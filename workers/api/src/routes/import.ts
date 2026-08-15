import type { Hono } from "hono";
import { z } from "zod";
import { mapSpreadsheet, parseSheet } from "@shuddl/adapters";
import type { MapResult, ParsedSheet } from "@shuddl/adapters";
import { selectMigrator, buildOverrides } from "@shuddl/agents";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { resolveTenantDb } from "../tenants.js";
import { seedColdStartTariff } from "../tariff-seed.js";
import { SHIPMENT_MODES, findOrCreateParty, materializeShipment, sha256Hex } from "../intake-core.js";
import type { PartyKind, ShipmentMode } from "../intake-core.js";
import type { Env, Vars } from "../index.js";

// REQ-127 / REQ-035 / REQ-025 / REQ-030 (WP-14 Task 5) — THE MIGRATOR DRAG-DROP IMPORT (light self-serve). A
// stranger drag-drops their messy spreadsheet at onboarding and it becomes parties + shipments in their new
// workspace. This route:
//   1. maps the sheet via the PURE @shuddl/adapters mapper (deterministic header→field + per-field confidence,
//      the gap-row no-silent-drop law), optionally rescued by the @shuddl/agents LLM column-guesser (LLM ONLY in
//      packages/agents, REQ-024 — degrades to the deterministic mapping when unbound),
//   2. LOOPS the EXISTING intake verbs (findOrCreateParty / materializeShipment — the SAME functions POST
//      /v1/parties + POST /v1/shipments call, so no reimplement + identical gate parity),
//   3. writes EXACTLY ONE `anomalies` row per column that did not cleanly map (rule migrator.unmapped_column /
//      migrator.low_confidence_column) — CLAUDE.md rule 10 / REQ-035: a column that doesn't map NEVER silently
//      disappears; its per-row VALUES ride shipments.refs / parties.external_refs (nothing lost), and
//   4. records the migrator run + per-field confidence into the EXISTING `agent_runs` table (idempotent).
//
// LAWS: roles admin/ops ONLY; tenant from the JWT claim (resolveTenantDb, REQ-025) — never a client field; every
// id is DETERMINISTIC from the import CONTENT so a re-import makes no dupes (INSERT OR IGNORE). A rate sheet →
// rate_config via the Task-4 seedColdStartTariff path. NO new table/kind/surface. SCOPE: the light one-shot import
// only — the heavy 171-col continuous overlay (REQ-035, WP-15) is NOT built here.

const MAX_ROWS = 5000;
const MAX_COLS = 200;
const MAX_CELL = 2000;
const MAX_HEADER = 200;
const MAX_R2_KEY = 256;
const MAX_SAMPLE = 200; // the anomaly detail sample is truncated

const SheetSchema = z
  .object({
    headers: z.array(z.string().max(MAX_HEADER)).min(1).max(MAX_COLS),
    rows: z.array(z.array(z.string().max(MAX_CELL)).max(MAX_COLS)).max(MAX_ROWS),
  })
  .strict();

