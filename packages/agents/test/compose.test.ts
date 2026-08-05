import { describe, expect, it } from "vitest";
import {
  QuotePricedPayload,
  InvoiceIssuedPayload,
  ZoneTariff,
  FloorsConfig,
  FscConfig,
  AccessorialSchedule,
} from "@shuddl/contracts";
import type { JsonObject } from "@shuddl/contracts";
import { priceShipment } from "@shuddl/rater";
import type { Leg, RateRequest, TenantRatingConfig } from "@shuddl/rater";
import { composeInvoice, glMap } from "../src/index.js";
import type { ComposeInput } from "../src/index.js";
import fixtureRaw from "../../../fixtures/anomaly/the-222084-case.json?raw";

// ============================================================================================
// WP-06 Task 2 — the Biller's PURE composition core (REQ-031/040/056). composeInvoice turns
// (POD + the RECORDED accepted quote + bill terms) into an invoice.issued PAYLOAD that mirrors
// the quote's itemized lines TO THE PENNY, or a HOLD when the recorded quote carries a
// pricing-time anomaly flag (REQ-040, permanent — the $222,084/35-lb case NEVER auto-invoices)
// or an interline EXECUTING SHARE sits below floor without an approval of MATCHING strength
// (REQ-048: "single" releases a single-approval hold; only "dual" releases a dual/loss hold).
// ============================================================================================

// The vendored PERMANENT fixture, replayed verbatim (bytes hash-pinned by fixtures/manifest.json).
interface AnomalyFixture {
  case: string;
  weight_lb: number;
  sell_cents: number;
  expect: { flags: boolean; code: string };
}
const fixture = JSON.parse(fixtureRaw) as AnomalyFixture;

const POD = { event_id: "evt-pod-1", shipment_id: "shp-1" };

// A normal, sane 3-line quote (freight + fsc + accessorial): Σ 90,000 + 12,000 + 18,000 = 120,000.
function mkQuote(opts?: {
  basis?: JsonObject;
  floors?: { contribution: number; full: number; target: number };
}): QuotePricedPayload {
  return QuotePricedPayload.parse({
    sell: 120_000,
    lines: [
      { kind: "freight", code: "freight", amount_cents: 90_000 },
      { kind: "fsc", code: "fsc", amount_cents: 12_000 },
      { kind: "accessorial", code: "liftgate", amount_cents: 18_000 },
    ],
    floors: opts?.floors ?? { contribution: 60_000, full: 90_000, target: 100_000 },
    versions: { rate_config_ids: ["rc-tariff-v3"] },
    basis: opts?.basis ?? {},
  });
}

function baseInput(quote: QuotePricedPayload): ComposeInput {
  return {
    pod: POD,
    acceptedQuote: quote,
    bill: { party_id: "party-bill-to", terms: "prepaid" },
    invoiceId: "inv-shp-1-1",
  };
}

describe("composeInvoice — penny-parity issue (REQ-031: the invoice PROJECTS the recorded quote)", () => {
  it("a normal 3-line quote issues lines that mirror the quote to the penny", () => {
    const quote = mkQuote();
    const result = composeInvoice(baseInput(quote));
    expect(result.status).toBe("issue");
    if (result.status !== "issue") throw new Error("expected issue");

    const { payload } = result;
    expect(payload.invoice_id).toBe("inv-shp-1-1");
    expect(payload.party_id).toBe("party-bill-to");
    expect(payload.division).toBe("main"); // default when bill.division absent
    expect(payload.lines).toHaveLength(3);
    expect(payload.lines.map((l) => l.line_no)).toEqual([1, 2, 3]);
    expect(payload.lines.map((l) => l.kind)).toEqual(["freight", "fsc", "accessorial"]);
    expect(payload.lines.map((l) => l.amount_cents)).toEqual([90_000, 12_000, 18_000]);
    expect(payload.lines.map((l) => l.gl_map)).toEqual([
      "4000-FREIGHT-AR",
      "4100-FSC-AR",
      "4200-ACCESSORIAL-AR",
    ]);

    // Penny-parity: Σ invoice lines === the recorded quote's sell. INTEGER cents.
    const total = payload.lines.reduce((s, l) => s + l.amount_cents, 0);
    expect(total).toBe(120_000);
    expect(total).toBe(quote.sell);

    // The payload is contract-valid (the same schema the invoice.issued event carries).
    expect(() => InvoiceIssuedPayload.parse(payload)).not.toThrow();
  });

  it("a supplied bill.division rides through", () => {
    const result = composeInvoice({
      ...baseInput(mkQuote()),
      bill: { party_id: "party-bill-to", terms: "prepaid", division: "brokerage" },
    });
    if (result.status !== "issue") throw new Error("expected issue");
    expect(result.payload.division).toBe("brokerage");
  });
});

