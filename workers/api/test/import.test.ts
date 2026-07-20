import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { parseSheet } from "@shuddl/adapters";
import { ensureSchema, ensureTenantBSchema, token, TENANT_SLUG } from "./helpers.js";
import brokerLoads from "../../../fixtures/migrator/broker-loads.csv?raw";
import messyShipments from "../../../fixtures/migrator/messy-shipments.csv?raw";
import tlDispatch from "../../../fixtures/migrator/tl-dispatch.csv?raw";
import collidingHeaders from "../../../fixtures/migrator/colliding-headers.csv?raw";

// WP-14 Task 5 (REQ-127/035/025/030) — THE MIGRATOR DRAG-DROP IMPORT. A stranger drag-drops their messy
// spreadsheet → parties/shipments in their workspace. THE LAWS under test (the DoD):
//   · 3 messy files import → parties/shipments created; a re-import (fresh Idempotency-Key) makes NO dupes.
//   · THE NO-SILENT-DROP LAW: every unmapped column raises EXACTLY ONE `migrator.unmapped_column` anomaly —
//     columns↔anomalies count with zero silent drops.
//   · a <0.8-confidence mapping is QUEUED for review (a `migrator.low_confidence_column` gap), NOT applied.
//   · retained-but-unmapped values land on shipments.refs / parties.external_refs (nothing lost).
//   · the import is TENANT-SCOPED (REQ-025) — an import into tenant-a never writes tenant-b.
//
// isolatedStorage is OFF (shared D1): the fixtures use their own party names/emails, and every DB assertion is
// scoped by the returned `import_id` (or the fixture's own values), so other files' rows never contaminate a count.

const TENANT = TENANT_SLUG;
const opsTok = (): Promise<string> => token({ sub: "im-ops", tenant: TENANT, role: "ops" });

