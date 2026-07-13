// WP-06 — THE BILLER CONSUMER (REQ-031 / REQ-040 / REQ-003 / REQ-056). The integration seam of the
// acceptance demo: a committed pod.signed → composeInvoice over the RECORDED quote.priced →
// invoice.issued appended THROUGH the sequencer DO (the I2 gate + the money projection run atomically
// there, one db.batch) → the evidence email through the EvidenceSender port.
//
// LAWS THIS MODULE ENFORCES:
//   · The invoice is the LEDGER'S. A send failure NEVER blocks or reverses it (REQ-031): a retriable
//     failure THROWS (queue redelivery is the retry — the append is idempotent, so redelivery is
//     safe); a permanent failure returns `issued_send_pending` and holds for a human.
//   · Anomalous / below-floor recorded quotes HOLD, never auto-invoice (REQ-040 — the $222,084/35-lb
//     case is permanent). A hold appends NOTHING and sends NOTHING; surfacing holds on the exceptions
//     queue is WP-11 Watchtower territory — until then the returned outcome is the loud log line.
//   · Money lines exist only as projections of events (REQ-003): this module never writes money_lines
//     or invoices rows — the sequencer's batch projects them FROM the invoice.issued event.
//   · Idempotent under queue redelivery: the invoice EVENT id and the payload invoice_id are both
//     DETERMINISTICALLY derived from the POD event id (no Date, no random), the sequencer dedupes by
//     event id, and the sender dedupes by `evidence-email/<invoice event id>`. Twice in = once out.
//     A redelivered message whose invoice already committed takes the FAST PATH (send-only, from the
//     stored payload) — it never re-judges the issue. This same idempotency is what lets the REQ-169
//     reconciliation sweep (WP-11 cron) aggressively re-enqueue any pod.signed whose trigger was lost
//     in the commit→enqueue window.
//
// LLM-free and pure-composition at the core (composeInvoice); this consumer only loads records,
// derives ids, appends through the DO, and sends. It runs in workers/agents (REQ-024: agents may call
// LLMs, the ledger may not — this one happens to need none).

import { z } from "@shuddl/contracts";
import type { GeoStamp, InvoiceIssuedPayload, LedgerEvent, QuotePricedPayload } from "@shuddl/contracts";
import { rowToEvent } from "@shuddl/ledger/lens";
import { composeInvoice, renderEvidenceEmail, SendError } from "@shuddl/agents";
import type { EvidenceEmailData, EvidenceMessage, EvidenceSender } from "@shuddl/agents";
import type { Leg } from "@shuddl/rater";

// ---- the queue payload (Zod at the boundary; the producer is the sequencer DO) ----------------------
export const PodSignedMessage = z
  .object({
    kind: z.literal("pod.signed"),
    tenant: z.string().min(1),
    shipment_id: z.string().min(1),
    event_id: z.string().min(1),
  })
  .strict();
export type PodSignedMessage = z.infer<typeof PodSignedMessage>;

// ---- deps ------------------------------------------------------------------------------------------
// The DO append surface, hand-written for the same reason events.ts binds SeqStub: the generic
// DurableObjectStub RPC mapper explodes on the recursive event union. Only `id` is consumed here.
export interface SeqAppendResult {
  id: string;
}
export interface SeqStubLike {
  append(req: { tenant: string; streamId: string; input: unknown }): Promise<SeqAppendResult>;
}

export interface BillerDeps {
  /** The message tenant's OWN D1 (the caller resolves it via the tenant allowlist — REQ-025). */
  db: D1Database;
  seq: SeqStubLike;
  sender: EvidenceSender;
  /** REQ-129 — the referral link base; `?ref=<shipment_ref>` is appended here. */
  referralBase: string;
}

// ---- outcome ---------------------------------------------------------------------------------------
export type BillerOutcome =
  | { status: "issued_sent"; invoice_event_id: string; invoice_id: string; provider: string; provider_id: string }
  | {
      status: "issued_send_pending";
      invoice_event_id: string;
      invoice_id: string;
      reason: "send_failed_permanent" | "recipient_unresolved";
      detail: string;
    }
  | { status: "held"; reason: "anomaly" | "below_floor" | "no_quote" | "interline_unresolved"; detail: string }
  | { status: "skipped"; reason: "pod_not_found" | "shipment_not_found"; detail: string };

