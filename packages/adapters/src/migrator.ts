// REQ-127 / REQ-035 (WP-14 Task 5) — THE LIGHT SELF-SERVE MIGRATOR: a stranger drag-drops their messy
// spreadsheet at onboarding and it becomes parties + shipments in their new workspace. This module is the
// PURE, DETERMINISTIC core: a header→canonical-field mapping with per-field confidence, applied over the
// rows. It is I/O-FREE and ledger-free — it mirrors @shuddl/edi/mapping.ts (no network, no D1, no ledger/
// rater import; just schema-validated config resolution + lookups). The WORKER (workers/api/routes/import.ts)
// loops the EXISTING intake verbs to persist, writes the gap-row anomalies, and records the agent_runs.
//
// THE TWO LAWS THIS ENFORCES (CLAUDE.md rule 10 / Migrator rule / REQ-035):
//   1. NO SILENT DROP: a column that maps to NO known field raises a `gapRow` (never disappears), AND its
//      per-row VALUES are retained inline on the shipment's `refs` / the party's `external_refs` — nothing
//      is lost while a human maps the column properly.
//   2. NO SILENT LOW-CONFIDENCE APPLY: a mapping BELOW the 0.8 confidence floor is NOT applied to its
//      canonical field — it is routed to REVIEW as a `gapRow` (a low-confidence marker) and its values are
//      retained exactly like an unmapped column. A weak guess never silently rewrites a field.
//
// SCOPE (WP-14 vs WP-15): this is the ONE-SHOT drag-drop import only. The heavy 171-col continuous overlay
// (REQ-035 WP-15) shares this confidence + gap-row law but is NOT built here.
import { z } from "zod";

// ── canonical target fields ──────────────────────────────────────────────────────────────────
// The fields the intake verbs (POST /v1/parties + POST /v1/shipments) can populate. A header resolves to one
// of these (applied), a weak guess of one of these (review), or nothing (unmapped). NO field here maps to a
// new table/column — parties.{names,contacts,external_refs} + shipments.{mode,division,refs} already exist.
export const CANONICAL_FIELDS = [
  "shipper_name",
  "consignee_name",
  "bill_to_name",
  "shipper_email",
  "consignee_email",
  "bill_to_email",
  "mode",
  "division",
  "pro",
  "bol",
  "origin_zip",
  "dest_zip",
  "weight_lb",
] as const;
export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

// The confidence FLOOR: a mapping at OR ABOVE this is applied; strictly below it is routed to review and never
// silently applied (REQ-035 "<0.8 queues review"). Confidences are 0..1 floats in this pure layer; the worker
// converts to basis points for the agent_runs metering.
export const CONFIDENCE_FLOOR = 0.8;

// Party roles the light import recognizes, and the parties.kind each maps to (byte-valid against the
// 0002_domain.sql CHECK). A customer/account column is the bill_to (a broker's paying customer).
export type PartyRole = "shipper" | "consignee" | "bill_to";
const ROLE_KIND: Record<PartyRole, string> = { shipper: "shipper", consignee: "consignee", bill_to: "broker" };

// The 6 shipment modes — byte-identical to the shipments.mode CHECK in 0002_domain.sql. A mapped `mode` VALUE
// that is not one of these is NOT applied (the column stays mapped, but the row's raw value rides refs so it
// is never lost, and the shipment defaults LTL downstream).
const SHIPMENT_MODES: ReadonlySet<string> = new Set(["LTL", "TL", "brokered", "cartage", "dray", "transload"]);
const MODE_SYNONYMS: Record<string, string> = nullMap({
  ltl: "LTL",
  "less than truckload": "LTL",
  tl: "TL",
  truckload: "TL",
  ftl: "TL",
  "full truckload": "TL",
  brokered: "brokered",
  broker: "brokered",
  cartage: "cartage",
  dray: "dray",
  drayage: "dray",
  transload: "transload",
});

// Build a prototype-less string map so a lookup by a key equal to an Object.prototype member (`toString`,
// `__proto__`, …) can never return an inherited function instead of undefined (mirrors @shuddl/edi nullMap).
function nullMap<T>(entries: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null), entries);
}

interface Synonym {
  field: CanonicalField;
  confidence: number;
}

