import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { stripStruck } from "./strip-struck.js";

// §1474 (REQ-118/119) — A REOPEN TRIGGER THAT NAMES A PATH MUST NAME A PATH THAT EXISTS.
//
// The GO-LIVE checklist's last column is the reopen trigger: the sentence that says when a carried row stops
// being true. §1473 built a ladder for claims by whether a stranger can RUN them, and these sit across it —
// some are commands (*"re-run `git grep -l 'split.computed' -- packages/ledger/src/queries`"*), some are
// observable changes (*"when `collector.ts` gains a page bound"*), and some are production-scale predictions
// (*"when a tenant's lifetime count makes /v1/kpis measurably slow"*) that genuinely cannot be run from here.
//
// §1474 re-ran every trigger that could be run — 4 commands and 6 observable-change checks — and all ten still
// held, none had fired. So the prose is in good shape and does NOT need a semantic gate; §1472 declined one for
// mutual lockstep pairs on exactly that reasoning (§1399: an English boundary can never close).
//
// What IS mechanically decidable is narrower and worth having: **can the trigger fire at all?** A trigger
// keyed to `collector.ts` gaining a page bound is unfirable the moment `collector.ts` is renamed — and nothing
// would say so, because a row whose trigger can never fire looks exactly like a row whose trigger has not
// fired. That is the "exemption outlives its subject" shape (§1359/§1426) applied to the reopen column.
//
// SCOPE, stated: this checks that the SUBJECT still exists, never that the trigger is still true. Truth is a
// phase's work — §1474 did it by hand for ten of them.

const CHECKLIST = "docs/ops/GO-LIVE-CHECKLIST.md";

/** A repo path in backticks, with an optional `:line` and any trailing prose inside the same span. */
const PATH_IN_TICKS = /`([A-Za-z0-9_./-]+\.(?:ts|tsx|md|json|toml|csv|sql))(?::\d+)?[^`]*`/g;

/**
 * A named path RESOLVES if it is tracked, or is a suffix of a tracked path.
 *
 * The suffix rule is not laxity — it is how these triggers are written: `routes/events.ts` means
 * `workers/api/src/routes/events.ts`, and a resolver demanding the full path reports it dead. §1474 measured
 * exactly that false positive on the first run, which is why the control below pins both directions.
 */
function resolver(root: string): (p: string) => boolean {
  const tracked = execSync("git ls-files", { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter((f) => f !== "");
  const exact = new Set(tracked);
  return (p: string) => exact.has(p) || tracked.some((t) => t.endsWith(`/${p}`));
}

/** Every (row item, path) named in the trigger column of a row whose status is OPEN. */
function triggerPaths(root: string): { item: string; path: string }[] {
  const out: { item: string; path: string }[] = [];
  for (const line of readFileSync(`${root}/${CHECKLIST}`, "utf8").split("\n")) {
    if (!line.startsWith("| **") || !line.includes("OPEN")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 3) continue;
    // §1474 — `stripStruck`, never a private regex. A row title carries superseded counts as struck spans
    // (`~~Two~~ ~~FOUR~~ SIX sites…`); a marker-strip would render all three as live, which is §1411's defect
    // in miniature. The shared mask is also what `strip-struck.test.ts` enforces — it caught this exact line.
    const item = stripStruck(cells[1] as string).replace(/\*/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
    for (const m of (cells[cells.length - 2] as string).matchAll(PATH_IN_TICKS)) out.push({ item, path: m[1] as string });
  }
  return out;
}

describe("§1474 REQ-119: every reopen trigger names a subject that still exists", () => {
  const root = repoRoot();
  const resolves = resolver(root);
  const named = triggerPaths(root);

  it("derives a real population (non-vacuity — an empty scan certifies every trigger)", () => {
    // LIVE, MEASURED at §1474: 43 OPEN rows carry a trigger cell; 24 repo paths are named across them. Floor 10,
    // well below, because rows close and their triggers go with them.
    expect(named.length, "no path found in any reopen trigger — the checklist table shape or the matcher changed").toBeGreaterThanOrEqual(10);
  });

  it("every path a trigger names still resolves", () => {
    const dead = named.filter((n) => !resolves(n.path)).map((n) => `${n.item} → ${n.path}`);
    expect(
      dead,
      "a reopen trigger is keyed to a file that no longer exists, so it can NEVER fire — and a row whose " +
        "trigger cannot fire is indistinguishable from a row whose trigger has not fired. Repoint the trigger " +
        "at the file that replaced it, or re-word it against something that still exists:\n  " + dead.join("\n  "),
    ).toEqual([]);
  });

  it("the resolver accepts a SUFFIX and rejects a genuine absence (positive + negative control)", () => {
    // §1474's first run reported `routes/events.ts` DEAD — a false positive, because the resolver demanded a
    // full tracked path while the triggers are written with the short form a reader recognises. Both directions
    // are pinned so neither the laxity nor the strictness can drift back in unnoticed.
    expect(resolves("routes/events.ts"), "the suffix form no longer resolves — every short-form trigger reads as dead").toBe(true);
    expect(resolves("workers/api/src/routes/events.ts"), "a full tracked path must resolve").toBe(true);
    expect(resolves("src/definitely-not-a-real-file.ts"), "the resolver accepts anything — it would certify a dead trigger").toBe(false);
    expect(resolves("events.ts"), "a BARE basename should resolve too (several triggers use it)").toBe(true);
  });
});
