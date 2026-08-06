// WP-07 — THE CONCIERGE CONSUMER (REQ-026 / REQ-093 / REQ-100). The Biller's sibling: a committed
// `message.received` triggers this consumer, which RESOLVES the inbound to a Party + Shipment (Task 4,
// pure over a ResolvePort), PRICES + DECIDES (Task 5 composeConcierge — auto_reply | queued), and then:
//   · auto_reply → appends quote.requested + quote.priced + message.sent THROUGH the sequencer DO, then
//     SENDS the reply via the EvidenceSender port;
//   · queued(reason) → appends quote.requested (the request is real, a human prices/answers it) + records
//     an internal DRAFT `messages` row (drafted_by_agent) — it does NOT send.
//
// LAWS THIS MODULE ENFORCES (carried from Tasks 4-5, review-mandated):
//   · IDEMPOTENCY (Task-4 I-1). Cloudflare Queues is at-least-once. BEFORE any resolve/create, skip if a
//     `quote.requested` carrying this message's id (`source_message_event_id`) already exists → the outcome
//     is `already_handled`. Belt-and-suspenders on top: the shipment/party ids AND every appended event id
//     are DETERMINISTICALLY derived from the message event id (no Date, no random), the sequencer dedupes
//     by event id, party/shipment INSERTs are `OR IGNORE`, and the sender dedupes by
//     `concierge-reply/<message.sent id>`. So even a redelivery in the create→append window reproduces the
//     SAME facts — twice in = once out.
//   · ATOMICITY / ORPHAN (Task-4 I-3). resolve does the direct party/shipment INSERTs (via the port) and
//     THEN we append `quote.requested` carrying `source_message_event_id`, so any orphan shipment (INSERT
//     landed, append lost) is correlatable and the redelivery completes it.
//   · AUTO-SEND ONLY VIA COMPOSE. Only `composeConcierge → status:"auto_reply"` sends. `queued` NEVER sends
//     — it records a draft for a human. The floor + corroboration + resolution gates already live in
//     compose (REQ-026/040/093); this consumer does NOT re-decide them.
//   · NO COMMS OUTSIDE THE LEDGER (REQ-100). The reply that IS sent gets a `message.sent` event appended
//     FIRST (the send references it via the idempotency key). A send failure NEVER unwinds the ledger facts
//     (the Biller law): a permanent SendError holds (send-pending outcome); a retriable one THROWS so the
//     queue redelivers (the appends + send are idempotent, so re-driving is safe).
//   · REQ-024. The LLM lives ONLY in the injected parse port (packages/agents); this consumer selects the
//     adapter at the composition root (NotConfiguredParser by default, ClaudeParser iff a key+model is
//     bound), exactly like the Biller's evidenceSender(). The consumer itself calls no LLM.

import { z, normalizePartyEmail, partyIdForEmail } from "@shuddl/contracts";
import type { LedgerEvent, MessageReceivedPayload, ZoneTariff } from "@shuddl/contracts";
import { rowToEvent } from "@shuddl/ledger/lens";
import { authoritativeSource, resolveAuthority } from "@shuddl/ledger/authority";
import { resolveConcierge, composeConcierge, renderQuoteReply, SendError } from "@shuddl/agents";
import { resolveTransitDays } from "@shuddl/rater";
import type {
  ConciergeParser,
  EvidenceMessage,
  EvidenceSender,
  InboundEmail,
  PartyKind,
  ResolvePort,
} from "@shuddl/agents";
import { loadTenantRatingConfig, loadTransitMatrix } from "./rate-config.js";
import type { SeqStubLike } from "./biller.js";
import type { SparkGate } from "./spark-caps.js";

// ---- the queue payload (Zod at the boundary; the producer is the sequencer DO) ----------------------
// `shipment_id` is OPTIONAL: a fresh quote email arrives on a non-shipment stream (no shipment yet — the
// Concierge CREATES one), so the consumer locates the trigger event by its globally-unique id, never by a
// stream it may not know. When the inbound already sits on a shipment stream the DO forwards its id here.
export const MessageReceivedTrigger = z
  .object({
    kind: z.literal("message.received"),
    tenant: z.string().min(1),
    shipment_id: z.string().min(1).optional(),
    event_id: z.string().min(1),
  })
  .strict();
export type MessageReceivedTrigger = z.infer<typeof MessageReceivedTrigger>;

// ---- deps ------------------------------------------------------------------------------------------
export interface ConciergeDeps {
  /** The message tenant's OWN D1 (the caller resolves it via the tenant allowlist — REQ-025). */
  db: D1Database;
  /** The sequencer DO append surface (the ONLY write path — I2/visibility/projections run there). */
  seq: SeqStubLike;
  /** The reply-send port (RecordingSender in tests; Resend/NotConfigured at the composition root). */
  sender: EvidenceSender;
  /** The parse port (REQ-024) — Deterministic in tests; Claude/NotConfigured at the composition root. */
  parser: ConciergeParser;
  /** REQ-098 tenant voice — the config-seeded from-name that signs the reply (bounded, never model output). */
  tenantFromName: string;
  /** WP-14 Task 8 (REQ-122/125) — the Spark convenience cap. This LLM-powered auto-quote is an agent CONVENIENCE
   *  (genesis/04); before the parse runs, the gate reserves one AI action against a Spark tenant's monthly
   *  allotment. A NON-Spark tenant's gate no-ops (uncapped). OPTIONAL: absent ⇒ uncapped — a unit harness with no
   *  plan wired behaves as a non-Spark tenant; the composition root (index.ts queue()) ALWAYS injects it. The
   *  physical-truth consumers (Biller/Booking) carry NO gate — the truth-path carve-out is STRUCTURAL. */
  sparkGate?: SparkGate;
}

