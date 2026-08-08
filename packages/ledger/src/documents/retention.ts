// WP-11 Task 12 (REQ-116) — R2 LIFECYCLE PER DOCUMENT KIND: a 7-year POD, shorter everything else, a
// per-tenant retention SWEEP that DELETES expired non-POD bytes, and a storage-cost metric. The symmetric
// sibling of anchor.ts (WebCrypto-free, LLM-free — REQ-024; injected D1/R2 only). NO new table, NO new event
// kind: retention rides two forward-only `documents` columns (0007) and the metric rides the R2 object list.
//
// THE INVARIANT (evidence.ts:182-202 / packages/ledger/src/anchor.ts:213@documents ): a documents row exists IFF its R2 bytes exist. The
// sweep preserves it by TOMBSTONING, never orphaning: it DELETEs the bytes and marks the row
// `retention_status='expired'` (an AUDIT record that the doc existed and was retention-deleted). An 'active'
// row still means "bytes present"; an 'expired' row means "bytes intentionally retention-deleted" — the row is
// never orphaned (it never claims active bytes that are gone) and the bytes are never orphaned (deleted WITH a
// row record). See sweepTenantExpiredDocuments for the crash-safe delete-then-tombstone ordering.
//
// TENANT ISOLATION (REQ-025): the caller binds `db` to ONE tenant's D1; the sweep + the storage metric key ONLY
// off `evidence/<tenant>/` (evidenceTenantPrefix) — a defense-in-depth guard refuses to delete any key outside
// this tenant's namespace, so a tenant-a sweep can never touch a tenant-b object. PURITY OF INPUTS: `now` is the
// caller's injected clock; the pure retention decision (retentionMsFor) never reads a clock.

// ── the kind → retention-class map (the durations, documented) ────────────────────────────────────────────
const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;

/** POD (and its tsa_receipt witness) — a 7-year COMPLIANCE hold; effectively never expires in any test window. */
export const RETENTION_CLASS_POD_7YR = "pod-7yr";
/** Everything else — photos, ratecon, COI, W9, BOL, invoice PDF, claim, WI_cert — a shorter default hold. */
export const RETENTION_CLASS_DEFAULT = "default";

export type RetentionClass = typeof RETENTION_CLASS_POD_7YR | typeof RETENTION_CLASS_DEFAULT;

/** The retention DURATION per class (ms). The ONE source of truth for how long a class's bytes are kept.
 *  - pod-7yr: 7 years — a signed POD is a compliance record; the tsa_receipt that witnesses it rides the same
 *    bucket (its proof is only as useful as the POD it attests).
 *  - default: 1 year — a reasonable operational-evidence hold for the shorter kinds (photos/ratecon/COI/…).
 *  The concrete legal schedule (what is kept, how long, the consignee notice) is a counsel / CONFIRM-2
 *  deliverable (REQ-140, genesis/08 GA-11); these are the ENFORCEMENT durations, tunable when that text lands. */
export const RETENTION_MS: Record<RetentionClass, number> = {
  [RETENTION_CLASS_POD_7YR]: 7 * YEAR_MS,
  [RETENTION_CLASS_DEFAULT]: 1 * YEAR_MS,
};

/** The doc KINDS whose bytes are compliance-retained (7yr) and MUST never be swept — POD and its tsa_receipt
 *  witness. Kept as a SQL filter in the sweep (belt) AND honored by retentionMsFor's fail-safe (suspenders). */
export const POD_RETAINED_KINDS: readonly string[] = ["POD", "tsa_receipt"];

/** The retention CLASS to STAMP on a documents row at write, DERIVED from its kind (the evidence/anchor insert
 *  sites call this instead of hardcoding 'default'), so a doc's retention is recorded at creation (REQ-116). */
export function retentionClassFor(kind: string): RetentionClass {
  return POD_RETAINED_KINDS.includes(kind) ? RETENTION_CLASS_POD_7YR : RETENTION_CLASS_DEFAULT;
}

