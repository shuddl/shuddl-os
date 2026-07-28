import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// TYPE-ONLY import (erased at runtime): the CLI in citation-links.ts imports this module, so a value
// import back would be a cycle. Resolution is injected as a `Resolver` instead — one matcher, one home.
import type { Citation } from "./citation-links.js";

// The adoption ratchet for content anchors.
//
// THE PROBLEM IT SOLVES: `path:line@symbol` is opt-in, and an opt-in rule with no pressure behind it
// stays at the handful of citations someone converted by hand. Retrofitting the ~66 citations into
// the high-churn files was rejected deliberately — this gate cannot tell a strong anchor from a weak
// one, so 66 anchors chosen in a hurry would read as protection while certifying nothing.
//
// THE MECHANISM: freeze today's number of UNANCHORED citations into a curated set of high-churn
// target files, and fail when that number grows. Nobody retrofits anything; the number falls as
// people touch those citations for their own reasons. A fall must be BANKED (the baseline lowered)
// or the ratchet quietly loosens back to the old ceiling, so a fall is a failure too — a friendly
// one, with the exact command attached.
//
// WHAT IS RATCHETED, AND WHAT IS NOT: only the curated `targets`. The other ~480 unanchored
// citations in this repo are untouched and always will be — this is a pressure valve on the files
// that demonstrably move, not a campaign.

/** citing file -> target path -> count of UNANCHORED citations */
export type RatchetCounts = Record<string, Record<string, number>>;

export interface RatchetConfig {
  /** curated repo-relative paths whose incoming citations are ratcheted */
  targets: string[];
  /** the frozen count, committed alongside the code */
  baseline: RatchetCounts;
}

export type Resolver = (citedPath: string, citingFile: string) => readonly string[];

export interface RatchetViolation {
  kind: "grew" | "fell";
  citingFile: string;
  target: string;
  baseline: number;
  actual: number;
}

export const RATCHET_CONFIG_PATH = "tools/checks/citation-ratchet.json";
const WRITE_COMMAND = "pnpm check:citations --write-ratchet";

/**
 * Count the unanchored citations into ratcheted targets, keyed (citing file, target).
 *
 * An AMBIGUOUS basename — a bare `events.ts` with a line number, which resolves to more than one file
 * in this repo — counts against EVERY ratcheted candidate. That is deliberate and fail-closed: the
 * checker cannot know which file the author meant, and the way out (write the full path, or add an
 * anchor) is the improvement the ratchet buys.
 *
 * (No example is written as a live `path:line` here on purpose. An illustration of the form IS a
 * citation to this scanner, and the `citation-check: ignore` escape is LINE-local — when the prose
 * rewraps, the marker and the example drift onto different lines and the gate fires. That happened
 * twice while writing this file; not writing the example at all is the durable fix.)
 */
export function countUnanchored(citations: readonly Citation[], targets: readonly string[], resolve: Resolver): RatchetCounts {
  const ratcheted = new Set(targets);
  const counts: RatchetCounts = {};
  for (const c of citations) {
    if (c.symbol !== undefined) continue;
    for (const candidate of resolve(c.path, c.citingFile)) {
      if (!ratcheted.has(candidate)) continue;
      const perFile = (counts[c.citingFile] ??= {});
      perFile[candidate] = (perFile[candidate] ?? 0) + 1;
    }
  }
  return counts;
}

function everyKey(a: RatchetCounts, b: RatchetCounts): { citingFile: string; target: string }[] {
  const keys = new Map<string, { citingFile: string; target: string }>();
  for (const source of [a, b]) {
    for (const [citingFile, perTarget] of Object.entries(source)) {
      for (const target of Object.keys(perTarget)) keys.set(`${citingFile}\u0000${target}`, { citingFile, target });
    }
  }
  return [...keys.values()].sort((x, y) => (x.citingFile === y.citingFile ? x.target.localeCompare(y.target) : x.citingFile.localeCompare(y.citingFile)));
}

/** Every place the live count differs from the frozen baseline, in either direction. */
export function checkRatchet(actual: RatchetCounts, config: RatchetConfig): RatchetViolation[] {
  const violations: RatchetViolation[] = [];
  for (const { citingFile, target } of everyKey(actual, config.baseline)) {
    const live = actual[citingFile]?.[target] ?? 0;
    const frozen = config.baseline[citingFile]?.[target] ?? 0;
    if (live === frozen) continue;
    violations.push({ kind: live > frozen ? "grew" : "fell", citingFile, target, baseline: frozen, actual: live });
  }
  return violations;
}

export function formatRatchetViolation(v: RatchetViolation): string {
  const where = `${v.citingFile} → ${v.target}`;
  if (v.kind === "grew") {
    return (
      `GREW ${where}: ${v.baseline} → ${v.actual} unanchored citation(s). ` +
      `${v.target} is a high-churn file, so a bare line number into it rots faster than anywhere else — ` +
      `write the new citation as \`path:line@symbol\` (the symbol must sit within 2 lines of it), or use the full path if an ambiguous basename pulled it in here.`
    );
  }
  return (
    `FELL ${where}: ${v.baseline} → ${v.actual} unanchored citation(s). This is PROGRESS, not a defect — ` +
    `bank it so the ratchet cannot loosen back: \`${WRITE_COMMAND}\`.`
  );
}

export function loadRatchetConfig(cwd: string = process.cwd()): RatchetConfig {
  return JSON.parse(readFileSync(join(cwd, RATCHET_CONFIG_PATH), "utf8")) as RatchetConfig;
}

/** Rewrite ONLY the baseline; the curated target list is hand-owned and never generated. */
export function writeRatchetBaseline(baseline: RatchetCounts, cwd: string = process.cwd()): void {
  const config = loadRatchetConfig(cwd);
  const sortedFiles = Object.keys(baseline).sort();
  const sorted: RatchetCounts = {};
  for (const f of sortedFiles) {
    const perTarget = baseline[f];
    if (perTarget === undefined) continue;
    sorted[f] = Object.fromEntries(Object.entries(perTarget).sort(([a], [b]) => a.localeCompare(b)));
  }
  writeFileSync(join(cwd, RATCHET_CONFIG_PATH), `${JSON.stringify({ ...config, baseline: sorted }, null, 2)}\n`, "utf8");
}
