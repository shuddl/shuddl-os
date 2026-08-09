import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §821 — ONE RATE REQUEST, FOUR HAND-ROLLED COPIES OF ITS SHAPE.
//
// `packages/contracts/src/rating.ts` declares `RateRequestPayload` under an explicit claim: *"the SINGLE
// canonical rate-request shape … ONE source of truth: a field drift on either side breaks the rater build"*
// and *"(mirrors the workers/api RateBody boundary)"*.
//
// Half of that is true and load-bearing. `packages/rater` aliases the INFERRED TYPE, so adding or removing a
// FIELD on either side is a compile error. But an inferred type carries no CONSTRAINTS — `min`, `max`,
// `nonnegative`, `optional` vs `nullish` all erase to the same TypeScript. So the build catches field drift
// and is structurally blind to constraint drift, which is the kind that actually changes what a caller may
// send. And only the translator imports `RateRequestPayload` at all: the three QUOTE surfaces each hand-roll
// their own copy.
//
// MEASURED (§821), and this is why the gate exists rather than a comment: the MCP tool declared
// `dims: Dims.optional()` where every other surface used `.nullish()`. `.optional()` accepts `undefined` and
// REJECTS `null`, so `{"dims": null}` — what a JSON producer naturally emits for an absent optional field —
// was a 400 from MCP and an accepted UNKNOWN from `/v1/rate` and the guest quote. One semantic payload,
// three surfaces, two answers, on the surface acceptance demo #4 runs through. The MCP file's own comment
// two lines above said missing dims "is never a client-side 400 here".
//
// WHAT THIS GATE DOES **NOT** CLAIM. The four schemas are legitimately different in scope: MCP takes parties
// and a mode, `/v1/rate` takes legs and a proposed sell, the guest body takes neither. Demanding whole-schema
// equality would be wrong and would be silenced within a month. This pins only the PHYSICS fields — the ones
// REQ-004 governs and all four genuinely share.

interface Surface {
  readonly path: string;
  readonly what: string;
}

/** Every place a rate request's physics is validated. A new quote surface belongs here. */
const SURFACES: readonly Surface[] = [
  { path: "packages/contracts/src/rating.ts", what: "the canonical RateRequestPayload" },
  { path: "workers/api/src/routes/rate.ts", what: "POST /v1/rate (authenticated)" },
  { path: "workers/api/src/pub/quote.ts", what: "the public guest quote" },
  { path: "workers/mcp/src/tools/quote.ts", what: "the MCP quote_freight tool (demo #4)" },
];

/**
 * The lower bound a Zod field expression admits, across BOTH idioms in this repo.
 *
 * The two idioms are `z.number().int().nonnegative()` (the workers) and `SafeInt.min(0)` (contracts). They
 * are equivalent, and normalising them is the only way to compare the copies at all — but a hand-written
 * mapping is itself a transcription, so it is CALIBRATED below against planted strings rather than trusted.
 */
function lowerBound(expr: string): number | null {
  const min = /\.min\((\d+)\)/.exec(expr);
  if (min) return Number(min[1]);
  if (/\.positive\(\)/.test(expr)) return 1;
  if (/\.nonnegative\(\)/.test(expr)) return 0;
  return null;
}

/** How a field treats absence: "nullish" (undefined AND null), "optional" (undefined only), or "required". */
function optionality(expr: string): string {
  if (/\.nullish\(\)/.test(expr)) return "nullish";
  if (/\.nullable\(\)/.test(expr)) return "nullable";
  if (/\.optional\(\)/.test(expr)) return "optional";
  return "required";
}

/** The trimmed source line declaring `<field>:` in a file, or undefined. */
function fieldLine(text: string, field: string): string | undefined {
  return text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(`${field}:`) && !l.startsWith("//"));
}

const read = (root: string, p: string): string => readFileSync(`${root}/${p}`, "utf8");

