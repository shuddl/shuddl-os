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
// non-empty strings so a config is always version-pinned (I5). transit_matrix is deliberately NOT here —
// it belongs to WP-08 booking (do not add it in WP-04).

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

// The engine consumes a tenant's rate_config as this tagged union, discriminated on `kind`.
export const RateConfig = z.discriminatedUnion("kind", [
  ZoneTariff,
  FloorsConfig,
  FscConfig,
  AccessorialSchedule,
  ClassAdapter,
]);
export type RateConfig = z.infer<typeof RateConfig>;