// The deterministic synonym table: normalized header → { canonical field, confidence }. STRONG synonyms sit at
// or above the floor (applied); AMBIGUOUS synonyms sit below it (routed to review) because the header alone
// cannot say WHICH party/ref it is (a bare "name" / "ref" / "zip"). Everything absent from this table is
// UNMAPPED. Prototype-safe (nullMap) so "toString"/"constructor" headers resolve to undefined, not a function.
const SYNONYMS: Record<string, Synonym> = nullMap<Synonym>({
  // party names — strong
  shipper: { field: "shipper_name", confidence: 1 },
  shipper_name: { field: "shipper_name", confidence: 1 },
  ship_from: { field: "shipper_name", confidence: 0.9 },
  shipfrom: { field: "shipper_name", confidence: 0.9 },
  origin_name: { field: "shipper_name", confidence: 0.9 },
  consignee: { field: "consignee_name", confidence: 1 },
  consignee_name: { field: "consignee_name", confidence: 1 },
  ship_to: { field: "consignee_name", confidence: 0.9 },
  shipto: { field: "consignee_name", confidence: 0.9 },
  receiver: { field: "consignee_name", confidence: 0.9 },
  destination_name: { field: "consignee_name", confidence: 0.9 },
  bill_to: { field: "bill_to_name", confidence: 1 },
  bill_to_name: { field: "bill_to_name", confidence: 1 },
  billto: { field: "bill_to_name", confidence: 1 },
  customer: { field: "bill_to_name", confidence: 0.9 },
  customer_name: { field: "bill_to_name", confidence: 0.9 },
  account: { field: "bill_to_name", confidence: 0.85 },
  account_name: { field: "bill_to_name", confidence: 0.9 },
  payer: { field: "bill_to_name", confidence: 0.85 },
  client: { field: "bill_to_name", confidence: 0.85 },
  client_name: { field: "bill_to_name", confidence: 0.9 },
  // party emails — strong
  email: { field: "bill_to_email", confidence: 0.9 },
  customer_email: { field: "bill_to_email", confidence: 1 },
  bill_to_email: { field: "bill_to_email", confidence: 1 },
  contact_email: { field: "bill_to_email", confidence: 0.85 },
  account_email: { field: "bill_to_email", confidence: 0.9 },
  shipper_email: { field: "shipper_email", confidence: 1 },
  origin_email: { field: "shipper_email", confidence: 0.85 },
  consignee_email: { field: "consignee_email", confidence: 1 },
  receiver_email: { field: "consignee_email", confidence: 0.9 },
  // shipment scalars — strong
  mode: { field: "mode", confidence: 1 },
  service_mode: { field: "mode", confidence: 0.9 },
  equipment: { field: "mode", confidence: 0.85 },
  transport_mode: { field: "mode", confidence: 0.9 },
  division: { field: "division", confidence: 1 },
  branch: { field: "division", confidence: 0.85 },
  office: { field: "division", confidence: 0.85 },
  // shipment refs — strong
  pro: { field: "pro", confidence: 1 },
  pro_number: { field: "pro", confidence: 1 },
  pro_no: { field: "pro", confidence: 0.9 },
  pronumber: { field: "pro", confidence: 0.9 },
  bol: { field: "bol", confidence: 1 },
  bol_number: { field: "bol", confidence: 1 },
  bol_no: { field: "bol", confidence: 0.9 },
  bill_of_lading: { field: "bol", confidence: 0.9 },
  origin_zip: { field: "origin_zip", confidence: 1 },
  orig_zip: { field: "origin_zip", confidence: 0.9 },
  from_zip: { field: "origin_zip", confidence: 0.9 },
  pickup_zip: { field: "origin_zip", confidence: 0.9 },
  dest_zip: { field: "dest_zip", confidence: 1 },
  destination_zip: { field: "dest_zip", confidence: 1 },
  to_zip: { field: "dest_zip", confidence: 0.9 },
  delivery_zip: { field: "dest_zip", confidence: 0.9 },
  weight: { field: "weight_lb", confidence: 0.9 },
  weight_lb: { field: "weight_lb", confidence: 1 },
  weight_lbs: { field: "weight_lb", confidence: 1 },
  gross_weight: { field: "weight_lb", confidence: 0.9 },
  wt: { field: "weight_lb", confidence: 0.85 },
  // AMBIGUOUS — a guess BELOW the floor (routed to review, never silently applied)
  name: { field: "bill_to_name", confidence: 0.5 },
  company: { field: "bill_to_name", confidence: 0.5 },
  ref: { field: "pro", confidence: 0.5 },
  reference: { field: "pro", confidence: 0.5 },
  number: { field: "pro", confidence: 0.4 },
  num: { field: "pro", confidence: 0.4 },
  zip: { field: "origin_zip", confidence: 0.5 },
  zipcode: { field: "origin_zip", confidence: 0.5 },
  zip_code: { field: "origin_zip", confidence: 0.5 },
  postal: { field: "origin_zip", confidence: 0.5 },
  postal_code: { field: "origin_zip", confidence: 0.5 },
});