const ImportBody = z
  .object({
    // Exactly ONE source: an inline parsed sheet, or an R2 object key (v1). The R2 read is tenant-scoped.
    sheet: SheetSchema.optional(),
    r2_key: z.string().min(1).max(MAX_R2_KEY).optional(),
    // Optional human/agent overrides (header → {field, confidence}); validated deep by the pure mapper.
    mapping: z
      .object({ overrides: z.record(z.string(), z.object({ field: z.string(), confidence: z.number().min(0).max(1) }).strict()).optional() })
      .strict()
      .optional(),
  })
  .strict()
  .refine((b) => (b.sheet !== undefined) !== (b.r2_key !== undefined), { message: "provide exactly one of sheet | r2_key" });

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export function mountImportRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  app.post("/v1/import", requireRole("admin", "ops"), async (c) => {
    const startedAt = Date.now();
    const session = c.get("session");
    const parsed = ImportBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "INVALID IMPORT BODY");
    const body = parsed.data;
    const db = await resolveTenantDb(c.env, session.tenant); // REQ-025 — D1 keyed off the claim only

    // ── resolve the sheet (inline, or a TENANT-SCOPED R2 object) ──────────────────────────────
    let sheet: ParsedSheet;
    if (body.sheet !== undefined) {
      sheet = { headers: body.sheet.headers, rows: body.sheet.rows };
    } else {
      // REQ-025 — the R2 key is prefixed with the session tenant, so an import can NEVER read another tenant's
      // uploaded file (the same tenant-scoped-key discipline as evidence/anchors).
      const key = `${session.tenant}/imports/${body.r2_key!}`;
      const obj = await c.env.EVIDENCE.get(key);
      if (obj === null) throw new ApiError("NOT_FOUND", 404, "UPLOADED FILE NOT FOUND");
      sheet = parseSheet(await obj.text());
      if (sheet.headers.length === 0) throw new ApiError("VALIDATION_FAILED", 400, "UPLOADED FILE HAS NO HEADER ROW");
    }

    // ── map: the LLM column-guesser (degrades to deterministic when unbound) → overrides → the PURE mapper ──
    // The guesser lives in @shuddl/agents (LLM ONLY there). Unbound in CI ⇒ DeterministicMigrator ⇒ empty
    // overrides ⇒ a fully deterministic mapping. A LIVE guesser hiccup (network/4xx) degrades to deterministic —
    // an LLM problem never fails the import (the deterministic mapping + gap-row law always hold).
    const guesser = selectMigrator({
      ...(c.env.ANTHROPIC_API_KEY !== undefined ? { apiKey: c.env.ANTHROPIC_API_KEY } : {}),
      ...(c.env.MIGRATOR_MODEL !== undefined ? { model: c.env.MIGRATOR_MODEL } : {}),
    });
    let llmOverrides: Record<string, { field: string; confidence: number }> = {};
    try {
      llmOverrides = buildOverrides(sheet.headers, await guesser.guess(sheet.headers));
    } catch {
      llmOverrides = {}; // degrade to deterministic — never fail the import on the LLM
    }
    const overrides = { ...llmOverrides, ...(body.mapping?.overrides ?? {}) }; // a human override wins over the LLM

    let result: MapResult;
    try {
      result = mapSpreadsheet(sheet, { overrides });
    } catch {
      // An override to an UNKNOWN canonical field is a hard reject at the pure boundary (schema-validated).
      throw new ApiError("VALIDATION_FAILED", 400, "INVALID MAPPING OVERRIDE (unknown canonical field)");
    }

    // The import id is DETERMINISTIC from the tenant + the sheet CONTENT, so a re-import reproduces every derived
    // id (party/shipment/anomaly/run) and INSERT OR IGNORE makes no duplicate rows.
    const importId = (await sha256Hex(`${session.tenant}:migrate:${JSON.stringify({ headers: sheet.headers, rows: sheet.rows })}`)).slice(0, 32);

    // ── a rate sheet seeds the Task-4 tariff (no parties/shipments) — but does NOT short-circuit ──────────
    // The flat-rate seed consumes only row-0's rate + margin; `result.gapRows` already flags every OTHER column
    // and the unconsumed rows, so the SAME no-silent-drop anomaly loop below runs on this path too (it must never
    // be a silent sink). `result.parties`/`shipments` are empty here, so those loops no-op.
    let rateSeeded = false;
    if (result.rateConfig !== undefined) {
      await seedColdStartTariff(db, {
        idPrefix: `import-${importId.slice(0, 16)}`,
        params: {
          ...(result.rateConfig.marketRateCentsPerCwt !== undefined ? { marketRateCentsPerCwt: result.rateConfig.marketRateCentsPerCwt } : {}),
          ...(result.rateConfig.marginBps !== undefined ? { marginBps: result.rateConfig.marginBps } : {}),
        },
        approvedBy: `migrator:${session.sub}`,
      });
      rateSeeded = true;
    }

    // ── loop the intake verbs: parties FIRST (so shipment FKs exist), then shipments ──────────
    const keyToId = new Map<string, string>();
    let partiesCreated = 0;
    for (const party of result.parties) {
      const { id, created } = await findOrCreateParty(db, {
        kind: party.kind as PartyKind,
        name: party.name,
        ...(party.email !== undefined ? { email: party.email } : {}),
        ...(Object.keys(party.external_refs).length > 0 ? { externalRefs: party.external_refs } : {}),
      });
      keyToId.set(party.key, id);
      if (created) partiesCreated++;
    }

    let shipmentsCreated = 0;
    for (const shp of result.shipments) {
      const shipperId = keyToId.get(shp.shipperKey);
      const consigneeId = keyToId.get(shp.consigneeKey);
      const billToId = keyToId.get(shp.billToKey);
      if (shipperId === undefined || consigneeId === undefined || billToId === undefined) continue; // never (parties made above)
      const id = `shp_${(await sha256Hex(`migrate:shipment:${importId}:${shp.rowIndex}`)).slice(0, 16)}`;
      const mode = shp.mode !== undefined && (SHIPMENT_MODES as readonly string[]).includes(shp.mode) ? (shp.mode as ShipmentMode) : undefined;
      const { created } = await materializeShipment(db, {
        id,
        shipperPartyId: shipperId,
        consigneePartyId: consigneeId,
        billToPartyId: billToId,
        ...(mode !== undefined ? { mode } : {}),
        ...(shp.division !== undefined ? { division: truncate(shp.division, MAX_CELL) } : {}),
        refs: shp.refs,
      });
      if (created) shipmentsCreated++;
    }

    // ── THE NO-SILENT-DROP LEDGER: exactly one anomaly per gap column (idempotent by content) ──
    // The anomaly id folds in the column ORDINAL so two same-named gap columns (e.g. a duplicate `Notes` header)
    // mint DISTINCT rows — the column↔anomaly count is airtight even for colliding/duplicate headers.
    const RULE_BY_REASON = {
      unmapped: "migrator.unmapped_column",
      low_confidence: "migrator.low_confidence_column",
      duplicate_field: "migrator.duplicate_column",
    } as const;
    let unmapped = 0;
    let lowConfidence = 0;
    let duplicate = 0;
    for (const g of result.gapRows) {
      if (g.reason === "unmapped") unmapped++;
      else if (g.reason === "low_confidence") lowConfidence++;
      else duplicate++;
      const id = `mig_${(await sha256Hex(`${importId}:${g.reason}:${g.columnOrdinal}:${g.column}`)).slice(0, 24)}`;
      const detail = JSON.stringify({
        import_id: importId,
        column: truncate(g.column, MAX_HEADER),
        column_ordinal: g.columnOrdinal,
        retention_key: truncate(g.retentionKey, MAX_HEADER),
        confidence: g.confidence,
        ...(g.suspectedField !== undefined ? { suspected_field: g.suspectedField } : {}),
        sample: g.sample !== null ? truncate(g.sample, MAX_SAMPLE) : null,
      });
      await db
        // anomaly-recurrence: one-shot — the id folds `importId`, which is unique per import RUN, so a later
        // import of the same bad column mints a NEW row rather than needing this one reopened (audit §1541).
        .prepare("INSERT OR IGNORE INTO anomalies (id, rule, object_kind, object_id, severity, detail, status) VALUES (?,?,?,?,?,?,'open')")
        .bind(id, RULE_BY_REASON[g.reason], "import_field", truncate(g.column, MAX_HEADER), "warn", detail)
        .run();
    }

    await recordRun(db, importId, "migrator", startedAt, { parties_created: partiesCreated, shipments_created: shipmentsCreated, unmapped, low_confidence: lowConfidence, duplicate, rate_seeded: rateSeeded }, result);

    return c.json({
      import_id: importId,
      rate_seeded: rateSeeded,
      parties_created: partiesCreated,
      shipments_created: shipmentsCreated,
      unmapped_columns: unmapped,
      low_confidence_columns: lowConfidence,
      duplicate_columns: duplicate,
      gap_rows: result.gapRows,
      field_confidence: result.fieldConfidence,
    });
  });
}

