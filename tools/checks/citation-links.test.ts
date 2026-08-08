import { describe, expect, it } from "vitest";
import {
  buildRepoIndex,
  checkCitations,
  collectCitations,
  suppressedLines,
  extractCitations,
  formatViolation,
  type RepoIndex,
  type CitationViolation,
  planCitationRepairs,
} from "./citation-links.js";

// A stub repo: path -> either a line COUNT (filler lines, for the bounds rules) or the actual lines
// (for the anchor rules). `checkCitations` is pure over this, so every rule below is provable
// without touching the tree.
function stubIndex(files: Record<string, number | string[]>): RepoIndex {
  const lines = new Map<string, string[]>(
    Object.entries(files).map(([p, v]) => [p, typeof v === "number" ? Array.from({ length: v }, (_, i) => `filler ${i + 1}`) : v]),
  );
  return { paths: [...lines.keys()], lines: (p) => lines.get(p) ?? null };
}

const INDEX = stubIndex({
  "workers/api/src/do/sequencer.ts": 1000,
  "workers/api/src/routes/intake.ts": 98,
  "workers/api/src/intake-core.ts": 120,
  "workers/api/src/routes/events.ts": 336,
  "packages/contracts/src/events.ts": 635,
  "packages/map/test/bearing.test.ts": 21,
  "packages/map/test/glide.test.ts": 112,
  "docs/security/threat-model.md": 60,
  "docs/security/pen-test-basics.md": 160,
  "packages/ledger/src/redact.ts": 200,
});

function one(citingFile: string, text: string) {
  return extractCitations(citingFile, text);
}

describe("citation parser: the forms this repo actually writes", () => {
  it("reads a backticked full-path range in markdown", () => {
    const [c] = one("docs/ops/NOTES.md", "see `workers/api/src/do/sequencer.ts:926-929` for the gate");
    expect(c).toMatchObject({ citingFile: "docs/ops/NOTES.md", citingLine: 1, path: "workers/api/src/do/sequencer.ts", spec: "926-929" });
  });

  it("reads an UNbackticked citation in markdown prose (the checklist writes these)", () => {
    const [c] = one("docs/ops/NOTES.md", "| Device signing root key | threat-model.md:8 | hold |");
    expect(c?.path).toBe("threat-model.md");
    expect(c?.spec).toBe("8");
  });

  it("reads a single line, a hyphen range, an en-dash range and a comma list", () => {
    const cs = one("docs/a.md", "`a.ts:12` `b.ts:12-14` `c.ts:98–124` `d.ts:60,93` `e.ts:77,88-90`");
    expect(cs.map((c) => c.spec)).toEqual(["12", "12-14", "98–124", "60,93", "77,88-90"]);
  });

  it("reports the citing line number so a reader can jump straight to it", () => {
    const cs = one("docs/a.md", ["one", "two", "see `a.ts:5`"].join("\n"));
    expect(cs[0]?.citingLine).toBe(3);
  });

  it("reads TypeScript `//` comments and jsdoc/block-comment continuation lines", () => {
    const src = ["const x = 1;", "// MUST byte-match workers/api/src/intake-core.ts:64", "/**", " * mirrors packages/contracts/src/events.ts:151-152", " */"].join("\n");
    const cs = one("workers/translator/src/core/map-204.ts", src);
    expect(cs.map((c) => `${c.path}:${c.spec}`)).toEqual(["workers/api/src/intake-core.ts:64", "packages/contracts/src/events.ts:151-152"]);
  });

  it("does NOT read TypeScript code — only comments (a string literal is not a citation)", () => {
    expect(one("tools/x.ts", `const s = "workers/api/src/do/sequencer.ts:99999";`)).toEqual([]);
  });

  it("does NOT treat a `//` INSIDE a string literal as a comment", () => {
    // The gate's first false positive was on its own test file, from exactly this shape.
    expect(one("tools/x.ts", `expect(parse("// packages/map/test/bearing.test.ts:9999")).toEqual([]);`)).toEqual([]);
  });

  it("still reads a real comment that FOLLOWS a string containing a slash", () => {
    const cs = one("tools/x.ts", `const sep = "a/b"; // see packages/map/test/bearing.test.ts:9-21`);
    expect(cs.map((c) => c.spec)).toEqual(["9-21"]);
  });
});

