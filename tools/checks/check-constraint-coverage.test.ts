import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./repo-root.js";

// §915 — EVERY D1 `CHECK` CONSTRAINT MUST BE CLASSIFIED, AND A NEW ONE MUST NOT ARRIVE UNNOTICED.
//
// §668 already established why these matter: a DDL constraint is the last line below every gate and test
// double, and it is exactly the clause a schema refactor drops because nothing in the application layer
// references it. For `money_lines.direction` and `money_lines.kind` — whose values REQ-040's floor
// comparison and I7's netting identity are written in terms of — there is no Zod counterpart at all, so
// the database is not a backstop, it is the only guard.
//
// §668 fixed that for `0002_domain.sql` and built a fifteen-row roster to hold it. **It never swept the
// sibling migrations.** Mutating all 23 CHECKs repo-wide at §915 found four the roster could not see:
// `events.visibility`, `events.source` (0001_ledger_core), `documents.retention_status` (0007) and
// `pairings.kind` (control). Each was enforced by the database and by nothing else — neutralising it to
// `CHECK (1=1)` left every suite green.
//
// That is the roster half (§802/§822): a roster finds what it lists. This is the scan. It does not
// re-check what §668 checks; it checks that nothing is OUTSIDE the set of things being checked.
//
// WHAT A GREEN HERE DOES NOT MEAN. It proves each constraint is classified and that the file named as its
// home mentions the column. It does NOT prove that file's assertions are sound — a test can name a column
// and still assert nothing about it. §668's roster is what verifies the values; this verifies the roster
// is complete.

interface Constraint {
  /** Migration basename. */ file: string;
  /** Column the CHECK constrains, or a short label for a structural (non-enum) CHECK. */ column: string;
  /** Allowed values joined by "|", or "" for a structural CHECK. A widened enum changes this and fails. */ values: string;
  /** Test file that exercises it — asserted to exist and to mention the column. */ testedBy: string;
}

/**
 * Every CHECK in `db/`, with where it is exercised. Membership is REQUIRED, not remembered (§265): a new
 * CHECK fails this gate until someone classifies it, which puts the decision in front of the person who
 * caused it rather than relying on them to recall a roster in another package.
 */
const CLASSIFIED: readonly Constraint[] = [
  // ── control plane ──────────────────────────────────────────────────────────────────────────────────
  { file: "0001_control.sql", column: "role", values: "admin|ops|finance|read|driver|portal", testedBy: "packages/ledger/test/schema-domain.test.ts" },
  { file: "0001_control.sql", column: "kind", values: "mcp|api|webhook|edi", testedBy: "packages/ledger/test/schema-domain.test.ts" },
  // ── ledger core (events) — §915 found visibility + source unexercised ───────────────────────────────
  { file: "0001_ledger_core.sql", column: "visibility", values: "internal|counterparty|public", testedBy: "packages/ledger/test/schema-core.test.ts" },
  { file: "0001_ledger_core.sql", column: "source", values: "native|legacy|edi|email", testedBy: "packages/ledger/test/schema-core.test.ts" },
  { file: "0001_ledger_core.sql", column: "device_id", values: "", testedBy: "packages/ledger/test/schema-core.test.ts" },
  { file: "0001_ledger_core.sql", column: "shipment_id", values: "", testedBy: "packages/ledger/test/schema-core.test.ts" },
  // ── tenant domain — §668's roster ──────────────────────────────────────────────────────────────────
  { file: "0002_domain.sql", column: "kind", values: "shipper|consignee|carrier|broker|cartage|factor|insurer", testedBy: "packages/ledger/test/schema-domain.test.ts" },
  { file: "0002_domain.sql", column: "mode", values: "LTL|TL|brokered|cartage|dray|transload", testedBy: "packages/ledger/test/schema-domain.test.ts" },
  { file: "0002_domain.sql", column: "kind", values: "pickup|linehaul|interline|cartage|delivery|dray", testedBy: "packages/ledger/test/schema-domain.test.ts" },
  { file: "0002_domain.sql", column: "kind", values: "BOL|POD|photo|WI_cert|invoice|ratecon|COI|W9|claim|tsa_receipt", testedBy: "packages/ledger/test/schema-domain.test.ts" },
  { file: "0002_domain.sql", column: "visibility", values: "internal|counterparty|public", testedBy: "packages/ledger/test/schema-domain.test.ts" },
  { file: "0002_domain.sql", column: "direction", values: "ar|ap", testedBy: "packages/ledger/test/schema-domain.test.ts" },
  { file: "0002_domain.sql", column: "kind", values: "freight|fsc|accessorial|correction_credit|correction_debit|interline_split|cod_collect|settle_fee|credit_purchase", testedBy: "packages/ledger/test/schema-domain.test.ts" },
  { file: "0002_domain.sql", column: "channel", values: "email|sms|voice|portal|note", testedBy: "packages/ledger/test/schema-domain.test.ts" },
  { file: "0002_domain.sql", column: "kind", values: "terminal|dock|yard", testedBy: "packages/ledger/test/schema-domain.test.ts" },
  { file: "0002_domain.sql", column: "kind", values: "tractor|trailer|pup", testedBy: "packages/ledger/test/schema-domain.test.ts" },
  { file: "0002_domain.sql", column: "kind", values: "zone_tariff|floors|fsc|accessorials|transit_matrix|class_adapter", testedBy: "packages/ledger/test/schema-domain.test.ts" },
  { file: "0002_domain.sql", column: "module", values: "rating|invoicing|dispatch|settlement|comms", testedBy: "packages/ledger/test/schema-domain.test.ts" },
  { file: "0002_domain.sql", column: "authority", values: "native|legacy", testedBy: "packages/ledger/test/schema-domain.test.ts" },
  { file: "0002_domain.sql", column: "severity", values: "info|warn|critical", testedBy: "packages/ledger/test/schema-domain.test.ts" },
  { file: "0002_domain.sql", column: "kind", values: "edi_partner|eld|quickbooks|email_inbox|tiles|tsa", testedBy: "packages/ledger/test/schema-domain.test.ts" },
  { file: "0002_domain.sql", column: "amount_cents", values: "", testedBy: "packages/ledger/test/schema-domain.test.ts" },
  // ── retention — §915 found this one guarded by the DB and by NOTHING else (no Zod schema exists) ────
  { file: "0007_documents_retention.sql", column: "retention_status", values: "active|expired", testedBy: "packages/ledger/test/retention.test.ts" },
];

