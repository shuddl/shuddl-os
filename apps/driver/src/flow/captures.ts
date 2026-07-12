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
// flow. The continuous 30s-cadence position.updated emitter (the "GPS 30s moving" half → the live map dot) is
// a FOLLOW-UP: the payload contract exists (PositionUpdatedPayload) but no background cadence loop ships in WP-05.
// REQ-070 (battery/data budget — [CONFIRM]/pilot): the <5%/day-at-30s budget is a FIELD MEASUREMENT on a real
// device, not a CI claim; its intended mechanism is that same 30s position cadence (the follow-up emitter),
// whose power/data cost is measured at pilot.
const MOCK_GEO = { lat_e6: 45_523_100, lon_e6: -122_676_500, accuracy_m: 5 } as const;
const DRIVER_USER = "u:driver";
const SHIPPER_PARTY = "p:shipper";
const CARRIER_PARTY = "p:carrier";

export interface CaptureContext {
  readonly shipmentId: string;
  readonly ts: number;
  /** Evidence bytes for the current step (a photo frame or signature strokes), when applicable. */
  readonly bytes?: Uint8Array;
  /** The placed-freight photo hash, threaded from photo_placed → delivered's delivery.evidenced. */
  readonly placedPhotoHash?: string;
}

type Base = Pick<CaptureParams, "shipment_id" | "ts">;

/** The event(s) a completed step emits, in capture order. Empty when a step has no artifact to persist yet. */
export function capturesForStep(kind: StopKind, stepId: StepId, ctx: CaptureContext): CaptureParams[] {
  const base: Base = { shipment_id: ctx.shipmentId, ts: ctx.ts };

  switch (stepId) {
    case "arrive": {
      // Consent-before-first-GPS (REQ-166) is enforced PER STREAM, so EVERY stop — pickup and delivery
      // alike — emits the consent doc (derived from the session ack) BEFORE its `stop.arrived`. The
      // first (pickup) stop of the day would otherwise 403 ["consent"] the moment sync lands (Task 9).
      const consent: CaptureParams = { ...base, kind: "document.attached", payload: consentAckPayload() };
      const arrived: CaptureParams = { ...base, kind: "stop.arrived", payload: { geo: MOCK_GEO, auto: false } };
      return [consent, arrived];
    }
    case "count":
      return [{ ...base, kind: "freight.counted", payload: { pieces: 6 } }];
    case "photo_freight":
      return [freightPhoto(base, "freight", ctx.bytes)];
    case "dims":
      return [{ ...base, kind: "dims.captured", payload: { l_in: 48, w_in: 40, h_in: 36, pieces: 6, method: "manual" } }];
    case "sign":
      if (kind === "pickup") {
        return [{
          ...base,
          kind: "custody.transferred",
          actor_user: DRIVER_USER,
          payload: { from_party: SHIPPER_PARTY, to_party: CARRIER_PARTY, geo: MOCK_GEO },
        }];
      }
      return [podSigned(base, ctx.bytes)];
    case "photo_placed":
      return [freightPhoto(base, "placed", ctx.bytes)];
    case "depart":
      return [{ ...base, kind: "stop.departed", payload: { geo: MOCK_GEO, auto: false, out_for_delivery: true } }];
    case "delivered":
      // The gated transition. Reuses the placed photo hash captured at photo_placed (delivery.evidenced
      // requires it). If somehow absent, emit nothing rather than a schema-invalid event.
      return ctx.placedPhotoHash
        ? [{ ...base, kind: "delivery.evidenced", payload: { placed_photo_hash: ctx.placedPhotoHash, geo: MOCK_GEO } }]
        : [];
  }
}

function freightPhoto(base: Base, photo_kind: "freight" | "placed", bytes?: Uint8Array): CaptureParams {
  const params: CaptureParams = { ...base, kind: "freight.photographed", payload: { photo_kind } };
  return bytes ? { ...params, evidence: { bytes, field: "photo_hash" } } : params;
}

function podSigned(base: Base, bytes?: Uint8Array): CaptureParams {
  const params: CaptureParams = { ...base, kind: "pod.signed", actor_user: DRIVER_USER, payload: { geo: MOCK_GEO } };
  return bytes ? { ...params, evidence: { bytes, field: "signature_hash" } } : params;
}
