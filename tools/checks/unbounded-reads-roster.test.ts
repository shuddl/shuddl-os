import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-197/010 §794 — THE UNBOUNDED-READ HOLD, KEPT HONEST.
//
// `docs/ops/GO-LIVE-CHECKLIST.md` carries a filed, deliberately-unfixed hold: *"Unbounded list reads — 7
// sites, no LIMIT and no cursor"* (audit §183, re-verified §470). Every row a tenant has ever accumulated is
// loaded into one 128 MB Worker response. The decision to file rather than fix is the owner's and stands;
// what did NOT exist was anything keeping the record true.
//
// §470 re-verified BY HAND. A hand-verified hold is exactly the kind whose verdict dies silently: the sites
// can be fixed (and the doc then over-states the risk), or — worse — "fixed" with a bare `LIMIT`, which
// TRUNCATES SILENTLY and is the one remedy this repo forbids (the Migrator no-silent-drops rule; the
// checklist says so explicitly, and REQ-197/010 already established keyset cursors as the correct shape).
//
// This gate asserts the roster BOTH WAYS (§745):
//   · every listed site is STILL unbounded → the checklist's count is not over-stating a solved problem;
//   · a site that GAINS a bound fails → whoever fixed it updates the doc, and the reviewer gets to check
//     that the bound is a CURSOR and not a silent truncation.
//
// It deliberately does NOT try to discover new unbounded reads. A general detector over this tree finds ~29
// candidates against the checklist's 7, because most are bounded by a single-entity `WHERE` (one shipment's
// legs, one stream's events) — a ratio that would make the gate noise. Discovery stays the audit's job; this
// gate's job is that the filed answer does not rot.

/** The filed sites: file + a distinctive fragment of the SQL statement itself. */
const ROSTER: ReadonlyArray<{ file: string; anchor: string; what: string }> = [
  { file: "workers/api/src/routes/invoices.ts", anchor: "INVOICE_COLS_TENANT", what: "tenant lens — every invoice, no WHERE at all (the worst)" },
  { file: "workers/api/src/routes/invoices.ts", anchor: "INVOICE_COLS_PARTY", what: "party lens — every invoice for a party" },
  { file: "workers/api/src/routes/watchtower.ts", anchor: "FROM anomalies", what: "status=all drops the WHERE" },
  { file: "workers/api/src/routes/dunning.ts", anchor: "drafted_by_agent", what: "the dunning draft queue" },
  { file: "workers/api/src/routes/export.ts", anchor: "DOC_EXPORT_COLS", what: "export paginates EVENTS but returns ALL documents" },
  { file: "workers/api/src/routes/export.ts", anchor: "tsa_receipt", what: "every anchor receipt" },
  { file: "packages/ledger/src/parity.ts", anchor: "FROM events WHERE kind IN", what: "every native+legacy event of the backing kinds, FULL PAYLOADS" },
  { file: "workers/agents/src/watchtower.ts", anchor: "quote.priced", what: "every anomalous quote ever, on the daily cron" },
  // §823 — the NINTH, found by enumerating every API list endpoint rather than re-reading the eight.
  // `GET /v1/approvals?status=open` returns EVERY approval with that status: no cursor, no LIMIT, and
  // no per-object narrowing — the same shape as the invoices party lens two rows up. Its sibling
  // endpoints `/v1/exceptions` (REQ-197 keyset) and `/v1/invoices` (REQ-010 cursor) both paginate, which
  // is what makes this an unevenly applied rule rather than an unknown one.
  { file: "workers/api/src/routes/approvals.ts", anchor: "FROM approvals WHERE status = ?", what: "GET /v1/approvals — every approval of a status, no cursor" },
];