describe("citation parser: the false-positive shapes that would train readers to skim past this gate", () => {
  const notCitations = [
    "run the dev server on http://localhost:8787/v1/board",
    "the tile host is https://tiles.shuddl.tech:8443/x/y.png",
    "point the proxy at http://127.0.0.1:8080",
    "vite serves on localhost:4321",
    "the standup is at 12:30 and the cutoff at 09:05",
    "install pnpm@10.6.1 and node@22.15.0",
    'import { readFileSync } from "node:fs";',
    "the barrel is @shuddl/ledger and the peer is @shuddl/contracts",
    "chai is pinned to 5.3.3 for vitest-pool-workers",
    "coverage must stay 288/288 with drift exactly 8",
    "the window is 2026-07-27T14:30Z",
  ];
  for (const line of notCitations) {
    it(`ignores: ${line.slice(0, 46)}`, () => {
      expect(one("docs/a.md", line)).toEqual([]);
    });
  }

  it("ignores a requirement-id prefix, which is a colon after letters+digits, not a path", () => {
    // The literal id is assembled at runtime: a bare requirement id written into a scanned file is
    // read by the traceability scanner as an implementation annotation, and this file is scanned.
    const line = `REQ-${"061"}: gates are server-side, see the register`;
    expect(one("docs/a.md", line)).toEqual([]);
  });

  it("ignores a bare `:123` self-reference — its target is context-dependent, so it is out of scope", () => {
    expect(one("docs/a.md", "corrected in place at `:154`, `:264` and `:180`")).toEqual([]);
  });
});

describe("resolution: root, sibling, suffix and basename", () => {
  it("resolves a repo-root path and passes an in-bounds citation", () => {
    expect(checkCitations(one("docs/a.md", "`workers/api/src/do/sequencer.ts:926-929`"), INDEX)).toEqual([]);
  });

  it("resolves a bare basename against the citing file's own directory first", () => {
    expect(checkCitations(one("docs/security/pen-test-basics.md", "see threat-model.md:37"), INDEX)).toEqual([]);
  });

  it("resolves a PARTIAL path by unique suffix match (`contracts/src/events.ts`)", () => {
    expect(checkCitations(one("packages/ledger/src/x.ts", "// contracts/src/events.ts:600"), INDEX)).toEqual([]);
  });

  it("flags a path that resolves nowhere in the repo", () => {
    const v = checkCitations(one("docs/ops/GO-LIVE.md", "`workers/api/src/internal-platform.ts:82`"), INDEX);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/no such file/i);
  });

  it("flags a docs path that does not exist even though a same-named file exists elsewhere", () => {
    const v = checkCitations(one("docs/ops/GO-LIVE.md", "`docs/ops/threat-model.md:37`"), INDEX);
    expect(v).toHaveLength(1);
    expect(v[0]?.citedPath).toBe("docs/ops/threat-model.md");
  });
});

describe("bounds: the check the path-only link-check could not make", () => {
  it("flags a single line past the end of the file", () => {
    const v = checkCitations(one("docs/a.md", "`packages/map/test/bearing.test.ts:27`"), INDEX);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/21 lines/);
  });

  it("flags a range whose END is past the file, even when the start is in bounds", () => {
    const v = checkCitations(one("docs/security/pen-test-basics.md", "`packages/map/test/bearing.test.ts:19-41`"), INDEX);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/21 lines/);
  });

  it("flags the last entry of a comma list when it is past the end", () => {
    const v = checkCitations(one("docs/a.md", "`packages/map/test/bearing.test.ts:12,19,44`"), INDEX);
    expect(v).toHaveLength(1);
  });

  it("passes a citation that ends exactly on the last line (off-by-one guard)", () => {
    expect(checkCitations(one("docs/a.md", "`packages/map/test/bearing.test.ts:9-21`"), INDEX)).toEqual([]);
  });

  it("flags line 0 and an inverted range — neither can be a real target", () => {
    const v = checkCitations(one("docs/a.md", "`packages/map/test/glide.test.ts:0` and `packages/map/test/glide.test.ts:40-12`"), INDEX);
    expect(v).toHaveLength(2);
    expect(v[0]?.reason).toMatch(/line 0/i);
    expect(v[1]?.reason).toMatch(/inverted/i);
  });
});

