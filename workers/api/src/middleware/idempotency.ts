import type { Context, Next } from "hono";
import { ApiError } from "./error.js";
import type { Env, Vars } from "../index.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// The KV idempotency key is a SHA-256 of the scope tuple, so its length is fixed (a client-controlled
// path segment or Idempotency-Key header can be arbitrarily long — a ~10KB :id used to overflow KV's
// 512-byte key limit and 500 with error.unhandled before any validation ran). Hashing bounds the key
// AND still isolates tenants (REQ-025): the tenant is folded into the digest, and a NUL field separator
// keeps the tuple unambiguous so a value containing a delimiter char cannot forge a different scope.
async function idempotencyKey(tenant: string, method: string, pathname: string, key: string): Promise<string> {
  const NUL = String.fromCharCode(0); // cannot appear in a URL path, method, tenant slug, or header value
  const raw = [tenant, method, pathname, key].join(NUL);
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
  // Tenant-scoped: one tenant's key can never replay another's response (REQ-025).
  const scope = await idempotencyKey(c.get("session").tenant, c.req.method, new URL(c.req.url).pathname, key);
  const cached = await c.env.IDEMPOTENCY.get(scope);
  if (cached) {
    const { status, body } = JSON.parse(cached) as { status: number; body: string };
    return c.newResponse(body, status as 200, { "content-type": "application/json", "idempotency-replay": "true" });
  }
  await next();
  const res = c.res.clone();
  if (res.status < 500) {
    await c.env.IDEMPOTENCY.put(scope, JSON.stringify({ status: res.status, body: await res.text() }), { expirationTtl: 60 * 60 * 24 });
  }
}
