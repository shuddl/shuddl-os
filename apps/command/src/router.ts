// REQ-081 — the command surface's tiny path/hash router. NO routing dependency: it maps window.location to
// one of the command screens. The map board is the DEFAULT (the map IS the home, REQ-073/080); the queues,
// the KPI drill-through, and the ⌘K copilot are stubs T9-T12 wire to real views. The resolver is PURE (it
// takes only the location pieces), so the routing table is exhaustively unit-tested without a DOM.
//
// This organizes EXISTING canonical views (genesis/10) — it does not invent a 13th. The `board` maps to
// v_board + v_kpi_strip; the three `queue` kinds map to v_queue_{approvals,exceptions,money}; the `kpi`
// drill lands on the detail views (v_lane_pnl / v_aging / v_scoreboards / v_unbilled / v_operating_ratio) a metric
// slug selects; `copilot` is the separate ⌘K command surface (the "+copilot", not one of the 12 views).

/** The three canonical command queues (v_queue_{approvals,exceptions,money}). */
export type QueueKind = "approvals" | "exceptions" | "money";
const QUEUE_KINDS: readonly QueueKind[] = ["approvals", "exceptions", "money"];

function toQueueKind(raw: string | null): QueueKind | null {
  return QUEUE_KINDS.includes(raw as QueueKind) ? (raw as QueueKind) : null;
}

/** The resolved command screen. `kpi.metric` is the drill-through slug from the URL, or null (the index). */
export type Route =
  | { name: "board" }
  | { name: "queue"; kind: QueueKind }
  | { name: "kpi"; metric: string | null }
  | { name: "parity" }
  | { name: "copilot" };

/** Resolve a Location-shaped value to a Route. Pure — no window access, so it is trivially testable. */
export function resolveRoute(loc: { pathname: string; search: string; hash: string }): Route {
  const path = loc.pathname.replace(/\/+$/, "") || "/";
  const params = new URLSearchParams(loc.search);

  // Queues: /queue/:kind is the primary form; ?kind= is accepted as a fallback so a link builder may use
  // either. An unknown/absent kind fails SAFE to the board — the router never conjures a non-canonical view.
  const queuePath = path.match(/^\/queue\/(.+)$/);
  if (queuePath) {
    const kind = toQueueKind(decodeURIComponent(queuePath[1] ?? ""));
    return kind ? { name: "queue", kind } : { name: "board" };
  }
  if (path === "/queue") {
    const kind = toQueueKind(params.get("kind"));
    return kind ? { name: "queue", kind } : { name: "board" };
  }

  // KPI drill-through: /kpi/:metric selects a detail view; bare /kpi is the drill index (metric null).
  const kpiPath = path.match(/^\/kpi\/(.+)$/);
  if (kpiPath) return { name: "kpi", metric: decodeURIComponent(kpiPath[1] ?? "") };
  if (path === "/kpi") return { name: "kpi", metric: null };

  // WP-15 (REQ-152/153) — the v_parity shadow-parity dashboard: SHUDDL's native compute vs the incumbent's legacy
  // mirror, per module. A canonical command VIEW (the reclaimed `v_parity` slug), organized here — never a 13th.
  if (path === "/parity") return { name: "parity" };

  // The ⌘K copilot surface.
  if (path === "/copilot") return { name: "copilot" };

  return { name: "board" };
}
