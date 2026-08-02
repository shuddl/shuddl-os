import { env } from "cloudflare:test";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { TENANT_SLUG as TENANT, ensureSchema, post, seedShipment, streamCount as countEvents, token } from "./helpers.js";

// 2026-08-02 audit §15 (REQ-030/025/045/180) — THE MALFORMED TENANT POLICY.
//
// `tenants.policy` is D1 `TEXT NOT NULL DEFAULT '{}'` — NOT NULL, but NOT constrained to valid JSON. One
// truncated ops paste makes it unparseable, and the sequencer DO's #policy read is awaited by #append
// BEFORE any gate runs, so whatever #policy does with a bad row decides what every later append does.
//
// THIS FILE EXISTS BECAUSE THE FIRST TWO ANSWERS WERE BOTH WRONG, AND NOTHING CAUGHT EITHER.
//
//   1. Originally the parse was unguarded: a SyntaxError escaped #policy and every append 500'd forever.
//      Fail-closed, but opaque, and the translator's inbound-204 chain retry-storms against it.
//   2. §13 "fixed" that by falling back to `{}` and letting appends proceed, calling `{}` a gate-knob floor.
//      It is not. `{}` is the floor for ONE knob and the CEILING for three — `gates.dims_required` is read
//      `=== true` (so `{}` DROPS the REQ-045 precondition), `gates.geofence_radius_m` falls to a WIDER 150m
//      default, and `resolveVisibility` falls to `KIND_VISIBILITY_DEFAULTS`, dropping every narrowing
//      override a tenant configured. Visibility is stamped ON the event at append time and events are
//      immutable (I3/I7) — so a tenant who set `freight.photographed: internal` and then suffered one
//      corrupt byte would have those events stamped `counterparty` and exposed through the portal lens
//      PERMANENTLY. Repairing the control row afterwards cannot un-stamp a committed event.
//
// The api suite was 725/725 green under BOTH wrong answers. That is what these tests close: the refusal is
// pinned, and so is its DIRECTION — refuse, never proceed-on-defaults.

const SHP = "t-policy-guard";

const setPolicy = (p: string): Promise<unknown> =>
  env.CONTROL_DB.prepare("UPDATE tenants SET policy = ? WHERE slug = ?").bind(p, TENANT).run();

const opsTok = (): Promise<string> => token({ sub: "u-ops", tenant: TENANT, role: "ops" });

// freight.photographed is NOT device-gated (ops may append it directly) and it is visibility-BEARING —
// the exact knob a `{}` fallback widens. Each case uses a fresh shipment id → a fresh DO → a fresh
// #policy read, so a case always sees the policy it just set.
function photographedInput(shipmentId: string, hash: string): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: 1_720_000_000_000,
    actor: { party: "party-shipper" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "freight.photographed",
    payload: { photo_hash: hash, photo_kind: "placed" },
  };
}

const HASH = "a".repeat(64);

beforeAll(async () => {
  await ensureSchema(env);
  await seedShipment(SHP);
});

afterAll(async () => {
  // 65 files share this control plane (isolatedStorage: false) — restore the shared {} policy.
  await setPolicy("{}");
});

describe("a MALFORMED tenants.policy REFUSES the append — it never proceeds on defaults (§15)", () => {
  it("unparseable JSON → refused with a NAMED cause, and NOTHING is written", async () => {
    await setPolicy("{not json");
    const shp = `${SHP}-1`;
    await seedShipment(shp);
    const before = await countEvents(shp);
    const r = await post(shp, photographedInput(shp, HASH), await opsTok());

    // The client gets the CODE only — the specific cause ("tenant policy malformed") stays server-side in
    // the log, deliberately: a control-plane misconfiguration is not a fact to hand a caller.
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((r.json as { code?: string } | undefined)?.code).toBe("VALIDATION_FAILED");

    // THE LOAD-BEARING ASSERTION. Under the §13 `{}` fallback this append COMMITTED — with the dims gate
    // dropped and default (wider) visibility stamped irreversibly onto an append-only event.
    expect(await countEvents(shp)).toBe(before);
  });

  it("a non-object policy (null, an array, a number, a string) is refused identically", async () => {
    for (const [i, bad] of ["null", "[1,2]", "7", '"a string"'].entries()) {
      await setPolicy(bad);
      const shp = `${SHP}-no-${i}`;
      await seedShipment(shp);
      const before = await countEvents(shp);
      const r = await post(shp, photographedInput(shp, HASH), await opsTok());
      expect(r.status, `policy ${bad} must be refused`).toBeGreaterThanOrEqual(400);
      expect(await countEvents(shp), `policy ${bad} must append nothing`).toBe(before);
    }
  });

  it("a WELL-FORMED policy still appends — the guard refuses bad rows, not all rows", async () => {
    await setPolicy('{"gates":{"dims_required":false}}');
    const shp = `${SHP}-ok`;
    await seedShipment(shp);
    const before = await countEvents(shp);
    const r = await post(shp, photographedInput(shp, HASH), await opsTok());
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(await countEvents(shp)).toBe(before + 1);
  });

  it("the policy is REALLY consumed on this path: a narrowing override reaches the stamped event", async () => {
    // Without this, the three tests above could pass against a #policy that is never read for this kind —
    // and the whole point is that a MALFORMED policy must not silently become a WIDER one.
    await setPolicy('{"visibility":{"freight.photographed":"internal"}}');
    const shp = `${SHP}-narrow`;
    await seedShipment(shp);
    const r = await post(shp, photographedInput(shp, HASH), await opsTok());
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const row = await env.TENANT_A_DB.prepare(
      "SELECT visibility FROM events WHERE stream_id = ? ORDER BY seq DESC LIMIT 1",
    )
      .bind(`s:${shp}`)
      .first<{ visibility: string }>();
    expect(row?.visibility).toBe("internal");
  });
});
