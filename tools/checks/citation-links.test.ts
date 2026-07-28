import { describe, expect, it } from "vitest";
import {
  buildRepoIndex,
  checkCitations,
  collectCitations,
  extractCitations,
  formatViolation,
  type RepoIndex,
} from "./citation-links.js";

// A stub repo: path -> line count. `checkCitations` is pure over this, so every resolution and
// bounds rule below is provable without touching the tree.
function stubIndex(files: Record<string, number>): RepoIndex {
  return { paths: Object.keys(files), lineCount: (p) => files[p] ?? null };
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

describe("KNOWN LIMITATION, pinned so nobody claims more than this gate delivers", () => {
  it("does NOT catch an in-bounds citation that points at the wrong content", () => {
    // The historical sequencer defect: the cited range exists, it just names the booking gate instead
    // of the ratecon deferral. Only a content anchor could see that; line existence cannot.
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