/** The prepare() template containing `anchor`, or undefined. Brace-free: SQL lives in one template literal. */
function statementContaining(src: string, anchor: string): string | undefined {
  for (const m of src.matchAll(/prepare\(\s*(`[^`]*`|"(?:[^"\\]|\\.)*")/g)) {
    const sql = m[1]!;
    if (sql.includes(anchor)) return sql;
  }
  return undefined;
}

describe("REQ-197/010 §794: the filed unbounded-read hold still describes reality", () => {
  const root = repoRoot();

  it.each(ROSTER)("$file — $what is still unbounded", ({ file, anchor }) => {
    const sql = statementContaining(readFileSync(`${root}/${file}`, "utf8"), anchor);
    expect(
      sql,
      `the roster's anchor "${anchor}" no longer names a prepared statement in ${file}. Either the read moved ` +
        "or it was rewritten — re-verify it against docs/ops/GO-LIVE-CHECKLIST.md and update BOTH.",
    ).toBeDefined();
    expect(
      /\bLIMIT\b/i.test(sql!),
      `${file} (${anchor}) now carries a LIMIT. If that is a KEYSET CURSOR, good — drop this row from the ` +
        "roster and from the GO-LIVE-CHECKLIST, because the hold just shrank and the record must say so. If " +
        "it is a BARE LIMIT, it is the wrong fix: it truncates silently, which this repo forbids (REQ-197/010 " +
        "established the cursor shape for exactly this).",
    ).toBe(false);
  });

  it("the checklist still files this hold at the roster's size (doc and code agree)", () => {
    // The doc groups the two invoices sites into one row, so it reads "7 sites" for 8 statements. Asserting
    // the DOC still carries the hold at all is the part that matters: a doc that quietly dropped the row
    // while the reads stayed unbounded is the failure this pairs against.
    const doc = readFileSync(`${root}/docs/ops/GO-LIVE-CHECKLIST.md`, "utf8");
    expect(doc, "the GO-LIVE-CHECKLIST no longer files the unbounded-read hold, but the reads are still unbounded").toMatch(
      /Unbounded list reads/,
    );
    expect(ROSTER.length, "roster size changed — update the checklist row in the same commit").toBe(9);
    // THE COUNT, not just the title (§823). This assertion used to match `/Unbounded list reads/` alone, so
    // the doc could say "7 sites" while the roster held 8 and both tests stayed green — and it DID, for two
    // audits. A doc-and-code agreement test that never compares the number is agreeing about a heading.
    const claimed = /Unbounded list reads — (\d+) sites/.exec(doc);
    expect(claimed, "the checklist row no longer states a site COUNT — restore it; the number is the thing this pins").not.toBeNull();
    expect(
      Number(claimed![1]),
      `the GO-LIVE-CHECKLIST claims ${claimed?.[1]} unbounded sites; the roster holds ${ROSTER.length}. ` +
        "Whichever moved, move the other in the SAME commit.",
    ).toBe(ROSTER.length);
  });
});

// ── §822 — THE DISCOVERY HALF. A ROSTER WATCHES WHAT IT KNOWS; A NINTH SITE WALKS PAST IT. ──────────────
//
// The roster above is a TRIPWIRE on eight filed holds: it fires when one of them is fixed, so the doc stops
// over-stating the risk. What it cannot do — and §794 did not claim it could — is notice a NEW unbounded
// read. §802 hit this exact wall on the constant-time roster and answered it by detecting the DEFECT shape
// rather than the known-good one. Same answer here.
//
// SCOPE, STATED NARROWLY AND ON PURPOSE. This finds a SELECT with **no WHERE clause at all** — a full table
// scan. That is the roster's own "the worst" category (its first row), and it is the only unboundedness a
// text scanner can decide without judgement.
//
// It deliberately does NOT flag the filtered-but-unbounded reads. Measured: **36** SELECTs filter on
// something other than a primary key, and the great majority are bounded in practice — `tenants WHERE
// slug = ?`, `users WHERE email = ?`, `legs WHERE shipment_id = ?`. Gating those would mean ~30 allowlist
// entries, and an allowlist that size is where a weak detector hides (§817). Two of the eight rostered
// holds live in that category and stay covered by the roster, which is the right tool for a known list.
//
// MEASURED (§822): exactly **2** no-WHERE statements exist, and **both are already rostered**
// (`DOC_EXPORT_COLS`, `INVOICE_COLS_TENANT`). Zero false positives — so the calibration below is a live
// positive set, not a planted one.
//
// THE SCANNER HAD TO BE FIXED FIRST, and that is worth recording. Reading only the FIRST string literal
// inside `.prepare(` reported SIX no-WHERE hits; four were statements built by CONCATENATION whose later
// fragments carried both the `WHERE` and a `LIMIT 1`. A scanner that sees one fragment of a four-fragment
// statement reports a table scan that does not exist. It now concatenates every literal in the call.

const STRING_LITERAL = /`[^`]*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/;

