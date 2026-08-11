import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { ledgerRows } from "./ledger-status-vocabulary.test.js";

// §995 — AN EXPIRY TRIGGER THAT NOBODY EVALUATES IS A COMMENT, NOT A CONTROL.
//
// Every row in the repo-owned debt ledger carries an `Evidence expires` cell, and the good ones are precise:
// *"when `packages/ledger/src/anchor.ts` changes — the green above is evidence about `08e2156` and nothing
// else."* That discipline is the reason this record can be trusted at all. But it was enforced by **nothing**:
// the trigger is written when the row is filed and re-read by whoever happens to open the file.
//
// MEASURED AT §995, by comparing each row's newest date against the last-commit date of every file its trigger
// names: **5 of 17 terminal rows had already expired** — L404 (2026-08-04), L406 (08-07), L414 (08-06/08-09),
// L420 (08-05), L429 (08-08, a week after the fix). None carried a re-verification note, and none had been
// re-checked. All five were then re-verified by hand and **all five HELD** — which is the point. Nothing in
// the repo could distinguish *"still true"* from *"nobody looked"*, and a fix silently undone by a later
// refactor looks exactly like a fix that stayed.
//
// THE RULE: a terminal row (FIXED / RESOLVED / TRIPWIRED) whose trigger names a repo file must carry a date at
// least as new as that file's last commit. Re-verifying and stamping the row is what clears it — which is the
// behaviour the ledger already asks for in prose.
//
// SELF-REFRESHING BY CONSTRUCTION: the row's date is the NEWEST date appearing anywhere in it, so adding
// `RE-VERIFIED <today>` is both the human record and the machine clearance. There is no second list to update
// and therefore nothing to drift — the failure mode §945 and §988 both produced.
//
// SCOPE, STATED: this checks that somebody LOOKED after the file moved, never that they looked correctly. A
// stamp is a claim by its author, exactly as before; what changes is that omitting one is now loud. Triggers
// phrased against the world rather than a file ("at reboot", "when counsel signs") name no path and are
// correctly invisible here — see the companion assertion below, which keeps that exemption from silently
// swallowing the whole corpus.

const CHECKLIST = "docs/ops/GO-LIVE-CHECKLIST.md";
const TERMINAL = /^\**(FIXED|RESOLVED|TRIPWIRED)\b/;
const ISO_DATE = /\b(20\d{2}-\d{2}-\d{2})\b/g;
/** A backticked token that looks like a repo path. Extensionless prose in backticks is not a citation. */
const BACKTICKED_PATH = /`([A-Za-z0-9_./@-]+\.[A-Za-z0-9]{1,5})`/g;
const EXPIRES_CELL = 7;

interface Terminal {
  line: number;
  status: string;
  newestDate: string | null;
  paths: string[];
}

/** Split honouring `\|` escapes inside code spans — §945's trap, hit four times there. */
function cells(line: string): string[] {
  return line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
}

