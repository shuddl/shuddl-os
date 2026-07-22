import { Hono } from "hono";
import type { SessionClaims } from "@shuddl/contracts";
import { z } from "zod";
import { reqId, handleError, envelope, ApiError } from "./middleware/error.js";
import { corsMiddleware } from "./middleware/cors.js";
import { auth, requireRole } from "./middleware/auth.js";
import { idempotency } from "./middleware/idempotency.js";
import { resolveTenantDb } from "./tenants.js";
import { mountEventRoutes } from "./routes/events.js";
import { mountPositionRoutes } from "./routes/positions.js";
import { mountAnchorRoutes } from "./routes/anchors.js";
import { mountRateRoutes } from "./routes/rate.js";
import { mountEvidenceRoutes } from "./routes/evidence.js";
import { mountStatusLinkRoutes } from "./routes/status-link.js";
import { mountDocumentRoutes } from "./routes/documents.js";
import { mountInvoiceRoutes } from "./routes/invoices.js";
import { mountPortalActionRoutes } from "./routes/portal-actions.js";
import { mountIntakeRoutes } from "./routes/intake.js";
import { mountApprovalRoutes } from "./routes/approvals.js";
import { mountExceptionRoutes } from "./routes/exceptions.js";
import { mountKpiRoutes } from "./routes/kpis.js";
import { mountParityRoutes } from "./routes/parity.js";
import { mountAuthorityRoutes } from "./routes/authority.js";
import { mountCopilotRoutes } from "./routes/copilot.js";
import { mountBoardRoutes } from "./routes/board.js";
import { mountExportRoutes } from "./routes/export-journal.js";
import { mountFullExportRoutes } from "./routes/export.js";
import { mountDunningRoutes } from "./routes/dunning.js";
import { mountWatchtowerRoutes } from "./routes/watchtower.js";
import { mountPublicRoutes } from "./routes/public.js";
import { mountSignupRoutes } from "./routes/signup.js";
import { mountTariffRoutes } from "./routes/tariff.js";
import { mountImportRoutes } from "./routes/import.js";
import { mountInternalPlatformRoutes } from "./routes/internal-platform.js";