describe("ambiguity is never reported as a defect unless EVERY candidate fails", () => {
  it("an ambiguous basename with one viable candidate is silent (no cry-wolf)", () => {
    // `events.ts` is two files (336 and 635 lines); :600 only fits one, and that is enough.
    expect(checkCitations(one("docs/a.md", "`events.ts:600`"), INDEX)).toEqual([]);
  });

  it("an ambiguous basename where EVERY candidate is too short IS a defect", () => {
    const v = checkCitations(one("docs/a.md", "`events.ts:9000`"), INDEX);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/candidate/i);
  });
});

describe("the escape hatch and the output contract", () => {
  it("honours a line-local `citation-check: ignore` marker", () => {
    const line = "`packages/map/test/bearing.test.ts:27-41` <!-- citation-check: ignore -->";
    expect(checkCitations(one("docs/a.md", line), INDEX)).toEqual([]);
  });

  it("skips a `~~struck~~` markdown citation (a superseded record stays in place, per the convention)", () => {
    const line = "| ~~`packages/map/test/bearing.test.ts:27-41`~~ **corrected: `packages/map/test/bearing.test.ts:9-21`** |";
    expect(checkCitations(one("docs/a.md", line), INDEX)).toEqual([]);
  });

  it("still checks the CORRECTION beside a struck citation — the exemption is not a blanket line skip", () => {
    const line = "| ~~`packages/map/test/bearing.test.ts:27-41`~~ **corrected: `packages/map/test/bearing.test.ts:9-99`** |";
    const v = checkCitations(one("docs/a.md", line), INDEX);
    expect(v).toHaveLength(1);
    expect(v[0]?.citedSpec).toBe("9-99");
  });

  it("does NOT apply the strikethrough exemption to TypeScript comments", () => {
    const v = checkCitations(one("tools/x.ts", "// ~~packages/map/test/bearing.test.ts:27-41~~ moved"), INDEX);
    expect(v).toHaveLength(1);
  });

  it("formats a violation as `citing:line → cited:line — reason`", () => {
    const [v] = checkCitations(one("docs/a.md", "`packages/map/test/bearing.test.ts:27-41`"), INDEX);
    expect(formatViolation(v!)).toMatch(/^docs\/a\.md:1 → packages\/map\/test\/bearing\.test\.ts:27-41 — /);
  });
});

// ---------------------------------------------------------------------------------------------
// Content anchors: the OPT-IN `path:line@symbol` form. This is the only rule that can see the
// defect class where the line still exists and the content moved out from under it.
// ---------------------------------------------------------------------------------------------

const ANCHORED = stubIndex({
  "packages/ledger/src/anchor.ts": [
    "line 1", "line 2", "line 3", "line 4", "line 5",
    "async function recordAnchorFailure(", // 6
    "line 7", "line 8", "line 9", "line 10",
    "  await clearAnchorFailures(db, tenant, day);", // 11
    "line 12", "line 13", "line 14", "line 15",
  ],
  "docs/x.md": ["a", "b", "c", "d", "e", "f", "g", "h"],
});

