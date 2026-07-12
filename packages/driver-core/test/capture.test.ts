import { describe, expect, it } from "vitest";
import { EventInput } from "@shuddl/contracts";
import { verifyEventSig } from "@shuddl/ledger/sign";
import { generateDeviceKey } from "../src/device-key.js";
import { capture, type DeviceContext } from "../src/capture.js";

// SHA-256("abc") — a known answer, computed independently of the code under test.
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const GEO = { lat_e6: 37_421_000, lon_e6: -122_084_000 };

function seqCounter(start = 0): () => number {
  let n = start;
  return () => n++;
}

async function deviceCtx(): Promise<{ ctx: DeviceContext; publicJwk: JsonWebKey; device_id: string }> {
  const dk = await generateDeviceKey();
  return {
    ctx: { device_id: dk.device_id, privateKey: dk.keyPair.privateKey, party: "party-carrier", nextSeq: seqCounter() },
    publicJwk: dk.publicJwk,
    device_id: dk.device_id,
  };
}

describe("device-key (REQ-013/016)", () => {
  it("mints a P-256 keypair with an exported public JWK and a stable derived device_id", async () => {
    const dk = await generateDeviceKey();
    expect(dk.keyPair.privateKey.type).toBe("private");
    expect(dk.keyPair.publicKey.type).toBe("public");
    expect(dk.publicJwk.kty).toBe("EC");
    expect(dk.publicJwk.crv).toBe("P-256");
    expect(dk.device_id).toMatch(/^dev_[0-9a-f]{64}$/);
  });

  it("distinct keys yield distinct device_ids", async () => {
    const a = await generateDeviceKey();
    const b = await generateDeviceKey();
    expect(a.device_id).not.toBe(b.device_id);
  });
});

describe("capture — signature round-trip (REQ-013/016)", () => {
  it("a captured pod.signed event VERIFIES via verifyEventSig against the device public JWK", async () => {
    const { ctx, publicJwk } = await deviceCtx();
    const bytes = new TextEncoder().encode("wet-ink-signature-pixels");
    const { event } = await capture(
      { shipment_id: "shp-1", kind: "pod.signed", payload: { geo: GEO }, actor_party: "party-carrier", ts: 1_720_000_000_000, evidence: { bytes, field: "signature_hash" } },
      ctx,
    );
    expect(event.sig).toBeDefined();
    // The proof: the offline device signature is valid for the sequencer's public-key check.
    expect(await verifyEventSig(event, publicJwk)).toBe(true);
    // I4: a custody/pod event carries the co-signing device.
    expect(event.actor.device).toBe(ctx.device_id);
  });

  it("tampering with any signed field (ts) breaks verification", async () => {
    const { ctx, publicJwk } = await deviceCtx();
    const { event } = await capture(
      { kind: "position.updated", payload: { lat_e6: GEO.lat_e6, lon_e6: GEO.lon_e6 }, actor_party: "party-carrier", ts: 1_720_000_000_000 },
      ctx,
    );
    expect(await verifyEventSig(event, publicJwk)).toBe(true);
    // ts is inside the frozen clientView — bumping it must invalidate the signature.
    expect(await verifyEventSig({ ...event, ts: event.ts + 1 }, publicJwk)).toBe(false);
  });

  it("tampering with device_seq breaks verification — the merge dedup key is signature-protected (REQ-016 crux)", async () => {
    const { ctx, publicJwk } = await deviceCtx();
    const { event } = await capture(
      { kind: "freight.counted", payload: { pieces: 1 }, actor_party: "p", ts: 1_720_000_000_000 },
      ctx,
    );
    expect(await verifyEventSig(event, publicJwk)).toBe(true);
    // device_seq is in the frozen clientView, so a replay under a different (device, seq) key can't be forged.
    expect(await verifyEventSig({ ...event, device_seq: (event.device_seq ?? 0) + 1 }, publicJwk)).toBe(false);
  });

  it("a wrong device public key fails verification", async () => {
    const { ctx } = await deviceCtx();
    const other = await generateDeviceKey();
    const { event } = await capture(
      { kind: "position.updated", payload: { lat_e6: 1, lon_e6: 2 }, actor_party: "p", ts: 1_720_000_000_000 },
      ctx,
    );
    expect(await verifyEventSig(event, other.publicJwk)).toBe(false);
  });
});

