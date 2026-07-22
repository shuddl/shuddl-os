// REQ-022 (WP-15 Task 5) — THE PROJECT-BACK-OUT ADAPTER: the WRITE-BACK half of the zero-cutover overlay + the
// no-ping-pong anchor. While authority migrates, SHUDDL projects its OWN facts BACK OUT to the incumbent so the
// incumbent stays internally consistent (genesis/02). This is the PURE INVERSE of the Task-4 mirror-IN
// (legacy-mirror.ts): it takes SHUDDL-held facts (the MIRROR_KINDS) and emits incumbent-format rows using the SAME
// LegacyMirrorConfig — the SAME control columns, the SAME field specs, the SAME echoColumn.
//
// THE ONE ECHO CONTRACT (REQ-022 — the highest continuous-path risk): every outbound row EMBEDS its originating
// SHUDDL event id in `config.echoColumn`. When the incumbent's next export echoes that row back, the mirror-IN sees
// the non-empty echo column, recognizes the SHUDDL fact, and produces NO event (legacy-mirror.ts :281-283) — so a
// native fact CANNOT re-enter as a source:'legacy' event. project-OUT and mirror-IN therefore MUST share the ONE
// contract: the SAME config (the echoColumn + field specs) and the SAME stableStringify (imported below, never
// re-implemented — a divergent stringify or an id the mirror-IN doesn't recognize would be a silent ping-pong).
//
// PURE + DETERMINISTIC + I/O-FREE (mirrors legacy-mirror.ts / migrator.ts / @shuddl/edi): NO D1/DO/network, NO
// Date, NO crypto/random, NO LLM (REQ-024). The WORKER/transport does the I/O (reads the ledger, mints the outbound
// cursor, writes the CSV/XML/EDI to the incumbent's drop). GENERIC / no vendor identity (REQ-167): the concrete
// wire format is tenant-pack config — this core emits NEUTRAL rows; `serializeOutboundCsv` is the REPRESENTATIVE
// serializer (an XML/EDI/PDF serializer is the same neutral rows rendered by a tenant-pack format module).
//
// NO new event kind, NO new table: project-OUT reads the existing 35-catalog MIRROR_KINDS and writes plain rows.
import {
  MIRROR_KINDS,
  nullMap,
  type MirrorKind,
  type LegacyMirrorConfig,
  type LegacyRecordSpec,
} from "./legacy-mirror.js";

// Re-export THE ONE stringify at the project-OUT boundary so a consumer that reaches for the write-back half gets
// the SAME echo-contract primitive the mirror-IN idSeed folds — never a second copy (share-lint-matchers). The
// bidirectional soak imports it from here to prove the round-trip's idSeed is byte-identical across cycles.
export { stableStringify } from "./legacy-mirror.js";

// ── the input: a SHUDDL-held fact to project OUT ─────────────────────────────────────────────────────────────
/** A SHUDDL-held fact eligible for project-OUT. In production the worker reads these from the ledger; the intended
 *  producer is SHUDDL's NATIVE facts (source:'native'), but the echo-id embed — NOT the source — is the ping-pong
 *  guard, so a mirrored-legacy fact (already carrying a SHUDDL id) is projected back out just as safely. */
export interface ProjectableEvent {
  /** The SHUDDL event id. EMBEDDED into `config.echoColumn` on the outbound row — the whole no-ping-pong contract.
   *  A blank id is refused (it would produce an unrecognized row ⇒ a silent ping-pong). */
  id: string;
  /** A canonical event kind. Projected only when it is a MIRROR_KIND the config maps; anything else is skipped. */
  kind: string;
  /** Provenance, informational only (the echo-id embed is the safety gate, not the source). */
  source?: string;
  /** The canonical event payload (SHUDDL's native shape) — project-OUT extracts only the numbers the config maps. */
  payload: Record<string, unknown>;
  /** The shipment natural key → `config.streamColumn` (the inverse of MirrorEventDraft.streamKey). */
  streamKey: string;
  /** The row natural key → `config.keyColumn` (the inverse of MirrorEventDraft.naturalKey). */
  naturalKey: string;
  /** The incumbent-facing feed cursor → `config.cursorColumn`. Caller-supplied (keeps this core Date-free). */
  cursor: number;
  /** actor-claimed epoch-ms → `config.tsColumn` when the config declares one. */
  ts?: number;
}

