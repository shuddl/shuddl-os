// REQ-019 — interline/cartage splits COMPUTED FROM THE CUSTODY LEGS, never a pre-supplied allocation.
// A shipment's custody legs (the WP-05 custody model: legs.executor_party_id names the carrier that
// executed each segment, legs.split_bps its recorded per-leg revenue weight) are the SERVER-SIDE physical
// record of who moved the freight. deriveSplitFromLegs turns them into the SplitComputedPayload-shaped
// allocation the interline_split projection consumes — grouping by executing carrier and apportioning the
// whole 10000-bps pie across the carriers' summed weights via the Hamilton largest-remainder in split.ts.
//
// THE EXECUTING-SHARE MODEL (defensible, documented): each carrier's share of the movement = the SUM of
// its legs' recorded split_bps, taken as a relative WEIGHT and apportioned to the pie. When the recorded
// splits already partition 100% (Σ split_bps === 10000, the well-formed interline case the Biller's
// resolveInterline enforces for the REQ-040 floor check), the apportionment is exact — a carrier's summed
// split_bps IS its bps. When the legs carry raw relative weights (mileage, equal-per-leg), the largest-
// remainder normalizes them to sum to EXACTLY 10000 with zero remainder loss. Either way the derivation
// is penny-exact end to end: the SAME allocateCents the projection uses turns these bps into the AP cents,
// so the derived split and the posted money_lines can never round apart (REQ-003/040/112).
//
// PURE. No Date, no random, no I/O, no LLM (REQ-024). Integer bps / integer cents only.

import { apportion } from "./split.js";

// One recorded custody leg — the projection of legs.executor_party_id + legs.split_bps (the WP-05 model).
export interface CustodyLeg {
  /** The carrier that executed this segment (legs.executor_party_id). */
  executor_party_id: string;
  /** This segment's recorded revenue weight (legs.split_bps) — a relative weight, not necessarily ×/10000. */
  split_bps: number;
  /** legs.kind — carried for the audit trail; the derivation is by executor + weight, never the label. */
  kind?: string;
}

// The SplitComputedPayload shape (contracts/src/money.ts): total_cents + allocations summing to 10000 bps.
export interface DerivedAllocation {
  party_id: string;
  share_bps: number;
}
export interface DerivedSplit {
  total_cents: number;
  allocations: DerivedAllocation[];
}

/**
 * deriveSplitFromLegs — the recorded custody legs + the gross sell → the interline split allocation.
 *
 * Groups the legs by executing carrier (FIRST-SEEN order, so the allocation is deterministic and stable),
 * sums each carrier's recorded split_bps into its relative weight, and apportions the 10000-bps pie across
 * the carriers via the Hamilton largest-remainder (Σ share_bps === 10000, exactly). THROWS on a malformed
 * leg set — a non-integer/negative split_bps, no legs, or no revenue weight anywhere (all-zero) — never
 * silently derives a split that couldn't be reconciled. The returned payload feeds the EXISTING
 * split.computed → interline_split projection verbatim; allocateCents there makes the cents penny-exact.
 */
export function deriveSplitFromLegs(legs: readonly CustodyLeg[], totalCents: number): DerivedSplit {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new Error(`deriveSplitFromLegs: totalCents must be a non-negative integer number of cents (got ${totalCents})`);
  }
  if (legs.length === 0) {
    throw new Error("deriveSplitFromLegs: at least one custody leg is required — a split cannot be derived from no legs");
  }

  // Group by executor in first-seen order; sum each carrier's recorded split_bps into a relative weight.
  const order: string[] = [];
  const weightByParty = new Map<string, number>();
  for (const leg of legs) {
    if (!Number.isInteger(leg.split_bps) || leg.split_bps < 0) {
      throw new Error(
        `deriveSplitFromLegs: leg split_bps must be a non-negative integer weight (got ${String(leg.split_bps)} for executor ${leg.executor_party_id})`,
      );
    }
    if (!weightByParty.has(leg.executor_party_id)) {
      order.push(leg.executor_party_id);
      weightByParty.set(leg.executor_party_id, 0);
    }
    weightByParty.set(leg.executor_party_id, (weightByParty.get(leg.executor_party_id) ?? 0) + leg.split_bps);
  }

  // Apportion the whole pie across the carriers' weights (largest-remainder). apportion THROWS on an
  // all-zero weight set (no revenue to split) — a leg set with no split anywhere is malformed, not a
  // free-for-all direct move (that classification is the producer's, upstream of here).
  const weights = order.map((p) => weightByParty.get(p) ?? 0);
  const shareBps = apportion(10_000, weights);

  return {
    total_cents: totalCents,
    allocations: order.map((party_id, i) => ({ party_id, share_bps: shareBps[i] ?? 0 })),
  };
}
