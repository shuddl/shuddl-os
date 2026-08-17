import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1695 (REQ-118/119) — NO NEW ERROR CODE MAY BE DECLARED WITHOUT A PRODUCER.
//
// §1694 measured the wire contract's ten codes against their emitters and found TWO with zero:
// `UNKNOWN_NO_PRICE` and `FLOOR_APPROVAL_REQUIRED`. Both are vestigial — the behaviours they name outgrew an
// error code (a quote that cannot be priced returns a 200 carrying `{status:"UNKNOWN", reason}`; a below-floor
// price appends `approval.requested`) — and REMOVING either is a wire-contract change reserved to a register
// amendment. So they stay, and this gate stops a THIRD from joining them.
//
// WHY THIS VOCABULARY AND NOT THE OTHER ONE (§1695's actual finding). The 35 `EVENT_KINDS` have the same
// shape — a frozen declared vocabulary — and four of them likewise have no producer (`quote.sent`,
// `quote.expired`, `pickup.scheduled`, and `call.transcribed`, which is CONFIRM-gated by CLAUDE.md). Nobody
// had to notice, because the event taxonomy is ITERATED: `for (const kind of EVENT_KINDS)` and friends run at
// **14** sites, so lens, visibility and chain coverage touch every member whether or not anything emits it.
// The error enum is iterated at **ZERO** sites — it is only ever referenced one member at a time — which is
// exactly how two dead codes sat in a wire contract unremarked.
//
//   A vocabulary that is WALKED cannot hide a dead member. One referenced member-by-member can.
//
// This gate is the walk the error enum lacked.

/** FROZEN at §1695: `UNKNOWN_NO_PRICE` + `FLOOR_APPROVAL_REQUIRED`. May FALL (a producer appears, or the
 *  owner removes one under a register amendment) — never grow. */
const FROZEN_PRODUCERLESS = 2;

const ERRORS = "packages/contracts/src/errors.ts";

/** PURE: the declared codes, parsed from the enum literal. Separate so a synthetic corpus proves the matcher. */
export function declaredCodes(source: string): string[] {
  const block = /export const ErrorCode = z\.enum\(\[([\s\S]*?)\]\)/.exec(source);
  if (block === null) return [];
  return [...(block[1] as string).matchAll(/"([A-Z_]+)"/g)].map((m) => m[1] as string);
}

function productionSources(root: string): string[] {
  return execSync('git ls-files "packages" "workers" "apps"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.") && !f.includes("/test/") && !f.endsWith(ERRORS));
}

/** Codes no production source outside the declaration ever names. */
function producerless(root: string): string[] {
  const codes = declaredCodes(readFileSync(`${root}/${ERRORS}`, "utf8"));
  const texts = productionSources(root).map((f) => readFileSync(`${root}/${f}`, "utf8"));
  return codes.filter((c) => !texts.some((t) => t.includes(c)));
}

describe("§1695 REQ-118: the error vocabulary is walked, so a dead code cannot hide", () => {
  const root = repoRoot();

  it("parses the enum, and ignores prose around it (positive control)", () => {
    // A matcher that returned [] would report ZERO producerless codes over ZERO codes — the §1387 shape where
    // green means "found none". This pins that the parser reads the literal and nothing else.
    const synthetic = `// "NOT_A_CODE" in a comment\nexport const ErrorCode = z.enum([\n  "ALPHA",\n  "BETA",\n]);\nconst other = "GAMMA";`;
    expect(declaredCodes(synthetic)).toEqual(["ALPHA", "BETA"]);
    expect(declaredCodes("no enum here")).toEqual([]);
  });

  it("reads the real declaration and a real corpus (non-vacuity)", () => {
    // LIVE at §1695: 10 codes, 221 production sources.
    expect(declaredCodes(readFileSync(`${root}/${ERRORS}`, "utf8")).length, "the enum parsed to nothing — the declaration moved or its shape changed").toBeGreaterThanOrEqual(8);
    expect(productionSources(root).length, "almost no production sources — the glob broke, not the tree").toBeGreaterThan(150);
  });

  it("no NEW error code is declared without a producer", () => {
    const dead = producerless(root);
    expect(
      dead.length,
      `${dead.length} declared ErrorCode member(s) have NO producer anywhere in production source, frozen at ` +
        `${FROZEN_PRODUCERLESS} by §1695: ${dead.join(", ")}. The envelope is a WIRE CONTRACT (genesis/14 §46 ` +
        '— "codes are stable strings"), so a client may switch on any member; one nothing emits is a branch ' +
        "that can never execute. Either emit it, or do not declare it. The two frozen members are recorded in " +
        "GO-LIVE-CHECKLIST with the live mechanisms that superseded them; removing either is a wire-contract " +
        "change needing a register amendment, which is why this number may FALL but never grow.",
    ).toBeLessThanOrEqual(FROZEN_PRODUCERLESS);
  });
});
