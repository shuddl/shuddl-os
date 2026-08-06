// WP-15 Task 4 (REQ-021 / REQ-022 / REQ-035) — THE CONTINUOUS 171-COL LEGACY-MIRROR SWEEP: the zero-cutover
// overlay's ingest half. It reads the incumbent's legacy export, DIFFS it against a per-tenant watermark, and
// mirrors every NEW/CHANGED row into the ledger as a `source:'legacy'` event THROUGH the api sequencer DO — so
// SHUDDL can run ALONGSIDE the incumbent and the Task-6 parity primitive can compare native-vs-legacy per module
// (rating/invoicing/settlement/dispatch) BEFORE any authority flips. The PURE mapping + gap-row + echo law lives
// in @shuddl/adapters (legacy-mirror.ts, I/O-free, shared with the WP-14 migrator's confidence + gap-row core);
// this file is the I/O + composition + idempotency wiring, mirroring workers/translator/src/inbound.ts (the
// continuous EDI adapter): the SAME injected SeqStubLike append port, the SAME deterministic-id/quarantine-not-
// drop discipline, and workers/agents/src/recon-sweep.ts's bounded per-tenant cron shape (`now` injected).
//
// THE LAWS (each has a test — packages/adapters + workers/agents/test/mirror-sweep):
//   1. MIRROR = source:'legacy' EVENTS (REQ-021), appended via the DO. NO shadow table, NO new kind/table.
//   2. NO SILENT DROP, CONTINUOUSLY (rule 10 / REQ-035): every unmapped export column raises a gap `anomalies`
//      row on EVERY sweep — the id folds the sweep clock so a re-run RE-raises it (a persistent "these columns are
//      still dropped" monitor), while a same-tick retry dedupes. The per-row values ride the anchored shipment refs.
//   3. ECHO-SAFE (REQ-022): (a) the event id is DETERMINISTIC in the row's natural key + content, so a redelivered/
//      re-ingested identical row reproduces the id → the DO dedupes (idempotent); a CHANGED value ⇒ a new id ⇒ a
//      new legacy event (a correction). (b) A row carrying an embedded SHUDDL event id (echoed back by the
//      incumbent) is skipped by the mapper — never re-appended as legacy (no ping-pong).
//   4. WATERMARK-DIFFED (REQ-021): only rows whose cursor exceeds the stored watermark are APPENDED (O(changed));
//      the watermark lives on `integrations.config` (a JSON field on the EXISTING row — the CHECK is never amended,
//      no table/column added) and advances each sweep.
//   5. GENERIC / no vendor identity (REQ-167): the 171 headers + record kinds + cadence are TENANT-PACK config
//      (outside the repo); this worker is config-driven. The repo ships only a synthetic neutral fixture/config.
//   6. TENANT-ISOLATED (REQ-025): the caller binds `db` to ONE tenant; every append names ONLY that tenant; every
//      key derives from the row's own stream key. It can never touch another tenant.
//   7. LLM-FREE (REQ-024): a durable D1 read + integer/crypto id derivation. No LLM anywhere.
//
// FAIL-CLOSED / DORMANT-UNTIL-CUTOVER (the composition root — see index.ts): the default FeedReader is
// NotConfiguredFeedReader (returns null ⇒ no-op), the SAME posture as NotConfiguredSender/NotConfiguredTransport,
// AND absent an `integrations` row the sweep no-ops. So the cron is INERT in every environment until a tenant pack
// deliberately wires a real feed at Phase-0 cutover (genesis/13). The read-model projection interaction (a legacy
// invoice.issued would otherwise project AR alongside native) is the Task-2 DORMANT native-suppression / cutover
// concern (NON-scope here) — this task ships the mirror-IN machinery fail-closed and does NOT change compute paths.
import { mapLegacyExport, parseSheet, LegacyMirrorConfigSchema, stableStringify } from "@shuddl/adapters";
import type { LegacyMirrorConfig, MirrorEventDraft, MirrorQuarantine } from "@shuddl/adapters";
import { EventInput } from "@shuddl/contracts";

// The api sequencer DO append surface — hand-written for the SAME reason inbound.ts / the agents Biller bind it:
// the generic DurableObjectStub RPC mapper explodes on the recursive event union. Only `id` is consumed. In
// production this routes to `env.SHIPMENT_SEQ.get(idFromName(...)).append(...)` (index.ts sequencerFor).
export interface SeqStubLike {
  append(req: { tenant: string; streamId: string; input: unknown }): Promise<{ id: string }>;
}

