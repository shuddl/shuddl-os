// Maps each completed flow step to the signed event(s) the device captures offline. Kept beside the
// pure state machine but IMPURE by nature (it builds real event payloads). Payloads mirror the doc-10
// schemas exactly so `capture` → `EventInput.parse` never throws; evidence-bearing steps route their
// bytes through `capture`'s evidence path (hash-at-capture, REQ-017). GPS is a fixed mock stamp here —
// a real device reads hardware GPS; the microdegree integers keep it a valid GeoStamp either way.
import type { CaptureParams } from "@shuddl/driver-core";
import { consentAckPayload } from "../session.js";
import type { StepId, StopKind } from "./stop-flow.js";

// REQ-071 (positions v1 — gate-stamp half BUILT): "positions v1 = driver GPS 30s moving + gate stamps". The
// GATE STAMPS (stop.arrived / stop.departed, each carrying a GeoStamp below) are emitted here as part of the
// flow. Task 11 removes the hardcoded MOCK_GEO: the geo comes from the foreground `watchPosition` reader in
// GatedFlow (a real device fix), threaded in as `ctx.geo`. A GPS step is only reached with a fresh permitted
// fix (GatedFlow gates it behind an explicit permission/stale screen), so `ctx.geo` is present in production;
// absence never fabricates a coordinate — a GPS payload with no geo fails capture (EventInput.parse), which
// GatedFlow surfaces rather than enqueuing a fake stamp. The continuous 30s position.updated cadence (the live
// map dot) remains a follow-up. REQ-070 battery/data budget stays a [CONFIRM]/pilot FIELD measurement.
// 2026-08-01 convergence audit — the fabrication constants (u:driver / p:shipper / p:carrier and the
// hardcoded pieces/dims) are GONE. Every physical fact in a capture now arrives through CaptureContext
// or the capture THROWS (surfaced by GatedFlow's capture-error path), exactly the rule Task 11
// established for GPS: absence never fabricates. The driver principal is the manifest's authenticated
// driver_id; the custody party pair rides the REQ-069/REQ-190 identity work and is a ledgered
// pre-pilot hold until the manifest carries real parties.

/** A device GPS fix (integer microdegrees, canonical law) — the geo stamped into a GPS-bearing capture. */
export interface GeoFix {
  readonly lat_e6: number;
  readonly lon_e6: number;
  readonly accuracy_m?: number;
}

export interface CaptureContext {
  readonly shipmentId: string;
  readonly ts: number;
  /** The current foreground GPS fix, threaded from GatedFlow's watchPosition reader (Task 11). */
  readonly geo?: GeoFix;
  /** Evidence bytes for the current step (a photo frame or signature strokes), when applicable. */
  readonly bytes?: Uint8Array;
  /** The placed-freight photo hash, threaded from photo_placed → delivered's delivery.evidenced. */
  readonly placedPhotoHash?: string;
  /** The REAL piece count the driver entered on the count step. Absent ⇒ the capture throws. */
  readonly pieces?: number;
  /** Real measured dims for a dims-required lane (V2-flagged; unreachable in V1). Absent ⇒ throws. */
  readonly dims?: { readonly l_in: number; readonly w_in: number; readonly h_in: number; readonly pieces: number };
  /** The AUTHENTICATED driver principal (DriverManifest.driver_id) — the actor_user on custody/POD. */
  readonly driverUserId?: string;
  /** The shipment's REAL custody pair for a pickup handoff. Absent ⇒ throws (ledgered REQ-069 hold). */
  readonly custodyParties?: { readonly from: string; readonly to: string };
}

/** Fail-closed input read: a physical fact that was not really captured is never fabricated. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`CAPTURE_INPUT_MISSING: ${what} was not captured — refusing to record a fabricated fact`);
  return value;
}

type Base = Pick<CaptureParams, "shipment_id" | "ts">;

/** The event(s) a completed step emits, in capture order. Empty when a step has no artifact to persist yet. */
export function capturesForStep(kind: StopKind, stepId: StepId, ctx: CaptureContext): CaptureParams[] {
  const base: Base = { shipment_id: ctx.shipmentId, ts: ctx.ts };
  const geo = ctx.geo; // a real device fix (present when a GPS step is reached); never a mock

  switch (stepId) {
    case "arrive": {
      // Consent-before-first-GPS (REQ-166) is enforced PER STREAM, so EVERY stop — pickup and delivery
      // alike — emits the consent doc (derived from the session ack) BEFORE its `stop.arrived`. The
      // first (pickup) stop of the day would otherwise 403 ["consent"] the moment sync lands (Task 9).
      const consent: CaptureParams = { ...base, kind: "document.attached", payload: consentAckPayload() };
      const arrived: CaptureParams = { ...base, kind: "stop.arrived", payload: { geo, auto: false } };
      return [consent, arrived];
    }
    case "count":
      // The REAL entered count — never a constant (the audit found a hardcoded 6 recorded on every pickup).
      return [{ ...base, kind: "freight.counted", payload: { pieces: required(ctx.pieces, "the piece count") } }];
    case "photo_freight":
      return [freightPhoto(base, "freight", ctx.bytes)];
    case "dims": {
      const d = required(ctx.dims, "measured dims");
      return [{ ...base, kind: "dims.captured", payload: { l_in: d.l_in, w_in: d.w_in, h_in: d.h_in, pieces: d.pieces, method: "manual" } }];
    }
    case "sign":
      if (kind === "pickup") {
        const parties = required(ctx.custodyParties, "the custody party pair");
        return [{
          ...base,
          kind: "custody.transferred",
          actor_user: required(ctx.driverUserId, "the authenticated driver id"),
          payload: { from_party: parties.from, to_party: parties.to, geo },
        }];
      }
      return [podSigned(base, geo, ctx.bytes, required(ctx.driverUserId, "the authenticated driver id"))];
    case "photo_placed":
      return [freightPhoto(base, "placed", ctx.bytes)];
    case "depart":
      return [{ ...base, kind: "stop.departed", payload: { geo, auto: false, out_for_delivery: true } }];
    case "delivered":
      // The gated transition. Reuses the placed photo hash captured at photo_placed (delivery.evidenced
      // requires it). If somehow absent, emit nothing rather than a schema-invalid event.
      return ctx.placedPhotoHash
        ? [{ ...base, kind: "delivery.evidenced", payload: { placed_photo_hash: ctx.placedPhotoHash, geo } }]
        : [];
  }
}

function freightPhoto(base: Base, photo_kind: "freight" | "placed", bytes?: Uint8Array): CaptureParams {
  const params: CaptureParams = { ...base, kind: "freight.photographed", payload: { photo_kind } };
  return bytes ? { ...params, evidence: { bytes, field: "photo_hash" } } : params;
}

function podSigned(base: Base, geo: GeoFix | undefined, bytes: Uint8Array | undefined, driverUserId: string): CaptureParams {
  const params: CaptureParams = { ...base, kind: "pod.signed", actor_user: driverUserId, payload: { geo } };
  return bytes ? { ...params, evidence: { bytes, field: "signature_hash" } } : params;
}
