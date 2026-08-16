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
  ZERO_CHARGE_RATE_CONFIG,
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

// §1533 (REQ-003/051/118) — THE APPENDED PAYLOAD CARRIES NOTHING VERBATIM FROM THE REQUEST BODY.
//
// This is a load-bearing fact that three separate dispositions in this block leaned on WITHOUT it being
// measured or pinned, and two of them stated the OPPOSITE. §1515 justified bounding the zip by "that string
// lands in an append-only quote.priced payload"; §1516 left the `legs` array OPEN as a ledger-SIZE decision
// because "ten thousand legs land in an append-only payload". §1527 measured the zip (it does not) and this
// section measures the rest: a marker zip, a 1e12 dim, a marker leg `executor` and a marker `tenant_party`
// all return 200 and appear in NEITHER appended event. The engine's `basis` is DERIVED — miles, weight —
// never an echo of the request.
//
// It is pinned here because it is the premise under several "this is safe" verdicts, and an unpinned premise
// is what §1527 caught being wrong twice. If a future edit stamps the request onto the payload, the bounds
// those verdicts waived become permanent-storage problems in the same commit.
describe("§1533 — /v1/rate appends nothing verbatim from the request body", () => {
  it("no appended payload contains the request's zip, dims, leg executor or tenant_party", async () => {
    const shipmentId = `shp-verbatim-${crypto.randomUUID().slice(0, 8)}`;
    const ZIP = "97201ZZVERBATIM";
    const CARRIER = "CARRIER-ZZVERBATIM";
    const DIM = 1_000_000_007; // a distinctive integer, well under MAX_WEIGHT-scale bounds
    const res = await rate({
      shipment_id: shipmentId,
      origin_zip: ZIP,
      dest_zip: "80012",
      weight_lb: 1_000,
      dims: { l_in: DIM, w_in: 40, h_in: 48, pieces: 2 },
      legs: [{ kind: "interline", executor: CARRIER, split_bps: 10_000 }],
      tenant_party: CARRIER,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const events = await eventsFor(env.TENANT_A_DB, shipmentId);
    expect(events.length, "nothing was appended — this case would then be vacuous").toBeGreaterThan(0);
    const blob = JSON.stringify(events);
    for (const [what, marker] of [["zip", ZIP], ["leg executor", CARRIER], ["dim", String(DIM)]] as const) {
      expect(
        blob.includes(marker),
        `the appended payload now carries the request's ${what} VERBATIM. That is not automatically wrong — but ` +
          "§1515/§1516/§1527 all turn on it being false, so re-read those before accepting it: a request string " +
          "in an append-only event is permanent, and the bounds those sections waived assumed it was not.",
      ).toBe(false);
    }
  });
});

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

    // REQ-003/031 — the stored quote.priced carries the itemized breakdown the Biller projects from:
    // its lines equal the priced breakdown the client saw AND sum to sell (penny-parity, never re-computed).
    expect(payload.lines.length).toBeGreaterThan(0);
    expect(payload.lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(payload.sell);
    expect(payload.lines).toEqual(body.lines);

    // agent.acted cites ≥1 basis link — the config it priced against (REQ-005)
    const acted = pickKind(events, "agent.acted");
    const basis = (acted.payload as { basis?: unknown }).basis;
    expect(Array.isArray(basis) && basis.length >= 1).toBe(true);
    expect((acted.payload as { agent?: unknown }).agent).toBe("rater");
  });

  it("agent.acted carries a REAL (deterministic=0) cost and a measured latency (REQ-113 metering)", async () => {
    const shipment_id = "rate-meter-1";
    const res = await rate({ shipment_id, ...PRICEABLE });
    expect(res.status).toBe(200);
    const events = await eventsFor(env.TENANT_A_DB, shipment_id);
    const acted = pickKind(events, "agent.acted");
    const p = acted.payload as { cost_cents?: unknown; latency_ms?: unknown };
    // The rater is a DETERMINISTIC engine (no LLM/vendor call) → an HONEST 0 cost, never a fabricated number.
    expect(p.cost_cents).toBe(0);
    // latency_ms is the REAL measured wall-clock of the priced run — an integer, never negative, never invented.
    expect(typeof p.latency_ms).toBe("number");
    expect(Number.isInteger(p.latency_ms)).toBe(true);
    expect(p.latency_ms as number).toBeGreaterThanOrEqual(0);
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

  // §921 — CLAUDE.md LAW 5: INTERLINE FLOORS COMPARE THE EXECUTING SHARE, NEVER GROSS.
  //
  // The route rejects `legs` without `tenant_party`, and NOTHING drove that refusal: neutering the guard
  // left all 816 api tests green. It is the only thing standing between an interline body and a gross
  // comparison, because `approvalOpts()` attaches legs ONLY when BOTH are present — so with the guard gone
  // it returns `{}`, `assessApproval` takes its DIRECT branch, and the floor is judged against
  // `quote.sell_cents`, the whole move's price, instead of this tenant's share of it.
  //
  // The rater has a fail-loud sibling (`assessApproval` throws when legs and tenantParty disagree), but it
  // can never see this case: the partial signal is DROPPED before it gets there. A guard whose siblings are
  // structurally unable to fire is a guard with no backstop at all.
  //
  // This is the law whose $222,084-on-35-lb anomaly regression CLAUDE.md rule 5 makes permanent. A gross
  // comparison does not error — it APPROVES, quietly, at a number nobody would have signed off.
  it("interline legs WITHOUT tenant_party are refused — the executing share is unknowable, so nothing is priced", async () => {
    const shipment_id = "rate-legs-noparty";
    const res = await rate({
      shipment_id,
      ...PRICEABLE,
      // no tenant_party — the executing party is exactly what a floor comparison needs
      legs: [
        { kind: "linehaul", executor: "carrier:self", split_bps: 7000 },
        { kind: "interline", executor: "carrier:other", split_bps: 3000 },
      ],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("VALIDATION_FAILED");
    // Refused at the boundary: no quote.priced, so no gross-compared approval can exist downstream.
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

// ─── §930 — WHAT A HALF-LOADED TARIFF ACTUALLY ANSWERS ──────────────────────────────────────────────────
//
// §928 found that `quote.priced`'s `lines.min(1)` is the SOLE refusal for a zero-sell empty-lines quote
// (the penny-parity refine computes Σ [] = 0 === sell 0 and passes). §929 proved the input is REACHABLE:
// `compose` omits zero lines by design, `min_charge_cents` is NonNegCents (>= 0), so a zero-charge tariff
// composes an EMPTY breakdown. Both left the same question open: what does the CALLER see?
//
// It matters because the two possible answers are not equally good. A clean UNKNOWN is REQ-004's "no price
// on air" working — the server declining to price what it cannot price. A 400 from the append refusal is
// correct but tells an integrator their REQUEST was invalid when the truth is that the TENANT'S TARIFF is
// not loaded. This test records which one it is, so the answer stops being a guess.
describe("§930: a zero-charge tariff — what the route answers, and that NO quote is recorded", () => {
  it("does not record a quote.priced with an empty breakdown", async () => {
    const shipment_id = "rate-zero-tariff";
    await seedRateConfig(env.TENANT_A_DB, ZERO_CHARGE_RATE_CONFIG);
    try {
      const res = await rate({ shipment_id, ...PRICEABLE });
      const body = (await res.json().catch(() => null)) as { code?: string } | null;

      // MEASURED at §930: 400 VALIDATION_FAILED. Pinned so the answer stops being a guess — and so a
      // future change to it is a decision someone makes rather than a drift nobody sees.
      //
      // The ledger is protected (asserted below) but the DIAGNOSIS is wrong-way-round: the caller is told
      // their REQUEST failed validation when the truth is that this TENANT'S TARIFF is not loaded. The
      // rater already speaks the right language for "cannot price" — UNKNOWN with a reason (no_zone,
      // no_rate_group, missing_physics) — and a zero-charge tariff computes a real zero, so it returns
      // PRICED and the append refuses downstream instead.
      //
      // Whether that should become an UNKNOWN is a BEHAVIOUR change, so it is FILED for the owner
      // (GO-LIVE-CHECKLIST, §930) rather than built here — CLAUDE.md rule 1.
      expect(res.status).toBe(400);
      expect(body?.code).toBe("VALIDATION_FAILED");

      // The invariant that must hold either way: nothing meaningless reaches the append-only ledger.
      const evts = await eventsFor(env.TENANT_A_DB, shipment_id);
      expect(evts.filter((e) => e.kind === "quote.priced"), "a quote with no basis must never be recorded").toHaveLength(0);
    } finally {
      await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG); // restore for the rest of the file
    }
  });
});

// §1642 (REQ-051/189/004) — THE AUTHENTICATED HALF OF §1516's FIX, which had no case at all.
//
// §1516's own header records the defect on BOTH surfaces: `accessorials: ["not-a-real-code"]` →
// **HTTP 500 on `/pub/quote` AND on `/v1/rate`**. Both were fixed with the same exported predicate; only the
// anonymous surface was pinned. MEASURED at §1642: deleting `/v1/rate`'s boundary guard outright leaves the
// api worker **882/882 GREEN**, so the exact regression §1516 closed is reintroducible on the surface CSRs
// use, with nothing failing. (Neutering the shared predicate reds two cases — both of them the anonymous
// ones, which is what made the asymmetry visible.)
//
// This is NOT a money defect: `compose` still refuses the unknown code, so nothing mis-prices. It is the
// DIAGNOSIS that regresses — an ops user who mistypes a code is told the server failed, and the code they got
// wrong is not named. That is precisely the trade §1516 decided, and a decision with no test is a preference.
describe("§1642 — an unknown accessorial is a 400 on the AUTHENTICATED surface too, and names the code", () => {
  it("a mistyped code is refused at the boundary, never reported as a server fault", async () => {
    const res = await rate({
      shipment_id: "rate-unknown-acc",
      origin_zip: "97201",
      dest_zip: "80012",
      weight_lb: 1_000,
      dims: DIMS,
      accessorials: ["not-a-real-code"],
    });
    expect(res.status, "a client's typo must never surface as a 500 on the authenticated surface either").toBe(400);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe("VALIDATION_FAILED");
    // The authed surface NAMES the offending codes (the anonymous one deliberately does not — no account,
    // no enumeration oracle). That difference is the reason this case cannot simply mirror the public one.
    expect(JSON.stringify(body), "the operator must be told WHICH code was rejected").toContain("not-a-real-code");
  });

  it("a prototype key is an unknown code, not a Function on the prototype (the Object.hasOwn rule)", async () => {
    for (const code of ["constructor", "toString", "__proto__"]) {
      const res = await rate({
        shipment_id: `rate-proto-acc-${code.replace(/[^a-z]/g, "")}`,
        origin_zip: "97201",
        dest_zip: "80012",
        weight_lb: 1_000,
        dims: DIMS,
        accessorials: [code],
      });
      expect(res.status, `${code} must resolve to an unknown accessorial, never to a prototype member`).toBe(400);
    }
  });
});