/** The retention DURATION (ms) for a stored `lifecycle_class`. FAIL-SAFE: only the exact 'default' class gets
 *  the short hold; EVERY other value — 'pod-7yr', an unknown/legacy class — resolves to the LONGEST (7yr) hold,
 *  because for a DELETE operation the safe miss is "keep longer", never "delete sooner". */
export function retentionMsFor(lifecycleClass: string): number {
  return lifecycleClass === RETENTION_CLASS_DEFAULT ? RETENTION_MS[RETENTION_CLASS_DEFAULT] : RETENTION_MS[RETENTION_CLASS_POD_7YR];
}

// ── tenant-scoped R2 key discipline (REQ-025) ─────────────────────────────────────────────────────────────
/** The R2 prefix that holds ONE tenant's evidence bytes — the SAME layout evidence.ts writes
 *  (`evidence/<tenant>/<shipment>/<hash>`). The sweep's delete-guard AND the storage-cost list both key off
 *  THIS one builder (share-lint: a single prefix, never two drifting string literals). */
export function evidenceTenantPrefix(tenant: string): string {
  return `evidence/${tenant}/`;
}

/** Whether an R2 key lives inside THIS tenant's evidence namespace — the defense-in-depth guard that makes a
 *  delete tenant-safe even if a row somehow carried a foreign/corrupted key (fail-closed: not ours ⇒ skip). */
export function isTenantEvidenceKey(r2Key: string, tenant: string): boolean {
  return r2Key.startsWith(evidenceTenantPrefix(tenant));
}

// ── the retention sweep ───────────────────────────────────────────────────────────────────────────────────
export interface RetentionSweepResult {
  /** Active non-POD candidate rows examined this pass. */
  scanned: number;
  /** Docs whose R2 bytes were deleted + row tombstoned this pass (the genuinely-newly-expired). */
  deleted: number;
  /** Candidates not yet expired (kept — bytes + row untouched). */
  retained: number;
  /** Candidates SKIPPED because their r2_key is not under this tenant's evidence prefix (defense-in-depth). */
  skipped_foreign_key: number;
}

interface CandidateRow {
  id: string;
  kind: string;
  r2_key: string;
  lifecycle_class: string;
  created_ts: number;
}

// ACTIVE (not already tombstoned) + NON-POD in SQL — POD/tsa_receipt are the 7yr compliance kinds and are
// EXCLUDED here (belt) so the sweep can never even consider them, independent of retentionMsFor (suspenders).
const CANDIDATES_SQL =
  "SELECT id, kind, r2_key, lifecycle_class, created_ts FROM documents " +
  "WHERE retention_status = 'active' AND kind NOT IN ('POD','tsa_receipt')";

// The TOMBSTONE — a plain UPDATE (documents is a mutable projection table, no append-only guard). Guarded by
// `retention_status='active'` so it is a strict active→expired transition (idempotent: an already-expired row
// updates 0 rows). NOT a REPLACE/upsert (those are lint-banned on guarded tables; a plain UPDATE here is legal).
const TOMBSTONE_SQL = "UPDATE documents SET retention_status = 'expired' WHERE id = ? AND retention_status = 'active'";

/**
 * Sweep ONE tenant's `documents` for EXPIRED non-POD bytes and retention-delete them, preserving row-iff-bytes.
 * The caller binds `db`/`r2`/`tenant` to that one tenant (REQ-025). `now` is the injected sweep clock.
 *
 * Per expired candidate: DELETE the R2 bytes FIRST (idempotent — a missing key is a no-op), THEN tombstone the
 * row. Ordering is crash-safe + SELF-HEALING: a crash after the delete leaves the row 'active', so the NEXT
 * tick re-selects it, re-deletes (no-op), and completes the tombstone — the only transient torn state is
 * "active row, bytes already gone", exactly the graceful miss the /pub bytes proxy already 404s on
 * (routes/documents.ts). An already-tombstoned doc is excluded by the query ⇒ a re-sweep is a total no-op
 * (idempotent). POD/tsa_receipt are never candidates (7yr). TENANT-SAFE: a key outside this tenant's evidence
 * prefix is SKIPPED, never deleted.
 */
