import { describe, expect, it } from "vitest";
import {
  StopArrivedPayload,
  FreightCountedPayload,
  FreightPhotographedPayload,
  DimsCapturedPayload,
  SealAppliedPayload,
  StopDepartedPayload,
  OsdCapturedPayload,
  DeliveryEvidencedPayload,
  ConsentAck,
  JsonObject,
  LedgerEvent,
  EventInput,
  eventFixture,
} from "../src/index.js";

// A real 64-hex content hash (sha-256 of empty string) — evidence is hashed AT CAPTURE (REQ-017).
const HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const GEO = { lat_e6: 37_421_000, lon_e6: -122_084_000 };

// A minimal valid EventInput envelope (client-suppliable subset); payload/kind merged per case.
const INPUT_BASE = {
  id: "00000000-0000-4000-8000-0000000000aa",
  ts: 1_720_000_000_000,
  actor: { party: "party-carrier", device: "device-1" },
  party_refs: [] as string[],
  evidence: [] as never[],
  source: "native" as const,
  confidence: 10_000,
};

describe("REQ-063/017: stop.arrived payload = geo + auto", () => {
  it("accepts a geofence-triggered arrival", () => {
    expect(StopArrivedPayload.parse({ geo: GEO, auto: true }).auto).toBe(true);
  });
  it("rejects a non-integer geo (microdegrees are integers)", () => {
    expect(() => StopArrivedPayload.parse({ geo: { lat_e6: 37.5, lon_e6: -122 }, auto: true })).toThrow();
  });
  it("rejects a missing auto flag and unknown keys", () => {
    expect(() => StopArrivedPayload.parse({ geo: GEO })).toThrow();
    expect(() => StopArrivedPayload.parse({ geo: GEO, auto: true, extra: 1 })).toThrow();
  });
});

describe("REQ-063: freight.counted payload = pieces (+ optional expected)", () => {
  it("accepts pieces alone and pieces+expected", () => {
    expect(FreightCountedPayload.parse({ pieces: 12 }).pieces).toBe(12);
    expect(FreightCountedPayload.parse({ pieces: 12, expected: 14 }).expected).toBe(14);
  });
  it("rejects a negative or non-integer count", () => {
    expect(() => FreightCountedPayload.parse({ pieces: -1 })).toThrow();
    expect(() => FreightCountedPayload.parse({ pieces: 2.5 })).toThrow();
  });
  it("rejects a missing pieces count", () => {
    expect(() => FreightCountedPayload.parse({ expected: 3 })).toThrow();
  });
});

describe("REQ-017/063: freight.photographed payload = photo_hash + photo_kind", () => {
  it("accepts a hashed forced photo", () => {
    expect(FreightPhotographedPayload.parse({ photo_hash: HASH, photo_kind: "placed" }).photo_kind).toBe("placed");
  });
  it("rejects a non-64-hex photo_hash (bytes are hashed at capture, not carried)", () => {
    expect(() => FreightPhotographedPayload.parse({ photo_hash: "not-a-hash", photo_kind: "freight" })).toThrow();
    expect(() => FreightPhotographedPayload.parse({ photo_hash: HASH.toUpperCase(), photo_kind: "freight" })).toThrow();
  });
  it("rejects an unknown/dropped photo_kind and a missing hash", () => {
    expect(() => FreightPhotographedPayload.parse({ photo_hash: HASH, photo_kind: "selfie" })).toThrow();
    // "seal"/"exception" were dropped — seals ride seal.applied, OS&D rides osd.captured.
    expect(() => FreightPhotographedPayload.parse({ photo_hash: HASH, photo_kind: "seal" })).toThrow();
    expect(() => FreightPhotographedPayload.parse({ photo_kind: "freight" })).toThrow();
  });
});

