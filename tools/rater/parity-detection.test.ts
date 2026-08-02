import { describe, expect, it } from "vitest";
// The rater is consumed by SOURCE MODULE PATH, not the package name — root does not depend on
// @shuddl/rater, matching the idiom in parity.ts/invoice-parity.ts.
import type { QuoteResult, RateRequest, TenantRatingConfig } from "../../packages/rater/src/price.js";
import { runParity, type ParityCase } from "./parity.js";
import { runInvoiceParity, SMOKE_CASES, SMOKE_CONFIG, type InvoiceReplayCase } from "./invoice-parity.js";
import { compareRequest, compareDecision, type Mismatch } from "../concierge/parse-parity.js";

// 2026-08-02 audit §17 (REQ-027/165/031/040) — CAN THE PARITY GATES ACTUALLY FAIL?
//
// A sweep of every gate script for negative-test coverage found exactly three with none: the rater parity
// harness, the invoice replay harness, and the concierge parse harness. Those are the SAME three that are
// BLOCKED/PENDING on engagement fixtures that have never been vendored — so they have never executed against
// real inputs AND nothing proves their comparison logic works.
//
// That combination is the §16 defect shape waiting to happen. On the day the owner vendors the fixtures,
// three gates flip from PENDING to blocking. If a comparison is inverted, a tolerance is backwards, or a
// field is silently skipped, the gate either blocks a correct release or — far worse — certifies a wrong
// one, and there is no evidence today that would tell us which.
//
// The private fixtures are not needed to answer that question. Both rater harnesses take an INJECTABLE
// price function and `invoice-parity` ships an in-repo SMOKE set, so the DETECTION logic is fully testable
// here. What stays untestable without the fixtures is whether tenant-0's real numbers match — which is the
// gate's job, not this file's. This file proves the gate is capable of saying no.

const REQ: ParityCase["request"] = { origin_zip: "97201", dest_zip: "80012", weight_lb: 1000 };

function pricedAs(sell: number, floors = { contribution: 1, full: 2, target: 3 }): QuoteResult {
  return { status: "PRICED", sell_cents: sell, floors, lines: [], versions: {} } as unknown as QuoteResult;
}
function unknownFor(reason: string): QuoteResult {
  return { status: "UNKNOWN", reason, floors: { contribution: 0, full: 0, target: 0 }, lines: [], versions: {} } as unknown as QuoteResult;
}
const stub =
  (r: QuoteResult) =>
  (_req: RateRequest, _cfg: TenantRatingConfig): QuoteResult =>
    r;

const CFG = SMOKE_CONFIG;

describe("runParity DETECTS divergence — the 48-test / 504-sweep gate can say no (REQ-027/165)", () => {
  const priced: ParityCase = { name: "c", request: REQ, expect: { status: "PRICED", sell_cents: 55_800 } };

  it("an exact match passes and reports zero mismatches", () => {
    const r = runParity([priced], CFG, stub(pricedAs(55_800)));
    expect(r).toEqual({ total: 1, passed: 1, mismatches: [] });
  });

  it("ONE CENT of sell divergence is a mismatch — this gate is penny-exact, not approximate", () => {
    const r = runParity([priced], CFG, stub(pricedAs(55_801)));
    expect(r.passed).toBe(0);
    expect(r.mismatches).toEqual([{ name: "c", field: "sell_cents", expected: 55_800, actual: 55_801 }]);
  });

  it("a status divergence is decisive and reported ALONE (downstream fields are incomparable)", () => {
    const r = runParity([priced], CFG, stub(unknownFor("missing_weight")));
    expect(r.passed).toBe(0);
    expect(r.mismatches).toEqual([{ name: "c", field: "status", expected: "PRICED", actual: "UNKNOWN" }]);
  });

  it("each floor is compared INDIVIDUALLY — a single wrong floor cannot hide behind the other two", () => {
    const withFloors: ParityCase = {
      name: "f",
      request: REQ,
      expect: { status: "PRICED", sell_cents: 100, floors: { contribution: 1, full: 2, target: 3 } },
    };
    const r = runParity([withFloors], CFG, stub(pricedAs(100, { contribution: 1, full: 999, target: 3 })));
    expect(r.mismatches).toEqual([{ name: "f", field: "floors.full", expected: 2, actual: 999 }]);
  });

  it("a HOLLOW PRICED expectation is a mismatch, never a status-only pass", () => {
    // The Zod refine rejects this at CLI parse; runParity is exported, so a caller building cases by hand
    // must not be able to green an expectation that pins nothing. This is the defence-in-depth branch.
    const hollow = { name: "h", request: REQ, expect: { status: "PRICED" } } as unknown as ParityCase;
    const r = runParity([hollow], CFG, stub(pricedAs(55_800)));
    expect(r.passed).toBe(0);
    expect(r.mismatches[0]).toMatchObject({ name: "h", field: "sell_cents", expected: undefined });
  });

  it("an UNKNOWN case compares the machine-readable reason when it pins one", () => {
    const u: ParityCase = { name: "u", request: REQ, expect: { status: "UNKNOWN", reason: "missing_weight" } };
    expect(runParity([u], CFG, stub(unknownFor("missing_weight"))).mismatches).toEqual([]);
    expect(runParity([u], CFG, stub(unknownFor("missing_dims"))).mismatches).toEqual([
      { name: "u", field: "reason", expected: "missing_weight", actual: "missing_dims" },
    ]);
  });

  it("counts are per-CASE, not per-mismatch — one case with two bad fields is one failure of one", () => {
    const two: ParityCase = {
      name: "t",
      request: REQ,
      expect: { status: "PRICED", sell_cents: 1, floors: { contribution: 9, full: 9, target: 9 } },
    };
    const r = runParity([two], CFG, stub(pricedAs(2, { contribution: 8, full: 8, target: 8 })));
    expect(r.total).toBe(1);
    expect(r.passed).toBe(0);
    expect(r.mismatches.length).toBeGreaterThan(1);
  });

  it("an EMPTY case list is not a pass in disguise — total 0 means the gate asserted nothing", () => {
    // The CLI must never read `passed === total` as success on zero cases; this records the shape so a
    // future reader of ParityResult sees that 0/0 is vacuous, not green.
    expect(runParity([], CFG, stub(pricedAs(1)))).toEqual({ total: 0, passed: 0, mismatches: [] });
  });
});

