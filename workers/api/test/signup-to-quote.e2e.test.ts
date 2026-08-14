import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSheet } from "@shuddl/adapters";
import { applyMigrations } from "@shuddl/ledger/migrate";
import platformSql from "../../../db/control/migrations/0002_platform_tenant.sql?raw";
import controlPoolSql from "../../../db/control/migrations/0003_tenant_pool.sql?raw";
import brokerLoads from "../../../fixtures/migrator/broker-loads.csv?raw";
import { ensureSchema, ensureTenantBSchema, ensureTenantPlaneSchema } from "./helpers.js";
import { resolveTenantDb } from "../src/tenants.js";
import app from "../src/index.js";
import type { Env } from "../src/index.js";

// WP-14 Task 10 (REQ-121/025/127/151) — ACCEPTANCE DEMO #2, END TO END: a stranger signs up and quotes, UNASSISTED.
//
//   POST /pub/signup  (claims a pool slot, seeds a cold-start tariff, mints an admin session)
//     → POST /v1/import  (a messy spreadsheet → parties + shipments + no-silent-drop gap rows)
//     → POST /v1/rate    (a REAL priced SELL — the claimed tenant WRITING quote.priced through the now-wired sequencer)
//
// HONESTY NOTE (§1478) — the "<10 min" half of demo #2, stated to match `heartbeat.test.ts`'s note on the "<5s"
// half of demo #1. That bound is HUMAN time: a stranger reading a form, typing a company name, choosing a
// spreadsheet. It is not a machine latency, there is no human in a pool-workers harness, and NO minute count is
// asserted or fabricated here. What THIS test proves is the other half, and it is the half that decides whether
// the ten minutes are even possible: the chain is complete and UNASSISTED — signup claims a pool slot, the import
// lands parties + shipments + gap rows, and /v1/rate returns a REAL priced sell written to the claimed tenant's
// own D1, with no operator step anywhere in it. If any seam here needed a human, the demo would be impossible at
// any duration; because none does, the only thing between a stranger and a quote is their own typing.
//
// Recorded because the asymmetry was the defect: demo #1 declared its unasserted number and demo #2 did not, so a
// reader of the acceptance evidence could not tell whether "<10 min" was measured, waived, or forgotten.
//
// This is the WRITE-PATH proof of Task 10's gap-1 fix: BEFORE the fix the sequencer's #append resolved its D1 via
// the STATIC allowlist (tenantDb), so a CLAIMED (pool) tenant FORBIDDENed on any ledger append — /v1/rate would
// have surfaced that as a non-PRICED error, NOT a real quote. Now #resolveDb uses resolveTenantDb (static + claimed),
// so the signed-up tenant writes to its OWN pool D1. A PRICED response with a committed quote.priced in the pool D1
// (and NOT in tenant-a) is the demo. The same chain with the flag OFF is refused at signup (DARK).

// Flag ON (test-only): PROVISIONING_ENABLED own-prop over the real env prototype, so every binding still resolves
// through the chain (mirrors signup.test.ts / provision.test.ts). The DARK default (flag OFF) is the real worker.
const onEnv: Env = Object.assign(Object.create(env) as Env, { PROVISIONING_ENABLED: "true" });

const POOL_SLOTS = [
  { id: "_pool_01", binding: "TENANT_POOL_01_DB" },
  { id: "_pool_02", binding: "TENANT_POOL_02_DB" },
] as const;

type SignupOut = { session: string; workspace: { slug: string; plan: string; entry: string } };

