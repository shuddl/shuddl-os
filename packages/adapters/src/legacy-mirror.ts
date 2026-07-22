// REQ-021 / REQ-022 / REQ-035 (WP-15 Task 4) — THE CONTINUOUS 171-COL LEGACY-MIRROR: the PURE, config-driven
// core that turns one row of the incumbent's legacy export into the SAME canonical event kind SHUDDL emits
// natively, tagged source:'legacy', so the Task-6 parity primitive can compare native-vs-legacy per module.
// This is the HEAVY continuous overlay the LIGHT WP-14 migrator (migrator.ts) deferred: it SHARES that module's
// confidence floor + gap-row no-silent-drop law (imported below), but is a DISTINCT mapper (a config-driven feed
// mirror, not a one-shot drag-drop import). It is I/O-FREE + DETERMINISTIC (no D1/DO/network/Date/crypto/random),
// exactly like migrator.ts / @shuddl/edi — the WORKER (workers/agents/src/mirror-sweep.ts) does the I/O:
// reads the feed, diffs the watermark, mints the ids, appends through the api sequencer DO, writes the gap-row +
// quarantine anomalies, advances the cursor. LLM-FREE (REQ-024).
//
// THE LAWS THIS PURE CORE ENFORCES (each has a test):
//   1. MIRROR = source:'legacy' EVENTS (REQ-021): every mappable row → a canonical event DRAFT carrying
//      source:'legacy'. NO shadow table, NO new kind — the mirrored kinds are the SAME 35-catalog strings.
//   2. CONTINUOUS NO-SILENT-DROP (rule 10 / REQ-035): every export column that maps to NO canonical field is a
//      `gapRow` (the migrator's law made continuous — the worker re-raises it EVERY sweep); a below-floor field
//      mapping is a `low_confidence` gapRow, never silently applied. The per-row VALUES of gap columns are
//      RETAINED on the event draft's `retainedRefs` — nothing is lost while a human maps the column.
//   3. ECHO-SAFE (REQ-022 — the highest continuous risk): (a) a DETERMINISTIC id seed folds the row's natural key
//      + its mapped content (no Date/random), so re-ingesting the identical row reproduces the identical seed →
//      the same event id → the DO dedupes (idempotent); a CHANGED value yields a NEW seed → a NEW legacy event
//      (a correction, never a silent overwrite). (b) A row carrying an embedded SHUDDL event id (SHUDDL's own
//      fact projected OUT by Task 5 and echoed back by the incumbent) is recognized as an ECHO and produces NO
//      event — re-appending it would be a native fact masquerading as legacy (a ping-pong).
//   4. QUARANTINE, NEVER DROP: a row that cannot map (unknown type, a missing/bad required field, an unparseable
//      cursor) becomes a `quarantine` marker carrying the row's RAW cells (retained inline) — never dropped,
//      never a throw.
//   5. GENERIC / no vendor identity (REQ-167): the 171 literal headers + record kinds are CONFIG (tenant-pack,
//      outside the repo). This core is config-driven; the repo ships only a synthetic neutral fixture/config.
import { z } from "zod";
import { CONFIDENCE_FLOOR, type GapRow, type GapReason } from "./migrator.js";

// ── the mirrorable kinds + modules (the SUBSET this overlay maps) ─────────────────────────────────────────────
// String-literal unions that MIRROR @shuddl/contracts' EventKind / AuthorityModule — kept LOCAL so this pure
// core stays dependency-light (like @shuddl/edi's "no ledger import"). The worker validates every built payload
// against the real @shuddl/contracts `EventInput` at the DO boundary, so a kind/shape drift fails LOUD there
// (a bad kind ⇒ the input is rejected ⇒ the row quarantines) — never a silent wrong-kind append.
export const MIRROR_KINDS = ["quote.priced", "invoice.issued", "split.computed", "dispatch.assigned", "appointment.set"] as const;
export type MirrorKind = (typeof MIRROR_KINDS)[number];
export const MIRROR_MODULES = ["rating", "invoicing", "settlement", "dispatch", "comms"] as const;
export type MirrorModule = (typeof MIRROR_MODULES)[number];

// ── the config (Zod-validated at the worker boundary; tenant-pack-supplied, outside the repo) ────────────────
const LegacyFieldSpec = z
  .object({
    /** The EXACT legacy export header this canonical input reads from. */
    column: z.string().min(1),
    /** 0..1 mapping confidence. Below CONFIDENCE_FLOOR ⇒ the field is a `low_confidence` gap and is NOT applied. */
    confidence: z.number().min(0).max(1).default(1),
  })
  .strict();