// Unmapped/low-confidence columns whose header names a PARTY attribute (phone/fax/contact/address) have their
// retained values ride the bill_to party's `external_refs`; every other retained value rides the shipment's
// `refs`. Either way NOTHING is lost — this only decides WHERE the retained value is parked.
const PARTY_ATTR_KEYS: ReadonlySet<string> = new Set([
  "phone",
  "telephone",
  "fax",
  "mobile",
  "cell",
  "contact",
  "contact_name",
  "address",
  "addr",
  "street",
]);

// ── header normalization ─────────────────────────────────────────────────────────────────────
// Lowercase, strip a UTF-8 BOM, collapse every run of non-alphanumerics to a single underscore, trim the
// underscores. "PRO #" → "pro", "Ship-To Name" → "ship_to_name", "﻿Customer" → "customer". Deterministic:
// the same header always normalizes identically, so the same sheet always yields the byte-identical mapping.
export function normalizeHeader(header: string): string {
  return header
    .replace(/^﻿/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ── the column plan (resolveColumnMapping — the LLM-overridable seam) ──────────────────────────
export type ColumnDecision = "apply" | "review" | "unmapped";
export interface ColumnPlan {
  /** The ORIGINAL header, verbatim (so a human recognizes it in the gap row). */
  header: string;
  normalized: string;
  /** The canonical field the column maps to, or null when unmapped. */
  field: CanonicalField | null;
  /** 0..1; 0 when unmapped. */
  confidence: number;
  decision: ColumnDecision;
  /** When NOT applied, a party-attribute header parks its retained values on the party's external_refs. */
  partyScoped: boolean;
}

// An override is a proposed mapping for a header (the LLM column-guesser's output, or a human correction). It
// is validated at the boundary (mirrors @shuddl/edi resolveMapping): the field MUST be a known canonical field
// and confidence a 0..1 float — an unknown field is a hard REJECT (a typo/smuggled key never silently no-ops).
const OverrideSchema = z
  .object({ field: z.enum(CANONICAL_FIELDS), confidence: z.number().min(0).max(1) })
  .strict();
export const MigratorMappingSchema = z
  .object({ overrides: z.record(z.string(), OverrideSchema).optional() })
  .strict();
export type MigratorMapping = z.infer<typeof MigratorMappingSchema>;

/**
 * Resolve each header into a ColumnPlan. Deterministic + pure. An override (keyed by the ORIGINAL header) wins
 * over the synonym table — this is the seam the LLM column-guesser feeds (it may place an otherwise
 * unmapped/low-confidence header). Below-floor confidence (from either source) is `review`, never `apply`.
 */
export function resolveColumnMapping(headers: readonly string[], mapping: unknown = {}): ColumnPlan[] {
  const { overrides } = MigratorMappingSchema.parse(mapping);
  return headers.map((header) => {
    const normalized = normalizeHeader(header);
    // Override first (validated), else the synonym table, else unmapped.
    const override = overrides !== undefined && Object.hasOwn(overrides, header) ? overrides[header] : undefined;
    const syn = Object.hasOwn(SYNONYMS, normalized) ? SYNONYMS[normalized] : undefined;
    const hit = override ?? syn;
    const partyScoped = PARTY_ATTR_KEYS.has(normalized);
    if (hit === undefined) {
      return { header, normalized, field: null, confidence: 0, decision: "unmapped", partyScoped };
    }
    const decision: ColumnDecision = hit.confidence >= CONFIDENCE_FLOOR ? "apply" : "review";
    return { header, normalized, field: hit.field, confidence: hit.confidence, decision, partyScoped };
  });
}

// ── the parsed sheet + the map result ──────────────────────────────────────────────────────────
export interface ParsedSheet {
  headers: string[];
  /** Each row aligned to `headers` (padded/truncated by parseSheet). */
  rows: string[][];
}

export interface MappedParty {
  /** A stable dedupe key within this import: the normalized email, else `n:<normalized name>`. */
  key: string;
  role: PartyRole;
  kind: string;
  name: string;
  email?: string;
  /** Retained party-scoped values (REQ-035 nothing lost) — merged across this party's rows, first-non-empty. */
  external_refs: Record<string, string>;
}

export interface MappedShipment {
  /** 0-based index into sheet.rows — the worker folds it into the deterministic (re-import-safe) shipment id. */
  rowIndex: number;
  shipperKey: string;
  consigneeKey: string;
  billToKey: string;
  mode?: string;
  division?: string;
  /** Canonical refs (pro/bol/…) PLUS retained unmapped/low-confidence values — nothing lost (REQ-035). */
  refs: Record<string, string>;
}

export type GapReason = "unmapped" | "low_confidence";
export interface GapRow {
  /** The ORIGINAL header that did not cleanly apply. One gap row per such column (the no-silent-drop law). */
  column: string;
  reason: GapReason;
  /** The suspected field for a low-confidence guess (absent for a fully unmapped column). */
  suspectedField?: CanonicalField;
  confidence: number;
  /** The first non-empty value in that column across the rows — the human's sample (null when the column is empty). */
  sample: string | null;
}

export interface RateSheetHint {
  marketRateCentsPerCwt?: number;
  marginBps?: number;
}

export interface MapResult {
  parties: MappedParty[];
  shipments: MappedShipment[];
  /** Present ONLY when the sheet is a rate sheet (no party columns + rate/margin columns) — the worker seeds
   *  it via the Task-4 tariff path. Absent for a normal parties/shipments import. */
  rateConfig?: RateSheetHint;
  /** One row per column that did not cleanly apply (unmapped OR below-floor). The no-silent-drop ledger. */
  gapRows: GapRow[];
  /** Per canonical field the confidence it was applied at (max across mapping columns). Metering → agent_runs. */
  fieldConfidence: Record<string, number>;
}

function partyKey(name: string, email: string | undefined): string {
  const e = email?.trim().toLowerCase();
  if (e) return e;
  return `n:${name.trim().toLowerCase()}`;
}

const firstNonEmpty = (col: number, rows: readonly string[][]): string | null => {
  for (const row of rows) {
    const v = row[col];
    if (v !== undefined && v.trim() !== "") return v;
  }
  return null;
};

/**
 * Map a parsed spreadsheet into parties + shipments + gap rows + per-field confidence. PURE + DETERMINISTIC:
 * no I/O, no Date, no crypto, no ledger — the same (sheet, mapping) always yields the byte-identical result.
 * The worker turns the result into persisted rows by LOOPING the existing intake verbs; ids/timestamps are the
 * worker's job (this stays pure).
 */
export function mapSpreadsheet(sheet: ParsedSheet, mapping: unknown = {}): MapResult {
  const plans = resolveColumnMapping(sheet.headers, mapping);

  // A rate sheet (rate/margin columns, no party columns) short-circuits to a tariff hint (Task-4 path). A normal
  // import (any party column present) never takes this branch.
  const rateHint = detectRateSheet(sheet, plans);
  if (rateHint !== null) {
    return { parties: [], shipments: [], rateConfig: rateHint, gapRows: [], fieldConfidence: {} };
  }

  // fieldConfidence: the max confidence any APPLIED column reached for each canonical field.
  const fieldConfidence: Record<string, number> = {};
  for (const p of plans) {
    if (p.decision === "apply" && p.field !== null) {
      fieldConfidence[p.field] = Math.max(fieldConfidence[p.field] ?? 0, p.confidence);
    }
  }

  // gapRows: one per column that did not cleanly apply. Column-level (schema gap), independent of row count.
  const gapRows: GapRow[] = [];
  for (let c = 0; c < plans.length; c++) {
    const p = plans[c]!;
    if (p.decision === "apply") continue;
    const sample = firstNonEmpty(c, sheet.rows);
    if (p.decision === "review" && p.field !== null) {
      gapRows.push({ column: p.header, reason: "low_confidence", suspectedField: p.field, confidence: p.confidence, sample });
    } else {
      gapRows.push({ column: p.header, reason: "unmapped", confidence: 0, sample });
    }
  }

  // Per-role applied field columns, and the retained (review/unmapped) columns — precomputed once.
  const appliedCol = (field: CanonicalField): number => plans.findIndex((p) => p.decision === "apply" && p.field === field);
  const idx = {
    shipper_name: appliedCol("shipper_name"),
    consignee_name: appliedCol("consignee_name"),
    bill_to_name: appliedCol("bill_to_name"),
    shipper_email: appliedCol("shipper_email"),
    consignee_email: appliedCol("consignee_email"),
    bill_to_email: appliedCol("bill_to_email"),
    mode: appliedCol("mode"),
    division: appliedCol("division"),
    pro: appliedCol("pro"),
    bol: appliedCol("bol"),
    origin_zip: appliedCol("origin_zip"),
    dest_zip: appliedCol("dest_zip"),
    weight_lb: appliedCol("weight_lb"),
  };
  const retainedCols = plans.map((p, c) => ({ p, c })).filter(({ p }) => p.decision !== "apply");

  const cell = (row: readonly string[], col: number): string | undefined => {
    if (col < 0) return undefined;
    const v = row[col];
    return v !== undefined && v.trim() !== "" ? v.trim() : undefined;
  };

  // Accumulate deduped parties (by key, keeping the FIRST role/kind seen) and their merged external_refs.
  const partyByKey = new Map<string, MappedParty>();
  const upsertParty = (role: PartyRole, name: string, email: string | undefined): string => {
    const key = partyKey(name, email);
    const existing = partyByKey.get(key);
    if (existing === undefined) {
      const party: MappedParty = { key, role, kind: ROLE_KIND[role], name, external_refs: {} };
      if (email !== undefined) party.email = email;
      partyByKey.set(key, party);
    } else if (existing.email === undefined && email !== undefined) {
      existing.email = email; // enrich a name-only party with an email seen later
    }
    return key;
  };

  const shipments: MappedShipment[] = [];
  for (let r = 0; r < sheet.rows.length; r++) {
    const row = sheet.rows[r]!;
    if (row.every((v) => v.trim() === "")) continue; // skip a fully-blank line

    // Party names per role, with fallback: an absent shipper/consignee reuses the bill_to; an absent bill_to
    // reuses the first available name. A row with NO party name at all yields no shipment (but its column-level
    // gaps still fired above); fixtures always carry a customer, so this is the degenerate guard only.
    const shipperName = cell(row, idx.shipper_name);
    const consigneeName = cell(row, idx.consignee_name);
    const billToName = cell(row, idx.bill_to_name);
    const primaryName = billToName ?? shipperName ?? consigneeName;
    if (primaryName === undefined) continue;

    const billKey = upsertParty("bill_to", billToName ?? primaryName, cell(row, idx.bill_to_email));
    const shipKey = shipperName !== undefined ? upsertParty("shipper", shipperName, cell(row, idx.shipper_email)) : billKey;
    const consKey = consigneeName !== undefined ? upsertParty("consignee", consigneeName, cell(row, idx.consignee_email)) : billKey;

    // Shipment refs: canonical refs first, then EVERY retained value (nothing lost). A retained party-scoped
    // value rides the bill_to party's external_refs instead; everything else rides the shipment refs.
    const refs: Record<string, string> = {};
    for (const ref of ["pro", "bol", "origin_zip", "dest_zip", "weight_lb"] as const) {
      const v = cell(row, idx[ref]);
      if (v !== undefined) refs[ref] = v;
    }
    for (const { p, c } of retainedCols) {
      const v = cell(row, c);
      if (v === undefined) continue;
      if (p.partyScoped) {
        const bill = partyByKey.get(billKey)!;
        if (bill.external_refs[p.header] === undefined) bill.external_refs[p.header] = v;
      } else {
        refs[p.header] = v;
      }
    }

    const shipment: MappedShipment = { rowIndex: r, shipperKey: shipKey, consigneeKey: consKey, billToKey: billKey, refs };
    // mode: apply only a recognized mode; otherwise retain the raw value on refs (never lost) and default LTL.
    const rawMode = cell(row, idx.mode);
    if (rawMode !== undefined) {
      const norm = MODE_SYNONYMS[rawMode.toLowerCase()] ?? (SHIPMENT_MODES.has(rawMode) ? rawMode : undefined);
      if (norm !== undefined) shipment.mode = norm;
      else refs["mode_raw"] = rawMode;
    }
    const division = cell(row, idx.division);
    if (division !== undefined) shipment.division = division;
    shipments.push(shipment);
  }

  return { parties: [...partyByKey.values()], shipments, gapRows, fieldConfidence };
}

// A rate sheet is detected ONLY when the sheet has NO party columns and DOES have a rate + margin column, so a
// normal parties/shipments import (which always has a party column) can never be mistaken for one. Deterministic.
function detectRateSheet(sheet: ParsedSheet, plans: readonly ColumnPlan[]): RateSheetHint | null {
  const hasParty = plans.some((p) => p.field !== null && p.field.endsWith("_name"));
  if (hasParty) return null;
  const norms = new Set(sheet.headers.map(normalizeHeader));
  const rateHeader = ["market_rate_cents_per_cwt", "market_rate", "rate_cents_per_cwt", "linehaul_rate"].find((h) => norms.has(h));
  const marginHeader = ["margin_bps", "margin", "markup_bps"].find((h) => norms.has(h));
  if (rateHeader === undefined || marginHeader === undefined) return null;
  const firstRow = sheet.rows.find((row) => row.some((v) => v.trim() !== ""));
  if (firstRow === undefined) return null;
  const col = (h: string): number => sheet.headers.findIndex((x) => normalizeHeader(x) === h);
  const rateVal = Number.parseInt((firstRow[col(rateHeader)] ?? "").trim(), 10);
  const marginVal = Number.parseInt((firstRow[col(marginHeader)] ?? "").trim(), 10);
  const hint: RateSheetHint = {};
  if (Number.isInteger(rateVal) && rateVal > 0) hint.marketRateCentsPerCwt = rateVal;
  if (Number.isInteger(marginVal) && marginVal >= 0) hint.marginBps = marginVal;
  return hint.marketRateCentsPerCwt !== undefined ? hint : null;
}

// ── parseSheet — a pure CSV reader (the R2/inline byte boundary) ────────────────────────────────
// A minimal but correct RFC-4180-ish CSV parser: quoted fields, escaped "" quotes, embedded commas/newlines,
// CRLF or LF, a leading BOM. PURE (string in, ParsedSheet out) — the worker uses it to turn an uploaded file's
// bytes into rows; the map stays byte-clean. Rows are aligned to the header count (short rows padded, long rows
// truncated) so a ragged messy export never desynchronizes a column from its header.
export function parseSheet(text: string): ParsedSheet {
  const records = parseCsvRecords(text.replace(/^﻿/, ""));
  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0]!.map((h) => h.trim());
  const width = headers.length;
  const rows = records.slice(1).map((rec) => {
    const out = new Array<string>(width);
    for (let i = 0; i < width; i++) out[i] = rec[i] ?? "";
    return out;
  });
  return { headers, rows };
}

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  const pushField = (): void => {
    record.push(field);
    field = "";
  };
  const pushRecord = (): void => {
    pushField();
    records.push(record);
    record = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r") {
      // swallow a CRLF or a lone CR as one line terminator
      pushRecord();
      i += text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      pushRecord();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // flush the trailing field/record unless the input ended exactly on a newline (no dangling empty record)
  if (field !== "" || record.length > 0) pushRecord();
  // drop a single trailing all-empty record produced by a final newline+EOF edge
  return records.filter((rec) => !(rec.length === 1 && rec[0] === ""));
}
