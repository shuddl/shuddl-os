import { describe, expect, it } from "vitest";
import { mulDivHalfUp as ledgerMulDivHalfUp } from "../../packages/ledger/src/money/split.js";
import { mulDivHalfUp as raterMulDivHalfUp } from "../../packages/rater/src/money.js";

// §1441 (REQ-118, CLAUDE.md money law) — ONE ROUNDING RULE, TWO IMPLEMENTATIONS, ONE PROBE CORPUS.
//
// `packages/ledger/src/money/split.ts` and `packages/rater/src/money.ts` each define `mulDivHalfUp`, and each
// says so: the rater's header reads "Mirrors the BigInt precedent in packages/ledger/src/money/split.ts". The
// duplication is DELIBERATE and correct — the rater is a domain engine ABOVE the ledger, neither package
// depends on the other, and importing across that line would invert the layering. What was missing is the
// thing the repo's own `share-lint-matchers-with-parity-tests` skill exists to add: **one corpus fed through
// BOTH, so the copies cannot drift.**
//
// WHY IT MATTERS, measured at §1441. Replacing the half-up decision with plain truncation — ONE token,
// `r * 2n >= d ? q + 1n : q` becomes `q` — is caught loudly in the rater (4+ named cases red, including the
// exact-half boundaries `15/10 ⇒ 2` and `5/10 ⇒ 1`) and is **completely silent in the ledger: 728 tests
// green**. The ledger copy has exactly one caller today (`documents/retention.ts`, a storage-cost estimate),
// so nothing financial rides on it YET — and "yet" is the whole argument. A money projection that starts
// using it inherits a rounding rule no test asserts.
//
// The corpus is the boundaries, not round numbers: exact halves in both directions, a value just under and
// just over a half, and the 2^53 case where a float product would already be wrong.

/** (a, b, divisor) — each chosen because it distinguishes half-up from truncation or from float arithmetic. */
const CORPUS: readonly (readonly [number, number, number, string])[] = [
  [15, 1, 10, "exact half rounds UP: 1.5 ⇒ 2"],
  [5, 1, 10, "exact half rounds UP: 0.5 ⇒ 1"],
  [14, 1, 10, "just under a half rounds DOWN: 1.4 ⇒ 1"],
  [16, 1, 10, "just over a half rounds UP: 1.6 ⇒ 2"],
  [12345, 3000, 10000, "the interline share case: 3703.5 ⇒ 3704"],
  [101, 4230, 10000, "fractional > 0.5: 42.723 ⇒ 43"],
  [1234, 100, 10000, "fractional < 0.5: 12.34 ⇒ 12"],
  [10000, 2500, 10000, "no remainder: exact"],
  [Number.MAX_SAFE_INTEGER - 1, 1, 2, "2^53 boundary — a float product is already wrong here"],
];

describe("§1441 money law: the ledger and rater half-up implementations agree on one corpus", () => {
  it("both are the same function on every boundary case", () => {
    for (const [a, b, d, why] of CORPUS) {
      const led = ledgerMulDivHalfUp(a, b, d);
      const rat = raterMulDivHalfUp(a, b, d);
      expect(led, `${why} — the two mirrored implementations DISAGREE on mulDivHalfUp(${a}, ${b}, ${d})`).toBe(rat);
    }
  });

  it("and both actually round HALF UP (not truncation) — the property, not just agreement", () => {
    // Agreement alone is satisfied by two identically-broken copies. This asserts the RULE, so a
    // simultaneous edit to both cannot pass by staying consistent.
    for (const impl of [ledgerMulDivHalfUp, raterMulDivHalfUp]) {
      expect(impl(15, 1, 10), "exact half must round UP").toBe(2);
      expect(impl(5, 1, 10), "exact half must round UP").toBe(1);
      expect(impl(14, 1, 10), "below a half must round DOWN").toBe(1);
      expect(impl(12345, 3000, 10000), "the interline share must be 3704, not 3703").toBe(3704);
    }
  });

  it("both reject the inputs the money law forbids, identically", () => {
    // A shared guarantee is not only the happy path: both refuse floats and negatives rather than silently
    // producing a cent that no audit can reproduce.
    for (const impl of [ledgerMulDivHalfUp, raterMulDivHalfUp]) {
      expect(() => impl(1.5, 100, 10000), "a non-integer operand must throw").toThrow();
      expect(() => impl(-1, 100, 10000), "a negative operand must throw").toThrow();
      expect(() => impl(100, 100, 0), "a zero divisor must throw").toThrow();
    }
  });
});