describe("content anchors: `path:line@symbol` (opt-in)", () => {
  it("parses the anchor off a single line and off a range", () => {
    const cs = one("docs/a.md", "`packages/ledger/src/anchor.ts:6@recordAnchorFailure` and `packages/ledger/src/anchor.ts:6-11@clearAnchorFailures`");
    expect(cs.map((c) => [c.spec, c.symbol])).toEqual([
      ["6", "recordAnchorFailure"],
      ["6-11", "clearAnchorFailures"],
    ]);
  });

  it("an UNanchored citation carries no symbol — the 492 existing ones must not change meaning", () => {
    expect(one("docs/a.md", "`packages/ledger/src/anchor.ts:6`")[0]?.symbol).toBeUndefined();
  });

  it("accepts a symbol containing `:`, `(`, `.`, `-`, `_` — the corpus is full of them", () => {
    const cs = one("tools/x.ts", "// see `workers/api/src/intake-core.ts:64@intake:party:name:` and a.md:1@foo.bar-baz_qux(");
    expect(cs.map((c) => c.symbol)).toEqual(["intake:party:name:", "foo.bar-baz_qux("]);
  });

  it("passes when the symbol is ON the cited line", () => {
    expect(checkCitations(one("docs/a.md", "`packages/ledger/src/anchor.ts:6@recordAnchorFailure`"), ANCHORED)).toEqual([]);
  });

  it("passes within the ±2 tolerance (the target drifted by one line)", () => {
    expect(checkCitations(one("docs/a.md", "`packages/ledger/src/anchor.ts:4@recordAnchorFailure`"), ANCHORED)).toEqual([]);
    expect(checkCitations(one("docs/a.md", "`packages/ledger/src/anchor.ts:8@recordAnchorFailure`"), ANCHORED)).toEqual([]);
  });

  it("FAILS just outside the tolerance — this is the drift the gate exists to catch", () => {
    const v = checkCitations(one("docs/a.md", "`packages/ledger/src/anchor.ts:3@recordAnchorFailure`"), ANCHORED);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/not found in lines 1-5/);
  });

  it("tells the reader WHERE the symbol actually is, so the fix needs no file opened", () => {
    const [v] = checkCitations(one("docs/a.md", "`packages/ledger/src/anchor.ts:14@recordAnchorFailure`"), ANCHORED);
    expect(v?.reason).toMatch(/it IS at :6/);
    expect(v?.reason).toMatch(/repoint/);
  });

  it("says so plainly when the symbol is nowhere in the file (a wrong anchor, not a moved one)", () => {
    const [v] = checkCitations(one("docs/a.md", "`packages/ledger/src/anchor.ts:6@noSuchSymbol`"), ANCHORED);
    expect(v?.reason).toMatch(/appears nowhere in/);
  });

  it("widens the window at BOTH ends of a range, not just the start", () => {
    expect(checkCitations(one("docs/a.md", "`packages/ledger/src/anchor.ts:1-4@recordAnchorFailure`"), ANCHORED)).toEqual([]);
    expect(checkCitations(one("docs/a.md", "`packages/ledger/src/anchor.ts:8-15@recordAnchorFailure`"), ANCHORED)).toEqual([]);
    expect(checkCitations(one("docs/a.md", "`packages/ledger/src/anchor.ts:9-15@recordAnchorFailure`"), ANCHORED)).toHaveLength(1);
  });

  it("is a literal substring, not a regex — a symbol with `(` matches literally and never explodes", () => {
    expect(checkCitations(one("docs/a.md", "`packages/ledger/src/anchor.ts:6@recordAnchorFailure(`"), ANCHORED)).toEqual([]);
    expect(checkCitations(one("docs/a.md", "`packages/ledger/src/anchor.ts:6@record.*Failure`"), ANCHORED)).toHaveLength(1);
  });

  it("is case-sensitive — these are code identifiers", () => {
    expect(checkCitations(one("docs/a.md", "`packages/ledger/src/anchor.ts:6@recordanchorfailure`"), ANCHORED)).toHaveLength(1);
  });

  it("checks BOUNDS before the anchor — an out-of-range line reports the bound, not the symbol", () => {
    const [v] = checkCitations(one("docs/a.md", "`packages/ledger/src/anchor.ts:99@recordAnchorFailure`"), ANCHORED);
    expect(v?.reason).toMatch(/15 lines/);
  });

  it("with an ambiguous path, one candidate satisfying the anchor is enough", () => {
    const amb = stubIndex({
      "a/dup.ts": ["nope", "nope", "nope"],
      "b/dup.ts": ["nope", "recordAnchorFailure", "nope"],
    });
    expect(checkCitations(one("docs/a.md", "`dup.ts:2@recordAnchorFailure`"), amb)).toEqual([]);
    expect(checkCitations(one("docs/a.md", "`dup.ts:2@absent`"), amb)).toHaveLength(1);
  });

  it("puts the symbol in the formatted output so the violation is self-explaining", () => {
    const [v] = checkCitations(one("docs/a.md", "`packages/ledger/src/anchor.ts:14@recordAnchorFailure`"), ANCHORED);
    expect(formatViolation(v!)).toMatch(/^docs\/a\.md:1 → packages\/ledger\/src\/anchor\.ts:14@recordAnchorFailure — /);
  });
});

describe("KNOWN LIMITATION, pinned so nobody claims more than this gate delivers", () => {
  it("does NOT catch an in-bounds citation that points at the wrong content — UNLESS it is anchored", () => {
    // The historical sequencer defect: the cited range exists, it just names the booking gate instead
    // of the ratecon deferral. Bounds cannot see that. An anchor can, and that is the whole point of
    // the opt-in form above — so the limitation now has an escape, one citation at a time.
    expect(checkCitations(one("docs/a.md", "`workers/api/src/do/sequencer.ts:700-708`"), INDEX)).toEqual([]);
  });
});

