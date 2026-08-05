import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CSS_VAR_LITERALS, FONTS, TOKENS } from "../src/index.js";

// The drift pin: CSS_VAR_LITERALS (the JS literal map the evidence email inlines from, because
// mail clients strip var()) must equal tokens.css byte-for-value. --signal-deep already moved
// once (Amendment A1) — a token that moves in one file and not the other is a silent brand fork.
// (cwd-relative: vitest's root is this package; jsdom rewrites import.meta.url to localhost.)

const css = readFileSync(resolve(process.cwd(), "tokens.css"), "utf8");

function cssVars(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    out.set(m[1] as string, (m[2] as string).trim().replace(/\s+/g, " "));
  }
  return out;
}

describe("CSS_VAR_LITERALS ↔ tokens.css lockstep", () => {
  const fromCss = cssVars();

  it("every custom property tokens.css defines has the identical literal in CSS_VAR_LITERALS", () => {
    expect(fromCss.size).toBeGreaterThan(0);
    for (const [name, value] of fromCss) {
      expect(CSS_VAR_LITERALS[name as keyof typeof CSS_VAR_LITERALS], `token ${name} missing or drifted`).toBe(value);
    }
  });

  it("CSS_VAR_LITERALS names nothing tokens.css does not define", () => {
    for (const name of Object.keys(CSS_VAR_LITERALS)) {
      expect(fromCss.has(name), `${name} is not in tokens.css`).toBe(true);
    }
  });
});

// THE PALETTE BUDGET (audit §203/§204). `CLAUDE.md` lists "5 color tokens · 2 font families" under
// "Hard budgets (CI-enforced; exceeding = the PR is wrong)" — and until this test, nothing counted them.
// Planting a 6th token and a 3rd family passed everything: `audit:design` exit 0, this package 9/9,
// tools/design 49/49. What the design audit DOES enforce is the adjacent, stronger everyday rule — no raw
// hex outside tokens.ts, everything reaching colour through var(--token)/TOKENS — which stops ad-hoc
// colour but not the palette itself GROWING. That adjacency is why the gap survived: the check you would
// look for exists, guarding something else.
//
// A budget is only a budget if exceeding it fails. Deliberately `toBe`, not `toBeLessThanOrEqual`: the
// numbers ARE the law (five, two), so shrinking the palette should also make someone come here and
// re-read CLAUDE.md rather than silently pass.
describe("CLAUDE.md hard budget — the palette cannot grow", () => {
  it("exactly 5 colour tokens", () => {
    expect(Object.keys(TOKENS)).toHaveLength(5);
  });

  it("exactly 2 font families", () => {
    expect(Object.keys(FONTS)).toHaveLength(2);
  });
});
