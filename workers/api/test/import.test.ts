import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { parseSheet } from "@shuddl/adapters";
import { ensureSchema, ensureTenantBSchema, token, TENANT_SLUG } from "./helpers.js";
import brokerLoads from "../../../fixtures/migrator/broker-loads.csv?raw";
import messyShipments from "../../../fixtures/migrator/messy-shipments.csv?raw";
import tlDispatch from "../../../fixtures/migrator/tl-dispatch.csv?raw";
import collidingHeaders from "../../../fixtures/migrator/colliding-headers.csv?raw";
import laneRates from "../../../fixtures/migrator/lane-rates.csv?raw";

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

// §1535 (REQ-035/195/017) — THE TWO WRITERS OF `shipments.refs` ARE BOUNDED DIFFERENTLY, ON PURPOSE.
//
// §1534 capped the ROUTE at `MAX_REF_KEYS = 64` after measuring 2.1 MB stored from one authed request. Its
// reopen trigger asked the obvious question: the IMPORT path also writes `refs` — the no-silent-drop values
// of every unmapped column (rule 10) — and a legacy export carries up to 171 of them. If the cap reached
// here it would DROP those values, which is the one thing that law forbids.
//
// It does not reach here: `import.ts` calls `materializeShipment` directly, never `ShipmentBody`. That is not
// a hole — the import path has its own ceiling, `MAX_COLS = 200` headers × `MAX_CELL = 2000` chars — so both
// writers are bounded and the numbers differ because the reasons do: a client naming its own refs has no
// business sending 65, and a legacy sheet's unmapped columns must ride or be lost.
//
// This case exists so that asymmetry is MEASURED rather than assumed. It is the shape of regression a
// bound-adding phase creates: the cap is right where it is and wrong one function deeper.
describe("§1535 — a legacy sheet's unmapped columns still ride refs (the §1534 cap does not reach this path)", () => {
  it("100 unmapped columns import cleanly, and their values are retained on the shipment", async () => {
    const cols = 100;
    const headers = ["shipper_name", "consignee_name", "bill_to_name", ...Array.from({ length: cols }, (_, i) => `legacy_col_${i}`)];
    const row = ["Acme Shipper", "Beta Consignee", "Gamma Broker", ...Array.from({ length: cols }, (_, i) => `v${i}`)];
    const res = await SELF.fetch("https://api.local/v1/import", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        Authorization: `Bearer ${await token({ sub: "u1", tenant: "tenant-a", role: "ops" })}`,
      },
      body: JSON.stringify({ sheet: { headers, rows: [row] } }),
    });
    expect(res.status, `${cols} unmapped columns must import — the §1534 route cap must not reach materializeShipment`).toBe(200);
    const stored = await env.TENANT_A_DB.prepare("SELECT MAX(length(refs)) AS n FROM shipments").first<{ n: number }>();
    expect(stored?.n, "nothing rode refs — rule 10's no-silent-drop half is what this path exists for").toBeGreaterThan(1_000);
  });
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

