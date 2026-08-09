import type { Hono } from "hono";
import type { LedgerEvent } from "@shuddl/contracts";
import { rowToEvent } from "@shuddl/ledger/lens";
import { plausibleEmail } from "@shuddl/ledger/contacts";
import {
  renderDunningDraft,
  overdueDays,
  dunningDraftId,
  ResendSender,
  NotConfiguredSender,
  SendError,
  type DunningBucket,
  type EvidenceMessage,
  type EvidenceSender,
} from "@shuddl/agents";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { resolveTenantDb } from "../tenants.js";
import { authoritativeSource, resolveAuthority } from "../authority.js";
import { translateAppendError } from "./events.js";
import type { AppendedEvent } from "../do/sequencer.js";
import type { Env, Vars } from "../index.js";

// WP-11 Task 7 (REQ-032) — the HUMAN review-and-send for the Collector's dunning DRAFTS. The Collector cron
// (workers/agents/src/collector.ts) DRAFTS a tone-matched dunning `messages` row per OPEN overdue invoice and
// NEVER sends (drafted_by_agent='collector', direction='out', shipment_id NULL, body_ref='collector-dunning/
// <invoice>/<bucket>', no message.sent). This module is the other half: an operator reviews the drafts (GET
// /v1/dunning?status=draft) and clicks send (POST /v1/dunning/:id/send). The HUMAN IS THE APPROVAL — there is
// no auto-send anywhere, and the WP-10 dual-control matrix is deliberately NOT wired (draft quality is
// human-rated per the REQ-032 DoD, not matrix-gated).
//
// THE SEND MIRRORS THE BILLER/CONCIERGE append-then-send tail (biller.ts sendEvidence / concierge.ts
// sendConciergeReply):
//   · The rendered body is a PURE function of COMMITTED state (renderDunningDraft over the invoice's
//     total_cents/due_ts + the aging bucket recovered from the draft's body_ref), so the sent bytes are
//     REPRODUCIBLE. The send instant is PINNED into the message.sent event's `ts`, and the tenant "voice"
//     (from_name) is PINNED into its payload — so the fast-path re-render is byte-identical from committed
//     state, immune to a wall-clock read or a from-name config change (the REQ-178 transit_days lesson).
//   · The message.sent event is appended THROUGH the sequencer FIRST (the send is on the timeline), with a
//     DETERMINISTIC id per (invoice, bucket): a re-POST re-derives it, the sequencer dedupes by id, and we take
//     the FAST PATH — re-send from committed bytes under the same idempotency key (no second event, no double
//     email). It rides a party/invoice-scoped `q:` stream with NO shipment_id (the projected row mirrors the
//     draft: shipment_id NULL — the widened, party-scoped send, sender.ts BASE_FIELDS).
//   · HONEST HOLD (the pattern at workers/agents/src/biller.ts:608@resolveRecipient ): a recipient with no billing email HOLDS with NOTHING
//     appended (a message.sent with no to_ref would falsely claim a send); a permanent SendError HOLDS with the
//     event standing (surfaced honestly as `held`, never a false `sent`); a retriable SendError THROWS (a 5xx
//     the idempotency middleware does not cache, so a retry re-sends via the fast path — never a DLQ loop).
// Tenant is the JWT claim ONLY (tenantDb, REQ-025). NO new table/kind — drafts are `messages` rows; the send is
// a `message.sent` event.

const DEFAULT_DUNNING_FROM_NAME = "Shuddl Billing"; // REQ-098/167 tenant-voice fallback — REQ-167-clean (no names)
const MAX_DRAFT_ID_LEN = 200; // bound BEFORE the DO name / any query (mirrors events.ts / approvals.ts) — 400, not 500
const SEND_CONFIDENCE_BPS = 10_000; // a deterministic server-recorded fact (mirrors the Biller/Concierge appends)
const DUNNING_BUCKETS: ReadonlySet<string> = new Set<DunningBucket>(["reminder", "firm", "final"]);

