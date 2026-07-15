import type { TransitMatrix, ZoneTariff } from "@shuddl/contracts";
import { matchZone } from "./engine.js";

// REQ-059 — the HONEST transit window resolver. PURE and DETERMINISTIC (no LLM/I/O/Date/random): given an
// origin zip, a dest zip, a parsed TransitMatrix and the SAME ZoneTariff pricing uses, it resolves BOTH zips
// to zones via the freight engine's OWN longest-prefix matchZone (so a transit lane keys off exactly the
// zones a price does), then looks up days[originZone][destZone], falling back to matrix.default_days.
//
// THE HONEST-WINDOW LAW: an UNRESOLVABLE lane — a zip that resolves to no zone, OR a lane the matrix does not
// enumerate with no default — returns UNKNOWN. The caller MUST render UNKNOWN as "transit window unavailable"
// or OMIT the line; it must NEVER coerce UNKNOWN to a number. A number is only ever returned for a lane the
// tenant actually configured (an explicit lane or an explicit default). No fabricated transit standard reaches
// a customer.

/** A resolved transit standard in whole BUSINESS DAYS, or UNKNOWN (the caller omits the window — never fakes it). */
export type TransitResult =
  | { readonly status: "KNOWN"; readonly days: number }
  | { readonly status: "UNKNOWN" };

export function resolveTransitDays(
  originZip: string,
  destZip: string,
  matrix: TransitMatrix,
  zoneTariff: ZoneTariff,
): TransitResult {
  const origin = matchZone(originZip, zoneTariff.zip_to_zone);
  const dest = matchZone(destZip, zoneTariff.zip_to_zone);
  // Either endpoint failing to resolve to a served zone ⇒ no honest lane ⇒ UNKNOWN (never a guess).
  if (origin === undefined || dest === undefined) return { status: "UNKNOWN" };

  const lane = matrix.days[origin.zone]?.[dest.zone];
  if (lane !== undefined) return { status: "KNOWN", days: lane };

  // The lane is not enumerated. A configured default is a legitimate transit standard; its absence is UNKNOWN.
  if (matrix.default_days !== undefined) return { status: "KNOWN", days: matrix.default_days };
  return { status: "UNKNOWN" };
}
