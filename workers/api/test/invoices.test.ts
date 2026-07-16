import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, ensureTenantBSchema, TENANT_SLUG, token } from "./helpers.js";

// ─── REQ-085 (WP-09 Task 7) — THE PORTAL INVOICES LIST ──────────────────────────────────────────────
//
// GET /v1/invoices returns the `invoices` read-model HEADERS scoped to the caller's lens:
//   - a portal party sees ONLY invoices billed to its party (invoices.party_id = claim party_id);
//   - ops/admin/finance/read (tenant lens) see EVERY in-tenant invoice;
//   - a driver has no billing relationship → an empty list (fail-closed).
//
// The party projection carries the SUMMARY only — NO `division` (internal org unit / margin dimension,
// REQ-057); margin/GL internals must not ride the counterparty list (REQ-179). The tenant handle is
// claim-keyed (tenantDb, REQ-025), so a cross-tenant read is impossible.
//
// isolatedStorage is OFF (all api test files share ONE D1) — every id here is prefixed `inv-` and unique.

const TENANT = TENANT_SLUG;

const PARTY_A = "inv-party-a"; // billed party on two invoices
const PARTY_B = "inv-party-b"; // billed party on one invoice
const INV_A1 = "inv-a-0001";
const INV_A2 = "inv-a-0002";
const INV_B1 = "inv-b-0001";
const INV_TENANT_B = "inv-tenantb-0001"; // lives ONLY in tenant-b's D1 (isolation proof)

const opsTok = (): Promise<string> => token({ sub: "inv-ops", tenant: TENANT, role: "ops" });
const portalTok = (partyId: string): Promise<string> =>
  token({ sub: `${partyId}-user`, tenant: TENANT, role: "portal", party_id: partyId });
const driverTok = (): Promise<string> => token({ sub: "inv-driver", tenant: TENANT, role: "driver" });

async function seedInvoice(
  db: D1Database,
  inv: { id: string; party_id: string; division?: string; total_cents: number; status?: string; issued_event_id: string },
): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO invoices (id, party_id, division, total_cents, status, issued_event_id) VALUES (?,?,?,?,?,?)")
    .bind(inv.id, inv.party_id, inv.division ?? "main", inv.total_cents, inv.status ?? "issued", inv.issued_event_id)
    .run();
}

interface InvoicesRes {
  status: number;
  invoices: Array<Record<string, unknown>>;
  body: string;
}
async function listInvoices(tok: string, query = ""): Promise<InvoicesRes> {
  const res = await SELF.fetch(`https://api.local/v1/invoices${query}`, { headers: { Authorization: `Bearer ${tok}` } });
  const body = await res.text();
  const parsed = res.status === 200 ? (JSON.parse(body) as { invoices: Array<Record<string, unknown>> }) : { invoices: [] };
  return { status: res.status, invoices: parsed.invoices, body };
}

const idsOf = (r: InvoicesRes): Set<string> => new Set(r.invoices.map((i) => i.id as string));

beforeAll(async () => {
  await ensureSchema(env);
  await ensureTenantBSchema(env);

  await seedInvoice(env.TENANT_A_DB, { id: INV_A1, party_id: PARTY_A, division: "west", total_cents: 120_000, issued_event_id: "evt-a1" });
  await seedInvoice(env.TENANT_A_DB, { id: INV_A2, party_id: PARTY_A, division: "east", total_cents: 55_000, issued_event_id: "evt-a2" });
  await seedInvoice(env.TENANT_A_DB, { id: INV_B1, party_id: PARTY_B, division: "west", total_cents: 90_000, issued_event_id: "evt-b1" });

  // tenant-b's OWN invoice — the isolation target. It must never surface through a tenant-a lens.
  await seedInvoice(env.TENANT_B_DB, { id: INV_TENANT_B, party_id: PARTY_A, division: "west", total_cents: 777_000, issued_event_id: "evt-tb" });
});

