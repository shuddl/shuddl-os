import type { Hono } from "hono";
import { AnchorDay, LeafHex, type AnchorProofResponse, type AnchorRunResponse, type AnchorSummaryResponse } from "@shuddl/contracts";
import { anchorProof, readAnchorManifest, runDailyAnchor } from "@shuddl/ledger/anchor";
import { FakeTsaClient, HttpTsaClient, UnavailableTsaClient, type TsaClient } from "@shuddl/ledger/tsa/client";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { resolveTenantDb } from "../tenants.js";
import type { Env, Vars } from "../index.js";

// REQ-014 — the anchors read/verify surface (doc 14 §04). Tenant + party come from the JWT claim
// only. The proof endpoint is open to every authenticated role: a party verifying its OWN POD hash
// against a third-party TSA receipt is the entire point, and a sibling tenant's leaves are opaque
// (it can only ask about a leaf it already holds). The full manifest carries activity counts, so the
// portal lens gets only {day, root} — no volume signal leaks across the boundary (Decision 14).

// Prod resolves a real RFC-3161 endpoint from the `integrations` row (kind 'tsa'); a missing config
// yields an Unavailable client so the anchor leaves the day unanchored + escalates (never a fake in
// prod). Dev/CI use the deterministic fake so the whole flow is exercised offline.
async function tsaClientFor(env: Env, db: D1Database): Promise<TsaClient> {
  if (env.ENVIRONMENT !== "prod") return new FakeTsaClient();
  const row = await db.prepare("SELECT config FROM integrations WHERE kind = 'tsa' LIMIT 1").first<{ config: string }>();
  if (!row) return new UnavailableTsaClient("TSA_UNCONFIGURED");
  const cfg = JSON.parse(row.config) as { url?: string };
  return cfg.url ? new HttpTsaClient({ url: cfg.url }) : new UnavailableTsaClient("TSA_URL_MISSING");
}

function parseDay(raw: string): string {
  const parsed = AnchorDay.safeParse(raw);
  if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "day MUST BE YYYY-MM-DD");
  return parsed.data;
}

export function mountAnchorRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // GET /v1/anchors/:day — full manifest for tenant roles; {day, root} only for portal.
  app.get("/v1/anchors/:day", async (c) => {
    const session = c.get("session");
    const day = parseDay(c.req.param("day"));
    const manifest = await readAnchorManifest(c.env.EVIDENCE, session.tenant, day);
    if (!manifest) throw new ApiError("NOT_FOUND", 404, "ANCHOR NOT FOUND");
    if (session.role === "portal") {
      const summary: AnchorSummaryResponse = { day: manifest.day, root: manifest.root };
      return c.json(summary);
    }
    return c.json(manifest);
  });

  // GET /v1/anchors/:day/proof?leaf=<hex> — inclusion proof for one leaf. Any authenticated role.
  app.get("/v1/anchors/:day/proof", async (c) => {
    const session = c.get("session");
    const day = parseDay(c.req.param("day"));
    const leaf = LeafHex.safeParse(c.req.query("leaf"));
    if (!leaf.success) throw new ApiError("VALIDATION_FAILED", 400, "leaf MUST BE EVEN-LENGTH LOWER-CASE HEX");
    const db = await resolveTenantDb(c.env, session.tenant);
    try {
      const proof = await anchorProof(db, day, leaf.data);
      const body: AnchorProofResponse = { day: proof.day, root: proof.root, proof: proof.steps, receipt_doc_id: proof.receipt_doc_id };
      return c.json(body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("ANCHOR_NOT_FOUND")) throw new ApiError("NOT_FOUND", 404, "ANCHOR NOT FOUND");
      if (msg.startsWith("LEAF_NOT_IN_DAY")) throw new ApiError("NOT_FOUND", 404, "LEAF NOT IN ANCHORED DAY");
      throw new ApiError("INTERNAL", 500, "ANCHOR PROOF FAILED"); // ROOT_DRIFT etc.
    }
  });

  // POST /v1/anchors/run — admin-triggered backfill (the cron does this on a schedule). Anchors this
  // tenant's unanchored days up to yesterday, oldest-first, capped per run.
  //
  // A 200 reports what the RUN did, which is not the same question as whether the request was served. Both
  // failure modes are inside the body, and neither is silent: a day that could not anchor is named in
  // `failed[]`, and a run that could not even determine its days is named in `scan_failed` (all three
  // arrays then empty) — the honest distinction from "nothing to anchor", which is the same body without
  // that field. Both are also durably alarmed in `anomalies`, so the cron path (which discards this result)
  // still reports them, and both are visible at GET /v1/watchtower?status=open. What this endpoint must not
  // do is 500: runDailyAnchor contains every D1 fault it can meet, per-day and pre-loop alike.
  app.post("/v1/anchors/run", requireRole("admin"), async (c) => {
    const session = c.get("session");
    const db = await resolveTenantDb(c.env, session.tenant);
    const tsa = await tsaClientFor(c.env, db);
    const res = await runDailyAnchor({ db, r2: c.env.EVIDENCE, tsa, tenant: session.tenant, now: () => new Date() });
    const body: AnchorRunResponse = res;
    return c.json(body);
  });
}
