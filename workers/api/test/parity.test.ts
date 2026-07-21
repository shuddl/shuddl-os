import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, token, TENANT_SLUG } from "./helpers.js";
import { eventFixture, type EventKind, type LedgerEvent } from "@shuddl/contracts";
import { eventToRow } from "@shuddl/ledger/lens";
import { computeAllParity, PARITY_MODULES, type ModuleParity } from "@shuddl/ledger/parity";

// WP-15 Task 6 (REQ-023/152/153) — the v_parity BACKEND COMPUTE route. GET /v1/parity surfaces the 5 overlay
// modules' native-vs-legacy shadow parity, each a REAL number or the literal "UNKNOWN" with backing_kinds — the
// SAME @shuddl/ledger/parity primitive the flip guard (Task 3) and the Watchtower (Task 8) consume (no drift).
//
// These tests assert the ROUTE contract (shape, roles, tenant-scoping, primitive-equivalence, fail-closed).
// The DETERMINISTIC drift/anti-false-green correctness lives in the ledger package (packages/ledger/test/
// parity.test.ts, isolatedStorage per-test). The api test D1 is SHARED across files (isolatedStorage off), so a
// whole-tenant parity read reflects other suites' native events — hence the route test proves wiring, not exact
// drift. No api suite seeds `source:'legacy'`, so the honest baseline here is "no legacy mirror ⇒ UNKNOWN".

let hashN = 0xa11000;
const nextHash = (): string => (hashN++).toString(16).padStart(64, "0");

async function seedEvent(
  db: D1Database,
  kind: EventKind,
  o: { shipmentId: string; seq: number; source: LedgerEvent["source"]; payload?: Record<string, unknown> },
): Promise<void> {
  const overrides: Record<string, unknown> = {
    id: crypto.randomUUID(),
    stream_id: `s:${o.shipmentId}`,
    shipment_id: o.shipmentId,
    seq: o.seq,
    source: o.source,
    visibility: "internal",
    party_refs: [],
  };
  if (o.payload !== undefined) overrides.payload = o.payload;
  const e = eventFixture(kind, overrides);
  const row = eventToRow(e);
  row.hash = nextHash();
  const cols = Object.keys(row);
  await db
    .prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .bind(...cols.map((c) => row[c]))
    .run();
}

const invoicePayload = (total: number): Record<string, unknown> => ({
  invoice_id: `inv-${total}`,
  party_id: "party-bill-to",
  division: "main",
  lines: [{ line_no: 1, kind: "freight", amount_cents: total, gl_map: "4000-REV" }],
});

type Body = { modules: ModuleParity[] };
async function getParity(tok: string): Promise<{ status: number; modules: ModuleParity[] }> {
  const res = await SELF.fetch("https://api.local/v1/parity", { headers: { Authorization: `Bearer ${tok}` } });
  const body = (await res.json().catch(() => ({}))) as Partial<Body>;
  return { status: res.status, modules: body.modules ?? [] };
}

beforeAll(async () => {
  await ensureSchema(env);
});

describe("GET /v1/parity — the v_parity overlay dashboard compute (REQ-023/152/153)", () => {
  it("returns the 5 overlay modules in order; each value is a number or the literal UNKNOWN; backing_kinds non-empty", async () => {
    const ops = await token({ sub: "parity-ops", tenant: TENANT_SLUG, role: "ops" });
    const r = await getParity(ops);
    expect(r.status).toBe(200);
    expect(r.modules.map((m) => m.module)).toEqual([...PARITY_MODULES]);
    for (const m of r.modules) {
      expect(m.native_value === "UNKNOWN" || typeof m.native_value === "number").toBe(true);
      expect(m.legacy_value === "UNKNOWN" || typeof m.legacy_value === "number").toBe(true);
      expect(m.drift_bps === "UNKNOWN" || typeof m.drift_bps === "number").toBe(true);
      expect(typeof m.within_gate).toBe("boolean");
      expect(["MATCH", "DRIFT", "UNKNOWN"]).toContain(m.status);
      expect(Array.isArray(m.backing_kinds)).toBe(true);
      expect(m.backing_kinds.length).toBeGreaterThan(0);
    }
  });

  it("REUSES the shared primitive: the route body equals computeAllParity over the same tenant D1 (no second compute)", async () => {
    const ops = await token({ sub: "parity-eq", tenant: TENANT_SLUG, role: "ops" });
    const r = await getParity(ops);
    const direct = await computeAllParity(env.TENANT_A_DB);
    expect(r.modules).toEqual(direct); // byte-for-byte the primitive's output — the route never recomputes a second way
  });

  it("HONESTY: any module the route reports UNKNOWN is within_gate:false (fail-closed — never a green off a missing side)", async () => {
    const ops = await token({ sub: "parity-honest", tenant: TENANT_SLUG, role: "ops" });
    const r = await getParity(ops);
    for (const m of r.modules) {
      if (m.status === "UNKNOWN") {
        expect(m.within_gate).toBe(false);
        expect(m.drift_bps).toBe("UNKNOWN");
      }
    }
  });

  it("surfaces a seeded legacy mirror end-to-end: with both a native AND a legacy invoice.issued, invoicing is no longer UNKNOWN", async () => {
    // Seed the ONLY legacy invoice in the tenant D1 (77_777) + a native invoice (so the native side is present
    // regardless of file order). legacy_value is deterministic (I am the sole legacy seeder); status is MATCH/DRIFT.
    await seedEvent(env.TENANT_A_DB, "invoice.issued", { shipmentId: "parity-nat-inv", seq: 0, source: "native", payload: invoicePayload(80_000) });
    await seedEvent(env.TENANT_A_DB, "invoice.issued", { shipmentId: "parity-leg-inv", seq: 0, source: "legacy", payload: invoicePayload(77_777) });
    const ops = await token({ sub: "parity-both", tenant: TENANT_SLUG, role: "ops" });
    const r = await getParity(ops);
    const invoicing = r.modules.find((m) => m.module === "invoicing") as ModuleParity;
    expect(invoicing.legacy_value).toBe(77_777); // the one legacy mirror total, surfaced honestly
    expect(typeof invoicing.native_value).toBe("number"); // native side present
    expect(invoicing.status).not.toBe("UNKNOWN"); // both sides present ⇒ a real MATCH/DRIFT verdict
    expect(typeof invoicing.within_gate).toBe("boolean");
  });

  it("role-gates like the KPI strip: admin/ops/finance/read see it (200); driver and portal do not (403)", async () => {
    const admin = await token({ sub: "parity-admin", tenant: TENANT_SLUG, role: "admin" });
    const finance = await token({ sub: "parity-fin", tenant: TENANT_SLUG, role: "finance" });
    const read = await token({ sub: "parity-read", tenant: TENANT_SLUG, role: "read" });
    const driver = await token({ sub: "parity-driver", tenant: TENANT_SLUG, role: "driver" });
    const portal = await token({ sub: "parity-portal", tenant: TENANT_SLUG, role: "portal", party_id: "party-bill-to" });
    expect((await getParity(admin)).status).toBe(200);
    expect((await getParity(finance)).status).toBe(200);
    expect((await getParity(read)).status).toBe(200);
    expect((await getParity(driver)).status).toBe(403);
    expect((await getParity(portal)).status).toBe(403);
  });
});
