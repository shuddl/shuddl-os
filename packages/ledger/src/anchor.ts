// Daily Merkle -> TSA anchor (REQ-014, REQ-002). Once a day the ledger folds everything the DB
// learned that day into one RFC 6962 Merkle root and gets that root RFC-3161 timestamped by an
// independent authority. The receipt is the proof that a POD hash — a signature at a door — was
// witnessed by a third party at a known time. Verifying a POD hash against the receipt is the whole
// point (REQ-014 DoD).
//
// Two rules are load-bearing and easy to get wrong:
//  1. LEAF ORDER is total and stable (Decision 7): events by (stream_id, seq) — stream_id is never
//     NULL — THEN positions by (shipment_id, device_id, ts). Any instability makes the root
//     non-reproducible and the anchor worthless. Event leaf data = the hex-decoded `hash` column;
//     position leaf data = the canonical row bytes (positions bypass the DO, so their canonical row
//     IS their integrity anchor — doc 10 §01).
//  2. DAY BUCKETING uses `recorded_at` (the server clock), NEVER the actor's `ts`. An airplane-mode
//     upload carries yesterday's physical timestamp; bucketing on it would mutate an already-anchored
//     day. The anchor attests "known to the ledger by day D."
//
// Storage adds NO table and NO column (I8 intact): an anchor is a `documents` row with a deterministic
// id `anchor:{day}`, kind `tsa_receipt`, hash = root hex. The row exists IFF fully anchored (root
// computed AND receipt stored) — R2 is written first, the row last, and re-runs use INSERT OR IGNORE.
//
// PURE of LLM (REQ-024). WebCrypto + injected D1/R2/TSA only.

import { canonicalBytes, sha256Hex } from "./canonical.js";
import { bytesToHex, hexToBytes, inclusionProof, merkleRoot, type ProofStep } from "./merkle.js";
import { retentionClassFor } from "./documents/retention.js";
import type { TsaClient } from "./tsa/client.js";

const IMPRINT_PREFIX = "shuddl-anchor-v1";
const DAY_MS = 86_400_000;
const MAX_DAYS_PER_RUN = 30;
const CONSECUTIVE_FAILURE_ESCALATION = 3;

export interface AnchorDeps {
  db: D1Database;
  r2: R2Bucket;
  tsa: TsaClient;
  tenant: string;
  now: () => Date;
}

export interface AnchorRunResult {
  /** Days newly anchored this run (oldest-first). */
  anchored: string[];
  /** Days already carrying their `documents` row — a no-op. */
  skipped: string[];
  /** Days that could not anchor (TSA refusal, boundary race, or a day that could not be built) — retried next run. */
  failed: string[];
}

// UTC day bucket (YYYY-MM-DD) of an epoch-ms `recorded_at`. UTC, never local time.
export function dayOf(recordedAtMs: number): string {
  return new Date(recordedAtMs).toISOString().slice(0, 10);
}
function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

export function anchorReceiptKey(tenant: string, day: string): string {
  return `anchors/${tenant}/${day}/tsr.der`;
}
export function anchorManifestKey(tenant: string, day: string): string {
  return `anchors/${tenant}/${day}/manifest.json`;
}
export function anchorDocId(day: string): string {
  return `anchor:${day}`;
}

export interface PositionRow {
  shipment_id: string;
  device_id: string;
  ts: number;
  lat_e6: number;
  lon_e6: number;
  accuracy_m: number | null;
  speed_cms: number | null;
}

// The canonical bytes of a position row — byte-identical to what the /v1/positions ingest hashed as
// the row's integrity anchor (the client-meaningful fields only; `recorded_at` is excluded). This IS
// the Merkle leaf data for a position. Keep in lockstep with workers/api/src/routes/positions.ts.
export function canonicalPositionBytes(row: PositionRow): Uint8Array {
  const canon: Record<string, number | string> = {
    shipment_id: row.shipment_id,
    device_id: row.device_id,
    ts: row.ts,
    lat_e6: row.lat_e6,
    lon_e6: row.lon_e6,
  };
  if (row.accuracy_m !== null) canon.accuracy_m = row.accuracy_m;
  if (row.speed_cms !== null) canon.speed_cms = row.speed_cms;
  return canonicalBytes(canon);
}

interface DayLeaves {
  leaves: Uint8Array[];
  eventCount: number;
  positionCount: number;
}

