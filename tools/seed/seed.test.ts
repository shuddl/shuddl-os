import { describe, expect, it } from "vitest";
import { verifyChain } from "@shuddl/ledger/chain";
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
