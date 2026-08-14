import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { CANONICAL_DOC, definedSections, findDanglingSectionRefs, loadDocs } from "./section-refs.js";
import { repoRoot } from "./repo-root.js";

// REQ-118 (audit §508/§509). `check:citations` bounds-checks `path:line`; NOTHING checked `§N`, and the
// audit record runs on §N — 5,197 of them. §508 measured what that permitted: §38 and §58 were each
// referenced ELEVEN TIMES as sections with content, and neither number was ever written.
//
// §508 fixed the instances. This gate is the mechanism, because fixing instances without the mechanism is
// how §489 arrived at instance #5 of one convention defect.
//
// The two tests that matter most here are the FALSE-POSITIVE ones. The first version of the §508 sweep
// reported 202 broken references; 199 of them were my classifier, not the record. A gate that cries wolf
// over `genesis/00 §01` gets disabled in a week, so both bugs are pinned as behaviour rather than fixed and
// forgotten.

describe("REQ-118 §509: §N references resolve", () => {
  it("the real corpus is clean", () => {
    const docs = loadDocs();
    expect(docs.length, "no markdown found — the scan is broken, not the tree").toBeGreaterThan(50);
    const canonical = definedSections(docs.find((d) => d.path === CANONICAL_DOC)?.text ?? "");
    expect(canonical.size, "the canonical namespace must resolve to the audit's sections").toBeGreaterThan(100);
    expect(findDanglingSectionRefs(docs, canonical)).toEqual([]);
  });

  it("§1415: the corpus includes the non-.ts text files that carry §N pointers", () => {
    // A COUNT floor cannot catch this. The gate already asserted `docs.length > 50` and passed for months
    // while reading none of the 74 `§N` pointers in `eslint.config.mjs` — the largest concentration outside
    // the audit. §1387's rule: floor the INPUT, and name the thing that must be in it. These three are named
    // individually because each is a different extension family, and losing any one is a silent narrowing.
    const paths = new Set(loadDocs().map((d) => d.path));
    for (const f of ["eslint.config.mjs", "genesis/09-REQUIREMENTS-REGISTER.csv", ".github/workflows/ci.yml"]) {
      expect(paths.has(f), `${f} carries §N references and is no longer in the corpus — the glob narrowed`).toBe(true);
    }
    expect(paths.size, "the corpus collapsed — a narrowed glob reports clean").toBeGreaterThan(900);
  });

  it("catches a reference to a section that does not exist", () => {
    const docs = [{ path: "d.md", text: "as §12 shows, and §999 also" }];
    const found = findDanglingSectionRefs(docs, new Set(["12"]));
    expect(found).toHaveLength(1);
    expect(found[0]?.ref).toBe("§999");
    expect(found[0]?.line).toBe(1);
  });

  // FALSE POSITIVE #1 — the genesis namespace. `genesis/00 §01` is a DIFFERENT numbering, used correctly by
  // CLAUDE.md and BUILD-PROMPT.md. The zero-padding is the discriminator, and it is the whole reason those
  // files do not fail this gate.
  it("IGNORES the zero-padded genesis namespace (§01–§08)", () => {
    const docs = [{ path: "CLAUDE.md", text: "the Ten Laws in `genesis/00` §01 and doc 13 §01, plus §08" }];
    expect(findDanglingSectionRefs(docs, new Set())).toEqual([]);
  });

  // FALSE POSITIVE #2 — heading level. Fifteen audit sections are `###`, not `##`. A collector keyed on
  // `^## §N` reads every reference to one as dangling, which is 199 of the 202 hits the first sweep produced.
  it("collects sections at ANY heading level, not just ##", () => {
    const text = "## §1 — a\n### §2 — b\n#### §3 — c\n";
    expect([...definedSections(text)].sort()).toEqual(["1", "2", "3"]);
  });

  // A document that defines its own §N owns its namespace and resolves against itself first.
  it("a doc with its OWN section headings resolves against itself", () => {
    const docs = [{ path: "plan.md", text: "## §7 — local\nsee §7 for the plan" }];
    expect(findDanglingSectionRefs(docs, new Set()), "§7 is defined in this very document").toEqual([]);
  });

  it("a landing stub satisfies the gate — the §508 remedy is a legitimate fix", () => {
    // §38/§58 are stubs stating no section was written. That is deliberately ENOUGH: the point is that a
    // pointer lands on an explanation, not that every number carries findings.
    const docs = [{ path: "a.md", text: "### §38 — (number unused)\nsee §38" }];
    expect(findDanglingSectionRefs(docs, new Set())).toEqual([]);
  });
});

