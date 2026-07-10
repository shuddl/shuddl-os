import type { Hono } from "hono";
import { PositionInput } from "@shuddl/contracts";
import { canonicalBytes, sha256Hex } from "@shuddl/ledger/canonical";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { tenantDb } from "../tenants.js";
import type { Env, Vars } from "../index.js";

// REQ-002 / doc 14 §06 — positions are a PHYSICAL PARTITION of the ledger: they BYPASS the sequencer
// (no seq, no hash chain) and land directly in the `positions` table. Tenant comes from the JWT claim
// only. The Merkle-leaf hash is a pure function of the client fields (NOT the server clock), so a
// re-ingest is byte-identical and dedupes cleanly.

export function mountPositionRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  app.post("/v1/positions", requireRole("admin", "ops", "driver"), async (c) => {
    const parsed = PositionInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "INVALID POSITION");
    const p = parsed.data;

    // Canonical position bytes = the client-meaningful fields ONLY. `recorded_at` (the server clock) is
    // DELIBERATELY excluded: a byte-identical re-ingest must reproduce the SAME hash so positions_guard_ins
    // (which aborts only when an existing PK row has a DIFFERENT hash) stays silent and INSERT OR IGNORE
    // dedupes the row. This is the Merkle leaf the daily anchor (Task 16) will attest.
    const canon: Record<string, number | string> = {
      shipment_id: p.shipment_id,
      device_id: p.device_id,
      ts: p.ts,
      lat_e6: p.lat_e6,
      lon_e6: p.lon_e6,
    };
    if (p.accuracy_m !== undefined) canon.accuracy_m = p.accuracy_m;
    if (p.speed_cms !== undefined) canon.speed_cms = p.speed_cms;
    const hash = await sha256Hex(canonicalBytes(canon));

    // Two independent dedupe layers, both intentional: the Idempotency-Key middleware (POST is a mutation)
    // dedupes an HTTP retry of the SAME key; the PK (shipment_id, device_id, ts) + INSERT OR IGNORE dedupes
    // a re-send under a NEW key. Neither writes twice.
    await tenantDb(c.env, c.get("session").tenant)
      .prepare(
        "INSERT OR IGNORE INTO positions (shipment_id, device_id, ts, recorded_at, lat_e6, lon_e6, accuracy_m, speed_cms, hash) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .bind(p.shipment_id, p.device_id, p.ts, Date.now(), p.lat_e6, p.lon_e6, p.accuracy_m ?? null, p.speed_cms ?? null, hash)
      .run();

    return c.json({ ok: true, hash }, 201);
  });
}
