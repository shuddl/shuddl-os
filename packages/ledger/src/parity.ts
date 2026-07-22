// WP-15 Task 6 (REQ-023 / REQ-152 / REQ-153) — the SHARED native-vs-legacy PARITY primitive: the SINGLE
// definition of "how closely does SHUDDL's own computation match the incumbent's legacy mirror, per module?"
// that THREE later consumers all import — the Gatekeeper flip guard (Task 3: "is a module's parity green enough
// to promote legacy→native?"), the Command v_parity dashboard (Task 7: render it), and the Watchtower drift
// sweep (Task 8: "has a promoted native module DRIFTED back out of parity?"). ONE definition means "what the
// gate checks / the dashboard shows / the watchtower alarms on" can NEVER drift apart — exactly the
// .claude/skills/share-lint-matchers-with-parity-tests principle (the same discipline that keeps the KPI
// number the command shows and the durable alarm the Watchtower raises impossible to diverge).
//
// WHY THIS LIVES IN @shuddl/ledger (like resolveAuthority in authority.ts): it is consulted from BOTH the api
// worker (the dashboard route + the flip guard) AND the agents worker (the Watchtower sweep), and those two
// workers have NO dependency edge. A shared READ over the append-only `events` ledger belongs in the ONE
// package both workers import — a single implementation, zero parity-drift risk.
//
// THE OVERLAY MODEL: SHUDDL runs ALONGSIDE the incumbent. The 171-col legacy export is mirrored into the ledger
// as `source:'legacy'` events (Task 4); SHUDDL computes natively (`source:'native'` events). PARITY compares the
// native output against the legacy mirror per module, split by `events.source`. Today (before the Task-4 mirror)
// NO legacy events exist, so EVERY module is honestly UNKNOWN — which is the correct, fail-closed answer.
//
// THE HONESTY LAW (the anti-false-green heart, mirroring tools/rater/parity.ts + the KPI compute's "a real
// number OR the literal UNKNOWN, never fabricated"): a MISSING side (no native events, OR no legacy events, for
// the module) resolves to status:'UNKNOWN' AND within_gate:false — you CANNOT prove parity with a side missing,
// and the flip gate MUST treat UNKNOWN as "not green". NEVER a fabricated 100% match from one side.
//
// REQ-024-clean: PURE of LLM / Date / fabrication — a durable D1 read + integer arithmetic, exactly like
// lens.ts / queries/metrics.ts. Tenant-scoped BY CONSTRUCTION: `db` is ALREADY the tenant's own D1 (resolved
// upstream from the JWT tenant claim, REQ-025) — this never takes a tenant from a header or a body.

import type { EventKind } from "@shuddl/contracts";
import type { AuthorityModule } from "./authority.js";

// Re-export the module type FROM the seam so every caller (api + agents) imports the ONE source (as authority.ts
// re-exports it from @shuddl/contracts). The primitive reuses the Task-2 AuthorityModule — the 5 overlay modules.
export type { AuthorityModule } from "./authority.js";

export type ParityStatus = "MATCH" | "DRIFT" | "UNKNOWN";
/** A metric value that is a REAL number OR the literal "UNKNOWN" (never a fabricated placeholder). */
export type ParityValue = number | "UNKNOWN";

export interface ModuleParity {
  module: AuthorityModule; // one of the 5 overlay modules (Task 2)
  native_value: ParityValue; // SHUDDL's own aggregate (source:'native'); UNKNOWN if the native side has no events
  legacy_value: ParityValue; // the incumbent mirror's aggregate (source:'legacy'); UNKNOWN if the legacy side is absent
  drift_bps: ParityValue; // |native − legacy| / legacy, in bps; UNKNOWN if EITHER side is UNKNOWN
  within_gate: boolean; // drift_bps <= tolerance(module); ALWAYS false when a side is UNKNOWN (fail-closed)
  status: ParityStatus; // UNKNOWN (a side missing) · MATCH (within gate) · DRIFT (beyond gate)
  backing_kinds: EventKind[]; // the ledger kinds behind the number — drill-through, exactly like a KPI tile's backing.kinds
}