describe("dims.captured payload = l/w/h + pieces + method", () => {
  it("accepts a camera measurement", () => {
    const p = DimsCapturedPayload.parse({ l_in: 48, w_in: 40, h_in: 60, pieces: 4, method: "camera" });
    expect(p.method).toBe("camera");
  });
  it("rejects negative/float dims, an unknown method, and a missing field", () => {
    expect(() => DimsCapturedPayload.parse({ l_in: -1, w_in: 40, h_in: 60, pieces: 4, method: "manual" })).toThrow();
    expect(() => DimsCapturedPayload.parse({ l_in: 48, w_in: 40.5, h_in: 60, pieces: 4, method: "manual" })).toThrow();
    expect(() => DimsCapturedPayload.parse({ l_in: 48, w_in: 40, h_in: 60, pieces: 4, method: "lidar" })).toThrow();
    expect(() => DimsCapturedPayload.parse({ l_in: 48, w_in: 40, h_in: 60, method: "manual" })).toThrow();
  });
  it("rejects a 0-inch linear dim (degenerate box), but allows pieces=0 (shortage)", () => {
    expect(() => DimsCapturedPayload.parse({ l_in: 0, w_in: 40, h_in: 60, pieces: 4, method: "camera" })).toThrow();
    expect(() => DimsCapturedPayload.parse({ l_in: 48, w_in: 0, h_in: 60, pieces: 4, method: "camera" })).toThrow();
    expect(() => DimsCapturedPayload.parse({ l_in: 48, w_in: 40, h_in: 0, pieces: 4, method: "camera" })).toThrow();
    expect(DimsCapturedPayload.parse({ l_in: 48, w_in: 40, h_in: 60, pieces: 0, method: "camera" }).pieces).toBe(0);
  });
});

describe("REQ-017: seal.applied payload = seal_id + photo_hash", () => {
  it("accepts a sealed trailer", () => {
    expect(SealAppliedPayload.parse({ seal_id: "SEAL-001", photo_hash: HASH }).seal_id).toBe("SEAL-001");
  });
  it("rejects an empty seal_id and a bad photo_hash", () => {
    expect(() => SealAppliedPayload.parse({ seal_id: "", photo_hash: HASH })).toThrow();
    expect(() => SealAppliedPayload.parse({ seal_id: "SEAL-001", photo_hash: "xyz" })).toThrow();
  });
});

describe("stop.departed payload = geo + auto (+ optional out_for_delivery)", () => {
  it("accepts a manual departure, with and without the OFD flag", () => {
    expect(StopDepartedPayload.parse({ geo: GEO, auto: false }).auto).toBe(false);
    // REQ-015: the driver PWA raises OFD by setting out_for_delivery on depart (status-cache reads it).
    expect(StopDepartedPayload.parse({ geo: GEO, auto: false, out_for_delivery: true }).out_for_delivery).toBe(true);
  });
  it("rejects a missing auto flag and a non-boolean OFD flag", () => {
    expect(() => StopDepartedPayload.parse({ geo: GEO })).toThrow();
    expect(() => StopDepartedPayload.parse({ geo: GEO, auto: false, out_for_delivery: "yes" })).toThrow();
  });
});

describe("osd.captured payload = photo_hash + reason_code (+ optional note)", () => {
  it("accepts an OS&D with and without a note", () => {
    expect(OsdCapturedPayload.parse({ photo_hash: HASH, reason_code: "damage" }).reason_code).toBe("damage");
    expect(OsdCapturedPayload.parse({ photo_hash: HASH, reason_code: "shortage", note: "2 short" }).note).toBe("2 short");
  });
  it("rejects an unknown reason_code and a bad photo_hash", () => {
    expect(() => OsdCapturedPayload.parse({ photo_hash: HASH, reason_code: "misloaded" })).toThrow();
    expect(() => OsdCapturedPayload.parse({ photo_hash: "nope", reason_code: "damage" })).toThrow();
  });
});

describe("REQ-063: delivery.evidenced payload = forced placed-photo hash + geo", () => {
  it("accepts the placed-freight evidence", () => {
    expect(DeliveryEvidencedPayload.parse({ placed_photo_hash: HASH, geo: GEO }).placed_photo_hash).toBe(HASH);
  });
  it("rejects a missing placed_photo_hash (the forced photo is untypassable)", () => {
    expect(() => DeliveryEvidencedPayload.parse({ geo: GEO })).toThrow();
  });
  it("rejects a non-integer geo", () => {
    expect(() => DeliveryEvidencedPayload.parse({ placed_photo_hash: HASH, geo: { lat_e6: 1.1, lon_e6: 2 } })).toThrow();
  });
});

