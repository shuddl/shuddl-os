// REQ-086/051 — the portal's tiny path/hash router. NO routing dependency: it maps window.location to one
// of the portal's screens. TWO of them are PUBLIC (no session): the shared status page (/status/:cap) and
// the guest quote (/quote). Everything else is the authed board. It also honors the legacy ?screen= switch
// (the visual harness — tests/visual/screens.spec.ts) and the #status "Track" link, so nothing that resolved
// in WP-03 regresses. The resolver is PURE (it takes only the location pieces), so the routing table is
// exhaustively unit-tested without a DOM.

/** A board TAB reachable by deep-link. Only STATEMENT (REQ-090) is wired today — a bill-to party can be
 * sent straight to its account view (`/statement` or `?screen=statement`). Absent ⇒ the board's default. */
export type BoardTab = "statement";

/** The resolved screen. `status.cap` is the (public, forwardable) status capability from the URL, or null.
 * `board.tab` (optional) opens the authed board directly on a deep-linkable tab. */
export type Route =
  | { name: "status"; cap: string | null }
  | { name: "quote" }
  | { name: "email" }
  | { name: "board"; tab?: BoardTab };

/** Resolve a Location-shaped value to a Route. Pure — no window access, so it is trivially testable. */
export function resolveRoute(loc: { pathname: string; search: string; hash: string }): Route {
  const path = loc.pathname.replace(/\/+$/, "") || "/";
  const params = new URLSearchParams(loc.search);

  // Path-based PUBLIC routes — the real, shareable URLs. A cap on the path is the primary form; a ?cap= query
  // is accepted as a fallback so a link builder may use either.
  const statusPath = path.match(/^\/status\/(.+)$/);
  if (statusPath) return { name: "status", cap: decodeURIComponent(statusPath[1] ?? "") };
  if (path === "/status") return { name: "status", cap: params.get("cap") };
  if (path === "/quote") return { name: "quote" };
  // The STATEMENT deep-link (REQ-090) — the authed board opened on the statement tab.
  if (path === "/statement") return { name: "board", tab: "statement" };

  // Legacy ?screen= switch (visual harness) + the #status "Track" link — kept resolving.
  const which = params.get("screen");
  if (which === "status" || loc.hash === "#status") return { name: "status", cap: params.get("cap") };
  if (which === "quote") return { name: "quote" };
  if (which === "email") return { name: "email" };
  if (which === "statement") return { name: "board", tab: "statement" };

  return { name: "board" };
}