/** One neutral outbound row: the SHUDDL fact rendered as the incumbent's columns. `cells` is a prototype-safe map
 *  (legacy-header → value) that a concrete format module (CSV/XML/EDI/PDF, tenant-pack) serializes. `cells` ALWAYS
 *  includes `config.echoColumn = eventId` — the echo embed. */
export interface OutboundRow {
  /** The SHUDDL event id this row projects (also written into `cells[config.echoColumn]`). */
  eventId: string;
  kind: MirrorKind;
  cells: Record<string, string>;
}

const MIRROR_KIND_SET = new Set<string>(MIRROR_KINDS);
const isMirrorKind = (k: string): k is MirrorKind => MIRROR_KIND_SET.has(k);

// ── typed payload readers (no `any`; the inverse of the mirror-IN's field reads) ─────────────────────────────
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function readInt(v: unknown): string | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) ? String(v) : undefined;
}
function readStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}
// Σ of every line's amount_cents — the inverse of the mirror-IN, which folds the incumbent's total into a single
// line. Native invoices carry itemized lines; project-OUT sums them so the incumbent's total column round-trips
// (penny-parity: the number the mirror-IN would read back equals the sum SHUDDL projected).
function sumLineAmounts(v: unknown): string | undefined {
  if (!Array.isArray(v)) return undefined;
  let sum = 0;
  let seen = false;
  for (const item of v) {
    const amt = asRecord(item)?.["amount_cents"];
    if (typeof amt === "number" && Number.isSafeInteger(amt)) {
      sum += amt;
      seen = true;
    }
  }
  return seen && Number.isSafeInteger(sum) ? String(sum) : undefined;
}
function firstAllocationParty(v: unknown): string | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  return readStr(asRecord(v[0])?.["party_id"]);
}

// ── the field inverse: canonical payload → the field-name→value map the config columns read from ─────────────
// Each case is the EXACT inverse of legacy-mirror.ts buildPayload for that kind: it recovers the incumbent's number
// keyed by the SAME field name the config's `records[].fields` use. project-OUT then writes each recovered value to
// that field spec's `column`, so a value maps out and back consistently through the SAME field specs.
function inverseFieldValues(kind: MirrorKind, payload: Record<string, unknown>): Record<string, string> {
  const out = nullMap();
  const put = (field: string, val: string | undefined): void => {
    if (val !== undefined) out[field] = val;
  };
  switch (kind) {
    case "quote.priced":
      put("sell_cents", readInt(payload["sell"]));
      break;
    case "invoice.issued":
      put("total_cents", sumLineAmounts(payload["lines"]));
      put("invoice_ref", readStr(payload["invoice_id"]));
      put("party", readStr(payload["party_id"]));
      put("division", readStr(payload["division"]));
      break;
    case "split.computed":
      put("total_cents", readInt(payload["total_cents"]));
      put("party", firstAllocationParty(payload["allocations"]));
      break;
    case "dispatch.assigned":
      put("driver", readStr(payload["driver_user_id"]));
      put("asset", readStr(payload["asset_id"]));
      break;
    case "appointment.set":
      put("facility", readStr(payload["facility_id"]));
      put("slot", readStr(payload["slot_key"]));
      put("window_start_ms", readInt(payload["window_start_ts"]));
      put("window_end_ms", readInt(payload["window_end_ts"]));
      put("leg_kind", readStr(payload["leg_kind"]));
      break;
  }
  return out;
}

/**
 * projectOut — PURE + DETERMINISTIC: SHUDDL-held facts + the SAME LegacyMirrorConfig → the incumbent-format
 * outbound rows, each EMBEDDING its SHUDDL event id in `config.echoColumn` (the no-ping-pong contract, REQ-022).
 * Only the MIRROR_KINDS the config maps are projected; every other kind is skipped. A fact with a blank id is
 * REFUSED (a blank echo column would make the mirror-IN NOT recognize the echo ⇒ a silent ping-pong) — better a
 * loud throw than a native fact that re-enters as legacy. NO I/O, NO Date, NO crypto (the worker does that).
 */
