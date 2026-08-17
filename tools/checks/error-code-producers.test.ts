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
// WHY THIS VOCABULARY AND NOT THE OTHER ONE (§1695's actual finding, CORRECTED at §1723). The 35
// `EVENT_KINDS` have the same shape — a frozen declared vocabulary. §1695 wrote that "four of them likewise
// have no producer" and named them. **That number is not reproducible by the method this file defines, and
// §1723 measured it: running the producer scan below over EVENT_KINDS finds ZERO.** All 35 are credited,
// because the taxonomy is ITERATED — `visibility.ts`, `lens.ts` and the three projections name every member,
// so a text scan sees each one whether or not anything emits it.
//
// The correction makes the argument STRONGER, not weaker. Seven kinds genuinely lack an emitter — that is
// GO-LIVE-CHECKLIST's own row, derived at §418 and re-derived at §1143 against the **append-seam** corpus
// rather than by text, precisely because text cannot answer this question for a walked vocabulary. §1695
// quoted a subset of that row's list as if this file's scan had produced it. It had not.
//
//   The error enum is iterated at ZERO sites — only ever referenced one member at a time — which is exactly
//   how two dead codes sat in a wire contract unremarked. The event taxonomy is walked at 14, which is why
//   the same scan is blind there and why finding ITS dead members needed a different instrument.
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

/**
 * §1696 — THE SAME WALK, OVER EVERY DECLARED VOCABULARY.
 *
 * §1695's rule generalised, then measured: nine contracts vocabularies carry three or more members, and
 * exactly TWO are never iterated — `ErrorCode` (0 walk sites) and `AuthorityFlipReason` (0). The rule predicts
 * dead members there, and it was right ONCE: ErrorCode has two, AuthorityFlipReason has none (all three of
 * `promote`/`drift`/`manual` are emitted at real `authority.flipped` construction sites). **Being unwalked is
 * a RISK FACTOR, not a diagnosis** — which is why this is a ratchet over the whole class rather than a claim
 * about any one enum.
 *
 * WHAT IT CANNOT SEE, stated because the limit is real: a producer is detected by the member string appearing
 * in a production source, so a member whose name is a COMMON WORD is credited by any unrelated use. Measured
 * at §1696: `AuthorityFlipReason.manual` showed four "producers", three of which were
 * `method: "manual"` on `dims.captured`. The count therefore UNDER-reports dead members and never
 * over-reports — safe for a ratchet, useless as a census.
 */
const VOCABULARIES: ReadonlyArray<{ file: string; name: string }> = [
  { file: "packages/contracts/src/errors.ts", name: "ErrorCode" },
  { file: "packages/contracts/src/authority.ts", name: "AuthorityFlipReason" },
];