describe("the real tree stays clean (this is the regression lock, not a sample)", () => {
  it("every citation in every tracked markdown file and TypeScript comment resolves and is in bounds", () => {
    const index = buildRepoIndex();
    const violations = checkCitations(collectCitations(), index);
    expect(violations.map(formatViolation)).toEqual([]);
  });
});

// audit §272 — `citation-check: ignore` makes the scanner skip a line SILENTLY. It is the one way this gate
// can be weakened without failing, so the corpus count is pinned: the first real suppression must be a
// deliberate act that shows up here, not a comment nobody notices.
describe("§272: the citation escape hatch is bounded", () => {
  it("no tracked file outside the scanner's own tree suppresses a citation", () => {
    expect(
      suppressedLines(),
      "a `citation-check: ignore` retires a citation with no gate failure — justify it here, or fix the citation",
    ).toEqual([]);
  });
});

// AUDIT §487 — this gate reported a clean bill over an EMPTY corpus.
//
// `git ls-files` is CWD-relative, and every entry point here took a `cwd` that silently doubled as a
// SCOPE. Run from `tools/checks/` the gate printed `citation-links OK — 0 path:line citations resolve to a
// real file and an in-bounds line` — in the gate whose entire job is keeping the record's addresses honest,
// and which had caught four rotted citations that same session. It then exited 1, but from an unhandled
// ENOENT on the ratchet config resolved against the same wrong directory: a CRASH, not a verdict, which is
// what made the vacuous OK above it survivable.
//
// These pin the CAUSE — the corpus does not depend on where you stand. The `main()` floor is the backstop
// for any other way the corpus could empty out; this is the property that makes the backstop unnecessary.
describe("REQ-118 §487: the citation corpus does not depend on the caller's directory", () => {
  const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

  it("collectCitations finds the same corpus from a subdirectory as from the root", () => {
    const fromRoot = collectCitations(REPO);
    const fromSubdir = collectCitations(`${REPO}/tools/checks`);
    expect(fromSubdir.length, "cwd must not narrow the scan — this is the §487 defect").toBe(fromRoot.length);
    expect(fromRoot.length, "and the corpus is non-empty, or the assertion above is vacuous").toBeGreaterThan(500);
  });

  it("buildRepoIndex resolves the same universe, and can still READ what it lists", () => {
    // Listing and reading must share ONE root: rooting the list while reading against `cwd` would resolve
    // every path wrongly off-root, turning the vacuity defect into a mass false-positive instead.
    const idx = buildRepoIndex(`${REPO}/tools/checks`);
    expect(idx.paths.length).toBe(buildRepoIndex(REPO).paths.length);
    expect(idx.lines("package.json"), "a listed path must be readable through the same root").not.toBeNull();
  });

  it("suppressedLines is rooted too — the escape hatch cannot be hidden by cwd", () => {
    // If this scan narrowed, a suppressed line would silently drop out of the count the OK line reports,
    // which is the one number proving the `citation-check: ignore` hatch is unused.
    expect(suppressedLines(`${REPO}/tools/checks`)).toEqual(suppressedLines(REPO));
  });
});

