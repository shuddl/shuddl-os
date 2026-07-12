import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { QuotePricedPayload, type LedgerEvent } from "@shuddl/contracts";
import { rowToEvent } from "@shuddl/ledger/lens";
import {
  ensureSchema,
  ensureTenantBSchema,
  seedRateConfig,
  clearRateConfig,
  token,
  TEST_RATE_CONFIG,
  TENANT_B_RATE_CONFIG,
  ANOMALY_RATE_CONFIG,
} from "./helpers.js";

// WP-04 Task 10 (REQ-030 / REQ-025 / REQ-005 / I5) — POST /v1/rate. Proves the SERVER-SIDE gate: pricing
// via the pure engine against the SESSION tenant's rate_config, emitting quote.priced + agent.acted, and
// enforcing the below-floor approval gate by appending approval.requested. Scopes to its OWN shipment ids
// and never assumes an empty events table (isolatedStorage is off — files share one D1).

const DIMS = { l_in: 48, w_in: 40, h_in: 48, pieces: 2 };

beforeAll(async () => {
  await ensureSchema(env); // tenant-a
  await ensureTenantBSchema(env); // tenant-b (events + rate_config, for the isolation assertion)
  await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
});

type RateResp = {
  status: string;
  reason?: string;
  sell_cents?: number;
  floors?: { contribution: number; full: number; target: number };
  versions?: { rate_config_ids: string[] };
  lines?: unknown[];
  approval?: { approval: string; approvals_required: number };
  anomaly?: unknown;
};

async function rate(
  body: Record<string, unknown>,
  opts: { tenant?: string; role?: string; auth?: boolean; key?: string } = {},
): Promise<Response> {
  const { tenant = "tenant-a", role = "ops", auth = true, key = crypto.randomUUID() } = opts;
  const headers: Record<string, string> = { "content-type": "application/json", "Idempotency-Key": key };
  if (auth) headers.Authorization = `Bearer ${await token({ sub: "u1", tenant, role })}`;
  return SELF.fetch("https://api.local/v1/rate", { method: "POST", headers, body: JSON.stringify(body) });
}

// Empty the HTTP idempotency KV cache so a repeat POST re-executes the handler instead of replaying the
// cached response — the only way to exercise the sequencer's deterministic-id dedup from the HTTP surface.
async function clearIdempotencyCache(): Promise<void> {
  const { keys } = await env.IDEMPOTENCY.list();
  await Promise.all(keys.map((k) => env.IDEMPOTENCY.delete(k.name)));
}

async function eventsFor(db: D1Database, shipmentId: string): Promise<LedgerEvent[]> {
  const res = await db.prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq").bind(`s:${shipmentId}`).all();
  return (res.results as Record<string, string | number | null>[]).map((row) => rowToEvent(row));
}

function pickKind(events: LedgerEvent[], kind: string): LedgerEvent {
  const e = events.find((x) => x.kind === kind);
  if (!e) throw new Error(`expected a ${kind} event, got: [${events.map((x) => x.kind).join(", ")}]`);
  return e;
}

// dest "80012" → prefix "800" → Z5 → rg-far (a priceable lane in TEST_RATE_CONFIG).
const PRICEABLE = { origin_zip: "97201", dest_zip: "80012", weight_lb: 1000, dims: DIMS };

