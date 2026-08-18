// WP-11 Task 12 (REQ-116) — R2 LIFECYCLE PER DOCUMENT KIND: a 7-year POD, shorter everything else, a
// per-tenant retention SWEEP that DELETES expired non-POD bytes, and a storage-cost metric. The symmetric
// sibling of anchor.ts (WebCrypto-free, LLM-free — REQ-024; injected D1/R2 only). NO new table, NO new event
// kind: retention rides two forward-only `documents` columns (0007) and the metric rides the R2 object list.
//
// THE INVARIANT (evidence.ts:182-202 / packages/ledger/src/anchor.ts:213@documents ): a documents row exists IFF its R2 bytes exist. The
// sweep preserves it by TOMBSTONING, never orphaning: it DELETEs the bytes and marks the row
// `retention_status='expired'` (an AUDIT record that the doc existed and was retention-deleted). An 'expired'
// row means "bytes intentionally retention-deleted"; the bytes are never orphaned (deleted WITH a row record).
//
// WHAT AN 'active' ROW DOES *NOT* PROVE (§1672, measured). The sentence here used to read "an 'active' row
// still means bytes present … the row never claims active bytes that are gone". That is FALSE for the length
// of this sweep's own delete→tombstone window: the delete lands first, so between the two awaits the row reads
// 'active' with its bytes already gone. Not a crash window — any request interleaving with an ORDINARY tick
// observes it, once per deleted document. A READER MAY NOT INFER BYTE PRESENCE FROM THE ROW; it must ask R2.
// The upload's duplicate path inferred exactly that and returned 200 + an r2_key for evidence it had not
// stored (fixed at routes/evidence.ts with a HEAD). The ordering itself stays — reversing it would orphan
// BYTES, and §54's rule is that a DELETE's safe miss is "keep longer", never "delete sooner".
//
// TENANT ISOLATION (REQ-025): the caller binds `db` to ONE tenant's D1; the sweep + the storage metric key ONLY
// off `evidence/<tenant>/` (evidenceTenantPrefix) — a defense-in-depth guard refuses to delete any key outside
// this tenant's namespace, so a tenant-a sweep can never touch a tenant-b object. PURITY OF INPUTS: `now` is the
// caller's injected clock; the pure retention decision (retentionMsFor) never reads a clock.

// ── the kind → retention-class map (the durations, documented) ────────────────────────────────────────────
import { mulDivHalfUp } from "../money/split.js";

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
 *  THIS one builder.
 *
 *  §1718 CORRECTION — that used to end "(share-lint: a single prefix, never two drifting string literals)",
 *  which was true INSIDE this file and false across the boundary that matters: `evidence.ts@evidenceKey`
 *  re-authors the layout, so there ARE two literals. Measured, neither side could see the other move —
 *  changing the writer left this package at 755/755, changing this left `workers/api` at 891/891. They are not
 *  merged (the writer lives in a worker, this in the package the worker imports), so what enforces the
 *  agreement is a PARITY test that reads one and computes the other:
 *  `workers/api/test/evidence-upload.test.ts` §1718.
 *
 *  THE TRAILING SLASH IS THE GUARD. `isTenantEvidenceKey` is a `startsWith`, so without it `tenant-a` matches
 *  `evidence/tenant-a-legacy/...` and this tenant's sweep DELETES a sibling's bytes. Removing it was silent
 *  across 755 tests until §1718 added the slug-EXTENDING sibling cases; do not remove it. */
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
  /** Candidates SKIPPED because their retention CLOCK is unknown (created_ts <= 0) — see the guard below. */
  skipped_unknown_clock: number;
}

interface CandidateRow {
  id: string;
  kind: string;
  r2_key: string;
  lifecycle_class: string;
  created_ts: number;
}

// ACTIVE (not already tombstoned) + the 7yr compliance kinds excluded, DERIVED from POD_RETAINED_KINDS rather
// than restated — the same list decides the stamped class (retentionClassFor) and the sweep's blind spot, so a
// kind added to one must reach the other. It read `NOT IN ('POD','tsa_receipt')` until 2026-08-15 (audit §1536):
// a hand-written second copy, drift-ready in the same file as its own constant. Bound, not interpolated.
//
// AND IT IS NOT A BELT. The struck comment here claimed this exclusion was redundant with retentionMsFor
// ("independent of ... (suspenders)"), which is TRUE for a POD the evidence route writes — real created_ts +
// the 7yr window — and FALSE for the row that actually needs it. `anchor.ts` inserts its daily tsa_receipt
// WITHOUT created_ts, taking the column DEFAULT of 0 (0007), and `0 + any finite window` is a date in the
// past: a created_ts of 0 defeats every duration-based guard there is. This list is the SOLE watcher for the
// merkle receipts that make the ledger verifiable — measured by deleting 'tsa_receipt' from it, which reds
// exactly one case and silently deleted the receipt bytes before that case existed.
const CANDIDATES_SQL =
  "SELECT id, kind, r2_key, lifecycle_class, created_ts FROM documents " +
  `WHERE retention_status = 'active' AND kind NOT IN (${POD_RETAINED_KINDS.map(() => "?").join(",")})`;

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
 * tick re-selects it, re-deletes (no-op), and completes the tombstone. The torn state is "active row, bytes
 * already gone", and §1672 corrected two things this doc used to claim about it. (1) It is not crash-only —
 * the two awaits give an ordinary tick the same window, once per deleted document. (2) The consumers are not
 * just the /pub bytes proxy (which 404s gracefully, routes/documents.ts): the EVIDENCE UPLOAD's duplicate
 * path reads the same 'active' predicate, and trusting it returned a 200 claiming stored evidence that was
 * gone. Enumerating one consumer and stopping is how the second one shipped.
 * An already-tombstoned doc is excluded by the query ⇒ a re-sweep is a total no-op
 * (idempotent). POD/tsa_receipt are never candidates (7yr). TENANT-SAFE: a key outside this tenant's evidence
 * prefix is SKIPPED, never deleted.
 */
