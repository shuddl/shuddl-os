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
  "https://portal.example", // the authed Portal surface (synthetic placeholder host — REQ-167)
  "https://status.example", // the public status page that consumes /pub/status/:cap
  "http://localhost:5173", // Portal Vite dev server (apps/portal — Vite's default dev port)
  "http://localhost:4322", // design / screenshot harness dev origin
];

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
    origin: (origin) => (CORS_ALLOWED_ORIGINS.includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
    maxAge: 86_400, // 24h — cache the preflight so the browser stops re-asking on every call
  });
}
