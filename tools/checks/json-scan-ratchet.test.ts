import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1671 (REQ-118/119, filed row §1669/§1670) — THE SCANNING-JSON BLAST RADIUS MAY NOT GROW.
//
// A malformed JSON cell makes SQLite RAISE, not skip: `D1_ERROR: malformed JSON: SQLITE_ERROR` (measured at
// §1669 and §1670 against a real D1). The raise happens while EVALUATING THE PREDICATE, so a query whose
// `WHERE` scans rows the caller never asked for fails for EVERY caller as soon as ONE row anywhere is corrupt.
// §1670's split:
//
//   21  SCANNING   — `WHERE json_extract(col, …) = ?` or a `json_each(col)` join with no key pinned first.
//                    One bad row → the whole query raises. Includes `lens.ts` (the visibility lens),
//                    `sla-sweep`, the KPI computes, credit reconciliation, and every `users.device_keys` read.
//    7  KEYED      — `WHERE id = ?1 AND json_…`. Only that row's own operation breaks. Contained, fine.
//
// THE REAL FIX IS A MIGRATION — `CHECK (json_valid(col))` per JSON column — and CLAUDE.md puts a migration
// behind a REQ row, so the checklist carries it as an owner decision. This gate does the one thing that IS in
// scope meanwhile: **it stops the blast radius widening while the decision is open.** A 22nd scanning site is
// a new tenant-wide outage surface, and it should cost a conversation rather than a merge.
//
// NOT A CORRECTNESS GATE. It cannot make a corrupt row safe; it freezes how much a corrupt row could reach.

const FROZEN_SCANNING = 21;

/** PURE: split the SQL string literals of one source file into scanning vs keyed JSON reads. */
export function classifyJsonSql(text: string): { scanning: string[]; keyed: string[] } {
  const scanning: string[] = [];
  const keyed: string[] = [];
  for (const m of text.matchAll(/"([^"]{0,400}?json_(?:extract|each)\([^"]{0,400}?)"/gs)) {
    const sql = (m[1] ?? "").split(/\s+/).join(" ");
    // A key pinned in the WHERE before the JSON call contains the damage to that row.
    (/WHERE\s+[\w.]*\b(id|slug|stream_id)\b\s*=\s*\?/i.test(sql) ? keyed : scanning).push(sql);
  }
  return { scanning, keyed };
}

function productionSources(root: string): string[] {
  return execSync('git ls-files "packages" "workers"', { cwd: root, encoding: "utf8" })
    .split("\n")
    // `/\.tsx?$/`, never `.ts` alone — §1507 makes that class unrepeatable, and it caught THIS gate on its
    // first run. `packages/` and `workers/` hold 14 `.tsx` server-render views (the evidence email, the
    // dunning notice, the quote reply), any one of which could read a JSON column tomorrow.
    .filter((f) => /\.tsx?$/.test(f) && f.includes("/src/") && !f.includes(".test."));
}

describe("§1671 REQ-118: the scanning-JSON blast radius does not grow while §1669 is open", () => {
  const root = repoRoot();
  const files = productionSources(root);
  const all = files.flatMap((f) => classifyJsonSql(readFileSync(`${root}/${f}`, "utf8")).scanning);

  it("reads a real corpus (non-vacuity — an empty scan grows nothing)", () => {
    // LIVE COUNT at §1671: 212 production sources. The floor is far below it — a tripwire for a broken glob,
    // not a file count anyone maintains (§1650's distinction).
    expect(files.length, "almost no production sources parsed — the glob broke, not the tree").toBeGreaterThan(150);
  });

  it("the classifier separates a scanning read from a keyed one (positive control)", () => {
    const scan = `const q = "SELECT id FROM parties WHERE json_extract(names, '$.legal') = ?1";`;
    const key = `const q = "SELECT contacts FROM parties WHERE id = ?1 AND json_extract(contacts, '$.x') = ?2";`;
    expect(classifyJsonSql(scan).scanning).toHaveLength(1);
    expect(classifyJsonSql(scan).keyed).toHaveLength(0);
    expect(classifyJsonSql(key).keyed).toHaveLength(1);
    expect(classifyJsonSql(key).scanning).toHaveLength(0);
  });

  it("no NEW scanning JSON read is added", () => {
    expect(
      all.length,
      `${all.length} scanning json_each/json_extract reads, frozen at ${FROZEN_SCANNING} by §1671. A scanning ` +
        "read evaluates a JSON operator over rows the caller did not ask for, so ONE malformed cell anywhere " +
        "raises `D1_ERROR: malformed JSON` for EVERY caller — a tenant-wide outage from one bad row (§1669). " +
        "If you added one deliberately, pin the key in the WHERE first, or guard with `json_valid(col)`, or " +
        "raise this number in the same commit that says why. If you REMOVED one, lower it — this may fall.",
    ).toBeLessThanOrEqual(FROZEN_SCANNING);
  });

  // §1724 — THE DOC IS AN INPUT, NOT A NEIGHBOUR.
  //
  // `unbounded-reads-roster.test.ts:86@ROSTER` learned this at §823/§1019: a gate that freezes a count while
  // the checklist states the same count in prose is TWO numbers, and nothing makes them agree. That row read
  // "7 sites" while its roster held 8, green, for two audits — and the fix was to make the doc's number an
  // input to the gate. Three later ratchets (this one, `unbounded-event-scans`, `error-code-producers`) did
  // not carry the pattern forward. This is that binding.
  //
  // Deliberately matched on the NUMBER, not the heading: a doc-and-code agreement test that never compares
  // the number is agreeing about a title.
  it("§1724 the checklist states the same count this gate freezes (doc and code agree)", () => {
    const doc = readFileSync(`${repoRoot()}/docs/ops/GO-LIVE-CHECKLIST.md`, "utf8");
    const claimed = /(\d+) SCANNING `json_each`\/`json_extract` sites/.exec(doc);
    expect(
      claimed,
      "the checklist no longer states a SCANNING site count for the malformed-JSON hold. Restore it — the " +
        "number is the thing this pins, and a hold whose size nobody states is a hold nobody can size.",
    ).not.toBeNull();
    expect(
      Number(claimed![1]),
      `the checklist claims ${claimed?.[1]} scanning sites; this gate freezes ${FROZEN_SCANNING}. Whichever ` +
        "moved, move the other in the SAME commit.",
    ).toBe(FROZEN_SCANNING);
  });
});
