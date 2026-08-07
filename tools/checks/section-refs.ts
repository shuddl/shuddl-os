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

export function loadDocs(root: string = repoRoot()): { path: string; text: string }[] {
  const files = execSync('git ls-files "*.md"', { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  return files.map((path) => ({ path, text: readFileSync(`${root}/${path}`, "utf8") }));
}

function main(): void {
  const root = repoRoot();
  const docs = loadDocs(root);

  // NON-VACUITY (§487/§490): a scan that reads nothing reports clean. This corpus is thousands of
  // references across dozens of files; a floor here catches a broken `git ls-files` or a wrong root.
  if (docs.length < 10) {
    console.error(`FAIL section-refs — scanned ${docs.length} markdown file(s) under ${root}. A scan that reads nothing reports clean.`);
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
  console.log(`section-refs OK — ${refs} §N reference(s) across ${docs.length} markdown files all resolve (${canonical.size} sections defined)`);
}

if (process.argv[1]?.endsWith("section-refs.ts")) main();