// ---- outcome ---------------------------------------------------------------------------------------
export type ConciergeOutcome =
  | {
      status: "issued_replied";
      shipment_id: string;
      party_id: string;
      party_created: boolean;
      quote_requested_event_id: string;
      quote_priced_event_id: string;
      message_sent_event_id: string;
      provider: string;
      provider_id: string;
    }
  | {
      status: "issued_send_pending";
      shipment_id: string;
      party_id: string;
      quote_requested_event_id: string;
      quote_priced_event_id: string;
      message_sent_event_id: string;
      reason: "send_failed";
      detail: string;
    }
  | {
      status: "queued";
      shipment_id: string;
      party_id: string;
      quote_requested_event_id: string;
      reason: "below_floor" | "not_corroborated" | "unknown_price" | "low_resolution";
      detail: string;
    }
  | { status: "unresolved"; reason: "not_quote_intent" | "no_party_signal" | "no_request" | "low_confidence"; detail: string }
  | { status: "already_handled"; detail: string }
  // WP-14 Task 8 (REQ-122/125) — the Spark tenant is over its monthly AI-credit allotment: the LLM auto-quote
  // CONVENIENCE is throttled. NOTHING is parsed/appended/sent (the agent doing the quoting is lost). The truth
  // path is UNAFFECTED — pod.signed still records + the Biller still invoices. queue() ACKs this (redelivery
  // cannot restore the allotment; it is a deliberate throttle, not a transient fault).
  | { status: "capped"; reason: "spark_over_allotment"; detail: string }
  | { status: "skipped"; reason: "message_not_found"; detail: string };

