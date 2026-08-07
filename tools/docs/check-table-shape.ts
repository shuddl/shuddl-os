// Markdown table shape check.
//
// WHY THIS EXISTS. A markdown table row with MORE cells than its header does not
// error — GitHub renders the first N and silently DROPS the rest. Audit §50 found
// three rows in the threat model carrying a 4th "status" cell against a 3-column
// header; the dropped cells held the residual-risk statements ("the endpoint is
// DARK in every environment", "nothing authenticates a real partner today"), so
// the RENDERED document showed controls without their caveats and overstated
// protection. The same pass found a row FUSED to its neighbour by an insert that
// omitted a trailing newline — 9 pipes on a 4-column row — which deleted a whole
// mitigation row from the render.
//
// Both are invisible in the source diff and both drift the record toward claiming
// more safety than exists. This check is the mechanical floor: a table row must
// have exactly as many cells as its header.
//
// Under-wide rows are NOT flagged: markdown pads them, nothing is lost, and
// trailing empty cells are a common intentional shorthand.
//
// -----------------------------------------------------------------------------
// 2026-08-06 (audit §484): was `check-table-shape.mjs`, a main()-only script with
// ZERO exports — so no test could import it, and none did. Measured, not assumed:
// run from `tools/checks/` it printed **"OK (0 markdown files, every table row
// matches its header)" and exited 0**. `git ls-files '*.md'` is CWD-RELATIVE, so
// the gate whose job is stopping the record from overstating safety would itself
// certify the record having read nothing — the same input-vacuity defect §481
// closed in the bundle ratchet, in a scanner that had shipped since §50.
//
// TWO fixes, because detecting the symptom is weaker than removing the cause:
// the scan is now rooted at `git rev-parse --show-toplevel` so CWD CANNOT narrow
// it, and an empty file list is a hard failure rather than a clean report.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

/** Repo root as seen from `cwd`, so the scan covers the whole tree no matter where the gate is invoked from. */
export function repoRoot(cwd: string = process.cwd()): string {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8", cwd }).trim();
}

/**
 * Every tracked markdown file in the REPO, not in the caller's directory.
 *
 * `cwd` names WHERE TO LOOK FROM, never how much to look at: it is resolved to the repo root before
 * `git ls-files` runs. The first version of this fix took a `cwd` and passed it straight to git, which
 * fixed `main()` and left every other caller able to reproduce the §484 defect — the test below failed on
 * exactly that, one section after §483 recorded the same wiring-hole shape. A parameter that can narrow a
 * scan will eventually narrow one.
 */
export function listMarkdownFiles(cwd: string = process.cwd()): string[] {
  const root = repoRoot(cwd);
  return execSync("git ls-files '*.md'", { encoding: "utf8", cwd: root }).trim().split("\n").filter(Boolean);
}

/** Cell count of a markdown table row: split on unescaped pipes, drop the leading/trailing empties. */
export function cellCount(line: string): number {
  // A pipe inside `code` or escaped as \| is not a delimiter.
  const stripped = line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length)).replace(/\\\|/g, "  ");
  return stripped.split("|").slice(1, -1).length;
}

export const isDivider = (line: string): boolean => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");

/** Over-wide rows in one document. Pure over its text, so the test needs no fixture files. */
export function findOverWideRows(file: string, text: string): string[] {
  const problems: string[] = [];
  const lines = text.split("\n");
  let header: { cols: number; line: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trimStart().startsWith("|")) {
      header = null;
      continue;
    }
    if (header === null) {
      // A header is only a header if the NEXT line is the |---|---| divider.
      if (i + 1 < lines.length && isDivider(lines[i + 1]!)) header = { cols: cellCount(line), line: i + 1 };
      continue;
    }
    if (isDivider(line)) continue;
    const cols = cellCount(line);
    if (cols > header.cols) {
      problems.push(
        `${file}:${i + 1} — row has ${cols} cells, header (line ${header.line}) has ${header.cols}. ` +
          `Markdown DROPS the extra ${cols - header.cols} at render.`,
      );
    }
  }
  return problems;
}

export interface TableScan {
  files: number;
  problems: string[];
}

export function scanTables(cwd: string = process.cwd()): TableScan {
  // Paths from `git ls-files` are repo-relative, so they are read against the ROOT — not against `cwd`,
  // which would resolve every path wrongly the moment the gate ran from anywhere but the top.
  const root = repoRoot(cwd);
  const files = listMarkdownFiles(root);
  const problems: string[] = [];
  for (const file of files) problems.push(...findOverWideRows(file, readFileSync(`${root}/${file}`, "utf8")));
  return { files: files.length, problems };
}

/**
 * NON-VACUITY (§481/§484). A scanner that scans nothing reports clean, and this one PRINTED its file count
 * while checking it against nothing. The count is now the gate's own precondition: no markdown means the
 * input resolution broke, which is a failure of the check, not a clean bill for the docs.
 *
 * This is a SEPARATE exported function rather than an `if` inside `main()` on purpose: the ratchet test
 * (§483) noted that a reader silent about absence is only safe while every caller actually asks. Burying
 * the asking inside an unexported `main` is what made the original `.mjs` untestable in the first place.
 */
export function vacuityViolation(files: number, root: string): string | null {
  if (files > 0) return null;
  return (
    `scanned 0 markdown files under ${root}. A scanner that reads nothing reports clean; this is a broken ` +
    `input, not a clean record (audit §484). Expected \`git ls-files '*.md'\` to list the tree.`
  );
}

function main(): void {
  const root = repoRoot();
  const { files, problems } = scanTables(root);

  const vacuous = vacuityViolation(files, root);
  if (vacuous !== null) {
    console.error(`check:tables — FAIL: ${vacuous}`);
    process.exit(1);
  }

  if (problems.length > 0) {
    console.error(`check:tables — ${problems.length} over-wide table row(s); the extra cells render as NOTHING:\n`);
    for (const p of problems) console.error(`  ${p}`);
    console.error(`\nFix: merge the extra cells into the last column, or add the column to the header.`);
    process.exit(1);
  }
  console.log(`check:tables — OK (${files} markdown files, every table row matches its header)`);
}

if (process.argv[1]?.endsWith("check-table-shape.ts")) main();
