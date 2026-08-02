import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";

// REQ-025 / REQ-189 (WP-09 Task 5) — the Portal and the public status page load from a SEPARATE browser
// ORIGIN than this API, so their cross-origin reads need CORS. This is a SCOPED allowlist, never `*`:
//
//  • SYNTHETIC placeholder hosts only (REQ-167 — a real tenant/customer domain must never appear in a repo
//    artifact). `portal.example` / `status.example` stand in for the deploy-time surfaces; extend this ONE
//    named list when a real deploy origin is provisioned (never inline a host at the mount site).
//  • The local Vite dev origins the Portal serves from during development.
//  • A request whose Origin is NOT in this list gets NO `Access-Control-Allow-Origin` header at all, so the
//    browser blocks the cross-origin read. There is no wildcard fallback.
//
// The list is exported so the isolation/CORS suites can assert against the SAME source the worker mounts —
// a future edit that drops an origin (or slips in `*`) fails a test, not just a code review.
export const CORS_ALLOWED_ORIGINS: readonly string[] = [
  // ── The real deploy origins (added 2026-07-30 when the prod zone was routed). These are the three
  //    browser surfaces; `shuddl.tech` is an active zone in the same Cloudflare account as the workers,
  //    so each resolves to a real deployment rather than a stand-in. They are NOT tenant/customer names
  //    (REQ-167) — they are the product's own hostnames, which is what this allowlist is for.
  "https://command.shuddl.tech", // Command — the dispatcher board
  "https://portal.shuddl.tech", // the authed Client Portal
  "https://driver.shuddl.tech", // the Driver PWA
  "https://track.shuddl.tech", // the PUBLIC status page that consumes /pub/status/:cap (no session)
  // ── The synthetic placeholders the surfaces used before a real origin existed. Kept because the
  //    design/screenshot harness and the contract tests still assert against them; deleting them would
  //    fail those, not free anything. They can never resolve (`.example` is RFC 2606 reserved).
  "https://portal.example",
  "https://status.example",
  // ── Local development.
  "http://localhost:5173", // Portal Vite dev server (apps/portal — Vite's default dev port)
  "http://localhost:4322", // design / screenshot harness dev origin
];

// 2026-08-01 audit (config-deploy) — the served list is ENV-AWARE, and unknown fails CLOSED. The full list
// above compiled into every deploy, so prod served the two localhost dev origins and the two `.example`
// fixtures. The development list is now served ONLY for an explicitly recognized non-prod environment;
// everything else — "prod", an UNSET var, a typo, a scope that lost its [vars] — gets exactly the real
// deploy origins (the first cut restricted only the literal "prod", which the review caught failing OPEN
// on a missing var — the direction the fail-closed law forbids). The `.example` fixtures stay on the dev
// list because the screenshot/contract harnesses assert against them. Exported pure; its consumers are
// the cors.test.ts pins and the deploy preflight's served-vs-state reconciliation.
const PROD_ORIGIN = (o: string): boolean => o.startsWith("https://") && o.endsWith(".shuddl.tech");
const DEV_ENVIRONMENTS = new Set(["dev", "staging"]);
export function effectiveOrigins(environment: string): readonly string[] {
  return DEV_ENVIRONMENTS.has(environment) ? CORS_ALLOWED_ORIGINS : CORS_ALLOWED_ORIGINS.filter(PROD_ORIGIN);
}

// Built on hono's own `cors` middleware (the idiomatic choice in the pinned hono@4.12 — it handles the
// OPTIONS preflight + `Vary: Origin` for us). The `origin` callback ECHOES the matched origin back as
// `Access-Control-Allow-Origin` (never `*`) or returns null (=> no ACAO header, denied). Methods + headers
// are the exact set the two surfaces use: GET/POST for reads + guest quote + status-link mint, plus the
// Authorization / idempotency request headers the authed /v1 calls carry.
//
// `credentials` is intentionally NOT set: the Portal authorizes with a Bearer `Authorization` header, not
// cookies — so cross-origin credentialed mode is unnecessary AND the `*`-with-credentials footgun the CORS
// spec forbids is structurally impossible here (we echo a specific origin and send no credentials flag).
export function corsMiddleware(): MiddlewareHandler {
  return cors({
    origin: (origin, c) => (effectiveOrigins((c.env as { ENVIRONMENT?: string }).ENVIRONMENT ?? "").includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
    maxAge: 86_400, // 24h — cache the preflight so the browser stops re-asking on every call
  });
}
