import type { Context, Next } from "hono";
import { ApiError } from "./error.js";
import type { Env, Vars } from "../index.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// REQ-156 (generalizing REQ-106 beyond MCP): Idempotency-Key required on all mutations;
// replays return the original result.
export async function idempotency(c: Context<{ Bindings: Env; Variables: Vars }>, next: Next): Promise<Response | void> {
  if (!MUTATING.has(c.req.method)) return next();
  const key = c.req.header("Idempotency-Key");
  if (!key) throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", 400, "IDEMPOTENCY-KEY HEADER REQUIRED ON ALL MUTATIONS");
  // Tenant-scoped: one tenant's key can never replay another's response (REQ-025).
  const scope = `${c.get("session").tenant}:${c.req.method}:${new URL(c.req.url).pathname}:${key}`;
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
