import { describe, expect, it } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1149 (REQ-119) — EVERY WORK PACKAGE CARRIES ITS EXIT AUDIT, AND NOW SOMETHING CHECKS IT.
//
// CLAUDE.md rule 9: "Adversarial audit swarm at every WP exit … No open Criticals at close (REQ-119)."
//
// WHY THIS GATE EXISTS AT ALL (audit §1142). A GO-LIVE row asserted for weeks that the practice had lapsed —
// "WP-04…WP-16 have no exit-audit section at all, and WP-01 never had a labelled swarm" — and framed the
// remedy as an owner decision between amending rule 9 and resuming the swarms. It was FALSE: all sixteen
// carry one. The claim survived because nobody re-derived it, and because any single pattern reports most of
// them missing — the corpus uses THREE heading conventions that drifted across the build:
//
//   WP-01 – WP-11   ## WP-exit audit swarm (REQ-119)
//   WP-12 – WP-15   ## REQ-119 exit audit — CLEAR-TO-CLOSE
//   WP-16           ## REQ-119 launch audit — CLEAR-TO-CLOSE
//
// Matching only the second form yields "4 of 16", which reads as a serious constitutional finding and is an
// artifact. So the rule below accepts the family, and the BOUNDARY test pins all three so a future narrowing
// of this pattern fails here rather than producing another false alarm.
//
// A gate, unlike a paragraph, is re-runnable: a seventeenth work package added without an exit audit reds the
// build instead of waiting for an audit to notice (§1146's read → enforced conversion, third instance).

/** The exit-audit heading family. Deliberately broad: it is the ABSENCE that is the defect, never the wording. */
const EXIT_AUDIT_HEADING = /^#{2,3} .*(?:REQ-119|exit audit|audit swarm)/im;

export function wpsMissingExitAudit(docs: readonly { path: string; text: string }[]): string[] {
  return docs.filter((d) => !EXIT_AUDIT_HEADING.test(d.text)).map((d) => d.path);
}

function wpDocs(): { path: string; text: string }[] {
  const root = repoRoot();
  const paths = globSync("docs/wp/WP-*.md", { cwd: root }).sort();
  if (paths.length === 0) throw new Error("wp-exit-audit: glob matched ZERO work-package docs — a broken pattern reads as a clean scan");
  return paths.map((p) => ({ path: p, text: readFileSync(`${root}/${p}`, "utf8") }));
}

describe("§1149 REQ-119: every work package records its exit audit", () => {
  const docs = wpDocs();

  it("finds the work-package corpus at all (non-vacuity — §968's rule)", () => {
    // Sixteen WPs are closed (genesis/08). A floor below that catches a broken glob without pinning a count
    // that a seventeenth WP would falsify.
    expect(docs.length, "no WP docs found — the scan is broken, not the corpus").toBeGreaterThanOrEqual(16);
  });

  it("SENSITIVITY: a work package with no exit-audit heading is flagged", () => {
    const planted = [{ path: "docs/wp/WP-99.md", text: "# WP-99\n\n## Scope\n\nSome work.\n" }];
    expect(wpsMissingExitAudit(planted)).toEqual(["docs/wp/WP-99.md"]);
  });

  it("BOUNDARY: all THREE heading conventions satisfy the rule (§1142's artifact, pinned)", () => {
    const forms = [
      { path: "a.md", text: "## WP-exit audit swarm (REQ-119)\nfindings…" },
      { path: "b.md", text: "## REQ-119 exit audit — CLEAR-TO-CLOSE\nan 8-lens adversarial swarm…" },
      { path: "c.md", text: "## REQ-119 launch audit — CLEAR-TO-CLOSE\nverdict…" },
    ];
    expect(wpsMissingExitAudit(forms)).toEqual([]);
  });

  it("a passing MENTION in prose does not satisfy it — the rule wants a section", () => {
    // §1142's first wrong answer counted mentions and reported all 16 present for the wrong reason.
    const prose = [{ path: "d.md", text: "# WP-x\n\nAn exit audit swarm will run before close.\n" }];
    expect(wpsMissingExitAudit(prose)).toEqual(["d.md"]);
  });

  it("every work package in the repo carries one", () => {
    expect(wpsMissingExitAudit(docs)).toEqual([]);
  });
});
