import type { Context, Next } from "hono";
import { ApiError } from "./error.js";
import type { Env, Vars } from "../index.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// The KV idempotency key is a SHA-256 of the scope tuple, so its length is fixed (a client-controlled
// path segment or Idempotency-Key header can be arbitrarily long — a ~10KB :id used to overflow KV's
// 512-byte key limit and 500 with error.unhandled before any validation ran). Hashing bounds the key
// AND still isolates tenants (REQ-025): the tenant is folded into the digest, and a NUL field separator
// keeps the tuple unambiguous so a value containing a delimiter char cannot forge a different scope.
//
// §1613 — THE PRINCIPAL IS IN THE TUPLE TOO, and it was not. Tenant scoping answers "can another TENANT
// replay this?"; it never answered "can another PRINCIPAL inside my tenant?". Two routes take both a party
// and an operator — `POST /v1/shipments/:id/accept-quote` and `.../claim`, both
// `requireRole("admin","ops","portal")` — so one Idempotency-Key value used by both collided on
// (tenant, method, pathname, key).
//
// The cost is not primarily a leak, it is a SWALLOWED WRITE: the second caller receives the first's cached
// response and their own mutation never runs, while the status says it succeeded. Exploiting it needs a
// victim's key, so it is narrow — but nothing legitimate depends on two principals SHARING an idempotency
// scope, since a retry always comes from the session that issued the original. Folding `sub` in only ever
// removes a false match.
async function idempotencyKey(tenant: string, sub: string, method: string, pathname: string, key: string): Promise<string> {
  const NUL = String.fromCharCode(0); // cannot appear in a URL path, method, tenant slug, or header value
  const raw = [tenant, sub, method, pathname, key].join(NUL);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `idem:${hex}`;
}

// REQ-156 (generalizing REQ-106 beyond MCP): Idempotency-Key required on all mutations;
// replays return the original result.
export async function idempotency(c: Context<{ Bindings: Env; Variables: Vars }>, next: Next): Promise<Response | void> {
  if (!MUTATING.has(c.req.method)) return next();
  const key = c.req.header("Idempotency-Key");
  if (!key) throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", 400, "IDEMPOTENCY-KEY HEADER REQUIRED ON ALL MUTATIONS");
  // Tenant- AND principal-scoped: neither another tenant nor another user inside this tenant can replay this
  // response, or swallow this caller's write by reusing their key (REQ-025, §1613).
  const session = c.get("session");
  const scope = await idempotencyKey(session.tenant, session.sub, c.req.method, new URL(c.req.url).pathname, key);
  const cached = await c.env.IDEMPOTENCY.get(scope);
  if (cached) {
    const { status, body } = JSON.parse(cached) as { status: number; body: string };
    return c.newResponse(body, status as 200, { "content-type": "application/json", "idempotency-replay": "true" });
  }
  await next();
  const res = c.res.clone();
  // REQ-206 (H-5): cache ONLY a 2xx success. Idempotency protects a *committed* mutation from being
  // double-applied; a 4xx precondition failure (422 VALIDATION_FAILED, 409 conflict) or a 5xx
  // committed nothing, so it must stay RETRYABLE — caching it would replay the stale failure on a
  // same-key retry and `next()` would never re-run, silently losing the write the corrected retry
  // intended (the Driver-PWA offline-replay evidence-loss path).
  if (res.status >= 200 && res.status < 300) {
    await c.env.IDEMPOTENCY.put(scope, JSON.stringify({ status: res.status, body: await res.text() }), { expirationTtl: 60 * 60 * 24 });
  }
}