/** Every `.prepare(...)` argument, with ALL its concatenated string fragments joined. */
function preparedStatements(src: string): Array<{ line: number; sql: string }> {
  const out: Array<{ line: number; sql: string }> = [];
  for (const m of src.matchAll(/\.prepare\(/g)) {
    let depth = 1;
    let j = m.index + m[0].length;
    const start = j;
    while (j < src.length && depth > 0) {
      const ch = src[j]!;
      if (ch === "`" || ch === '"' || ch === "'") {
        const lit = new RegExp(STRING_LITERAL.source, "y");
        lit.lastIndex = j;
        if (lit.exec(src)) {
          j = lit.lastIndex;
          continue;
        }
      }
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      j += 1;
    }
    const expr = src.slice(start, j - 1);
    const fragments = expr.match(new RegExp(STRING_LITERAL.source, "g")) ?? [];
    out.push({ line: src.slice(0, m.index).split("\n").length, sql: fragments.map((f) => f.slice(1, -1)).join(" ") });
  }
  return out;
}

/** A SELECT with no WHERE, no LIMIT and no aggregate: it reads the whole table. */
function tableScans(root: string): Array<{ site: string; sql: string }> {
  const files = execSync('git ls-files "workers" "packages"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.ts$/.test(f) && !f.includes(".test.") && !f.includes("/test/"));
  const found: Array<{ site: string; sql: string }> = [];
  for (const f of files) {
    for (const { line, sql } of preparedStatements(readFileSync(`${root}/${f}`, "utf8"))) {
      if (!/\bSELECT\b/i.test(sql)) continue;
      if (/\bLIMIT\b/i.test(sql)) continue;
      if (/\b(COUNT|SUM|MAX|MIN|AVG)\s*\(/i.test(sql)) continue;
      if (/\bWHERE\b/i.test(sql)) continue;
      found.push({ site: `${f}:${line}`, sql: sql.replace(/\s+/g, " ").trim() });
    }
  }
  return found;
}

describe("REQ-197/010 §822: no NEW full-table scan (the discovery half the roster cannot do)", () => {
  const root = repoRoot();

  it("the scanner joins CONCATENATED fragments — one fragment is not a statement", () => {
    // The bug that produced four phantom table scans, pinned so it cannot come back. Both of these are ONE
    // statement each; the first is bounded and must not be reported as a scan.
    const src = [
      'const a = db.prepare("SELECT x FROM events " + "WHERE kind = ? " + "ORDER BY seq LIMIT 1").bind(k);',
      'const b = db.prepare("SELECT y FROM documents ORDER BY id").all();',
    ].join("\n");
    const stmts = preparedStatements(src);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]!.sql, "fragments were not joined — the WHERE and LIMIT live in later fragments").toContain("WHERE");
    expect(stmts[0]!.sql).toContain("LIMIT");
    expect(stmts[1]!.sql).not.toContain("WHERE");
  });

  it("finds the known table scans (calibration — both are ALREADY on the roster above)", () => {
    // A live positive set, so this calibration cannot rot the way a synthetic one can. If either stops being
    // found, the scanner broke — or the read was fixed, in which case the roster row goes too.
    const anchors = tableScans(root).map((s) => s.sql);
    for (const known of ["DOC_EXPORT_COLS", "INVOICE_COLS_TENANT"]) {
      expect(anchors.join("\n"), `the scanner no longer finds the ${known} table scan`).toContain(known);
    }
  });

  // The table scans are pinned as an EXACT SET, not filtered against the ROSTER's anchors. Measured the hard
  // way (§822): the first draft filtered out any hit whose SQL contained a roster anchor, and one of those
  // anchors is the substring `FROM anomalies` — so a planted full-table scan on that same table came back
  // **GREEN**. A roster anchor is a locator for a human reading one file; it was never a unique key, and
  // using it as one masked exactly the defect class this test exists to find. A count pin plus an
  // account-for-every-hit pass catches a new scan even in the same file, on the same table (§806/§809).
  const KNOWN_TABLE_SCANS: ReadonlyArray<{ file: string; anchor: string }> = [
    { file: "workers/api/src/routes/export.ts", anchor: "DOC_EXPORT_COLS" },
    { file: "workers/api/src/routes/invoices.ts", anchor: "INVOICE_COLS_TENANT" },
  ];

  it("the full-table scans are EXACTLY the two filed ones — no more, no fewer", () => {
    const found = tableScans(root);
    const accountedFor = (s: { site: string; sql: string }): boolean =>
      KNOWN_TABLE_SCANS.some((k) => s.site.startsWith(`${k.file}:`) && s.sql.includes(k.anchor));

    expect(
      found.filter((s) => !accountedFor(s)).map((n) => `${n.site}  ${n.sql.slice(0, 90)}`),
      "a SELECT reads an ENTIRE table — no WHERE, no LIMIT, no aggregate. Every row the tenant has ever " +
        "accumulated is loaded into a Worker's memory on one request. Add a keyset cursor (never a bare " +
        "LIMIT, which truncates silently — REQ-197/010), or if it is genuinely bounded, add it to " +
        "KNOWN_TABLE_SCANS with the reason:",
    ).toEqual([]);

    // The count pin. Without it, a SECOND scan matching a known file+anchor pair would be absorbed silently.
    expect(found, `expected exactly ${KNOWN_TABLE_SCANS.length} full-table scans, found ${found.length}`).toHaveLength(
      KNOWN_TABLE_SCANS.length,
    );
    // And both known ones must still BE scans — if one gains a cursor, this fails and its ROSTER row goes too.
    for (const k of KNOWN_TABLE_SCANS) {
      expect(
        found.some((s) => s.site.startsWith(`${k.file}:`) && s.sql.includes(k.anchor)),
        `${k.file} (${k.anchor}) is no longer a full-table scan — good; drop it here AND from ROSTER above`,
      ).toBe(true);
    }
  });
});
