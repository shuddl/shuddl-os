import { Hono } from "hono";
import type { SessionClaims } from "@shuddl/contracts";
import { reqId, handleError, envelope } from "./middleware/error.js";
import { auth, requireRole } from "./middleware/auth.js";
import { tenantDb } from "./tenants.js";

export type Env = {
  TENANT_A_DB: D1Database;
  TENANT_B_DB: D1Database;
  IDEMPOTENCY: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
};
export type Vars = { req_id: string; session: SessionClaims };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.use("*", reqId);
app.onError(handleError);

// Public: health only. Everything else authenticates (REQ-133: every client is untrusted).
app.get("/v1/health", (c) => c.json({ ok: true, env: c.env.ENVIRONMENT })); // REQ-111/114 probe target

app.use("/v1/*", auth);

app.get("/v1/whoami", (c) => c.json(c.get("session")));

// REQ-025 probe: the isolation suite's read target. Reads ONLY the session tenant's D1.
app.get("/v1/_probe", requireRole("admin", "ops", "finance"), async (c) => {
  const db = tenantDb(c.env, c.get("session").tenant);
  const row = await db.prepare("SELECT tenant FROM probe LIMIT 1").first<{ tenant: string }>();
  return c.json({ tenant_marker: row?.tenant ?? null });
});

app.notFound((c) => envelope(c, "NOT_FOUND", 404, "NOT FOUND"));

export default app;
