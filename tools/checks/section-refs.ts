import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { repoRoot } from "./repo-root.js";

// SECTION-REFERENCE INTEGRITY (REQ-118, audit §509).
//
// `check:citations` verifies every `path:line` reference resolves. Nothing verified `§N` references, and
// this record runs on them: **5,197** across the tracked markdown. §508 measured the consequence — §38 and
// §58 were referenced ELEVEN TIMES EACH as sections with content, and neither number was ever written. A
// reader following any of those twenty-two pointers landed on nothing, silently, for as long as they
// existed.
//
// The asymmetry §508 named is the whole reason this file exists: a `path:line` citation that rots fails a
// gate on every merge; a `§N` reference that points at nothing failed nowhere. §508 fixed the instances.
// Fixing instances without the mechanism is how §489 got instance #5 — so this is the mechanism.
//
// TWO NAMESPACES, deliberately separated:
//   • ZERO-PADDED `§01`–`§08` belong to the GENESIS docs (`genesis/00 §01`). CLAUDE.md and BUILD-PROMPT.md
//     use them correctly and they are NOT audit sections. Ignored here — the first version of the §508
//     sweep flagged every one of them, which is how a 202-hit false positive is made.
//   • A document that defines its OWN `§N` headings owns its own namespace and resolves against itself
//     first. `docs/plans/2026-07-23-codex-goal-clear-technical-debt.md` does exactly this.

/** A `§N` reference that resolves to no heading in its owning namespace. */
export interface DanglingRef {
  file: string;
  line: number;
  ref: string;
}

const HEADING_RE = /^#+ §(\d+)/gm;
const REF_RE = /§(\d+)/g;

/** Section numbers a document DEFINES as headings (`## §12`, `### §12`). */
export function definedSections(text: string): Set<string> {
  return new Set([...text.matchAll(HEADING_RE)].map((m) => String(Number(m[1]))));
}

/**
 * Dangling `§N` references across a corpus of `{path, text}` documents.
 *
 * `canonical` is the section namespace a document falls back to when it defines none of its own — the audit
 * record. A reference is dangling only when BOTH its own document and the canonical namespace lack it.
 */
export function findDanglingSectionRefs(
  docs: ReadonlyArray<{ path: string; text: string }>,
  canonical: ReadonlySet<string>,
): DanglingRef[] {
  const out: DanglingRef[] = [];
  for (const { path, text } of docs) {
    const own = definedSections(text);
    for (const m of text.matchAll(REF_RE)) {
      const raw = m[1]!;
      if (raw.startsWith("0")) continue; // the genesis §01–§08 namespace, not this one
      const n = String(Number(raw));
      if (own.has(n) || canonical.has(n)) continue;
      out.push({ file: path, line: text.slice(0, m.index).split("\n").length, ref: `§${raw}` });
    }
  }
  return out;
}

/** The audit record that owns the canonical `§N` namespace. */
export const CANONICAL_DOC = "docs/audits/2026-08-01-technical-debt-audit.md";

// §1188 — THE CORPUS INCLUDES SOURCE, because that is where most of these references actually live.
//
// This gate shipped scanning `*.md` only. Measured at §1188: tracked `.ts`/`.tsx` carry **2,492** `§N`
// references — MORE than the markdown corpus this file was built for — and every one of them was unchecked.
// Five dangled, all at section **624** — spelled without the § marker here because this gate requires that
// notation to resolve, and the whole point is that this one does not (the same collision §1187 met) (written without the marker below, deliberately), a number that was never allocated (the audit runs §623 → §625, and the phase
// those comments describe is §625). That number appears ZERO times in markdown, so the original corpus could never
// have seen it — the defect survived precisely by living outside the scan.
//
// That is §508's own finding recurring in the one place this gate does not look: §508 fixed §38 and §58 after
// they were referenced eleven times each as sections that were never written, and built this file so it could
// not happen again. It happened again, in source.
//
// Extending the corpus cost exactly those five references (measured BEFORE the change, per §1184's rule that
// an option's cost is asserted until someone runs it). Source files define no `§N` headings, so they resolve
// against the canonical audit namespace, which is the correct owner for every reference they carry.
export function loadDocs(root: string = repoRoot()): { path: string; text: string }[] {
  // §1415 — THE CORPUS, WIDENED. This read `"*.md" "*.ts" "*.tsx"` until a §1415 reference planted in
  // `eslint.config.mjs` passed the gate silently. That file carries **74** `§N` pointers, the largest
  // concentration outside the audit itself, and the gate whose only job is resolving those pointers had
  // never read it. Measured at the widening: 907 files -> 1001, and the only two dangling references in the
  // 94 new files were the ones this phase had just introduced. The historical content was sound; the gate
  // simply could not say so.
  //
  // Extensions rather than "every tracked file" because the corpus must exclude binaries (a PNG containing
  // the bytes `§` `1` `2` is not a reference). Any text format that can carry a comment can carry a §N.
  const files = execSync('git ls-files "*.md" "*.ts" "*.tsx" "*.mjs" "*.cjs" "*.js" "*.json" "*.yml" "*.yaml" "*.sql" "*.toml" "*.csv" "*.sh"', { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  return files.map((path) => ({ path, text: readFileSync(`${root}/${path}`, "utf8") }));
}

function main(): void {
  const root = repoRoot();
  const docs = loadDocs(root);

  // NON-VACUITY (§487/§490): a scan that reads nothing reports clean. This corpus is thousands of
  // references across dozens of files; a floor here catches a broken `git ls-files` or a wrong root.
  if (docs.length < 200) {
    console.error(`FAIL section-refs — scanned ${docs.length} file(s) under ${root}. A scan that reads nothing reports clean.`);
    process.exit(1);
  }
  const canonical = definedSections(docs.find((d) => d.path === CANONICAL_DOC)?.text ?? "");
  if (canonical.size < 100) {
    console.error(`FAIL section-refs — the canonical namespace (${CANONICAL_DOC}) resolved to ${canonical.size} sections; the audit defines hundreds.`);
    process.exit(1);
  }

  const dangling = findDanglingSectionRefs(docs, canonical);
  if (dangling.length > 0) {
    console.error(`section-refs — ${dangling.length} §N reference(s) point at a section that does not exist:\n`);
    for (const d of dangling) console.error(`  ${d.file}:${d.line} → ${d.ref}`);
    console.error(
      `\nFix: write the section, correct the reference, or — when a number was skipped and the intent cannot be` +
        ` recovered — add a landing stub saying so (audit §508 did this for §38 and §58). A wrong pointer is` +
        ` worse than an absent one.`,
    );
    process.exit(1);
  }
  const refs = docs.reduce((n, d) => n + [...d.text.matchAll(REF_RE)].filter((m) => !m[1]!.startsWith("0")).length, 0);
  const md = docs.filter((d) => d.path.endsWith(".md")).length;
  console.log(
    `section-refs OK — ${refs} §N reference(s) across ${docs.length} files all resolve ` +
      `(${md} markdown + ${docs.length - md} source; ${canonical.size} sections defined)`,
  );
}

if (process.argv[1]?.endsWith("section-refs.ts")) main();
