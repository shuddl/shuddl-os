import { describe, expect, it } from "vitest";
import apiRateConfigSrc from "../../api/src/rate-config.ts?raw";
import agentsRateConfigSrc from "../src/rate-config.ts?raw";

// REQ-151 / "No price on air" — the agents worker loads a tenant's effective rating config from a MIRROR of
// workers/api/src/rate-config.ts (the agents worker must not depend on @shuddl/api, so the loader is
// duplicated). If the two drift, one surface (the /rate service or the Concierge auto-quote) mis-prices
// while the other doesn't. This guards the mirror the same way tenants-parity guards tenants.ts: the two
// files must be BYTE-IDENTICAL, so a fix to one loader that isn't propagated to the other fails CI.
describe("REQ-151 — Concierge rating-config loader parity with the API", () => {
  it("workers/agents/src/rate-config.ts is byte-identical to workers/api/src/rate-config.ts", () => {
    expect(agentsRateConfigSrc.length).toBeGreaterThan(0);
    expect(agentsRateConfigSrc).toBe(apiRateConfigSrc);
  });
});
