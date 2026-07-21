// WP-14 Task 8 (REQ-122/125) — THE PER-TENANT SPARK CONVENIENCE METER, a Durable Object (NOT a D1 table — the
// 22-table ceiling is untouched; a DO's storage is its own, invisible to the migration table budget).
//
// Cloned from workers/mcp/src/caps-meter.ts (the CapsMeter DO) and adapted from the acting PAIRING to the
// TENANT, and from spend/velocity to a single AI-action allotment (a count of agent conveniences per month).
//
// WHAT IT METERS: the LLM-powered agent CONVENIENCES ONLY (the Concierge auto-quote — "copilot/auto-quote" in
// genesis/04). A Spark tenant over its monthly AI-credit allotment loses the AGENT doing the work; it NEVER
// loses the physical-truth append path or invoicing. "Credits throttle conveniences, not truth" (genesis/04:15).
// The cap is consulted ONLY at the agent-convenience chokepoint (spark-caps.ts → concierge.ts) — the sequencer
// append + the Biller invoice carry no reference to this DO, so the carve-out is STRUCTURAL.
//
// WHY A DO (not KV): the allotment check is a read-modify-WRITE (read the period tally → check → commit the
// increment). On KV that race is a TOCTOU cap bypass — two concurrent conveniences both read the SAME tally,
// both pass, both write, and the tenant runs one past its cap. A single DO instance PER tenant serializes its
// own state, and we further chain every reserve onto the previous one's settlement (the sequencer's proven
// mutex pattern, MEASURED load-bearing there) so the read and the write are ATOMIC across concurrent RPC calls —
// the DO input gate reopens between two `ctx.storage` awaits, so without the chain two interleaved reserves
// would still read the same tail. One DO per `idFromName(tenantId)` ⇒ structural per-tenant isolation; there is
// no shared counter two tenants could collide on.
//
// The counter is keyed off the SERVER-RESOLVED tenant (the queue trigger's `tenant`, from the allowlist) by the
// caller (spark-caps.ts). It is NEVER keyed off a client field — a hostile inbound cannot dodge its tenant's cap.
//
// NO-CAPS-DEFAULT = ZERO (not infinite): an unconfigured/malformed allotment is treated as ZERO capacity — an
// unprovisioned Spark tenant is at its FLOOR, refusing every convenience, never running unlimited ones. This is
// the fail-closed direction (the same discipline as CapsMeter's parseCaps returning null ⇒ refuse).
//
// RESERVE-AT-CHECK discipline (see caps-meter.ts header): `checkAndReserve` COMMITS the increment the moment the
// check passes. The chokepoint runs the convenience AFTER a successful reserve, so a downstream fault OVER-counts
// (a consumed slot) at worst — which fails CLOSED (it can only refuse a future convenience), never UNDER-counts
// (which would fail OPEN). Idempotency (the actionId dedupe) means a redelivery of the SAME convenience reserves
// the SAME slot, so a redelivered/retried action counts ONCE, not twice.
import { DurableObject } from "cloudflare:workers";

/** A reservation request: the current UTC-month period, this tenant's monthly allotment, and this action's id. */
export interface SparkReserveRequest {
  /** The metering period this convenience falls in (UTC calendar month, "YYYY-MM"; computed by the caller). */
  period: string;
  /** The tenant's monthly AI-action allotment (integer count). Clamped to a non-negative integer, else ZERO. */
  allotment: number;
  /** The DETERMINISTIC per-convenience id (concierge derives it from the inbound event id). A redelivery carries
   *  the SAME id, so the meter dedupes it and counts the action ONCE. Two DISTINCT conveniences carry distinct ids. */
  actionId: string;
}

/** The reservation result. `ok:false` means the allotment is spent; the tally is UNCHANGED on a refusal. */
export interface SparkReserveResult {
  ok: boolean;
  /** The period convenience count AFTER this reservation (or the unchanged current count on a refusal). */
  count: number;
  /** The EFFECTIVE (clamped) allotment applied — surfaced so the caller can explain the refusal. */
  allotment: number;
}

/** The persisted per-period tally. Keyed `tally:<period>` so a new period starts fresh without erasing history. */
interface Tally {
  count: number;
}

/** NO-CAPS-DEFAULT = ZERO: a non-negative integer allotment passes; anything else (undefined/NaN/negative/
 *  fractional) clamps to ZERO — an unconfigured Spark tenant is at its floor, NEVER infinite (fail-closed). */
function normalizeAllotment(raw: number): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

export class SparkMeter extends DurableObject {
  // The mutex — chain every reserve onto the previous one's settlement so the read-check-write is atomic across
  // concurrent RPC calls (the DO input gate reopens between the `get` and the `put`; without this chain two
  // interleaved reserves read the same tally and both pass, a cap bypass). `.catch(() => undefined)` keeps one
  // failed reserve from poisoning the chain — the returned promise still rejects (the caller fails closed).
  private lock: Promise<unknown> = Promise.resolve();

  /**
   * Atomically read the current period tally, check the allotment, and — only if it passes — commit the
   * incremented tally. IDEMPOTENT: a repeat `actionId` in the same period returns the tally as-of its first
   * reserve WITHOUT re-incrementing (a redelivered convenience counts once). Returns `{ok:true}` with the tally,
   * or `{ok:false}` WITHOUT writing. A thrown error (storage fault) propagates to the caller, which refuses the
   * convenience (redelivery is safe — the actionId dedupes).
   */
  checkAndReserve(req: SparkReserveRequest): Promise<SparkReserveResult> {
    const run = this.lock.then(() => this.#checkAndReserve(req));
    this.lock = run.catch(() => undefined);
    return run;
  }

  async #checkAndReserve(req: SparkReserveRequest): Promise<SparkReserveResult> {
    const allotment = normalizeAllotment(req.allotment);
    const tallyKey = `tally:${req.period}`;
    const appliedKey = `applied:${req.period}:${req.actionId}`;

    // IDEMPOTENT REPLAY: if THIS action id already reserved in this period, return that reserve's tally snapshot
    // WITHOUT re-incrementing (a legit redelivery must count ONCE). The marker read is inside the mutex, so it
    // cannot race a concurrent first reserve of the same id.
    const already = await this.ctx.storage.get<Tally>(appliedKey);
    if (already !== undefined) return { ok: true, count: already.count, allotment };

    const cur = (await this.ctx.storage.get<Tally>(tallyKey)) ?? { count: 0 };
    const nextCount = cur.count + 1;
    // Check the allotment BEFORE any write, so a refusal leaves the tally exactly as it was (no reserve on a
    // breach). An allotment of ZERO refuses the FIRST convenience — the fail-closed floor.
    if (nextCount > allotment) return { ok: false, count: cur.count, allotment };
    const nextTally: Tally = { count: nextCount };
    // Commit the advanced tally AND the per-actionId replay marker in ONE storage.put (a single atomic write —
    // no crash window between them). The marker records the tally-as-of-this-reserve so a later replay returns it.
    await this.ctx.storage.put({ [tallyKey]: nextTally, [appliedKey]: nextTally });
    return { ok: true, count: nextCount, allotment };
  }

  /** Read the current period tally without reserving (diagnostics/tests only — never a cap decision path). */
  async peek(period: string): Promise<Tally> {
    return (await this.ctx.storage.get<Tally>(`tally:${period}`)) ?? { count: 0 };
  }
}