describe("capture — evidence hashed AT CAPTURE, bytes deferred (REQ-017)", () => {
  it("writes the 64-hex SHA-256 of the bytes into payload[field] and defers the ORIGINAL bytes", async () => {
    const { ctx } = await deviceCtx();
    const bytes = new TextEncoder().encode("abc"); // known answer
    const { event, deferred } = await capture(
      { kind: "freight.photographed", payload: { photo_kind: "freight" }, actor_party: "party-carrier", ts: 1_720_000_000_000, evidence: { bytes, field: "photo_hash" } },
      ctx,
    );
    // The event carries ONLY the hash.
    if (event.kind !== "freight.photographed") throw new Error("wrong kind");
    expect(event.payload.photo_hash).toBe(SHA256_ABC);
    // The bytes are deferred for a LATER upload — same hash, and the ORIGINAL byte reference.
    expect(deferred).toBeDefined();
    expect(deferred?.hash).toBe(SHA256_ABC);
    expect(deferred?.bytes).toBe(bytes);
    expect(deferred?.field).toBe("photo_hash");
  });

  it("routes a placed_photo_hash into delivery.evidenced", async () => {
    const { ctx } = await deviceCtx();
    const bytes = new TextEncoder().encode("abc");
    const { event, deferred } = await capture(
      { kind: "delivery.evidenced", payload: { geo: GEO }, actor_party: "p", ts: 1_720_000_000_000, evidence: { bytes, field: "placed_photo_hash" } },
      ctx,
    );
    if (event.kind !== "delivery.evidenced") throw new Error("wrong kind");
    expect(event.payload.placed_photo_hash).toBe(SHA256_ABC);
    expect(deferred?.field).toBe("placed_photo_hash");
  });

  it("with NO evidence, returns no deferred and leaves the payload untouched", async () => {
    const { ctx } = await deviceCtx();
    const { event, deferred } = await capture(
      { kind: "stop.arrived", payload: { geo: GEO, auto: true }, actor_party: "p", ts: 1_720_000_000_000 },
      ctx,
    );
    expect(deferred).toBeUndefined();
    if (event.kind !== "stop.arrived") throw new Error("wrong kind");
    expect(event.payload.auto).toBe(true);
  });
});

describe("capture — device_seq + validation guardrails (REQ-016)", () => {
  it("stamps a per-device monotonic device_seq per call", async () => {
    const { ctx } = await deviceCtx();
    const a = await capture({ kind: "position.updated", payload: { lat_e6: 1, lon_e6: 2 }, actor_party: "p", ts: 1 }, ctx);
    const b = await capture({ kind: "position.updated", payload: { lat_e6: 1, lon_e6: 2 }, actor_party: "p", ts: 2 }, ctx);
    const c = await capture({ kind: "position.updated", payload: { lat_e6: 1, lon_e6: 2 }, actor_party: "p", ts: 3 }, ctx);
    expect([a.event.device_seq, b.event.device_seq, c.event.device_seq]).toEqual([0, 1, 2]);
  });

  it("rejects a kind/payload/field mismatch AND does not burn a device_seq (I-2b)", async () => {
    const dk = await generateDeviceKey();
    let seq = 0;
    const ctx: DeviceContext = { device_id: dk.device_id, privateKey: dk.keyPair.privateKey, party: "p", nextSeq: () => seq++ };
    const bytes = new TextEncoder().encode("abc");
    // pod.signed's payload has no photo_hash field — routing the hash there is a strict-parse violation.
    await expect(
      capture({ kind: "pod.signed", payload: { geo: GEO }, actor_party: "p", ts: 1, evidence: { bytes, field: "photo_hash" } }, ctx),
    ).rejects.toThrow();
    expect(seq).toBe(0); // the malformed capture consumed NO sequence number
    // the next, valid capture still gets seq 0 — the counter was never advanced by the bad call.
    const ok = await capture({ kind: "position.updated", payload: { lat_e6: 1, lon_e6: 2 }, actor_party: "p", ts: 2 }, ctx);
    expect(ok.event.device_seq).toBe(0);
  });

  it("produces an EventInput.parse-valid event and defaults captured_ts to ts", async () => {
    const { ctx } = await deviceCtx();
    const { event } = await capture({ kind: "freight.counted", payload: { pieces: 12 }, actor_party: "p", ts: 1_720_000_000_000 }, ctx);
    expect(() => EventInput.parse(event)).not.toThrow();
    expect(event.captured_ts).toBe(1_720_000_000_000);
    expect(event.source).toBe("native");
    expect(event.confidence).toBe(10_000);
    expect(event.device_id).toBe(ctx.device_id);
  });

  it("attributes actor.party to actor_party, falling back to the device's party", async () => {
    const { ctx } = await deviceCtx(); // device party = "party-carrier"
    const explicit = await capture({ kind: "freight.counted", payload: { pieces: 1 }, actor_party: "party-shipper", ts: 1 }, ctx);
    const fallback = await capture({ kind: "freight.counted", payload: { pieces: 1 }, ts: 2 }, ctx);
    expect(explicit.event.actor.party).toBe("party-shipper");
    expect(fallback.event.actor.party).toBe("party-carrier");
  });

  it("carries optional driver-user attribution (actor_user), signed", async () => {
    const { ctx, publicJwk } = await deviceCtx();
    const { event } = await capture({ kind: "freight.counted", payload: { pieces: 1 }, actor_party: "p", actor_user: "user-driver-7", ts: 1 }, ctx);
    expect(event.actor.user).toBe("user-driver-7");
    // actor is inside the frozen clientView, so user attribution rides the signature.
    expect(await verifyEventSig(event, publicJwk)).toBe(true);
  });
});