const key = (c: { file: string; column: string; values: string }): string => `${c.file}::${c.column}::${c.values}`;

/** Every CHECK in every tracked migration, enum and structural alike, read from the SQL. */
function discovered(root: string): Constraint[] {
  const files = execSync("git ls-files", { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.startsWith("db/") && f.endsWith(".sql"));
  const out: Constraint[] = [];
  for (const f of files) {
    const txt = readFileSync(`${root}/${f}`, "utf8");
    const base = f.split("/").pop() as string;
    for (const m of txt.matchAll(/CHECK\s*\(([^)]*(?:\([^)]*\))?[^)]*)\)/gi)) {
      const body = (m[1] as string).trim();
      const en = /^(\w+)\s+IN\s*\((.*)$/is.exec(body);
      if (en !== null) {
        const values = [...(en[2] as string).matchAll(/'([^']*)'/g)].map((x) => x[1] as string).join("|");
        out.push({ file: base, column: en[1] as string, values, testedBy: "" });
      } else {
        // Structural CHECK — keyed by its FIRST identifier, which is stable across rewording.
        const first = /\b([a-z_][a-z0-9_]*)\b/i.exec(body);
        out.push({ file: base, column: (first?.[1] ?? "?") as string, values: "", testedBy: "" });
      }
    }
  }
  return out;
}

describe("§915: every D1 CHECK constraint is classified, and none arrives unnoticed", () => {
  const root = repoRoot();
  const found = discovered(root);

  it("the scan finds a real population (non-vacuity — an empty scan classifies nothing)", () => {
    // A renamed db/ tree, a changed CHECK shape, or a broken ls-files read yields [] and the set
    // comparison below would pass over nothing — the failure this repo met in four gates (§487/§554/§572).
    expect(found.length, "no CHECK constraints found under db/ — the scan is broken, not the schema").toBeGreaterThanOrEqual(20);
  });

  it("the discovered set and the classified set are EQUAL (two-sided — added AND removed both fail)", () => {
    const f = found.map(key).sort();
    const c = CLASSIFIED.map(key).sort();
    expect(
      f,
      "a D1 CHECK constraint is not classified, or a classified one no longer exists. A CHECK is the last " +
        "line below every gate and test double, and for money_lines.direction/kind it is the ONLY guard " +
        "(no Zod counterpart). Add the row here naming the test that exercises it — §915 found FOUR that " +
        "§668's roster could not see, each enforced by the database and by nothing else. A changed value " +
        "list also lands here, which is deliberate: widening an enum is a decision, not a detail.",
    ).toEqual(c);
  });

  it("every classified constraint names a test file that exists and mentions the column", () => {
    // A weak link on purpose: it cannot tell whether that file ASSERTS anything about the column (§668's
    // roster does that). What it does catch is the row whose home was deleted or renamed underneath it.
    const broken: string[] = [];
    for (const c of CLASSIFIED) {
      const p = `${root}/${c.testedBy}`;
      if (!existsSync(p)) broken.push(`${c.file}:${c.column} → ${c.testedBy} DOES NOT EXIST`);
      else if (!readFileSync(p, "utf8").includes(c.column)) broken.push(`${c.file}:${c.column} → ${c.testedBy} never mentions "${c.column}"`);
    }
    expect(broken, `a CHECK's stated home no longer covers it:\n  ${broken.join("\n  ")}`).toEqual([]);
  });
});
