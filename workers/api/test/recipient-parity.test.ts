import { describe, expect, it } from "vitest";
import dunningSrc from "../src/routes/dunning.ts?raw";
import billerSrc from "../../agents/src/biller.ts?raw";

// REQ-031/032/182 §785 — THE TWO RECIPIENT RESOLVERS MUST NOT DRIFT.
//
// One rule — "read only this party's contacts, prefer the `billing` one, else the first plausible email" —
// is implemented TWICE, because the api worker cannot import the agents worker's internals:
//
//   workers/agents/src/biller.ts        → resolveRecipient        (the evidence email: invoice + signed POD)
//   workers/api/src/routes/dunning.ts   → resolveDunningRecipient (the dunning notice: a demand for money)
//
// `dunning.ts`'s own header says the copy is "pinned to the SHARED predicate — anti-drift". Only the LEAF
// predicate (`plausibleEmail`) is genuinely shared; the preference-and-fallback logic around it is duplicated,
// and **nothing checked that the two agreed**. A claim of no-drift is not a check (the `two-mechanisms`
// pattern this audit keeps finding).
//
// This is the parity half of the doctrine — the behavioural half lives beside each resolver
// (`workers/agents/test/recipient-resolution.test.ts` and dunning.test.ts's billing-contact case), because a
// parity test alone would happily certify two copies that are identically WRONG.
//
// Compared as NORMALISED BODIES rather than whole files: these are functions inside much larger modules, so
// the byte-identical-file idiom used by `rate-config-parity` / `tenants-parity` does not apply here.

/** Extract a function body by name from raw module source (brace-matched, so nested blocks are kept). */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`recipient-parity: ${name} not found — it was renamed or removed, which is itself the drift this guards`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`recipient-parity: unbalanced braces while reading ${name}`);
}

/** Strip comments and collapse whitespace — the two copies may be commented and indented differently. */
function normalise(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//"))
    .join("\n")
    .replace(/\s+/g, " ");
}

describe("REQ-031/032/182 §785: the evidence-email and dunning recipient resolvers agree", () => {
  const biller = normalise(functionBody(billerSrc, "resolveRecipient"));
  const dunning = normalise(functionBody(dunningSrc, "resolveDunningRecipient"));

  it("finds both function bodies (non-vacuity — an empty extraction must not read as agreement)", () => {
    // Without this, a rename turns `normalise("")` === `normalise("")` into a passing test that guards nothing.
    expect(biller.length, "resolveRecipient body not extracted").toBeGreaterThan(200);
    expect(dunning.length, "resolveDunningRecipient body not extracted").toBeGreaterThan(200);
  });

  it("the two implementations are logically identical", () => {
    expect(
      dunning,
      "the dunning recipient resolver has DRIFTED from the Biller's. One rule, two copies, and they now " +
        "disagree — so an invoice and the dunning notice chasing that same invoice can reach DIFFERENT " +
        "addresses. Fix both, or extract the shared helper; do not relax this test.",
    ).toBe(biller);
  });

  it("both still contain the billing preference (the rule the parity test cannot see on its own)", () => {
    // Parity alone certifies agreement, INCLUDING agreement on a wrong answer. This is the cheap floor that
    // stops both copies drifting together; the behavioural proof lives in each worker's own suite.
    for (const [name, body] of [["biller", biller], ["dunning", dunning]] as const) {
      expect(body, `${name}: the "kind === billing" preference is gone`).toContain('"billing"');
    }
  });
});
