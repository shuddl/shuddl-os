import type { Hono } from "hono";
import { lensFor, readEvents } from "@shuddl/ledger/lens";
import { ApiError, envelope } from "../middleware/error.js";
import { resolveTenantDb } from "../tenants.js";
import { mintDocDownloadCap, verifyDocDownloadCap } from "../pub/doc-cap.js";
import type { Env, Vars } from "../index.js";

// REQ-085 (WP-09 Task 6) — the PORTAL DOCUMENTS view. Three routes:
//   GET /v1/shipments/:id/documents  — a LENS-SCOPED documents list (authed).
//   GET /v1/documents/:id/url        — a short-lived SIGNED download URL, GATED through the SAME lens (authed).
//   GET /pub/documents/:cap          — the PUBLIC bytes proxy the URL points at (cap IS the authorization).
//
// The ledger carries the R2 REF, never the bytes; this surface hands a portal party a lens-correct list and
// a fail-closed way to fetch the bytes it is entitled to. Tenant + party come from the JWT claim ONLY
// (tenantDb + lensFor) — never a header/query/:id. The docs-list visibility scope REUSES the events lens
// seam (readEvents) so it can never drift from the read scope the party already sees.

const DOWNLOAD_TTL_SECONDS = 5 * 60; // a signed download URL is short-lived — minted per request, per doc.
const MAX_SHIPMENT_ID_LEN = 200; // mirrors events.ts (well under any DO-name / KV-key limit)
const MAX_DOCUMENT_ID_LEN = 300; // evidenceDocId = `evidence:<shipment>:<64-hex>` — ample headroom

// The portal-SAFE list columns. r2_key/hash are DELIBERATELY absent: the bytes ride the signed-URL
// resolver (which re-checks the lens), never the list body — so the list never leaks the R2 key layout.
const DOC_LIST_COLS = "id, shipment_id, party_id, kind, visibility";

// lensFor throws a PLAIN Error("LENS_UNRESOLVED: …") for a portal session missing party_id — surface it as
// a clean 403 instead of an opaque 500. Anything else rethrows as-is (incl. our own ApiErrors).
function toLensError(e: unknown): unknown {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith("LENS_UNRESOLVED")) return new ApiError("FORBIDDEN", 403, "SESSION LENS UNRESOLVED");
  return e;
}