describe("§821: every quote surface validates the SAME physics", () => {
  const root = repoRoot();
  const sources = SURFACES.map((s) => ({ ...s, text: read(root, s.path) }));

  it("the idiom normaliser is calibrated (a hand-written mapping is a transcription until proven)", () => {
    // Both real idioms, and the shapes that must NOT be silently read as a bound.
    expect(lowerBound("SafeInt.min(0)")).toBe(0);
    expect(lowerBound("SafeInt.min(1).optional()")).toBe(1);
    expect(lowerBound("z.number().int().nonnegative()")).toBe(0);
    expect(lowerBound("z.number().int().positive()")).toBe(1);
    expect(lowerBound("z.string().min(1)")).toBe(1); // a length bound reads as a bound — see the dims-only scope note
    expect(lowerBound("z.array(z.string())")).toBeNull();
    expect(optionality("Dims.nullish()")).toBe("nullish");
    expect(optionality("Dims.optional()")).toBe("optional");
    expect(optionality("Dims")).toBe("required");
    // The exact §821 defect, planted: these two must NOT compare equal.
    expect(optionality("Dims.optional()")).not.toBe(optionality("Dims.nullish()"));
  });

  it("every surface treats ABSENT dims identically — the §821 defect", () => {
    // `.optional()` rejects an explicit null; `.nullish()` accepts it. A caller sending {"dims": null} must
    // get the same answer everywhere, and REQ-004 says that answer is UNKNOWN, never a 400.
    const seen = sources.map((s) => {
      const line = fieldLine(s.text, "dims");
      expect(line, `${s.path} (${s.what}) no longer declares a \`dims:\` field — a quote surface with no physics validation, or this roster is stale`).toBeDefined();
      return { path: s.path, what: s.what, mode: optionality(line!) };
    });
    const modes = [...new Set(seen.map((x) => x.mode))];
    expect(
      modes,
      "the quote surfaces DISAGREE about how absent dims is expressed:\n  " +
        seen.map((x) => `${x.mode.padEnd(9)} ${x.path} — ${x.what}`).join("\n  ") +
        "\nUse .nullish() everywhere: a JSON producer emits null for an absent optional field, and REQ-004's " +
        "answer to missing physics is UNKNOWN-no-sell, never a client-side 400.",
    ).toEqual(["nullish"]);
  });

  it("every surface admits the same DIMS bounds (l_in/w_in/h_in ≥ 0, pieces ≥ 1)", () => {
    // The bounds themselves are §820's law: a zero dimension is legal at the boundary (0 means "not
    // provided") and the ENGINE turns it into UNKNOWN. What must not drift is one surface deciding a zero
    // dimension is a 400 while another prices the request — the same split §820 found between the pricing
    // and ledger paths, one layer out.
    for (const field of ["l_in", "w_in", "h_in", "pieces"] as const) {
      const bounds = sources.map((s) => ({ path: s.path, bound: lowerBound(fieldLine(s.text, field) ?? "") }));
      const distinct = [...new Set(bounds.map((b) => b.bound))];
      expect(
        distinct,
        `the surfaces disagree on the lower bound of \`${field}\`:\n  ` +
          bounds.map((b) => `${String(b.bound).padEnd(5)} ${b.path}`).join("\n  "),
      ).toHaveLength(1);
      expect(distinct[0], `\`${field}\` has no recognisable lower bound on any surface — the normaliser missed both idioms`).not.toBeNull();
    }
  });

  it("weight_lb agrees across surfaces (a positive whole number, or absent)", () => {
    const seen = sources.map((s) => {
      const line = fieldLine(s.text, "weight_lb");
      expect(line, `${s.path} no longer declares weight_lb`).toBeDefined();
      return { path: s.path, bound: lowerBound(line!), mode: optionality(line!) };
    });
    expect([...new Set(seen.map((x) => x.bound))], `weight_lb lower bounds diverge:\n  ${seen.map((x) => `${String(x.bound).padEnd(5)} ${x.path}`).join("\n  ")}`).toEqual([1]);
    expect([...new Set(seen.map((x) => x.mode))], "weight_lb optionality diverges across surfaces").toEqual(["optional"]);
  });

  it("the roster is non-vacuous — every file exists and declares a physics field", () => {
    // Without this, a renamed file would make `read` throw (loud), but a file that merely stopped declaring
    // `dims` would make every set above a set of ONE and pass. §819's lesson: a parity test compares sets,
    // and a set of one always agrees with itself.
    expect(SURFACES).toHaveLength(4);
    for (const s of sources) {
      expect(fieldLine(s.text, "dims"), `${s.path} declares no dims`).toBeDefined();
      expect(fieldLine(s.text, "weight_lb"), `${s.path} declares no weight_lb`).toBeDefined();
    }
  });
});
