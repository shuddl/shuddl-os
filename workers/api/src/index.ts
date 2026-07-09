import { Hono } from "hono";
import type { SessionClaims } from "@shuddl/contracts";
import { errorEnvelope, envelope } from "./middleware/error.js";

export type Env = {
  TENANT_A_DB: D1Database;
  TENANT_B_DB: D1Database;
  IDEMPOTENCY: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
};
export type Vars = { req_id: string; session: SessionClaims };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.use("*", errorEnvelope);

// Public: health only. Everything else authenticates (REQ-133: every client is untrusted).
app.get("/v1/health", (c) => c.json({ ok: true, env: c.env.ENVIRONMENT })); // REQ-111/114 probe target

app.notFound((c) => envelope(c, "NOT_FOUND", 404, "NOT FOUND"));

export default app;
