// WP-11 Task 10 (REQ-160) — the WEEKLY Watchtower TELEMETRY SNAPSHOT (the pure compute + manifest + R2 persist).
// The tenant's 7 health metrics captured once per ISO week and persisted to R2 for the case-study series (Doc 12
// §06). NO new table, NO new event kind — a snapshot is an R2 JSON manifest, the SAME package's anchor-cron R2
// precedent (packages/ledger/src/anchor.ts), NOT a ledger row. The 7 metrics are the SHARED ./queries/metrics
// computes: three (unbilled/DSO/OR) are the WP-10 KPI computes MOVED to that module (the KPI route re-exports
// them, so it and this snapshot cannot drift — a parity test locks it); four (POD→invoice latency, rating
// latency, disputes, close duration) are net-new.
//
// HONESTY (WP-10/11): every metric is a REAL number from real ledger rows OR the literal "UNKNOWN" — never a
// fabricated value. The FLOW metrics (latency/duration) use a 7-day trailing window so a weekly snapshot reflects
// THAT week's operational flow; the STATE metrics (unbilled/DSO/disputes/OR) are as-of `now`.
//
// IDEMPOTENT per week: the R2 key is deterministic per (tenant, ISO week), and persist is WRITE-ONCE
// (skip-if-exists) — a retry (or a second tick that same day) never re-clobbers the week's snapshot. TENANT
// ISOLATION (REQ-025): the key is `${tenant}`-scoped; the caller binds `db` to ONE tenant's D1, so a snapshot can
// never read or write across tenants. The DAY-OF-WEEK gate helper (isSnapshotDay) makes a DAILY cron WEEKLY; the
// tenant-iterating cron WRAPPER that uses it lives in workers/agents/src/watchtower-snapshot.ts (the anchor.ts /
// runAllTenants split — pure compute + R2 here, tenant fan-out in the worker).
//
// PUBLISHING (external) is CONFIRM-gated (Doc 12 §06) and is NOT built here: the R2 manifest IS the telemetry —
// there is no external send, no email, no publish in this task. PURE of LLM (REQ-024); WebCrypto-free, injected
// D1/R2 only — mirroring anchor.ts.

import {
  computeUnbilled,
  computeDsoDays,
  computeCostRatioBps,
  computePodToInvoiceLatencyMs,
  computeRatingLatencyMs,
  computeDisputesOpen,
  computeCloseDurationMs,
  WEEK_MS,
  type MetricValue,
} from "./queries/metrics.js";

/** The manifest schema version — a snapshot for one (tenant, week) can never be mistaken for another format. */
export const WATCHTOWER_SNAPSHOT_VERSION = "shuddl-watchtower-snapshot-v1";
/** The trailing window (7d) the flow metrics use, matching the weekly cadence. */
export const WATCHTOWER_SNAPSHOT_WINDOW_MS = WEEK_MS;
/** The ONE day/week (UTC day-of-week; 1 = Monday) the weekly snapshot runs — the gate that makes the daily cron weekly. */
export const SNAPSHOT_DOW = 1;

export interface SnapshotOpts {
  /** The snapshot instant (injected clock). Its ISO week is the R2 key; the flow metrics window back from it. */
  now: number;
  /** Test-only id-prefix scope threaded to every metric (the shared-D1 hook). Undefined ⇒ whole-tenant (prod). */
  scope?: string;
  /** Flow-metric trailing window override (ms). Undefined ⇒ WATCHTOWER_SNAPSHOT_WINDOW_MS (7 days). */
  windowMs?: number;
}

/** The 7 REQ-160 health metrics. Each is a REAL number or the literal "UNKNOWN" (the honesty law). */
export interface WatchtowerSnapshotMetrics {
  /** Shipments with a committed pod.signed but NO invoice.issued (0 = healthy; always a number). */
  unbilled: number;
  /** Dollar-weighted average age of OPEN AR, days. UNKNOWN when there is no open AR. */
  dso_days: MetricValue;
  /** Mean invoice.issued.ts − pod.signed.ts over shipments with both, ms (7d window). UNKNOWN when none. */
  pod_to_invoice_latency_ms: MetricValue;
  /** Mean of the rater's reported agent.acted.latency_ms, ms (7d window). UNKNOWN when no rater run reported one. */
  rating_latency_ms: MetricValue;
  /** Count of distinct shipments carrying an OPEN exception (0 = healthy; always a number). */
  disputes_open: number;
  /** Mean booking.created → first terminal (delivered/settled), ms (7d window). UNKNOWN when none. */
  close_duration_ms: MetricValue;
  /** HONEST cost/revenue ratio from the rater's quoted cost basis, bps (NOT a true operating ratio). UNKNOWN when none. */
  or_bps: MetricValue;
}