describe("runInvoiceParity DETECTS divergence — the WP-06 penny-exact replay gate can say no (REQ-031/040)", () => {
  it("the in-repo SMOKE set passes against the real engine — the harness works end to end", () => {
    const r = runInvoiceParity(SMOKE_CASES, SMOKE_CONFIG);
    expect(r.mismatches).toEqual([]);
    expect(r.passed).toBe(r.total);
    expect(r.total).toBeGreaterThan(0); // a smoke set that shrank to nothing would otherwise read green
  });

  it("perturbing ONE CENT of a smoke expectation fails it — penny-exact means penny-exact", () => {
    const [first, ...rest] = SMOKE_CASES;
    const bumped = {
      ...first!,
      expect: { ...first!.expect, sell_cents: (first!.expect as { sell_cents: number }).sell_cents + 1 },
    } as InvoiceReplayCase;
    const r = runInvoiceParity([bumped, ...rest], SMOKE_CONFIG);
    expect(r.passed).toBe(r.total - 1);
    expect(r.mismatches.map((m) => m.name)).toContain(first!.name);
  });

  it("a thrown comparison is recorded as a MISMATCH, never swallowed into a pass", () => {
    const boom = (): QuoteResult => {
      throw new Error("engine exploded");
    };
    const r = runInvoiceParity([SMOKE_CASES[0]!], SMOKE_CONFIG, boom as unknown as typeof runInvoiceParity extends never ? never : Parameters<typeof runInvoiceParity>[2]);
    expect(r.passed).toBe(0);
    expect(r.mismatches[0]).toMatchObject({ field: "exception" });
    expect(String(r.mismatches[0]?.actual)).toContain("engine exploded");
  });
});

// ── The third untested gate: the concierge parse harness (REQ-026/093/100) ────────────────────────────
// Its comparison logic was PRIVATE, so nothing could prove it reports a divergence rather than silently
// agreeing with whatever it is handed. `compareRequest` / `compareDecision` are now exported for exactly
// this pin (the two rater harnesses already exported their run functions for the same reason).
describe("the concierge parse harness DETECTS divergence (REQ-026/093/100)", () => {
  const EXPECTED = { origin_zip: "97201", dest_zip: "80012", weight_lb: 1000 };
  const req = (over: Record<string, unknown> = {}): never => ({ ...EXPECTED, ...over }) as never;

  it("an exact request match pushes nothing", () => {
    const out: Mismatch[] = [];
    compareRequest("c", req(), EXPECTED as never, out);
    expect(out).toEqual([]);
  });

  it("each request field is compared individually — origin, dest and weight each surface alone", () => {
    for (const [field, over] of [
      ["request.origin_zip", { origin_zip: "99999" }],
      ["request.dest_zip", { dest_zip: "99999" }],
      ["request.weight_lb", { weight_lb: 2 }],
    ] as const) {
      const out: Mismatch[] = [];
      compareRequest("c", req(over), EXPECTED as never, out);
      expect(out.map((m) => m.field), `${field} must be detected`).toEqual([field]);
    }
  });

  it("NO price on air: a request the parser should NOT have formed is a mismatch when it exists", () => {
    const out: Mismatch[] = [];
    compareRequest("c", req(), undefined, out);
    expect(out.map((m) => m.field)).toEqual(["request"]);
    const out2: Mismatch[] = [];
    compareRequest("c", undefined as never, EXPECTED as never, out2);
    expect(out2.map((m) => m.field)).toEqual(["request"]);
  });

  it("accessorials compare as a SET — order never matters, membership always does", () => {
    const withAcc = { ...EXPECTED, accessorials: ["liftgate", "residential"] };
    const same: Mismatch[] = [];
    compareRequest("c", req({ accessorials: ["residential", "liftgate"] }), withAcc as never, same);
    expect(same).toEqual([]);
    const differs: Mismatch[] = [];
    compareRequest("c", req({ accessorials: ["liftgate"] }), withAcc as never, differs);
    expect(differs.map((m) => m.field)).toEqual(["request.accessorials"]);
  });

  it("a decision status divergence is decisive and stops the reason comparison", () => {
    const out: Mismatch[] = [];
    compareDecision("c", { status: "auto_reply" } as never, { status: "queued", reason: "floor_block" } as never, out);
    expect(out.map((m) => m.field)).toEqual(["decision.status"]);
  });

  it("two QUEUED decisions with different reasons diverge — a queue is not a queue", () => {
    const out: Mismatch[] = [];
    compareDecision(
      "c",
      { status: "queued", reason: "floor_block" } as never,
      { status: "queued", reason: "low_confidence" } as never,
      out,
    );
    expect(out).toEqual([
      { name: "c", field: "decision.reason", expected: "low_confidence", actual: "floor_block" },
    ]);
  });

  it("matching decisions push nothing", () => {
    const out: Mismatch[] = [];
    compareDecision("c", { status: "auto_reply" } as never, { status: "auto_reply" } as never, out);
    compareDecision("c", { status: "queued", reason: "floor_block" } as never, { status: "queued", reason: "floor_block" } as never, out);
    expect(out).toEqual([]);
  });
});
