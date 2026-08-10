import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LedgerEvent, Visibility, eventFixture } from "@shuddl/contracts";
import { repoRoot } from "./repo-root.js";

// §915 — TWO MECHANISMS ENFORCE THE EVENT DOMAINS; THEY MUST AGREE.
//
// `events.visibility` and `events.source` are each constrained TWICE: by a Zod enum at the API boundary,
// and by a `CHECK (col IN (...))` in `0001_ledger_core.sql`. Neither duplication is wrong — the Zod side
// covers every path that parses a LedgerEvent, and the CHECK covers the paths that do NOT (a migration
// backfill, a seed loader, a repair script, a console write). The schema constraint is the last line.
//
// But two hand-written copies of one domain drift, and the drift is silent in the direction that matters:
// WIDEN the Zod enum without widening the CHECK and every write of the new value fails at the DB with a
// constraint error rather than a clean 400. Widen the CHECK without widening Zod and the schema stops
// documenting what can actually be stored. §912 found exactly this shape in a mirrored `superRefine`,
// where each copy was tested for a different subset and the pair read as covered while neither was.
//
// MEASURED AT §915: both pairs agree today. This is the scan that keeps them agreeing — the same
// share-lint-matchers-with-parity-tests rule the GL chart-of-accounts guard next door already applies.
//
// WHAT THIS DOES NOT DO. It proves the two DOMAINS match, not that either is right. And it reads the
// CHECK out of migration SQL by regex, so a CHECK written in a shape this regex cannot see would read as
// absent — which is why the non-vacuity case below asserts a real population rather than trusting silence.

const LEDGER_CORE = "db/tenant/migrations/0001_ledger_core.sql";

/**
 * The value list of a `CHECK (<column> IN ('a','b',…))` in a migration, read from the SQL rather than
 * restated here. §830's rule: read one side and COMPUTE the other, so this gate cannot drift from the
 * thing it checks — a copied list agrees on the day it is written and never again.
 */
function checkDomain(sql: string, column: string): string[] {
  const re = new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)\\s*\\)`, "i");
  const m = re.exec(sql);
  if (m === null) return [];
  return [...(m[1] as string).matchAll(/'([^']*)'/g)].map((x) => x[1] as string);
}

describe("§915: the Zod enum and the D1 CHECK constrain the same domain", () => {
  const sql = readFileSync(`${repoRoot()}/${LEDGER_CORE}`, "utf8");
  const dbVisibility = checkDomain(sql, "visibility");
  const dbSource = checkDomain(sql, "source");

  it("both CHECK domains parse (non-vacuity — an empty set agrees with everything)", () => {
    // A reworded CHECK, a renamed migration, or a broken read yields [] and every assertion below passes
    // over nothing — the failure this repo met in four gates (§487/§554/§572).
    expect(dbVisibility.length, `no visibility CHECK domain parsed from ${LEDGER_CORE} — the scan is broken, not the schema`).toBeGreaterThanOrEqual(3);
    expect(dbSource.length, `no source CHECK domain parsed from ${LEDGER_CORE} — the scan is broken, not the schema`).toBeGreaterThanOrEqual(4);
  });

  it("visibility: the Zod enum and the CHECK list are the SAME set", () => {
    // Both sides are available as data here, so this is a true set comparison in both directions —
    // widening either one alone turns it red.
    expect([...dbVisibility].sort(), "events.visibility has drifted between the Zod enum and the D1 CHECK").toEqual([...Visibility.options].sort());
  });

  it("source: every value the CHECK admits, Zod admits — and a value outside it, Zod refuses", () => {
    // `source` is an inline `z.enum([...])` rather than a named export, so it cannot be compared as a set
    // the way visibility is. This asserts the same property BEHAVIOURALLY, which is stronger per value and
    // weaker in coverage: it cannot see a value Zod admits that the CHECK omits, unless that value is
    // probed. The sentinel below is the one probe.
    const base = eventFixture("quote.requested") as Record<string, unknown>;
    for (const v of dbSource) {
      const r = LedgerEvent.safeParse({ ...base, source: v });
      expect(r.success, `the D1 CHECK admits source='${v}' but Zod refuses it — a row the schema allows can never be written through the API`).toBe(true);
    }
    const outside = "carrier-pigeon";
    expect(dbSource, "the sentinel must be outside the CHECK domain or this proves nothing").not.toContain(outside);
    expect(LedgerEvent.safeParse({ ...base, source: outside }).success, "Zod admits a source the D1 CHECK would reject at write time").toBe(false);
  });

  it("visibility, the same behavioural direction (the CHECK and the parser must not disagree per value)", () => {
    const base = eventFixture("quote.requested") as Record<string, unknown>;
    for (const v of dbVisibility) {
      expect(LedgerEvent.safeParse({ ...base, visibility: v }).success, `the D1 CHECK admits visibility='${v}' but Zod refuses it`).toBe(true);
    }
    expect(LedgerEvent.safeParse({ ...base, visibility: "everyone" }).success).toBe(false);
  });
});
