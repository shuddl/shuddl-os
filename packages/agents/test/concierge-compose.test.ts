import { describe, expect, it } from "vitest";
import {
  ZoneTariff,
  FloorsConfig,
  FscConfig,
  AccessorialSchedule,
} from "@shuddl/contracts";
import type { TenantRatingConfig } from "@shuddl/rater";
import { composeConcierge, ParseResultSchema } from "../src/index.js";
import type { InboundEmail, ParseResult } from "../src/index.js";

// ============================================================================================
// WP-07 Task 5 — composeConcierge: the PURE PRICE→DRAFT→DECIDE core (REQ-026/093/098). It prices
// the parsed request through the Rater, then AUTO-REPLIES only under two hard gates: floor-clean
// (mirrors the Biller's permanent HOLD — a below-floor OR a REQ-040 anomaly never auto-sends) AND
// independently-CORROBORATED (the "C1" defense: re-parse the RAW email deterministically and
// compare to the model's request; the model's self-reported `confidence` is NEVER an auto-send
// gate) AND resolution-confident (>=9000). Anything short of all gates QUEUES for a human.
// ============================================================================================

// A default tenant rating config. dest "98101" → zone "ZA" (prefix "981"); a single flat break.
// With opts we make a floor-clean quote (default) or an ANOMALY (a huge min charge over a tiny weight).
function mkConfig(opts?: { minChargeCents?: number; cwtCents?: number; targetBps?: number }): TenantRatingConfig {
  return {
    zone_tariff: ZoneTariff.parse({
      kind: "zone_tariff",
      id: "zt-1",
      version: "2026.07",
      zip_to_zone: { "981": "ZA" },
      rate_groups: [
        {
          id: "grp-1",
          zones: ["ZA"],
          breaks: [{ min_lb: 0, cwt_cents: opts?.cwtCents ?? 5_000 }],
          min_charge_cents: opts?.minChargeCents ?? 10_000,
        },
      ],
    }),
    floors: FloorsConfig.parse({
      kind: "floors",
      id: "fl-1",
      version: "2026.07",
      contribution_bps: 6_000,
      full_cost_bps: 8_000,
      target_or_bps: opts?.targetBps ?? 9_000,
    }),
    fsc: FscConfig.parse({ kind: "fsc", id: "fsc-1", version: "2026.07", pct_bps: 0 }),
    accessorials: AccessorialSchedule.parse({ kind: "accessorials", id: "acc-1", version: "2026.07", items: {} }),
  };
}

// A clean inbound the DeterministicParser reads as { 97201 → 98101, 1200 lb, 48x40x60 x2 }.
const EMAIL: InboundEmail = {
  from: "shipper@example.com",
  subject: "Quote request",
  body: "Please quote a shipment from 97201 to 98101, 1200 lbs, 48x40x60, 2 pallets.",
};

// The model's parse of that same email — corroborates the deterministic re-extraction by default. Built
// through ParseResultSchema so `confidence` is a real branded Bps (and the request is contract-valid).
function mkParse(opts?: { confidence?: number; request?: ParseResult["request"] }): ParseResult {
  const draft: Record<string, unknown> = {
    intent: "quote",
    confidence: opts?.confidence ?? 8_000,
    party_hint: { email: "shipper@example.com" },
  };
  if (opts !== undefined && "request" in opts) {
    if (opts.request !== undefined) draft.request = opts.request; // undefined ⇒ omit the request entirely
  } else {
    draft.request = { origin_zip: "97201", dest_zip: "98101", weight_lb: 1_200, dims: { l_in: 48, w_in: 40, h_in: 60, pieces: 2 } };
  }
  return ParseResultSchema.parse(draft);
}

const RESOLVED = { party_id: "party-1", shipment_id: "SHP-1", resolution_confidence: 9_000 };
const FROM_NAME = "Example Freight Desk";

function baseInput(over?: {
  parse?: ParseResult;
  email?: InboundEmail;
  resolved?: { party_id: string; shipment_id: string; resolution_confidence: number };
  ratingConfig?: TenantRatingConfig;
}) {
  return {
    parse: over?.parse ?? mkParse(),
    email: over?.email ?? EMAIL,
    resolved: over?.resolved ?? RESOLVED,
    ratingConfig: over?.ratingConfig ?? mkConfig(),
    tenantFromName: FROM_NAME,
  };
}

