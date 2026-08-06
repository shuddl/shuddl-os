import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { ensureSchema, clearRateConfig, token } from "./helpers.js";

// WP-14 Task 4 (REQ-151/025/030) — POST /v1/tariff, the GUIDED TARIFF BUILDER + the cold-start round-trip.
// Proves the demo-#2 arc: a fresh tenant with NO tariff answers UNKNOWN no_tariff (no price on air), then the
// brokerage builder materializes a rateable tariff into rate_config and /v1/rate PRICES immediately. Asset mode
// fabricates nothing (UNKNOWN holds). Scopes to tenant-a and CLEARS its rate_config before each test so the arc
// is exercised from a true cold start regardless of file order (isolatedStorage is off — files share one D1).

const DIMS = { l_in: 48, w_in: 40, h_in: 48, pieces: 2 };
const PRICEABLE = { origin_zip: "97201", dest_zip: "80012", weight_lb: 1000, dims: DIMS };

async function tariff(
  body: Record<string, unknown>,
  opts: { tenant?: string; role?: string; auth?: boolean; key?: string } = {},
): Promise<Response> {
  const { tenant = "tenant-a", role = "admin", auth = true, key = crypto.randomUUID() } = opts;
  const headers: Record<string, string> = { "content-type": "application/json", "Idempotency-Key": key };
  if (auth) headers.Authorization = `Bearer ${await token({ sub: "u1", tenant, role })}`;
  return SELF.fetch("https://api.local/v1/tariff", { method: "POST", headers, body: JSON.stringify(body) });
}

async function rate(shipment_id: string, opts: { tenant?: string } = {}): Promise<Response> {
  const { tenant = "tenant-a" } = opts;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "Idempotency-Key": crypto.randomUUID(),
    Authorization: `Bearer ${await token({ sub: "u1", tenant, role: "ops" })}`,
  };
  return SELF.fetch("https://api.local/v1/rate", {
    method: "POST",
    headers,
    body: JSON.stringify({ shipment_id, ...PRICEABLE }),
  });
}

async function rateConfigCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM rate_config").first<{ n: number }>();
  return row?.n ?? 0;
}

async function clearIdempotencyCache(): Promise<void> {
  const { keys } = await env.IDEMPOTENCY.list();
  await Promise.all(keys.map((k) => env.IDEMPOTENCY.delete(k.name)));
}

beforeAll(async () => {
  await ensureSchema(env);
});

beforeEach(async () => {
  await clearRateConfig(env.TENANT_A_DB); // true cold start before every test
});

afterAll(async () => {
  await clearRateConfig(env.TENANT_A_DB); // leave tenant-a clean for any later file (each file seeds its own)
});

