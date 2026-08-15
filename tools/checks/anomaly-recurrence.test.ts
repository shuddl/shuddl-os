import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1541 (REQ-035/030/118) — EVERY WRITER OF `anomalies` DECLARES ITS RECURRENCE CLASS.
//
// §1539 and §1540 found the same defect twice, in two workers, three commits apart: an `INSERT OR IGNORE` on
// `anomalies` whose id folds CONTENT, so a row an operator had cleared could never come back while the
// underlying condition kept recurring. Every ops read of that table filters `status = 'open'` — the watchtower
// route defaults to it, the sequencer's gate probe and the credit reconciler hard-code it — so the failure is
// invisible exactly where it is looked for.
//
// The rule is decidable, and it is decidable ONLY by the SUBJECT of the idempotency id:
//
//   RECURRING CONDITION  (partner+ISA control, tenant+naturalKey+raw row) — no new id will ever be minted for
//                        it, so the row itself must REOPEN: ON CONFLICT(id) DO UPDATE SET status = 'open'.
//   ONE-SHOT OCCURRENCE  (an id folding `now`, a per-run `importId`) — the next occurrence mints its own id, so
//                        OR IGNORE is correct and a reopen clause would be noise.
//
// Both classes live in the SAME FILES (mirror-sweep raises a content-keyed quarantine and a clock-keyed gap row
// twelve lines apart), so no path, name or table-level rule can separate them. Nothing mechanical can read an
// id's subject either — which is why this gate requires the author to SAY which class a site is, and accepts a
// marker only when it carries a reason. That is the §1244 shape: a filter fixes mechanical noise, never meaning,
// so the escape hatch is an explicit marker rather than a heuristic.
//
// A reopen trigger asks a future reader to remember §1540. This asks the compiler-of-record instead.

// `status = 'open'` may sit ANYWHERE in the SET list (watchtower and anchor both set severity and detail first)
// and the statement may be split across concatenated string literals — hence the bounded any-char reach rather
// than `\s+status`. It must still be the SAME clause, so the reach is capped well below a second statement.
//
// The negative half is the whole point and is pinned by a control below: an `ON CONFLICT … DO UPDATE` that
// refreshes `severity`/`detail` and NEVER touches `status` must NOT satisfy this. That is not hypothetical —
// it is exactly what `status-cache.ts` did (audit §1541, the third instance), and it is invisible to any sweep
// that buckets writers by conflict FORM, because the form is right and the SET list is what is wrong.
const REOPEN_CLAUSE = /ON\s+CONFLICT\s*\(\s*id\s*\)\s*DO\s+UPDATE\s+SET[\s\S]{0,200}?status\s*=\s*'open'/i;
/** The opt-out: an author declaring this site one-shot, and saying why. `anomaly-recurrence: one-shot — <reason>` */
const ONE_SHOT_MARKER = /anomaly-recurrence:\s*one-shot\s*[—-]\s*\S/i;
const INSERT_ANOMALIES = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["'`[]?anomalies\b/i;

interface Site {
  readonly file: string;
  readonly line: number;
}

/** Every production INSERT into `anomalies`, with the window a clause or marker may legally sit in. */
function anomalyInserts(root: string): { site: Site; window: string }[] {
  const files = execSync("git ls-files workers packages", { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.") && !f.includes("/test/"));
  const out: { site: Site; window: string }[] = [];
  for (const file of files) {
    const lines = readFileSync(`${root}/${file}`, "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (!INSERT_ANOMALIES.test(lines[i] as string)) continue;
      // The clause may wrap onto the next lines; the marker sits in the comment block ABOVE the statement.
      // Both directions are bounded and generous — a site that needs more than this is unreadable anyway.
      out.push({ site: { file, line: i + 1 }, window: lines.slice(Math.max(0, i - 14), i + 6).join("\n") });
    }
  }
  return out;
}

describe("§1541 REQ-035: every writer of `anomalies` declares whether its row can recur", () => {
  const root = repoRoot();
  const inserts = anomalyInserts(root);

  it("derives a real population (non-vacuity — an empty scan certifies every writer)", () => {
    // Floor the INPUT, never the finding (§1148). LIVE, MEASURED at §1541: six production INSERT sites across
    // four files (translator inbound, mirror-sweep ×2, api import, anchor, status-cache, watchtower).
    expect(
      inserts.length,
      "no INSERT INTO anomalies found — the extractor broke, not the codebase. This gate ranges over a table " +
        "written by seven modules; a zero here would silently certify all of them.",
    ).toBeGreaterThanOrEqual(5);
  });

  it("each site either REOPENS on conflict or is declared one-shot with a reason", () => {
    const undeclared = inserts
      .filter(({ window }) => !REOPEN_CLAUSE.test(window) && !ONE_SHOT_MARKER.test(window))
      .map(({ site }) => `${site.file}:${site.line}`);
    expect(
      undeclared,
      "an `anomalies` writer neither reopens on conflict nor declares itself one-shot. This exact defect shipped " +
        "TWICE (audit §1539 translator quarantine, §1540 legacy-mirror quarantine): a content-keyed id under " +
        "OR IGNORE can never come back once an operator clears it, and every ops read of this table filters " +
        "status = 'open'. Decide by the SUBJECT of the id — a RECURRING condition must reopen; a ONE-SHOT " +
        "occurrence (id folds `now` or a per-run id) may keep OR IGNORE and must say so:\n" +
        "    // anomaly-recurrence: one-shot — <why a fresh id arrives on its own>\n  " +
        undeclared.join("\n  "),
    ).toEqual([]);
  });

  it("the detector fires on the exact shape it exists for, and is not satisfied by a bare marker (positive control)", () => {
    // Without this, a matcher that stopped recognising the clause would report a clean tree forever (§1387).
    const reopening = 'db.prepare("INSERT INTO anomalies (id) VALUES (?) ON CONFLICT(id) DO UPDATE SET status = \'open\'")';
    const bare = 'db.prepare("INSERT OR IGNORE INTO anomalies (id) VALUES (?)")';
    expect(INSERT_ANOMALIES.test(bare), "the insert matcher no longer recognises a write to this table").toBe(true);
    expect(REOPEN_CLAUSE.test(reopening), "the reopen clause is no longer recognised").toBe(true);
    expect(REOPEN_CLAUSE.test(bare), "an OR IGNORE must not read as reopening").toBe(false);
    // THE DISCRIMINATING CONTROL — the third instance's exact shape. An upsert that refreshes the row's contents
    // and leaves `status` alone is not a reopen, and a sweep that buckets by conflict FORM cannot tell them apart.
    const upsertNoStatus =
      'db.prepare("INSERT INTO anomalies (id) VALUES (?) ON CONFLICT(id) DO UPDATE SET severity = excluded.severity, detail = excluded.detail")';
    expect(
      REOPEN_CLAUSE.test(upsertNoStatus),
      "a DO UPDATE that never sets status read as a reopen — this gate would then miss §1541's own instance",
    ).toBe(false);
    // The marker is an ASSERTION by an author, so it must carry a reason — a bare tag buys nothing.
    expect(ONE_SHOT_MARKER.test("// anomaly-recurrence: one-shot"), "a reasonless marker must not satisfy the gate").toBe(false);
    expect(ONE_SHOT_MARKER.test("// anomaly-recurrence: one-shot — the id folds `now`, so each tick mints a new row")).toBe(true);
  });
});