function lastCommitDate(root: string, rel: string): string | null {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cs", "--", rel], { cwd: root, encoding: "utf8" }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** A row's newest date and the repo files its expiry trigger names. */
function measure(root: string, raw: string, line: number, status: string): Terminal {
  const dates = [...raw.matchAll(ISO_DATE)].map((m) => m[1] as string).sort();
  const expires = cells(raw)[EXPIRES_CELL] ?? "";
  const paths = [...expires.matchAll(BACKTICKED_PATH)]
    .map((m) => (m[1] as string).replace(/[:#].*$/, ""))
    .filter((p) => p.includes("/") && existsSync(`${root}/${p}`));
  return { line, status, newestDate: dates[dates.length - 1] ?? null, paths: [...new Set(paths)] };
}

/**
 * §998 — BOTH tables, because the rule follows the TRIGGER, not the table.
 *
 * §995 read only the repo-owned ledger, on the reasoning that external holds expire on world events ("at
 * reboot", "when counsel signs") that no gate can observe. Mostly true, and it hid a real row: the CORS hold
 * names `tests/e2e/prod-surface.spec.ts` in its trigger, and that file moved 2026-08-01 against a row dated
 * 2026-07-31. A file-change trigger is equally checkable wherever it is written, and scoping by TABLE rather
 * than by trigger shape is what made it invisible. External rows naming no file are still correctly ignored —
 * they simply produce no paths.
 */
function terminalRows(root: string): Terminal[] {
  const md = readFileSync(`${root}/${CHECKLIST}`, "utf8");
  const lines = md.split("\n");
  const out = ledgerRows(md)
    .filter((r) => TERMINAL.test(r.status))
    .map((r) => measure(root, lines[r.line - 1] as string, r.line, r.status));

  const start = lines.findIndex((l) => l.startsWith("## External holds"));
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i += 1) {
      const l = lines[i] as string;
      if (l.startsWith("## ")) break;
      if (!l.startsWith("| ") || l.startsWith("|--")) continue;
      const c = cells(l);
      if (c.length !== 8 || c[5] === "Status") continue; // header, by its own 6th cell (§981's method)
      out.push(measure(root, l, i + 1, c[5] as string));
    }
  }
  return out;
}

describe("§995: an evidence-expiry trigger is evaluated, not merely written", () => {
  const root = repoRoot();
  const rows = terminalRows(root);
  const withPaths = rows.filter((r) => r.paths.length > 0);

  it("finds terminal rows and resolvable trigger paths (non-vacuity — §968's rule)", () => {
    // Both floors matter and fail differently. Zero terminal rows means the ledger parse broke; zero
    // resolvable paths means the EXEMPTION swallowed the corpus — a trigger phrased against the world is
    // legitimately unreachable here, so without this floor a reformatted `Evidence expires` column would
    // exempt every row at once and this gate would certify a clean ledger over nothing.
    expect(rows.length, `no terminal (FIXED/RESOLVED/TRIPWIRED) rows parsed from ${CHECKLIST} — the scan is broken, not the ledger`).toBeGreaterThanOrEqual(10);
    expect(
      withPaths.length,
      `no terminal row's expiry trigger names a resolvable repo path. Either the triggers stopped citing files ` +
        `in backticks (re-scope this gate deliberately) or the cell index moved — both must fail here rather ` +
        `than pass over an empty set.`,
    ).toBeGreaterThanOrEqual(5);
  });

  it("every terminal row is at least as new as the files its own trigger names", () => {
    const stale = withPaths.flatMap((r) =>
      r.paths
        .map((p) => ({ p, committed: lastCommitDate(root, p) }))
        .filter((x) => x.committed !== null && (r.newestDate === null || x.committed > r.newestDate))
        .map((x) => `${CHECKLIST}:${r.line}  row dated ${r.newestDate ?? "(no date)"}  <  ${x.p} @ ${x.committed}`),
    );
    expect(
      stale,
      "repo-owned ledger row(s) whose evidence EXPIRED by their own stated trigger, with no later " +
        "re-verification:\n  " +
        stale.join("\n  ") +
        "\n\nThe row says its verdict dies when that file changes; the file changed and the row did not " +
        "follow. MEASURED AT §995: five rows were in exactly this state, one of them a week stale, and all " +
        "five still HELD when checked by hand — which is why this must be a gate and not a habit. Nothing " +
        "could distinguish *still true* from *nobody looked*.\n" +
        "Re-verify the row, then append `RE-VERIFIED <today> (audit §N) — <what you re-ran and what it said>` " +
        "to its Evidence-expires cell. The newest date in the row is what clears this, so the human record " +
        "and the machine clearance are the same edit.",
    ).toEqual([]);
  });

  it("a row that names a file carries a date at all (the clearance mechanism must be reachable)", () => {
    // If a dated row loses its dates, `newestDate` is null and the assertion above fires on every path it
    // names — correct, but the message would blame the file rather than the missing stamp. Failing here first
    // says the real thing.
    const undated = withPaths.filter((r) => r.newestDate === null).map((r) => `${CHECKLIST}:${r.line}  ${r.status.slice(0, 60)}`);
    expect(
      undated,
      "terminal row(s) naming a file in their expiry trigger but carrying NO date, so nothing can establish " +
        "whether the evidence predates the file:\n  " +
        undated.join("\n  ") +
        "\n\nDate the verdict (`FIXED (YYYY-MM-DD)`) — an undated fix cannot expire, which sounds safe and " +
        "means the opposite.",
    ).toEqual([]);
  });
});