describe("composeInvoice — bill terms pick the invoice target (REQ-056)", () => {
  const targetCases = [
    { terms: "prepaid", expected: "party-bill-to" },
    { terms: "collect", expected: "party-bill-to" },
  ] as const;

  it.each(targetCases)("$terms → party_id = bill.party_id", ({ terms, expected }) => {
    const result = composeInvoice({
      ...baseInput(mkQuote()),
      bill: { party_id: "party-bill-to", terms },
    });
    if (result.status !== "issue") throw new Error("expected issue");
    expect(result.payload.party_id).toBe(expected);
  });

  it("third_party → party_id = bill.third_party_id", () => {
    const result = composeInvoice({
      ...baseInput(mkQuote()),
      bill: { party_id: "party-bill-to", terms: "third_party", third_party_id: "party-3pl" },
    });
    if (result.status !== "issue") throw new Error("expected issue");
    expect(result.payload.party_id).toBe("party-3pl");
  });

  it("third_party with NO third_party_id THROWS — never silently bill the wrong party", () => {
    expect(() =>
      composeInvoice({
        ...baseInput(mkQuote()),
        bill: { party_id: "party-bill-to", terms: "third_party" },
      }),
    ).toThrow(/third_party_id/);
  });

  it("a BLANK party_id under prepaid/collect THROWS the same actionable REQ-056 error (symmetric guard)", () => {
    expect(() =>
      composeInvoice({ ...baseInput(mkQuote()), bill: { party_id: "", terms: "prepaid" } }),
    ).toThrow(/party_id is blank/);
    expect(() =>
      composeInvoice({ ...baseInput(mkQuote()), bill: { party_id: "", terms: "collect" } }),
    ).toThrow(/party_id is blank/);
  });
});

describe("composeInvoice — the POD names the shipment (holds are actionable)", () => {
  it("empty pod refs THROW — a hold must be able to name the shipment and POD it blocks", () => {
    expect(() =>
      composeInvoice({ ...baseInput(mkQuote()), pod: { event_id: "", shipment_id: "shp-1" } }),
    ).toThrow(/pod\.event_id/);
    expect(() =>
      composeInvoice({ ...baseInput(mkQuote()), pod: { event_id: "evt-pod-1", shipment_id: "" } }),
    ).toThrow(/pod\.shipment_id/);
  });
});