describe("composeConcierge — AUTO-REPLY when floor-clean + corroborated + resolved-high", () => {
  it("prices, corroborates, and returns auto_reply whose html shows the Rater's sell", async () => {
    const decision = await composeConcierge(baseInput());
    expect(decision.status).toBe("auto_reply");
    if (decision.status !== "auto_reply") throw new Error("expected auto_reply");

    // The money comes from the RATER, never the model: freight = 1200 lb × 5000¢/cwt = 60,000¢.
    expect(decision.quote.sell_cents).toBe(60_000);
    expect(decision.reply.html).toContain("$600.00"); // the reply shows the Rater's sell_cents
    expect(decision.reply.subject).toContain("SHP-1");
    expect(decision.reply.subject).toContain("$600.00");

    // The quote.priced payload the consumer will append mirrors the quote to the penny (Σ lines === sell).
    const sumLines = decision.quote_priced.lines.reduce((s, l) => s + l.amount_cents, 0);
    expect(sumLines).toBe(decision.quote_priced.sell);
    expect(decision.quote_priced.sell).toBe(60_000);
    // A clean auto-reply carries a null anomaly on its recorded basis.
    expect(decision.quote_priced.basis["anomaly"]).toBeNull();
  });
});

describe("composeConcierge — the permanent floor guard (a below-floor/anomalous quote NEVER auto-sends)", () => {
  // The $222,084 / 35-lb regression (REQ-040, permanent): floor-CLEAN (sell ≥ target) yet physically
  // absurd. Even corroborated + max confidence + max resolution, it must QUEUE, never auto-reply.
  const ANOMALY_EMAIL: InboundEmail = {
    from: "shipper@example.com",
    subject: "Quote",
    body: "Quote from 97201 to 98101, 35 lbs, 12x12x12, 1 pallet.",
  };
  const anomalyParse = mkParse({
    confidence: 10_000,
    request: { origin_zip: "97201", dest_zip: "98101", weight_lb: 35, dims: { l_in: 12, w_in: 12, h_in: 12, pieces: 1 } },
  });

  it("an anomalous PRICED quote (corroborated + high conf) ⇒ queued(below_floor), NOT auto_reply", async () => {
    const decision = await composeConcierge(
      baseInput({
        parse: anomalyParse,
        email: ANOMALY_EMAIL,
        ratingConfig: mkConfig({ minChargeCents: 22_208_400 }), // the absurd min charge dominates the 35-lb piece
        resolved: { party_id: "party-1", shipment_id: "SHP-1", resolution_confidence: 10_000 },
      }),
    );
    expect(decision.status).toBe("queued");
    if (decision.status !== "queued") throw new Error("expected queued");
    expect(decision.reason).toBe("below_floor");
    // the quote + a human-review draft ride the queue decision; the anomaly is recorded on the quote
    expect(decision.quote?.sell_cents).toBe(22_208_400);
    expect(decision.quote?.anomaly).not.toBeNull();
    expect(decision.draft?.html).toContain("$222,084.00"); // a human sees the absurd draft — it is NOT sent
  });
});

