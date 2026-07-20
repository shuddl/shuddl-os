import { ZoneTariff, FloorsConfig, FscConfig, AccessorialSchedule } from "@shuddl/contracts";
import { mulDivHalfUp, roundHalfUp } from "./money.js";

// REQ-151 (WP-14 Task 4) — RATING COLD START. A fresh tenant has no cost surface, so "stranger signs up →
// first quote in <10 min" (demo #2) is blocked: loadTenantRatingConfig returns null (no tariff) and /v1/rate
// answers UNKNOWN no_tariff. This module closes that gap for a BROKERAGE tenant — a pure factory that turns a
// MARKET RATE + MARGIN into a schema-valid rate_config bundle that prices IMMEDIATELY — while HOLDING the "no
// price on air" law for an asset-mode tenant: `assetTemplate` fabricates NOTHING (no tariff ⇒ the engine
// returns UNKNOWN, REQ-004), it only names what a real tariff (built in the guided builder or imported by the
// Migrator) must supply.
//
// PURE + DETERMINISTIC: no LLM (REQ-024 — this lives in packages/rater, statically linted), no I/O, no Date/
// random. The money markup uses the SAME BigInt-exact half-up primitive the freight core uses (money.ts), so
// no float ever touches a monetary value. The bundle is INPUT-typed (plain numbers/strings, pre-brand) so it
// (a) JSON-serializes straight into rate_config.payload and (b) parses back through the @shuddl/contracts
// schemas unchanged — the seed-at-provisioning + the guided builder both materialize exactly this shape.

const BPS = 10_000; // basis-point denominator (100% = 10000 bps).

// The single national cold-start zone. A brokerage prices ANY lane from market+margin, so the cold-start zone
// map covers the WHOLE US: every 3-digit ZIP prefix ("000".."999") resolves to one zone (the engine's
// longest-prefix matchZone then serves any 3–5 digit dest_zip). This is what makes a fresh brokerage tenant
// quote a load to ANY destination on day one — no "no_zone" coverage holes that would read as UNKNOWN.
const NATIONAL_ZONE = "NAT";

// The input (pre-brand) payload shapes — coupled to the source-of-truth schemas so a field rename/addition in
// @shuddl/contracts fails at COMPILE time here, not just at the loader's runtime .parse() (the seed/helpers
// precedent). `["_input"]` is what z.input<typeof X> yields.
type ZoneTariffInput = (typeof ZoneTariff)["_input"];
type FloorsInput = (typeof FloorsConfig)["_input"];
type FscInput = (typeof FscConfig)["_input"];
type AccessorialsInput = (typeof AccessorialSchedule)["_input"];

/** The four REQUIRED rate_config payloads that make a tenant rateable (loadTenantRatingConfig needs all four). */
export interface ColdStartBundle {
  zone_tariff: ZoneTariffInput;
  floors: FloorsInput;
  fsc: FscInput;
  accessorials: AccessorialsInput;
}

/** Guided-builder inputs for a brokerage cold-start tariff. Money is integer cents; percentages are basis points. */
export interface BrokerageTemplateParams {
  /** The MARKET linehaul rate per hundredweight, integer cents — the broker's estimate of the carrier's cost. */
  marketRateCentsPerCwt: number;
  /** Gross-margin markup applied to the market rate to get the SELL linehaul, in basis points (0..10000). */
  marginBps: number;
  /** The small-shipment linehaul floor, integer cents (a min charge so a tiny load still covers handling). */
  minChargeCents: number;
  /** Fuel surcharge percent, basis points (0..10000). */
  fscPctBps: number;
  /** Optional accessorial schedule (code → cents). Defaults to none (a cold-start tenant adds these later). */
  accessorials?: Record<string, number>;
  /** Version-pinning id prefix (I5). The caller supplies a UNIQUE prefix per materialization so re-builds never
   *  collide on the rate_config PRIMARY KEY; each kind derives a distinct id `${idPrefix}-<kind>`. */
  idPrefix: string;
  /** The payload version STRING pinned into a quote (I5), default "v1" (distinct from the rate_config row integer). */
  version?: string;
}

function assertNonNegInt(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0) {
    throw new Error(`brokerageTemplate: ${name} must be a non-negative integer (got ${v})`);
  }
}
function assertPosInt(name: string, v: number): void {
  if (!Number.isInteger(v) || v <= 0) {
    throw new Error(`brokerageTemplate: ${name} must be a positive integer (got ${v})`);
  }
}
function assertBps(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v > BPS) {
    throw new Error(`brokerageTemplate: ${name} must be an integer basis point in 0..${BPS} (got ${v})`);
  }
}

// The whole-US ZIP→zone map: "000".."999" → the single national zone. 1000 three-digit prefixes, each matching
// the ZoneTariff zip_to_zone key law (/^\d{3,5}$/); the engine's longest-prefix match then resolves any dest.
function nationalZipToZone(zone: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (let p = 0; p < 1000; p++) {
    map[String(p).padStart(3, "0")] = zone;
  }
  return map;
}

