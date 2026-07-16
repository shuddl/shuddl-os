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
import { mountRateRoutes } from "./routes/rate.js";
import { mountEvidenceRoutes } from "./routes/evidence.js";
import { mountStatusLinkRoutes } from "./routes/status-link.js";
import { mountPublicRoutes } from "./routes/public.js";

export type Env = {
  TENANT_A_DB: D1Database;
  TENANT_B_DB: D1Database;
  CONTROL_DB: D1Database;
  SHIPMENT_SEQ: DurableObjectNamespace<import("./do/sequencer.js").ShipmentSequencer>;
  AGENT_QUEUE: Queue; // WP-06 (REQ-031/039): committed pod.signed → Biller trigger (consumer: agents worker)
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
// WP-04 Task 10 (REQ-030/025/005/I5): POST /v1/rate — server-side floor gate (requireRole applied inside).
mountRateRoutes(app);
// WP-06 (REQ-168/017): POST /v1/evidence — byte-verified deferred evidence upload (SHA-256 must match
// the event-recorded hash or nothing is stored).
mountEvidenceRoutes(app);
// WP-09 Task 2 (REQ-187): POST /v1/shipments/:id/status-link — authed, lens-scoped mint of a public
// status-cap link. A /v1 route, so app.use("/v1/*", auth) + idempotency already apply. The public read
// that consumes the cap (GET /pub/status/:cap) is Task 3.
mountStatusLinkRoutes(app);
// WP-09 Task 3 (REQ-187/188): GET /pub/status/:cap — the PUBLIC, no-auth status read that consumes the cap
// minted above. Mounted at /pub/* (NOT /v1/*), so app.use("/v1/*", auth) + idempotency do NOT run — the cap
// is the authorization. This is the first public data read in the system; verifyStatusCap is the whole gate.
mountPublicRoutes(app);

app.notFound((c) => envelope(c, "NOT_FOUND", 404, "NOT FOUND"));

export { ShipmentSequencer } from "./do/sequencer.js";

export default app;
