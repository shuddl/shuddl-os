import type { LedgerEvent } from "@shuddl/contracts";
import { rowToEvent } from "@shuddl/ledger/lens";
import { assertConsentBeforeGps } from "@shuddl/ledger/gates/transition-gates";
import { deriveOperatingState } from "@shuddl/ledger/geo/jurisdiction";

// REQ-030 / REQ-166 / REQ-190 — the SINGLE shared authority the events route AND the positions bypass
// route call for a driver/GPS write, so a gated physical fact's authorization cannot DRIFT between a
// path that goes through the sequencer DO and a path (positions) that BYPASSES it. The 2026-07-15 audit
// (C-1) found the positions bypass shipped the fast path and dropped every one of these checks while the
// sequencer's stop.arrived path enforced all three (assignment via the events route, device via the DO's
// signature verify, consent via assertConsentBeforeGps). See .claude/skills/enforce-server-side-gate-parity.

/**
 * REQ-030 — a driver may write to a shipment ONLY if the status-cache projection has assigned it to
 * them. The client-supplied shipment_id is UNTRUSTED until this passes. Byte-identical to the query the
 * events route uses for its driver write-scope (workers/api/src/routes/events.ts); ops/admin are
 * unrestricted, so the caller checks `role === "driver"` before calling this. `assigned_driver` is
 * compared to the AUTHENTICATED principal (session.sub → users.id), never a client field.
 */
export async function assignmentOf(db: D1Database, shipmentId: string, driverSub: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT json_extract(status_cache,'$.assigned_driver') AS d FROM shipments WHERE id = ?")
    .bind(shipmentId)
    .first<{ d: string | null }>();
  return !!row && row.d === driverSub;
}

/**
 * REQ-011/016/166 — a `device_id` supplied by a client is UNTRUSTED until it is a device REGISTERED to
 * the authenticated principal on the control plane (users.device_keys[]). The sequencer DO goes further
 * and verifies the event SIGNATURE (sequencer.ts #deviceKey + verifyEventSig); a raw position carries no
 * signed envelope, so the bypass route at MINIMUM proves ownership — a driver cannot post GPS under a
 * victim's device_id. The `sub`/user id join is on `users.id` (the JWT `sub` IS the user id; there is no
 * separate `sub` column) so an ops/admin device registered to a DIFFERENT user does not satisfy it.
 * Returns false, never throws (mirrors verifyEventSig's fail-closed discipline).
 */
export async function deviceOwnedBy(control: D1Database, tenant: string, deviceId: string, ownerSub: string): Promise<boolean> {
  const row = await control
    .prepare(
      "SELECT 1 AS ok FROM users u, json_each(u.device_keys) je " +
        "WHERE u.tenant_id = (SELECT id FROM tenants WHERE slug = ?1) " +
        "AND u.id = ?2 AND json_extract(je.value,'$.device_id') = ?3 LIMIT 1",
    )
    .bind(tenant, ownerSub, deviceId)
    .first<{ ok: number }>();
  return row !== null;
}

/**
 * The prior events on a shipment stream, loaded SERVER-SIDE for the consent gate. Byte-identical to the
 * read the sequencer DO uses for its own `prior()` (sequencer.ts #enforceTransitionGate: `SELECT * ...
 * ORDER BY seq`, then rowToEvent) so the pure gate sees the SAME shape on both paths. positions bypass
 * the DO, so the "prior consent context" is loaded here from D1 directly — the events table for the
 * stream — NOT from the DO.
 */
export async function loadStreamPrior(db: D1Database, shipmentId: string): Promise<readonly LedgerEvent[]> {
  const rows = await db
    .prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq")
    .bind(`s:${shipmentId}`)
    .all<Record<string, string | number | null>>();
  return rows.results.map((r) => rowToEvent(r));
}

/**
 * REQ-166 — consent-before-first-GPS for a raw position ping. Runs EXACTLY what the sequencer runs for a
 * `stop.arrived`: `deriveOperatingState` over the stamp's OWN coordinates (SERVER-SIDE — the client
 * supplies geo, the server decides the jurisdiction), then the pure `assertConsentBeforeGps` gate over
 * the prior stream. Positions carry no LedgerEvent envelope, but the pure gate reads only `incoming.kind`
 * to scope itself to GPS stamps, so a minimal `position.updated` stamp is handed to it — the same kind
 * the DO's GATED_KINDS comment names as "owned by the positions bypass route, which must enforce the
 * same consent gate". Throws GateError (→ GATE_BLOCKED) when no matching consent is on the stream, or an
 * unknown jurisdiction ("XX", fail-closed); GateValidationError (→ VALIDATION_FAILED) on a blank state.
 * The consent gate is NON-overridable — it is a legal precondition, not a waivable evidence requirement.
 */
export function assertPositionConsent(prior: readonly LedgerEvent[], coords: { lat_e6: number; lon_e6: number }): void {
  const operating_state = deriveOperatingState({ lat_e6: coords.lat_e6, lon_e6: coords.lon_e6 });
  // The pure gate reads only `.kind` off `incoming` (it scopes to position.updated/stop.arrived); this is
  // the position analog of the DO handing it the real event. Cast is safe by inspection of the gate body.
  assertConsentBeforeGps(prior, { kind: "position.updated" } as LedgerEvent, { operating_state });
}
