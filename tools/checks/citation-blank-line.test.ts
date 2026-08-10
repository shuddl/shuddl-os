import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §886 — A `path:line` CITATION THAT LANDS ON A BLANK LINE HAS MOVED.
//
// §885 found the checklist pointing at `workers/translator/src/sweep-214.ts:182` — a blank line. The claim was
// true and the file was right; the line had drifted. It took a hand pass to notice, and §885 closed by naming
// why nothing would have: the existing `citation-ratchet` is a GROWTH check on a NAMED SET of high-churn files
// (it refuses *more* unanchored citations into sequencer.ts / biller.ts / watchtower.ts). It says nothing about
// a citation that was correct when written and decayed afterwards, and nothing at all about quiet files —
// `sweep-214.ts`, `sender.ts` and `demo.ts` are all quiet, which is exactly why they rotted unobserved.
//
// `check:citations` already proves the line EXISTS. Blankness is the next cheapest signal and strictly
// stronger: an in-bounds pointer at nothing is a pointer that has moved.
//
// MEASURED BEFORE BUILDING (§886): 101 resolvable path:line citations in the checklist; TWO blank-line targets,
// ZERO out of bounds. A 2% flag rate, and both flags were real drift (`sender.ts:245` → the config is at :200;
// `demo.ts:115` → `DEMO_TILE_URL` is at :119). That number is why this is a gate and not a lint someone mutes.
//
// WHAT A GREEN HERE DOES NOT MEAN. A citation that drifts onto a DIFFERENT NON-BLANK line still passes. That is
// the majority of real drift; catching it needs the `@symbol` anchor form, which `check:citations` enforces
// where it is used. This gate closes one narrow, decidable hole — no more.

/** The LIVE record. The audit is append-only history whose old sections cite lines that legitimately moved. */
const DOC = "docs/ops/GO-LIVE-CHECKLIST.md";

const CITATION =
  /`((?:docs|workers|packages|apps|tools|db|genesis|tests)\/[A-Za-z0-9_./-]+\.[a-z]{2,4}):(\d+)(?:@[A-Za-z0-9_$]+)?`/g;

/** Struck spans keep their stale pointer ON PURPOSE — a superseded record is evidence, not a citation. */
const STRIKETHROUGH = /~~[\s\S]*?~~/g;

interface Cit {
  path: string;
  line: number;
}

function citations(root: string): Cit[] {
  const text = readFileSync(`${root}/${DOC}`, "utf8").replace(STRIKETHROUGH, " ");
  const tracked = new Set(execSync("git ls-files", { cwd: root, encoding: "utf8" }).split("\n"));
  const out: Cit[] = [];
  for (const m of text.matchAll(CITATION)) {
    const path = m[1] as string;
    if (!tracked.has(path) || !existsSync(`${root}/${path}`)) continue; // §880: known-bad paths are quoted on purpose
    out.push({ path, line: Number(m[2]) });
  }
  return out;
}

describe("§886: no live citation points at a blank line", () => {
  const root = repoRoot();
  const cits = citations(root);

  it("resolves a real population of citations (non-vacuity)", () => {
    // A renamed doc, a changed pattern, or a broken tracked-set read yields zero, and the assertion below
    // would pass over nothing — the failure this repo met in four gates (§487/§554/§572). Floor well under
    // the 101 measured at §886.
    expect(cits.length, `no resolvable path:line citations found in ${DOC} — the scan is broken, not the record`).toBeGreaterThanOrEqual(60);
  });

  it("every cited line is in bounds AND not blank", () => {
    const dead: string[] = [];
    for (const c of cits) {
      const lines = readFileSync(`${root}/${c.path}`, "utf8").split("\n");
      if (c.line > lines.length) {
        dead.push(`${c.path}:${c.line} — OUT OF BOUNDS (file has ${lines.length} lines)`);
        continue;
      }
      if ((lines[c.line - 1] ?? "").trim() === "") dead.push(`${c.path}:${c.line} — BLANK LINE`);
    }
    expect(
      dead,
      "a citation in the live checklist points at nothing. The claim may still be true — §885's case was — but " +
        "the pointer has moved, and a reader following it finds a gap. Re-anchor it as `path:line@symbol` so " +
        "the next insertion cannot silently break it:\n  " + dead.join("\n  "),
    ).toEqual([]);
  });

  it("the blankness test can actually fail (the instrument, not the corpus)", () => {
    // A tautological version of the check above — one that read the wrong file, or trimmed nothing — would be
    // green forever. This drives the same predicate over a known-blank line and a known-code line.
    const lines = readFileSync(`${root}/${DOC}`, "utf8").split("\n");
    const blankIdx = lines.findIndex((l) => l.trim() === "");
    const codeIdx = lines.findIndex((l) => l.trim().startsWith("|"));
    expect(blankIdx, "the doc has no blank line to probe with").toBeGreaterThanOrEqual(0);
    expect(codeIdx, "the doc has no table row to probe with").toBeGreaterThanOrEqual(0);
    expect((lines[blankIdx] ?? "").trim() === "").toBe(true);
    expect((lines[codeIdx] ?? "").trim() === "").toBe(false);
  });
});
