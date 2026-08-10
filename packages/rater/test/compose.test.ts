import { describe, expect, it } from "vitest";
import { FscConfig, AccessorialSchedule } from "@shuddl/contracts";
import { compose } from "../src/compose.js";
import { mulDivHalfUp, roundHalfUp } from "../src/money.js";
import type { PriceLine, Composed } from "../src/compose.js";

// REQ-027: hand-computed known-answer tests for the price COMPOSER (freight + fsc + accessorials → lines
// + sell) and its BigInt-safe fsc primitive mulDivHalfUp. Every cent below is computed by hand so the
// arithmetic is auditable. Money is INTEGER cents throughout.

// ---------------------------------------------------------------------------------------------------
// mulDivHalfUp — the BigInt-safe round_half_up((a×b)/divisor) used to form the fsc line.
// ---------------------------------------------------------------------------------------------------
describe("mulDivHalfUp — round_half_up((a×b)/divisor), product formed in BigInt", () => {
  it("normal exact case (no rounding): 10000 × 2500 / 10000 = 2500", () => {
    // fsc shape: freight 10000¢ at 2500 bps (25%) → 25000000/10000 = 2500 exactly.
    expect(mulDivHalfUp(10_000, 2_500, 10_000)).toBe(2_500);
  });

  it("rounds DOWN (fractional < 0.5): 1234 × 100 / 10000 = 12.34 ⇒ 12", () => {
    // 1234 * 100 = 123400; 123400 / 10000 = 12.34 → half-up → 12 (a ceil would give 13).
    expect(mulDivHalfUp(1_234, 100, 10_000)).toBe(12);
  });

  it("rounds UP at exact half: 15 × 1 / 10 = 1.5 ⇒ 2; and 5 × 1 / 10 = 0.5 ⇒ 1", () => {
    expect(mulDivHalfUp(15, 1, 10)).toBe(2);
    expect(mulDivHalfUp(5, 1, 10)).toBe(1);
  });

  it("rounds UP (fractional > 0.5): 101 × 4230 / 10000 = 42.723 ⇒ 43", () => {
    // 101 * 4230 = 427230; /10000 = 42.723 → half-up → 43.
    expect(mulDivHalfUp(101, 4_230, 10_000)).toBe(43);
  });

  it("2^53 GUARD: a×b overflows Number.MAX_SAFE_INTEGER but the BigInt path stays exact", () => {
    // a = MAX_SAFE_INTEGER (9007199254740991, odd), b = 3 (odd) ⇒ TRUE product = 27021597764222973 (odd,
    // in [2^54, 2^55) where floats are spaced by 4) — NOT representable as a JS number. divisor = 6.
    //   exact:  27021597764222973 / 6 = 4503599627370495 r3 → 2*3 ≥ 6 → round UP → 4503599627370496.
    // The JS-number product loses precision: 9007199254740991 * 3 === 27021597764222972 (off by one), and
    //   naive: 27021597764222972 / 6 = 4503599627370495 r2 → 2*2 < 6 → round DOWN → 4503599627370495.
    // So the BigInt path is off-by-one from the float path — proving the guard is load-bearing.
    const a = Number.MAX_SAFE_INTEGER;
    const b = 3;
    const d = 6;

    // BigInt path (correct):
    expect(mulDivHalfUp(a, b, d)).toBe(4_503_599_627_370_496);

    // Demonstrate the float product is lossy and the naive path disagrees:
    expect(a * b).toBe(27_021_597_764_222_972); // NOT the true 27021597764222973
    const naive = roundHalfUp(a * b, d); // rounds the LOSSY product
    expect(naive).toBe(4_503_599_627_370_495);
    expect(mulDivHalfUp(a, b, d)).not.toBe(naive);
  });

  it("large product with divisor 10000 stays exact and safe (freight ≈ 10^12 × 10000 bps)", () => {
    // a = 1000000000001 (~10^12 cents), b = 10000 bps ⇒ product = 10000000000010000 > 2^53
    // (9007199254740991). 10000000000010000 / 10000 = 1000000000001 exactly (a itself), safe. Round-trip exact.
    expect(mulDivHalfUp(1_000_000_000_001, 10_000, 10_000)).toBe(1_000_000_000_001);
  });

  it("rejects non-integer / negative / zero-divisor inputs (fails loudly, never misprices)", () => {
    expect(() => mulDivHalfUp(1.5, 100, 10_000)).toThrow();
    expect(() => mulDivHalfUp(100, 1.5, 10_000)).toThrow();
    expect(() => mulDivHalfUp(-1, 100, 10_000)).toThrow();
    expect(() => mulDivHalfUp(100, -1, 10_000)).toThrow();
    expect(() => mulDivHalfUp(100, 100, 0)).toThrow();
  });

  it("RESULT guard: a result past MAX_SAFE_INTEGER THROWS (never returns a lossy number)", () => {
    // MAX_SAFE_INTEGER × 10 / 1 = 90071992547409910, far past 2^53 — returning it as a JS number would
    // silently lose precision, so it must throw rather than return a lie.
    expect(() => mulDivHalfUp(Number.MAX_SAFE_INTEGER, 10, 1)).toThrow(/MAX_SAFE_INTEGER/);
  });
});

