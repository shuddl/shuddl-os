// WP-10 Task 12 (REQ-083/084) — the canonical command VIEW registry + the KPI presentation law.
//
// THE 12-VIEW BUDGET (REQ-084 / genesis/10 §views). These are the ONLY command views. The map board's furniture
// (the KPI strip + the three queues) ARE views here; the ⌘K copilot is the "+copilot" surface (a command, not a
// view — genesis/10) and is deliberately NOT counted. 11 named, 1 headroom — NEVER a 13th (no report builder,
// REQ-084). `assertViewBudget()` proves ≤12 at import so a future add is caught by the unit suite, not a reviewer.
//
// WP-15 (REQ-152/153): `v_parity` is the overlay's shadow-parity dashboard (native-vs-legacy per module). The
// OR (operating-ratio / cost-rev) drill that historically borrowed the `v_parity` slug was RENAMED to
// `v_operating_ratio` to return the genesis/10-reserved `v_parity` name to the overlay dashboard — a pure slug
// rename (the OR drill's behavior is unchanged), NOT a 13th view: this spends ONE of the 2 headroom slots.
import type { EventKind } from "@shuddl/contracts";
import { formatCents } from "../intake/intake.js";

export const CANONICAL_VIEWS = [
  "v_board", // the map home (REQ-073/080) — v_board + the live KPI strip
  "v_queue_approvals", // ApprovalsQueue
  "v_queue_exceptions", // ExceptionsQueue
  "v_queue_money", // MoneyQueue
  "v_kpi_strip", // KpiStrip
  "v_lane_pnl", // KpiDrill(lane_pnl)
  "v_aging", // KpiDrill(dso) — the open-AR aging drill
  "v_scoreboards", // KpiDrill(otd|dwell) — operational scoreboards
  "v_unbilled", // KpiDrill(unbilled)
  "v_operating_ratio", // KpiDrill(or) — the cost/rev (operating-ratio) drill (renamed from v_parity; WP-15)
  "v_parity", // WP-15 overlay shadow-parity dashboard — native-vs-legacy per module (REQ-152/153)
] as const;
export type CanonicalView = (typeof CANONICAL_VIEWS)[number];

/** The hard ceiling (genesis/10 hard budget: ≤12 canonical views). */
export const MAX_CANONICAL_VIEWS = 12;

/** Throws if the registry ever exceeds the budget — a build-time tripwire against a 13th view (REQ-084). */
export function assertViewBudget(): void {
  if (CANONICAL_VIEWS.length > MAX_CANONICAL_VIEWS) {
    throw new Error(`REQ-084: ${CANONICAL_VIEWS.length} canonical views exceeds the ${MAX_CANONICAL_VIEWS}-view budget`);
  }
}
assertViewBudget();

// ── The KPI strip's 6 tiles (GET /v1/kpis) ──────────────────────────────────────────────────────────────────
// value is a REAL number OR the literal "UNKNOWN" — the honesty law (never a fabricated 0/100%). backing.kinds is
// the ledger source of the number, deep-linked verbatim via GET /v1/events?kind=<kinds> so every KPI clicks
// through to the exact events that back it (the DoD).
export type KpiValue = number | "UNKNOWN";
export type KpiUnit = "count" | "bps" | "min" | "cents" | "days";
export interface KpiTile {
  key: string;
  label: string;
  value: KpiValue;
  unit: KpiUnit;
  backing: { kinds: EventKind[] };
  lanes?: unknown;
}

/** Each KPI metric drills to exactly ONE canonical detail view — the tile click lands here (no new view invented). */
export const KPI_DRILL_VIEW: Record<string, CanonicalView> = {
  unbilled: "v_unbilled",
  dso: "v_aging",
  lane_pnl: "v_lane_pnl",
  or: "v_operating_ratio", // the OR (cost/rev, "operating ratio") drill — renamed from v_parity (WP-15 reclaimed the slug)
  otd: "v_scoreboards",
  dwell: "v_scoreboards",
};

// The count-up TARGET for a numeric tile. Money stays integer cents; a percentage in BASIS POINTS is scaled to a
// whole percent so the count-up lands on a clean integer (9800 bps → 98). Every other unit counts up as-is.
export function kpiScale(unit: KpiUnit, value: number): number {
  return unit === "bps" ? Math.round(value / 100) : value;
}

/** The display formatter for a numeric tile's (already-scaled) count-up value. Integer-only money via formatCents. */
export function kpiFormat(unit: KpiUnit): (n: number) => string {
  switch (unit) {
    case "count":
      return (n) => String(n);
    case "bps":
      return (n) => `${n}%`;
    case "min":
      return (n) => `${n}M`;
    case "cents":
      return (n) => formatCents(n);
    case "days":
      return (n) => `${n}D`;
  }
}