async function dayLeaves(db: D1Database, dayStart: number, dayEnd: number): Promise<DayLeaves> {
  const events = await db
    .prepare("SELECT hash FROM events WHERE recorded_at >= ? AND recorded_at < ? ORDER BY stream_id, seq")
    .bind(dayStart, dayEnd)
    .all<{ hash: string }>();
  const positions = await db
    .prepare(
      "SELECT shipment_id, device_id, ts, lat_e6, lon_e6, accuracy_m, speed_cms FROM positions WHERE recorded_at >= ? AND recorded_at < ? ORDER BY shipment_id, device_id, ts",
    )
    .bind(dayStart, dayEnd)
    .all<PositionRow>();
  const leaves: Uint8Array[] = [];
  for (const e of events.results) leaves.push(hexToBytes(e.hash)); // events FIRST
  for (const p of positions.results) leaves.push(canonicalPositionBytes(p)); // positions SECOND
  return { leaves, eventCount: events.results.length, positionCount: positions.results.length };
}

async function countDayRows(db: D1Database, dayStart: number, dayEnd: number): Promise<number> {
  const e = await db
    .prepare("SELECT count(*) AS c FROM events WHERE recorded_at >= ? AND recorded_at < ?")
    .bind(dayStart, dayEnd)
    .first<{ c: number }>();
  const p = await db
    .prepare("SELECT count(*) AS c FROM positions WHERE recorded_at >= ? AND recorded_at < ?")
    .bind(dayStart, dayEnd)
    .first<{ c: number }>();
  return (e?.c ?? 0) + (p?.c ?? 0);
}

export interface AnchorManifest {
  version: string;
  tenant: string;
  day: string;
  root: string;
  leaf_count: number;
  event_count: number;
  position_count: number;
  imprint: string;
  imprint_message: string;
  receipt_key: string;
  created_at: string;
}

