// WP-13 Task 8 (REQ-105) — THE PER-ACTOR USAGE COUNTER, a Durable Object (NOT a D1 table — the 22-table
// ceiling is untouched; a DO's storage is its own, invisible to the migration table budget).
//
// WHY A DO (not KV): the spend/velocity caps are a read-modify-WRITE (read the period tally → check → commit the
// increment). On KV that race is a TOCTOU cap bypass — two concurrent book_shipment calls both read the SAME
// tally, both pass, both write, and the pairing books past its cap. A single DO instance PER pairing serializes
// its own state, and we further chain every reserve onto the previous one's settlement (the sequencer's proven
// mutex pattern, MEASURED load-bearing there) so the read and the write are ATOMIC across concurrent RPC calls —
// the DO input gate reopens between two `ctx.storage` awaits, so without the chain two interleaved reserves would
// still read the same tail. One DO per `idFromName(pairingId)` ⇒ structural per-actor isolation; there is no
// shared counter two pairings could collide on.
//
// The counter is keyed off the ACTING pairing id (the OAuth token subject, ctx.pairingId) by the caller (caps.ts).
// It is NEVER keyed off `refs.pairing` (the shipment ORIGINATOR): a hostile pairing B must not dodge its own cap
// by booking pairing A's pre-created quotes. The DO holds no notion of refs — it just meters whoever the caller
// keyed it as, and the caller keys it by the token pairing only.
//
// RESERVE-AT-CHECK discipline (see caps.ts header): `checkAndReserve` COMMITS the increment the moment the check
// passes (before the accept-quote api write). The chokepoint exposes no post-handler hook to release on a later
// api failure, so the deliberate, documented direction is to OVER-count on a post-check failure (a consumed slot),
// never UNDER-count — over-counting fails CLOSED (it can only refuse future bookings), which is the safe side of
// the REQ-105 "a crash must not fail OPEN" rule.
import { DurableObject } from "cloudflare:workers";

/** The reservation request: the current period, this booking's spend, and the acting pairing's configured caps. */
export interface ReserveRequest {
  /** The metering period this booking falls in (UTC calendar month, "YYYY-MM"; computed by the caller). */
  period: string;
  /** This booking's spend in integer cents (the accepted quote.priced `sell`). */
  spendCents: number;
  /** The acting pairing's spend cap for the period, in integer cents. */
  capSpendCents: number;
  /** The acting pairing's velocity cap: max bookings per period. */
  capVelocity: number;
}

/** The reservation result. `ok:false` carries which cap would be breached; the tally is UNCHANGED on a refusal. */
export interface ReserveResult {
  ok: boolean;
  reason?: "spend" | "velocity";
  /** The period spend AFTER this reservation (or the unchanged current spend on a refusal) — for debugging. */
  spendCents: number;
  /** The period booking count AFTER this reservation (or the unchanged current count on a refusal). */
  count: number;
}

/** The persisted per-period tally. Keyed `tally:<period>` so a new period starts fresh without erasing history. */
interface Tally {
  spend: number;
  count: number;
}

export class CapsMeter extends DurableObject {
  // The mutex — chain every reserve onto the previous one's settlement so the read-check-write is atomic across
  // concurrent RPC calls (the DO input gate reopens between the `get` and the `put`; without this chain two
  // interleaved reserves read the same tally and both pass, a cap bypass). `.catch(() => undefined)` keeps one
  // failed reserve from poisoning the chain — the returned promise still rejects (the caller fails closed).
  private lock: Promise<unknown> = Promise.resolve();

  /**
   * Atomically read the current period tally, check BOTH caps, and — only if BOTH pass — commit the incremented
   * tally. Returns `{ok:true}` with the post-increment tally, or `{ok:false, reason}` WITHOUT writing. A thrown
   * error (storage fault) propagates to the caller, which fails the booking closed.
   */
  checkAndReserve(req: ReserveRequest): Promise<ReserveResult> {
    const run = this.lock.then(() => this.#checkAndReserve(req));
    this.lock = run.catch(() => undefined);
    return run;
  }

  async #checkAndReserve(req: ReserveRequest): Promise<ReserveResult> {
    const key = `tally:${req.period}`;
    const cur = (await this.ctx.storage.get<Tally>(key)) ?? { spend: 0, count: 0 };
    const nextSpend = cur.spend + req.spendCents;
    const nextCount = cur.count + 1;
    // Check BOTH caps BEFORE any write, so a refusal leaves the tally exactly as it was (no reserve on a breach).
    if (nextSpend > req.capSpendCents) return { ok: false, reason: "spend", spendCents: cur.spend, count: cur.count };
    if (nextCount > req.capVelocity) return { ok: false, reason: "velocity", spendCents: cur.spend, count: cur.count };
    await this.ctx.storage.put(key, { spend: nextSpend, count: nextCount });
    return { ok: true, spendCents: nextSpend, count: nextCount };
  }

  /** Read the current period tally without reserving (diagnostics/tests only — never a cap decision path). */
  async peek(period: string): Promise<Tally> {
    return (await this.ctx.storage.get<Tally>(`tally:${period}`)) ?? { spend: 0, count: 0 };
  }
}
