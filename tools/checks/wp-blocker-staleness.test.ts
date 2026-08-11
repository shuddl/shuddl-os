import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §946 — NO LAUNCH-GATE ROW MAY NAME A WORK PACKAGE AS ITS PENDING BLOCKER.
//
// `PROJECT-STATE.md` states it twice — "All sixteen WPs are closed" (:9) and "All sixteen WPs are merged to
// `main` and closed" (:98) — and every close-out under docs/wp/ agrees. So a checklist row still reading
// "Deferred WP-13" or "Depends WP-14" is describing a world that ended in July.
//
// MEASURED AT §946, two of them, both on FILMED acceptance demos:
//   L116 (demo #4) action "Build MCP intake surface (WP-13)", status "Deferred WP-13" — while
//        `docs/wp/WP-13.md` reads "complete, merged to main locally" AND demo 4's spine
//        (`@shuddl/mcp test/quote-book.test.ts`) runs GREEN inside `pnpm test:acceptance`, a merge-board gate.
//   L115 (demo #2) status "Depends WP-14 + pilot" — WP-14 shipped; its own close-out records that the PLG
//        surface ships DARK until an operator binds flags at R4. The dependency is real and is no longer the
//        BUILD.
//
// A reader planning the launch gate found "build the MCP intake surface" as outstanding work. The blocker had
// migrated — from *build it* to *bind, flip and film it* — and the row did not follow. Third instance of that
// shape in three phases (§937's C3 row, §944's L417), each time a summary lagging a maintained record.
//
// SHAPE (§830): this READS PROJECT-STATE's all-sixteen assertion and COMPUTES the requirement, rather than
// hard-coding "16". If a WP is ever reopened, the premise fails here and gets re-decided, instead of this gate
// quietly outliving the fact it rests on.
//
// SCOPE, STATED: it catches a status naming a **WP**. A row whose blocker migrated to something UNNAMED is
// still prose and no gate reaches it — which is why both instances here were found by reading, not by CI.

const CHECKLIST = "docs/ops/GO-LIVE-CHECKLIST.md";
const STATE = "docs/ops/PROJECT-STATE.md";

/** Live text only — struck spans are corrections this repo preserves deliberately. */
function live(s: string): string {
  return s.replace(/~~[\s\S]*?~~/g, "");
}

describe("§946: no checklist row names a closed WP as its blocker", () => {
  const root = repoRoot();
  const checklist = readFileSync(`${root}/${CHECKLIST}`, "utf8");
  const state = readFileSync(`${root}/${STATE}`, "utf8");

  it("PROJECT-STATE still asserts every WP is closed (the premise this gate rests on)", () => {
    // If this fails, the rule below is no longer valid and must be re-decided — not deleted, and not
    // silently kept. A gate whose premise dies should say so in its own voice.
    expect(
      live(state),
      `${STATE} no longer asserts that all sixteen WPs are closed. §946's rule ("no row may name a WP as a ` +
        'pending blocker") depends on it. If a WP genuinely reopened, this gate must be re-scoped to that WP ' +
        "rather than dropped.",
    ).toMatch(/All sixteen WPs are (closed|merged)/);
  });

  it("no live status in the launch-gate table defers to a work package", () => {
    // SCOPED to `### Milestone / CONFIRM gates`, where a WP name in the Status column IS a claim that the
    // build is outstanding. §3's known-limitations table has a column whose PURPOSE is naming where an item
    // gets addressed — sibling rows legitimately read "WP-13", "WP-12/GTM", "Later refinement" — so applying
    // this rule there would be a false positive by design, and a gate that cries wolf gets silenced.
    // (Measured: exactly one §3 row, L261 "Deferred WP-11 Watchtower", points at a WP that has since closed.
    // Recorded in §946 as a disposition pointer, not gated as a blocker.)
    const lines = checklist.split("\n");
    const start = lines.findIndex((l) => l.startsWith("### Milestone / CONFIRM gates"));
    const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
    expect(start, "the `### Milestone / CONFIRM gates` section is gone — re-scope this gate deliberately").toBeGreaterThan(0);
    const offenders: string[] = [];
    lines.slice(start, end < 0 ? lines.length : end).forEach((l, k) => {
      const i = start + k;
      if (!l.startsWith("| ")) return;
      // Only the LIVE text of the row — a struck "~~Deferred WP-13~~" is the corrected record, not a defect.
      const m = /\b(Deferred|Depends(?: on)?)\s+(WP-\d+)/.exec(live(l));
      if (m !== null) offenders.push(`L${i + 1}: "${m[0]}" — ${l.slice(2, 60)}…`);
    });
    expect(
      offenders,
      "checklist row(s) whose live text still names a WORK PACKAGE as the pending blocker, though " +
        `${STATE} records all sixteen as closed:\n  ` +
        offenders.join("\n  ") +
        "\n\n§946 found two of these on FILMED acceptance demos — one still asking someone to 'Build MCP " +
        "intake surface (WP-13)' whose spine already runs green in `pnpm test:acceptance`. Restate the row's " +
        "ACTUAL remaining blocker (a binding, a flag flip, a filmed run, a CONFIRM), striking the old text " +
        "rather than deleting it.",
    ).toEqual([]);
  });

  it("the corrections are still legible (struck text preserved, not deleted)", () => {
    // The convention is load-bearing: the next reader must see that the question was asked and answered.
    // If someone "cleans up" the strikes, the row looks like it was always right and the migration of the
    // blocker becomes invisible again.
    for (const marker of ["~~Deferred WP-13~~", "~~Depends WP-14 + pilot~~"]) {
      expect(
        checklist,
        `${CHECKLIST} lost the struck correction ${marker}. §946 corrected these in place so the blocker's ` +
          "migration stays visible; deleting the old text hides that the row was ever wrong.",
      ).toContain(marker);
    }
  });
});