// ---- deterministic ids (no Date, no random — redelivery must reproduce them exactly) ----------------
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A domain-separated SHA-256 of the message event id, shaped into a v4-variant UUID so it satisfies
// EventInput's z.string().uuid() — the same shaping rate.ts/biller.ts use. The sequencer dedupes by this
// id, so a redelivered message returns the ORIGINAL event, never a second.
async function conciergeEventId(domain: string, messageEventId: string): Promise<string> {
  const h = (await sha256Hex(`concierge:${domain}:${messageEventId}`)).slice(0, 32);
  const variant = ((parseInt(h.slice(16, 17) || "0", 16) & 0x3) | 0x8).toString(16); // 8/9/a/b
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// The created shipment id (word-chars only ⇒ a valid `s:<id>` stream). Deterministic from the message id so
// redelivery reproduces it and the INSERT OR IGNORE is a no-op.
async function shipmentIdFor(messageEventId: string): Promise<string> {
  return `shp_${(await sha256Hex(`concierge:shipment:${messageEventId}`)).slice(0, 16)}`;
}

// REQ-176 — the PERMANENT-HOLD note. The auto-reply appends `message.sent` (the obligation-to-deliver) BEFORE
// calling the sender (append-then-send). If the send PERMANENTLY fails (a non-retriable SendError, or an
// undeliverable recipient that can never succeed), the reply was RECORDED but never DELIVERED — it is HELD.
// SURFACE the hold as a durable INTERNAL note — the SAME `message.received{channel:note,visibility:internal}`
// primitive the SLA sweep uses (no new kind/table) — keyed DETERMINISTICALLY off the held `message.sent` id so
// a redelivery re-holds to the SAME note (the DO dedupes by id → a re-append is a no-op). The sla-sweep's
// ANSWERED check EXCLUDES a `message.sent` that carries this hold note: a held (undelivered) reply must NOT
// clear the inbound's overdue timer, while a SUCCESSFUL send's `message.sent` (no hold note) STILL clears it —
// the REQ-174 backstop distinguishes SENT from HELD by the presence of this note.
function sendHoldBodyRef(messageSentEventId: string): string {
  return `concierge-send-hold/${messageSentEventId}`;
}
async function sendHoldNoteId(messageSentEventId: string): Promise<string> {
  const h = (await sha256Hex(`concierge:send-hold:${messageSentEventId}`)).slice(0, 32);
  const variant = ((parseInt(h.slice(16, 17) || "0", 16) & 0x3) | 0x8).toString(16); // 8/9/a/b
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// A created party's id is derived from the requester email via the SHARED @shuddl/contracts matcher
// (partyIdForEmail, REQ-196) — the SAME id the CSR intake derives — so re-creation is stable AND the two
// intake paths converge on one party row instead of forking a duplicate. (Was a Concierge-local
// `concierge:party:<raw email>` derivation that diverged from intake's.)

// ---- SLA timers on an inbound OWED a reply but NOT auto-answered (Task 8, REQ-095) -------------------
// The first-response window. A SINGLE DOCUMENTED DEFAULT until a per-tenant SLA-config source exists — NO
// config table/kind is invented here (that per-tenant override is a later-WP obligation, doc 02 §6). 4h:
// a freight-brokerage first-response norm — long enough to absorb ordinary handling latency, short enough
// that a quote request left unworked surfaces the SAME business day (before a competitor's quote wins the
// load). If a tenant SLA-config kind lands later, resolve this per-tenant and keep this the fallback.
export const SLA_REPLY_WINDOW_MS = 4 * 60 * 60 * 1000; // 14_400_000

// Set the first-response SLA on the inbound's OWN messages row (msg:<event id>, direction 'in'). `messages`
// is a MUTABLE read-model with no append-only guard (projection/messages.ts), so this UPDATE is legal — it
// is the resolution write that projection deliberately left NULL at receipt (sla_due_ts is Task 8's column).
// DETERMINISTIC: the due ts is `recorded_at + WINDOW` off the EVENT's recorded_at (never a fresh clock), so a
// redelivery re-computes the IDENTICAL value — re-setting is an exact no-op. Called on the queued paths (a
// human owns the reply) AND at the TOP of the auto_reply path (REQ-174 backstop): a partial-append death
// there leaves no answering message.sent, and the SLA is what lets the T8 sweep surface the vanished reply.
// A successfully-sent auto-reply carries a message.sent(in_reply_to) that the sweep's ANSWERED check honors,
// so the set SLA never becomes a false overdue flag.
async function setInboundSla(db: D1Database, inboundEventId: string, recordedAt: number): Promise<void> {
  await db
    .prepare("UPDATE messages SET sla_due_ts = ?1 WHERE id = ?2 AND direction = 'in'")
    .bind(recordedAt + SLA_REPLY_WINDOW_MS, `msg:${inboundEventId}`)
    .run();
}

// The tenant's effective rating config is loaded via the SHARED mirror (workers/agents/src/rate-config.ts,
// a byte-identical copy of workers/api/src/rate-config.ts guarded by test/rate-config-parity.test.ts). The
// agents worker does not depend on @shuddl/api, so the file is duplicated rather than imported — but the
// parity test fails CI on any drift, closing the "a fix to one loader silently mis-prices the other" gap.

// ---- the honest transit window (REQ-059) ------------------------------------------------------------
// The SHARED resolver for BOTH the fresh auto-reply AND the redelivery re-render: load the effective
// transit_matrix as-of `now` (SEPARATELY from the required rate config — a tenant without one still priced)
// and resolve the lane's whole business days over the SAME zone tariff pricing used. Returns the day count
// ONLY on a KNOWN lane; a missing matrix / absent request / unresolvable lane ⇒ undefined, so the caller
// OMITS the "Estimated transit" line — a number is NEVER fabricated (the honest-window law). BOTH call sites
// pass the SAME `now` (the inbound's recorded_at — the fast path reads it back as the sent event's `ts`), so a
// redelivery reproduces the IDENTICAL window, keeping the re-rendered reply byte-identical to the committed
// send (a divergent body would conflict the send's idempotency key).
async function resolveTransitDaysForReply(
  db: D1Database,
  now: number,
  request: { origin_zip: string; dest_zip: string } | undefined,
  zoneTariff: ZoneTariff,
): Promise<number | undefined> {
  if (request === undefined) return undefined;
  const matrix = await loadTransitMatrix(db, now);
  if (matrix === null) return undefined;
  const t = resolveTransitDays(request.origin_zip, request.dest_zip, matrix, zoneTariff);
  return t.status === "KNOWN" ? t.days : undefined;
}

// ---- record loading --------------------------------------------------------------------------------
type SqlRow = Record<string, string | number | null>;

// An event by its globally-unique id + kind (the consumer may not know the stream). A missing row on the
// trigger is POISON (redelivery cannot conjure it → skip); on the redelivery guards it means "not yet".
async function loadEventById(db: D1Database, eventId: string, kind: string): Promise<LedgerEvent | null> {
  const row = await db.prepare("SELECT * FROM events WHERE id = ? AND kind = ?").bind(eventId, kind).first<SqlRow>();
  return row === null ? null : rowToEvent(row);
}

// A recipient safe to interpolate into a mail send — a plausible address, never a header-injection vector.
// The send port's schema ALSO rejects CR/LF, but as a ZodError (not a SendError); we pre-check here so an
// undeliverable recipient HOLDS deterministically instead of throwing a non-retriable ZodError into a
// redelivery loop (Biller `plausibleEmail` parity).
function mailSafe(to: string): boolean {
  return to.includes("@") && !/[\r\n]/.test(to);
}

// ---- the tenant-scoped ResolvePort over D1 (REQ-025 — bound to ONE tenant's db) ---------------------
// findPartyByEmail matches an `email` inside any party's `contacts` JSON array (the same json_each shape the
// sequencer uses for device keys, and the honest email-bearing column the Biller reads). REQ-196: the match is
// CASE-INSENSITIVE (`lower(json_extract(...))` bound to normalizePartyEmail) so it finds a CSR-created party
// stored as `Bob@Acme.com` from a later `bob@acme.com` inbound — converging with intake instead of forking a
// duplicate. createParty writes the requester as a `shipper` with a primary contact (ORIGINAL-case email
// preserved for deliverability); createShipment writes a quote-stage shipment with the consumer-supplied
// created_ts (the pure resolve module has no clock — that is this port's job).
function makeResolvePort(db: D1Database, messageEventId: string, createdTs: number): ResolvePort {
  return {
    findPartyByEmail: async (email) => {
      const row = await db
        .prepare("SELECT p.id AS id FROM parties p, json_each(p.contacts) je WHERE lower(json_extract(je.value, '$.email')) = ?1 LIMIT 1")
        .bind(normalizePartyEmail(email))
        .first<{ id: string }>();
      return row === null ? null : { id: row.id };
    },
    createParty: async (p: { kind: PartyKind; email: string; name?: string }) => {
      const id = await partyIdForEmail(p.email);
      const names = JSON.stringify(p.name !== undefined && p.name !== "" ? { legal: p.name } : {});
      const contacts = JSON.stringify([{ kind: "primary", email: p.email }]);
      await db
        .prepare("INSERT OR IGNORE INTO parties (id, kind, names, contacts) VALUES (?,?,?,?)")
        .bind(id, p.kind, names, contacts)
        .run();
      return { id };
    },
    createShipment: async (s) => {
      const id = await shipmentIdFor(messageEventId);
      await db
        .prepare(
          "INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, refs, created_ts) VALUES (?,?,?,?,?,?)",
        )
        .bind(id, s.shipper_party_id, s.consignee_party_id, s.bill_to_party_id, s.refs, createdTs)
        .run();
      return { id };
    },
  };
}

// ---- the consumer ------------------------------------------------------------------------------------
export async function handleMessageReceived(message: MessageReceivedTrigger, deps: ConciergeDeps): Promise<ConciergeOutcome> {
  const msg = MessageReceivedTrigger.parse(message); // Zod at the boundary even when the caller pre-parsed
  const { db, seq, sender, parser, tenantFromName } = deps;

  // WP-15 REQ-030/L8 — consult the shared authority read-seam for the COMMS module before this consumer emits
  // the authoritative native reply (message.sent) below. `legacyValueAvailable` is false today (no legacy comms
  // mirror exists — Task 4), so authoritativeSource ALWAYS resolves to "native" and the Concierge composes /
  // sends exactly as before — behavior-identical. The dormant branch is where Tasks 4/6/8 defer to the
  // incumbent's outbound comms; it is UNREACHABLE while legacyValueAvailable is false (native always wins).
  const commsAuthority = authoritativeSource(await resolveAuthority(db, "comms"), false);
  if (commsAuthority === "legacy") {
    // DORMANT until a legacy comms mirror exists (Task 4). Unreachable today (native always wins).
    console.error(`concierge: comms authority is 'legacy' for message ${msg.event_id} but no mirror is wired (WP-15 Task 4) — proceeding native`);
  }

  // GUARD 1 — the trigger event must exist as a message.received on this tenant's ledger. A message that
  // references a nonexistent/foreign event is POISON: skip (non-retriable), never append.
  const inbound = await loadEventById(db, msg.event_id, "message.received");
  if (inbound === null || inbound.kind !== "message.received") {
    return { status: "skipped", reason: "message_not_found", detail: `message.received ${msg.event_id} not on tenant ${msg.tenant} — poison message` };
  }

  // The deterministic ids — the shipment id + every appended event id derive from the message event id (no
  // Date, no random), so a redelivery reproduces them EXACTLY. Computed once, up front, for the redelivery
  // fast/queued guards below AND the fresh flow.
  const shipmentId = await shipmentIdFor(msg.event_id);
  const quoteRequestedEventId = await conciergeEventId("quote-requested", msg.event_id);
  const quotePricedEventId = await conciergeEventId("quote-priced", msg.event_id);
  const messageSentEventId = await conciergeEventId("message-sent", msg.event_id);

  // REDELIVERY FAST PATH (mirror the Biller, REQ-100). If this inbound's auto-reply message.sent ALREADY
  // committed, compose + every gate ran and PASSED when it did; a redelivery goes STRAIGHT to the send,
  // re-derived from the committed events (re-send is dedupe-safe via the idempotency key). We do NOT re-parse
  // (no repeat LLM call, no model drift), re-resolve, or re-judge — re-judging under context drift could flip
  // a decision. THIS is what lets a retriable send THROW below and self-heal on redelivery (a transient blip
  // no longer silently loses the customer's quote — the C1 fix).
  const sentEvent = await loadEventById(db, messageSentEventId, "message.sent");
  if (sentEvent !== null) {
    return resendCommittedReply(db, seq, msg.tenant, sender, tenantFromName, shipmentId, sentEvent, { quoteRequestedEventId, quotePricedEventId, messageSentEventId });
  }

  // REDELIVERY (QUEUED). A quote.requested exists but NO message.sent ⇒ this inbound was already DECIDED as
  // queued (a human owns it) — there is nothing to auto-send. Return already_handled (no re-parse/re-judge).
  // Both this and the fast path are PRIMARY-KEY lookups on deterministic ids — no json_extract table scan (I1).
  // KNOWN GAP (same CLASS as REQ-169's Biller commit→enqueue window, but a DIFFERENT net): if a FRESH
  // auto-reply died AFTER appending quote.requested but BEFORE message.sent, this guard also returns
  // already_handled, so that reply never completes.
  //
  // Corrected 2026-08-03 (audit §102/§103) — the previous wording said "the [WP-11 reconciliation] sweep
  // detects it structurally … and re-drives it", which named the wrong sweep and overstated the action:
  //   · `recon-sweep.ts` is the BILLER reconciliation (committed pod.signed with no invoice). It has no
  //     concept of replies and will never see this.
  //   · The real net is `sla-sweep.ts`: it finds inbounds PAST their sla_due_ts with no answering
  //     message.sent and appends an internal overdue signal. It SURFACES the stranded reply for a human —
  //     it does NOT re-drive the send.
  //
  // LOAD-BEARING COUPLING — do not reorder without reading this. That net only works because
  // `setInboundSla` runs BEFORE the appends (see the three call sites below): a reply that dies mid-flight
  // must already carry its due ts, or the SLA sweep cannot find it and this gap loses its only backstop.
  // Pinned by workers/api/test/concierge.test.ts "the reply SLA is durable BEFORE the append" (audit §97),
  // which stages exactly that crash. The two properties live in different files and only work together.
  if ((await loadEventById(db, quoteRequestedEventId, "quote.requested")) !== null) {
    return { status: "already_handled", detail: `quote.requested already recorded (queued) for message ${msg.event_id}` };
  }

  // ── SPARK CAP (REQ-122/125) — THE AGENT-ACTION CHOKEPOINT, the CONVENIENCE seam ──────────────────────────
  // This LLM-powered auto-quote is an agent CONVENIENCE (genesis/04). BEFORE the parse (the LLM seam) runs,
  // reserve ONE AI action against this tenant's monthly Spark allotment. A NON-Spark tenant is UNCAPPED (the
  // injected gate no-ops). A Spark tenant OVER its allotment → the convenience is THROTTLED: return `capped`
  // (queue() ACKs it — redelivery cannot restore the allotment; the tenant records freight reality + invoices
  // as ever, it just loses the AGENT doing the quoting). "Credits throttle conveniences, not truth"
  // (genesis/04:15). Placed AFTER the redelivery guards so a completed/queued action is NOT re-charged, and
  // BEFORE the parse so no LLM call, resolve, price, append, or send runs for an over-cap tenant. The reserve is
  // keyed off a DETERMINISTIC per-inbound id, so a redelivery that re-reserves (e.g. after a downstream send
  // throw) counts the action ONCE. THE INVERSION: this is the ONLY Spark-cap consult in the whole consumer; the
  // sequencer append + the Biller invoice carry no gate at all, so the physical-truth path is never throttled.
  const reserved = deps.sparkGate ? await deps.sparkGate.reserve(`spark:concierge:${msg.event_id}`) : ({ ok: true } as const);
  if (!reserved.ok) {
    return {
      status: "capped",
      reason: "spark_over_allotment",
      detail: `tenant ${msg.tenant} is over its monthly Spark AI-credit allotment (${reserved.allotment}) — Concierge auto-quote throttled for message ${msg.event_id}; freight reality still records + invoices`,
    };
  }

  // ── FRESH ─────────────────────────────────────────────────────────────────────────────────────────────
  const payload: MessageReceivedPayload = inbound.payload;
  // The raw email the parser reads. `subject`/`body` are the interim inline parse source (see comms.ts);
  // absent ⇒ empty text, which the parser turns into an UNKNOWN/unresolved outcome (a documented gap, never
  // a crash) until the R2 body-resolver lands.
  const email: InboundEmail = { from: payload.from_ref, subject: payload.subject ?? "", body: payload.body ?? "" };

  // PARSE (REQ-024) — the ONLY LLM seam, injected. A NotConfigured/network/5xx failure THROWS (retriable via
  // the parse port) and the queue redelivers; we deliberately do NOT catch it here (the send-port law).
  //
  // METERING HOLD (audit §135/§136, corrected by §179). This call is the ONLY variable COST in the build —
  // every other agent is deterministic — and it emits no `agent.acted`. Only the rater does, from two
  // byte-identical paths, reporting an honest `cost_cents: 0`. Since `agent.acted` IS the metered AI action
  // (workers/billing/src/metering.ts) and the quantity the Watchtower budgets, the meter never observes the
  // one agent that spends money. The plumbing is complete and honest end-to-end — agent_runs carries
  // cost/latency, the projection records what an agent REPORTS and `{}` means unknown (never fabricated),
  // and the Watchtower averages ONLY reported metrics, so nothing here fails open. It simply never fires.
  // NOTE what IS metered: SparkMeter counts the Concierge convenience ACTION (REQ-122/125) — a count, with
  // no cost and no latency. §179 adds why no gate caught this: REQ-039's DoD is `agent_runs rows complete`,
  // and the rater's rows ARE complete, so it cannot detect that eleven of twelve built agents write none.
  const parse = await parser.parse(email);

  // RESOLVE (REQ-093) — tie the inbound to a Party + Shipment, or explain why it can't. The port does the
  // direct party/shipment INSERTs; the appended quote.requested (below) carries the provenance link. The
  // returned shipment_id equals the precomputed `shipmentId` above (same derivation from msg.event_id).
  // REQ-172 — resolve keys the party find/create off the AUTHENTICATED envelope sender (`from_ref`), NEVER
  // the model's `party_hint.email` (untrusted body output that could create an attacker party or match a
  // victim's, earning the existing-party resolution bump). `partyIdForEmail` below derives from the port's
  // `p.email`, which IS `senderEmail` — so identity is pinned to `from_ref` on every path (create + match).
  const port = makeResolvePort(db, msg.event_id, inbound.recorded_at);
  const resolved = await resolveConcierge(parse, port, msg.event_id, payload.from_ref);
  if (resolved.status === "unresolved") {
    // No shipment/party created, nothing quoted or sent. The outcome is the loud log until WP-11's queue.
    return { status: "unresolved", reason: resolved.reason, detail: `message ${msg.event_id} unresolved: ${resolved.reason}` };
  }

  const streamId = `s:${resolved.shipment_id}`;

  // PRICE → DECIDE (REQ-026/093/098). No tariff ⇒ can't auto-price: record the request + a draft, queue it.
  // REQ-173 (audit §404) — a MALFORMED required config throws HERE, at `ZoneTariff.parse` inside the loader,
  // and this call sits OUTSIDE the compose guard below. Un-caught it escapes into the queue's blanket
  // `catch → retry()` → DLQ, and the customer's quote email is SILENTLY LOST — the exact harm the guard at
  // "NEVER let a pricing throw escape" was written to prevent, on the one config path it did not cover.
  // The MISSING-config case was already handled gracefully (the `null` branch below); the MALFORMED case
  // was not, and both are "this tenant cannot be auto-priced right now".
  //
  // Treated identically: a throw becomes `null`, which takes the queued-for-a-human branch. Logged LOUDLY
  // because — unlike an absent tariff — a malformed one is an operator fault nothing else will surface.
  let ratingConfig: Awaited<ReturnType<typeof loadTenantRatingConfig>>;
  try {
    ratingConfig = await loadTenantRatingConfig(db, inbound.recorded_at);
  } catch (err) {
    console.error(
      `concierge: rate_config for tenant ${msg.tenant} is MALFORMED (stored payload failed its schema) — queueing this inbound for a human rather than losing it to the DLQ. Fix the tenant's rate_config rows:`,
      err,
    );
    ratingConfig = null;
  }
  if (ratingConfig === null) {
    // Owed a reply, not auto-answered → SET the SLA FIRST (before the appends). If a crash lands between
    // the quote.requested append and here, the redelivery guard returns already_handled — so setting the
    // SLA before the append guarantees an owed inbound always carries its due ts (deterministic, no-op re-set).
    await setInboundSla(db, msg.event_id, inbound.recorded_at);
    await appendQuoteRequested(seq, msg, streamId, resolved, parse, quoteRequestedEventId, inbound.recorded_at);
    await recordDraft(db, msg.event_id, resolved, payload.thread);
    return { status: "queued", shipment_id: resolved.shipment_id, party_id: resolved.party_id, quote_requested_event_id: quoteRequestedEventId, reason: "unknown_price", detail: `no rate_config in effect for tenant ${msg.tenant} — queued for a human` };
  }

  // PRICE → DECIDE, but NEVER let a pricing throw escape (REQ-173). priceShipment/the Rater compose THROWS
  // on an unpriceable request — a requested accessorial absent from the tenant schedule (no silent drop,
  // Migrator law), or a degenerate zero-rate tariff yielding empty lines. Un-caught, that throw propagates
  // out of the handler into the queue's blanket `catch → retry()` → infinite redelivery → DLQ → the customer
  // quote is SILENTLY LOST. Catch it and treat it EXACTLY like the `unknown_price` queued branch (a human
  // prices it): set the SLA, record the request + a draft, no send. The reason union is NOT widened — an
  // unpriceable request is an `unknown_price` cause, same as a null tariff / an UNKNOWN price.
  // REQ-059 — resolve the HONEST transit window INSIDE the compose guard (REQ-173 belt): a transit fault must
  // NEVER escape into the queue's blanket retry → DLQ and silently lose the quote (loadTransitMatrix already
  // degrades a malformed matrix to null, but the resolve stays inside the guard so no transit path can). NON-
  // required + additive: the matrix is loaded SEPARATELY from the required ratingConfig — a tenant without a
  // transit_matrix, or an unresolvable lane, yields UNKNOWN → transitDays undefined → compose OMITS the line
  // (never a fake number). transitDays is PINNED into message.sent below (REQ-178) so the redelivery fast path
  // re-renders the SAME line from committed bytes — never a live config re-read that could drift.
  let transitDays: number | undefined = undefined;
  let decision: Awaited<ReturnType<typeof composeConcierge>>;
  try {
    transitDays = await resolveTransitDaysForReply(db, inbound.recorded_at, parse.request, ratingConfig.zone_tariff);
    decision = await composeConcierge({
      parse,
      email,
      resolved: { party_id: resolved.party_id, shipment_id: resolved.shipment_id, resolution_confidence: resolved.resolution_confidence },
      ratingConfig,
      tenantFromName,
      ...(transitDays !== undefined ? { transitDays } : {}),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    // Owed a reply, not auto-answered → SET the SLA FIRST (before the appends), same as the queued branches.
    await setInboundSla(db, msg.event_id, inbound.recorded_at);
    await appendQuoteRequested(seq, msg, streamId, resolved, parse, quoteRequestedEventId, inbound.recorded_at);
    await recordDraft(db, msg.event_id, resolved, payload.thread);
    return {
      status: "queued",
      shipment_id: resolved.shipment_id,
      party_id: resolved.party_id,
      quote_requested_event_id: quoteRequestedEventId,
      reason: "unknown_price",
      detail: `message ${msg.event_id} could not be priced (${cause}) — queued for a human (no reply sent)`,
    };
  }

  // QUEUED — the gates in compose held (below_floor / not_corroborated / unknown_price / low_resolution). We
  // still RECORD the request (it is real; a human prices/answers it) + a DRAFT `messages` row, but NEVER send.
  if (decision.status === "queued") {
    // Owed a reply, not auto-answered → SET the SLA FIRST (see the unknown_price branch above for why order matters).
    await setInboundSla(db, msg.event_id, inbound.recorded_at);
    await appendQuoteRequested(seq, msg, streamId, resolved, parse, quoteRequestedEventId, inbound.recorded_at);
    await recordDraft(db, msg.event_id, resolved, payload.thread);
    return {
      status: "queued",
      shipment_id: resolved.shipment_id,
      party_id: resolved.party_id,
      quote_requested_event_id: quoteRequestedEventId,
      reason: decision.reason,
      detail: `message ${msg.event_id} composed but held: ${decision.reason} (no reply sent)`,
    };
  }

  // AUTO-REPLY — every gate passed. Append the ledger facts FIRST (quote.requested → quote.priced →
  // message.sent), THEN send. The reply's send references the message.sent event id (REQ-100).
  //
  // SLA BACKSTOP (REQ-174) — set the inbound SLA at the TOP of this block, BEFORE the appends. The auto-reply
  // appends quote.requested → quote.priced → message.sent as three separate DO calls; if #2/#3 dies (a
  // transient DO fault), redelivery finds message.sent absent, the queued guard returns `already_handled`,
  // and the reply is SILENTLY LOST. Setting the SLA first means such a dead auto-reply (quote.requested
  // committed, no answering message.sent) is caught by the T8 overdue sweep and surfaced as an internal
  // overdue note. A successfully-sent auto-reply carries a `message.sent in_reply_to` the inbound, so the
  // sweep's ANSWERED check correctly does NOT flag it — the SLA is a backstop, not a false alarm. The due ts
  // is deterministic (recorded_at + WINDOW), so re-setting on redelivery is an exact no-op.
  await setInboundSla(db, msg.event_id, inbound.recorded_at);
  await appendQuoteRequested(seq, msg, streamId, resolved, parse, quoteRequestedEventId, inbound.recorded_at);

  // WP-15 REQ-030/L8 — the Concierge auto-reply INDEPENDENTLY PRICES (it loaded the rating config above and
  // ran the Rater inside composeConcierge) and appends quote.priced below, so it is authoritative for the
  // RATING module too — not only comms. Consult the rating seam HERE, before the native price is committed, so
  // a future rating='legacy' tenant's concierge quote defers to the incumbent price mirror instead of silently
  // shipping a native price (the exact bypass the coverage lint guards — a comms-only consult would miss it).
  // `legacyValueAvailable` is false today ⇒ authoritativeSource ALWAYS resolves to "native" ⇒ behavior-identical;
  // dormant intent-marker branch, same as the comms consult above and the other sites. Tasks 4/6/8 light it up.
  const conciergeRatingAuthority = authoritativeSource(await resolveAuthority(db, "rating"), false);
  if (conciergeRatingAuthority === "legacy") {
    // DORMANT until a legacy price mirror exists (Task 4). Unreachable today (native always wins).
    console.error(`concierge: rating authority is 'legacy' for message ${msg.event_id} but no price mirror is wired (WP-15 Task 4) — proceeding native`);
  }

  await seq.append({
    tenant: msg.tenant,
    streamId,
    input: {
      id: quotePricedEventId,
      shipment_id: resolved.shipment_id,
      ts: inbound.recorded_at, // the inbound's commit instant this quote projects from — deterministic
      actor: { party: "agent:concierge" },
      party_refs: [resolved.party_id],
      evidence: [],
      source: "native",
      confidence: 10_000,
      kind: "quote.priced",
      payload: decision.quote_priced,
    },
  });

  const idempotencyKey = `concierge-reply/${messageSentEventId}`;
  // I2 — the reply recipient is the AUTHENTICATED envelope sender (`from_ref`), NEVER the model's
  // `party_hint.email`. That hint is model output over an untrusted body: a crafted email could steer it to
  // an arbitrary third party and the auto-reply would spray the tenant's firm-priced quote — from its
  // verified sending domain — at that address (a quote-spam relay on the tenant's reputation). The
  // deterministic parser's hint IS `from_ref` anyway; only the LLM's could diverge.
  const toRef = payload.from_ref;
  await seq.append({
    tenant: msg.tenant,
    streamId,
    input: {
      id: messageSentEventId,
      shipment_id: resolved.shipment_id,
      ts: inbound.recorded_at,
      actor: { party: "agent:concierge" },
      party_refs: [resolved.party_id],
      evidence: [],
      source: "native",
      confidence: 10_000,
      kind: "message.sent",
      payload: {
        channel: "email",
        to_ref: toRef,
        body_ref: idempotencyKey, // the durable pointer at the reply body (R2 persistence is a later WP)
        drafted_by_agent: "concierge",
        in_reply_to: msg.event_id,
        ...(payload.thread !== undefined ? { thread: payload.thread } : {}),
        // REQ-059/178 — PIN the resolved transit window so the fast path re-renders it from THIS committed
        // event, not a live config re-read (which could drift → a 409 hold on an already-sent reply). Absent
        // ⇒ the reply omitted the line, and the fast path omits it too — byte-identical either way.
        ...(transitDays !== undefined ? { transit_days: transitDays } : {}),
        // REQ-178 — PIN the tenant voice (from-name) the fresh reply is signed with, so the redelivery fast
        // path re-renders the SAME signature from THIS committed event, never a LIVE `tenantFromName` config
        // re-read that a between-send config change would drift → a divergent body → a 409 on the send's
        // idempotency key → a spurious permanent hold on an already-sent reply. Exactly what transit_days does
        // (and what Task 7's dunning send does). Canonical-hash-safe: optional field, absent on prior events.
        from_name: tenantFromName,
      },
    },
  });

  // THE SEND — downstream of the committed facts. A retriable failure THROWS (redelivery re-sends via the
  // fast path above); a permanent one HOLDS. Nothing here unwinds the ledger (REQ-100 / Biller law).
  const sendMsg: EvidenceMessage = {
    channel: "email",
    to: toRef,
    subject: decision.reply.subject,
    html: decision.reply.html,
    shipment_id: resolved.shipment_id,
    idempotency_key: idempotencyKey, // one message.sent event, one reply — dedupe under redelivery
  };
  return sendConciergeReply({
    seq,
    tenant: msg.tenant,
    sender,
    message: sendMsg,
    shipmentId: resolved.shipment_id,
    sentTs: inbound.recorded_at, // the committed message.sent's ts — the hold note (if any) rides the same instant
    partyId: resolved.party_id,
    partyCreated: resolved.party_created,
    quoteRequestedEventId,
    quotePricedEventId,
    messageSentEventId,
  });
}

// ---- the reply-send tail — shared by the fresh auto-reply path and the redelivery fast path -----------
// Everything here is DOWNSTREAM of the committed quote.requested/priced/message.sent: it may complete, hold,
// or throw for redelivery, but it NEVER unwinds those facts (REQ-100 / Biller law).
interface ReplySendCtx {
  /** The DO append surface — REQ-176 records the permanent-HOLD note through it (the only write path). */
  seq: SeqStubLike;
  /** The message tenant (the DO re-derives its identity from `${tenant}|${streamId}`, REQ-025). */
  tenant: string;
  sender: EvidenceSender;
  message: EvidenceMessage;
  shipmentId: string;
  /** The committed message.sent's ts — the hold note (REQ-176) rides the SAME deterministic instant. */
  sentTs: number;
  partyId: string;
  partyCreated: boolean;
  quoteRequestedEventId: string;
  quotePricedEventId: string;
  messageSentEventId: string;
}

async function sendConciergeReply(cx: ReplySendCtx): Promise<ConciergeOutcome> {
  const { seq, tenant, sender, message, shipmentId, sentTs, partyId, partyCreated, quoteRequestedEventId, quotePricedEventId, messageSentEventId } = cx;
  // A PERMANENT hold: the message.sent is RECORDED but the reply is never DELIVERED. SURFACE it (REQ-176) as a
  // durable internal note keyed off the held message.sent id (deterministic → idempotent under redelivery), so
  // the sla-sweep's ANSWERED check excludes it (a held reply must not clear the overdue timer) — was a lone
  // console.error. The note append rides the SAME sequencer DO on the shipment stream (no comms outside the
  // ledger, REQ-100). If THIS append faults transiently it throws out to the queue; redelivery re-holds + re-
  // appends the SAME note (dedupe-safe) — never a lost hold.
  const pending = async (detail: string): Promise<ConciergeOutcome> => {
    console.error(`concierge: ${detail}`);
    await seq.append({
      tenant,
      streamId: `s:${shipmentId}`,
      input: {
        id: await sendHoldNoteId(messageSentEventId),
        shipment_id: shipmentId,
        ts: sentTs,
        actor: { party: "agent:concierge" },
        party_refs: [],
        evidence: [],
        source: "native",
        confidence: 10_000,
        requested_visibility: "internal", // narrows message.received (counterparty) → internal, stamped server-side
        kind: "message.received",
        payload: { channel: "note", from_ref: "agent:concierge", body_ref: sendHoldBodyRef(messageSentEventId) },
      },
    });
    return { status: "issued_send_pending", shipment_id: shipmentId, party_id: partyId, quote_requested_event_id: quoteRequestedEventId, quote_priced_event_id: quotePricedEventId, message_sent_event_id: messageSentEventId, reason: "send_failed", detail };
  };

  // An undeliverable recipient can NEVER succeed (redelivery re-validates the same bytes): HOLD, do not send.
  if (!mailSafe(message.to)) {
    return await pending(`concierge reply recipient ${JSON.stringify(message.to)} is not a deliverable email (message.sent ${messageSentEventId}) — held send-pending, ledger facts stand`);
  }
  try {
    const receipt = await sender.send(message);
    return {
      status: "issued_replied",
      shipment_id: shipmentId,
      party_id: partyId,
      party_created: partyCreated,
      quote_requested_event_id: quoteRequestedEventId,
      quote_priced_event_id: quotePricedEventId,
      message_sent_event_id: messageSentEventId,
      provider: receipt.provider,
      provider_id: receipt.provider_id,
    };
  } catch (err) {
    if (err instanceof SendError) {
      // RETRIABLE ⇒ THROW so the queue redelivers; the redelivery FAST PATH re-sends from the committed
      // events (dedupe-safe via the idempotency key). Mirrors the Biller — a transient blip self-heals, and
      // the ledger facts already stand. PERMANENT ⇒ redelivery cannot help; HOLD for a human (WP-11).
      if (err.retriable) throw err;
      return await pending(`concierge reply permanently failed for message.sent ${messageSentEventId}: ${err.message} — held send-pending, ledger facts stand`);
    }
    // A non-SendError (an unexpected bug/fault) ⇒ THROW so the queue redelivers and it surfaces loudly.
    throw err;
  }
}

// REDELIVERY FAST PATH body — re-derive the EXACT reply from the committed events (a pure re-render of the
// recorded lane + sell) and re-send under the recorded idempotency key. Byte-identical to the original send,
// so the sender's key-dedupe returns the original receipt when it already went out, or delivers it when a
// prior send failed transiently. No re-parse, no re-judge.
async function resendCommittedReply(
  db: D1Database,
  seq: SeqStubLike,
  tenant: string,
  sender: EvidenceSender,
  tenantFromName: string,
  shipmentId: string,
  sentEvent: LedgerEvent,
  ids: { quoteRequestedEventId: string; quotePricedEventId: string; messageSentEventId: string },
): Promise<ConciergeOutcome> {
  const requested = await loadEventById(db, ids.quoteRequestedEventId, "quote.requested");
  const priced = await loadEventById(db, ids.quotePricedEventId, "quote.priced");
  const sent = sentEvent.payload as { to_ref: string; body_ref: string; transit_days?: number; from_name?: string };
  const partyId = sentEvent.party_refs[0] ?? "";
  if (requested === null || priced === null) {
    // message.sent committed but a preceding quote event is missing — cannot reconstruct the exact payload
    // to re-send safely (a mismatched payload would 409 the idempotency key). Nothing more to auto-do here.
    return { status: "already_handled", detail: `message.sent ${ids.messageSentEventId} committed but quote events missing — no safe re-send` };
  }
  const req = (requested.payload as { request: { origin_zip: string; dest_zip: string } }).request;
  const sell = (priced.payload as { sell: number }).sell;
  // REQ-059/178 — the honest transit line comes from the COMMITTED message.sent (`transit_days`), NEVER a live
  // config re-read. The fresh path pinned exactly what it rendered; reading it back makes this re-render
  // byte-identical to the original send regardless of any later config/matrix mutation (a live re-resolve
  // could return a different effective row → a 409 on the idempotency key → a spurious hold on a sent reply).
  // Absent ⇒ the original omitted the line ⇒ this omits it too. The fast path now reads ONLY committed events.
  // REQ-178 — the tenant voice (from-name) comes from the COMMITTED message.sent (`from_name`), NEVER the live
  // `tenantFromName` config dep: the fresh path pinned exactly what it signed, so reading it back makes this
  // re-render byte-identical to the original send regardless of a later from-name config change (a live re-read
  // could return a different voice → a divergent body → a 409 on the idempotency key → a spurious hold on a
  // sent reply). Absent ⇒ an OLDER send that predates the pin ⇒ fall back to the live dep (its historical
  // behavior). Same shape as the transit_days read-back above; the fast path now reads ONLY committed events.
  const reply = renderQuoteReply({
    shipment_ref: shipmentId,
    lane: { origin_zip: req.origin_zip, dest_zip: req.dest_zip },
    sell_cents: sell,
    tenant_from_name: sent.from_name ?? tenantFromName,
    ...(sent.transit_days !== undefined ? { transit_days: sent.transit_days } : {}),
  });
  const message: EvidenceMessage = { channel: "email", to: sent.to_ref, subject: reply.subject, html: reply.html, shipment_id: shipmentId, idempotency_key: sent.body_ref };
  return sendConciergeReply({ seq, tenant, sender, message, shipmentId, sentTs: sentEvent.ts, partyId, partyCreated: false, quoteRequestedEventId: ids.quoteRequestedEventId, quotePricedEventId: ids.quotePricedEventId, messageSentEventId: ids.messageSentEventId });
}

// ---- append helpers ---------------------------------------------------------------------------------
// quote.requested — the request event, carrying the canonical rate request AND source_message_event_id (the
// provenance link the idempotency guard + Task-4 orphan-correlation both key off). Appended on BOTH the
// auto_reply and queued paths (the request is real either way; only the SEND differs).
async function appendQuoteRequested(
  seq: SeqStubLike,
  msg: MessageReceivedTrigger,
  streamId: string,
  resolved: { party_id: string },
  parse: { request?: unknown },
  eventId: string,
  ts: number,
): Promise<void> {
  await seq.append({
    tenant: msg.tenant,
    streamId,
    input: {
      id: eventId,
      shipment_id: streamId.slice(2),
      ts,
      actor: { party: "agent:concierge" },
      party_refs: [resolved.party_id],
      evidence: [],
      source: "native",
      confidence: 10_000,
      kind: "quote.requested",
      payload: { request: parse.request, source_message_event_id: msg.event_id },
    },
  });
}

// The internal DRAFT artifact for a human (queued path). `messages` is a MUTABLE read-model (no append-only
// guard), so a direct INSERT OR IGNORE on a deterministic id is legal + idempotent — and it never clobbers a
// resolution the sequencer's projection already wrote (that path is INSERT OR IGNORE too). NOT a message.sent
// (a draft was never sent — appending message.sent would falsely record a send, REQ-100).
async function recordDraft(
  db: D1Database,
  messageEventId: string,
  resolved: { party_id: string; shipment_id: string; resolution_confidence: number },
  thread: string | undefined,
): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO messages (id, channel, direction, party_id, shipment_id, resolved_conf, thread, body_ref, drafted_by_agent, sla_due_ts) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      `msg:draft:${messageEventId}`,
      "email",
      "out",
      resolved.party_id,
      resolved.shipment_id,
      resolved.resolution_confidence,
      thread ?? null,
      `concierge-draft/${messageEventId}`,
      "concierge",
      null,
    )
    .run();
}