// The legacy-export source port. The composition root injects the live wiring (an R2 object the incumbent drops,
// or a pull); tests inject a static feed. The DEFAULT is fail-closed (null ⇒ the sweep no-ops) so no environment
// mirrors a real feed until a tenant deliberately wires it — the symmetric twin of NotConfiguredTransport.
export interface FeedReader {
  /** The current legacy export bytes (CSV text), or null when no feed is wired (fail-closed no-op). */
  read(): Promise<string | null>;
}

export class NotConfiguredFeedReader implements FeedReader {
  async read(): Promise<string | null> {
    return null;
  }
}

// The integrations row that carries `{ legacy_mirror: { mapping, watermark } }`. The sweep resolves it BY ID
// (kind-agnostic), so the tenant pack may register it under any existing integrations.kind (the CHECK is never
// amended) — the id is the contract. A fixed id per tenant D1 (the DBs are physically separate — REQ-025).
export const LEGACY_MIRROR_INTEGRATION_ID = "legacy-mirror";

// A server sentinel actor for the mirror (mirrors inbound.ts's "agent:rater") — no parties FK is accrued.
const LEGACY_ACTOR = "agent:legacy-mirror";
const MAX_SAMPLE = 200; // the anomaly detail sample is truncated

export interface MirrorSweepDeps {
  /** The tenant's OWN D1 (REQ-025) — the only tenant data path. */
  db: D1Database;
  /** The api sequencer DO append surface — the ONLY event write path (the gates + projections run there). */
  seq: SeqStubLike;
  /** The legacy export source (config-driven; fail-closed default). */
  feed: FeedReader;
  /** The integrations row id carrying the mapping + watermark. */
  integrationId: string;
  /** Names this ONE tenant on every append (REQ-025). */
  tenant: string;
  /** The sweep clock (injected; the cron reads wall-clock). Folded into the re-raised gap-anomaly ids + stamps ts. */
  now: number;
}

export interface MirrorSweepResult {
  configured: boolean;
  /** Records EXAMINED this sweep (cursor beyond the watermark). */
  scanned: number;
  /** source:'legacy' events appended (O(changed)). */
  appended: number;
  /** Rows skipped as SHUDDL echoes (REQ-022). */
  echoed: number;
  /** Malformed rows retained (never dropped). */
  quarantined: number;
  /** Export columns re-raised as gap rows THIS sweep (continuous no-silent-drop). */
  gapColumns: number;
  watermarkFrom: number;
  watermarkTo: number;
}

const ZERO: Omit<MirrorSweepResult, "configured"> = { scanned: 0, appended: 0, echoed: 0, quarantined: 0, gapColumns: 0, watermarkFrom: 0, watermarkTo: 0 };