export async function sweepTenantExpiredDocuments(
  db: D1Database,
  r2: R2Bucket,
  tenant: string,
  now: number,
): Promise<RetentionSweepResult> {
  const rows = (await db.prepare(CANDIDATES_SQL).all<CandidateRow>()).results;
  let deleted = 0;
  let retained = 0;
  let skippedForeignKey = 0;

  for (const row of rows) {
    const expiresAt = row.created_ts + retentionMsFor(row.lifecycle_class);
    if (expiresAt >= now) {
      retained += 1; // not yet expired — bytes + row untouched
      continue;
    }
    // TENANT SAFETY (REQ-025): only ever delete a key inside THIS tenant's evidence namespace. A row carrying a
    // foreign/corrupted key is left intact (fail-closed) rather than risk deleting another tenant's object.
    if (!isTenantEvidenceKey(row.r2_key, tenant)) {
      skippedForeignKey += 1;
      continue;
    }
    // DELETE bytes FIRST (idempotent), THEN tombstone — the crash-safe, self-healing ordering (see the doc above).
    await r2.delete(row.r2_key);
    await db.prepare(TOMBSTONE_SQL).bind(row.id).run();
    deleted += 1;
  }

  return { scanned: rows.length, deleted, retained, skipped_foreign_key: skippedForeignKey };
}

// ── the storage-cost metric (a METRIC, not a money_line) ──────────────────────────────────────────────────
// Storage cost is a Watchtower READING — an estimate of how much R2 the tenant uses — NOT a billable event: it
// is never a money_line and never an event kind (a metric the operator watches, not money the ledger owes).
// The estimate rate; R2 storage bills ~$0.015 / GB-month. Integer-cents figures round from this rate, so a few
// KB of evidence honestly reads as ~0¢ — the raw byte count is reported alongside so the number is meaningful.
const BYTES_PER_GB = 1_000_000_000; // decimal GB, R2's billing unit
export const STORAGE_COST_CENTS_PER_GB_MONTH = 1.5; // ~$0.015 / GB-month, the documented estimate rate

/** The integer-cents storage-cost estimate for `bytes` of R2 at the documented rate (rounded; never negative). */
export function estimateStorageCostCents(bytes: number): number {
  return Math.max(0, Math.round((bytes / BYTES_PER_GB) * STORAGE_COST_CENTS_PER_GB_MONTH));
}

/** Sum the bytes of ALL R2 objects under this tenant's `evidence/<tenant>/` prefix (REQ-025 — never another
 *  tenant's namespace). Paginated: R2 list returns ≤1000 objects per page, so follow the cursor to completion.
 *  This is the "how much storage does the tenant use" figure — no `documents.size` column exists, so the object
 *  list IS the authority (each R2Object carries its `.size`). */
export async function computeTenantStorageBytes(r2: R2Bucket, tenant: string): Promise<number> {
  const prefix = evidenceTenantPrefix(tenant);
  let total = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await r2.list(cursor !== undefined ? { prefix, cursor } : { prefix });
    for (const obj of page.objects) total += obj.size;
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return total;
}

export interface StorageReading {
  /** Total R2 bytes under this tenant's evidence prefix (the raw, honest number). */
  bytes: number;
  /** The integer-cents storage-cost estimate for those bytes (a metric, never a money_line). */
  cost_cents: number;
}

/** The tenant's storage READING — raw bytes + the integer-cents cost estimate — for the Watchtower snapshot. */
export async function tenantStorageReading(r2: R2Bucket, tenant: string): Promise<StorageReading> {
  const bytes = await computeTenantStorageBytes(r2, tenant);
  return { bytes, cost_cents: estimateStorageCostCents(bytes) };
}
