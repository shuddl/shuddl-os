import { describe, expect, it } from "vitest";
import { generateSeed, seedHash } from "./generate.js";

// REQ-155: deterministic seed tenant SEED-1 — identical dataset hash on every run.
describe("SEED-1 determinism", () => {
  it("two runs produce byte-identical datasets", () => {
    expect(seedHash(generateSeed())).toBe(seedHash(generateSeed()));
  });
  it("contains a tenant, customers, a tariff stub, and 20 shipments in every lifecycle state", () => {
    const s = generateSeed();
    expect(s.tenant.slug).toBe("seed-1");
    expect(s.parties.length).toBeGreaterThanOrEqual(8);
    expect(s.shipments.length).toBe(20);
    const states = new Set(s.shipments.map((x) => x.status_cache));
    for (const required of ["QUOTED", "BOOKED", "DISPATCHED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "INVOICED", "EXCEPTION"]) {
      expect(states).toContain(required);
    }
  });
  it("no wall-clock leakage — timestamps are all derived from the fixed base", () => {
    const s = generateSeed();
    for (const sh of s.shipments) for (const e of sh.events) expect(e.ts.startsWith("2026-07")).toBe(true);
  });
  it("event chains carry seq + prev_hash from GENESIS", () => {
    const s = generateSeed();
    const first = s.shipments[0];
    if (!first) throw new Error("no shipments");
    expect(first.events[0]?.seq).toBe(0);
    expect(first.events[0]?.prev_hash).toBe("GENESIS");
    expect(first.events[1]?.prev_hash).not.toBe("GENESIS");
  });
});