async function anchorDay(deps: AnchorDeps, day: string): Promise<"anchored" | "failed"> {
  const { db, r2, tsa, tenant } = deps;
  const dayStart = dayStartMs(day);
  const dayEnd = dayStart + DAY_MS;

  // Boundary race guard: count the day's rows, build the tree, recount. A row landing mid-build
  // (recorded_at right at the boundary) would give a root that doesn't match the row set — abort and
  // retry next run rather than anchor a root nothing can reproduce.
  const countBefore = await countDayRows(db, dayStart, dayEnd);
  const { leaves, eventCount, positionCount } = await dayLeaves(db, dayStart, dayEnd);
  const countAfter = await countDayRows(db, dayStart, dayEnd);
  if (countBefore !== countAfter || countAfter !== leaves.length) return "failed";

  const root = await merkleRoot(leaves);
  const rootHex = bytesToHex(root);
  const leafCount = leaves.length;

  // The imprint binds MORE than the root — tenant, day, and leaf count too — so a receipt for one
  // (tenant, day) can never be replayed as another.
  const imprintMessage = `${IMPRINT_PREFIX}:${tenant}:${day}:${rootHex}:${leafCount}`;
  const imprint = hexToBytes(await sha256Hex(new TextEncoder().encode(imprintMessage)));

  let tsr: Uint8Array;
  try {
    tsr = await tsa.timestamp(imprint);
  } catch (err) {
    // Guarded: a D1 fault while recording a TSA outage must not escape into the caller's per-day
    // containment, where it would be recorded a SECOND time as `anchor.build_failed` — exactly the
    // mislabelling the two kinds exist to prevent. The day is `failed` either way; only the note is
    // best-effort.
    await recordAnchorFailure(db, TSA_UNAVAILABLE, tenant, day, err).catch((recErr: unknown) => {
      console.error(`[REQ-014] anchor day ${day} (tenant ${tenant}): TSA failure could not be recorded: ${recErr instanceof Error ? recErr.message : "unknown"}`);
    });
    return "failed";
  }

  const receiptKey = anchorReceiptKey(tenant, day);
  const manifest: AnchorManifest = {
    version: IMPRINT_PREFIX,
    tenant,
    day,
    root: rootHex,
    leaf_count: leafCount,
    event_count: eventCount,
    position_count: positionCount,
    imprint: bytesToHex(imprint),
    imprint_message: imprintMessage,
    receipt_key: receiptKey,
    created_at: deps.now().toISOString(),
  };

  // R2 FIRST (raw .tsr + manifest), documents row LAST — so the row exists iff fully anchored. A crash
  // between the two just leaves the day unanchored (no row); next run re-timestamps (deterministic
  // root, new nonce) and INSERT OR IGNORE lands the row. Never INSERT OR REPLACE (source lint bans it).
  await r2.put(receiptKey, tsr as ArrayBuffer | Uint8Array);
  await r2.put(anchorManifestKey(tenant, day), JSON.stringify(manifest));
  // REQ-116 — the tsa_receipt carries its retention CLASS at write (retentionClassFor('tsa_receipt') = the
  // 7-year 'pod-7yr' compliance hold): the anchor witness proof is kept as long as the POD it attests, and the
  // retention sweep NEVER deletes it (both by kind-exclusion and by the 7yr duration). created_ts is left to
  // its column DEFAULT — a tsa_receipt is never swept, so its retention clock is moot (the INSERT column list
  // stays unchanged, so a DB migrated without 0007 still accepts this write).
  await db
    .prepare(
      "INSERT OR IGNORE INTO documents (id, shipment_id, party_id, kind, r2_key, hash, lifecycle_class, visibility) VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(anchorDocId(day), null, null, "tsa_receipt", receiptKey, rootHex, retentionClassFor("tsa_receipt"), "internal")
    .run();

  // The day IS anchored now — R2 written, documents row committed. Clearing the markers is RECOVERY
  // BOOKKEEPING, not part of anchoring, so it is guarded HERE rather than left to the caller's per-day
  // containment: a rejection there would report an anchored, witnessed, verifiable day as `failed`, and
  // nothing could ever correct that verdict — the next run sees this documents row, marks the day
  // `skipped`, and never calls anchorDay again, so the stale marker could never clear or escalate.
  await clearAnchorFailures(db, tenant, day).catch((err: unknown) => {
    console.error(`[REQ-014] anchor day ${day} (tenant ${tenant}) anchored, but its failure markers could not be cleared: ${err instanceof Error ? err.message : "unknown"}`);
  });
  return "anchored";
}

export async function runDailyAnchor(deps: AnchorDeps): Promise<AnchorRunResult> {
  const { db, now } = deps;
  const result: AnchorRunResult = { anchored: [], skipped: [], failed: [] };

  const minRow = await db
    .prepare("SELECT MIN(recorded_at) AS m FROM (SELECT recorded_at FROM events UNION ALL SELECT recorded_at FROM positions)")
    .first<{ m: number | null }>();
  if (minRow?.m == null) return result; // nothing recorded yet

  const todayStart = dayStartMs(dayOf(now().getTime()));
  const yesterdayStart = todayStart - DAY_MS; // anchor only days that can no longer grow (past midnight)
  const firstDayStart = dayStartMs(dayOf(minRow.m));
  if (firstDayStart > yesterdayStart) return result; // only today's data exists

  // One query for every already-anchored day, so a long backlog doesn't fan out into N point reads.
  const existing = await db
    .prepare("SELECT id FROM documents WHERE kind = 'tsa_receipt' AND id LIKE 'anchor:%'")
    .all<{ id: string }>();
  const anchoredDays = new Set(existing.results.map((r) => r.id.slice("anchor:".length)));

  const candidates: string[] = [];
  for (let ds = firstDayStart; ds <= yesterdayStart; ds += DAY_MS) {
    const day = dayOf(ds);
    if (anchoredDays.has(day)) {
      result.skipped.push(day);
      continue;
    }
    candidates.push(day); // empty days included -> gap-free day chain
    if (candidates.length >= MAX_DAYS_PER_RUN) break; // oldest-first, capped
  }

  for (const day of candidates) {
    // One unreadable day must not abandon the others. anchorDay already returns "failed" for the two
    // failures it owns (the boundary race, a TSA refusal); this contains everything else — a malformed
    // row reaching the leaf reader, an R2 fault — so the run reports that day in `failed`, the array
    // this result declares for exactly this purpose, instead of throwing away every good day with it.
    // A backfill spans up to MAX_DAYS_PER_RUN days; failing all of them on one bad day is the wrong
    // trade. What holds for a day contained here: NO `documents` row — it is anchorDay's LAST write, so
    // nothing that throws before it can have written one. (An R2 fault between the two puts can orphan
    // a receipt object, exactly as it could before this catch existed; it is unreachable without the
    // documents row and the next successful run overwrites it.) Everything anchorDay does AFTER that
    // row is guarded there, so a day that IS anchored is never reported failed here.
    let outcome: "anchored" | "failed";
    try {
      outcome = await anchorDay(deps, day);
    } catch (err) {
      outcome = "failed"; // the verdict is decided FIRST — nothing below may change it or re-raise
      await noteBuildFailure(deps, day, err);
    }
    (outcome === "anchored" ? result.anchored : result.failed).push(day);
  }

  // The BACKSTOP for the one hazard anchorDay's guarded clear leaves behind: a clear that rejects after
  // the documents row commits leaves the markers standing on a day that IS anchored, and that day is
  // `skipped` from then on — anchorDay is never called again, so nothing could ever clear or escalate
  // them. This sweep keys on the anchored-ness of the DAY, not on this run's outcome, so it collects a
  // marker no matter which run stranded it. Guarded and last, like every other piece of bookkeeping here:
  // a fault must not touch the verdicts above. Skipped when no day is anchored — nothing to sweep.
  if (result.anchored.length + result.skipped.length > 0) {
    await sweepAnchoredDayMarkers(db, deps.tenant).catch((err: unknown) => {
      console.error(`[REQ-014] anchor run (tenant ${deps.tenant}): stale marker sweep failed: ${err instanceof Error ? err.message : "unknown"}`);
    });
  }
  return result;
}

// ---- inclusion proof for a leaf against an anchored day (REQ-014 DoD verification path) ----------

export interface AnchorProof {
  day: string;
  root: string;
  steps: ProofStep[];
  leafCount: number;
  receipt_doc_id: string;
}

// Build the inclusion proof for `leafHex` (an event hash, or the hex of a position's canonical bytes)
// against the anchored root for `day`. The recomputed root is cross-checked against the `documents`
// row — a mismatch means the underlying rows changed after anchoring (tamper), which throws.
export async function anchorProof(db: D1Database, day: string, leafHex: string): Promise<AnchorProof> {
  const doc = await db.prepare("SELECT hash FROM documents WHERE id = ?").bind(anchorDocId(day)).first<{ hash: string }>();
  if (!doc) throw new Error(`ANCHOR_NOT_FOUND: ${day}`);
  const dayStart = dayStartMs(day);
  const { leaves } = await dayLeaves(db, dayStart, dayStart + DAY_MS);
  const target = leafHex.toLowerCase();
  const index = leaves.findIndex((l) => bytesToHex(l) === target);
  if (index < 0) throw new Error(`LEAF_NOT_IN_DAY: ${target} not anchored on ${day}`);
  const steps = await inclusionProof(leaves, index);
  const rootHex = bytesToHex(await merkleRoot(leaves));
  if (rootHex !== doc.hash) throw new Error(`ROOT_DRIFT: recomputed ${rootHex} != anchored ${doc.hash}`);
  return { day, root: rootHex, steps, leafCount: leaves.length, receipt_doc_id: anchorDocId(day) };
}

export async function readAnchorManifest(r2: R2Bucket, tenant: string, day: string): Promise<AnchorManifest | null> {
  const obj = await r2.get(anchorManifestKey(tenant, day));
  if (!obj) return null;
  return JSON.parse(await obj.text()) as AnchorManifest;
}

// ---- anchor failure accounting (no new table): one mutable `anomalies` row per (kind, tenant, day) --
// Consecutive failures accrue in the row's detail; at 3 the row escalates to `critical` — the alert
// that a day cannot be witnessed. On success the markers are cleared (the day is anchored regardless).
//
// TWO kinds, because "we built a root and the TSA refused to stamp it" and "we could not build the day
// at all" send ops after different things. Same accounting, same escalation, separate id + rule so the
// alert names the real condition.
const TSA_UNAVAILABLE = { idPrefix: "anchor-tsa", rule: "anchor.tsa_unavailable" } as const;
const BUILD_FAILED = { idPrefix: "anchor-build", rule: "anchor.build_failed" } as const;
type AnchorFailureKind = typeof TSA_UNAVAILABLE | typeof BUILD_FAILED;

const ANCHOR_FAILURE_KINDS: readonly AnchorFailureKind[] = [TSA_UNAVAILABLE, BUILD_FAILED];
const failureId = (kind: AnchorFailureKind, tenant: string, day: string): string => `${kind.idPrefix}:${tenant}:${day}`;

async function recordAnchorFailure(
  db: D1Database,
  kind: AnchorFailureKind,
  tenant: string,
  day: string,
  err: unknown,
): Promise<void> {
  const id = failureId(kind, tenant, day);
  const existing = await db.prepare("SELECT detail FROM anomalies WHERE id = ?").bind(id).first<{ detail: string }>();
  const prev = existing ? (JSON.parse(existing.detail) as { consecutive?: number }) : {};
  const consecutive = (prev.consecutive ?? 0) + 1;
  const severity = consecutive >= CONSECUTIVE_FAILURE_ESCALATION ? "critical" : "warn";
  const detail = JSON.stringify({
    day,
    consecutive,
    last_error: err instanceof Error ? err.message : String(err),
  });
  // anomalies is a mutable ops table (no append-only guard); ON CONFLICT keeps exactly one row per
  // (tenant, day). Not INSERT OR REPLACE (that verb is lint-banned; ON CONFLICT DO UPDATE is not).
  //
  // `status = 'open'` is part of the UPDATE, not decoration: an anchor marker IS a watchtower alarm, and
  // the default ops lens is `GET /v1/watchtower?status=open`. Refreshing severity + detail while leaving a
  // resolved row resolved would give an operator who closed a marker a row that keeps re-failing while
  // reading `resolved` — an alarm hiding itself from the only lens anyone looks at. This is the same
  // re-open-on-re-raise that raiseAlarm in workers/agents does, which names this UPSERT as its model;
  // the two SQL fragments now actually agree. A kind that did NOT re-fail is untouched, so re-opening is
  // never a blanket un-resolve.
  await db
    .prepare(
      "INSERT INTO anomalies (id, rule, object_kind, object_id, severity, detail, status) VALUES (?,?,?,?,?,?,'open') ON CONFLICT(id) DO UPDATE SET severity = excluded.severity, detail = excluded.detail, status = 'open'",
    )
    .bind(id, kind.rule, "anchor", day, severity, detail)
    .run();
}

// The notice for a day the caller has already given up on: LOUD *and* durable, because the cause cannot
// reach `AnchorRunResult` (a list of days) and the scheduled caller — runAllTenants in workers/agents —
// discards the result entirely, so on the cron path nothing else survives the run. EVERY statement sits
// inside the guard: String(err) throws for a null-prototype thrown value, and the D1 write shares the
// fault class that broke the day. This function CANNOT re-raise — if it could, it would re-create the
// 500 that per-day containment exists to remove.
async function noteBuildFailure(deps: AnchorDeps, day: string, err: unknown): Promise<void> {
  try {
    const cause = err instanceof Error ? err.message : String(err);
    console.error(`[REQ-014] anchor day ${day} (tenant ${deps.tenant}) could not be built and stays unanchored: ${cause}`);
    await recordAnchorFailure(deps.db, BUILD_FAILED, deps.tenant, day, err);
  } catch {
    // Static message: nothing left that can itself throw.
    console.error(`[REQ-014] anchor day ${day}: the build failure could not be recorded`);
  }
}

// The day is anchored — every reason it previously could not be is resolved, so BOTH markers go. An
// anomaly nobody can close is ops debt.
async function clearAnchorFailures(db: D1Database, tenant: string, day: string): Promise<void> {
  await db
    .prepare(`DELETE FROM anomalies WHERE id IN (${ANCHOR_FAILURE_KINDS.map(() => "?").join(",")})`)
    .bind(...ANCHOR_FAILURE_KINDS.map((k) => failureId(k, tenant, day)))
    .run();
}

// Every anchor marker whose DAY already carries its `tsa_receipt` documents row — stale by definition,
// because a marker is only ever written for a day that could not be anchored. ONE statement for the whole
// run (never one per day: a two-year-old tenant would otherwise pay hundreds of point deletes per run),
// and window-independent, so it also collects a day stranded beyond MAX_DAYS_PER_RUN. The id predicate is
// BUILT from the same idPrefix constants that write the marker and re-derives the whole id including the
// tenant, so this can only ever delete a row that failureId() itself would have produced for this tenant
// and that day — never another tenant's marker, and never a non-anchor anomaly. The EXISTS clause is the
// precision: without it the sweep would also delete the alarm of a day that is STILL failing, which is
// exactly the alarm that has to survive to escalate.
async function sweepAnchoredDayMarkers(db: D1Database, tenant: string): Promise<void> {
  const ids = ANCHOR_FAILURE_KINDS.map((k) => `'${k.idPrefix}:' || ? || ':' || object_id`).join(", ");
  await db
    .prepare(
      `DELETE FROM anomalies WHERE id IN (${ids}) ` +
        `AND EXISTS (SELECT 1 FROM documents WHERE documents.id = 'anchor:' || anomalies.object_id AND documents.kind = 'tsa_receipt')`,
    )
    .bind(...ANCHOR_FAILURE_KINDS.map(() => tenant))
    .run();
}