describe("THE LAW — a rate-sheet import flags every non-rate column + the unconsumed rows", () => {
  async function migAnomalyCount(importId: string): Promise<number> {
    const row = await env.TENANT_A_DB
      .prepare("SELECT COUNT(*) AS n FROM anomalies WHERE rule LIKE 'migrator.%' AND json_extract(detail,'$.import_id') = ?")
      .bind(importId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  it("seeds a tariff AND writes count(non-rate cols)+1 anomaly rows — the rate path is no longer a silent sink", async () => {
    const ops = await opsTok();
    const r = await doImport(laneRates, ops);
    const importId = r.json?.import_id as string;
    expect(r.json?.rate_seeded).toBe(true);
    // 5 non-rate columns (origin_zip, dest_zip, weight_break, fuel_surcharge, effective_date) + 1 unconsumed-rows flag.
    expect(await migAnomalyCount(importId)).toBe(6);
    expect(r.json?.unmapped_columns).toBe(6);
    // Targeted cleanup so the seeded tariff never bleeds into another suite on the shared D1 (approved_by is unique).
    await env.TENANT_A_DB.prepare("DELETE FROM rate_config WHERE approved_by = 'migrator:im-ops'").run();
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

// §914 — THE IMPORT BODY MUST NAME EXACTLY ONE SOURCE, AND NOTHING PROVED IT.
//
// `ImportBody`'s XOR refine (`provide exactly one of sheet | r2_key`) was UNTESTED: neutralising it left
// the whole api suite green. Found by mutating every Zod refine outside packages/contracts, not by reading.
//
// It is load-bearing twice over. The route's else-branch reads `body.r2_key!` — a non-null assertion whose
// only justification IS this refine — so without it:
//   · NEITHER source ⇒ the key becomes `<tenant>/imports/undefined`, R2 misses, and a malformed request is
//     reported as **404 UPLOADED FILE NOT FOUND** instead of a 400. A validation fault wearing a not-found
//     coat is the kind of error that sends an integrator hunting for a file they never uploaded.
//   · BOTH sources ⇒ the inline sheet silently wins and `r2_key` is ignored, so a caller who uploaded a file
//     imports something else and is told it succeeded. On the migrator path, where the governing law is that
//     nothing is dropped silently, importing the WRONG SOURCE silently is the same defect one level up.
describe("REQ-127/035: the import body names EXACTLY ONE source (sheet XOR r2_key)", () => {
  const postBody = async (body: unknown): Promise<Res> => {
    const res = await SELF.fetch("https://api.local/v1/import", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await opsTok()}`,
        "Idempotency-Key": crypto.randomUUID(),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  };

  it("accepts a sheet-only body — the control that isolates the XOR from every other rule in the schema", async () => {
    const { status, json } = await postBody({ sheet: parseSheet(brokerLoads) });
    expect(status, JSON.stringify(json)).toBe(200);
  });

  it("REJECTS a body with NEITHER source — a clean 400, never a 404 for `<tenant>/imports/undefined`", async () => {
    const { status, json } = await postBody({});
    expect(status, JSON.stringify(json)).toBe(400);
  });

  it("REJECTS a body with BOTH sources — the inline sheet must not silently win over r2_key", async () => {
    const { status, json } = await postBody({ sheet: parseSheet(brokerLoads), r2_key: "an-upload.csv" });
    expect(status, JSON.stringify(json)).toBe(400);
  });
});

// ─── §921 — REQ-025: AN IMPORT MAY NOT READ ANOTHER TENANT'S UPLOADED FILE ──────────────────────────────
//
// The r2_key branch prefixes the client's key with the SESSION tenant (`<tenant>/imports/<key>`), and that
// prefix is the whole of the confinement. Dropping it — `imports/<key>` — left the ENTIRE api suite green:
// every case in this file posts an INLINE `{ sheet }` body, and the only three that mention `r2_key` are
// §914's XOR cases, which never reach R2 at all because they are refused at the boundary.
//
// So the R2 read path of /v1/import had no tenant-isolation test, on a route whose own comment claims the
// discipline. CLAUDE.md rule 8 calls a cross-tenant read anywhere a build failure; this is the assertion
// that makes that true for this path rather than merely asserted in a comment.
describe("§921 — REQ-025: the /v1/import R2 read is confined to the session tenant", () => {
  const CSV = "Customer,Origin,Destination\nAcme Freight,Chicago IL,Denver CO\n";
  const postKey = async (r2_key: string): Promise<Res> => {
    const res = await SELF.fetch("https://api.local/v1/import", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await opsTok()}`,
        "Idempotency-Key": crypto.randomUUID(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ r2_key }),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  };

  it("a key naming ANOTHER tenant's upload is not read, while the same bytes under this tenant's prefix import", async () => {
    await env.EVIDENCE.put("tenant-b/imports/foreign.csv", CSV);
    const foreign = await postKey("foreign.csv");
    expect(foreign.status, JSON.stringify(foreign.json)).toBe(404);

    // CONTROL (§908): identical bytes under the SESSION tenant's own prefix DO import. Without it a 404
    // proves only that some object was missing — it could not distinguish confinement from a broken key
    // template, which is the wrong-reason trap §906 recorded.
    await env.EVIDENCE.put(`${TENANT}/imports/own.csv`, CSV);
    const own = await postKey("own.csv");
    expect(own.status, JSON.stringify(own.json)).toBe(200);
  });
});
