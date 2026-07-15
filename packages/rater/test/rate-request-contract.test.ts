import { describe, expect, it } from "vitest";
import {
  ZoneTariff,
  FloorsConfig,
  FscConfig,
  AccessorialSchedule,
  QuoteRequestedPayload,
  RateRequestPayload,
} from "@shuddl/contracts";
import { priceShipment } from "../src/price.js";
import type { RateRequest, TenantRatingConfig } from "../src/price.js";

// WP-07 review fix: RateRequestPayload (contracts) is the SINGLE canonical rate-request shape, and the rater's
// `RateRequest` is an ALIAS of it. This file is the load-bearing proof that the alias holds BOTH ways — so a
// future field drift on EITHER side (a new required field in the payload, a renamed field in the engine) breaks
// THIS build/test, not silently at the Concierge call site.

// Compile-time: bidirectional assignability. If either extends fails, the type collapses to `never` and the
// `const … : Holds = true` assignment stops compiling (true is not assignable to never).
type PayloadToEngine = RateRequestPayload extends RateRequest ? true : never;
type EngineToPayload = RateRequest extends RateRequestPayload ? true : never;
const _payloadToEngine: PayloadToEngine = true;
const _engineToPayload: EngineToPayload = true;

// A tiny SCHEMA-VALID tariff bundle with hand-audited numbers (dest 80112 → prefix "801" → zone ZA).
const config: TenantRatingConfig = {
  zone_tariff: ZoneTariff.parse({
    kind: "zone_tariff",
    id: "zt-c",
    version: "2026.07",
    zip_to_zone: { "801": "ZA" },
    rate_groups: [
      { id: "grp-main", zones: ["ZA"], breaks: [{ min_lb: 0, cwt_cents: 5_000 }, { min_lb: 1_000, cwt_cents: 2_000 }], min_charge_cents: 8_500 },
    ],
  }),
  floors: FloorsConfig.parse({ kind: "floors", id: "fl-c", version: "2026.07", contribution_bps: 8_500, full_cost_bps: 9_200, target_or_bps: 9_800 }),
  fsc: FscConfig.parse({ kind: "fsc", id: "fsc-c", version: "2026.07", pct_bps: 2_500 }),
  accessorials: AccessorialSchedule.parse({ kind: "accessorials", id: "acc-c", version: "2026.07", items: { liftgate: 2_500 } }),
};

describe("WP-07: the Concierge can price a parsed QuoteRequestedPayload.request directly", () => {
  it("the alias holds both ways (compile-time proof)", () => {
    expect(_payloadToEngine).toBe(true);
    expect(_engineToPayload).toBe(true);
  });

  it("priceShipment(QuoteRequestedPayload.parse(...).request, config) type-checks AND prices (REQ-026 loop)", () => {
    // The exact call the Concierge (Task 5) makes: parse the request event's payload, then price its `.request`.
    const quoteRequested = QuoteRequestedPayload.parse({
      request: { origin_zip: "97201", dest_zip: "80112", weight_lb: 1_500, dims: { l_in: 48, w_in: 40, h_in: 48, pieces: 1 }, accessorials: ["liftgate"] },
      source_message_event_id: "evt-message-1",
    });
    // No cast, no re-shape — `quoteRequested.request` IS a RateRequest. If it weren't, this file would not compile.
    const quote = priceShipment(quoteRequested.request, config);
    expect(quote.status).toBe("PRICED");
    if (quote.status !== "PRICED") return;
    expect(quote.sell_cents).toBe(40_000); // 30000 freight + 7500 fsc + 2500 liftgate (hand-audited)
  });

  it("a request missing physics prices UNKNOWN — no price on air, end to end (REQ-004)", () => {
    const req: RateRequest = RateRequestPayload.parse({ origin_zip: "97201", dest_zip: "80112" }); // no weight/dims
    expect(priceShipment(req, config).status).toBe("UNKNOWN");
  });
});
