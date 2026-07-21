// WP-14 Task 7 · REQ-123/025/003 — THE PLATFORM-TENANT APPEND PORT.
//
// Credits are MONEY EVENTS on the reserved `_platform` revenue tenant, PROJECTED — never a direct money_lines
// write (REQ-003). This port appends an `invoice.issued` / `payment.received` to the platform D1 and runs the
// SHIPPED money projection (applyMoneyProjection) in the SAME db.batch() as the event insert — exactly what the
// api sequencer does (workers/api/src/do/sequencer.ts), so I1 holds both directions (no line without its event;
// no half-applied money event).
//
// WHY A DEDICATED PORT (not the api sequencer, here) — the append-path decision (STEP 0):
//   The api sequencer resolves its tenant D1 via tenantDb(env, tenant), and tenantDb FORBIDs `_platform`
//   (workers/api/src/tenants.ts) — the reserved tenant's D1 is reachable ONLY server-side via
//   resolvePlatformTenantDb, never a customer path. Teaching the sequencer to resolve `_platform` (a
//   SERVER-SIDE-ONLY internal path a customer JWT can NEVER drive) is a change to workers/api — OUT OF SCOPE for
//   this task (scope = workers/billing/**). So the credit EMITTER + its money projection are built and TESTED
//   here against the platform D1 via this port (proving the credit_purchase money-event mapping), and the LIVE
//   append-through-sequencer for `_platform` (with the claimed-slug write-path) is wired in Task 10. `PlatformLedger`
//   is the seam: Task 10 swaps D1PlatformLedger for a sequencer-routed impl without touching the emitter.
//
// A customer can NEVER drive this path: the platform D1 is resolved with NO slug argument (a single well-known
// target — resolvePlatformTenantDb), and the webhook that reaches it is Stripe-authed (signature), not
// customer-authed. There is no client-influenced input on the tenant resolution at all (REQ-025).
import { EventInput, LedgerEvent } from "@shuddl/contracts";
import { GENESIS_HASH, hashEvent } from "@shuddl/ledger/chain";
import { eventToRow } from "@shuddl/ledger/lens";
import { applyMoneyProjection, type MoneyProjectionDeps } from "@shuddl/ledger/projection/money";

/** The append seam. Task 10 provides a sequencer-routed impl for the live `_platform` path; D1PlatformLedger is
 *  the tested interim that proves the money-event projection. `streamId` is DO-authoritative in the sequencer
 *  world; here it is assigned by the caller (the emitter derives a per-purchase credit stream). */
export interface PlatformLedger {
  append(req: { streamId: string; input: EventInput }): Promise<{ id: string }>;
}

// The EXACT event columns the platform D1 carries under the billing migration set (0001–0004, 0007 — see
// test/helpers.ts). override_json (0005) is deliberately ABSENT: a credit event never carries a gate override,
// so on a full-schema production D1 that column takes its NULL default. Mirrors test/helpers.ts EVENT_COLUMNS.
const EVENT_COLUMNS = [
  "stream_id", "seq", "id", "shipment_id", "ts", "recorded_at", "kind",
  "actor_party_id", "actor_user_id", "actor_device_id", "party_refs", "payload",
  "evidence", "prev_hash", "hash", "sig", "visibility", "source", "confidence",
  "device_id", "device_seq", "captured_ts",
] as const;
const EVENT_INSERT_SQL = `INSERT INTO events (${EVENT_COLUMNS.join(",")}) VALUES (${EVENT_COLUMNS.map(() => "?").join(",")})`;

/**
 * The concrete platform-D1 append. Mirrors the sequencer's core loop minimally: idempotency by event id,
 * seq/prev_hash off the stream tail, canonical hash, then ONE batch = event insert + money projection. It does
 * NOT reproduce the sequencer's gates (credit events are not gated transition kinds) or the cross-script DO
 * mutex (Task 10's sequencer-routed impl restores that); idempotency by event id makes redelivery safe here.
 */
export class D1PlatformLedger implements PlatformLedger {
  private readonly db: D1Database;
  constructor(db: D1Database) {
    this.db = db;
  }

  async append({ streamId, input }: { streamId: string; input: EventInput }): Promise<{ id: string }> {
    const parsed = EventInput.parse(input); // Zod at the boundary even when the caller pre-built it

    // Idempotency — replay by event id returns the ORIGINAL (twice in = once out). The emitter derives the
    // event id deterministically from the Stripe payment correlation id, so a redelivered (or duplicate) Stripe
    // event re-derives the SAME id and lands here as a no-op — no second invoice, no second projection.
    const existing = await this.db.prepare("SELECT id FROM events WHERE id = ?").bind(parsed.id).first<{ id: string }>();
    if (existing !== null) return { id: existing.id };

    // D1 is truth: the stream tail (seq, prev_hash) from D1, GENESIS on an empty stream.
    const tailRow = await this.db
      .prepare("SELECT seq, hash FROM events WHERE stream_id = ? ORDER BY seq DESC LIMIT 1")
      .bind(streamId)
      .first<{ seq: number; hash: string }>();
    const tail = tailRow ?? { seq: -1, hash: GENESIS_HASH };

    // requested_visibility is INPUT-ONLY (no column; never hashed). Credit money is platform-internal.
    const { requested_visibility, ...clientFields } = parsed;
    void requested_visibility;
    const event = LedgerEvent.parse({
      ...clientFields,
      stream_id: streamId,
      seq: tail.seq + 1,
      prev_hash: tail.hash,
      // Deterministic — recorded_at is the event's own business ts (the Stripe clock, carried on `ts`); no clock
      // read, so a redelivery would reproduce byte-identical bytes even before the id-dedup catches it. Mirrors
      // the Biller's ts = pod.recorded_at discipline.
      recorded_at: parsed.ts,
      visibility: "internal",
    });
    const hash = await hashEvent(event);
    const full = { ...event, hash } as LedgerEvent;

    const deps = await this.#moneyDeps(full);
    const row = eventToRow(full);
    // ONE batch — the event FIRST (so the money_lines.event_id → events(id) FK is satisfied within the batch),
    // then the projected money_lines + invoices upsert/settle. A projection failure aborts the whole append (I1).
    const stmts: D1PreparedStatement[] = [
      this.db.prepare(EVENT_INSERT_SQL).bind(...EVENT_COLUMNS.map((c) => row[c] ?? null)),
      ...applyMoneyProjection(this.db, full, deps),
    ];
    await this.db.batch(stmts);
    return { id: full.id };
  }

  // Mirror the sequencer's payment.received settlement matching (#matchOpenInvoice): resolve the OPEN invoice the
  // payment names (payload.invoice_id) so the shipped AR projection flips it to 'paid'. Kept off the pure
  // projection. invoice.issued needs no deps (credits are prepaid — no net terms, so terms/due_ts project NULL).
  async #moneyDeps(e: LedgerEvent): Promise<MoneyProjectionDeps> {
    if (e.kind !== "payment.received") return {};
    const invoiceId = typeof e.payload["invoice_id"] === "string" ? e.payload["invoice_id"] : undefined;
    if (invoiceId === undefined) return {};
    const row = await this.db
      .prepare("SELECT id, total_cents FROM invoices WHERE id = ?1 AND status = 'issued'")
      .bind(invoiceId)
      .first<{ id: string; total_cents: number }>();
    return row ? { settleInvoice: row } : {};
  }
}