// ---- deterministic ids (no Date, no random — redelivery must reproduce them exactly) ----------------
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The invoice EVENT id: SHA-256 of the POD event id, shaped into a v4-variant UUID so it satisfies
// EventInput's z.string().uuid() — the same shaping rate.ts uses for its resumable event sequence.
// The sequencer dedupes by this id, so a redelivered message returns the ORIGINAL event, never a second.
export async function invoiceEventIdFor(podEventId: string): Promise<string> {
  const h = (await sha256Hex(`biller:invoice-event:${podEventId}`)).slice(0, 32);
  const variant = ((parseInt(h.slice(16, 17) || "0", 16) & 0x3) | 0x8).toString(16); // 8/9/a/b
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// The payload invoice_id (the AR document number) — same derivation, different domain-separation tag.
async function invoiceIdFor(podEventId: string): Promise<string> {
  return `inv_${(await sha256Hex(`biller:invoice:${podEventId}`)).slice(0, 16)}`;
}

// ---- display formatting (pre-formatted HERE; renderEvidenceEmail is Date-free by contract) ----------
function formatUtc(epochMs: number): string {
  const iso = new Date(epochMs).toISOString(); // a pure function of the recorded timestamp, not a clock read
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

// Integer-string microdegree formatting — no float division touches a recorded coordinate.
function e6ToDeg(e6: number): string {
  const sign = e6 < 0 ? "-" : "";
  const abs = Math.abs(e6);
  return `${sign}${Math.floor(abs / 1_000_000)}.${String(abs % 1_000_000).padStart(6, "0")}`;
}
function formatGeo(geo: { lat_e6: number; lon_e6: number }): string {
  return `${e6ToDeg(geo.lat_e6)}, ${e6ToDeg(geo.lon_e6)}`;
}

// ---- record loading --------------------------------------------------------------------------------
type SqlRow = Record<string, string | number | null>;

async function loadEvent(db: D1Database, streamId: string, eventId: string, kind: string): Promise<LedgerEvent | null> {
  const row = await db
    .prepare("SELECT * FROM events WHERE stream_id = ? AND id = ? AND kind = ?")
    .bind(streamId, eventId, kind)
    .first<SqlRow>();
  return row === null ? null : rowToEvent(row);
}

// The accepted quote. ASSUMPTION (stated, per plan): no booking/acceptance flow exists yet —
// `quote.accepted` is a defined kind but nothing emits it — so the LATEST quote.priced recorded
// BEFORE the POD is the quote this shipment moved under. When booking lands (WP-08), switch to the
// quote event the booking references.
async function loadAcceptedQuote(db: D1Database, streamId: string, beforeSeq: number): Promise<LedgerEvent | null> {
  const row = await db
    .prepare("SELECT * FROM events WHERE stream_id = ? AND kind = 'quote.priced' AND seq < ? ORDER BY seq DESC LIMIT 1")
    .bind(streamId, beforeSeq)
    .first<SqlRow>();
  return row === null ? null : rowToEvent(row);
}

type ShipmentRow = { bill_to_party_id: string; bill_terms: string | null; division: string; refs: string };

// The bill-to recipient: parties.contacts (a JSON array) is the tenant plane's ONLY email-bearing
// column, so it is the honest source. A `kind: "billing"` contact wins over the first plausible one
// (an AR document should reach the billing desk, not whoever was entered first). Header-safe:
// a CR/LF-carrying value is rejected here (it would otherwise ride into a mail header).
function plausibleEmail(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const email = (entry as Record<string, unknown>)["email"];
  return typeof email === "string" && email.includes("@") && !/[\r\n]/.test(email) ? email : undefined;
}
async function resolveRecipient(db: D1Database, partyId: string): Promise<string | undefined> {
  const row = await db.prepare("SELECT contacts FROM parties WHERE id = ?").bind(partyId).first<{ contacts: string }>();
  if (row === null) return undefined;
  let contacts: unknown;
  try {
    contacts = JSON.parse(row.contacts);
  } catch {
    return undefined;
  }
  if (!Array.isArray(contacts)) return undefined;
  const billing = contacts.find(
    (c) => c !== null && typeof c === "object" && !Array.isArray(c) && (c as Record<string, unknown>)["kind"] === "billing" && plausibleEmail(c) !== undefined,
  );
  if (billing !== undefined) return plausibleEmail(billing);
  for (const entry of contacts) {
    const email = plausibleEmail(entry);
    if (email !== undefined) return email;
  }
  return undefined;
}

// The delivery stop's recorded coordinates (legs.geo, the same server-side source the delivery fence
// reads) — the email's "Location" line. Falls back to the POD's own signing geo when no leg exists.
async function deliveryStopGeo(db: D1Database, shipmentId: string): Promise<{ lat_e6: number; lon_e6: number } | undefined> {
  const row = await db
    .prepare("SELECT geo FROM legs WHERE shipment_id = ? AND kind = 'delivery' ORDER BY seq LIMIT 1")
    .bind(shipmentId)
    .first<{ geo: string }>();
  if (row === null) return undefined;
  let geo: unknown;
  try {
    geo = JSON.parse(row.geo);
  } catch {
    return undefined;
  }
  if (geo === null || typeof geo !== "object") return undefined;
  const g = geo as Record<string, unknown>;
  return typeof g.lat_e6 === "number" && typeof g.lon_e6 === "number" ? { lat_e6: g.lat_e6, lon_e6: g.lon_e6 } : undefined;
}

// ---- interline resolution (REQ-040 — the executing share, never gross; FAIL-CLOSED) -----------------
const LEG_KINDS: ReadonlySet<string> = new Set(["pickup", "linehaul", "interline", "cartage", "delivery", "dray"]);
type LegRow = { kind: string; executor_party_id: string; split_bps: number | null };
type InterlineResolution = { kind: "direct" } | { kind: "interline"; legs: Leg[]; tenantParty: string } | { kind: "unresolved"; detail: string };

// Classification is by the DATA, never the LABEL (REQ-040 fail-CLOSED). A partner with a revenue stake
// shows up as a real `split_bps` on some leg OR a second distinct executor party — regardless of whether
// any leg happens to wear the 'interline' KIND. Keying "direct" off the absence of a kind='interline'
// leg is fail-OPEN: a partner leg recorded under 'linehaul'/'cartage'/'dray' but carrying a 9000-bps
// split would bill at full gross with the executing-share floor check skipped entirely (the $222K-class
// fail-open). So:
//   · DIRECT is the ONLY leg shape with NO revenue split anywhere AND a single executor party.
//   · Anything else is interline-shaped and MUST have its executing share judged (never gross): every
//     leg needs a clean integer split summing to 10000, and the tenant's OWN executing party — the POD
//     signer's party (`pod.actor.party`, device co-signed, I4 — the authoritative "who is the tenant
//     here"; equivalently the executor_party_id≠partner comparison the sequencer's #isInterline notes) —
//     must actually execute a recorded leg. Any ambiguity is UNRESOLVED, which HOLDS: an interline move
//     whose executing share cannot be judged must never auto-invoice ("as direct" would skip REQ-040).
function resolveInterline(rows: readonly LegRow[], tenantParty: string): InterlineResolution {
  const hasSplit = rows.some((r) => r.split_bps !== null);
  const executors = [...new Set(rows.map((r) => r.executor_party_id))];
  if (!hasSplit && executors.length <= 1) return { kind: "direct" };

  // Interline-shaped (a split and/or a second executor): the share MUST be judged, never the gross.
  if (rows.some((r) => r.split_bps === null || !Number.isInteger(r.split_bps) || !LEG_KINDS.has(r.kind))) {
    return { kind: "unresolved", detail: "a revenue split or a partner executor is present but split_bps/kind is incomplete — cannot compute the executing share" };
  }
  const total = rows.reduce((s, r) => s + (r.split_bps as number), 0);
  if (total !== 10_000) {
    return { kind: "unresolved", detail: `leg split_bps total ${total}, expected 10000 — cannot compute the executing share` };
  }
  if (tenantParty === "" || !executors.includes(tenantParty)) {
    return { kind: "unresolved", detail: `the tenant's executing party (the POD signer ${JSON.stringify(tenantParty)}) executes none of the recorded legs — cannot compute the executing share` };
  }
  return {
    kind: "interline",
    legs: rows.map((r) => ({ kind: r.kind as Leg["kind"], executor: r.executor_party_id, split_bps: r.split_bps as number })),
    tenantParty,
  };
}

// ---- the consumer ------------------------------------------------------------------------------------
export async function handlePodSigned(message: PodSignedMessage, deps: BillerDeps): Promise<BillerOutcome> {
  const msg = PodSignedMessage.parse(message); // Zod at the boundary even when the caller pre-parsed
  const { db, seq, sender, referralBase } = deps;
  const streamId = `s:${msg.shipment_id}`;

  // GUARD 1 — the trigger event must exist ON THIS STREAM as a pod.signed. A message that references a
  // nonexistent/foreign POD is POISON: redelivery cannot conjure the event, so skip (non-retriable),
  // never append. This is the consumer-side backstop to the sequencer's own I2 gate.
  const pod = await loadEvent(db, streamId, msg.event_id, "pod.signed");
  if (pod === null || pod.kind !== "pod.signed") {
    return { status: "skipped", reason: "pod_not_found", detail: `pod.signed ${msg.event_id} not on ${streamId} — poison message` };
  }

  const shipment = await db
    .prepare("SELECT bill_to_party_id, bill_terms, division, refs FROM shipments WHERE id = ?")
    .bind(msg.shipment_id)
    .first<ShipmentRow>();
  if (shipment === null) {
    return { status: "skipped", reason: "shipment_not_found", detail: `shipment ${msg.shipment_id} has events but no shipments row — data fault, not retriable` };
  }

  // REDELIVERY FAST PATH — if the deterministically-derived invoice event ALREADY exists on this
  // stream, compose + every gate already ran and PASSED when it committed; a redelivered message goes
  // STRAIGHT to the send, from the STORED payload. Re-judging here could flip to a hold under context
  // drift (legs edited after issue, a config change), which would orphan the evidence email forever
  // while the invoice stands — redelivery may complete or hold the SEND, never re-litigate the ISSUE.
  // (It also makes redelivery cheap: no quote/legs loads, no compose.)
  const invoiceEventId = await invoiceEventIdFor(pod.id);
  const existing = await loadEvent(db, streamId, invoiceEventId, "invoice.issued");
  if (existing !== null && existing.kind === "invoice.issued") {
    return sendEvidence({
      db,
      sender,
      referralBase,
      msg,
      podRecordedAt: pod.recorded_at,
      podGeo: pod.payload.geo,
      shipment,
      invoiceEventId: existing.id,
      invoicePayload: existing.payload,
    });
  }

  // GUARD 2 — an accepted quote with recorded itemized lines must exist (REQ-003/031: the invoice is a
  // projection of the RECORDED quote). No quote ⇒ HOLD — an unquoted shipment must never invoice ad hoc.
  const quoteEvent = await loadAcceptedQuote(db, streamId, pod.seq);
  if (quoteEvent === null || quoteEvent.kind !== "quote.priced") {
    return { status: "held", reason: "no_quote", detail: `no quote.priced precedes pod ${msg.event_id} on ${streamId} — nothing to project an invoice from` };
  }
  const acceptedQuote: QuotePricedPayload = quoteEvent.payload;

  // Bill terms (REQ-056) — three cases, distinguished ON PURPOSE:
  //   · NULL — the column is simply UNPOPULATED (no booking flow writes it yet): default "prepaid"
  //     quietly (the documented close-out default, not a fault).
  //   · a recognized value — use it.
  //   · an UNRECOGNIZED non-NULL value ("COLLECT", garbage) — a DATA FAULT, not an empty column: log
  //     LOUDLY, proceed as prepaid. Proceeding is safe because the PAYER is terms-invariant today:
  //     bill_to_party_id is "who pays" under EVERY terms value (third_party doubles it as
  //     third_party_id), so terms only label the document — holding would block real revenue over a
  //     label. Revisit if terms ever route the payer differently.
  let terms: "prepaid" | "collect" | "third_party" = "prepaid";
  if (shipment.bill_terms === "prepaid" || shipment.bill_terms === "collect" || shipment.bill_terms === "third_party") {
    terms = shipment.bill_terms;
  } else if (shipment.bill_terms !== null) {
    console.error(
      `biller: shipment ${msg.shipment_id} carries unrecognized bill_terms ${JSON.stringify(shipment.bill_terms)} — ` +
        `DATA FAULT (not an unpopulated column); billing prepaid to the recorded bill_to_party_id (the payer is terms-invariant today)`,
    );
  }
  const bill = {
    party_id: shipment.bill_to_party_id,
    terms,
    ...(terms === "third_party" ? { third_party_id: shipment.bill_to_party_id } : {}),
    division: shipment.division,
  };

  // Interline: the executing share is judged, never gross (REQ-040). Fail-closed on any ambiguity.
  const legRows = await db
    .prepare("SELECT kind, executor_party_id, split_bps FROM legs WHERE shipment_id = ? ORDER BY seq")
    .bind(msg.shipment_id)
    .all<LegRow>();
  const interline = resolveInterline(legRows.results, pod.actor.party);
  if (interline.kind === "unresolved") {
    return { status: "held", reason: "interline_unresolved", detail: `shipment ${msg.shipment_id}: ${interline.detail} (REQ-040 fail-closed)` };
  }

  // Compose — pure, deterministic, LLM-free. Both ids derive from the POD event id (redelivery-stable;
  // invoiceEventId was computed for the fast path above). approvalGranted is intentionally unwired
  // (close-out note): reading a below-floor release from approval.decided events lands with the
  // approvals queue (WP-10/11); until then a below-floor interline share always holds — fail-closed.
  const composed = composeInvoice({
    pod: { event_id: pod.id, shipment_id: msg.shipment_id },
    acceptedQuote,
    bill,
    invoiceId: await invoiceIdFor(pod.id),
    ...(interline.kind === "interline" ? { legs: interline.legs, tenantParty: interline.tenantParty } : {}),
  });

  if (composed.status === "hold") {
    // NO append, NO send. The outcome is the log line; the exceptions-queue surface is WP-11 (Watchtower).
    return { status: "held", reason: composed.reason, detail: composed.detail };
  }

  // Append THROUGH the sequencer DO: I2 (no invoice without a signed POD) + the money projection run
  // there, atomically with the event insert. The DO dedupes by event id, so a redelivered message gets
  // the ORIGINAL event back — no second invoice, no second projection. An append refusal/fault throws
  // out of this handler: redelivery retries it safely, and a persistent refusal lands in the DLQ.
  const appended = await seq.append({
    tenant: msg.tenant,
    streamId,
    input: {
      id: invoiceEventId,
      shipment_id: msg.shipment_id,
      ts: pod.recorded_at, // the POD commit instant this money projects from — deterministic, no clock read
      actor: { party: "agent:biller" }, // server-controlled sentinel (mirrors rate.ts's "agent:rater")
      party_refs: [],
      evidence: [],
      source: "native",
      confidence: 10_000,
      kind: "invoice.issued",
      payload: composed.payload,
    },
  });

  // The evidence send — downstream of the committed invoice; nothing in it unwinds the append (REQ-031).
  return sendEvidence({
    db,
    sender,
    referralBase,
    msg,
    podRecordedAt: pod.recorded_at,
    podGeo: pod.payload.geo,
    shipment,
    invoiceEventId: appended.id,
    invoicePayload: composed.payload,
  });
}

// ---- the evidence send tail — shared by the fresh-issue path and the redelivery fast path ------------
// Everything here is DOWNSTREAM of a committed invoice.issued: it may complete, hold, or throw for
// redelivery, but it can NEVER unwind the invoice (REQ-031). On the fast path the payload is the
// STORED event's — the send always reflects exactly what the ledger holds.
interface SendContext {
  db: D1Database;
  sender: EvidenceSender;
  referralBase: string;
  msg: PodSignedMessage;
  podRecordedAt: number;
  podGeo: GeoStamp;
  shipment: ShipmentRow;
  invoiceEventId: string;
  invoicePayload: InvoiceIssuedPayload;
}

async function sendEvidence(cx: SendContext): Promise<BillerOutcome> {
  const { db, sender, referralBase, msg, shipment, invoiceEventId, invoicePayload } = cx;
  const total = invoicePayload.lines.reduce((s, l) => s + l.amount_cents, 0);
  let refs: Record<string, unknown> = {};
  try {
    refs = JSON.parse(shipment.refs) as Record<string, unknown>;
  } catch {
    /* unparseable refs ⇒ fall back to the shipment id */
  }
  const shipmentRef = typeof refs["pro"] === "string" && refs["pro"] !== "" ? refs["pro"] : msg.shipment_id;
  const stopGeo = (await deliveryStopGeo(db, msg.shipment_id)) ?? cx.podGeo;

  const emailData: EvidenceEmailData = {
    shipment_ref: shipmentRef,
    delivered_at: formatUtc(cx.podRecordedAt), // pre-formatted here — the render is Date-free by contract
    // PodSignedPayload records the signature HASH, not the signer's printed name (close-out note: thread
    // a signer name through capture when the driver flow collects one).
    signed_by: "Signature on file",
    location: formatGeo(stopGeo),
    invoice_ref: invoicePayload.invoice_id,
    total_cents: total,
    photos: {}, // close-out note: the R2-signed-URL resolver for signature/placed photos is not wired yet
    referral_url: `${referralBase}?ref=${encodeURIComponent(shipmentRef)}`,
  };
  const rendered = renderEvidenceEmail(emailData);

  const recipient = await resolveRecipient(db, shipment.bill_to_party_id);
  if (recipient === undefined) {
    // NOT a silent skip (that would be a NotConfiguredSender-shaped lie): the email composed fine, the
    // RECIPIENT is the gap. Record it loudly as a hold-equivalent — the invoice stands (REQ-031).
    const detail =
      `invoice ${invoicePayload.invoice_id} (event ${invoiceEventId}) issued for shipment ${msg.shipment_id}, but ` +
      `bill-to party ${shipment.bill_to_party_id} has no contact email (parties.contacts) — evidence email HELD unsent`;
    console.error(`biller: ${detail}`);
    return { status: "issued_send_pending", invoice_event_id: invoiceEventId, invoice_id: invoicePayload.invoice_id, reason: "recipient_unresolved", detail };
  }

  const evidenceMessage: EvidenceMessage = {
    channel: "email",
    to: recipient,
    subject: rendered.subject,
    html: rendered.html,
    shipment_id: msg.shipment_id,
    idempotency_key: `evidence-email/${invoiceEventId}`, // one invoice event, one message — dedupe under redelivery
  };
  try {
    const receipt = await sender.send(evidenceMessage);
    return {
      status: "issued_sent",
      invoice_event_id: invoiceEventId,
      invoice_id: invoicePayload.invoice_id,
      provider: receipt.provider,
      provider_id: receipt.provider_id,
    };
  } catch (err) {
    if (err instanceof SendError && !err.retriable) {
      // Redelivery cannot help (validation-adjacent 4xx / idempotency conflict / unwired channel):
      // hold for a human, do NOT throw — throwing would redeliver a message that can never succeed.
      const detail = `evidence email permanently failed for invoice event ${invoiceEventId}: ${err.message}`;
      console.error(`biller: ${detail}`);
      return { status: "issued_send_pending", invoice_event_id: invoiceEventId, invoice_id: invoicePayload.invoice_id, reason: "send_failed_permanent", detail };
    }
    // Retriable (or unknown) ⇒ THROW so the queue redelivers. The invoice append is idempotent and the
    // sender's idempotency key dedupes, so redelivery is safe end to end. NEVER unwind the invoice.
    throw err;
  }
}