export type LegacyFieldSpec = z.infer<typeof LegacyFieldSpec>;

const LegacyRecordSpec = z
  .object({
    kind: z.enum(MIRROR_KINDS),
    module: z.enum(MIRROR_MODULES),
    /** The `typeColumn` VALUE that selects this record spec (exact match). */
    match: z.string().min(1),
    /** canonical-input-name → the legacy column that feeds it (+ confidence). */
    fields: z.record(z.string(), LegacyFieldSpec),
  })
  .strict();
export type LegacyRecordSpec = z.infer<typeof LegacyRecordSpec>;

export const LegacyMirrorConfigSchema = z
  .object({
    /** The column whose value discriminates the record kind (→ a matching `records[].match`). */
    typeColumn: z.string().min(1),
    /** The MONOTONIC feed cursor — the watermark diffs on this so only NEW/CHANGED rows are appended (O(changed)). */
    cursorColumn: z.string().min(1),
    /** REQ-022 echo-skip: a NON-EMPTY value here means the row is a SHUDDL fact echoed back by the incumbent ⇒ skip. */
    echoColumn: z.string().min(1),
    /** The row's natural key — the deterministic id seed + the quarantine id fold it in. */
    keyColumn: z.string().min(1),
    /** The shipment natural key — anchors the legacy stream (the worker hashes it into a stream id). */
    streamColumn: z.string().min(1),
    /** OPTIONAL actor-claimed epoch-ms column; absent ⇒ the worker stamps the sweep clock (ts is NOT in the id). */
    tsColumn: z.string().min(1).optional(),
    records: z.array(LegacyRecordSpec).min(1),
  })
  .strict();
export type LegacyMirrorConfig = z.infer<typeof LegacyMirrorConfigSchema>;

// ── the mapper output ────────────────────────────────────────────────────────────────────────────────────────
/** The append DRAFT the worker turns into a validated `EventInput`: it mints the uuid from `idSeed`, the stream
 *  id from `streamKey`, then appends `source:'legacy'`. Everything here is deterministic + I/O-free. */
export interface MirrorEventDraft {
  /** Deterministic seed: `legacy|<kind>|<naturalKey>|<canonical payload>` (no Date/random) → the worker hashes it
   *  into the event id. Same row ⇒ same seed ⇒ DO dedupe; changed content ⇒ new seed ⇒ a new legacy correction. */
  idSeed: string;
  /** The raw shipment natural key — the worker derives the (collision-proof) legacy stream id from it. */
  streamKey: string;
  kind: MirrorKind;
  module: MirrorModule;
  /** ALWAYS 'legacy' — the whole point of the mirror (REQ-021). */
  source: "legacy";
  /** The typed canonical payload (a plain object; the worker validates it against `EventInput` at the DO boundary). */
  payload: Record<string, unknown>;
  /** min applied-field confidence, in basis points (an honest "how sure is this mirror row"). */
  confidenceBps: number;
  /** actor-claimed epoch-ms if the feed carried one (`tsColumn`); absent ⇒ the worker stamps the sweep clock. */
  ts?: number;
  /** The per-row values of every GAP column — retained so nothing is lost while a human maps the column (rule 10). */
  retainedRefs: Record<string, string>;
  naturalKey: string;
}

export type MirrorQuarantineReason = "unknown_type" | "missing_field" | "bad_value" | "bad_cursor";

/** A row that cannot map — retained, never dropped (the worker writes an idempotent anomaly carrying `raw`). */
export interface MirrorQuarantine {
  naturalKey: string;
  reason: MirrorQuarantineReason;
  detail: string;
  /** The row's RAW cells, keyed by header — retained inline so nothing from a bad row is lost. */
  raw: Record<string, string>;
}

/** One per data row: an appendable event, an echo-skip, or a quarantine — exactly one, never a drop. */
export interface MirrorRecord {
  rowIndex: number;
  naturalKey: string;
  /** The parsed feed cursor; null when unparseable (⇒ a `bad_cursor` quarantine, so it never advances the watermark). */
  cursor: number | null;
  echo: boolean;
  event?: MirrorEventDraft;
  quarantine?: MirrorQuarantine;
}

export interface MirrorResult {
  records: MirrorRecord[];
  /** One per export column that maps to no canonical field (unmapped) or only below the floor (low_confidence).
   *  The worker re-raises these EVERY sweep (continuous no-silent-drop). Reuses the migrator's GapRow shape. */
  gapRows: GapRow[];
}

