// reference-predicates.ts — the SINGLE shared authority the sequencer DO and every bypass route call,
// so a gated fact's authorization cannot drift between the two paths (REQ-030 gate parity).
//
// These signatures FACTOR OUT the checks already inlined at:
//   - events.ts:167-173      driver-assignment (json_extract status_cache '$.assigned_driver')
//   - sequencer.ts:518-532   device ownership (users.device_keys[] on the registering user)
//   - sequencer.ts:441       consent-before-GPS (assertConsentBeforeGps + deriveOperatingState)
// Move the bodies here; have BOTH call sites import them. A route that persists a gated fact then
// cannot silently omit a check the DO performs (the positions.ts RED).

import type { LedgerEvent } from "@shuddl/contracts";

/**
 * REQ-030 — a driver may write to a shipment ONLY if the status-cache projection has assigned it to
 * them. Client shipment_id is untrusted until this passes. Mirrors events.ts:167-173 exactly; ops/admin
 * are unrestricted (check role at the call site, as events.ts does).
 */
export async function assignmentOf(db: D1Database, shipmentId: string, driverSub: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT json_extract(status_cache,'$.assigned_driver') AS d FROM shipments WHERE id = ?")
    .bind(shipmentId)
    .first<{ d: string | null }>();
  return !!row && row.d === driverSub;
}

/**
 * REQ-011/016 — a device_id supplied by a client is untrusted until it is a device REGISTERED to the
 * authenticated principal on the control plane (users.device_keys[]). The DO goes further and verifies
 * the event SIGNATURE (sequencer.ts:237-256); a bypass route that stores no signed envelope (positions)
 * at minimum proves ownership so a driver cannot post under a victim's device_id. Returns false, never
 * throws (mirror verifyEventSig discipline).
 */
export async function deviceOwnedBy(
  env: { CONTROL_DB: D1Database },
  tenant: string,
  deviceId: string,
  ownerSub: string,
): Promise<boolean> {
  const row = await env.CONTROL_DB
    .prepare(
      "SELECT 1 AS ok FROM users u, json_each(u.device_keys) je " +
        "WHERE u.tenant_id = (SELECT id FROM tenants WHERE slug = ?1) " +
        "AND u.sub = ?2 AND json_extract(je.value,'$.device_id') = ?3 LIMIT 1",
    )
    .bind(tenant, ownerSub, deviceId)
    .first<{ ok: number }>();
  return row !== null;
}

/**
 * REQ-166 — consent-before-first-GPS. The pure gate lives at
 * packages/ledger/src/gates/transition-gates.ts:330 (assertConsentBeforeGps). The IMPURE half — reading
 * the prior stream and deriving the operating state from the stamp's own coords — is what a bypass route
 * must replicate. `deriveOperatingState` (packages/ledger/src/geo/jurisdiction.ts) runs SERVER-SIDE over
 * incoming.geo; the client supplies geo, the server decides the jurisdiction. Fail-closed: an unknown
 * jurisdiction (UNKNOWN_JURISDICTION "XX") blocks regardless of any consent on the stream.
 */
export async function streamPrior(db: D1Database, shipmentId: string): Promise<readonly LedgerEvent[]> {
  // Same read the DO uses at sequencer.ts:398-406 (SELECT * ... ORDER BY seq, rowToEvent). Reuse
  // rowToEvent so the shape matches what the pure gate expects.
  throw new Error("bind rowToEvent from @shuddl/ledger/lens — see sequencer.ts:398-406");
}
