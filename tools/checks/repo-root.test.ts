import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot } from "./repo-root.js";

// §1193 (REQ-118) — THE MOST DEPENDED-UPON HELPER IN THE GATE CORPUS HAD NO TEST.
//
// `repoRoot()` is imported by **98** files under `tools/` and asserted by none — measured at §1193 by the
// sibling-test sweep that found it as the ONE exception in a directory where twelve other modules carry one.
// Every gate that resolves a corpus goes through it.
//
// Its own header records why it exists, and the stakes are in that history: three gates written by different
// hands certified CONSTITUTIONAL laws against an EMPTY SET — `check:tables` reported "OK (0 markdown files)",
// `check:invariants` reported "OK — 0/22 tables, events append-only (0 migration files)", `check:citations`
// reported "OK — 0 path:line citations resolve" — because each resolved its inputs against `process.cwd()`.
// This module is the one place that answer is written.
//
// THE REGRESSION THIS PINS is not a deletion, it is a KINDNESS: wrapping the call in a `try/catch` that
// returns `process.cwd()` when git fails. That reads as defensive programming and is the exact vacuity the
// module exists to remove — the header says so ("a permissive default here would recreate exactly the vacuity
// this module exists to remove, and would do it invisibly"). With such a fallback, all 98 gates keep passing
// while scanning whatever directory they were started from. Nothing in the suite would have noticed.
//
// NOTE FOR WHOEVER SEES `fatal: not a git repository` IN A RUN: this file produces it deliberately, from the
// out-of-tree case below, exactly as `invariants.test.ts` does from its stray-SQL fallback. §1190 spent six
// bisect runs tracing that string to a benign source; it is recorded here so the next reader does not repeat
// them. `execSync` forwards the child's stderr even when the throw is the expected outcome.

describe("§1193 REQ-118: repoRoot resolves SCOPE from the repo, never from the caller's location", () => {
  it("returns the repository toplevel", () => {
    const root = repoRoot();
    expect(root.length, "an empty toplevel would silently root every gate at `/`").toBeGreaterThan(1);
    // Anchored on a file that must exist at the root of THIS repo, rather than on a hardcoded path.
    expect(spawnSync("test", ["-f", join(root, "CLAUDE.md")]).status, `${root} is not this repo's toplevel`).toBe(0);
  });

  it("returns the SAME toplevel from a subdirectory — cwd is a LOCATION, never a SCOPE", () => {
    // The whole §487/§489 lesson in one assertion: three gates' verdicts once depended on where they were
    // started from, and this is the property that removes that dependence.
    const fromRoot = repoRoot();
    expect(repoRoot(join(fromRoot, "tools", "checks"))).toBe(fromRoot);
    expect(repoRoot(join(fromRoot, "packages"))).toBe(fromRoot);
  });

  it("THROWS outside a git work tree — it must not fall back to process.cwd()", () => {
    const outside = mkdtempSync(join(tmpdir(), "shuddl-norepo-"));
    try {
      // PREMISE, asserted rather than assumed: the directory really is outside a work tree. If a machine's
      // tmpdir ever sat inside one, the assertion below would pass for the wrong reason (§1183's lesson —
      // a proof marker must be verified, not trusted).
      const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: outside, encoding: "utf8" });
      expect(probe.status, "premise: the temp dir must not be inside a git work tree").not.toBe(0);

      expect(
        () => repoRoot(outside),
        "repoRoot must FAIL CLOSED outside a work tree. A fallback to process.cwd() would let every gate " +
          "scan whatever directory it was started from and report OK on an empty corpus — the exact defect " +
          "this module was written to end (audit §487/§489).",
      ).toThrow();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("never returns the caller's directory when that directory is not a repo", () => {
    // Belt to the throw above: if a future edit swallows the error, this catches the SHAPE of the fallback
    // rather than only its absence — a `catch { return cwd }` satisfies "does not throw" and fails here.
    const outside = mkdtempSync(join(tmpdir(), "shuddl-norepo2-"));
    try {
      let returned: string | undefined;
      try {
        returned = repoRoot(outside);
      } catch {
        returned = undefined; // the correct behaviour
      }
      expect(returned, `repoRoot returned ${String(returned)} for a non-repo directory instead of throwing`).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
