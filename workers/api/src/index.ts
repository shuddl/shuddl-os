import { Hono } from "hono";
import type { SessionClaims } from "@shuddl/contracts";
import { z } from "zod";
import { reqId, handleError, envelope, ApiError } from "./middleware/error.js";
import { auth, requireRole } from "./middleware/auth.js";
import { idempotency } from "./middleware/idempotency.js";
import { tenantDb } from "./tenants.js";
import { mountEventRoutes } from "./routes/events.js";
import { mountPositionRoutes } from "./routes/positions.js";
import { mountAnchorRoutes } from "./routes/anchors.js";

export type Env = {
  TENANT_A_DB: D1Database;
  TENANT_B_DB: D1Database;
  CONTROL_DB: D1Database;
  SHIPMENT_SEQ: DurableObjectNamespace<import("./do/sequencer.js").ShipmentSequencer>;
  IDEMPOTENCY: KVNamespace;
  EVIDENCE: R2Bucket; // anchor receipts (.tsr) + manifests (REQ-014)
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
app.use("/v1/*", idempotency);

app.get("/v1/whoami", (c) => c.json(c.get("session")));

// WP-01 conformance target for the idempotency contract test; replaced by real mutations at WP-02+.
const EchoBody = z.object({ n: z.number() });
app.post("/v1/_echo", async (c) => {
  const body = EchoBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new ApiError("VALIDATION_FAILED", 400, "BODY MUST BE {n: number}");
  return c.json({ n: body.data.n, req_id: c.get("req_id") });
});

// REQ-025 probe: the isolation suite's read target. Reads ONLY the session tenant's D1.
app.get("/v1/_probe", requireRole("admin", "ops", "finance"), async (c) => {
  const db = tenantDb(c.env, c.get("session").tenant);
  const row = await db.prepare("SELECT tenant FROM probe LIMIT 1").first<{ tenant: string }>();
  return c.json({ tenant_marker: row?.tenant ?? null });
});

// WP-02 ledger routes (REQ-015 / REQ-002 / I6). Mounted AFTER auth + idempotency so both apply.
mountEventRoutes(app);
mountPositionRoutes(app);
mountAnchorRoutes(app);

app.notFound((c) => envelope(c, "NOT_FOUND", 404, "NOT FOUND"));

export { ShipmentSequencer } from "./do/sequencer.js";

export default app;