export interface WatchtowerSnapshot {
  version: string;
  tenant: string;
  iso_week: string;
  generated_at: string; // ISO-8601 of `now`
  now_ms: number;
  window_ms: number;
  metrics: WatchtowerSnapshotMetrics;
}

/** The ISO-8601 week-of-year (YYYY-Www) of an epoch-ms instant, UTC. Week 1 is the week containing the year's
 *  first Thursday; the week-year comes from that Thursday (so early-Jan / late-Dec days land in the right year). */
export function isoWeek(nowMs: number): string {
  const d = new Date(nowMs);
  // A UTC date at midnight, then shift to the THURSDAY of this ISO week (Mon=0..Sun=6).
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const isoYear = date.getUTCFullYear();
  // The first Thursday of the ISO year (shift Jan-4, which is always in week 1, to its week's Thursday).
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / WEEK_MS);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** The TENANT-SCOPED R2 key for a (tenant, ISO week) snapshot (REQ-025 — never crosses tenants). */
export function snapshotKey(tenant: string, isoWeekStr: string): string {
  return `watchtower/${tenant}/${isoWeekStr}.json`;
}

/** Whether `nowMs`'s UTC day-of-week is the weekly snapshot day (the gate that makes the daily cron weekly). */
export function isSnapshotDay(nowMs: number, dow: number = SNAPSHOT_DOW): boolean {
  return new Date(nowMs).getUTCDay() === dow;
}

/** Compute the 7 REQ-160 health metrics for one tenant at `now` (all metrics honest — a real number or UNKNOWN).
 *  The caller binds `db` to ONE tenant's D1 (REQ-025). Flow metrics window back over `windowMs` (default 7d). */
export async function computeWatchtowerSnapshot(db: D1Database, tenant: string, opts: SnapshotOpts): Promise<WatchtowerSnapshot> {
  const { now } = opts;
  const windowMs = opts.windowMs ?? WATCHTOWER_SNAPSHOT_WINDOW_MS;
  // Spread the scope only when set (exactOptionalPropertyTypes forbids passing an explicit `undefined`).
  const scopeOpt = opts.scope !== undefined ? { scope: opts.scope } : {};
  const flow = { now, windowMs, ...scopeOpt };

  // Seven independent read paths. Each returns a REAL number or the literal "UNKNOWN" — never a fabricated value.
  const [unbilled, dso, podToInvoice, rating, disputes, close, or] = await Promise.all([
    computeUnbilled(db, scopeOpt),
    computeDsoDays(db, { now, ...scopeOpt }),
    computePodToInvoiceLatencyMs(db, flow),
    computeRatingLatencyMs(db, flow),
    computeDisputesOpen(db, scopeOpt),
    computeCloseDurationMs(db, flow),
    computeCostRatioBps(db, scopeOpt),
  ]);

  return {
    version: WATCHTOWER_SNAPSHOT_VERSION,
    tenant,
    iso_week: isoWeek(now),
    generated_at: new Date(now).toISOString(),
    now_ms: now,
    window_ms: windowMs,
    metrics: {
      unbilled,
      dso_days: dso,
      pod_to_invoice_latency_ms: podToInvoice,
      rating_latency_ms: rating,
      disputes_open: disputes,
      close_duration_ms: close,
      or_bps: or,
    },
  };
}

export interface PersistResult {
  key: string;
  iso_week: string;
  outcome: "written" | "skipped";
}

/** Persist a tenant's weekly snapshot to R2 — WRITE-ONCE per ISO week (skip-if-exists, the anchor idempotency
 *  pattern). Returns 'skipped' when the week's manifest already exists (a re-run/retry is a no-op that never
 *  re-clobbers the week's reading), else computes + writes it and returns 'written'. NO external publish. */
export async function persistWatchtowerSnapshot(r2: R2Bucket, db: D1Database, tenant: string, opts: SnapshotOpts): Promise<PersistResult> {
  const week = isoWeek(opts.now);
  const key = snapshotKey(tenant, week);
  // r2.head (metadata only) — NOT r2.get: the existence check must not open a body stream (an unconsumed R2
  // body breaks the test harness's isolated-storage teardown, and prod never needs the bytes here).
  const existing = await r2.head(key);
  if (existing !== null) return { key, iso_week: week, outcome: "skipped" };
  const snapshot = await computeWatchtowerSnapshot(db, tenant, opts);
  await r2.put(key, JSON.stringify(snapshot));
  return { key, iso_week: week, outcome: "written" };
}