// ---- the sequencer append surface (hand-written for the same TS reason events.ts binds SeqStub) -------------
interface SeqAppend {
  append(req: { tenant: string; streamId: string; input: unknown }): Promise<AppendedEvent>;
}
function sequencerFor(env: Env): SeqAppend {
  return {
    append: (req) =>
      (env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${req.tenant}|${req.streamId}`)) as unknown as SeqAppend).append(req),
  };
}

// The send port — the SAME composition-root discipline as the agents worker (workers/agents/src/index.ts
// evidenceSender): BOTH halves bound ⇒ ResendSender; anything less ⇒ NotConfiguredSender (rejects LOUDLY,
// retriable). Unbound in CI, so the live sender is never reached in tests (the injected RecordingSender is).
// EXPORTED FOR A DIRECT TEST (§798) — mirroring `resolveRecipient`/`deliveryStopGeo`. This selection is a
// byte-for-byte twin of the Biller's (`workers/agents/src/index.ts:237`), and only the Biller's had a
// behavioural test. Replacing the fallback here with a silently-succeeding stub left `workers/api` at
// 808/808 — and this route APPENDS `message.sent` BEFORE sending, so the ledger would record a delivered
// demand for money that never left the building.
export function evidenceSender(env: Env): EvidenceSender {
  const apiKey = env.RESEND_API_KEY;
  const from = env.EVIDENCE_FROM;
  if (apiKey !== undefined && apiKey !== "" && from !== undefined && from !== "") return new ResendSender({ apiKey, from });
  return new NotConfiguredSender();
}
function dunningFromName(env: Env): string {
  return env.DUNNING_FROM_NAME !== undefined && env.DUNNING_FROM_NAME !== "" ? env.DUNNING_FROM_NAME : DEFAULT_DUNNING_FROM_NAME;
}

// ---- deterministic ids (no Date, no random — a re-POST must reproduce them exactly) --------------------------
// A DETERMINISTIC v4-variant UUID (satisfies EventInput.id = z.string().uuid()) from a domain-separated seed —
// the SAME shaping approvals.ts / rate.ts use. Seeding the message.sent id off (invoice, bucket) makes a re-POST
// re-derive the SAME id → the sequencer dedupes → one message.sent per draft, ever.
async function deterministicUuid(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  const h = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  const variant = ((parseInt(h.slice(16, 17) || "0", 16) & 0x3) | 0x8).toString(16); // 8/9/a/b
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export async function dunningSentEventId(invoiceId: string, bucket: DunningBucket): Promise<string> {
  return deterministicUuid(`collector:dunning-sent:${invoiceId}:${bucket}`);
}

// The message.sent rides a party/invoice-scoped `q:` stream (stream regex `q:[\w-]+`) — NOT a shipment stream: a
// dunning is invoice-scoped and an invoice may cover several shipments (invoices.shipment_ids). No shipment_id in
// the envelope ⇒ the projected messages row carries shipment_id NULL, mirroring the draft.
function dunningStreamId(invoiceId: string, bucket: DunningBucket): string {
  return `q:dunning-${invoiceId}-${bucket}`;
}

// Recover (invoice, bucket) from the draft's deterministic body_ref (`collector-dunning/<invoiceId>/<bucket>`,
// dunningBodyRef). Split on the LAST slash so an invoice id is preserved verbatim; the bucket is validated
// against the frozen three. Returns null on anything unrecoverable (a forged/foreign body_ref).
function parseDunningRef(bodyRef: string): { invoiceId: string; bucket: DunningBucket } | null {
  const prefix = "collector-dunning/";
  if (!bodyRef.startsWith(prefix)) return null;
  const rest = bodyRef.slice(prefix.length);
  const slash = rest.lastIndexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  const invoiceId = rest.slice(0, slash);
  const bucket = rest.slice(slash + 1);
  if (!DUNNING_BUCKETS.has(bucket)) return null;
  return { invoiceId, bucket: bucket as DunningBucket };
}

// ---- recipient resolution (a MIRROR of the Biller's, pinned to the SHARED predicate — anti-drift) -----------
// A `kind:"billing"` contact wins over the first plausible one; `plausibleEmail` (@shuddl/ledger/contacts) is the
// SAME per-entry predicate the Biller's resolveRecipient (`workers/agents/src/biller.ts:231@resolveRecipient`
// — repointed 2026-07-28 by the citation gate: `:153` had rotted onto `formatUtc`) and the Collector
// sweep apply — re-implemented here (the api worker does not import the agents worker's internals) but pinned to
// that one predicate, so the SEND reaches EXACTLY the address the sweep validated before drafting (no drift).
async function resolveDunningRecipient(db: D1Database, partyId: string): Promise<string | undefined> {
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

// ---- record loading -----------------------------------------------------------------------------------------
type SqlRow = Record<string, string | number | null>;
interface InvoiceRow {
  total_cents: number;
  due_ts: number | null;
  party_id: string;
  status: string;
}
async function loadInvoice(db: D1Database, invoiceId: string): Promise<InvoiceRow | null> {
  return db
    .prepare("SELECT total_cents, due_ts, party_id, status FROM invoices WHERE id = ?1")
    .bind(invoiceId)
    .first<InvoiceRow>();
}
async function loadMessageSent(db: D1Database, eventId: string): Promise<LedgerEvent | null> {
  const row = await db.prepare("SELECT * FROM events WHERE id = ?1 AND kind = 'message.sent'").bind(eventId).first<SqlRow>();
  return row === null ? null : rowToEvent(row);
}
function payloadString(payload: unknown, key: string): string | undefined {
  if (payload !== null && typeof payload === "object") {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
}

// ---- the human-send handler ---------------------------------------------------------------------------------
export interface DunningSendDeps {
  /** The message tenant's OWN D1 (the route resolves it via tenantDb off the JWT claim — REQ-025). */
  db: D1Database;
  /** The tenant slug — folded into the sequencer DO name and named on the append (the DO re-derives + checks it). */
  tenant: string;
  seq: SeqAppend;
  sender: EvidenceSender;
  /** REQ-098/178 tenant voice — the from-name signed into the body AND pinned into message.sent. */
  tenantFromName: string;
  /** The send clock — pinned into message.sent.ts so the fast-path re-render is deterministic (injected in tests). */
  now: () => number;
}

export type DunningSendOutcome =
  | { status: "sent"; invoice_id: string; bucket: DunningBucket; message_sent_event_id: string; provider: string; provider_id: string }
  | { status: "held"; invoice_id: string; bucket: DunningBucket; reason: "recipient_unresolved" | "send_failed_permanent"; detail: string; message_sent_event_id?: string }
  | { status: "skipped"; reason: "draft_not_found" | "malformed_draft" | "invoice_not_found" | "invoice_not_open"; detail: string };

// Render the dunning body from COMMITTED state and SEND. Shared by the fresh-append path and the redelivery
// fast path: `sentTs` + `fromName` come from the committed message.sent either way, so the bytes are identical.
async function renderAndSend(args: {
  sender: EvidenceSender;
  invoiceId: string;
  bucket: DunningBucket;
  amountCents: number;
  dueTs: number | null;
  sentTs: number;
  fromName: string;
  recipient: string;
  bodyRef: string;
  sentEventId: string;
}): Promise<DunningSendOutcome> {
  // days-overdue from the COMMITTED send instant (message.sent.ts) + the committed due_ts — a pure function, so a
  // re-send re-derives the IDENTICAL count. A null due_ts (no terms) clamps to 0 (the sweep never drafts one).
  const daysOverdue = args.dueTs === null ? 0 : overdueDays(args.sentTs, args.dueTs);
  const rendered = renderDunningDraft({
    invoice_ref: args.invoiceId,
    amount_cents: args.amountCents,
    days_overdue: daysOverdue,
    bucket: args.bucket,
    tenant_from_name: args.fromName,
  });
  const message: EvidenceMessage = {
    channel: "email",
    to: args.recipient,
    subject: rendered.subject,
    html: rendered.html,
    // deterministic per (invoice, bucket) — the sender dedupes a re-send; NO shipment_id (party/invoice-scoped).
    idempotency_key: args.bodyRef,
  };
  try {
    const receipt = await args.sender.send(message);
    return { status: "sent", invoice_id: args.invoiceId, bucket: args.bucket, message_sent_event_id: args.sentEventId, provider: receipt.provider, provider_id: receipt.provider_id };
  } catch (err) {
    if (err instanceof SendError && !err.retriable) {
      // Redelivery cannot help (validation-adjacent 4xx / idempotency conflict / unwired channel): HOLD honestly.
      // The message.sent event STANDS (the send is on the timeline); the outcome reports the real held state.
      const detail = `dunning send permanently failed for invoice ${args.invoiceId} (${args.bucket}): ${err.message} — HELD, the message.sent event stands`;
      console.error(`dunning: ${detail}`);
      return { status: "held", invoice_id: args.invoiceId, bucket: args.bucket, reason: "send_failed_permanent", detail, message_sent_event_id: args.sentEventId };
    }
    // Retriable (or an unexpected non-SendError) ⇒ THROW so the POST returns a 5xx (uncached) and a retry
    // re-sends via the fast path. The message.sent already stands; the sender's key dedupes. NEVER re-append.
    throw err;
  }
}

export async function sendDunningDraft(deps: DunningSendDeps, draftId: string): Promise<DunningSendOutcome> {
  const { db, tenant, seq, sender, tenantFromName, now } = deps;

  // WP-15 REQ-030/L8 — consult the shared authority read-seam for the COMMS module before this service emits
  // the authoritative native dunning (message.sent) below. `legacyValueAvailable` is false today (no legacy
  // comms mirror exists — Task 4), so authoritativeSource ALWAYS resolves to "native" and the human-send runs
  // exactly as before — behavior-identical. The dormant branch is where Tasks 4/6/8 defer to the incumbent's
  // outbound comms; it is UNREACHABLE while legacyValueAvailable is false (native always wins).
  const commsAuthority = authoritativeSource(await resolveAuthority(db, "comms"), false);
  if (commsAuthority === "legacy") {
    // DORMANT until a legacy comms mirror exists (Task 4). Unreachable today (native always wins).
    console.error(`dunning: comms authority is 'legacy' for draft ${draftId} but no mirror is wired (WP-15 Task 4) — proceeding native`);
  }

  // 1 — load the DRAFT row (a Collector-drafted outbound `messages` row).
  const draft = await db
    .prepare("SELECT id, body_ref FROM messages WHERE id = ?1 AND drafted_by_agent = 'collector' AND direction = 'out'")
    .bind(draftId)
    .first<{ id: string; body_ref: string | null }>();
  if (draft === null || draft.body_ref === null) {
    return { status: "skipped", reason: "draft_not_found", detail: `no Collector dunning draft ${draftId}` };
  }

  // 2 — recover (invoice, bucket) from the body_ref pointer AND verify it reconstructs the draft id (integrity).
  const ref = parseDunningRef(draft.body_ref);
  if (ref === null || dunningDraftId(ref.invoiceId, ref.bucket) !== draftId) {
    return { status: "skipped", reason: "malformed_draft", detail: `draft ${draftId} body_ref ${JSON.stringify(draft.body_ref)} is not a recoverable dunning pointer` };
  }
  const { invoiceId, bucket } = ref;

  // 3 — load the invoice (committed AR state) — the send re-renders as a PURE function of it.
  const invoice = await loadInvoice(db, invoiceId);
  if (invoice === null) {
    return { status: "skipped", reason: "invoice_not_found", detail: `dunning draft ${draftId} references invoice ${invoiceId}, which has no row` };
  }

  // 4 — the deterministic message.sent id. If it already committed, take the FAST PATH: re-render from the
  // COMMITTED event (its ts + pinned from_name + to_ref) and re-send idempotently. A prior transient failure
  // self-heals; a completed send returns the original receipt. Never re-judges the invoice (a since-paid
  // invoice's send already happened — undoing it is not this route's job; REQ-031 the record stands).
  const sentEventId = await dunningSentEventId(invoiceId, bucket);
  const existing = await loadMessageSent(db, sentEventId);
  if (existing !== null) {
    const recipient = payloadString(existing.payload, "to_ref");
    if (recipient === undefined) {
      // A committed message.sent must carry to_ref (schema min(1)); absence is a data fault, not a re-send target.
      return { status: "held", invoice_id: invoiceId, bucket, reason: "recipient_unresolved", detail: `committed message.sent ${sentEventId} has no to_ref — cannot re-send`, message_sent_event_id: sentEventId };
    }
    return renderAndSend({
      sender,
      invoiceId,
      bucket,
      amountCents: invoice.total_cents,
      dueTs: invoice.due_ts,
      sentTs: existing.ts,
      fromName: payloadString(existing.payload, "from_name") ?? tenantFromName,
      recipient,
      bodyRef: draft.body_ref,
      sentEventId,
    });
  }

  // 5 — FRESH. Refuse to dun a NON-OPEN invoice: a since-paid/settled AR must never get a fresh dunning.
  if (invoice.status !== "issued") {
    return { status: "skipped", reason: "invoice_not_open", detail: `invoice ${invoiceId} is '${invoice.status}', not open AR — no dunning sent` };
  }

  // Resolve the recipient (the SAME resolver the sweep validated). No billing email ⇒ HOLD with NOTHING appended:
  // a message.sent needs a to_ref, and recording one with no recipient would falsely claim a send (REQ-100).
  const recipient = await resolveDunningRecipient(db, invoice.party_id);
  if (recipient === undefined) {
    return { status: "held", invoice_id: invoiceId, bucket, reason: "recipient_unresolved", detail: `bill-to party ${invoice.party_id} has no billing email — dunning HELD unsent` };
  }

  // Append message.sent THROUGH the sequencer FIRST (the send is on the timeline). The ts is PINNED (the send
  // instant) and from_name is PINNED (the tenant voice) so the fast-path re-render is byte-identical. party_refs
  // is empty (a tenant-internal comms record, mirroring the Biller's invoice.issued); shipment_id is omitted.
  const sentTs = now();
  const appended = await seq.append({
    tenant,
    streamId: dunningStreamId(invoiceId, bucket),
    input: {
      id: sentEventId,
      ts: sentTs,
      actor: { party: "agent:collector" }, // server-controlled sentinel (mirrors "agent:biller"/"agent:concierge")
      party_refs: [],
      evidence: [],
      source: "native",
      confidence: SEND_CONFIDENCE_BPS,
      kind: "message.sent",
      payload: {
        channel: "email",
        to_ref: recipient,
        body_ref: draft.body_ref, // the SAME pointer the draft carries — how the read correlates draft→sent
        drafted_by_agent: "collector",
        from_name: tenantFromName, // REQ-178 — pinned so a from-name config change can't drift a re-render
      },
    },
  });

  // Render from the RETURNED committed event (its ts + from_name), not the local clock — so a concurrent
  // double-POST that deduped to the ORIGINAL event still renders the ORIGINAL bytes (no idempotency-key 409).
  return renderAndSend({
    sender,
    invoiceId,
    bucket,
    amountCents: invoice.total_cents,
    dueTs: invoice.due_ts,
    sentTs: appended.ts,
    fromName: payloadString(appended.payload, "from_name") ?? tenantFromName,
    recipient: payloadString(appended.payload, "to_ref") ?? recipient,
    bodyRef: draft.body_ref,
    sentEventId: appended.id,
  });
}

// ---- the draft-queue read -----------------------------------------------------------------------------------
export interface DunningListItem {
  draft_id: string;
  invoice_id: string;
  party_id: string;
  bucket: DunningBucket;
  amount_cents: number;
  due_ts: number | null;
  days_overdue: number;
  recipient: string | null;
  subject: string;
  preview_html: string;
}

// List the Collector's drafts. A draft is UNSENT iff NO message.sent shares its body_ref (the send projects a
// `messages` row carrying the SAME body_ref — a self-contained correlation in the read-model, no events join).
// status='sent' inverts it (the sent ones). A draft whose invoice vanished, or whose AR has since settled
// (status != 'issued'), is honestly EXCLUDED from the draft queue — there is nothing to dun.
export async function listDunningDrafts(
  db: D1Database,
  status: "draft" | "sent",
  tenantFromName: string,
  now: number,
): Promise<DunningListItem[]> {
  const existence = status === "draft" ? "NOT EXISTS" : "EXISTS";
  // VOLUME HOLD (audit §183 + §185): no LIMIT, and `EXPLAIN QUERY PLAN` returns a bare SCAN — `messages`
  // has only an id PK, so neither drafted_by_agent nor direction is indexed, and collector drafts
  // accumulate every dunning cycle. See GO-LIVE-CHECKLIST for the keyset fix (not a bare LIMIT).
  const rows = (
    await db
      .prepare(
        `SELECT d.id, d.body_ref FROM messages d
         WHERE d.drafted_by_agent = 'collector' AND d.direction = 'out' AND d.id LIKE 'msg:dunning:%'
           AND ${existence} (SELECT 1 FROM messages s WHERE s.body_ref = d.body_ref AND s.id <> d.id)
         ORDER BY d.id`,
      )
      .all<{ id: string; body_ref: string | null }>()
  ).results;

  const items: DunningListItem[] = [];
  for (const r of rows) {
    if (r.body_ref === null) continue;
    const ref = parseDunningRef(r.body_ref);
    if (ref === null) continue;
    const invoice = await loadInvoice(db, ref.invoiceId);
    if (invoice === null) continue; // a draft whose invoice vanished — not actionable
    if (status === "draft" && invoice.status !== "issued") continue; // a since-settled AR is not dunnable
    const daysOverdue = invoice.due_ts === null ? 0 : overdueDays(now, invoice.due_ts);
    const recipient = await resolveDunningRecipient(db, invoice.party_id);
    const preview = renderDunningDraft({
      invoice_ref: ref.invoiceId,
      amount_cents: invoice.total_cents,
      days_overdue: daysOverdue,
      bucket: ref.bucket,
      tenant_from_name: tenantFromName,
    });
    items.push({
      draft_id: r.id,
      invoice_id: ref.invoiceId,
      party_id: invoice.party_id,
      bucket: ref.bucket,
      amount_cents: invoice.total_cents,
      due_ts: invoice.due_ts,
      days_overdue: daysOverdue,
      recipient: recipient ?? null,
      subject: preview.subject,
      preview_html: preview.html,
    });
  }
  return items;
}

export function mountDunningRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // GET /v1/dunning?status=draft — the Collector's DRAFT dunning queue. roles admin/ops/finance (the money-lens
  // roles; a portal party/driver/read has no send authority here). Tenant off the JWT claim ONLY (tenantDb).
  app.get("/v1/dunning", requireRole("admin", "ops", "finance"), async (c) => {
    const session = c.get("session");
    const db = await resolveTenantDb(c.env, session.tenant);
    const status = c.req.query("status") ?? "draft";
    if (status !== "draft" && status !== "sent") throw new ApiError("VALIDATION_FAILED", 400, "status MUST BE draft OR sent");
    const drafts = await listDunningDrafts(db, status, dunningFromName(c.env), Date.now());
    return c.json({ drafts });
  });

  // POST /v1/dunning/:id/send — a HUMAN-INITIATED send of a specific draft (the human IS the approval; no
  // auto-send, no dual-control matrix). roles admin/ops/finance. The WP-01 idempotency middleware already
  // requires the Idempotency-Key header; the deterministic message.sent id dedupes the send itself.
  app.post("/v1/dunning/:id/send", requireRole("admin", "ops", "finance"), async (c) => {
    const session = c.get("session");
    const draftId = c.req.param("id") ?? "";
    if (draftId.length > MAX_DRAFT_ID_LEN) throw new ApiError("VALIDATION_FAILED", 400, "DRAFT ID TOO LONG");
    const db = await resolveTenantDb(c.env, session.tenant); // REQ-025 — D1 keyed off the claim only

    const deps: DunningSendDeps = {
      db,
      tenant: session.tenant,
      seq: sequencerFor(c.env),
      sender: evidenceSender(c.env),
      tenantFromName: dunningFromName(c.env),
      now: () => Date.now(),
    };

    let outcome: DunningSendOutcome;
    try {
      outcome = await sendDunningDraft(deps, draftId);
    } catch (err) {
      // A retriable SendError ⇒ 503 (a 5xx the idempotency middleware does NOT cache), so a retry re-attempts the
      // send via the fast path (the message.sent already stands, the sender key dedupes). Anything else is a DO
      // append fault — map it to its stable envelope (translateAppendError → 4xx, or INTERNAL 500).
      if (err instanceof SendError) throw new ApiError("INTERNAL", 503, "DUNNING SEND FAILED — RETRIABLE, RETRY THE SEND");
      throw translateAppendError(err);
    }

    if (outcome.status === "skipped") {
      // A settled invoice is a conflict-with-current-state (409); a missing/malformed draft is a 404.
      if (outcome.reason === "invoice_not_open") throw new ApiError("VALIDATION_FAILED", 409, outcome.detail);
      throw new ApiError("NOT_FOUND", 404, outcome.detail);
    }
    return c.json(outcome, 200);
  });
}