describe("GET /v1/invoices — party lens (portal)", () => {
  it("a portal party sees ONLY invoices billed to ITS party", async () => {
    const res = await listInvoices(await portalTok(PARTY_A));
    expect(res.status).toBe(200);
    const ids = idsOf(res);
    expect(ids.has(INV_A1)).toBe(true);
    expect(ids.has(INV_A2)).toBe(true);
    expect(ids.has(INV_B1)).toBe(false); // billed to PARTY_B — never in PARTY_A's list
    // every returned row is billed to the claim party
    for (const i of res.invoices) expect(i.party_id).toBe(PARTY_A);
  });

  it("a DIFFERENT party sees only its own invoice, never PARTY_A's", async () => {
    const res = await listInvoices(await portalTok(PARTY_B));
    const ids = idsOf(res);
    expect(ids.has(INV_B1)).toBe(true);
    expect(ids.has(INV_A1)).toBe(false);
    expect(ids.has(INV_A2)).toBe(false);
  });

  it("the party projection carries NO division (margin internal, REQ-179) — but keeps totals/status", async () => {
    const res = await listInvoices(await portalTok(PARTY_A));
    for (const i of res.invoices) {
      expect("division" in i).toBe(false);
      expect(i.total_cents).toBeTypeOf("number");
      expect(i.status).toBeDefined();
    }
    expect(res.body).not.toContain("division");
    expect(res.body).not.toContain("west"); // the division VALUE never appears in the party body
    expect(res.body).not.toContain("east");
  });

  it("a forged ?party_id never widens the party lens (the claim wins)", async () => {
    const tok = await portalTok(PARTY_B);
    const clean = await listInvoices(tok);
    const forged = await listInvoices(tok, `?party_id=${PARTY_A}`);
    expect(forged.status).toBe(200);
    expect(idsOf(forged).has(INV_A1)).toBe(false);
    expect(forged.body).toBe(clean.body); // identical — the query param is ignored
  });

  it("a portal party with NO invoices gets an empty list", async () => {
    const res = await listInvoices(await portalTok("inv-party-stranger"));
    expect(res.status).toBe(200);
    expect(res.invoices).toEqual([]);
  });
});

describe("GET /v1/invoices — tenant lens (ops) sees all, WITH division", () => {
  it("ops sees every in-tenant invoice, including division", async () => {
    const res = await listInvoices(await opsTok());
    expect(res.status).toBe(200);
    const ids = idsOf(res);
    expect(ids.has(INV_A1)).toBe(true);
    expect(ids.has(INV_A2)).toBe(true);
    expect(ids.has(INV_B1)).toBe(true);
    const a1 = res.invoices.find((i) => i.id === INV_A1)!;
    expect(a1.division).toBe("west"); // division is the tenant's own filterable dimension (REQ-057)
  });
});

describe("GET /v1/invoices — driver lens is empty (no billing relationship, fail-closed)", () => {
  it("a driver gets an empty list", async () => {
    const res = await listInvoices(await driverTok());
    expect(res.status).toBe(200);
    expect(res.invoices).toEqual([]);
  });
});

describe("GET /v1/invoices — tenant isolation (REQ-025)", () => {
  it("a tenant-a lens NEVER sees tenant-b's invoice (claim-keyed D1)", async () => {
    for (const tok of [await opsTok(), await portalTok(PARTY_A)]) {
      const res = await listInvoices(tok);
      expect(idsOf(res).has(INV_TENANT_B)).toBe(false);
      expect(res.body).not.toContain(INV_TENANT_B);
      expect(res.body).not.toContain("777000"); // tenant-b's distinctive total never leaks
    }
  });

  it("a tenant-b ops session sees tenant-b's invoice but NONE of tenant-a's", async () => {
    const tokB = await token({ sub: "inv-ops-b", tenant: "tenant-b", role: "ops" });
    const res = await listInvoices(tokB);
    expect(res.status).toBe(200);
    const ids = idsOf(res);
    expect(ids.has(INV_TENANT_B)).toBe(true);
    expect(ids.has(INV_A1)).toBe(false);
    expect(ids.has(INV_B1)).toBe(false);
  });
});