describe("REQ-166: driver location-tracking consent rides document.attached (no 36th kind)", () => {
  const ack = { doc_kind: "consent", policy_version: "OR-2026-01", operating_state: "OR", acknowledged: true };
  it("accepts a well-formed consent acknowledgment", () => {
    expect(ConsentAck.parse(ack).acknowledged).toBe(true);
  });
  it("rejects a non-acknowledgment (acknowledged must be literally true)", () => {
    expect(() => ConsentAck.parse({ ...ack, acknowledged: false })).toThrow();
  });
  it("rejects a missing doc_kind / operating_state", () => {
    expect(() => ConsentAck.parse({ policy_version: "v1", operating_state: "OR", acknowledged: true })).toThrow();
    expect(() => ConsentAck.parse({ doc_kind: "consent", policy_version: "v1", acknowledged: true })).toThrow();
  });
  // WP-05 exit audit (REQ-166): the fail-closed sentinel "XX" (deriveOperatingState returns it for any
  // coordinate outside the known boxes) must NOT be a consentable state — otherwise ONE ack covers ~45
  // states. The form is pinned to exactly two uppercase letters, excluding "XX".
  it("rejects operating_state 'XX' (the unknown-jurisdiction sentinel)", () => {
    expect(() => ConsentAck.parse({ ...ack, operating_state: "XX" })).toThrow();
  });
  it("rejects a non-2-uppercase operating_state (lowercase / full name / wrong length)", () => {
    expect(() => ConsentAck.parse({ ...ack, operating_state: "or" })).toThrow();
    expect(() => ConsentAck.parse({ ...ack, operating_state: "Oregon" })).toThrow();
    expect(() => ConsentAck.parse({ ...ack, operating_state: "O" })).toThrow();
  });
  it("is a structural subset of the document.attached JsonObject payload (rides it unchanged)", () => {
    // The carrier stays document.attached (JsonObject); the gate validates its payload against ConsentAck.
    expect(JsonObject.parse(ack)).toEqual(ack);
    const carried = LedgerEvent.parse({ ...eventFixture("document.attached"), payload: ack });
    expect(ConsentAck.parse(carried.payload).operating_state).toBe("OR");
  });
});

describe("union wiring: kind narrows payload in both LedgerEvent and EventInput", () => {
  it("LedgerEvent.parse round-trips the shaped physical kinds", () => {
    for (const kind of ["freight.photographed", "delivery.evidenced", "stop.arrived"] as const) {
      const e = eventFixture(kind);
      expect(LedgerEvent.parse(e).kind).toBe(kind);
    }
  });
  it("LedgerEvent rejects a shaped kind carrying the wrong payload", () => {
    const e = eventFixture("delivery.evidenced");
    expect(() => LedgerEvent.parse({ ...e, payload: {} })).toThrow();
  });
  it("EventInput.parse accepts the shaped physical kinds", () => {
    expect(
      EventInput.parse({ ...INPUT_BASE, kind: "stop.arrived", payload: { geo: GEO, auto: true } }).kind,
    ).toBe("stop.arrived");
    expect(
      EventInput.parse({
        ...INPUT_BASE,
        kind: "freight.photographed",
        payload: { photo_hash: HASH, photo_kind: "freight" },
      }).kind,
    ).toBe("freight.photographed");
    expect(
      EventInput.parse({
        ...INPUT_BASE,
        kind: "delivery.evidenced",
        payload: { placed_photo_hash: HASH, geo: GEO },
      }).kind,
    ).toBe("delivery.evidenced");
  });
  it("EventInput rejects a shaped kind with junk payload", () => {
    expect(() =>
      EventInput.parse({ ...INPUT_BASE, kind: "delivery.evidenced", payload: { placed_photo_hash: "bad", geo: GEO } }),
    ).toThrow();
  });
});