// Record the migrator run into the EXISTING agent_runs table (REQ-113 metering shape). Idempotent: id is
// deterministic from the import content, INSERT OR IGNORE. confidence is the WEAKEST applied field's confidence
// in basis points (an honest "how sure was this import"), or NULL when nothing applied. cost is `{}` (unknown —
// token cost is not metered here; an honest absence, never a fabricated 0). latency_ms is the REAL wall-clock.
async function recordRun(
  db: D1Database,
  importId: string,
  agent: string,
  startedAt: number,
  outcome: Record<string, unknown>,
  result: MapResult,
): Promise<void> {
  const confs = Object.values(result.fieldConfidence);
  const confidenceBps = confs.length > 0 ? Math.round(Math.min(...confs) * 10_000) : null;
  const actions = JSON.stringify([{ action: "import", ...outcome }]);
  const basis = JSON.stringify({ field_confidence: result.fieldConfidence, gap_rows: result.gapRows });
  await db
    .prepare(
      "INSERT OR IGNORE INTO agent_runs (id, agent, trigger_event_id, actions, basis, confidence, cost, latency_ms, outcome) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .bind(`migrator:${importId}`, agent, null, actions, basis, confidenceBps, "{}", Date.now() - startedAt, JSON.stringify(outcome))
    .run();
}