/** PURE: members of a `z.enum([...])` declaration by name. */
export function enumMembers(source: string, name: string): string[] {
  const m = new RegExp(`export const ${name} = z\\.enum\\(\\[([^\\]]*)\\]\\)`, "s").exec(source);
  return m === null ? [] : [...(m[1] as string).matchAll(/"([^"]+)"/g)].map((x) => x[1] as string);
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

  it("§1696 no NEW producerless member in ANY unwalked vocabulary", () => {
    // The corpus is built ONCE. The first cut called productionSources() inside the member loop, re-spawning
    // `git ls-files` per member — 39 seconds, and an index-based filter that no longer lined up with its list.
    const files = productionSources(root);
    const texts = files.map((f) => [f, readFileSync(`${root}/${f}`, "utf8")] as const);
    const dead: string[] = [];
    for (const v of VOCABULARIES) {
      const members = enumMembers(readFileSync(`${root}/${v.file}`, "utf8"), v.name);
      expect(members.length, `${v.name} parsed to nothing — the declaration moved or changed shape`).toBeGreaterThanOrEqual(3);
      const others = texts.filter(([f]) => !f.endsWith(v.file)).map(([, t]) => t);
      for (const m of members) {
        if (!others.some((t) => t.includes(`"${m}"`))) dead.push(`${v.name}.${m}`);
      }
    }
    expect(
      dead.length,
      `${dead.length} member(s) of an UNWALKED vocabulary have no producer, frozen at ${FROZEN_PRODUCERLESS} ` +
        `by §1696: ${dead.join(", ")}. Nine contracts vocabularies carry 3+ members and only these two are ` +
        "never iterated; a walked vocabulary cannot hide a dead member because every member gets touched. " +
        "Emit it, or do not declare it.",
    ).toBeLessThanOrEqual(FROZEN_PRODUCERLESS);
  });

  // §1723 — THE CORRECTION, ASSERTED SO IT CANNOT ROT BACK INTO PROSE.
  //
  // This pins the measurement that corrected §1695's comment: the producer scan finds ZERO dead EVENT_KINDS.
  // It is not a freeze for its own sake — it is meaningful in the direction it can break. A kind added to the
  // taxonomy but NOT added to `visibility.ts` / `lens.ts` / the projections would be the first member this
  // scan fails to credit, and that is a real defect (the projections would silently not handle it), not a
  // bookkeeping change. So a non-zero here is a signal to read, and the message says which.
  it("§1723 the WALKED taxonomy credits every member — so this scan is blind there, by construction", () => {
    // EVENT_KINDS is a plain `as const` array, not a `z.enum([...])`, so `enumMembers` does not fit it —
    // parsed here rather than widening that helper, whose subject is the zod vocabularies.
    const src = readFileSync(`${root}/packages/contracts/src/events.ts`, "utf8");
    const block = /export const EVENT_KINDS = \[([\s\S]*?)\]/.exec(src);
    const kinds = [...(block?.[1] ?? "").matchAll(/"([a-z_.]+)"/g)].map((m) => m[1] as string);
    expect(kinds.length, "EVENT_KINDS parsed to nothing — the declaration moved or changed shape").toBe(35);
    const texts = productionSources(root)
      .filter((f) => f !== "packages/contracts/src/events.ts")
      .map((f) => readFileSync(`${root}/${f}`, "utf8"));
    const uncredited = kinds.filter((k) => !texts.some((t) => t.includes(`"${k}"`)));
    expect(
      uncredited,
      `${uncredited.join(", ")} — a declared event kind that NO production source names. Every one of the 35 ` +
        "is named today because the taxonomy is walked (visibility, lens, the three projections). A member " +
        "that is not is a kind the projections will silently not handle, which is why this reads as zero and " +
        "why a non-zero is worth stopping for. NOTE what this does NOT say: seven kinds have no EMITTER " +
        "(GO-LIVE-CHECKLIST, derived against the append-seam corpus). A text scan cannot see that, and " +
        "§1695's comment briefly claimed otherwise.",
    ).toEqual([]);
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

  // §1724 — THE DOC IS AN INPUT, NOT A NEIGHBOUR (`unbounded-reads-roster.test.ts:86@ROSTER`, §823/§1019).
  //
  // Bound by IDENTITY rather than by count, and the row is why: it says "**Two** ErrorCode members…" — a
  // WORD, so a digit match would fail on arrival and a word match would pin the spelling instead of the
  // subject. Naming the members is the stronger binding anyway: it fails if either is removed, if a third is
  // added, or if the row is rewritten about different codes — none of which a "2" would notice.
  it("§1724 the checklist names the same producerless members this gate freezes (doc and code agree)", () => {
    const doc = readFileSync(`${repoRoot()}/docs/ops/GO-LIVE-CHECKLIST.md`, "utf8");
    const row = doc.split("\n").find((l) => l.includes("ErrorCode members have ZERO producers"));
    expect(row, "the checklist no longer files the producerless-ErrorCode hold — restore it or retire this gate").toBeDefined();
    const named = producerless(repoRoot());
    expect(named.length, "the live producerless set moved — this gate's own ratchet should have caught it first").toBe(FROZEN_PRODUCERLESS);
    for (const code of named) {
      expect(
        row,
        `the checklist row does not name ${code}, which this gate freezes as producerless. The row is the ` +
          "only place a reader learns WHICH codes a client must not switch on; a count alone does not say.",
      ).toContain(code);
    }
  });
});