// REQ-118 §510 — NO TRACKED TEXT FILE CONTAINS A NUL BYTE.
//
// Found by accident: a commit touching `gate-wiring.test.ts` reported `Bin 6065 -> 6159 bytes`. A
// TypeScript file was BINARY to git — it had carried four NUL bytes, each sitting exactly where a space
// belongs inside a template literal (`${name}\0${cmd}`), for as long as it had existed.
//
// Nothing caught it, and nothing could: the file compiled, linted, and its 5 tests passed, because a NUL
// inside a template literal is a legal character. The damage is to REVIEW — git renders every change to a
// binary file as `Bin X -> Y bytes` with no diff, so that file's changes were unreadable in every PR and
// every `git show`. A gate this repo relies on was the one file nobody could review.
//
// This lives here rather than in a new gate script deliberately: `tools/**/*.test.ts` is already in the
// merge profile via `test`, so the check runs without a new script, a new profile entry, or another round
// of count-pinning doc updates (§483/§509). The lightest correct wiring is the existing one.
describe("REQ-118 §510: no tracked text file is binary to git", () => {
  it("zero NUL bytes across every tracked text file", () => {
    // `repoRoot()` spawns `git rev-parse`; resolving it ONCE rather than per file took this from 8s
    // (878 subprocesses, a 5s timeout failure that looked like a finding) to milliseconds.
    const root = repoRoot();
    const files = execSync("git ls-files", { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean);
    const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|sql|yml|yaml|css|html|csv|txt|sh)$/;
    const text = files.filter((f) => TEXT.test(f));
    // Non-vacuity: a broken `git ls-files` or wrong root would scan nothing and pass (§487).
    expect(text.length, "no tracked text files found — the scan is broken, not the tree").toBeGreaterThan(100);
    const offenders = text.filter((f) => readFileSync(`${root}/${f}`).includes(0));
    expect(offenders, `NUL byte(s) make these files BINARY to git — every diff renders as "Bin X -> Y":\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  // TROJAN SOURCE (CVE-2021-42574) — the same family as the NUL, one step more serious.
  //
  // Bidirectional overrides and isolates (U+202A–U+202E, U+2066–U+2069) reorder how source RENDERS without
  // changing what the compiler reads, so a reviewer and the toolchain can see different programs. §510's NUL
  // made a file unreviewable by accident; this makes one deliberately misleading, and it is a published
  // supply-chain attack rather than a hypothetical.
  //
  // MEASURED CLEAN when this landed (0 of 878 files), so this locks in a good state rather than fixing a
  // defect — the cheap half of §486's rule: not worth a test when a guarantee is structural, worth one when
  // the guarantee is "nobody has done it yet".
  it("no bidirectional Unicode control characters (Trojan Source)", () => {
    const root = repoRoot();
    const files = execSync("git ls-files", { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean);
    const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|sql|yml|yaml|css|html|csv|txt|sh)$/;
    const text = files.filter((f) => TEXT.test(f));
    expect(text.length, "the scan is broken, not the tree").toBeGreaterThan(100);
    const BIDI = /[\u202A-\u202E\u2066-\u2069]/;
    const offenders = text.filter((f) => BIDI.test(readFileSync(`${root}/${f}`, "utf8")));
    expect(
      offenders,
      `bidi control character(s) — source that RENDERS differently than it compiles (CVE-2021-42574):\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