// ---------------------------------------------------------------------------------------------------
// compose — freight + fsc + accessorials → ordered price lines + sell.
// ---------------------------------------------------------------------------------------------------
// A tenant fsc (25%) and a fsc with pct_bps = 0 (no-fsc lane), both parsed through the Task-1 schema so
// compose is only ever fed VALID configs. An accessorial schedule with a zero-priced entry ("notify")
// exercises the "known but 0 ⇒ omit, not an unknown" branch.
const fsc25 = FscConfig.parse({ kind: "fsc", id: "fsc-test", version: "2026.07", pct_bps: 2_500 });
const fscZero = FscConfig.parse({ kind: "fsc", id: "fsc-zero", version: "2026.07", pct_bps: 0 });
const accessorials = AccessorialSchedule.parse({
  kind: "accessorials",
  id: "acc-test",
  version: "2026.07",
  items: { liftgate: 2_500, residential: 4_000, notify: 0 },
});

const codes = (c: Composed) => c.lines.map((l) => l.code);
const sumOf = (lines: readonly PriceLine[]) => lines.reduce((s, l) => s + l.amount_cents, 0);

describe("compose — freight + fsc, no accessorials", () => {
  it("clean fsc: freight 10000 @ 2500 bps ⇒ [freight 10000, fsc 2500], sell 12500", () => {
    const r = compose(10_000, [], fsc25, accessorials);
    expect(r.lines).toEqual<PriceLine[]>([
      { kind: "freight", code: "freight", amount_cents: 10_000 },
      { kind: "fsc", code: "fsc", amount_cents: 2_500 },
    ]);
    expect(r.sell_cents).toBe(12_500);
  });

  it("fsc rounding (DOWN): freight 12345 @ 2500 bps ⇒ fsc 3086 (3086.25 → 3086), sell 15431", () => {
    // 12345 * 2500 = 30862500; /10000 = 3086.25 → half-up → 3086.
    const r = compose(12_345, [], fsc25, accessorials);
    expect(r.lines).toEqual<PriceLine[]>([
      { kind: "freight", code: "freight", amount_cents: 12_345 },
      { kind: "fsc", code: "fsc", amount_cents: 3_086 },
    ]);
    expect(r.sell_cents).toBe(15_431);
  });
});

describe("compose — pct_bps = 0 ⇒ no fsc line", () => {
  it("freight only: sell excludes fsc", () => {
    const r = compose(10_000, [], fscZero, accessorials);
    expect(r.lines).toEqual<PriceLine[]>([{ kind: "freight", code: "freight", amount_cents: 10_000 }]);
    expect(r.sell_cents).toBe(10_000);
    expect(codes(r)).not.toContain("fsc");
  });

  it("freight + accessorials but no fsc: [freight, liftgate], sell 12500", () => {
    const r = compose(10_000, ["liftgate"], fscZero, accessorials);
    expect(r.lines).toEqual<PriceLine[]>([
      { kind: "freight", code: "freight", amount_cents: 10_000 },
      { kind: "accessorial", code: "liftgate", amount_cents: 2_500 },
    ]);
    expect(r.sell_cents).toBe(12_500);
  });
});

