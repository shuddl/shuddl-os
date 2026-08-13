import { readFileSync } from "node:fs";
import { repoRoot } from "../checks/repo-root.js";

// §1068 — `pnpm recall <term>` — WHICH PRIOR VERDICT ALREADY COVERS THIS?
//
// Written because a rule failed three times despite being written down. §"search the record before the code"
// says to check the audit before tracing a symbol; §1044, §1052 and §1067 each traced first, and §1067 spent a
// whole phase re-deriving §798's conclusion verbatim — including its reopen trigger.
//
// The cause is mechanical, not cultural. The record is **63,390 lines across 1,052 phase sections**, and a raw
// grep for a symbol returns bare lines: `NotConfiguredMigrator` matches 8 of them and NOT ONE says which phase
// decided it. Reading eight fragments to locate a verdict costs more than re-tracing the code, so re-tracing
// wins — every time, silently.
//
// This maps each hit to the SECTION THAT OWNS IT (the nearest preceding `## §N — …` heading) and to the
// checklist ROW that owns it (cell 0), so the answer to "has this been decided?" is one line per prior verdict
// rather than a pile of matches. It changes nothing about the discipline; it makes the discipline cheap.
//
// SCOPE, STATED: this finds where a term was DISCUSSED, never whether the discussion is still true. A phase
// heading is a pointer, not evidence — §1044's rule (an inherited claim is a claim you are making) still
// applies to whatever it points at, and the re-verification is still the reader's job.

// §1342 — SOURCES IS HAND-KEPT AND COVERS THE RECORD'S THREE DENSEST FILES, NOT ALL OF IT.
// Measured 2026-08-13: the tracked record spans ~45 markdown files (docs/audits 3, docs/ops 9, docs/wp 17,
// genesis 16), and these three carry the overwhelming bulk of it — the audit alone is ~78k lines. The
// omissions are real and worth knowing before reading a silence as absence: the two OTHER audits under
// docs/audits, the 17 WP checklists (two of which cite `audit §N`), PROJECT-STATE and the rest of docs/ops,
// and the genesis specs. This is the §1341 shape — a hand-kept CORPUS, where drift under-detects silently
// rather than failing — and it is kept deliberately: widening it to every markdown file would return the
// genesis specs for most product terms, which is the false-positive profile §1053 records as fatal to a
// tool people are meant to reach for.
const SOURCES = [
  "docs/audits/2026-08-01-technical-debt-audit.md",
  "docs/ops/GO-LIVE-CHECKLIST.md",
  "CLAUDE.md",
] as const;

export interface Hit { readonly source: string; readonly line: number; readonly owner: string; readonly text: string }

/** The `## §N — title` heading that owns `line`, or the checklist row's Item cell, or the file itself. */
export function ownerOf(lines: readonly string[], idx: number, source: string): string {
  if (source.endsWith("GO-LIVE-CHECKLIST.md")) {
    const row = lines[idx] ?? "";
    if (row.startsWith("| ")) {
      // Cell 0 is the Item — what the row is ABOUT (§993's column rule).
      const item = row.split(/(?<!\\)\|/)[1]?.trim() ?? "";
      return `row: ${item.replace(/\*\*/g, "").slice(0, 88)}`;
    }
  }
  for (let i = idx; i >= 0; i -= 1) {
    const m = /^## (§\d+) — (.*)$/.exec(lines[i] ?? "");
    if (m !== null) return `${m[1]} — ${(m[2] as string).slice(0, 80)}`;
  }
  return "(no owning section)";
}

export function recall(term: string, root: string = repoRoot()): Hit[] {
  const out: Hit[] = [];
  for (const source of SOURCES) {
    let raw: string;
    try {
      raw = readFileSync(`${root}/${source}`, "utf8");
    } catch {
      continue; // a source that does not exist is not an error — the record moves
    }
    const lines = raw.split("\n");
    lines.forEach((text, i) => {
      if (!text.includes(term)) return;
      out.push({ source, line: i + 1, owner: ownerOf(lines, i, source), text: text.trim().slice(0, 120) });
    });
  }
  return out;
}

/** Distinct owners, in first-appearance order — the actual answer to "who already decided this?". */
export function owners(hits: readonly Hit[]): string[] {
  const seen = new Set<string>();
  for (const h of hits) if (!seen.has(h.owner)) seen.add(h.owner);
  return [...seen];
}

// §1195 — A PHRASE MISS IS NOT NOVELTY, AND THIS TOOL USED TO SAY IT WAS.
//
// `recall()` is a literal `includes`, and `main` joins every argv into ONE string. That is right for the usage
// its own line advertises (`pnpm recall NotConfiguredMigrator` — a single symbol) and silently wrong for the
// way it actually gets used: a multi-word question. "drain order stranding" appears nowhere verbatim, so the
// tool answered *"appears in NO governing record. It is genuinely new — trace the code"* — while `drain-order`
// alone returns 6 mentions and `stranded` returns 21.
//
// MEASURED at §1195 across this session's own usage: FOUR multi-word queries got the novelty verdict, and at
// least one was demonstrably covered — "public quote rate limit abuse throttle guest" reported new while the
// subject was filed in SEVEN places (§1182 found it by grep moments later).
//
// The verdict is the problem, not the miss. "Genuinely new — trace the code" is an instruction, and this
// record's whole discipline is *search the record before claiming absence* (§1181). An instrument that
// answers a phrase question with a novelty claim inverts exactly that.
//
// So: when the literal phrase misses and the query has more than one term, RETRY PER TERM and report what each
// finds. Novelty is claimed only when NO term matches anything — which is the claim the message was always
// making and could not previously support.
export function splitTerms(query: string): string[] {
  return [...new Set(query.split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 3))];
}

function main(): void {
  const term = process.argv.slice(2).join(" ").trim();
  if (term === "") {
    console.error('recall: usage — pnpm recall <term>   (e.g. `pnpm recall NotConfiguredMigrator`)');
    process.exit(2);
  }
  const hits = recall(term);
  if (hits.length === 0) {
    const terms = splitTerms(term);
    const perTerm = terms.length > 1 ? terms.map((t) => ({ t, hits: recall(t) })).filter((r) => r.hits.length > 0) : [];
    if (perTerm.length > 0) {
      console.log(`recall: the exact phrase "${term}" is absent, but ITS TERMS ARE NOT. This is not novelty:\n`);
      for (const { t, hits: h } of perTerm) {
        console.log(`  "${t}" — ${h.length} mention(s) across ${owners(h).length} verdict(s); first: ${owners(h)[0] ?? "?"}`);
      }
      console.log(
        "\nRe-run `pnpm recall <term>` on whichever of these names your subject, and read the owning section " +
          "BEFORE tracing the code. A phrase miss says only that nobody wrote your sentence.",
      );
      return;
    }
    console.log(`recall: "${term}" appears in NO governing record${terms.length > 1 ? " — and no term of it does either" : ""}. It is genuinely new — trace the code.`);
    return;
  }
  console.log(`recall: "${term}" — ${hits.length} mention(s) across ${owners(hits).length} prior verdict(s):\n`);
  for (const o of owners(hits)) {
    const first = hits.find((h) => h.owner === o) as Hit;
    console.log(`  ${o}`);
    console.log(`      ${first.source}:${first.line}  ${first.text}`);
  }
  console.log(
    "\nRead the owning section(s) BEFORE tracing the code. A heading is a pointer, not evidence — whatever it " +
      "claims still needs re-verifying at HEAD (§1044), but re-deriving it from scratch is what §1067 cost a phase.",
  );
}

if (process.argv[1]?.endsWith("recall.ts")) main();