export function mountDocumentRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // GET /v1/shipments/:id/documents — the shipment's documents through the caller's lens. No requireRole:
  // the lens is the gate (mirrors the events read). tenant lens (admin/ops/finance/read) => every in-tenant
  // doc; party lens (portal) => only visibility<>'internal' docs on a shipment the party is on; driver lens
  // => same, on an assigned shipment.
  app.get("/v1/shipments/:id/documents", async (c) => {
    const session = c.get("session");
    const db = await resolveTenantDb(c.env, session.tenant);
    const shipmentId = c.req.param("id") ?? "";
    if (shipmentId.length > MAX_SHIPMENT_ID_LEN) throw new ApiError("VALIDATION_FAILED", 400, "SHIPMENT ID TOO LONG");
    try {
      const lens = lensFor(session);
      // party/driver: prove the caller can SEE the shipment through the SAME lens seam the events read uses
      // (the status-link.ts precedent) BEFORE any doc surfaces. Zero visible events => the shipment is not in
      // the caller's scope => an empty list (fail-closed), never another party's docs.
      if (lens.scope !== "tenant") {
        const visible = await readEvents(db, lens, { shipment_id: shipmentId, limit: 1 });
        if (visible.length === 0) return c.json({ documents: [] });
      }
      // The visibility filter DERIVED from the lens: tenant sees all; party/driver see only NON-internal.
      // documents.visibility is CHECK-constrained to {internal,counterparty,public}, so `<> 'internal'` is
      // the SAME positive allowlist the events lens uses (lens.ts) — one rule, no drift.
      const where = lens.scope === "tenant" ? "shipment_id = ?" : "shipment_id = ? AND visibility <> 'internal'";
      const res = await db.prepare(`SELECT ${DOC_LIST_COLS} FROM documents WHERE ${where} ORDER BY id`).bind(shipmentId).all();
      return c.json({ documents: res.results });
    } catch (e) {
      throw toLensError(e);
    }
  });

  // GET /v1/documents/:id/url — resolve ONE document to a short-lived signed download URL, GATED through the
  // SAME lens as the list. A portal party can only get a URL for a doc it can see; a miss FAILS CLOSED to
  // 404 (never reveal an internal doc — or another tenant's doc — exists).
  app.get("/v1/documents/:id/url", async (c) => {
    const session = c.get("session");
    const db = await resolveTenantDb(c.env, session.tenant);
    const documentId = c.req.param("id") ?? "";
    if (documentId.length > MAX_DOCUMENT_ID_LEN) throw new ApiError("VALIDATION_FAILED", 400, "DOCUMENT ID TOO LONG");
    try {
      const lens = lensFor(session);
      // Look the doc up in the SESSION tenant's D1 only (tenantDb is claim-keyed, REQ-025). Not found — OR a
      // doc that lives only in another tenant's D1 — is a plain 404, indistinguishable from nonexistent.
      // RETENTION COUPLING — this query deliberately does NOT filter `retention_status` (audit §95/§104).
      // An EXPIRED (tombstoned) row is still resolvable here, and that is safe for ONE reason: the retention
      // sweep DELETES the R2 bytes BEFORE it tombstones the row (`packages/ledger/src/documents/retention.ts`),
      // so an expired row's bytes never exist and the byte fetch below takes its graceful 404. Reverse that
      // ordering and the torn state becomes "row expired, bytes present" — which THIS query would happily
      // serve. The ordering is pinned by `packages/ledger/test/retention.test.ts` ("a FAILING tombstone leaves
      // the row ACTIVE with bytes already gone"). If you ever make a missing object anything other than a
      // clean miss here, read that test first.
      const doc = await db
        .prepare("SELECT shipment_id, r2_key, visibility FROM documents WHERE id = ?")
        .bind(documentId)
        .first<{ shipment_id: string | null; r2_key: string; visibility: string }>();
      if (doc === null) throw new ApiError("NOT_FOUND", 404, "DOCUMENT NOT FOUND");

      // The SAME lens gate the list applies, fail-closed. party/driver need BOTH: (a) the doc is non-internal
      // AND (b) the caller's lens can see the doc's shipment. A miss on EITHER is a 404. tenant lens: any
      // in-tenant doc. `<> 'internal'` via an explicit allowlist so an unexpected value never passes.
      if (lens.scope !== "tenant") {
        if (doc.visibility === "internal") throw new ApiError("NOT_FOUND", 404, "DOCUMENT NOT FOUND");
        const visible = await readEvents(db, lens, { shipment_id: doc.shipment_id ?? "", limit: 1 });
        if (visible.length === 0) throw new ApiError("NOT_FOUND", 404, "DOCUMENT NOT FOUND");
      }

      // Mint the signed proxy URL. `t` is session.tenant ALONE (never client input / :id), `k` is the
      // server-stored r2_key — BOTH ride inside the MAC, so a cap can only ever address its own tenant's
      // bytes. Relative /pub path only — the host is deploy-config, never a hardcoded domain (REQ-167).
      const cap = await mintDocDownloadCap(c.env.JWT_SECRET, {
        t: session.tenant,
        k: doc.r2_key,
        expSeconds: Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS,
      });
      return c.json({ url: `/pub/documents/${cap}`, expires_in: DOWNLOAD_TTL_SECONDS });
    } catch (e) {
      throw toLensError(e);
    }
  });

  // GET /pub/documents/:cap — the PUBLIC bytes proxy. Mounted at /pub/* (NOT /v1/*), so app.use("/v1/*", auth)
  // does NOT run — the cap IS the authorization, and verifyDocDownloadCap is the whole gate. Every failure is
  // the SAME uniform 404 (no MAC/tenant/existence oracle), mirroring the /pub/status handler.
  app.get("/pub/documents/:cap", async (c) => {
    // The cap lives in browser history / referrer / access logs — no-referrer + no-store on every response.
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    const cap = c.req.param("cap") ?? "";
    const deny = (): Response => envelope(c, "NOT_FOUND", 404, "NOT FOUND");

    let claims: { t: string; k: string };
    try {
      claims = await verifyDocDownloadCap(cap, c.env.JWT_SECRET);
    } catch {
      return deny();
    }
    // Defense in depth (REQ-025): the SIGNED key MUST live in the SIGNED tenant's R2 namespace
    // (`evidence/<t>/…`, the evidenceKey template) — so even a MAC-valid cap can only ever reach ITS OWN
    // tenant's bytes. Any drift => the uniform 404.
    if (!claims.k.startsWith(`evidence/${claims.t}/`)) return deny();
    let obj: R2ObjectBody | null;
    try {
      obj = await c.env.EVIDENCE.get(claims.k);
    } catch {
      return deny();
    }
    if (obj === null) return deny();
    return new Response(obj.body, {
      headers: {
        "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  });
}