// The per-module tolerances = the fixture REPLAY GATES (CLAUDE.md rule 6: legacy-export replay ±2% aggregate ·
// routes ±10% · QB export to the penny). Defined ONCE here and referenced from BOTH the primitive and its tests
// (the share-lint-matchers-with-parity-tests discipline): the number the flip gate enforces is the number the
// tests pin, so they can never drift. There is no pre-existing shared constant for these gates (they live as
// prose in CLAUDE.md / fixtures/README.md), so this map is their single typed source of truth.
//   · rating    ±10% (1000 bps) — the routes replay gate (a rated quote is the "routes" family).
//   · invoicing  ±2% (200 bps)  — the legacy-export aggregate replay gate; penny-exact where a cents total is
//                                 compared (integer-cents sums make an exact match a literal drift_bps of 0).
//   · settlement ±2% (200 bps)  — the money-settlement family, same aggregate gate as invoicing.
//   · dispatch   ±2% (200 bps)  — structural COUNT parity (see below); inherits the general aggregate gate.
//   · comms      ±2% (200 bps)  — structural COUNT parity; inherits the general aggregate gate.
export const PARITY_TOLERANCE_BPS: Record<AuthorityModule, number> = {
  rating: 1_000,
  invoicing: 200,
  settlement: 200,
  dispatch: 200,
  comms: 200,
};

/** The 5 overlay modules, in a fixed order (the dashboard + Task-3 consumption iterate this). */
export const PARITY_MODULES: readonly AuthorityModule[] = ["rating", "invoicing", "settlement", "dispatch", "comms"];

// ── the per-module metric ────────────────────────────────────────────────────────────────────────────────
// Each module picks the HONEST authoritative number computed from its backing events, split by source:
//   · rating     → quote.priced `sell` cents, summed over the LATEST quote per stream (a requote dedups to
//                  max-seq — exactly the OR-compute discipline in queries/metrics.ts, so a re-price is not
//                  double-counted). ±10%.
//   · invoicing  → invoice.issued `Σ lines[].amount_cents`, summed (aggregate). ±2% + penny-exact.
//   · settlement → the settled money: split.computed `total_cents` (the interline split gross) or
//                  settlement.executed `fee_cents`, summed. ±2%.
//   · dispatch   → a structural COUNT of dispatch.assigned + appointment.set events. There is no honest
//                  MONEY number for dispatch, so the metric is the count of authoritative dispatch/appointment
//                  facts each side produced for the same freight — a real, drill-through-able number (never a
//                  fabricated timing/quality score). It is a COARSE structural signal (matching counts does not
//                  prove matching content); value/timing parity is future work. Still fail-closes to UNKNOWN
//                  when a side is absent, so it can never green a flip on one side.
//   · comms      → a structural COUNT of message.sent + message.received events (same rationale as dispatch).
type PayloadExtract = (payload: Record<string, unknown>) => number | null;

type Metric =
  | { readonly kind: "sum_latest_per_stream"; readonly extract: PayloadExtract } // rating
  | { readonly kind: "sum"; readonly extract: PayloadExtract } // invoicing, settlement
  | { readonly kind: "count" }; // dispatch, comms

interface ModuleSpec {
  readonly backing_kinds: readonly EventKind[];
  readonly metric: Metric;
}