export function projectOut(events: readonly ProjectableEvent[], config: LegacyMirrorConfig): OutboundRow[] {
  // First spec per kind (a config declares at most one record per mirror kind; first wins deterministically).
  const specByKind = new Map<MirrorKind, LegacyRecordSpec>();
  for (const rec of config.records) if (!specByKind.has(rec.kind)) specByKind.set(rec.kind, rec);

  const rows: OutboundRow[] = [];
  for (const ev of events) {
    if (!isMirrorKind(ev.kind)) continue; // not an outbound-relevant fact — skip (never a wrong-kind projection)
    const spec = specByKind.get(ev.kind);
    if (spec === undefined) continue; // the config chose not to project this kind
    if (ev.id.trim() === "") {
      throw new Error(`projectOut: event id is required for the ${config.echoColumn} echo embed (REQ-022 no-ping-pong)`);
    }

    const cells = nullMap();
    // control columns — the inverse of the mirror-IN control reads (typeColumn ← the record spec's match, etc.).
    cells[config.typeColumn] = spec.match;
    cells[config.cursorColumn] = String(ev.cursor);
    cells[config.keyColumn] = ev.naturalKey;
    cells[config.streamColumn] = ev.streamKey;
    if (config.tsColumn !== undefined && ev.ts !== undefined) cells[config.tsColumn] = String(ev.ts);
    // THE ECHO EMBED (REQ-022): the SHUDDL event id rides the SHARED echoColumn ⇒ the mirror-IN skips the echo.
    cells[config.echoColumn] = ev.id;

    // the field inverse — write each recovered value to its field spec's column (config-driven; only mapped fields).
    const inverse = inverseFieldValues(ev.kind, ev.payload);
    for (const [field, fieldSpec] of Object.entries(spec.fields)) {
      const value = inverse[field];
      if (value !== undefined) cells[fieldSpec.column] = value;
    }

    rows.push({ eventId: ev.id, kind: ev.kind, cells });
  }
  return rows;
}

// ── the representative serializer (CSV) ──────────────────────────────────────────────────────────────────────
// GENERIC / no vendor identity (REQ-167): a concrete outbound format (CSV here) is a tenant-pack detail. This CSV
// serializer is the REPRESENTATIVE format — an XML/EDI/PDF serializer renders the SAME neutral `OutboundRow.cells`
// through a different tenant-pack format module. The header is derived from the config so the output parses back
// through the SAME parseSheet the mirror-IN reads (a byte-clean round-trip). PURE — string out, no I/O.

// The deterministic outbound header: the control columns (in a fixed order) then every field column across the
// records, de-duplicated, first-occurrence order — independent of row data.
function outboundHeaders(config: LegacyMirrorConfig): string[] {
  const seen = new Set<string>();
  const push = (h: string, into: string[]): void => {
    if (!seen.has(h)) {
      seen.add(h);
      into.push(h);
    }
  };
  const headers: string[] = [];
  push(config.typeColumn, headers);
  push(config.cursorColumn, headers);
  push(config.echoColumn, headers);
  push(config.keyColumn, headers);
  push(config.streamColumn, headers);
  if (config.tsColumn !== undefined) push(config.tsColumn, headers);
  for (const rec of config.records) for (const spec of Object.values(rec.fields)) push(spec.column, headers);
  return headers;
}

// RFC-4180 escaping that round-trips through parseSheet: quote a field containing a comma, quote, CR or LF, and
// double any embedded quote. (An embedded SHUDDL id or JSON-ish value never desynchronizes a column.)
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * serializeOutboundCsv — the REPRESENTATIVE outbound format: project-OUT rows → a CSV the incumbent can re-import
 * and the mirror-IN can re-read (via parseSheet) verbatim. PURE (string in the cells, string out). The header +
 * every row are aligned to the config-derived column order, so a missing cell is a blank field (never a shifted
 * column). An XML/EDI/PDF serializer is the same rows through a tenant-pack format module (out of repo scope).
 */
export function serializeOutboundCsv(rows: readonly OutboundRow[], config: LegacyMirrorConfig): string {
  const headers = outboundHeaders(config);
  const lines: string[] = [headers.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvField(row.cells[h] ?? "")).join(","));
  }
  return `${lines.join("\n")}\n`;
}