describe("compose — accessorials", () => {
  it("two accessorials are billed and SORTED by code asc, regardless of request order", () => {
    // requested residential THEN liftgate; output must be freight, fsc, liftgate, residential.
    const r = compose(10_000, ["residential", "liftgate"], fsc25, accessorials);
    expect(codes(r)).toEqual(["freight", "fsc", "liftgate", "residential"]);
    expect(r.lines).toEqual<PriceLine[]>([
      { kind: "freight", code: "freight", amount_cents: 10_000 },
      { kind: "fsc", code: "fsc", amount_cents: 2_500 },
      { kind: "accessorial", code: "liftgate", amount_cents: 2_500 },
      { kind: "accessorial", code: "residential", amount_cents: 4_000 },
    ]);
    expect(r.sell_cents).toBe(19_000); // 10000 + 2500 + 2500 + 4000
  });

  it("NO SILENT DROP: an unknown accessorial code THROWS naming the code", () => {
    expect(() => compose(10_000, ["teleport"], fsc25, accessorials)).toThrow(/teleport/);
  });

  it("inherited keys are 'unknown', not Object.prototype members: 'constructor' THROWS", () => {
    expect(() => compose(10_000, ["constructor"], fsc25, accessorials)).toThrow(/constructor/);
  });

  it("DEDUPE: a code requested twice bills ONCE", () => {
    const r = compose(10_000, ["liftgate", "liftgate"], fsc25, accessorials);
    expect(r.lines).toEqual<PriceLine[]>([
      { kind: "freight", code: "freight", amount_cents: 10_000 },
      { kind: "fsc", code: "fsc", amount_cents: 2_500 },
      { kind: "accessorial", code: "liftgate", amount_cents: 2_500 },
    ]);
    expect(r.sell_cents).toBe(15_000); // liftgate counted once
  });

  it("a KNOWN but zero-priced accessorial is omitted (0-cent line is noise) — and does NOT throw", () => {
    // "notify" IS in the schedule (priced 0), so it is not an unknown/silent-drop — it is simply omitted.
    const r = compose(10_000, ["notify"], fscZero, accessorials);
    expect(r.lines).toEqual<PriceLine[]>([{ kind: "freight", code: "freight", amount_cents: 10_000 }]);
    expect(r.sell_cents).toBe(10_000);
  });
});

describe("compose — invariants", () => {
  it("sell_cents always equals Σ line amounts, and every emitted line is > 0", () => {
    const r = compose(12_345, ["residential", "liftgate", "liftgate"], fsc25, accessorials);
    expect(r.sell_cents).toBe(sumOf(r.lines));
    for (const line of r.lines) expect(line.amount_cents).toBeGreaterThan(0);
  });

  it("is deterministic: same inputs ⇒ deeply-equal output", () => {
    const args = () => compose(12_345, ["residential", "liftgate"], fsc25, accessorials);
    expect(args()).toEqual(args());
  });

  it("defensive: freight 0 omits the freight line (omit-zero applies uniformly)", () => {
    // priceFreight never yields 0 freight (positive weight + min_charge floor), but the composer holds the
    // PriceLine invariant "always > 0 for an emitted line" uniformly rather than emitting a 0-cent line.
    const r = compose(0, ["liftgate"], fscZero, accessorials);
    expect(r.lines).toEqual<PriceLine[]>([
      { kind: "accessorial", code: "liftgate", amount_cents: 2_500 },
    ]);
    expect(r.sell_cents).toBe(2_500);
  });

  it("freightCents guard: a non-integer or negative freight THROWS (self-standing, not via fsc)", () => {
    // Even with pct_bps = 0 (fsc skipped path in future), the freight guard still fires on bad input.
    expect(() => compose(1.5, [], fscZero, accessorials)).toThrow(/freightCents/);
    expect(() => compose(-1, [], fscZero, accessorials)).toThrow(/freightCents/);
    expect(() => compose(Number.NaN, [], fscZero, accessorials)).toThrow(/freightCents/);
  });
});

// ─── §929 — THE COMPOSER CAN EMIT ZERO LINES, WHICH IS WHY quote.priced's `.min(1)` IS LOAD-BEARING ─────
//
// §928 established that `QuotePricedPayload`'s penny-parity refine (Σ lines === sell) cannot refuse an
// empty breakdown when `sell` is 0 — Σ [] = 0 === 0 — so the array `.min(1)` is the sole refusal for that
// input. It left the reachability open as a trigger. This closes it.
//
// The composer OMITS zero lines by design: freight is pushed only `if (freightCents > 0)`, fsc only if the
// computed fsc is > 0, and zero-priced accessorials are dropped. `compose`'s own guard admits
// `freightCents === 0` (non-negative integer), and `min_charge_cents` is `NonNegCents` — `>= 0` — so a
// zero-charge tariff rates to 0 and the floor does not lift it.
//
// The source comment says "freight is > 0 for any real PRICED shipment". That is an ASSUMPTION about
// tariffs, not an enforcement, and a misconfigured or not-yet-populated tariff is exactly the shape that
// arrives during onboarding. What `.min(1)` buys is that such a tariff makes /v1/rate FAIL CLOSED rather
// than record a meaningless quote — a price with nothing behind it, which is the shape REQ-004 refuses.
describe("§929: a zero-charge tariff composes ZERO lines — the input quote.priced's .min(1) is the only guard for", () => {
  it("compose(0, [], fsc 0%, no accessorials) yields an EMPTY breakdown summing to zero", () => {
    // Module-scope fixtures (fscZero is 0 bps; no accessorials requested), so nothing here invents a shape.
    const r: Composed = compose(0, [], fscZero, accessorials);
    // Not a hypothetical: the composer's own omit-zero rule produces this, with no line to carry the price.
    expect(r.lines).toEqual([]);
    expect(r.sell_cents).toBe(0);
  });
});