// quote.priced `sell` — a positive integer-cents charge. A non-integer / negative value is unusable → skipped.
const extractSell: PayloadExtract = (p) => {
  const s = p["sell"];
  return typeof s === "number" && Number.isInteger(s) && s >= 0 ? s : null;
};
// invoice.issued `Σ lines[].amount_cents`. An absent / malformed lines array is unusable → skipped (never 0).
const extractInvoiceTotal: PayloadExtract = (p) => {
  const lines = p["lines"];
  if (!Array.isArray(lines) || lines.length === 0) return null;
  let sum = 0;
  for (const line of lines) {
    const a = (line as { amount_cents?: unknown })["amount_cents"];
    if (typeof a !== "number" || !Number.isInteger(a)) return null;
    sum += a;
  }
  return sum;
};
// settlement money — split.computed `total_cents` (gross) or settlement.executed `fee_cents`, first present wins.
const extractSettlementAmount: PayloadExtract = (p) => {
  for (const key of ["total_cents", "fee_cents", "amount_cents"] as const) {
    const v = p[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  }
  return null;
};

const MODULE_SPEC: Record<AuthorityModule, ModuleSpec> = {
  rating: { backing_kinds: ["quote.priced"], metric: { kind: "sum_latest_per_stream", extract: extractSell } },
  invoicing: { backing_kinds: ["invoice.issued"], metric: { kind: "sum", extract: extractInvoiceTotal } },
  settlement: { backing_kinds: ["settlement.executed", "split.computed"], metric: { kind: "sum", extract: extractSettlementAmount } },
  dispatch: { backing_kinds: ["dispatch.assigned", "appointment.set"], metric: { kind: "count" } },
  comms: { backing_kinds: ["message.sent", "message.received"], metric: { kind: "count" } },
};

// ── the reducers (pure; no I/O) ──────────────────────────────────────────────────────────────────────────
// Only 'native' and 'legacy' rows participate: 'edi'/'email' events are inbound facts, neither SHUDDL's own
// computation nor the incumbent's mirror, so they are excluded from a native-vs-legacy comparison.
const TRACKED_SOURCES = ["native", "legacy"] as const;
type TrackedSource = (typeof TRACKED_SOURCES)[number];
function isTracked(s: string): s is TrackedSource {
  return (TRACKED_SOURCES as readonly string[]).includes(s);
}

interface Row {
  source: string;
  stream_id: string;
  seq: number;
  kind: string;
  payload: string;
}
/** Per-source accumulator: `n` = usable events counted for this side (0 ⇒ the side is absent ⇒ UNKNOWN);
 *  `value` = the metric (the summed cents, or the event count for a count-metric). */
interface SideStat {
  n: number;
  value: number;
}
type SideStats = Record<TrackedSource, SideStat>;
function emptyStats(): SideStats {
  return { native: { n: 0, value: 0 }, legacy: { n: 0, value: 0 } };
}

// Parse a stored payload safely; an unparseable / non-object payload yields null so the caller SKIPS it (never
// fabricates a 0). Mirrors the defensive JSON.parse in queries/metrics.ts computeCostRatioBps.
function parsePayload(payload: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

function countBySource(rows: readonly Row[]): SideStats {
  const stats = emptyStats();
  for (const r of rows) {
    if (!isTracked(r.source)) continue;
    stats[r.source].n += 1;
    stats[r.source].value += 1;
  }
  return stats;
}

function sumBySource(rows: readonly Row[], extract: PayloadExtract): SideStats {
  const stats = emptyStats();
  for (const r of rows) {
    if (!isTracked(r.source)) continue;
    const p = parsePayload(r.payload);
    if (p === null) continue;
    const v = extract(p);
    if (v === null) continue; // an event whose value can't be read is not counted — an honest omission, never a 0
    stats[r.source].n += 1;
    stats[r.source].value += v;
  }
  return stats;
}

// Latest-per-stream then sum, PER SOURCE (rating): within each source, keep the max-seq event per stream_id so a
// requote does not double-count. The dedup key folds in the source, so a native quote and a legacy mirror quote
// on the SAME stream are deduped independently.
function latestSumBySource(rows: readonly Row[], extract: PayloadExtract): SideStats {
  const latest = new Map<string, { source: TrackedSource; seq: number; payload: string }>();
  for (const r of rows) {
    if (!isTracked(r.source)) continue;
    const key = `${r.source}|${r.stream_id}`;
    const prev = latest.get(key);
    if (prev === undefined || r.seq > prev.seq) latest.set(key, { source: r.source, seq: r.seq, payload: r.payload });
  }
  const stats = emptyStats();
  for (const { source, payload } of latest.values()) {
    const p = parsePayload(payload);
    if (p === null) continue;
    const v = extract(p);
    if (v === null) continue;
    stats[source].n += 1;
    stats[source].value += v;
  }
  return stats;
}

function reduce(rows: readonly Row[], metric: Metric): SideStats {
  switch (metric.kind) {
    case "count":
      return countBySource(rows);
    case "sum":
      return sumBySource(rows, metric.extract);
    case "sum_latest_per_stream":
      return latestSumBySource(rows, metric.extract);
  }
}

// |native − legacy| / legacy in bps (integer, mirroring computeCostRatioBps's `Math.round(x * 10000 / y)`).
// legacy === 0 is the divide-by-zero edge: 0 vs 0 is EXACT parity (drift 0); a nonzero native against a 0 legacy
// is UNBOUNDED relative drift — represented as MAX_SAFE_INTEGER so `within_gate` (drift <= tolerance) is false.
// This keeps the both-sides-present branch honestly MATCH-or-DRIFT (never a fabricated 0/0 match).
function driftBps(native: number, legacy: number): number {
  if (legacy === 0) return native === 0 ? 0 : Number.MAX_SAFE_INTEGER;
  return Math.round((Math.abs(native - legacy) * 10_000) / legacy);
}

function toValue(side: SideStat): ParityValue {
  return side.n === 0 ? "UNKNOWN" : side.value;
}

/**
 * computeModuleParity — a DURABLE READ over `events` split by `source`, for ONE overlay module. Fail-closed:
 * a missing side ⇒ status:'UNKNOWN', within_gate:false, drift_bps:'UNKNOWN'. Both present ⇒ MATCH/DRIFT off the
 * module's tolerance. PURE (no LLM/Date/fabrication); tenant-scoped by construction (`db` is the tenant's D1).
 */
export async function computeModuleParity(db: D1Database, module: AuthorityModule): Promise<ModuleParity> {
  const spec = MODULE_SPEC[module];
  const backing_kinds = [...spec.backing_kinds];
  const placeholders = spec.backing_kinds.map(() => "?").join(",");
  const res = await db
    .prepare(
      `SELECT source, stream_id, seq, kind, payload FROM events WHERE kind IN (${placeholders}) AND source IN ('native','legacy')`,
    )
    .bind(...spec.backing_kinds)
    .all<Row>();

  const stats = reduce(res.results, spec.metric);
  const native_value = toValue(stats.native);
  const legacy_value = toValue(stats.legacy);

  // THE HONESTY LAW: either side missing ⇒ UNKNOWN and NOT within gate. Parity is unprovable with a side absent
  // — the flip gate treats this as "not green". NEVER fabricate a match (or a 0 drift) from one side.
  if (native_value === "UNKNOWN" || legacy_value === "UNKNOWN") {
    return { module, native_value, legacy_value, drift_bps: "UNKNOWN", within_gate: false, status: "UNKNOWN", backing_kinds };
  }

  const drift_bps = driftBps(native_value, legacy_value);
  const within_gate = drift_bps <= PARITY_TOLERANCE_BPS[module];
  return { module, native_value, legacy_value, drift_bps, within_gate, status: within_gate ? "MATCH" : "DRIFT", backing_kinds };
}

/** computeAllParity — the 5 modules, for the Command v_parity dashboard (Task 7) + the flip-guard/watchtower
 *  consumers (Tasks 3/8). Each is a real number or an honest UNKNOWN; the array order is PARITY_MODULES. */
export async function computeAllParity(db: D1Database): Promise<ModuleParity[]> {
  return Promise.all(PARITY_MODULES.map((module) => computeModuleParity(db, module)));
}