export type Env = {
  TENANT_A_DB: D1Database;
  TENANT_B_DB: D1Database;
  CONTROL_DB: D1Database;
  // WP-14 Task 1 (REQ-123/025): the reserved PLATFORM revenue tenant's OWN D1. A DISTINCT binding from the
  // customer tenant DBs and from CONTROL_DB — reachable ONLY server-side via resolvePlatformTenantDb (never
  // the customer TENANT_BINDINGS/tenantDb path). The usage/credits billing ledger provisions against it.
  PLATFORM_TENANT_DB: D1Database;
  // WP-14 Task 2 (REQ-121/025): the pre-provisioned tenant-D1 POOL for DARK dynamic provisioning. Bindings are
  // static in a Worker, so self-serve signup CLAIMS one of these already-migrated slots (provisionTenant) rather
  // than minting a binding. Reached ONLY server-side (resolveClaimedTenantDb / the claim), NEVER the customer
  // TENANT_BINDINGS/tenantDb path — so the REQ-025 ISO-pub-5 subset-parity (HOST_TENANTS ⊆ TENANT_BINDINGS) is
  // untouched. Grow the pool by adding a binding here + a wrangler slot + a sentinel row (0003_tenant_pool.sql).
  TENANT_POOL_01_DB: D1Database;
  TENANT_POOL_02_DB: D1Database;
  // WP-14 Task 2 (REQ-121): the server-side provisioning FLAG. DARK by default — ABSENT from every wrangler.toml,
  // so provisionTenant() fail-closes (refuses) until R4 flips it ON. Never a client input; read off the Env only.
  PROVISIONING_ENABLED?: string;
  // WP-14 Task 10 (REQ-123/025): the server-to-server shared secret gating the INTERNAL platform-credit append
  // route (routes/internal-platform.ts). The billing worker presents it (via the API service binding) to append
  // credit money events onto `_platform` through the real sequencer. ABSENT ⇒ DARK: the internal route 503s and
  // no platform-credit append is possible. Operator-injected via `wrangler secret`, NEVER wrangler.toml (REQ-154).
  PLATFORM_INTERNAL_SECRET?: string;
  SHIPMENT_SEQ: DurableObjectNamespace<import("./do/sequencer.js").ShipmentSequencer>;
  AGENT_QUEUE: Queue; // WP-06 (REQ-031/039): committed pod.signed → Biller trigger (consumer: agents worker)
  IDEMPOTENCY: KVNamespace;
  EVIDENCE: R2Bucket; // anchor receipts (.tsr) + manifests (REQ-014)
  JWT_SECRET: string;
  ENVIRONMENT: string;
  // WP-10 Task 7 (REQ-038/024) — the copilot's OPTIONAL, CONFIRM-gated LLM binding. BOTH present ⇒ the live
  // ClaudeCopilot; anything less ⇒ the DeterministicCopilot floor. Unbound in CI, so the LLM is never called there.
  ANTHROPIC_API_KEY?: string;
  COPILOT_MODEL?: string;
  // WP-14 Task 5 (REQ-127/035/024) — the Migrator column-guesser's OPTIONAL model id. With ANTHROPIC_API_KEY both
  // present ⇒ the live ClaudeMigrator; anything less ⇒ the deterministic @shuddl/adapters mapping. Unbound in CI.
  MIGRATOR_MODEL?: string;
  // WP-11 Task 7 (REQ-032/092/157) — the Collector dunning human-send. BOTH RESEND halves present ⇒ ResendSender;
  // anything less ⇒ NotConfiguredSender (rejects LOUDLY, retriable) — the SAME composition-root discipline as the
  // agents worker's evidenceSender. Unbound in CI, so the live sender is never reached (tests inject a recorder).
  RESEND_API_KEY?: string;
  EVIDENCE_FROM?: string;
  DUNNING_FROM_NAME?: string; // REQ-098 tenant voice signed into the dunning body (defaults to a REQ-167-clean name)
};
export type Vars = { req_id: string; session: SessionClaims };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.use("*", reqId);
// REQ-025/189 (WP-09 Task 5): scoped CORS for the Portal + public status browser origins. Mounted right
// after reqId and BEFORE auth so (a) it wraps BOTH /v1/* and /pub/*, and (b) the OPTIONS preflight — which
// browsers send WITHOUT an Authorization header — is answered here with a 204 and never reaches auth (which
// would 401 it). A denied origin gets NO Access-Control-Allow-Origin header; an allowed origin is echoed,
// never `*`. See middleware/cors.ts for the (synthetic, REQ-167-safe) allowlist.
app.use("*", corsMiddleware());
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
  const db = await resolveTenantDb(c.env, c.get("session").tenant);
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
// WP-09 Task 6 (REQ-085): the portal DOCUMENTS view — GET /v1/shipments/:id/documents (lens-scoped list) +
// GET /v1/documents/:id/url (lens-gated signed download URL). Both /v1 routes, so auth + idempotency already
// apply; the module ALSO registers the public GET /pub/documents/:cap bytes proxy the URL points at (the cap
// is its authorization — it lives outside the /v1 auth middleware by design).
mountDocumentRoutes(app);
// WP-09 Task 7 (REQ-085 + REQ-179 pulled forward): GET /v1/invoices — the PORTAL invoices list, lens-scoped
// (a party sees only invoices billed to it; ops/admin see all in-tenant). A /v1 route, so auth + idempotency
// already apply. The margin/GL internals (division/gl_map) are absent from the party projection here, the
// same law redact.ts now enforces on the invoice.issued EVENT (nested lines[].gl_map strip, REQ-179).
mountInvoiceRoutes(app);
// WP-09 Task 8 (REQ-085): the NARROW, lens-gated portal action seams — POST /v1/shipments/:id/accept-quote
// (quote.accepted → the WP-08 Booking agent) + POST /v1/shipments/:id/claim (a portal-channel message.received).
// Both /v1 routes, so auth + idempotency already apply; both lens-gate :id and append THROUGH the sequencer DO.
// A portal party gets NO general event-POST — that surface (POST /v1/shipments/:id/events) still excludes portal.
mountPortalActionRoutes(app);
// WP-10 Task 6 (REQ-150/195/030/025): the synchronous CSR net-new intake seam — POST /v1/parties (find-or-create
// a party deterministically, no LLM) + POST /v1/shipments (materialize a QUOTE-STAGE shipments row with the
// shipper/consignee/bill_to FKs). Both /v1 routes, so auth + idempotency already apply; roles admin/ops only,
// tenant off the JWT claim (tenantDb, REQ-025). The seam creates a quote-stage row with NO booking.created, so a
// CSR booking still flows through the sequencer + #enforceBooking (credit/evidence gates — no bypass). UI-decoupled
// (WP-13 MCP calls the same verbs). NO new table/kind; the append-only ledger is untouched (domain-table INSERTs).
mountIntakeRoutes(app);
// WP-10 Task 2 (REQ-082/194): the approvals QUEUE — POST /v1/shipments/:id/approval-decision (the BLESSED
// approval.decided path that enforces the matrix required_role SERVER-SIDE) + GET /v1/approvals?status=open
// (the tenant-scoped command-queue list over the read-model the sequencer now projects). Both /v1 routes, so
// auth + idempotency already apply; the write appends THROUGH the sequencer DO (I1 + every gate still run).
mountApprovalRoutes(app);
// WP-10 Task 3 (REQ-082): GET /v1/exceptions?status=open — the command EXCEPTIONS queue, a DURABLE read over the
// append-only exception.raised + osd.captured EVENTS (NOT the clobber-prone status_cache), joined to each
// shipment's current state for an honest open/resolved flag. A /v1 route, so auth + idempotency already apply;
// tenant-scoped via the JWT claim (tenantDb, REQ-025). NO new table/kind/projection. Resolve flow deferred to WP-11.
mountExceptionRoutes(app);
// WP-10 Task 5 (REQ-083): GET /v1/kpis — the command KPI strip. Six tiles, each a REAL number computed from real
// ledger rows and DRILLABLE to its backing events (backing.kinds → GET /v1/events?kind=), OR the literal "UNKNOWN"
// — NEVER a fabricated/placeholder number (the "no price on air" ethos for KPIs). The OR tile is an HONEST,
// clearly-labeled cost/revenue ratio from the quoted cost basis, NOT a bare Operating Ratio (no op-cost kind exists).
// A /v1 route, so auth + idempotency apply; tenant-scoped via the JWT claim (tenantDb, REQ-025). NO new table/kind/projection.
mountKpiRoutes(app);
// WP-15 Task 6 (REQ-023/152/153): GET /v1/parity — the overlay's v_parity shadow-parity dashboard compute. The 5
// overlay modules' native-vs-legacy parity (@shuddl/ledger/parity computeAllParity), each a REAL number or the
// literal "UNKNOWN" with backing_kinds for drill-through. The SAME primitive the flip guard + Watchtower consume,
// so gate/dashboard/alarm can never drift. A DURABLE READ over `events` split by `source` — NO new table/kind/
// projection. Tenant-lens roles only; tenant off the JWT claim (tenantDb, REQ-025). Task 7 renders the tile.
mountParityRoutes(app);
// WP-15 Task 3 (REQ-023/030, L8): POST /v1/authority/:module/flip — the Gatekeeper FLIP GUARD. A per-module
// authority flip is a SERVER-SIDE decision, never a UI toggle: it evaluates the gate FRESH (parity via the shared
// primitive + the money clean-close leg) and either PROMOTES a module to native (FORWARD — blocked until parity
// is proven green) or FALLS BACK to legacy (BACKWARD — always allowed), recording a co-signed, append-only
// authority.flipped event on the tenant-level t:root stream. authority_map changes ONLY via the Task-1 projection
// of that event — never a direct write. admin-only; tenant off the JWT claim (resolveTenantDb, REQ-025). A /v1
// route, so auth + idempotency already apply. NO new table/kind (authority.flipped is the frozen #35).
mountAuthorityRoutes(app);
// WP-10 Task 7 (REQ-038/024): POST /v1/copilot/ask — the READ-ONLY, cite-or-abstain ledger copilot. Binds a
// lens-scoped D1 read port (readEvents(db, lensFor(session), q)) and runs the pure copilot core (@shuddl/agents,
// where the LLM lives — statically linted). NO write path: the route only reads + returns {text, citations,
// abstained}. Tenant-lens roles only; tenant off the JWT claim (tenantDb, REQ-025). LLM unbound in CI → the
// DeterministicCopilot floor answers; the LLM is never reachable in tests.
mountCopilotRoutes(app);
// WP-10 Task 9 (REQ-073/080): GET /v1/board — the command map's live, lens-scoped fleet. The tenant's ACTIVE
// shipments, each at its LATEST position with status_cache.state mapped to the map's status vocabulary, so the
// exception-pulse / world-dim demo #5 fires on REAL ledger state (not synthetic demoFleet). A DURABLE read over
// shipments (status_cache) + positions — NO new table/kind/projection. Tenant-lens roles only; tenant off the JWT
// claim (tenantDb, REQ-025). The tenant lens is unredacted, so the board exposes EXACT ops geo; a shipment with no
// position is never placed (truthful map). A /v1 route, so auth + idempotency already apply.
mountBoardRoutes(app);
// WP-11 Task 2 (REQ-020/057/025): GET /v1/export/journal — the QuickBooks JOURNAL EXPORT. Serves a balanced
// double-entry journal for a [from,to] window as a QuickBooks IIF artifact (format=iif, default) or the raw
// JournalLine[] (format=json), optionally scoped to one division (REQ-057). A ONE-WAY journal artifact —
// NATIVE GL FORBIDDEN (no period close/balances); exportJournal + the serializer both assert Σdebit===Σcredit.
// roles admin/ops/finance; tenant off the JWT claim (tenantDb, REQ-025). A /v1 route, so auth + idempotency
// already apply. NO new table/kind/projection — a pure read over money_lines.
mountExportRoutes(app);
// WP-11 Task 5 (REQ-010/025): GET /v1/export — the ONE-CLICK FULL TENANT EXPORT in open formats. ADMIN only
// (a full-tenant export is privileged). Assembles a SINGLE open-format JSON archive: the append-only EVENTS
// (lens-scoped, admin = tenant lens, cursor-paginated so a big tenant streams page by page), the GL JOURNAL
// (exportJournal + the QuickBooks IIF), the DOCUMENT refs (documents read-model rows — refs, NOT bytes), and
// the daily MERKLE ANCHOR roots (the tsa_receipt documents rows), plus a manifest (tenant, generated_at,
// counts, roots). A READ — no writes, no new table/kind; only existing reads. Tenant off the JWT claim
// (tenantDb, REQ-025) — the export can NEVER cross tenants. A /v1 route, so auth + idempotency already apply.
mountFullExportRoutes(app);
// WP-11 Task 7 (REQ-032/025): the Collector's dunning human review-and-send. GET /v1/dunning?status=draft (the
// DRAFT queue — Collector-drafted `messages` rows with no corresponding message.sent, re-rendered from the
// invoice's committed state) + POST /v1/dunning/:id/send (a HUMAN-INITIATED send — the human IS the approval;
// no auto-send, no dual-control matrix). The send appends message.sent THROUGH the sequencer FIRST then calls
// the EvidenceSender, idempotent (deterministic id) with an honest hold (biller.ts pattern). Both /v1 routes, so
// auth + idempotency already apply; roles admin/ops/finance, tenant off the JWT claim (tenantDb, REQ-025). NO new
// table/kind — drafts are `messages` rows; the send is a `message.sent` event.
mountDunningRoutes(app);
// WP-11 Task 8 (REQ-036): GET /v1/watchtower — the thin READ over the durable `anomalies` alarms the Watchtower
// cron (workers/agents/src/watchtower.ts) raises (unbilled / pricing_anomaly / floor_breach). The alarm STORE is
// the deliverable; this surfaces the open alarms to the command surface. roles admin/ops/finance; tenant off the
// JWT claim (tenantDb, REQ-025). A /v1 route, so auth + idempotency already apply. NO new table/kind/projection.
mountWatchtowerRoutes(app);
// WP-09 Task 3 (REQ-187/188): GET /pub/status/:cap — the PUBLIC, no-auth status read that consumes the cap
// minted above. Mounted at /pub/* (NOT /v1/*), so app.use("/v1/*", auth) + idempotency do NOT run — the cap
// is the authorization. This is the first public data read in the system; verifyStatusCap is the whole gate.
mountPublicRoutes(app);
// WP-14 Task 3 (REQ-121/025): POST /pub/signup — the PRE-AUTH, DARK self-serve signup. Mounted at /pub/* (NOT
// /v1/*), so auth + idempotency do NOT run (a stranger has no token). Behind PROVISIONING_ENABLED (OFF by
// default → 404, DARK); when ON it CLAIMS a pool slot (provisionTenant) and mints the new tenant's admin session
// so the customer can read their own workspace via the resolveTenantDb claimed-fallback (tenants.ts). No new
// table/kind/surface — the claimed-registry is the existing `tenants` control table.
mountSignupRoutes(app);
// WP-14 Task 4 (REQ-151/025/030): POST /v1/tariff — the GUIDED TARIFF BUILDER. Materializes a brokerage
// cold-start tariff (market rate + margin) into the tenant's OWN rate_config so a fresh tenant quotes on day
// one; asset mode fabricates NOTHING (no tariff ⇒ UNKNOWN no_tariff — no price on air, REQ-004). A /v1 route,
// so auth + idempotency already apply; roles admin/ops, tenant off the JWT claim (resolveTenantDb, REQ-025). NO
// new table/kind — it rides the existing rate_config via the shared seedColdStartTariff (also the provisioning seed).
mountTariffRoutes(app);
// WP-14 Task 5 (REQ-127/035/025/030): POST /v1/import — the Migrator drag-drop import (light self-serve). Maps a
// messy spreadsheet via the PURE @shuddl/adapters mapper (rescued by the @shuddl/agents LLM column-guesser, which
// degrades to the deterministic mapping when unbound), LOOPS the intake verbs (findOrCreateParty/materializeShipment
// — the SAME functions POST /v1/parties + /v1/shipments call, identical gate parity), writes EXACTLY ONE anomalies
// row per unmapped/low-confidence column (CLAUDE.md rule 10 / REQ-035 — no silent drop; values ride refs/external_refs),
// and records the run into agent_runs. roles admin/ops, tenant off the JWT claim (resolveTenantDb, REQ-025). Every id
// is content-derived so a re-import makes no dupes. NO new table/kind/surface.
mountImportRoutes(app);
// WP-14 Task 10 (REQ-123/025/003): the INTERNAL, server-to-server platform-credit append seam. Mounted at
// /internal/* (NOT /v1/*), so app.use("/v1/*", auth) + idempotency do NOT run — a customer JWT never reaches it.
// Its own fail-closed shared-secret gate (PLATFORM_INTERNAL_SECRET, DARK by default) is the sole authorization.
// The billing worker (over the API service binding) appends credit money events onto `_platform` through the REAL
// sequencer here — the ONLY caller that sets the sequencer's `platform: true` flag (the isolation invariant).
mountInternalPlatformRoutes(app);

app.notFound((c) => envelope(c, "NOT_FOUND", 404, "NOT FOUND"));

export { ShipmentSequencer } from "./do/sequencer.js";

export default app;