// A parsed sheet (mirrors migrator's ParsedSheet — the worker feeds parseSheet's output here).
export interface ParsedFeed {
  headers: string[];
  rows: string[][];
}

// Prototype-less string map so a column literally named `__proto__` / `toString` sets an OWN property instead of
// hitting Object.prototype (which would silently discard the retained value — the retention half of no-silent-drop).
function nullMap(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

// Deterministic stable stringify (sorted keys, recursive) — the id seed folds this so identical content always
// yields identical bytes (the echo-safety anchor). Payloads are plain JSON (objects/arrays/primitives).
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// ── column-plan (which columns are mapped vs a gap) ──────────────────────────────────────────────────────────
interface ColumnClass {
  gap?: GapReason; // "unmapped" | "low_confidence" (a control/applied column has none)
  confidence: number;
}

// Classify every export header against the config: a control column or a field applied ≥ floor is MAPPED; a
// header referenced by no config column is an `unmapped` gap; a header referenced ONLY by below-floor field(s) is
// a `low_confidence` gap. Deterministic; independent of row data.
function classifyColumns(config: LegacyMirrorConfig, headers: readonly string[]): Map<number, ColumnClass> {
  const control = new Set<string>([config.typeColumn, config.cursorColumn, config.echoColumn, config.keyColumn, config.streamColumn]);
  if (config.tsColumn !== undefined) control.add(config.tsColumn);
  // header → the field specs (across every record) that reference it.
  const fieldRefs = new Map<string, { field: string; confidence: number }[]>();
  for (const rec of config.records) {
    for (const [field, spec] of Object.entries(rec.fields)) {
      const list = fieldRefs.get(spec.column) ?? [];
      list.push({ field, confidence: spec.confidence });
      fieldRefs.set(spec.column, list);
    }
  }
  const out = new Map<number, ColumnClass>();
  headers.forEach((header, c) => {
    if (control.has(header)) return; // mapped (a control column)
    const refs = fieldRefs.get(header);
    if (refs === undefined) {
      out.set(c, { gap: "unmapped", confidence: 0 });
      return;
    }
    const applied = refs.some((r) => r.confidence >= CONFIDENCE_FLOOR);
    if (applied) return; // mapped (applied ≥ floor by at least one record type)
    const best = refs.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    out.set(c, { gap: "low_confidence", confidence: best.confidence });
  });
  return out;
}

const firstNonEmpty = (col: number, rows: readonly string[][]): string | null => {
  for (const row of rows) {
    const v = row[col];
    if (v !== undefined && v.trim() !== "") return v;
  }
  return null;
};

// ── field readers (the parse boundary for a mapped field) ────────────────────────────────────────────────────
class FieldError extends Error {
  constructor(readonly reason: MirrorQuarantineReason, message: string) {
    super(message);
  }
}

// Resolve a field's applied cell: an APPLIED (≥ floor) field returns its trimmed value; a below-floor field is
// treated as ABSENT (routed to review, never applied) so a required-below-floor field fails the same as missing.
function appliedCell(spec: LegacyFieldSpec, header: (h: string) => number, row: readonly string[]): string | undefined {
  if (spec.confidence < CONFIDENCE_FLOOR) return undefined;
  const idx = header(spec.column);
  if (idx < 0) return undefined;
  const v = row[idx];
  return v !== undefined && v.trim() !== "" ? v.trim() : undefined;
}

// ── the mapper ───────────────────────────────────────────────────────────────────────────────────────────────
/**
 * mapLegacyExport — PURE + DETERMINISTIC: a parsed legacy export + a mapping config → the canonical event drafts
 * (source:'legacy'), the echo-skips, the quarantines, and the continuous gap rows. NO I/O, NO Date, NO crypto,
 * NO ledger — the same (feed, config) always yields the byte-identical result. Ids/timestamps + the append are
 * the worker's job (this stays pure — mirrors migrator.ts).
 */
export function mapLegacyExport(feed: ParsedFeed, config: LegacyMirrorConfig): MirrorResult {
  const headerIndex = new Map<string, number>();
  feed.headers.forEach((h, i) => {
    if (!headerIndex.has(h)) headerIndex.set(h, i); // FIRST wins on a duplicate header (deterministic)
  });
  const header = (h: string): number => headerIndex.get(h) ?? -1;
  const cell = (row: readonly string[], h: string): string => {
    const i = header(h);
    return i >= 0 ? (row[i] ?? "").trim() : "";
  };

  const columnClass = classifyColumns(config, feed.headers);
  const specByMatch = new Map<string, LegacyRecordSpec>();
  for (const rec of config.records) specByMatch.set(rec.match, rec);

  // gapRows: one per gap column (schema-level, independent of row count). Carries a sample so the human sees a
  // value. Retention key disambiguated on repeated headers so the worker mints a distinct anomaly per column.
  const gapRows: GapRow[] = [];
  const usedKeys = new Set<string>();
  for (const [c, cls] of [...columnClass.entries()].sort((a, b) => a[0] - b[0])) {
    const original = feed.headers[c]!;
    let key = original;
    let n = 2;
    while (usedKeys.has(key)) key = `${original}#${n++}`;
    usedKeys.add(key);
    // NOTE: GapRow.suspectedField is the migrator's CanonicalField namespace (parties/shipments intake), which
    // the mirror's kind-specific input fields are NOT — so it is deliberately left unset here. The column + reason
    // + confidence + sample fully convey the drop for ops (rule 10). Reuses migrator's GapRow shape otherwise.
    const gap: GapRow = { column: original, columnOrdinal: c, reason: cls.gap!, confidence: cls.confidence, retentionKey: key, sample: firstNonEmpty(c, feed.rows) };
    gapRows.push(gap);
  }

  const records: MirrorRecord[] = [];
  for (let r = 0; r < feed.rows.length; r++) {
    const row = feed.rows[r]!;
    if (row.every((v) => v.trim() === "")) continue; // skip a fully-blank line

    const naturalKey = cell(row, config.keyColumn);
    const cursorRaw = cell(row, config.cursorColumn);
    const cursorNum = /^-?\d+$/.test(cursorRaw) ? Number.parseInt(cursorRaw, 10) : NaN;
    const cursor = Number.isSafeInteger(cursorNum) ? cursorNum : null;

    // The row's RAW cells (retained on a quarantine — nothing from a bad row is lost).
    const raw = nullMap();
    feed.headers.forEach((h, i) => {
      const v = row[i];
      if (v !== undefined && v.trim() !== "") raw[h] = v.trim();
    });

    const quarantine = (reason: MirrorQuarantineReason, detail: string): void => {
      records.push({ rowIndex: r, naturalKey, cursor, echo: false, quarantine: { naturalKey, reason, detail, raw } });
    };

    // (a) ECHO-SKIP (REQ-022): a non-empty echo column ⇒ SHUDDL's own fact echoed back ⇒ NOT re-mirrored.
    if (cell(row, config.echoColumn) !== "") {
      records.push({ rowIndex: r, naturalKey, cursor, echo: true });
      continue;
    }
    // A row we cannot watermark can't be safely diffed — quarantine (retained), never a re-append storm.
    if (cursor === null) {
      quarantine("bad_cursor", `unparseable ${config.cursorColumn}='${cursorRaw}'`);
      continue;
    }
    // (b) which record kind? An unknown type is retained, never dropped.
    const spec = specByMatch.get(cell(row, config.typeColumn));
    if (spec === undefined) {
      quarantine("unknown_type", `no record spec for ${config.typeColumn}='${cell(row, config.typeColumn)}'`);
      continue;
    }

    // (c) build the typed payload from the applied fields; a missing/bad required field ⇒ quarantine (retained).
    let built: { payload: Record<string, unknown>; appliedConfidences: number[] };
    try {
      built = buildPayload(spec, (h) => header(h), row, naturalKey);
    } catch (err) {
      if (err instanceof FieldError) {
        quarantine(err.reason, err.message);
        continue;
      }
      throw err; // a genuine bug stays loud
    }

    // (d) retain the per-row values of every gap column on the draft (rule 10 — nothing lost).
    const retainedRefs = nullMap();
    for (const c of columnClass.keys()) {
      const v = row[c];
      if (v !== undefined && v.trim() !== "") retainedRefs[feed.headers[c]!] = v.trim();
    }

    const confidenceBps = built.appliedConfidences.length > 0 ? Math.round(Math.min(...built.appliedConfidences) * 10_000) : 10_000;
    const tsRaw = config.tsColumn !== undefined ? cell(row, config.tsColumn) : "";
    const ts = /^-?\d+$/.test(tsRaw) && Number.isSafeInteger(Number.parseInt(tsRaw, 10)) ? Number.parseInt(tsRaw, 10) : undefined;
    const idSeed = `legacy|${spec.kind}|${naturalKey}|${stableStringify(built.payload)}`;

    const event: MirrorEventDraft = {
      idSeed,
      streamKey: cell(row, config.streamColumn),
      kind: spec.kind,
      module: spec.module,
      source: "legacy",
      payload: built.payload,
      confidenceBps,
      retainedRefs,
      naturalKey,
    };
    if (ts !== undefined) event.ts = ts;
    records.push({ rowIndex: r, naturalKey, cursor, echo: false, event });
  }

  return { records, gapRows };
}

// ── per-kind payload builders ────────────────────────────────────────────────────────────────────────────────
// Each builder assembles the MINIMAL canonical payload the parity primitive reads, faithfully carrying the
// incumbent's number. They build plain objects; the worker validates them against @shuddl/contracts EventInput.
function buildPayload(spec: LegacyRecordSpec, header: (h: string) => number, row: readonly string[], naturalKey: string): {
  payload: Record<string, unknown>;
  appliedConfidences: number[];
} {
  const applied: number[] = [];
  const reqInt = (field: string, min: number): number => {
    const s = spec.fields[field];
    if (s === undefined) throw new FieldError("missing_field", `record '${spec.match}' has no mapping for required field '${field}'`);
    const v = appliedCell(s, header, row);
    if (v === undefined) throw new FieldError("missing_field", `required field '${field}' is absent/below-floor`);
    if (!/^-?\d+$/.test(v)) throw new FieldError("bad_value", `field '${field}'='${v}' is not an integer`);
    const n = Number.parseInt(v, 10);
    if (!Number.isSafeInteger(n) || n < min) throw new FieldError("bad_value", `field '${field}'=${v} is out of range (>= ${min})`);
    applied.push(s.confidence);
    return n;
  };
  const reqStr = (field: string): string => {
    const s = spec.fields[field];
    if (s === undefined) throw new FieldError("missing_field", `record '${spec.match}' has no mapping for required field '${field}'`);
    const v = appliedCell(s, header, row);
    if (v === undefined) throw new FieldError("missing_field", `required field '${field}' is absent/below-floor`);
    applied.push(s.confidence);
    return v;
  };
  const optStr = (field: string): string | undefined => {
    const s = spec.fields[field];
    if (s === undefined) return undefined;
    const v = appliedCell(s, header, row);
    if (v !== undefined) applied.push(s.confidence);
    return v;
  };

  let payload: Record<string, unknown>;
  switch (spec.kind) {
    case "quote.priced": {
      const sell = reqInt("sell_cents", 1); // a positive charge (mirrors QuotePricedPayload line refine)
      payload = {
        sell,
        lines: [{ kind: "freight", code: "legacy", amount_cents: sell }], // Σ === sell (penny-parity)
        floors: { contribution: 0, full: 0, target: 0 }, // the incumbent's floors are unknown to the mirror
        versions: { rate_config_ids: ["legacy-mirror"] },
        basis: { mirror: "legacy" },
      };
      break;
    }
    case "invoice.issued": {
      const total = reqInt("total_cents", 1);
      // invoice_id: the incumbent's own ref if mapped, else derived from the row's natural key (always non-empty).
      payload = {
        invoice_id: optStr("invoice_ref") ?? `lg-inv-${naturalKey || "row"}`,
        party_id: optStr("party") ?? "legacy-party",
        division: optStr("division") ?? "main",
        lines: [{ line_no: 1, kind: "freight", amount_cents: total, gl_map: "legacy-mirror" }],
      };
      break;
    }
    case "split.computed": {
      const total = reqInt("total_cents", 0); // interline gross (mirrors SplitComputedPayload; >= 0)
      payload = { total_cents: total, allocations: [{ party_id: optStr("party") ?? "legacy-party", share_bps: 10_000 }] };
      break;
    }
    case "dispatch.assigned": {
      const driver = reqStr("driver");
      const asset = optStr("asset");
      payload = { driver_user_id: driver, ...(asset !== undefined ? { asset_id: asset } : {}) };
      break;
    }
    case "appointment.set": {
      const facility = reqStr("facility");
      const slot = reqStr("slot");
      const start = reqInt("window_start_ms", 0);
      const end = reqInt("window_end_ms", 0);
      if (end < start) throw new FieldError("bad_value", `window_end_ms(${end}) < window_start_ms(${start})`);
      const legKind = optStr("leg_kind");
      const leg_kind = legKind === "delivery" ? "delivery" : "pickup";
      payload = { leg_kind, facility_id: facility, slot_key: slot, window_start_ts: start, window_end_ts: end };
      break;
    }
  }
  return { payload, appliedConfidences: applied };
}
