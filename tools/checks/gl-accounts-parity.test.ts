import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_GL_ACCOUNTS,
  GL_FREIGHT_AR,
  GL_FSC_AR,
  GL_ACCESSORIAL_AR,
  GL_INTERLINE_AP,
  GL_COD_CLEARING,
  GL_SETTLEMENT_FEE,
  GL_AR_CONTROL,
  GL_AP_CONTROL,
  eventFixture,
} from "@shuddl/contracts";
import { projectMoneyLines } from "@shuddl/ledger/projection/money";
// Reach the Biller GL_MAP by RELATIVE path — @shuddl/agents is not (and must never become) a
// dependency of the ledger or contracts; this is the ONE layer (tools) that can see BOTH the compose
// side (agents) and the projection side (ledger) at once, so the parity guard lives here. Same
// cross-package reach the invoice-parity harness already uses (tools/rater/invoice-parity.ts).
import { GL_MAP } from "../../packages/agents/src/biller/gl-map.js";

// REQ-020 (share-lint-matchers-with-parity-tests) — ONE canonical chart-of-accounts, enforced over
// every surface that can emit a gl_map: the Biller compose path (GL_MAP), the ledger money projection
// (interline/cod/settle), the journal-export control accounts, and the vendored gl-netting fixture.
// The account STRINGS are frozen reality (real invoice.issued events carry them); this test proves the
// four surfaces agree on ONE set, so a future divergence is a red test, not a silent penny-break in the
// QB export (Task-3 qb-journal-month reconciles a real invoice month against this same chart).

// Collect every gl_map string the ledger money PROJECTION assigns for the non-invoice money kinds —
// the kinds whose account is chosen by the projection itself, not passed through from the payload.
// (invoice.issued/corrected pass gl_map through from the payload, so their canonical source is GL_MAP,
// asserted separately below — feeding them synthetic payloads here would prove nothing.)
function projectionEmittedAccounts(): string[] {
  const out: string[] = [];
  const split = eventFixture("split.computed", {
    payload: {
      total_cents: 100_000,
      allocations: [
        { party_id: "carrier-a", share_bps: 7_000 },
        { party_id: "carrier-b", share_bps: 3_000 },
      ],
    },
  });
  const cod = eventFixture("payment.received", {
    payload: { method: "cod", amount_cents: 50_000, party_id: "party-bill", division: "north" },
  });
  const settle = eventFixture("settlement.executed", {
    payload: { fee_cents: 2_500, party_id: "factor-x", division: "north" },
  });
  for (const l of projectMoneyLines(split, { division: "north" }).lines) out.push(l.gl_map);
  for (const l of projectMoneyLines(cod, {}).lines) out.push(l.gl_map);
  for (const l of projectMoneyLines(settle, {}).lines) out.push(l.gl_map);
  return out;
}

// Every gl_map string carried by the vendored gl-netting fixture (both issued lines and reissue lines).
function fixtureAccounts(): string[] {
  type Line = { gl_map: string };
  type Ev = { lines?: Line[]; reissue_lines?: Line[] };
  const seed = JSON.parse(readFileSync("fixtures/gl-netting/seed.json", "utf8")) as { events: Ev[] };
  const out: string[] = [];
  for (const e of seed.events) {
    for (const l of e.lines ?? []) out.push(l.gl_map);
    for (const l of e.reissue_lines ?? []) out.push(l.gl_map);
  }
  return out;
}

describe("REQ-020 — one canonical chart-of-accounts across every gl_map-emitting surface", () => {
  it("the Biller compose path (GL_MAP) emits only canonical accounts", () => {
    const emitted = Object.values(GL_MAP);
    expect(emitted.length).toBeGreaterThan(0);
    for (const account of emitted) {
      expect(CANONICAL_GL_ACCOUNTS.has(account)).toBe(true);
    }
  });

  it("the ledger money projection emits only canonical accounts (interline/cod/settle)", () => {
    const emitted = projectionEmittedAccounts();
    // interline_split, cod_collect, settle_fee each posted exactly one line.
    expect(emitted).toEqual([GL_INTERLINE_AP, GL_INTERLINE_AP, GL_COD_CLEARING, GL_SETTLEMENT_FEE]);
    for (const account of emitted) {
      expect(CANONICAL_GL_ACCOUNTS.has(account)).toBe(true);
    }
  });

  it("the journal-export control accounts are canonical", () => {
    expect(CANONICAL_GL_ACCOUNTS.has(GL_AR_CONTROL)).toBe(true);
    expect(CANONICAL_GL_ACCOUNTS.has(GL_AP_CONTROL)).toBe(true);
  });

  it("the vendored gl-netting fixture carries only canonical accounts", () => {
    const emitted = fixtureAccounts();
    expect(emitted.length).toBeGreaterThan(0);
    for (const account of emitted) {
      expect(CANONICAL_GL_ACCOUNTS.has(account)).toBe(true);
    }
  });

  it("the fixture's freight/fsc/accessorial codes are EXACTLY the compose-path codes (no divergence)", () => {
    const seedAccounts = new Set(fixtureAccounts());
    // The fixture replays real invoice.issued reality — its per-kind codes must equal what the Biller
    // would emit, so the Task-3 QB reconcile matches to the penny.
    expect(seedAccounts.has(GL_MAP.freight)).toBe(true);
    expect(seedAccounts.has(GL_MAP.fsc)).toBe(true);
    expect(seedAccounts.has(GL_MAP.accessorial)).toBe(true);
    expect(seedAccounts.has(GL_FREIGHT_AR)).toBe(true);
    expect(seedAccounts.has(GL_FSC_AR)).toBe(true);
    expect(seedAccounts.has(GL_ACCESSORIAL_AR)).toBe(true);
    // ...and NOTHING outside the canonical set leaks in.
    for (const account of seedAccounts) {
      expect(CANONICAL_GL_ACCOUNTS.has(account)).toBe(true);
    }
  });

  it("the canonical set is exactly the union of every emitting surface (no orphan account)", () => {
    const union = new Set<string>([
      ...Object.values(GL_MAP),
      ...projectionEmittedAccounts(),
      GL_AR_CONTROL,
      GL_AP_CONTROL,
    ]);
    // Every canonical account is emitted by SOME surface (no dead registry entry), and every emitted
    // account is canonical (asserted per-surface above) — the set and the surfaces are one closed system.
    expect(new Set(CANONICAL_GL_ACCOUNTS)).toEqual(union);
  });
});
