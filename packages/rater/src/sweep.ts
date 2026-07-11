import { priceShipment } from "./price.js";
import type { PricedQuote, RateRequest, TenantRatingConfig } from "./price.js";

// REQ-027 — the in-repo monotonic price sweep: the stand-in for the audited engine's real 504-quote
// monotonic sweep (which runs against tenant-0's tariff in the engagement workspace and lands in Task 11's
// parity harness when vendored). This module builds a deterministic (dest_zip × weight) grid over a config
// WE control and prices every cell; the PROPERTY assertions (weight-monotonic incl. a deficit-weight "trap",
// distance-monotonic, well-formed cells) live in the sibling test. PURE and DETERMINISTIC: no LLM, no I/O,
// no Date/random — the grid is a function of its inputs alone.

// One priced cell of the grid: the (dest_zip, weight) coordinate and the PRICED quote the engine returned.
// quote is the narrowed PricedQuote (never an UNKNOWN — sweepGrid throws on any UNKNOWN cell, see below).
export interface SweepCell {
  dest_zip: string;
  weight_lb: number;
  quote: PricedQuote;
}

/**
 * sweepGrid — price a deterministic (dest_zip × weight) grid over a single tenant config.
 *
 * For EVERY (dest_zip × weight) pair (dest_zips outer, weights inner, both in the caller's given order) it
 * calls priceShipment with the shared origin / dims / accessorials and collects the priced cell.
 *
 * A well-formed sweep prices EVERY cell (all inputs carry valid physics and land on a served lane): an
 * UNKNOWN cell is therefore a SWEEP-CONFIGURATION error, not a legitimate no-quote — so we THROW naming the
 * offending cell rather than skip it. Silently dropping UNKNOWN cells would let a monotonicity hole hide in
 * the gap (a cell that "should" have priced but didn't, between a lighter and a heavier one). After the
 * throw guard every returned cell is guaranteed status:"PRICED".
 *
 * Deterministic: the only inputs are the arguments; no Date, no random, stable iteration order.
 */
export function sweepGrid(
  config: TenantRatingConfig,
  opts: {
    origin_zip: string;
    dest_zips: readonly string[]; // one per zone, in NEAR→FAR order
    weights_lb: readonly number[]; // ascending
    dims: { l_in: number; w_in: number; h_in: number; pieces: number };
    accessorials?: readonly string[];
  },
): SweepCell[] {
  // Normalise accessorials to a concrete array once: RateRequest.accessorials is optional under
  // exactOptionalPropertyTypes, so we pass a real (possibly empty) array, never `undefined`.
  const accessorials: readonly string[] = opts.accessorials ?? [];

  const cells: SweepCell[] = [];
  for (const dest_zip of opts.dest_zips) {
    for (const weight_lb of opts.weights_lb) {
      const request: RateRequest = {
        origin_zip: opts.origin_zip,
        dest_zip,
        weight_lb,
        dims: opts.dims,
        accessorials,
      };
      const quote = priceShipment(request, config);
      if (quote.status !== "PRICED") {
        // An UNKNOWN cell in a sweep we control means the grid or config is wrong (unserved lane / missing
        // physics). Fail LOUD and name the exact cell — never return a grid with a silent hole.
        throw new Error(
          `sweepGrid: cell (dest_zip=${dest_zip}, weight_lb=${weight_lb}) priced UNKNOWN (reason=${quote.reason}) — ` +
            `a well-formed sweep prices every cell; fix the grid/config, do not skip the cell`,
        );
      }
      cells.push({ dest_zip, weight_lb, quote });
    }
  }
  return cells;
}