// ── deterministic id helpers (replicated from inbound.ts — the SAME v4-variant shaping, so a redelivered row
//    reproduces the SAME id and the sequencer dedupes by id). PURE of Date/random. ──────────────────────────────
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function deterministicUuid(seed: string): Promise<string> {
  const h = (await sha256Hex(seed)).slice(0, 32);
  const variant = ((parseInt(h.slice(16, 17) || "0", 16) & 0x3) | 0x8).toString(16); // 8/9/a/b
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
// stableStringify is imported from @shuddl/adapters — THE ONE canonical echo-contract stringify (shared by the
// mirror-IN idSeed, the project-OUT, and this worker's quarantine-id derivation). No hand-copied replica ⇒ the
// real-world idSeed can never silently drift from the echo contract (REQ-022; a drifted stringify = a ping-pong).

// Resolve the mapping config + watermark cursor off the integrations row. Returns null when the row/section is
// absent (⇒ the sweep no-ops — fail-closed). Validates the mapping at the boundary (Zod), so a malformed pack
// config fails LOUD here, never as a silent wrong-mapping.
interface ResolvedConfig {
  raw: Record<string, unknown>;
  mapping: LegacyMirrorConfig;
  watermark: number;
}
async function resolveConfig(db: D1Database, integrationId: string): Promise<ResolvedConfig | null> {
  const row = await db.prepare("SELECT config FROM integrations WHERE id = ? LIMIT 1").bind(integrationId).first<{ config: string }>();
  if (row === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(row.config);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const section = (raw as { legacy_mirror?: unknown }).legacy_mirror;
  if (typeof section !== "object" || section === null) return null;
  const s = section as { mapping?: unknown; watermark?: { cursor?: unknown } };
  const mapping = LegacyMirrorConfigSchema.parse(s.mapping);
  const cursor = s.watermark?.cursor;
  const watermark = typeof cursor === "number" && Number.isSafeInteger(cursor) ? cursor : 0;
  return { raw: raw as Record<string, unknown>, mapping, watermark };
}

// Anchor a legacy stream: a synthetic legacy party + a minimal shipments row (INSERT OR IGNORE — idempotent). The
// unmapped per-row values ride the shipment refs so nothing is lost (rule 10). A collision-proof id namespace
// (`shp_lg_`/`pty_lg_`) keeps a legacy stream distinct from any native uuid stream. Mirrors inbound.ts's persist.
async function anchorStream(db: D1Database, streamKey: string, draft: MirrorEventDraft, now: number): Promise<string> {
  const h = (await sha256Hex(streamKey)).slice(0, 16);
  const shipmentId = `shp_lg_${h}`;
  const partyId = `pty_lg_${h}`;
  await db
    .prepare("INSERT OR IGNORE INTO parties (id, kind, names, external_refs) VALUES (?,?,?,?)")
    .bind(partyId, "broker", JSON.stringify({ legal: "Legacy counterparty (mirror)" }), JSON.stringify({ legacy_stream_key: streamKey }))
    .run();
  const refs = JSON.stringify({ ...draft.retainedRefs, legacy_stream_key: streamKey, source: "legacy" });
  await db
    .prepare(
      "INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, mode, division, refs, created_ts) VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(shipmentId, partyId, partyId, partyId, "brokered", "main", refs, now)
    .run();
  return shipmentId;
}

async function writeQuarantine(db: D1Database, tenant: string, q: MirrorQuarantine): Promise<void> {
  // Idempotent by CONTENT (natural key + reason + the raw row), NOT the clock — a re-ingested identical bad row
  // dedupes, so quarantine never storms (contrast the gap rows, which fold the clock to re-raise every sweep).
  const id = `lgm_quar_${(await sha256Hex(`${tenant}:${q.naturalKey}:${q.reason}:${stableStringify(q.raw)}`)).slice(0, 24)}`;
  const detail = JSON.stringify({ reason: q.reason, detail: truncate(q.detail, MAX_SAMPLE), natural_key: q.naturalKey, raw: q.raw });
  await db
    .prepare("INSERT OR IGNORE INTO anomalies (id, rule, object_kind, object_id, severity, detail, status) VALUES (?,?,?,?,?,?,'open')")
    .bind(id, "legacy_mirror.quarantine", "legacy_row", truncate(q.naturalKey, 120), "warn", detail)
    .run();
}

/**
 * Sweep ONE tenant's legacy export into the ledger as source:'legacy' events. Idempotent + BOUNDED + fail-closed:
 * no integrations row / no feed ⇒ a clean no-op; every append is deterministic (a re-ingest dedupes at the DO);
 * the watermark makes appends O(changed); the gap rows re-raise every sweep. REQ-025-isolated: `db`/`tenant` name
 * one tenant. `now` is injected (the cron reads wall-clock). NEVER a silent drop, NEVER a throw-storm.
 */
export async function sweepTenantLegacyMirror(deps: MirrorSweepDeps): Promise<MirrorSweepResult> {
  const { db, seq, feed, integrationId, tenant, now } = deps;

  const cfg = await resolveConfig(db, integrationId);
  if (cfg === null) return { configured: false, ...ZERO };

  const text = await feed.read();
  if (text === null) return { configured: true, ...ZERO, watermarkFrom: cfg.watermark, watermarkTo: cfg.watermark };

  const sheet = parseSheet(text);
  const { records, gapRows } = mapLegacyExport(sheet, cfg.mapping);

  // ── LAW 2: the gap rows re-raise EVERY sweep (the id folds `now`). A same-tick retry dedupes; a later tick
  //    re-raises (a persistent "these columns still map to nothing" monitor). Independent of the watermark, so a
  //    no-new-data tick still re-raises the schema drift. ──────────────────────────────────────────────────────
  for (const g of gapRows) {
    const rule = g.reason === "low_confidence" ? "legacy_mirror.low_confidence_column" : "legacy_mirror.unmapped_column";
    const id = `lgm_gap_${(await sha256Hex(`${tenant}:${now}:${g.reason}:${g.columnOrdinal}:${g.column}`)).slice(0, 24)}`;
    const detail = JSON.stringify({
      column: truncate(g.column, 120),
      column_ordinal: g.columnOrdinal,
      retention_key: truncate(g.retentionKey, 120),
      confidence: g.confidence,
      sample: g.sample !== null ? truncate(g.sample, MAX_SAMPLE) : null,
    });
    await db
      .prepare("INSERT OR IGNORE INTO anomalies (id, rule, object_kind, object_id, severity, detail, status) VALUES (?,?,?,?,?,?,'open')")
      .bind(id, rule, "legacy_column", truncate(g.column, 120), "warn", detail)
      .run();
  }

  // ── LAW 4: watermark diff — process ONLY records beyond the stored cursor (O(changed)). A null-cursor row (a
  //    bad_cursor quarantine) is always examined (it never advances the watermark; its anomaly is idempotent). ──
  const isNew = (c: number | null): boolean => c === null || c > cfg.watermark;
  const fresh = records.filter((r) => isNew(r.cursor)).sort((a, b) => (a.cursor ?? Number.MAX_SAFE_INTEGER) - (b.cursor ?? Number.MAX_SAFE_INTEGER));

  let appended = 0;
  let echoed = 0;
  let quarantined = 0;
  let maxCursor = cfg.watermark;
  for (const rec of records) if (rec.cursor !== null && rec.cursor > maxCursor) maxCursor = rec.cursor;

  for (const rec of fresh) {
    if (rec.echo) {
      // Count the echo and exit early. NOTE (audit §398): this line does NOT enforce LAW 3(b) — the mapper
      // does. `packages/adapters/src/legacy-mirror.ts:291@echo` pushes an echoed row with NO `event` field, so
      // `if (draft === undefined) continue` below catches it whether or not this branch exists. Removing this
      // `continue` changes no append behaviour and no test (measured). What this branch owns is the `echoed`
      // COUNTER in the summary; the ping-pong guarantee is the mapper's, exactly as the file header says.
      echoed += 1;
      continue;
    }
    if (rec.quarantine !== undefined) {
      await writeQuarantine(db, tenant, rec.quarantine); // LAW: retain, never drop
      quarantined += 1;
      continue;
    }
    const draft = rec.event;
    if (draft === undefined) continue; // (defensive — a non-echo, non-quarantine record always carries an event)

    const shipmentId = await anchorStream(db, draft.streamKey, draft, now);
    const streamId = `s:${shipmentId}`;
    const id = await deterministicUuid(draft.idSeed); // LAW 3(a): deterministic ⇒ DO dedupe on re-ingest
    const candidate = {
      id,
      shipment_id: shipmentId,
      ts: draft.ts ?? now,
      actor: { party: LEGACY_ACTOR },
      party_refs: [] as string[],
      evidence: [] as { doc_id: string; hash: string }[],
      source: "legacy" as const,
      confidence: draft.confidenceBps,
      kind: draft.kind,
      payload: draft.payload,
    };
    // Validate at the DO boundary (Zod) — a payload the mapper built wrong is QUARANTINED, never appended as
    // garbage (fail-closed). This is also the drift guard for the mapper's local kind union vs the 35-catalog.
    const parsed = EventInput.safeParse(candidate);
    if (!parsed.success) {
      await writeQuarantine(db, tenant, { naturalKey: draft.naturalKey, reason: "bad_value", detail: `EventInput rejected: ${parsed.error.message}`, raw: { kind: draft.kind } });
      quarantined += 1;
      continue;
    }
    await seq.append({ tenant, streamId, input: parsed.data });
    appended += 1;
  }

  // ── LAW 4: advance the watermark on integrations.config (the EXISTING row; no CHECK amend, no new column). ──
  if (maxCursor > cfg.watermark) {
    const next = { ...cfg.raw, legacy_mirror: { ...(cfg.raw["legacy_mirror"] as Record<string, unknown>), watermark: { cursor: maxCursor } } };
    await db.prepare("UPDATE integrations SET config = ? WHERE id = ?").bind(JSON.stringify(next), integrationId).run();
  }

  return { configured: true, scanned: fresh.length, appended, echoed, quarantined, gapColumns: gapRows.length, watermarkFrom: cfg.watermark, watermarkTo: maxCursor };
}
