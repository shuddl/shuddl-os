import type { FloorsConfig } from "@shuddl/contracts";
import { mulDivHalfUp } from "./money.js";

// REQ-027 — the THREE floors that ride on every priced quote. PURE and DETERMINISTIC (no LLM/I/O/Date/
// random): given the cost basis and the tenant's parsed FloorsConfig it returns the contribution/full/
// target ladder in INTEGER cents. Each floor is a fraction (basis points) of the cost basis, rounded
// ONCE by the shared BigInt-safe mulDivHalfUp (no float ever touches a monetary value; the product
// cost × bps can exceed 2^53 for very large freight, so it is formed in BigInt). This module computes the
// floors only — the approval matrix that COMPARES a sell against them is Task 6, not here.

const BPS_DIVISOR = 10_000; // floor pct is in basis points; floor = round_half_up(cost × bps / 10000).

// The floor ladder, integer cents, always ordered contribution ≤ full ≤ target. Consumed by a co-signed
// quote.priced event downstream (contracts QuotePricedPayload.floors), so it must never be mutated after
// computeFloors returns it.
export interface Floors {
  readonly contribution: number;
  readonly full: number;
  readonly target: number;
}

/**
 * computeFloors — the contribution/full/target ladder as fractions of the cost basis (REQ-027).
 *
 *  - each floor = round_half_up(costCents × bps / 10000) via mulDivHalfUp (BigInt product, exact half-up).
 *  - the RESULT ladder MUST be monotonic (contribution ≤ full ≤ target). A misconfigured FloorsConfig
 *    (bps out of order) would yield an out-of-order ladder that breaks the approval matrix downstream, so
 *    we FAIL LOUDLY here rather than emit an unusable quote. (When costCents === 0 every floor is 0 and
 *    the ladder is trivially monotonic — a zero cost basis cannot express a misordering.)
 *  - costCents is guarded to be a non-negative integer directly (self-standing, not merely incidental to
 *    mulDivHalfUp) so the guarantee holds even if the bps path changes later.
 */
export function computeFloors(costCents: number, floors: FloorsConfig): Floors {
  if (!Number.isInteger(costCents) || costCents < 0) {
    throw new Error(`computeFloors: costCents must be a non-negative integer (got ${costCents})`);
  }

  const contribution = mulDivHalfUp(costCents, floors.contribution_bps, BPS_DIVISOR);
  const full = mulDivHalfUp(costCents, floors.full_cost_bps, BPS_DIVISOR);
  const target = mulDivHalfUp(costCents, floors.target_or_bps, BPS_DIVISOR);

  // Assert the ladder on the RESULT (not merely the bps): a non-monotonic floor ladder would make the
  // approval matrix ambiguous — never emit it.
  if (contribution > full || full > target) {
    throw new Error(
      `computeFloors: floor ladder must be monotonic contribution ≤ full ≤ target, but got ` +
        `${contribution}/${full}/${target} from bps ${floors.contribution_bps}/${floors.full_cost_bps}/` +
        `${floors.target_or_bps} (config ${floors.id}@${floors.version}) — a misordered ladder would break the approval matrix`,
    );
  }

  return { contribution, full, target };
}