describe("POST /v1/rate", () => {
  it("PRICED emits quote.priced + agent.acted and pins the rate_config versions (I5, REQ-005)", async () => {
    const shipment_id = "rate-priced-1";
    const res = await rate({ shipment_id, ...PRICEABLE });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RateResp;
    expect(body.status).toBe("PRICED");
    expect(body.sell_cents).toBeGreaterThan(0);
    expect(body.versions?.rate_config_ids).toContain("zt-test@v1");

    const events = await eventsFor(env.TENANT_A_DB, shipment_id);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("quote.priced");
    expect(kinds).toContain("agent.acted");

    // the stored quote.priced payload validates against the contract AND pins versions (I5)
    const priced = pickKind(events, "quote.priced");
    const payload = QuotePricedPayload.parse(priced.payload);
    expect(payload.versions.rate_config_ids).toContain("zt-test@v1");
    expect(payload.sell).toBe(body.sell_cents);

    // agent.acted cites ≥1 basis link — the config it priced against (REQ-005)
    const acted = pickKind(events, "agent.acted");
    const basis = (acted.payload as { basis?: unknown }).basis;
    expect(Array.isArray(basis) && basis.length >= 1).toBe(true);
    expect((acted.payload as { agent?: unknown }).agent).toBe("rater");
  });

  it("missing weight → UNKNOWN, no quote.priced appended (no price on air)", async () => {
    const shipment_id = "rate-unknown-1";
    const res = await rate({ shipment_id, origin_zip: "97201", dest_zip: "80012", dims: DIMS }); // no weight_lb
    expect(res.status).toBe(200);
    const body = (await res.json()) as RateResp;
    expect(body.status).toBe("UNKNOWN");
    expect(body.reason).toBe("missing_physics");

    const events = await eventsFor(env.TENANT_A_DB, shipment_id);
    expect(events).toHaveLength(0);
  });

  it("a tenant with no rate_config → UNKNOWN no_tariff, no event (REQ-151 cold start)", async () => {
    await clearRateConfig(env.TENANT_B_DB);
    const shipment_id = "rate-notariff-1";
    const res = await rate({ shipment_id, ...PRICEABLE }, { tenant: "tenant-b" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RateResp;
    expect(body.status).toBe("UNKNOWN");
    expect(body.reason).toBe("no_tariff");

    const events = await eventsFor(env.TENANT_B_DB, shipment_id);
    expect(events).toHaveLength(0);
  });

  it("below-floor appends approval.requested — the SERVER-SIDE gate (REQ-030), single AND dual", async () => {
    // baseline priced quote (no proposed) reveals the floors; its own sell clears target ⇒ no approval.
    const base = (await (await rate({ shipment_id: "rate-floor-base", ...PRICEABLE })).json()) as RateResp;
    const floors = base.floors;
    if (!floors) throw new Error("baseline did not price");
    expect(floors.contribution).toBeLessThan(floors.target);

    // SINGLE: a proposal at contribution is below target but still covers contribution ⇒ one approval (ops).
    const singleShip = "rate-floor-single";
    const single = (await (await rate({ shipment_id: singleShip, ...PRICEABLE, proposed_sell_cents: floors.contribution })).json()) as RateResp;
    expect(single.approval?.approval).toBe("single");
    expect(single.approval?.approvals_required).toBe(1);
    expect((await eventsFor(env.TENANT_A_DB, singleShip)).map((e) => e.kind)).toContain("approval.requested");

    // DUAL: a proposal below contribution loses money ⇒ dual approval (finance), recorded as one event.
    const dualShip = "rate-floor-dual";
    const dual = (await (await rate({ shipment_id: dualShip, ...PRICEABLE, proposed_sell_cents: 1 })).json()) as RateResp;
    expect(dual.approval?.approval).toBe("dual");
    expect(dual.approval?.approvals_required).toBe(2);
    const dualEvents = await eventsFor(env.TENANT_A_DB, dualShip);
    const req = pickKind(dualEvents, "approval.requested");
    expect((req.payload as { approvals_required?: unknown }).approvals_required).toBe(2);
    expect((req.payload as { rule?: unknown }).rule).toBe("below_contribution_loss");
  });

  it("a malformed interline split (Σ split_bps ≠ 10000) is a 400 VALIDATION_FAILED with ZERO events (no partial write)", async () => {
    // The split sum lives at the Zod boundary now — a plausible typo summing to 9000 is rejected BEFORE any
    // DB/DO work, so nothing is appended. (Previously the sum was only checked inside executingShare at
    // assessApproval, AFTER quote.priced + agent.acted had already committed → a 500 with an orphaned priced fact.)
    const shipment_id = "rate-badsplit-1";
    const res = await rate({
      shipment_id,
      ...PRICEABLE,
      tenant_party: "carrier:self",
      legs: [
        { kind: "linehaul", executor: "carrier:self", split_bps: 6000 },
        { kind: "interline", executor: "carrier:other", split_bps: 3000 }, // sums to 9000, not 10000
      ],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("VALIDATION_FAILED");
    // NOTHING was appended — the malformed split was rejected at the boundary.
    expect(await eventsFor(env.TENANT_A_DB, shipment_id)).toHaveLength(0);
  });

  it("a well-formed interline split (Σ = 10000) still prices — the boundary refine does not reject valid interline", async () => {
    const shipment_id = "rate-goodsplit-1";
    const res = await rate({
      shipment_id,
      ...PRICEABLE,
      tenant_party: "carrier:self",
      legs: [
        { kind: "linehaul", executor: "carrier:self", split_bps: 7000 },
        { kind: "interline", executor: "carrier:other", split_bps: 3000 }, // sums to exactly 10000
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RateResp;
    expect(body.status).toBe("PRICED");
    expect((await eventsFor(env.TENANT_A_DB, shipment_id)).map((e) => e.kind)).toContain("quote.priced");
  });

  it("REQ-025: tenant-a prices against tenant-a's config only; its events land in TENANT_A_DB, never TENANT_B_DB", async () => {
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    await seedRateConfig(env.TENANT_B_DB, TENANT_B_RATE_CONFIG);

    const shipment_id = "rate-iso-1";
    const res = await rate({ shipment_id, ...PRICEABLE }, { tenant: "tenant-a" });
    const body = (await res.json()) as RateResp;
    expect(body.status).toBe("PRICED");
    // the pinned versions are tenant-a's — tenant-b's config is never read
    expect(body.versions?.rate_config_ids).toContain("zt-test@v1");
    expect(body.versions?.rate_config_ids).not.toContain("zt-testb@v1");

    // the events physically landed in tenant-a's D1, and NOT in tenant-b's
    expect((await eventsFor(env.TENANT_A_DB, shipment_id)).map((e) => e.kind)).toContain("quote.priced");
    expect(await eventsFor(env.TENANT_B_DB, shipment_id)).toHaveLength(0);
  });

  it("a price that shouldn't exist records on quote.priced.basis, not exception.raised — DIRECT move (REQ-040)", async () => {
    // An absurd tariff: a 1-lb shipment prices at ~$310k ⇒ over the $2,000/lb cap. A DIRECT move with NO
    // tenant_party (ops sessions carry no party lens) — exactly the case the old exception.raised path 500'd
    // on (its passports FK). The anomaly must now record ATOMICALLY on quote.priced.basis: no partial write.
    await seedRateConfig(env.TENANT_B_DB, ANOMALY_RATE_CONFIG);
    const shipment_id = "rate-anomaly-1";
    const res = await rate({ shipment_id, origin_zip: "97201", dest_zip: "80012", weight_lb: 1, dims: DIMS }, { tenant: "tenant-b" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RateResp & { anomaly?: { code?: string } | null };
    expect(body.status).toBe("PRICED");
    expect(body.anomaly?.code).toBe("over_per_lb");

    // quote.priced + agent.acted landed; NO exception.raised was emitted; the anomaly is durable on basis.
    const events = await eventsFor(env.TENANT_B_DB, shipment_id);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("quote.priced");
    expect(kinds).toContain("agent.acted");
    expect(kinds).not.toContain("exception.raised");
    const priced = pickKind(events, "quote.priced");
    const basisAnomaly = (priced.payload as { basis?: { anomaly?: { code?: string } | null } }).basis?.anomaly;
    expect(basisAnomaly?.code).toBe("over_per_lb");
  });

  it("a retried POST with the same Idempotency-Key does not duplicate quote.priced (deterministic ids)", async () => {
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    const shipment_id = "rate-idem-1";
    const key = "rate-idem-key-1";
    const first = await rate({ shipment_id, ...PRICEABLE }, { key });
    expect(first.status).toBe(200);

    // Force the handler to RE-RUN (as a 5xx-then-retry would — the HTTP idempotency cache only stores <500).
    await clearIdempotencyCache();

    const second = await rate({ shipment_id, ...PRICEABLE }, { key });
    expect(second.status).toBe(200);
    expect(second.headers.get("idempotency-replay")).toBeNull(); // the handler actually re-ran (no HTTP replay)

    // the retry's deterministic ids deduped at the sequencer — exactly ONE of each event, no duplicates.
    const events = await eventsFor(env.TENANT_A_DB, shipment_id);
    expect(events.filter((e) => e.kind === "quote.priced")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "agent.acted")).toHaveLength(1);
  });

  it("an oversized shipment_id is a clean 400 (capped before the DO name), not a 500", async () => {
    const res = await rate({ shipment_id: "x".repeat(201), ...PRICEABLE });
    expect(res.status).toBe(400);
  });

  it("a role not in {ops,admin,finance} is 403; no session is 401", async () => {
    const forbidden = await rate({ shipment_id: "rate-auth-1", ...PRICEABLE }, { role: "read" });
    expect(forbidden.status).toBe(403);

    const unauth = await rate({ shipment_id: "rate-auth-2", ...PRICEABLE }, { auth: false });
    expect(unauth.status).toBe(401);
  });
});
