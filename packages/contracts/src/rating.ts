import { z } from "zod";
import { SafeInt } from "./json.js";
import { Cents, Bps } from "./money.js";

// Rate-config money is a CHARGE, never a credit: cwt rates, min charges and accessorial fees are all
// non-negative. `Cents` alone permits negatives (it is signed for the ledger's credit/reversal lines),
// so a stray negative cwt_cents would crash the engine and a negative accessorial could silently REDUCE a
// valid price. Narrow to >= 0 here, mirroring money.ts InvoiceLine.amount_cents / SplitComputedPayload.
const NonNegCents = Cents.refine((c) => c >= 0, "rate_config cents must be non-negative (a charge, never a credit)");

// doc 10 §17: rate_config(kind[zone_tariff|floors|fsc|accessorials|transit_matrix|class_adapter],
// version, payload, effective). This module models the PAYLOAD shape per kind — a tenant's rating
// configuration, the SHAPE ONLY, with ZERO hardcoded tenant data. All money is INTEGER cents (Cents);
// all percentages are basis points (Bps, 0..10000). Every object is .strict(); id/version are
// non-empty strings so a config is always version-pinned (I5). transit_matrix (REQ-059, the honest
// transit window) landed with WP-08 booking — see TransitMatrix below.

// zip_to_zone maps a ZIP prefix ("800") to a zone id ("Z4"). rate_groups carry weight breaks where
// cwt_cents is the rate per hundredweight in cents; the engine expects breaks ASCENDING by min_lb, but
// ordering is enforced by a later WP-04 task — here we model the shape only.
export const ZoneTariff = z
  .object({
    kind: z.literal("zone_tariff"),
    id: z.string().min(1),
    version: z.string().min(1),
    zip_to_zone: z.record(z.string().regex(/^\d{3,5}$/), z.string()),
    rate_groups: z
      .array(
        z
          .object({
            id: z.string().min(1),
            zones: z.array(z.string()).min(1),
            breaks: z.array(z.object({ min_lb: SafeInt, cwt_cents: NonNegCents }).strict()).min(1),
            min_charge_cents: NonNegCents,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type ZoneTariff = z.infer<typeof ZoneTariff>;

export const FloorsConfig = z
  .object({
    kind: z.literal("floors"),
    id: z.string().min(1),
    version: z.string().min(1),
    target_or_bps: Bps, // `or` = operating ratio (cost/revenue); the target OR floor, in basis points
    full_cost_bps: Bps,
    contribution_bps: Bps,
  })
  .strict();
export type FloorsConfig = z.infer<typeof FloorsConfig>;

export const FscConfig = z
  .object({
    kind: z.literal("fsc"),
    id: z.string().min(1),
    version: z.string().min(1),
    pct_bps: Bps,
  })
  .strict();
export type FscConfig = z.infer<typeof FscConfig>;

// items maps an accessorial code ("liftgate") to its charge in cents ({ liftgate: 2500 }).
export const AccessorialSchedule = z
  .object({
    kind: z.literal("accessorials"),
    id: z.string().min(1),
    version: z.string().min(1),
    items: z.record(z.string(), NonNegCents),
  })
  .strict();
export type AccessorialSchedule = z.infer<typeof AccessorialSchedule>;

// class_to_density_pcf maps a freight class ("50") to a density in lb/ft^3. Density is genuinely
// fractional, so this is z.number() (not the integer-only Cents/SafeInt). Per REQ-004 this is an
// isolated edge adapter — class is NEVER the engine foundation, only a translation at the boundary.
// .positive().finite() bounds the one unbounded numeric in the module: a 0 / negative / NaN / Infinity
// density would silently corrupt the downstream density→dimensional-weight division.
export const ClassAdapter = z
  .object({
    kind: z.literal("class_adapter"),
    id: z.string().min(1),
    version: z.string().min(1),
    class_to_density_pcf: z.record(z.string(), z.number().positive().finite()),
  })
  .strict();
export type ClassAdapter = z.infer<typeof ClassAdapter>;

// REQ-059 (WP-08) — the transit-standards matrix: zone×zone BUSINESS-DAY transit standards that yield an
// HONEST transit window on a quote. `days[originZone][destZone]` is the whole business-day transit for that
// lane; `default_days` is the fallback for a lane the matrix does not enumerate. Days are SafeInt (integer
// canonical law — no fractional transit day) and NON-NEGATIVE (a transit count, never negative; 0 is a
// legitimate same-zone/same-day standard). There is NO "0 = unknown" sentinel: an UNRESOLVABLE lane (a zip
// that resolves to no zone, or a lane absent with no default) resolves to UNKNOWN in resolveTransitDays and
// the caller OMITS the window — a number is NEVER fabricated (the honest-window law). A zone key is the same
// non-empty string shape as ZoneTariff's zone ids. This is a NON-required rate_config: a tenant without one
// still PRICES (the loader is a separate optional load; its absence omits the window, never blocks a quote).
const TransitZoneKey = z.string().min(1);
const TransitDays = SafeInt.min(0);
export const TransitMatrix = z
  .object({
    kind: z.literal("transit_matrix"),
    id: z.string().min(1),
    version: z.string().min(1),
    days: z.record(TransitZoneKey, z.record(TransitZoneKey, TransitDays)),
    default_days: TransitDays.optional(),
  })
  .strict();
export type TransitMatrix = z.infer<typeof TransitMatrix>;

// The engine consumes a tenant's rate_config as this tagged union, discriminated on `kind`.
export const RateConfig = z.discriminatedUnion("kind", [
  ZoneTariff,
  FloorsConfig,
  FscConfig,
  AccessorialSchedule,
  ClassAdapter,
  TransitMatrix,
]);
export type RateConfig = z.infer<typeof RateConfig>;

// ─── the rate REQUEST (measured physics) ────────────────────────────────────────────────────────────────
// The measured-physics request a quote is priced FROM — the SINGLE canonical rate-request shape. It lives
// here (rating domain: a rate request is a rating concept); comms.ts merely references it for
// QuoteRequestedPayload.request. packages/rater ALIASES its `RateRequest` to this inferred type, so there is
// ONE source of truth: a field drift on either side breaks the rater build (and a contract test proves a
// parsed request prices through priceShipment). The engine READS these fields (priceShipment handles an
// absent weight_lb and spreads accessorials ?? []). Missing weight/dims is LEGAL — the engine returns UNKNOWN
// (no price on air — REQ-004), never a parse error. Integer-only law: integer pounds / integer inches (mirrors
// the workers/api RateBody boundary). `accessorials` stays readonly — a priced request is not mutated after
// construction (matches the engine's readonly consumption and the sweep constructor).
const RateDims = z
  .object({
    l_in: SafeInt.min(0),
    w_in: SafeInt.min(0),
    h_in: SafeInt.min(0),
    pieces: SafeInt.min(1),
  })
  .strict();

// §1513/§1514 (REQ-004/051/189) — THE PHYSICAL CEILING ON WEIGHT, declared ONCE for every surface that prices.
//
// The pricing chain forms `weight × cwt_cents` in BigInt and THROWS rather than return an imprecise JS number
// (`packages/rater/src/money.ts@mulDivHalfUp`). Unbounded, that throw is reachable from outside: measured at
// §1513, `weight_lb: 1e15` on the UNAUTHENTICATED `/pub/quote` returned **HTTP 500**, and `1e12` returned a
// PRICED $558-billion quote. Three surfaces price — the authed `/v1/rate`, the guest `/pub/quote`, and the MCP
// `quote_freight` tool — and §1513 bounded only the first two, because it enumerated ROUTES rather than
// surfaces. The constant lives HERE, in the vocabulary all three already import, so the next surface inherits
// the ceiling instead of re-deciding it (`quote.ts`'s own header records what three-way drift already cost).
//
// PHYSICAL, not arbitrary: a fully-loaded US truck's legal GROSS is 80,000 lb, so this is 12.5× the heaviest
// legal load and nine orders of magnitude below the precision ceiling — it cannot refuse a real shipment and
// cannot reach the throw. Over-cap is a VALUE decision (a 400); ABSENT weight stays UNKNOWN, which is a
// PHYSICS decision (REQ-004, no price on air). The two must never collapse into one another.
export const MAX_WEIGHT_LB = 1_000_000;

export const RateRequestPayload = z
  .object({
    origin_zip: z.string().min(1),
    dest_zip: z.string().min(1),
    weight_lb: SafeInt.min(1).max(MAX_WEIGHT_LB).optional(),
    dims: RateDims.nullish(), // absent OR null ⇒ missing physics (the engine returns UNKNOWN)
    accessorials: z.array(z.string()).readonly().optional(),
  })
  .strict();
export type RateRequestPayload = z.infer<typeof RateRequestPayload>;