describe("composeInvoice — anomaly HOLD (REQ-040 PERMANENT: the $222,084/35-lb case never auto-invoices)", () => {
  it("the $222,084 fixture priced through the REAL engine ⇒ hold(anomaly), NO payload", () => {
    // Price the vendored case through priceShipment so the recorded quote.priced payload is exactly
    // what the /rate service would append: a min-charge tariff that reproduces the absurd sell.
    const config: TenantRatingConfig = {
      zone_tariff: ZoneTariff.parse({
        kind: "zone_tariff",
        id: "zt-222084",
        version: "2026.07",
        zip_to_zone: { "801": "ZA" },
        rate_groups: [
          {
            id: "grp-222084",
            zones: ["ZA"],
            breaks: [{ min_lb: 0, cwt_cents: 5_000 }],
            min_charge_cents: fixture.sell_cents, // the $222,084 min charge dominates the 35-lb piece
          },
        ],
      }),
      floors: FloorsConfig.parse({
        kind: "floors",
        id: "fl-222084",
        version: "2026.07",
        contribution_bps: 8_500,
        full_cost_bps: 9_200,
        target_or_bps: 9_800,
      }),
      fsc: FscConfig.parse({ kind: "fsc", id: "fsc-222084", version: "2026.07", pct_bps: 0 }),
      accessorials: AccessorialSchedule.parse({
        kind: "accessorials",
        id: "acc-222084",
        version: "2026.07",
        items: {},
      }),
    };
    const req: RateRequest = {
      origin_zip: "97201",
      dest_zip: "80112",
      weight_lb: fixture.weight_lb,
      dims: { l_in: 12, w_in: 12, h_in: 12, pieces: 1 },
    };
    const priced = priceShipment(req, config);
    if (priced.status !== "PRICED") throw new Error("expected PRICED");
    expect(priced.sell_cents).toBe(fixture.sell_cents); // 22,208,400¢ — the vendored case exactly
    expect(priced.anomaly?.code).toBe(fixture.expect.code); // over_per_lb, flagged AT pricing

    // The recorded quote.priced payload carries the pricing-time flag at basis.anomaly.
    const quote = QuotePricedPayload.parse({
      sell: priced.sell_cents,
      lines: priced.lines.map((l) => ({ kind: l.kind, code: l.code, amount_cents: l.amount_cents })),
      floors: priced.floors,
      versions: { rate_config_ids: [...priced.versions.rate_config_ids] },
      basis: { ...priced.basis, anomaly: priced.anomaly },
    });

    const result = composeInvoice(baseInput(quote));
    expect(result.status).toBe("hold");
    if (result.status !== "hold") throw new Error("expected hold");
    expect(result.reason).toBe("anomaly");
    expect(result.detail).toContain("over_per_lb");
    expect(result.detail).toContain("shp-1"); // the hold names the shipment for the review queue
    expect(result.detail).toContain("evt-pod-1"); // and the POD that triggered billing
    expect("payload" in result).toBe(false); // a HOLD builds NO payload — nothing to leak downstream
  });

  it("a negative-flagged recorded quote ⇒ hold(anomaly) — the recorded flag is authoritative, never recomputed", () => {
    const quote = mkQuote({
      basis: { anomaly: { code: "negative", detail: "sell_cents -1 is negative — a price cannot be below zero" } },
    });
    const result = composeInvoice(baseInput(quote));
    if (result.status !== "hold") throw new Error("expected hold");
    expect(result.reason).toBe("anomaly");
    expect(result.detail).toContain("negative");
  });

  it("anomaly HOLD is HARD — even the strongest approval grant (dual) does NOT override it", () => {
    const quote = mkQuote({ basis: { anomaly: { code: "over_per_lb", detail: "absurd" } } });
    const result = composeInvoice({ ...baseInput(quote), approvalGranted: "dual" });
    expect(result.status).toBe("hold");
    if (result.status !== "hold") throw new Error("expected hold");
    expect(result.reason).toBe("anomaly");
  });

  it("basis.anomaly: null (a recorded SANE price) issues — null is not a flag", () => {
    const result = composeInvoice(baseInput(mkQuote({ basis: { anomaly: null } })));
    expect(result.status).toBe("issue");
  });

  // FAIL-CLOSED at the distinguishing values: only ABSENT or literal null means "sane". A truthiness
  // check would flip these malformed-record values to auto-issue — these tests make that mutation fail.
  it.each([
    { label: "false", anomaly: false },
    { label: '"" (empty string)', anomaly: "" },
  ])("a malformed recorded flag — basis.anomaly: $label — HOLDS (fail-closed, never truthiness)", ({ anomaly }) => {
    const result = composeInvoice(baseInput(mkQuote({ basis: { anomaly } })));
    expect(result.status).toBe("hold");
    if (result.status !== "hold") throw new Error("expected hold");
    expect(result.reason).toBe("anomaly");
  });
});

