// WP-11 Task 10 (REQ-160) — the WEEKLY Watchtower snapshot CRON WRAPPER (the tenant fan-out). The pure metric
// compute + the R2 manifest persist + the ISO-week key + the day-of-week gate all live in
// @shuddl/ledger/watchtower-snapshot (the anchor.ts / runAllTenants split — pure compute + R2 in the ledger,
// tenant fan-out in the worker). This module only iterates the tenant allowlist under the WEEKLY gate.
//
// PUBLISHING (external) is CONFIRM-gated (Doc 12 §06) — NOT built here: the R2 manifest IS the telemetry.

import { persistWatchtowerSnapshot, isSnapshotDay } from "@shuddl/ledger/watchtower-snapshot";
import { allTenantSlugs, resolveTenantDb, type AgentsEnv } from "./tenants.js";

// Re-export the pure surface so the agents cron test (and any agents-side caller) has ONE import site; the
// ledger module is the single source of truth for the compute/key/gate logic.
export {
  computeWatchtowerSnapshot,
  persistWatchtowerSnapshot,
  isoWeek,
  snapshotKey,
  isSnapshotDay,
  SNAPSHOT_DOW,
  WATCHTOWER_SNAPSHOT_VERSION,
  WATCHTOWER_SNAPSHOT_WINDOW_MS,
  type WatchtowerSnapshot,
  type WatchtowerSnapshotMetrics,
  type SnapshotOpts,
  type PersistResult,
} from "@shuddl/ledger/watchtower-snapshot";

/** REQ-160 — the WEEKLY snapshot sweep across every allowlisted tenant, ridden on the DAILY agents cron. The
 *  day-of-week GATE (isSnapshotDay) makes it weekly: on any non-SNAPSHOT_DOW tick this is a total no-op. On the
 *  gate day it persists each tenant's snapshot (write-once per ISO week; a retry that day skips — idempotent).
 *  REQ-025 isolation: one tenant's D1 + a `${tenant}`-scoped R2 key per iteration; a per-tenant fault is
 *  contained + logged so one tenant never stalls the rest. The cron reads wall-clock for `now` (deterministic in
 *  tests). NO external publish (CONFIRM-gated) — the R2 manifest IS the telemetry. */
export async function runWatchtowerSnapshots(env: AgentsEnv, now: () => number = () => Date.now()): Promise<void> {
  const at = now();
  if (!isSnapshotDay(at)) return; // WEEKLY gate — only fires the snapshot on SNAPSHOT_DOW
  // Claimed-aware (2026-08-01 review of audit C3): this was the NINTH fan-out — the one that lived
  // outside index.ts and escaped both the conversion and the source pin, which now scans this file too.
  for (const slug of await allTenantSlugs(env)) {
    try {
      const result = await persistWatchtowerSnapshot(env.EVIDENCE, await resolveTenantDb(env, slug), slug, { now: at });
      console.log(`watchtower-snapshot: tenant ${slug} → ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`watchtower-snapshot: tenant ${slug} failed (re-run next tick — the snapshot is idempotent):`, err);
    }
  }
}