/**
 * brokerageTemplate — a market rate + margin → a VALID, immediately-rateable rate_config bundle (REQ-151).
 *
 * The mapping onto SHUDDL's engine:
 *   · SELL linehaul cwt = market rate marked up by the margin (BigInt-exact half-up). This is the tariff break
 *     rate, so a priceable load (weight present, any US zip) PRICES on day one.
 *   · A single national zone + one weight break + a min charge — a brokerage prices every lane, not a fixed grid.
 *   · Floors derived HONESTLY from the margin as fractions of the sell freight (the engine's cost basis):
 *       contribution = break-even (market cost / sell = 10000/(10000+margin)) — below it the broker LOSES money;
 *       target       = list (100%); full = midway. Monotonic contribution ≤ full ≤ target, each a valid Bps.
 *
 * PURE: no I/O, no Date/random. Fails LOUDLY on nonsense params — a config factory must never emit a tariff
 * that would misprice.
 */
export function brokerageTemplate(params: BrokerageTemplateParams): ColdStartBundle {
  const { marketRateCentsPerCwt, marginBps, minChargeCents, fscPctBps } = params;
  assertPosInt("marketRateCentsPerCwt", marketRateCentsPerCwt);
  assertBps("marginBps", marginBps);
  assertNonNegInt("minChargeCents", minChargeCents);
  assertBps("fscPctBps", fscPctBps);
  if (params.idPrefix.length === 0) {
    throw new Error("brokerageTemplate: idPrefix must be non-empty (rate_config ids are version-pinned, I5)");
  }
  const idPrefix = params.idPrefix;
  const version = params.version ?? "v1";

  // SELL linehaul cwt = market cost × (1 + margin). Half-up in BigInt (money law) — no float touches the value.
  const sellCwtCents = mulDivHalfUp(marketRateCentsPerCwt, BPS + marginBps, BPS);

  // Break-even fraction of the sell freight = market cost / sell = 10000 / (10000 + margin). ≤ 10000 by
  // construction (margin ≥ 0), so it is always a valid Bps floor. Target = list (100%); full = the half-up mean.
  const contributionBps = mulDivHalfUp(BPS, BPS, BPS + marginBps);
  const targetOrBps = BPS;
  const fullCostBps = roundHalfUp(contributionBps + targetOrBps, 2);

  return {
    zone_tariff: {
      kind: "zone_tariff",
      id: `${idPrefix}-zone_tariff`,
      version,
      zip_to_zone: nationalZipToZone(NATIONAL_ZONE),
      rate_groups: [
        {
          id: `${idPrefix}-nat`,
          zones: [NATIONAL_ZONE],
          breaks: [{ min_lb: 0, cwt_cents: sellCwtCents }],
          min_charge_cents: minChargeCents,
        },
      ],
    },
    floors: {
      kind: "floors",
      id: `${idPrefix}-floors`,
      version,
      target_or_bps: targetOrBps,
      full_cost_bps: fullCostBps,
      contribution_bps: contributionBps,
    },
    fsc: { kind: "fsc", id: `${idPrefix}-fsc`, version, pct_bps: fscPctBps },
    accessorials: {
      kind: "accessorials",
      id: `${idPrefix}-accessorials`,
      version,
      items: params.accessorials ?? {},
    },
  };
}

/**
 * assetTemplate — the asset-mode cold-start scaffold. An asset carrier prices from its OWN tariff (zone map +
 * rate groups + floors + FSC), imported by the Migrator or built in the guided builder. SHUDDL never fabricates
 * a rate for it: `seed` is `null` (no rate_config is written), so until all four required kinds exist,
 * /v1/rate returns UNKNOWN no_tariff — the "no price on air" law (REQ-004), which is exactly the REQ-151
 * asset-mode half. This scaffold only NAMES what a real tariff must supply; it is deliberately NOT rateable.
 */
export interface AssetTemplate {
  readonly mode: "asset";
  readonly seed: null; // NO fabricated tariff — none ⇒ the engine returns UNKNOWN (REQ-004/151), never a price on air.
  readonly requiredKinds: readonly ["zone_tariff", "floors", "fsc", "accessorials"];
  readonly guidance: string;
}

export function assetTemplate(): AssetTemplate {
  return {
    mode: "asset",
    seed: null,
    requiredKinds: ["zone_tariff", "floors", "fsc", "accessorials"],
    guidance:
      "Asset-mode carriers price from their OWN tariff (zone map + rate groups + floors + FSC), imported via " +
      "the Migrator or built in the guided builder. SHUDDL never fabricates a rate: until all four required " +
      "rate_config kinds exist, /v1/rate returns UNKNOWN no_tariff (REQ-004 no price on air / REQ-151 cold start).",
  };
}