describe("POST /v1/tariff — the guided brokerage builder + cold-start round-trip (REQ-151)", () => {
  it("cold start → build → price: no tariff is UNKNOWN, then the brokerage builder makes /v1/rate PRICE", async () => {
    // 1) COLD START — no tariff yet ⇒ UNKNOWN no_tariff (no price on air, no event).
    const before = (await (await rate("tariff-cold-1")).json()) as { status: string; reason?: string };
    expect(before.status).toBe("UNKNOWN");
    expect(before.reason).toBe("no_tariff");

    // 2) BUILD — the guided brokerage builder materializes a rateable tariff (default market+margin).
    const built = await tariff({ mode: "brokerage" });
    expect(built.status).toBe(201);
    const builtBody = (await built.json()) as { mode: string; seeded: boolean; config_ids: string[] };
    expect(builtBody.mode).toBe("brokerage");
    expect(builtBody.seeded).toBe(true);
    expect(builtBody.config_ids.length).toBe(4); // the four required kinds, version-pinned (I5)
    expect(await rateConfigCount(env.TENANT_A_DB)).toBe(4);

    // 3) PRICE — the SAME tenant now quotes a priceable load immediately (write → read → price).
    const after = (await (await rate("tariff-priced-1")).json()) as { status: string; sell_cents?: number; versions?: { rate_config_ids: string[] } };
    expect(after.status).toBe("PRICED");
    expect(after.sell_cents).toBeGreaterThan(0);
    // the quote pinned the builder's own cold-start zone tariff version (I5)
    expect(after.versions?.rate_config_ids.some((v) => v.includes("zone_tariff"))).toBe(true);
  });

  it("brokerage builder with explicit params prices, and a higher margin lifts the sell", async () => {
    const lo = await tariff({ mode: "brokerage", market_rate_cents_per_cwt: 3000, margin_bps: 1000, min_charge_cents: 10000, fsc_pct_bps: 2000 });
    expect(lo.status).toBe(201);
    const loSell = ((await (await rate("tariff-lo-1")).json()) as { sell_cents: number }).sell_cents;

    await clearRateConfig(env.TENANT_A_DB);
    const hi = await tariff({ mode: "brokerage", market_rate_cents_per_cwt: 3000, margin_bps: 4000, min_charge_cents: 10000, fsc_pct_bps: 2000 });
    expect(hi.status).toBe(201);
    const hiSell = ((await (await rate("tariff-hi-1")).json()) as { sell_cents: number }).sell_cents;

    expect(hiSell).toBeGreaterThan(loSell);
  });

  it("ASSET mode fabricates NOTHING — no rate_config written, /v1/rate stays UNKNOWN no_tariff (REQ-004/151)", async () => {
    const res = await tariff({ mode: "asset" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; seeded: boolean; required_kinds: string[] };
    expect(body.mode).toBe("asset");
    expect(body.seeded).toBe(false);
    expect(body.required_kinds).toEqual(["zone_tariff", "floors", "fsc", "accessorials"]);

    // no price on air: the asset-mode call wrote no tariff, so pricing is still UNKNOWN
    expect(await rateConfigCount(env.TENANT_A_DB)).toBe(0);
    const priced = (await (await rate("tariff-asset-1")).json()) as { status: string; reason?: string };
    expect(priced.status).toBe("UNKNOWN");
    expect(priced.reason).toBe("no_tariff");
  });

  it("is idempotent — a retried build with the same Idempotency-Key does not duplicate rows", async () => {
    const key = "tariff-idem-key-1";
    const first = await tariff({ mode: "brokerage" }, { key });
    expect(first.status).toBe(201);
    const firstIds = ((await first.json()) as { config_ids: string[] }).config_ids;
    expect(await rateConfigCount(env.TENANT_A_DB)).toBe(4);

    // Force the handler to RE-RUN (the HTTP idempotency cache only stores <500; clear it to re-execute).
    await clearIdempotencyCache();

    const second = await tariff({ mode: "brokerage" }, { key });
    expect(second.status).toBe(201);
    const secondIds = ((await second.json()) as { config_ids: string[] }).config_ids;
    expect(secondIds).toEqual(firstIds); // deterministic ids from the key
    expect(await rateConfigCount(env.TENANT_A_DB)).toBe(4); // INSERT OR IGNORE — still exactly 4 rows
  });

  it("role gate: read is 403, no session is 401 (server-side gate parity, REQ-030)", async () => {
    const forbidden = await tariff({ mode: "brokerage" }, { role: "read" });
    expect(forbidden.status).toBe(403);
    const unauth = await tariff({ mode: "brokerage" }, { auth: false });
    expect(unauth.status).toBe(401);
  });

  it("a malformed param is a clean 400 (bounded at the Zod boundary, never a template throw)", async () => {
    const res = await tariff({ mode: "brokerage", margin_bps: 20000 }); // outside Bps 0..10000
    expect(res.status).toBe(400);
  });
});

// THE COLD-START DEFAULTS ARE A MONEY CONSTANT (audit §439). `DEFAULT_BROKERAGE_PARAMS` seeds rate_config
// for EVERY newly provisioned tenant (provision.ts:230), the guided builder's unspecified fields, and the
// Migrator import path. No test named it.
//
// MEASURED before this existed: setting `marginBps: 1800 → 0` left `check:seed` at exit 0 ("SEED-1 hash
// verified") AND signup.test.ts 16/16 green — and signup PROVISIONS a tenant, so the zero-margin seed
// actually ran. Every new tenant would have quoted and booked at COST, silently, until someone noticed the
// money. The asymmetry that hid it: the route bounds CLIENT-supplied overrides with `.positive()`, but the
// DEFAULT is not client input and passes through no schema at all.
//
// Two assertions, deliberately. The frozen values catch an accidental edit; the DOMAIN assertions state WHY
// each is what it is, so they still bite after someone updates the literals — the failure mode a bare golden
// has (§433: the anchor must outlive the edit that moves it).
describe("REQ-151/035: the cold-start brokerage defaults are commercially sane (audit §439)", () => {
  it("the seeded defaults are the frozen, deliberate values", async () => {
    const { DEFAULT_BROKERAGE_PARAMS } = await import("../src/tariff-seed.js");
    expect(DEFAULT_BROKERAGE_PARAMS.marketRateCentsPerCwt).toBe(3500);
    expect(DEFAULT_BROKERAGE_PARAMS.marginBps).toBe(1800);
    expect(DEFAULT_BROKERAGE_PARAMS.minChargeCents).toBe(12_000);
    expect(DEFAULT_BROKERAGE_PARAMS.fscPctBps).toBe(2400);
    expect(DEFAULT_BROKERAGE_PARAMS.accessorials).toEqual({ liftgate: 3500, residential: 2500, detention: 6500, notify: 1200 });
  });

  it("every default is in the domain the tariff route enforces for client overrides", async () => {
    const { DEFAULT_BROKERAGE_PARAMS: d } = await import("../src/tariff-seed.js");
    // A tenant seeded at or below zero margin sells at or under cost from its first quote — the silent money
    // defect. The route already rejects a client sending these; the default must clear the same bar.
    expect(d.marginBps, "a cold-start tenant would sell at COST").toBeGreaterThan(0);
    expect(d.marketRateCentsPerCwt, "no linehaul rate ⇒ nothing to mark up").toBeGreaterThan(0);
    expect(d.minChargeCents, "no small-shipment floor ⇒ a 1-lb move prices at ~0").toBeGreaterThan(0);
    expect(d.fscPctBps, "a negative fuel surcharge REFUNDS fuel").toBeGreaterThanOrEqual(0);
    const acc = Object.entries(d.accessorials as Record<string, number>);
    expect(acc.length, "non-vacuity: the accessorial menu must not be empty").toBeGreaterThan(0);
    for (const [name, cents] of acc) expect(cents, `accessorial ${name} is free`).toBeGreaterThan(0);
  });
});
