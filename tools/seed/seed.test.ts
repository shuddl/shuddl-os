import { describe, expect, it } from "vitest";
import { verifyChain } from "@shuddl/ledger/chain";
import {
  ZoneTariff,
  FloorsConfig,
  FscConfig,
  AccessorialSchedule,
  ClassAdapter,
} from "@shuddl/contracts";
import { generateSeed, seedHash } from "./generate.js";

// REQ-155: deterministic seed tenant SEED-1 — identical dataset hash on every run, now emitting
// the real WP-02 ledger envelope (canonical hash chain per shipment).
describe("SEED-1 determinism", () => {
  it("two runs produce byte-identical datasets", async () => {
    expect(await seedHash(await generateSeed())).toBe(await seedHash(await generateSeed()));
  });
  it("contains a tenant, customers, a tariff stub, and 20 shipments in every lifecycle state", async () => {
    const s = await generateSeed();
    expect(s.tenant.slug).toBe("seed-1");
    expect(s.parties.length).toBeGreaterThanOrEqual(8);
    expect(s.shipments.length).toBe(20);
    const states = new Set(s.shipments.map((x) => x.status));
    for (const required of ["QUOTED", "BOOKED", "DISPATCHED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "INVOICED", "EXCEPTION"]) {
      expect(states).toContain(required);
    }
  });
  it("no wall-clock leakage — timestamps are integer epoch-ms derived from the fixed base", async () => {
    const base = Date.UTC(2026, 6, 9, 6, 0, 0);
    const s = await generateSeed();
    for (const sh of s.shipments) {
      for (const e of sh.events) {
        expect(Number.isInteger(e.ts)).toBe(true);
        expect(e.ts).toBeGreaterThanOrEqual(base);
      }
    }
  });
  it("each shipment's events form a canonical hash chain from GENESIS that verifies green", async () => {
    const s = await generateSeed();
    const first = s.shipments[0];
    if (!first) throw new Error("no shipments");
    expect(first.events[0]?.seq).toBe(0);
    expect(first.events[0]?.prev_hash).toBe("0".repeat(64));
    for (const sh of s.shipments) {
      const r = await verifyChain(sh.events);
      expect(r.ok).toBe(true);
      expect(r.ok && r.count).toBe(sh.events.length);
    }
  });
});

// REQ-155 / REQ-165: SEED-1 carries a deterministic rating_config — one of EACH rate_config kind
// (the Task-1 @shuddl/contracts schemas), a modest but realistic LTL tariff. It's the config the
// WP-04 rating engine (built in later tasks) is tested against, so it must be VALID and reproducible.
describe("SEED-1 rating_config", () => {
  it("exposes one of each rate_config kind", async () => {
    const rc = (await generateSeed()).rating_config;
    expect(rc).toBeDefined();
    expect(rc.zone_tariff.kind).toBe("zone_tariff");
    expect(rc.floors.kind).toBe("floors");
    expect(rc.fsc.kind).toBe("fsc");
    expect(rc.accessorials.kind).toBe("accessorials");
    expect(rc.class_adapter.kind).toBe("class_adapter");
  });

  it("each kind parses cleanly through its Task-1 schema", async () => {
    const rc = (await generateSeed()).rating_config;
    expect(() => ZoneTariff.parse(rc.zone_tariff)).not.toThrow();
    expect(() => FloorsConfig.parse(rc.floors)).not.toThrow();
    expect(() => FscConfig.parse(rc.fsc)).not.toThrow();
    expect(() => AccessorialSchedule.parse(rc.accessorials)).not.toThrow();
    expect(() => ClassAdapter.parse(rc.class_adapter)).not.toThrow();
  });

  it("zone tariff has ~6 distance-ordered zones and a real zip map", async () => {
    const zt = ZoneTariff.parse((await generateSeed()).rating_config.zone_tariff);
    const zones = new Set(Object.values(zt.zip_to_zone));
    expect(zones.size).toBeGreaterThanOrEqual(6);
    expect(Object.keys(zt.zip_to_zone).length).toBeGreaterThanOrEqual(30);
    // every mapped zone is one the rate_groups actually price
    const priced = new Set(zt.rate_groups.flatMap((g) => g.zones));
    for (const z of zones) expect(priced.has(z)).toBe(true);
  });

  it("each rate group's breaks ascend by min_lb with decreasing cwt_cents (heavier = cheaper per cwt)", async () => {
    const zt = ZoneTariff.parse((await generateSeed()).rating_config.zone_tariff);
    for (const g of zt.rate_groups) {
      for (let i = 1; i < g.breaks.length; i++) {
        const prev = g.breaks[i - 1];
        const cur = g.breaks[i];
        if (!prev || !cur) throw new Error("missing break");
        expect(cur.min_lb).toBeGreaterThan(prev.min_lb);
        expect(cur.cwt_cents).toBeLessThan(prev.cwt_cents);
      }
    }
  });

  it("floors satisfy contribution_bps <= full_cost_bps <= target_or_bps", async () => {
    const fl = FloorsConfig.parse((await generateSeed()).rating_config.floors);
    expect(fl.contribution_bps).toBeLessThanOrEqual(fl.full_cost_bps);
    expect(fl.full_cost_bps).toBeLessThanOrEqual(fl.target_or_bps);
  });

  it("is deterministic — two runs deep-equal the rating_config", async () => {
    expect((await generateSeed()).rating_config).toEqual((await generateSeed()).rating_config);
  });
});
