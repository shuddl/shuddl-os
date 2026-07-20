import type { Hono } from "hono";
import { z } from "zod";
import { assetTemplate } from "@shuddl/rater";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { resolveTenantDb } from "../tenants.js";
import { seedColdStartTariff, DEFAULT_BROKERAGE_PARAMS } from "../tariff-seed.js";
import type { Env, Vars } from "../index.js";

// REQ-151 / REQ-025 / REQ-030 (WP-14 Task 4) — THE GUIDED TARIFF BUILDER. A brand-new tenant has no cost
// surface, so demo #2 ("stranger signs up → first quote in <10 min") is blocked. This seam lets an admin/ops
// user MATERIALIZE a cold-start tariff into their OWN rate_config so /v1/rate prices immediately:
//   POST /v1/tariff  { mode: "brokerage", market_rate_cents_per_cwt?, margin_bps?, ... }
//                    → writes the 4 required rate_config kinds (zone_tariff/floors/fsc/accessorials).
//                    { mode: "asset" } → seeds NOTHING; the tenant must import/build a REAL tariff (Migrator).
//
// LAWS THIS ENFORCES:
//   · NO PRICE ON AIR (REQ-004/151): asset mode NEVER fabricates a tariff — it returns the assetTemplate
//     scaffold and writes no rows, so /v1/rate stays UNKNOWN no_tariff until a real tariff exists. Only the
//     brokerage path (market rate + margin) produces a rateable config.
//   · ROLES admin/ops ONLY; tenant from the JWT claim (resolveTenantDb, REQ-025) — never a client field.
//   · IDEMPOTENT: the version-pinned ids derive from the Idempotency-Key, so a retry re-writes the SAME rows
//     (INSERT OR IGNORE — no duplicate); a genuinely new build gets fresh ids + a newer effective_ts that wins.
//   · NO new table/kind/surface — it rides the EXISTING rate_config table via the shared seedColdStartTariff.
//   · UI-DECOUPLED: a plain REST verb; WP-13 MCP calls the same endpoint and inherits the same server-side gates.

const MODES = ["brokerage", "asset"] as const;
const BPS_MAX = 10_000;

// .strict() body. `mode` defaults to brokerage. Every brokerage param is OPTIONAL (a one-tap cold start uses the
// DEFAULT_BROKERAGE_PARAMS); when present it is bounded to the SAME domain the pure template asserts (positive
// integer cents; basis points 0..10000), so a bad value is a clean 400 at the boundary, never a template throw.
const TariffBody = z
  .object({
    mode: z.enum(MODES).optional(),
    market_rate_cents_per_cwt: z.number().int().positive().optional(),
    margin_bps: z.number().int().min(0).max(BPS_MAX).optional(),
    min_charge_cents: z.number().int().min(0).optional(),
    fsc_pct_bps: z.number().int().min(0).max(BPS_MAX).optional(),
    accessorials: z.record(z.string().min(1), z.number().int().min(0)).optional(),
  })
  .strict();

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function mountTariffRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  app.post("/v1/tariff", requireRole("admin", "ops"), async (c) => {
    const session = c.get("session");
    const parsed = TariffBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "INVALID TARIFF BODY");
    const body = parsed.data;
    const mode = body.mode ?? "brokerage";

    // ASSET MODE — the "no price on air" half of REQ-151: fabricate NOTHING. Return the scaffold that names the
    // four required kinds a real tariff must supply; write no rate_config, so /v1/rate stays UNKNOWN no_tariff.
    if (mode === "asset") {
      const scaffold = assetTemplate();
      return c.json({ mode: "asset" as const, seeded: false, required_kinds: scaffold.requiredKinds, guidance: scaffold.guidance }, 200);
    }

    // BROKERAGE MODE — materialize a rateable cold-start tariff (market rate + margin). Params default to the
    // one-tap cold-start defaults; any provided field overrides. exactOptionalPropertyTypes: attach an override
    // only when present (undefined must never become an explicit key).
    const params: Partial<typeof DEFAULT_BROKERAGE_PARAMS> = {
      ...(body.market_rate_cents_per_cwt !== undefined ? { marketRateCentsPerCwt: body.market_rate_cents_per_cwt } : {}),
      ...(body.margin_bps !== undefined ? { marginBps: body.margin_bps } : {}),
      ...(body.min_charge_cents !== undefined ? { minChargeCents: body.min_charge_cents } : {}),
      ...(body.fsc_pct_bps !== undefined ? { fscPctBps: body.fsc_pct_bps } : {}),
      ...(body.accessorials !== undefined ? { accessorials: body.accessorials } : {}),
    };

    const db = await resolveTenantDb(c.env, session.tenant); // REQ-025 — D1 keyed off the JWT claim only

    // The id prefix is DETERMINISTIC from the Idempotency-Key so a retry reproduces the SAME 4 ids (INSERT OR
    // IGNORE → no duplicate rows); a fresh key is a fresh build (new ids, newer effective_ts wins the loader).
    const idemKey = c.req.header("Idempotency-Key") ?? crypto.randomUUID();
    const idPrefix = `tariff-${(await sha256Hex(`${session.tenant}:${idemKey}`)).slice(0, 16)}`;

    const { config_ids } = await seedColdStartTariff(db, {
      idPrefix,
      params,
      approvedBy: `builder:${session.sub}`,
    });

    return c.json({ mode: "brokerage" as const, seeded: true, config_ids }, 201);
  });
}