// REQ-118 §733 — THE REPAIR PLANNER. Every assertion here is about what it REFUSES.
//
// §732 shifted `invariants.ts` by 25 lines and rotted 8 citations across five files — the third documented
// recurrence for that one file (§175, §253, §732). The repair is mechanical, and my HAND repair still failed
// twice: once matching only the rooted path form, once taking the line from the first MENTION rather than the
// declaration. So it belongs in code — and the danger of putting it in code is that a wrong repair is silent,
// because the gate goes green over a false address. Hence: derive only when unambiguous, refuse otherwise.
describe("REQ-118 §733: planCitationRepairs derives a line, or refuses", () => {
  const index: RepoIndex = {
    paths: ["t.ts"],
    lines: (p) => (p === "t.ts" ? ["a", "const TARGET = 1;", "b", "// TARGET again", "c"] : null),
  };
  const v = (over: Partial<CitationViolation>): CitationViolation => ({
    citingFile: "d.md", citingLine: 3, citedPath: "t.ts", citedSpec: "1", citedSymbol: "TARGET", reason: "rot", ...over,
  });

  it("repairs a single-line anchored citation to the anchor's actual line", () => {
    const uniq: RepoIndex = { paths: ["t.ts"], lines: () => ["a", "const TARGET = 1;", "b"] };
    const { repairs, refusals } = planCitationRepairs([v({})], uniq);
    expect(refusals).toEqual([]);
    expect(repairs).toEqual([{ citingFile: "d.md", citingLine: 3, from: "t.ts:1@TARGET", to: "t.ts:2@TARGET" }]);
  });

  it("a symbol at its declaration AND its uses resolves to the DECLARATION", () => {
    // `TARGET` hits lines 2 and 4 (`const TARGET = 1;` and a comment mentioning it). Multiple hits are the
    // NORMAL case — the first build of this planner refused them and therefore repaired 0 of 15 on the real
    // rot it was built for. A declaration is a qualitatively different hit from a use, so one declaration
    // among the hits leaves no guess to make.
    const { repairs, refusals } = planCitationRepairs([v({})], index);
    expect(refusals).toEqual([]);
    expect(repairs[0]?.to).toBe("t.ts:2@TARGET");
  });

  it("REFUSES when SEVERAL hits look like declarations", () => {
    const two: RepoIndex = { paths: ["t.ts"], lines: () => ["const TARGET = 1;", "x", "let TARGET = 2;"] };
    const { repairs, refusals } = planCitationRepairs([v({})], two);
    expect(repairs).toEqual([]);
    expect(refusals[0]?.reason).toMatch(/AMBIGUOUS/);
  });

  it("REFUSES when NO hit looks like a declaration — an anchor may be arbitrary text", () => {
    // The anchor contract is "a literal substring near the cited line", not "a symbol". Prose anchors get
    // no declaration to prefer, so multiple hits stay a human's call.
    const prose: RepoIndex = { paths: ["t.ts"], lines: () => ["// TARGET here", "x", "// TARGET there"] };
    const { repairs, refusals } = planCitationRepairs([v({})], prose);
    expect(repairs).toEqual([]);
    expect(refusals[0]?.reason).toMatch(/AMBIGUOUS/);
  });

  it("REFUSES a cited path that resolves to more than one file", () => {
    const dup: RepoIndex = { paths: ["a/t.ts", "b/t.ts"], lines: () => ["const TARGET = 1;"] };
    const { repairs, refusals } = planCitationRepairs([v({})], dup);
    expect(repairs).toEqual([]);
    expect(refusals[0]?.reason).toMatch(/ambiguous across/);
  });

  it("REFUSES an unanchored citation — there is no ground truth to derive from", () => {
    // Built without the key rather than with `citedSymbol: undefined` — `exactOptionalPropertyTypes` is on,
    // and an absent anchor is genuinely a different thing from one set to undefined.
    const unanchored: CitationViolation = { citingFile: "d.md", citingLine: 3, citedPath: "t.ts", citedSpec: "1", reason: "rot" };
    const { repairs, refusals } = planCitationRepairs([unanchored], index);
    expect(repairs).toEqual([]);
    expect(refusals[0]?.reason).toMatch(/unanchored/);
  });

  it("REFUSES a multi-line spec — one symbol cannot determine a span", () => {
    const uniq: RepoIndex = { paths: ["t.ts"], lines: () => ["a", "const TARGET = 1;", "b"] };
    const { repairs, refusals } = planCitationRepairs([v({ citedSpec: "1-4" })], uniq);
    expect(repairs).toEqual([]);
    expect(refusals[0]?.reason).toMatch(/multi-line/);
  });

  it("REFUSES a vanished anchor — repointing would invent an address", () => {
    const uniq: RepoIndex = { paths: ["t.ts"], lines: () => ["a", "b", "c"] };
    const { repairs, refusals } = planCitationRepairs([v({})], uniq);
    expect(repairs).toEqual([]);
    expect(refusals[0]?.reason).toMatch(/appears nowhere/);
  });

  it("REFUSES an unresolvable target — a move is a human decision, not a line shift", () => {
    const { repairs, refusals } = planCitationRepairs([v({ citedPath: "gone.ts" })], index);
    expect(repairs).toEqual([]);
    expect(refusals[0]?.reason).toMatch(/does not resolve/);
  });
});

