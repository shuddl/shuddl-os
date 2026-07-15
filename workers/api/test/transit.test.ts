import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { loadTenantRatingConfig, loadTransitMatrix } from "../src/rate-config.js";
import {
  ensureSchema,
  seedRateConfig,
  seedTransitMatrix,
  clearTransitMatrix,
  token,
  TEST_RATE_CONFIG,
  TEST_TRANSIT_MATRIX,
} from "./helpers.js";

// WP-08 Task 3 (REQ-059) — the HONEST transit window. Two guarantees under test:
//   1. NON-REQUIRED loading: a tenant WITHOUT a transit_matrix still PRICES (loadTenantRatingConfig returns a
//      config; loadTransitMatrix returns null). The transit window is additive — its absence omits the line,
//      never blocks a quote.
//   2. HONEST WINDOW on /rate: a PRICED quote carries the transit window ONLY when a matrix covers the lane;
//      an absent matrix / unresolvable lane marks it "unavailable" — a fabricated number NEVER reaches a client.

const DIMS = { l_in: 48, w_in: 40, h_in: 48, pieces: 2 };
// origin 97005 → "970" → Z1; dest 80012 → "800" → Z5 (TEST_RATE_CONFIG.zone_tariff). The transit resolver
// zones BOTH endpoints, so the origin must ACTUALLY match a prefix (97201 → "972" would NOT match "970" —
// pricing is dest-only so it wouldn't notice, but the honest transit window would be UNKNOWN). TEST_TRANSIT_MATRIX
// pins Z1→Z5 = 3 business days.
const PRICEABLE = { origin_zip: "97005", dest_zip: "80012", weight_lb: 1000, dims: DIMS };

type RateResp = {
  status: string;
  sell_cents?: number;
  transit?: { status: string; business_days?: number };
};

async function rate(body: Record<string, unknown>): Promise<RateResp> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "Idempotency-Key": crypto.randomUUID(),
    Authorization: `Bearer ${await token({ sub: "u1", tenant: "tenant-a", role: "ops" })}`,
  };
  const res = await SELF.fetch("https://api.local/v1/rate", { method: "POST", headers, body: JSON.stringify(body) });
  return (await res.json()) as RateResp;
}

beforeAll(async () => {
  await ensureSchema(env);
});

describe("REQ-059 — transit_matrix is NON-required (a tenant without one still prices)", () => {
  it("loadTransitMatrix parses a seeded transit_matrix row", async () => {
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    await seedTransitMatrix(env.TENANT_A_DB, TEST_TRANSIT_MATRIX);
    const tm = await loadTransitMatrix(env.TENANT_A_DB, Date.now());
    expect(tm).not.toBeNull();
    expect(tm?.days["Z1"]?.["Z5"]).toBe(3);
    expect(tm?.default_days).toBe(5);
  });

  it("loadTransitMatrix returns null when NO transit_matrix row exists (absent → null)", async () => {
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG); // seeds the 4 REQUIRED only (DELETE all first)
    await clearTransitMatrix(env.TENANT_A_DB);
    expect(await loadTransitMatrix(env.TENANT_A_DB, Date.now())).toBeNull();
  });

  it("loadTenantRatingConfig STILL succeeds without a transit_matrix — the quote can price", async () => {
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    await clearTransitMatrix(env.TENANT_A_DB);
    const cfg = await loadTenantRatingConfig(env.TENANT_A_DB, Date.now());
    expect(cfg).not.toBeNull();
    expect(cfg?.zone_tariff.id).toBe("zt-test");
    // transit_matrix is not part of the required bundle — its absence never nulls the config.
    expect(await loadTransitMatrix(env.TENANT_A_DB, Date.now())).toBeNull();
  });
});

describe("POST /v1/rate — honest transit window (REQ-059)", () => {
  it("a PRICED quote carries the transit window when a matrix covers the lane (Z1→Z5 = 3 business days)", async () => {
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    await seedTransitMatrix(env.TENANT_A_DB, TEST_TRANSIT_MATRIX);
    const body = await rate({ shipment_id: "transit-known-1", ...PRICEABLE });
    expect(body.status).toBe("PRICED");
    expect(body.transit?.status).toBe("known");
    expect(body.transit?.business_days).toBe(3);
  });

  it("NO transit_matrix ⇒ the PRICED quote marks transit unavailable — never a fabricated number", async () => {
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    await clearTransitMatrix(env.TENANT_A_DB);
    const body = await rate({ shipment_id: "transit-nomatrix-1", ...PRICEABLE });
    expect(body.status).toBe("PRICED");
    expect(body.sell_cents).toBeGreaterThan(0); // it STILL priced (non-required)
    expect(body.transit?.status).toBe("unavailable");
    expect(body.transit?.business_days).toBeUndefined(); // no number on air
  });

  it("a matrix that does NOT cover the lane AND has no default ⇒ unavailable (unresolvable lane, no guess)", async () => {
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    // covers only Z5→Z1; the priced lane is Z1→Z5 and there is NO default_days ⇒ UNKNOWN.
    await seedTransitMatrix(env.TENANT_A_DB, {
      kind: "transit_matrix",
      id: "tm-sparse",
      version: "v1",
      days: { Z5: { Z1: 4 } },
    });
    const body = await rate({ shipment_id: "transit-sparse-1", ...PRICEABLE });
    expect(body.status).toBe("PRICED");
    expect(body.transit?.status).toBe("unavailable");
    expect(body.transit?.business_days).toBeUndefined();
  });
});