export async function sweepTenantExpiredDocuments(
  db: D1Database,
  r2: R2Bucket,
  tenant: string,
  now: number,
): Promise<RetentionSweepResult> {
  const rows = (await db.prepare(CANDIDATES_SQL).bind(...POD_RETAINED_KINDS).all<CandidateRow>()).results;
  let deleted = 0;
  let retained = 0;
  let skippedForeignKey = 0;
  let skippedUnknownClock = 0;

  for (const row of rows) {
    // FAIL CLOSED ON AN UNKNOWN CLOCK (audit §1766). 0007 gives `created_ts` a `DEFAULT 0`, and for a DELETION
    // sweep that default is the maximally-expired value: `0 + any finite window` is a date in 1970, so a row
    // written WITHOUT a created_ts is deleted on the very next tick. The existing defence is the kind
    // exclusion, which covers the one known such writer (`anchor.ts`'s daily tsa_receipt, §1536) — but it
    // defends by KIND while the hazard is by MISSING COLUMN, so a third writer that omits created_ts under any
    // non-POD kind would have its bytes deleted irreversibly and tombstoned as retention-expired.
    //
    // Today this branch is unreachable: the only two writers are `anchor.ts` (kind-excluded before this point)
    // and the evidence route (which stamps a real created_ts). It is a NO-OP on current data and a floor on
    // future data — the cheap half of "fail-closed is about the fallback VALUE". An unknown clock is not
    // evidence of expiry; it is evidence of nothing, and a sweep that deletes on nothing is not a sweep.
    if (row.created_ts <= 0) {
      skippedUnknownClock += 1;
      continue;
    }
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

  return {
    scanned: rows.length,
    deleted,
    retained,
    skipped_foreign_key: skippedForeignKey,
    skipped_unknown_clock: skippedUnknownClock,
  };
}

// ── the storage-cost metric (a METRIC, not a money_line) ──────────────────────────────────────────────────
// Storage cost is a Watchtower READING — an estimate of how much R2 the tenant uses — NOT a billable event: it
// is never a money_line and never an event kind (a metric the operator watches, not money the ledger owes).
// The estimate rate; R2 storage bills ~$0.015 / GB-month. Integer-cents figures round from this rate, so a few
// KB of evidence honestly reads as ~0¢ — the raw byte count is reported alongside so the number is meaningful.
const BYTES_PER_GB = 1_000_000_000; // decimal GB, R2's billing unit

// The rate as an EXACT INTEGER RATIO rather than a fractional cent (audit §843). It read
// `STORAGE_COST_CENTS_PER_GB_MONTH = 1.5` — the repo's only `*CENTS*` identifier bound to a non-integer — and
// the estimate multiplied it into a float quotient. The rate is genuinely sub-cent ($0.015/GB), which is why
// it was a float; it is not why it had to be. 15 TENTHS of a cent per GB is the same rate, expressed so the
// shared half-up primitive can do the arithmetic exactly.
//
// This module argues, correctly, that the figure is "a METRIC, not a money_line" — the ledger owes nothing.
// But §817 converted the Watchtower's `avgCostCents`, the same kind of operator reading, on the grounds that
// it is DENOMINATED IN CENTS; leaving one Watchtower cents figure exact and the other floating is the
// inconsistency. The integer ratio needs no ruling on whether a metric is money.
//
// Measured over 200,011 inputs (the documented cases plus a dense sweep across rounding boundaries): ZERO
// differences from the float form. Nothing this reports has changed.
const STORAGE_COST_TENTHS_CENT_PER_GB = 15; // $0.015 / GB-month = 1.5¢ = 15 tenths of a cent
const TENTHS_PER_CENT = 10;

/** The integer-cents storage-cost estimate for `bytes` of R2 at the documented rate (rounded; never negative). */
export function estimateStorageCostCents(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return mulDivHalfUp(Math.floor(bytes), STORAGE_COST_TENTHS_CENT_PER_GB, BYTES_PER_GB * TENTHS_PER_CENT);
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
