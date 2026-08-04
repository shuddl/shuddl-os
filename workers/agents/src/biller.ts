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
import { authoritativeSource, resolveAuthority } from "@shuddl/ledger/authority";
import { plausibleEmail } from "@shuddl/ledger/contacts";
import { terminalHoldBodyRef } from "@shuddl/ledger/queries/unbilled";
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
  /** Task 9 (REQ-170) — the tenant-shared evidence R2 bucket. When present, the Biller REQUIRES the POD's
   *  signature bytes to be STORED (an active, tenant-scoped POD document + a present R2 object) before it mints
   *  the invoice + sends the proof email; a miss HOLDS(evidence_missing). Production (workers/agents index.ts)
   *  ALWAYS wires it, so the precondition always runs there; a unit test that is not exercising the evidence
   *  precondition may omit it, and the check is then skipped (the byte gate is opt-in for those tests). */
  evidence?: R2Bucket;
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
  | { status: "held"; reason: "anomaly" | "below_floor" | "no_quote" | "interline_unresolved" | "evidence_missing"; detail: string }
  | { status: "skipped"; reason: "pod_not_found" | "shipment_not_found"; detail: string };

// ---- deterministic ids (no Date, no random — redelivery must reproduce them exactly) ----------------
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A DETERMINISTIC v4-variant UUID from a domain-tagged seed — SHA-256(seed) shaped so it satisfies
// EventInput's z.string().uuid() (the same shaping rate.ts uses for its resumable event sequence). The
// sequencer dedupes by event id, so an agent that seeds this from its trigger event's id re-derives the
// SAME event id on redelivery and gets the ORIGINAL event back, never a second. Shared by the Biller and
// the interline-split producer (REQ-019) so both agents' id law lives in ONE place.
export async function uuidFromSeed(seed: string): Promise<string> {
  const h = (await sha256Hex(seed)).slice(0, 32);
  const variant = ((parseInt(h.slice(16, 17) || "0", 16) & 0x3) | 0x8).toString(16); // 8/9/a/b
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// The invoice EVENT id: domain-tagged on the POD event id (redelivery-stable; see uuidFromSeed).
export async function invoiceEventIdFor(podEventId: string): Promise<string> {
  return uuidFromSeed(`biller:invoice-event:${podEventId}`);
}

// The payload invoice_id (the AR document number) — same derivation, different domain-separation tag.
async function invoiceIdFor(podEventId: string): Promise<string> {
  return `inv_${(await sha256Hex(`biller:invoice:${podEventId}`)).slice(0, 16)}`;
}

// ---- the terminal-hold marker (REQ-169) --------------------------------------------------------------
// A PERMANENT hold (below_floor / no_quote / interline_unresolved / anomaly) used to append NOTHING — just a
// returned outcome + log line. That left two gaps: (1) the hold was INVISIBLE on the ledger (nothing to surface
// on the exceptions queue, REQ-036), and (2) the REQ-169 reconciliation sweep's pod-without-invoice anti-join
// would re-enqueue a permanently-held POD every cron tick, forever. This durable, idempotent MARKER closes both:
// an INTERNAL message.received{channel:note} note (the sla-sweep.ts internal-note idiom — NO new event kind, the
// 35-catalog is frozen) recording the hold (shipment + reason), appended THROUGH the sequencer. Its id is
// DETERMINISTIC per (shipment, reason), so the DO dedupes a re-drive to a no-op; its body_ref
// (`terminalHoldBodyRef`) is the SAME shape the recon anti-join excludes on (single source of truth,
// @shuddl/ledger/queries/unbilled). ONLY a TERMINAL hold gets a marker — a RETRIABLE fault still THROWS
// (redelivery). If the marker append itself faults transiently it THROWS too, redelivering the message; the
// re-judged hold re-derives the SAME marker id, so the retry is safe (the marker lands at most once).
async function emitTerminalHoldMarker(
  seq: SeqStubLike,
  msg: PodSignedMessage,
  streamId: string,
  podRecordedAt: number,
  reason: "below_floor" | "no_quote" | "interline_unresolved" | "anomaly",
): Promise<void> {
  await seq.append({
    tenant: msg.tenant,
    streamId,
    input: {
      // Deterministic per (shipment, reason) — a re-drive re-derives it and the DO returns the ORIGINAL note.
      id: await uuidFromSeed(`biller:terminal-hold:${msg.shipment_id}:${reason}`),
      shipment_id: msg.shipment_id,
      ts: podRecordedAt, // the POD commit instant — deterministic, no clock read (mirrors the invoice ts)
      actor: { party: "agent:biller" }, // the server-controlled sentinel (same as the invoice.issued actor)
      party_refs: [],
      evidence: [],
      source: "native",
      confidence: 10_000,
      requested_visibility: "internal", // narrows message.received's counterparty default → internal ops note
      kind: "message.received",
      payload: { channel: "note", from_ref: "agent:biller", body_ref: terminalHoldBodyRef(msg.shipment_id, reason) },
    },
  });
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

export async function loadEvent(db: D1Database, streamId: string, eventId: string, kind: string): Promise<LedgerEvent | null> {
  const row = await db
    .prepare("SELECT * FROM events WHERE stream_id = ? AND id = ? AND kind = ?")
    .bind(streamId, eventId, kind)
    .first<SqlRow>();
  return row === null ? null : rowToEvent(row);
}

// The FALLBACK quote for a stream with NO booking (the booking path resolves + verifies its NAMED quote
// via loadAcceptedBookingQuote below — Task 7, REQ-031/003): the LATEST quote.priced recorded BEFORE the
// POD is the quote the shipment moved under. Kept because a directly-dispatched (bookingless) shipment
// still invoices; a booked one never reaches this — the caller branches on the booking's quote ref first.
export async function loadAcceptedQuote(db: D1Database, streamId: string, beforeSeq: number): Promise<LedgerEvent | null> {
  const row = await db
    .prepare("SELECT * FROM events WHERE stream_id = ? AND kind = 'quote.priced' AND seq < ? ORDER BY seq DESC LIMIT 1")
    .bind(streamId, beforeSeq)
    .first<SqlRow>();
  return row === null ? null : rowToEvent(row);
}

// Task 7 (REQ-031/003) — the stream's single booking.created's accepted-quote reference, or null when the
// shipment is UN-BOOKED (no booking.created — a legacy/quote-stage shipment). booking.created is idempotent per
// stream (REQ-191, sequencer #enforceBooking), so ORDER BY seq LIMIT 1 IS the one booking. The value is the
// accepted quote.priced's event id (BookingCreatedPayload.quote_event_id) — the authority the invoice must project.
export async function loadBookingQuoteRef(db: D1Database, streamId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT json_extract(payload, '$.quote_event_id') AS quote_event_id FROM events WHERE stream_id = ? AND kind = 'booking.created' ORDER BY seq LIMIT 1")
    .bind(streamId)
    .first<{ quote_event_id: string | null }>();
  return row?.quote_event_id ?? null;
}

// Task 7 (REQ-031/003) — resolve a booking's quote_event_id to the ACCEPTED quote.priced ON THIS STREAM. Returns
// the quote.priced event ONLY when (a) an event with that exact id on this stream is a quote.priced AND (b) a
// quote.accepted on this stream NAMES it (payload.quote_event_id). Any authority inconsistency — the id is
// dangling, the wrong kind, on another stream (the stream_id filter excludes it — cross-stream/cross-tenant), or
// never accepted — returns null, which the caller treats as a fail-closed hold. This is the exact-ID / stream /
// kind / accepted verification the plan requires (verify tenant/stream/order/exact ID before we bind money to it).
export async function loadAcceptedBookingQuote(db: D1Database, streamId: string, quoteEventId: string): Promise<LedgerEvent | null> {
  const quote = await loadEvent(db, streamId, quoteEventId, "quote.priced");
  if (quote === null) return null;
  const accepted = await db
    .prepare("SELECT 1 AS present FROM events WHERE stream_id = ? AND kind = 'quote.accepted' AND json_extract(payload, '$.quote_event_id') = ? LIMIT 1")
    .bind(streamId, quoteEventId)
    .first<{ present: number }>();
  return accepted === null ? null : quote;
}

type ShipmentRow = { bill_to_party_id: string; bill_terms: string | null; division: string; refs: string };

// The bill-to recipient: parties.contacts (a JSON array) is the tenant plane's ONLY email-bearing
// column, so it is the honest source. A `kind: "billing"` contact wins over the first plausible one
// (an AR document should reach the billing desk, not whoever was entered first). `plausibleEmail` (the
// per-entry, header-safe email predicate) is imported from @shuddl/ledger/contacts — the SAME predicate the
// REQ-182 booking evidence-recipient gate applies to THIS SAME party (the bill_to). Because the gate checks
// the party this resolver emails, a booking that passed the gate is one this resolver can reach. Exported so
// the gate suite can bind the two directly (gate-pass ⇒ resolveRecipient(bill_to) is non-null).
export async function resolveRecipient(db: D1Database, partyId: string): Promise<string | undefined> {
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
//
// INVARIANT (WP-08 T5, REQ-028/052): booking.created materializes ONE delivery leg per shipment at the
// deterministic `${id}:delivery` row with EMPTY geo; downstream provisioning (dispatch/T8) must UPDATE that
// row with the real geo, NEVER INSERT a sibling delivery leg. As a backstop against a stray sibling, this
// PREFERS a delivery leg with NON-EMPTY geo (falling back to lowest-seq only if none has geo), so the empty
// skeleton can never SHADOW the real coordinates regardless of seq order. Exported for a direct unit test.
export async function deliveryStopGeo(db: D1Database, shipmentId: string): Promise<{ lat_e6: number; lon_e6: number } | undefined> {
  const row = await db
    .prepare("SELECT geo FROM legs WHERE shipment_id = ? AND kind = 'delivery' ORDER BY (geo IS NULL OR geo = '{}') ASC, seq ASC LIMIT 1")
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

// Task 9 (REQ-170) — the ACTIVE, tenant-scoped POD evidence document for a recorded signature hash. Returns the
// row ONLY when a POD document on THIS shipment records EXACTLY this hash (so a stale/other-hash doc never
// satisfies the check), is retention-ACTIVE (the row-iff-bytes invariant: an 'active' row means bytes are
// stored — a tombstoned 'expired' row is not proof), AND its R2 key sits under THIS tenant's `evidence/<tenant>/`
// prefix (REQ-025 — a mis-scoped row can never stand in for the tenant's own evidence). Any miss returns null →
// the caller HOLDS. The R2 `head` on the returned key is the caller's belt that the bytes physically exist.
export interface PodEvidenceDoc {
  r2_key: string;
}
export async function loadActivePodDocument(
  db: D1Database,
  tenant: string,
  shipmentId: string,
  evidenceHash: string,
): Promise<PodEvidenceDoc | null> {
  const row = await db
    .prepare("SELECT r2_key FROM documents WHERE shipment_id = ? AND hash = ? AND kind = 'POD' AND retention_status = 'active' LIMIT 1")
    .bind(shipmentId, evidenceHash)
    .first<{ r2_key: string }>();
  if (row === null) return null;
  if (!row.r2_key.startsWith(`evidence/${tenant}/`)) return null; // REQ-025 — the row must live in THIS tenant's key space
  return { r2_key: row.r2_key };
}

// ---- interline resolution (REQ-040 — the executing share, never gross; FAIL-CLOSED) -----------------
const LEG_KINDS: ReadonlySet<string> = new Set(["pickup", "linehaul", "interline", "cartage", "delivery", "dray"]);
export type LegRow = { kind: string; executor_party_id: string; split_bps: number | null };
export type InterlineResolution = { kind: "direct" } | { kind: "interline"; legs: Leg[]; tenantParty: string } | { kind: "unresolved"; detail: string };

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
export function resolveInterline(rows: readonly LegRow[], tenantParty: string): InterlineResolution {
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

  // WP-15 REQ-030/L8 — consult the shared authority read-seam for the INVOICING module before composing the
  // authoritative native invoice below. `legacyValueAvailable` is false today (no legacy AR mirror exists —
  // Task 4 ships the 171-col mirror adapter), so authoritativeSource ALWAYS resolves to "native" and this
  // consumer projects the native invoice exactly as before — behavior-identical. The dormant branch is where
  // Tasks 4/6/8 light up the incumbent-mirror path; it is UNREACHABLE while legacyValueAvailable is false
  // (native always wins), so it never runs today — the seam is load-bearing but inert.
  const invoicingAuthority = authoritativeSource(await resolveAuthority(db, "invoicing"), false);
  if (invoicingAuthority === "legacy") {
    // DORMANT until a legacy AR mirror exists (Task 4): defer to the incumbent's invoice instead of composing
    // a native one. Unreachable today (legacyValueAvailable=false ⇒ authoritativeSource never yields legacy).
    console.error(`biller: invoicing authority is 'legacy' for shipment ${msg.shipment_id} but no mirror is wired (WP-15 Task 4) — proceeding native`);
  }

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

  // GUARD 2 — bind the invoice to the EXACT ACCEPTED BOOKING QUOTE (Task 7, REQ-031/003). The invoice is a
  // projection of the RECORDED quote the booking ACCEPTED — never "the latest quote.priced before the POD": a
  // re-quote (quote B) priced AFTER the booking but BEFORE the POD used to win that latest-pre-POD selection and
  // MIS-BILL (bill B instead of the booked A). Load the stream's single booking.created; when present, resolve
  // booking.quote_event_id to an ACCEPTED quote.priced ON THIS STREAM (loadAcceptedBookingQuote verifies exact
  // id / stream / kind / accepted). An UN-booked stream (no booking.created — a legacy/quote-stage shipment)
  // FALLS BACK to the latest-pre-POD quote (the prior behavior, preserved so an un-booked POD still bills; in
  // production every real shipment is booked, so the exact-quote binding is what runs).
  let quoteEvent: LedgerEvent | null;
  const bookingQuoteRef = await loadBookingQuoteRef(db, streamId);
  if (bookingQuoteRef !== null) {
    quoteEvent = await loadAcceptedBookingQuote(db, streamId, bookingQuoteRef);
    if (quoteEvent === null) {
      // AUTHORITY INCONSISTENCY (fail closed): the booking names a quote that is not an accepted quote.priced on
      // THIS stream (dangling / wrong-kind / cross-stream / cross-tenant / never accepted). HOLD — zero money/send.
      // In production a booking always carries a real accepted quote (the booking agent's GUARD 2 + the
      // accept-quote route guarantee it), so this is the fail-closed belt, never the golden path.
      await emitTerminalHoldMarker(seq, msg, streamId, pod.recorded_at, "no_quote");
      return {
        status: "held",
        reason: "no_quote",
        detail: `booking on ${streamId} names quote ${bookingQuoteRef}, which is not an accepted quote.priced on this stream — cannot bind the invoice (Task 7 authority, REQ-031/003)`,
      };
    }
  } else {
    quoteEvent = await loadAcceptedQuote(db, streamId, pod.seq);
  }
  if (quoteEvent === null || quoteEvent.kind !== "quote.priced") {
    // TERMINAL: an unquoted shipment can never invoice ad hoc, and no quote can be recorded before this POD
    // retroactively (append-only + seq<) — so this hold is permanent. Mark it (REQ-169 bounding + surfacing).
    await emitTerminalHoldMarker(seq, msg, streamId, pod.recorded_at, "no_quote");
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
    // TERMINAL (REQ-040 fail-closed): an interline move whose executing share cannot be judged must never
    // auto-invoice; it holds for a human. Mark it (REQ-169 bounding + surfacing).
    await emitTerminalHoldMarker(seq, msg, streamId, pod.recorded_at, "interline_unresolved");
    return { status: "held", reason: "interline_unresolved", detail: `shipment ${msg.shipment_id}: ${interline.detail} (REQ-040 fail-closed)` };
  }

  // Task 9 (REQ-170) — REQUIRE STORED POD BYTES BEFORE THE PROOF EMAIL. The evidence email frames itself as the
  // delivery RECORD, so it must never assert proof over ZERO stored bytes: a POD gated through with a fabricated
  // signature hash and no upload (the REQ-170 residual the delivery gate + the upload byte-verify could not
  // close on their own) would otherwise still bill + send. Before minting the invoice, require the POD's recorded
  // signature_hash to have an ACTIVE, tenant-scoped POD document (D1) AND a present R2 object (head). A miss FAILS
  // CLOSED: held(evidence_missing) — NO invoice, NO send, and NO terminal marker (the hold is TEMPORARY: the byte
  // upload re-drives the Biller (routes/evidence.ts), and the REQ-169 recon sweep re-drives it meanwhile because
  // an evidence-held POD has NO invoice + NO marker, so it stays in the anti-join until the bytes land).
  // GATED on deps.evidence: production (workers/agents index.ts) always wires the R2 bucket, so the precondition
  // always runs there; a unit test not exercising the byte gate omits it and the check is skipped.
  if (deps.evidence !== undefined) {
    const evidenceHash = pod.payload.signature_hash;
    const document = await loadActivePodDocument(db, msg.tenant, msg.shipment_id, evidenceHash);
    const object = document !== null ? await deps.evidence.head(document.r2_key) : null;
    if (document === null || object === null) {
      return {
        status: "held",
        reason: "evidence_missing",
        detail: `POD ${msg.event_id} on ${streamId}: no stored bytes for signature_hash ${evidenceHash} (no active tenant-scoped POD document + present R2 object) — the proof email cannot assert evidence it does not have (REQ-170)`,
      };
    }
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
    // NO invoice, NO send — a below-floor executing share or an anomalous ($222k/35-lb) recorded quote is a
    // PERMANENT hold (REQ-040). Append the durable, idempotent marker (REQ-169): it makes the hold visible on
    // the exceptions queue (REQ-036) AND lets the reconciliation sweep EXCLUDE it (bounded re-enqueue).
    await emitTerminalHoldMarker(seq, msg, streamId, pod.recorded_at, composed.reason);
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
    // REQ-178 SIBLING HAZARD (OUT OF SCOPE HERE — flag only, do not fix): `referralBase` is a LIVE config dep,
    // and the redelivery FAST PATH above re-renders this evidence email from the committed invoice.issued while
    // reading `referralBase` LIVE — the SAME class of config-drift hazard the Concierge's from_name/transit_days
    // pin closes (a between-send change to referralBase would drift the re-rendered body). Unlike the Concierge
    // reply, the evidence send's idempotency does not key off this URL today, so it is not a 409 risk — but if a
    // future change makes the referral URL body-load-bearing, PIN it into invoice.issued (or a sibling) and read
    // it back here, exactly like from_name. Tracked as its own REQ, deliberately not widened into REQ-178.
    referral_url: `${referralBase}?ref=${encodeURIComponent(shipmentRef)}`,
  };
  // REQ-170 (Task 9 note — pairs with REQ-168's pre-upload residual, see
  // packages/ledger/src/gates/transition-gates.ts): the SIGNATURE hash IS byte-verified upstream in
  // handlePodSigned — an active POD document + present R2 object are REQUIRED before the invoice mints
  // (a miss is held(evidence_missing), fail-closed) — so this send never asserts proof over zero stored
  // signature bytes. RESIDUAL, deliberately narrow: the placed-photo hash is not byte-checked (its
  // resolver — the same one that would fetch bytes for `photos` — is still deferred), and the
  // routes/evidence.ts redelivery fast path re-drives the Biller without re-checking. The email's proof
  // claim rests on the signature bytes; the invoice stands on the ledger either way (REQ-031).
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
      //
      // SURFACING HOLD (audit §137). "Hold for a human" is the right decision and there is no human to hold
      // it FOR: this path console.errors and returns `issued_send_pending`, raising NO anomaly and writing
      // no queue row, so the ONLY trace that a customer never received their proof-and-invoice is a Workers
      // log line. The invoice is correctly issued and the ledger is correct — what is missing is the
      // OPERATOR SIGNAL. Contrast the retriable branch below, which the queue itself makes visible by
      // redelivering. Raising an anomaly here is new behaviour (a REQ row); recorded in GO-LIVE-CHECKLIST
      // as Med-LATENT because it is inert until a real sender is wired.
      const detail = `evidence email permanently failed for invoice event ${invoiceEventId}: ${err.message}`;
      console.error(`biller: ${detail}`);
      return { status: "issued_send_pending", invoice_event_id: invoiceEventId, invoice_id: invoicePayload.invoice_id, reason: "send_failed_permanent", detail };
    }
    // Retriable (or unknown) ⇒ THROW so the queue redelivers. The invoice append is idempotent and the
    // sender's idempotency key dedupes, so redelivery is safe end to end. NEVER unwind the invoice.
    throw err;
  }
}