describe("composeInvoice — interline below-floor HOLD (REQ-040: judge the EXECUTING SHARE, never gross)", () => {
  // Tenant executes 3,000 bps of the move. Gross 120,000¢ CLEARS the 100,000¢ target — judging the
  // gross would issue — but the tenant's executing share is 36,000¢, below the 60,000¢ contribution
  // floor. The share, never the gross, is what is judged (REQ-040).
  const legs: readonly Leg[] = [
    { kind: "linehaul", executor: "party-tenant", split_bps: 3_000 },
    { kind: "interline", executor: "party-other", split_bps: 7_000 },
  ];

  // Floor ladders relative to the 36,000¢ share (REQ-048 matrix):
  //   default mkQuote floors: contribution 60,000 → share BELOW contribution ⇒ a LOSS ⇒ DUAL required.
  //   singleFloors: contribution 30,000 ≤ 36,000 < target 40,000 ⇒ below target only ⇒ SINGLE required.
  const singleFloors = { contribution: 30_000, full: 33_000, target: 40_000 };

  it("gross clears the floors but the executing share is below floor ⇒ HOLD (nothing granted)", () => {
    const quote = mkQuote(); // gross 120,000 ≥ target 100,000; share 36,000 < contribution 60,000
    const result = composeInvoice({ ...baseInput(quote), legs, tenantParty: "party-tenant" });
    expect(result.status).toBe("hold");
    if (result.status !== "hold") throw new Error("expected hold");
    expect(result.reason).toBe("below_floor");
    expect(result.detail).toContain("36000"); // the share actually judged
    expect(result.detail).toContain("shp-1"); // the hold names the shipment for the review queue
  });

  it("a DUAL-required hold (share below contribution — a loss) with only 'single' granted STAYS HELD (REQ-048)", () => {
    const quote = mkQuote(); // share 36,000 < contribution 60,000 ⇒ dual (finance) required
    const result = composeInvoice({
      ...baseInput(quote),
      legs,
      tenantParty: "party-tenant",
      approvalGranted: "single",
    });
    expect(result.status).toBe("hold");
    if (result.status !== "hold") throw new Error("expected hold");
    expect(result.reason).toBe("below_floor");
    expect(result.detail).toContain("dual"); // the hold says what it still needs
  });

  it("the same DUAL-required hold with 'dual' granted ⇒ ISSUE, lines still the full quote", () => {
    const quote = mkQuote();
    const result = composeInvoice({
      ...baseInput(quote),
      legs,
      tenantParty: "party-tenant",
      approvalGranted: "dual",
    });
    if (result.status !== "issue") throw new Error("expected issue");
    // The invoice still bills the CUSTOMER the full recorded sell — the share judged only the floor.
    expect(result.payload.lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(120_000);
  });

  it("a SINGLE-required hold (below target, above contribution) releases with 'single' granted", () => {
    const quote = mkQuote({ floors: singleFloors }); // 30,000 ≤ 36,000 < 40,000 ⇒ single required
    const held = composeInvoice({ ...baseInput(quote), legs, tenantParty: "party-tenant" });
    expect(held.status).toBe("hold"); // nothing granted ⇒ held
    const released = composeInvoice({
      ...baseInput(quote),
      legs,
      tenantParty: "party-tenant",
      approvalGranted: "single",
    });
    expect(released.status).toBe("issue");
  });

  it("an executing share at/above the floors issues WITHOUT approval", () => {
    // Same 36,000¢ share, but a floor ladder it clears: target 35,000 ≤ 36,000.
    const quote = mkQuote({ floors: { contribution: 20_000, full: 30_000, target: 35_000 } });
    const result = composeInvoice({ ...baseInput(quote), legs, tenantParty: "party-tenant" });
    expect(result.status).toBe("issue");
  });

  // Partial-signal guards, BOTH directions (mirrors rater assessApproval — REQ-040): a partial
  // interline signal must throw, never silently fall through to an unjudged issue.
  it("legs WITHOUT a tenantParty THROWS — never silently skip the share check (REQ-040)", () => {
    expect(() => composeInvoice({ ...baseInput(mkQuote()), legs })).toThrow(/tenantParty/);
  });

  it("a tenantParty WITHOUT legs THROWS — the mirror partial signal must not skip the check either", () => {
    expect(() => composeInvoice({ ...baseInput(mkQuote()), tenantParty: "party-tenant" })).toThrow(
      /legs/,
    );
  });

  it("legs: [] with a tenantParty is a partial signal too ⇒ THROWS (an empty set judges nothing)", () => {
    expect(() =>
      composeInvoice({ ...baseInput(mkQuote()), legs: [], tenantParty: "party-tenant" }),
    ).toThrow(/legs/);
  });

  it("neither legs nor tenantParty = a DIRECT shipment ⇒ issues (no interline check to run)", () => {
    const result = composeInvoice(baseInput(mkQuote()));
    expect(result.status).toBe("issue");
  });
});

describe("composeInvoice — deterministic (pure: no Date, no random, no I/O)", () => {
  it("the same input twice yields deep-equal payloads", () => {
    const input = baseInput(mkQuote());
    const a = composeInvoice(input);
    const b = composeInvoice(input);
    expect(a).toStrictEqual(b);
    if (a.status !== "issue" || b.status !== "issue") throw new Error("expected issue");
    expect(a.payload).toStrictEqual(b.payload);
  });
});

describe("glMap — the frozen, total kind → GL account map", () => {
  const accounts = [
    { kind: "freight", account: "4000-FREIGHT-AR" },
    { kind: "fsc", account: "4100-FSC-AR" },
    { kind: "accessorial", account: "4200-ACCESSORIAL-AR" },
  ] as const;

  it.each(accounts)("$kind → $account", ({ kind, account }) => {
    expect(glMap(kind)).toBe(account);
  });

  it("an unmapped kind THROWS — never a silent default account", () => {
    expect(() => glMap("cod_collect")).toThrow(/cod_collect/);
    expect(() => glMap("no-such-kind")).toThrow(/no-such-kind/);
    // prototype-chain keys must not resolve to a Function off Object.prototype
    expect(() => glMap("toString")).toThrow(/toString/);
  });
});

// THE POSTCONDITION ITSELF (audit §232). compose.ts asserts `Σ lines === sell` and says why: "the Task-1
// refine guarantees the recorded lines sum to sell, but a mapping bug here must fail loud, never
// misprice." The happy path above proves the lines mirror a WELL-FORMED quote; nothing proved the guard
// FIRES on a malformed one — disabling it left packages/agents 217/217 and workers/api 754/754 green.
//
// That matters because this guard is the SOLE enforcement of penny-parity. Downstream,
// packages/ledger/src/projection/money.ts:125 computes the invoice's total_cents FROM THE LINES
// (`p.lines.reduce(...)`), so a drifted line set does not disagree with anything — it silently produces an
// invoice whose total differs from the accepted quote's sell, and every projection agrees with itself.
//
// REQ-003 is "money is a PROJECTION of recorded physics". This is the assertion that makes the projection
// checkable rather than merely intended.
describe("composeInvoice — the penny-parity postcondition FIRES (REQ-003/031)", () => {
  it("lines that do not sum to the recorded sell THROW, naming both figures", () => {
    const drifted = {
      ...mkQuote(),
      lines: [
        { kind: "freight", code: "freight", amount_cents: 90_000 },
        { kind: "fsc", code: "fsc", amount_cents: 12_000 },
        { kind: "accessorial", code: "liftgate", amount_cents: 17_999 }, // one cent short of sell
      ],
    } as QuotePricedPayload;

    expect(() => composeInvoice(baseInput(drifted))).toThrow(/penny-parity violated/);
  });

  it("the error names the computed total AND the recorded sell — a misprice must be diagnosable", () => {
    const drifted = {
      ...mkQuote(),
      lines: [{ kind: "freight", code: "freight", amount_cents: 1 }],
    } as QuotePricedPayload;

    expect(() => composeInvoice(baseInput(drifted))).toThrow(/1¢.*120000|120000.*1¢/);
  });
});