describe("composeConcierge — C1 independent corroboration (defeats a prompt-injected request)", () => {
  it("model request DIVERGES from the deterministic re-extraction (weight 1 vs email's 1200) ⇒ queued(not_corroborated)", async () => {
    // An injected model parse claiming weight_lb=1 (a cheap price) while the RAW email says 1200 lb.
    const injected = mkParse({
      confidence: 10_000, // even a maxed-out self-reported confidence cannot force the send
      request: { origin_zip: "97201", dest_zip: "98101", weight_lb: 1, dims: { l_in: 48, w_in: 40, h_in: 60, pieces: 2 } },
    });
    const decision = await composeConcierge(baseInput({ parse: injected }));
    expect(decision.status).toBe("queued");
    if (decision.status !== "queued") throw new Error("expected queued");
    expect(decision.reason).toBe("not_corroborated");
  });

  it("zips that diverge from the raw email ⇒ queued(not_corroborated)", async () => {
    // dest 98199 still prices (prefix "981" → zone ZA), so it clears price + floor gates — but the RAW
    // email says 98101, so the deterministic re-extraction diverges and the send is refused.
    const injected = mkParse({
      request: { origin_zip: "97201", dest_zip: "98199", weight_lb: 1_200, dims: { l_in: 48, w_in: 40, h_in: 60, pieces: 2 } },
    });
    const decision = await composeConcierge(baseInput({ parse: injected }));
    expect(decision.status).toBe("queued");
    if (decision.status !== "queued") throw new Error("expected queued");
    expect(decision.reason).toBe("not_corroborated");
  });

  it("a DROPPED accessorial (email says liftgate; model omits it) ⇒ queued(not_corroborated) — under-quote can't send (REQ-171)", async () => {
    const email: InboundEmail = {
      from: "shipper@example.com",
      subject: "Quote",
      body: "Please quote from 97201 to 98101, 1200 lbs, 48x40x60, 2 pallets, liftgate required.",
    };
    // Model omits the liftgate the email requested → a lower, still-floor-clean sell. The deterministic
    // re-extraction sees liftgate → the accessorial SETS diverge → not corroborated.
    const decision = await composeConcierge(baseInput({ parse: mkParse(), email }));
    expect(decision.status).toBe("queued");
    if (decision.status !== "queued") throw new Error("expected queued");
    expect(decision.reason).toBe("not_corroborated");
  });

  it("weight FAILS CLOSED: model priced on a weight the deterministic parser can't confirm ('1200#') ⇒ queued(not_corroborated) (REQ-171)", async () => {
    const email: InboundEmail = {
      from: "shipper@example.com",
      subject: "Quote",
      body: "Quote from 97201 to 98101, 1200#, 48x40x60, 2 pallets.", // '1200#' — WEIGHT_RE misses it
    };
    // The model extracted weight_lb 1200, but nothing independent confirms it → refuse to auto-send.
    const decision = await composeConcierge(baseInput({ parse: mkParse(), email }));
    expect(decision.status).toBe("queued");
    if (decision.status !== "queued") throw new Error("expected queued");
    expect(decision.reason).toBe("not_corroborated");
  });
});

describe("composeConcierge — no price on air (UNKNOWN ⇒ a human handles it)", () => {
  it("a request missing dims prices UNKNOWN ⇒ queued(unknown_price), no quote", async () => {
    const decision = await composeConcierge(
      baseInput({ parse: mkParse({ request: { origin_zip: "97201", dest_zip: "98101", weight_lb: 1_200 } }) }),
    );
    expect(decision.status).toBe("queued");
    if (decision.status !== "queued") throw new Error("expected queued");
    expect(decision.reason).toBe("unknown_price");
    expect(decision.quote).toBeUndefined();
  });

  it("an absent request ⇒ queued(unknown_price) — compose does not assume resolve gated it", async () => {
    const decision = await composeConcierge(baseInput({ parse: mkParse({ request: undefined }) }));
    expect(decision.status).toBe("queued");
    if (decision.status !== "queued") throw new Error("expected queued");
    expect(decision.reason).toBe("unknown_price");
  });
});

describe("composeConcierge — resolution-confidence gate (belt-and-suspenders over Task-4)", () => {
  it("resolution_confidence 8000 (below the 9000 floor) ⇒ queued(low_resolution)", async () => {
    const decision = await composeConcierge(
      baseInput({ resolved: { party_id: "party-1", shipment_id: "SHP-1", resolution_confidence: 8_000 } }),
    );
    expect(decision.status).toBe("queued");
    if (decision.status !== "queued") throw new Error("expected queued");
    expect(decision.reason).toBe("low_resolution");
  });
});

describe("composeConcierge — the model's `confidence` is NEVER the auto-send gate", () => {
  it("confidence 10000 but a DIVERGING request still QUEUES (not_corroborated)", async () => {
    const decision = await composeConcierge(
      baseInput({
        parse: mkParse({ confidence: 10_000, request: { origin_zip: "97201", dest_zip: "98101", weight_lb: 1, dims: { l_in: 48, w_in: 40, h_in: 60, pieces: 2 } } }),
      }),
    );
    expect(decision.status).toBe("queued");
    if (decision.status !== "queued") throw new Error("expected queued");
    expect(decision.reason).toBe("not_corroborated");
  });

  it("confidence 3000 but corroborated + floor-clean + resolved still AUTO_REPLIES", async () => {
    const decision = await composeConcierge(baseInput({ parse: mkParse({ confidence: 3_000 }) }));
    expect(decision.status).toBe("auto_reply");
  });
});

describe("composeConcierge — determinism (pure: no Date/random/I/O)", () => {
  it("same input → identical decision", async () => {
    const a = await composeConcierge(baseInput());
    const b = await composeConcierge(baseInput());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