function json(headers: Record<string, string>, body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

// Reset both pool sentinels to unclaimed + purge claimed admin/credits/tariff, so each test starts from a known
// 2-slot-unclaimed pool regardless of order (mirrors signup.test.ts resetPool).
async function resetPool(): Promise<void> {
  for (const { id, binding } of POOL_SLOTS) {
    await env.CONTROL_DB.prepare("DELETE FROM users WHERE tenant_id = ?").bind(id).run();
    // 2026-08-02 §15: the credits purge used to bind ONLY the slot id. Since the row is keyed by SLUG, that
    // deleted nothing — and with isolatedStorage:false every claimed tenant’s meter row survived the whole
    // run, so a future test claiming the same slug twice would hit UNIQUE(usage_credits.id) inside the
    // atomic batch and surface as PROVISION_FAILED rather than SLUG_TAKEN. Purge BOTH shapes: the slot id
    // (legacy rows) and whatever slug currently occupies the slot.
    // Purge EVERY non-static meter row, not just this slot occupant (2026-08-02 §17). The narrower
    // occupant-only purge still left rows behind and the api suite failed ~1 run in 5 with
    // "UNIQUE constraint failed: usage_credits.id" inside the atomic claim — surfacing as PROVISION_FAILED
    // across four files at once. usage_credits is keyed <slug>:<period>, so a row survives any reset that
    // does not know the slug AND period that wrote it; the only reliable predicate is "not a static tenant".
    // Nothing in workers/api writes a meter row for a static tenant (metering lives in the billing worker),
    // so this is exact rather than broad.
    await env.CONTROL_DB.prepare("DELETE FROM usage_credits WHERE tenant_id NOT IN (?, ?)").bind("tenant-a", "tenant-b").run();
    await env.CONTROL_DB
      .prepare("UPDATE tenants SET slug = ?, name = ?, plan = 'unclaimed', policy = ?, created_ts = 0 WHERE id = ?")
      .bind(id, `SHUDDL Pool Slot ${id}`, JSON.stringify({ pool_binding: binding }), id)
      .run();
    await env[binding].prepare("DELETE FROM rate_config").run();
  }
}

beforeAll(async () => {
  await ensureSchema(env); // control plane + tenant-a
  await ensureTenantBSchema(env);
  await applyMigrations(env.CONTROL_DB, [
    { path: "0002_platform_tenant.sql", sql: platformSql },
    { path: "0003_tenant_pool.sql", sql: controlPoolSql },
  ]);
  // The pool slots are pre-provisioned, MIGRATED tenant D1s in production — so import + rate can WRITE into a
  // claimed slot's own schema (events/parties/shipments/rate_config).
  for (const { binding } of POOL_SLOTS) await ensureTenantPlaneSchema(env[binding]);
});

beforeEach(resetPool);

const DIMS = { l_in: 48, w_in: 40, h_in: 48, pieces: 2 };
const PRICEABLE = { origin_zip: "97201", dest_zip: "80012", weight_lb: 1000, dims: DIMS };

describe("demo #2 — signup → import → first quote, UNASSISTED (flags ON)", () => {
  it("a stranger signs up, imports a messy file, and gets a REAL priced SELL — writing through the sequencer", async () => {
    // 1) SIGNUP — claims a pool slot + mints an admin session (cold-start tariff seeded into the pool D1).
    const signupRes = await app.fetch(
      new Request("https://api.local/pub/signup", json({}, { company: "Quotes R Us", email: "admin@e2e-quote.test", slug: "e2e-quote" })),
      onEnv,
    );
    expect(signupRes.status, await signupRes.clone().text()).toBe(201);
    const { session, workspace } = (await signupRes.json()) as SignupOut;
    expect(workspace.slug).toBe("e2e-quote");
    const authed = (extra: Record<string, string> = {}): Record<string, string> => ({ Authorization: `Bearer ${session}`, "Idempotency-Key": crypto.randomUUID(), ...extra });

    // 2) IMPORT — a messy spreadsheet becomes parties + shipments + no-silent-drop gap rows in the new workspace.
    const sheet = parseSheet(brokerLoads);
    const importRes = await app.fetch(new Request("https://api.local/v1/import", json(authed(), { sheet })), onEnv);
    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const imp = (await importRes.json()) as { parties_created: number; shipments_created: number; gap_rows: unknown[] };
    expect(imp.parties_created).toBeGreaterThan(0);
    expect(imp.shipments_created).toBeGreaterThan(0);
    expect(imp.gap_rows.length).toBeGreaterThan(0); // the no-silent-drop law surfaced the unmapped columns

    // 3) RATE — a REAL priced SELL. This APPENDS quote.priced THROUGH the sequencer onto the claimed tenant's OWN
    // pool D1 — the write path that FORBIDDENed before Task 10. A PRICED response proves the append succeeded.
    const shipmentId = `e2e-shp-${Date.now()}`;
    const rateRes = await app.fetch(
      new Request("https://api.local/v1/rate", json(authed(), { shipment_id: shipmentId, ...PRICEABLE })),
      onEnv,
    );
    expect(rateRes.status, await rateRes.clone().text()).toBe(200);
    const quote = (await rateRes.json()) as { status: string; sell_cents?: number };
    expect(quote.status).toBe("PRICED");
    expect(quote.sell_cents).toBeGreaterThan(0); // a real SELL, not UNKNOWN

    // WRITE-PATH PROOF (REQ-025): the quote.priced event landed on the CLAIMED tenant's OWN pool D1 …
    const poolDb = await resolveTenantDb(env, "e2e-quote");
    const priced = await poolDb
      .prepare("SELECT COUNT(*) AS n FROM events WHERE stream_id = ? AND kind = 'quote.priced'")
      .bind(`s:${shipmentId}`)
      .first<{ n: number }>();
    expect(priced!.n).toBe(1);
    // … and NOT on tenant-a (isolation holds — a claimed tenant writes ONLY its own D1).
    const leaked = await env.TENANT_A_DB
      .prepare("SELECT COUNT(*) AS n FROM events WHERE stream_id = ?")
      .bind(`s:${shipmentId}`)
      .first<{ n: number }>();
    expect(leaked!.n).toBe(0);
  });
});

describe("the SAME chain with the flag OFF is refused at signup (DARK)", () => {
  it("POST /pub/signup on the real worker (no flag) is 404 — the stranger never gets a session, so nothing follows", async () => {
    const res = await SELF.fetch(
      "https://api.local/pub/signup",
      json({}, { company: "No Flag Co", email: "a@e2e-dark.test", slug: "e2e-dark" }),
    );
    expect(res.status).toBe(404);
    const claimed = await env.CONTROL_DB.prepare("SELECT COUNT(*) AS n FROM tenants WHERE slug = ?").bind("e2e-dark").first<{ n: number }>();
    expect(claimed?.n).toBe(0); // nothing provisioned → no session → no import/quote possible
  });
});