interface Res {
  status: number;
  json: Record<string, unknown> | null;
}
async function doImport(raw: string, tok: string, key = crypto.randomUUID()): Promise<Res> {
  const sheet = parseSheet(raw);
  const res = await SELF.fetch("https://api.local/v1/import", {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": key, "content-type": "application/json" },
    body: JSON.stringify({ sheet }),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function anomalyCount(db: D1Database, rule: string, importId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM anomalies WHERE rule = ? AND json_extract(detail, '$.import_id') = ?")
    .bind(rule, importId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  await ensureSchema(env);
  await ensureTenantBSchema(env); // REQ-025 — the tenant-scope assertion reads TENANT_B_DB
});

describe("the 3 messy files import → parties + shipments (idempotent)", () => {
  it("broker-loads imports parties + 3 shipments; a re-import (fresh key) makes NO dupes", async () => {
    const ops = await opsTok();
    const first = await doImport(brokerLoads, ops);
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json?.shipments_created).toBe(3);
    expect((first.json?.parties_created as number)).toBeGreaterThan(0);

    // The specific parties exist (the bill_to carries its email; the consignee is name-only).
    const acme = await env.TENANT_A_DB.prepare("SELECT p.id AS id FROM parties p, json_each(p.contacts) je WHERE lower(json_extract(je.value,'$.email')) = 'ops@acme.example'").first();
    expect(acme).not.toBeNull();

    // DOMAIN idempotency: a re-import with a DIFFERENT Idempotency-Key (bypasses the HTTP replay cache) still
    // dedupes — content-derived ids collapse under INSERT OR IGNORE. No new party, no new shipment.
    const second = await doImport(brokerLoads, ops);
    expect(second.status).toBe(200);
    expect(second.json?.parties_created).toBe(0);
    expect(second.json?.shipments_created).toBe(0);
    expect(second.json?.import_id).toBe(first.json?.import_id); // same content ⇒ same import id
  });

  it("all three fixtures import cleanly", async () => {
    const ops = await opsTok();
    for (const raw of [messyShipments, tlDispatch]) {
      const r = await doImport(raw, ops);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect((r.json?.shipments_created as number)).toBeGreaterThan(0);
    }
  });
});

describe("THE LAW — every unmapped column raises EXACTLY ONE anomaly (zero silent drops)", () => {
  it("broker-loads: 3 unmapped columns ⇒ 3 migrator.unmapped_column anomalies", async () => {
    const ops = await opsTok();
    const r = await doImport(brokerLoads, ops);
    const importId = r.json?.import_id as string;
    // The route's own count of unmapped columns…
    expect(r.json?.unmapped_columns).toBe(3);
    // …equals the number of durable anomaly rows (rule migrator.unmapped_column) for THIS import — no drop, no dup.
    expect(await anomalyCount(env.TENANT_A_DB, "migrator.unmapped_column", importId)).toBe(3);
    // Each anomaly is object_kind='import_field', severity='warn', status='open', with a sample in the detail.
    const rows = await env.TENANT_A_DB
      .prepare("SELECT object_kind, severity, status, detail FROM anomalies WHERE rule='migrator.unmapped_column' AND json_extract(detail,'$.import_id')=?")
      .bind(importId)
      .all<{ object_kind: string; severity: string; status: string; detail: string }>();
    for (const row of rows.results) {
      expect(row.object_kind).toBe("import_field");
      expect(row.severity).toBe("warn");
      expect(row.status).toBe("open");
    }
    // Re-import does NOT duplicate the anomalies (content-stable ids).
    await doImport(brokerLoads, ops);
    expect(await anomalyCount(env.TENANT_A_DB, "migrator.unmapped_column", importId)).toBe(3);
  });
});

describe("THE LAW — a <0.8 mapping is queued for review, NOT silently applied", () => {
  it("messy-shipments: Zip + Reference raise low_confidence anomalies and are NOT applied to their fields", async () => {
    const ops = await opsTok();
    const r = await doImport(messyShipments, ops);
    const importId = r.json?.import_id as string;
    expect(r.json?.low_confidence_columns).toBe(2);
    expect(await anomalyCount(env.TENANT_A_DB, "migrator.low_confidence_column", importId)).toBe(2);
    expect(await anomalyCount(env.TENANT_A_DB, "migrator.unmapped_column", importId)).toBe(1); // Commodity

    // The shipment applied dest_zip but NEVER applied the low-confidence origin_zip/pro — those values are
    // retained under their ORIGINAL header instead (nothing lost, nothing silently mapped).
    const shp = await env.TENANT_A_DB
      .prepare("SELECT refs FROM shipments WHERE json_extract(refs,'$.dest_zip')='80012' LIMIT 1")
      .first<{ refs: string }>();
    expect(shp).not.toBeNull();
    const refs = JSON.parse(shp!.refs) as Record<string, string>;
    expect(refs["origin_zip"]).toBeUndefined(); // NOT applied
    expect(refs["pro"]).toBeUndefined(); // NOT applied
    expect(refs["Zip"]).toBe("97201"); // retained under the original header
    expect(refs["Reference"]).toBe("REF-55");
    expect(refs["Commodity"]).toBe("Palletized goods"); // the unmapped column's value, retained
  });
});

describe("THE LAW — colliding / duplicate columns: airtight column↔anomaly count, zero silent drops", () => {
  async function migAnomalyCount(importId: string): Promise<number> {
    const row = await env.TENANT_A_DB
      .prepare("SELECT COUNT(*) AS n FROM anomalies WHERE rule LIKE 'migrator.%' AND json_extract(detail,'$.import_id') = ?")
      .bind(importId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  it("Customer,Notes,Notes: TWO distinct anomaly rows persist (not one) and BOTH values survive", async () => {
    const ops = await opsTok();
    const sheet = { headers: ["Customer", "Notes", "Notes"], rows: [["Acme Coll1", "First", "Second"]] };
    const res = await SELF.fetch("https://api.local/v1/import", {
      method: "POST",
      headers: { Authorization: `Bearer ${ops}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
      body: JSON.stringify({ sheet }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    const importId = json.import_id as string;
    // TWO durable anomaly rows for the two Notes columns — the id must include the ordinal, not collapse to one.
    expect(await migAnomalyCount(importId)).toBe(2);
    // Both note values survive on the shipment refs under distinct keys.
    const shp = await env.TENANT_A_DB
      .prepare("SELECT refs FROM shipments WHERE json_extract(refs,'$.pro') IS NULL AND shipper_party_id IN (SELECT id FROM parties WHERE json_extract(names,'$.legal')='Acme Coll1') LIMIT 1")
      .first<{ refs: string }>();
    const refs = JSON.parse(shp!.refs) as Record<string, string>;
    const noteVals = Object.values(refs).filter((v) => v === "First" || v === "Second");
    expect(new Set(noteVals)).toEqual(new Set(["First", "Second"]));
  });

  it("colliding-headers.csv: count(gap columns) === count(migrator anomaly rows), EXACTLY", async () => {
    const ops = await opsTok();
    const r = await doImport(collidingHeaders, ops);
    const importId = r.json?.import_id as string;
    const gaps = (r.json?.unmapped_columns as number) + (r.json?.low_confidence_columns as number) + (r.json?.duplicate_columns as number);
    expect(gaps).toBe(5);
    expect(await migAnomalyCount(importId)).toBe(5); // airtight — one anomaly per gap column
  });
});

describe("nothing lost — retained values ride refs (shipment) / external_refs (party)", () => {
  it("broker-loads: unmapped values ride shipment refs; the party-scoped Phone rides parties.external_refs", async () => {
    const ops = await opsTok();
    await doImport(brokerLoads, ops);

    const shp = await env.TENANT_A_DB
      .prepare("SELECT refs FROM shipments WHERE json_extract(refs,'$.pro')='PRO123456' LIMIT 1")
      .first<{ refs: string }>();
    const refs = JSON.parse(shp!.refs) as Record<string, string>;
    expect(refs["Special Instructions"]).toBe("Liftgate, call ahead");
    expect(refs["Salesperson"]).toBe("Dana");
    expect(refs["Phone"]).toBeUndefined(); // Phone is party-scoped, NOT on the shipment

    const party = await env.TENANT_A_DB
      .prepare("SELECT external_refs FROM parties WHERE json_extract(external_refs,'$.Phone')='555-0100' LIMIT 1")
      .first<{ external_refs: string }>();
    expect(party).not.toBeNull(); // the retained Phone rode the bill_to party's external_refs
  });
});

describe("REQ-025 — the import is tenant-scoped", () => {
  it("an import into tenant-a writes NOTHING to tenant-b", async () => {
    const ops = await opsTok();
    const r = await doImport(tlDispatch, ops);
    const importId = r.json?.import_id as string;
    expect(r.status).toBe(200);
    // tenant-a got the anomaly; tenant-b's DB never saw this import.
    expect(await anomalyCount(env.TENANT_A_DB, "migrator.unmapped_column", importId)).toBeGreaterThan(0);
    expect(await anomalyCount(env.TENANT_B_DB, "migrator.unmapped_column", importId)).toBe(0);
    const bShipments = await env.TENANT_B_DB
      .prepare("SELECT COUNT(*) AS n FROM shipments WHERE json_extract(refs,'$.Notes')='Team drivers, hazmat'")
      .first<{ n: number }>();
    expect(bShipments?.n).toBe(0);
  });
});

describe("the migrator run is recorded to agent_runs (idempotent)", () => {
  it("records one migrator run per import content, with the per-field confidence on its basis", async () => {
    const ops = await opsTok();
    const r = await doImport(brokerLoads, ops);
    const importId = r.json?.import_id as string;
    const run = await env.TENANT_A_DB
      .prepare("SELECT agent, basis, confidence FROM agent_runs WHERE id = ?")
      .bind(`migrator:${importId}`)
      .first<{ agent: string; basis: string; confidence: number | null }>();
    expect(run?.agent).toBe("migrator");
    const basis = JSON.parse(run!.basis) as { field_confidence: Record<string, number> };
    expect(Object.keys(basis.field_confidence).length).toBeGreaterThan(0); // per-field confidence recorded
  });
});

describe("role gating (admin/ops only)", () => {
  it("portal / driver / read / finance are 403 on /v1/import", async () => {
    const sheet = parseSheet(brokerLoads);
    for (const role of ["portal", "driver", "read", "finance"] as const) {
      const tok = await token({ sub: `im-${role}`, tenant: TENANT, role, ...(role === "portal" ? { party_id: "im-p" } : {}) });
      const res = await SELF.fetch("https://api.local/v1/import", {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
        body: JSON.stringify({ sheet }),
      });
      expect(res.status, role).toBe(403);
    }
  });
});
