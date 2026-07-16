import type { Hono } from "hono";
import { PositionInput } from "@shuddl/contracts";
import { canonicalBytes, sha256Hex } from "@shuddl/ledger/canonical";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { tenantDb } from "../tenants.js";
import { assignmentOf, deviceOwnedBy, loadStreamPrior, assertPositionConsent } from "../gate-context.js";
import { translateAppendError } from "./events.js";
import type { Env, Vars } from "../index.js";

// REQ-002 / doc 14 §06 — positions are a PHYSICAL PARTITION of the ledger: they BYPASS the sequencer
// (no seq, no hash chain) and land directly in the `positions` table. Tenant comes from the JWT claim
// only. The Merkle-leaf hash is a pure function of the client fields (NOT the server clock), so a
// re-ingest is byte-identical and dedupes cleanly.
//
// REQ-030 / REQ-166 / REQ-190 (2026-07-15 audit C-1) — BYPASS ≠ un-gated. This route skips the seq/
// hash-chain but NOT the server-side gates the sequencer's GPS path (stop.arrived) enforces. Before the
// INSERT it re-enforces, via the SHARED predicate module (../gate-context.js) so the two paths cannot
// drift: (1) driver-assignment scope (driver only; ops/admin unrestricted), (2) device-registration
// (the client device_id must belong to the authenticated principal), and (3) consent-before-GPS
// (deriveOperatingState + assertConsentBeforeGps over the prior stream, loaded from D1 here since there
// is no DO). Any refusal inserts NOTHING. NOTE [CONFIRM, carried]: whether each raw ping should ALSO be
// cryptographically co-signed per-ping (non-repudiation) is an open audit [CONFIRM] — positions are
// high-volume, so per-ping signature verification is a separate perf/UX decision, NOT done here. These
// three gates close the AUTHORIZATION breach.

export function mountPositionRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  app.post("/v1/positions", requireRole("admin", "ops", "driver"), async (c) => {
    const parsed = PositionInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "INVALID POSITION");
    const p = parsed.data;

    const session = c.get("session");
    const db = tenantDb(c.env, session.tenant);

    // (1) Driver write-scope — a driver may stamp GPS ONLY on a shipment the status-cache projection has
    // assigned to them (mirror of the events route). ops/admin are unrestricted by assignment. The
    // client shipment_id is untrusted until this passes → a non-assigned driver is 403, NOTHING inserted.
    if (session.role === "driver" && !(await assignmentOf(db, p.shipment_id, session.sub))) {
      throw new ApiError("FORBIDDEN", 403, "DRIVER NOT ASSIGNED TO THIS SHIPMENT");
    }

    // (2) Device-registration — the client device_id is untrusted until it is a device registered to the
    // authenticated principal (users.device_keys[]). A raw position carries no signed envelope (unlike a
    // DO event), so ownership is the minimum bar: a driver cannot post under a victim's device_id → 403.
    if (!(await deviceOwnedBy(c.env.CONTROL_DB, session.tenant, p.device_id, session.sub))) {
      throw new ApiError("FORBIDDEN", 403, "DEVICE NOT REGISTERED TO THIS PRINCIPAL");
    }

    // (3) Consent-before-GPS — the SAME pure gate the sequencer runs for stop.arrived, over the operating
    // state DERIVED SERVER-SIDE from this stamp's own coords + the prior stream (loaded from D1 here, not
    // the DO). No matching per-state consent on the stream → GateError → GATE_BLOCKED (403), NOTHING
    // inserted. GateError/GateValidationError encode `CODE:json`, so translateAppendError maps them to the
    // EXACT same envelope the events route uses for a DO gate block (GATE_BLOCKED 403 / VALIDATION_FAILED
    // 400) — one mapping, no drift. Any non-gate throw rethrows untouched (never masked as a gate block).
    try {
      assertPositionConsent(await loadStreamPrior(db, p.shipment_id), { lat_e6: p.lat_e6, lon_e6: p.lon_e6 });
    } catch (e) {
      if (e instanceof Error && /^(GATE_BLOCKED|VALIDATION_FAILED):/.test(e.message)) throw translateAppendError(e);
      throw e;
    }

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
    // a re-send under a NEW key. Neither writes twice. A byte-identical re-ingest passes silently here.
    try {
      await db
        .prepare(
          "INSERT OR IGNORE INTO positions (shipment_id, device_id, ts, recorded_at, lat_e6, lon_e6, accuracy_m, speed_cms, hash) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .bind(p.shipment_id, p.device_id, p.ts, Date.now(), p.lat_e6, p.lon_e6, p.accuracy_m ?? null, p.speed_cms ?? null, hash)
        .run();
    } catch (e) {
      // A re-ingest at the SAME PK with DIFFERENT data trips positions_guard_ins (RAISE(ABORT)). The row
      // is NOT rewritten — integrity holds, which is the guard's whole job. But this is a CLIENT conflict,
      // not a server fault: report 400, never a 500. A 500 would make a client retry forever and pollute
      // the unhandled-error alarm Watchtower will page on. There is no 409 code in errors.ts (adding one
      // is a register amendment), so VALIDATION_FAILED/400 is the register-legal choice. An unrelated DB
      // fault (no SQLITE_CONSTRAINT / I3 marker) still rethrows as a genuine INTERNAL 500.
      const msg = e instanceof Error ? e.message : String(e);
      if (/SQLITE_CONSTRAINT|I3: append-only/i.test(msg)) {
        throw new ApiError("VALIDATION_FAILED", 400, "POSITION CONFLICT AT (shipment, device, ts) WITH DIFFERENT DATA");
      }
      throw e;
    }

    return c.json({ ok: true, hash }, 201);
  });
}
