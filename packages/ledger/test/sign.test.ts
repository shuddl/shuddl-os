import { describe, expect, it } from "vitest";
import { signEvent, verifyEventSig, clientView } from "../src/sign.js";
import { eventFixture } from "@shuddl/contracts";

async function p256(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
}
async function pubJwkOf(pair: CryptoKeyPair): Promise<JsonWebKey> {
  return (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
}

describe("REQ-016 / I4: P-256 device signatures over the offline clientView", () => {
  it("signs a pod.signed clientView and verifies it", async () => {
    const pair = await p256();
    const jwk = await pubJwkOf(pair);
    const e = eventFixture("pod.signed");
    const sig = await signEvent(e, pair.privateKey);
    expect(await verifyEventSig({ ...e, sig }, jwk)).toBe(true);
  });

  // §1197 — EVERY signed field, not just one. REQ-016/I4.
  //
  // The suite pinned two halves and left the join between them open. `clientView is the frozen offline field
  // set` pins the ten field NAMES; the test below pins tamper-detection for exactly ONE of them (`ts`). Neither
  // pins that the signature covers each field's VALUE — and that is a different property, because sign and
  // verify BOTH go through `clientView`. If it returned a constant for a field, the two sides would still
  // agree, verification would still pass, and the real field would be unprotected.
  //
  // MEASURED at §1197: replacing `payload` with `{}` (or `evidence` with `[]`) inside clientView left
  // **749 tests green** — the whole ledger package plus every workers/api suite that uses signEvent. A device
  // signature that covers a constant instead of the freight it attests is exactly the forgery I4 exists to
  // prevent, and nothing in the tree objected.
  //
  // The list pin cannot see this (the key is still there) and the single-field tamper test cannot either
  // (it varies `ts`). So: tamper EACH field, with a type-appropriate change, and require a false verdict.
  const TAMPERS: ReadonlyArray<readonly [string, (e: Record<string, unknown>) => Record<string, unknown>]> = [
    ["id", (e) => ({ ...e, id: "00000000-0000-4000-8000-0000000000ff" })],
    ["shipment_id", (e) => ({ ...e, shipment_id: `${String(e["shipment_id"])}-x` })],
    ["kind", (e) => ({ ...e, kind: "delivery.evidenced" })],
    ["payload", (e) => ({ ...e, payload: { ...(e["payload"] as Record<string, unknown>), tampered: true } })],
    ["evidence", (e) => ({ ...e, evidence: [...(e["evidence"] as unknown[]), { kind: "doc", id: "forged" }] })],
    ["actor", (e) => ({ ...e, actor: { ...(e["actor"] as Record<string, unknown>), party: "party-attacker" } })],
    ["ts", (e) => ({ ...e, ts: (e["ts"] as number) + 1 })],
    ["device_id", (e) => ({ ...e, device_id: "dev-attacker" })],
    ["device_seq", (e) => ({ ...e, device_seq: ((e["device_seq"] as number | undefined) ?? 0) + 1 })],
    ["captured_ts", (e) => ({ ...e, captured_ts: ((e["captured_ts"] as number | undefined) ?? 0) + 1 })],
  ];

  it("§1197: tampering with ANY signed field breaks verification — every field, not just ts", async () => {
    const pair = await p256();
    const jwk = await pubJwkOf(pair);
    // A device-namespaced fixture, so device_id/device_seq/captured_ts carry real values to tamper with.
    const base = { ...eventFixture("pod.signed"), device_id: "dev-1", device_seq: 7, captured_ts: 1_720_000_000_123 };
    const sig = await signEvent(base, pair.privateKey);
    expect(await verifyEventSig({ ...base, sig }, jwk), "premise: the untampered event verifies").toBe(true);

    const accepted: string[] = [];
    for (const [field, tamper] of TAMPERS) {
      const forged = { ...(tamper(base as unknown as Record<string, unknown>) as unknown as typeof base), sig };
      if (await verifyEventSig(forged, jwk)) accepted.push(field);
    }
    expect(
      accepted,
      "a tampered field verified as authentic. The signature does not cover it — which means clientView is " +
        "signing something other than this field's real value, and a forged event carrying it would pass the " +
        "sequencer's signature gate (REQ-016/I4):",
    ).toEqual([]);
  });

  it("any change to a signed field breaks verification", async () => {
    const pair = await p256();
    const jwk = await pubJwkOf(pair);
    const e = eventFixture("pod.signed");
    const sig = await signEvent(e, pair.privateKey);
    // ts is part of the clientView — bumping one byte must invalidate the signature.
    expect(await verifyEventSig({ ...e, sig, ts: e.ts + 1 }, jwk)).toBe(false);
  });

  it("a wrong public key fails verification", async () => {
    const signer = await p256();
    const other = await p256();
    const e = eventFixture("custody.transferred");
    const sig = await signEvent(e, signer.privateKey);
    expect(await verifyEventSig({ ...e, sig }, await pubJwkOf(other))).toBe(false);
  });

  it("a server-actor event carries no sig; verify returns false", async () => {
    const pair = await p256();
    const e = eventFixture("agent.acted"); // server actor: no device, no sig
    expect(e.sig).toBeUndefined();
    expect(await verifyEventSig(e, await pubJwkOf(pair))).toBe(false);
  });

  it("the signature is base64url (no +, /, =) and clientView is the frozen offline field set", async () => {
    const pair = await p256();
    const e = eventFixture("pod.signed");
    const sig = await signEvent(e, pair.privateKey);
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Object.keys(clientView(e)).sort()).toEqual([
      "actor", "captured_ts", "device_id", "device_seq", "evidence", "id", "kind", "payload", "shipment_id", "ts",
    ]);
  });
});

// REQ-133/REQ-011/REQ-002: the sequencer DO (Task 13) feeds device- and portal-controlled
// `sig` strings straight into verifyEventSig. A forged/garbage signature must be a clean
// `false` (→ 401), never an uncaught throw (→ 500). A rejected promise is a failing test.
describe("hardening: a malformed signature rejects cleanly, never throws", () => {
  it("non-base64url garbage → false (atob would otherwise throw InvalidCharacterError)", async () => {
    const pair = await p256();
    const e = eventFixture("pod.signed");
    await expect(verifyEventSig({ ...e, sig: "!!!not-base64!!!" }, await pubJwkOf(pair))).resolves.toBe(false);
  });
  it("a wrong-length but valid-base64url signature → false (WebCrypto verify would throw)", async () => {
    const pair = await p256();
    const e = eventFixture("pod.signed");
    // "AAAA" is valid base64url but decodes to 3 bytes; a P-256 sig is 64 raw bytes.
    await expect(verifyEventSig({ ...e, sig: "AAAA" }, await pubJwkOf(pair))).resolves.toBe(false);
  });
  it("an empty signature → false", async () => {
    const pair = await p256();
    const e = eventFixture("pod.signed");
    await expect(verifyEventSig({ ...e, sig: "" }, await pubJwkOf(pair))).resolves.toBe(false);
  });
  // §1281 — THE FAIL-CLOSED CATCH ITSELF. The two cases above (non-base64url garbage, wrong-length signature)
  // assert the OUTCOME `false`, and BOTH the charset guard and the catch produce `false` — so neither case can
  // tell them apart. Measured: dropping the charset guard, dropping the `return await`, and flipping the catch
  // to `return true` (a total AUTH BYPASS) each left every owning suite GREEN — packages/ledger 17/17,
  // workers/api 27/27, driver-core 14/14.
  //
  // The reason is that no input in the suite ever FAULTS. Garbage is stopped by the charset guard before the
  // try; a wrong-length signature makes WebCrypto's verify resolve false rather than throw here. The one
  // reachable fault is a MALFORMED PUBLIC KEY — a corrupted `device_keys` entry — where `importKey` rejects.
  // That is the input that reaches the catch, and it is the input that distinguishes fail-closed from
  // fail-open: with `catch { return true }`, a device whose stored key is corrupt verifies EVERY signature.
  it("§1281: a MALFORMED public JWK → false, never a throw and never true (the catch is fail-CLOSED)", async () => {
    const pair = await p256();
    const e = eventFixture("pod.signed");
    const sig = await signEvent(e, pair.privateKey); // a genuine signature…
    const brokenJwk = { kty: "EC", crv: "P-256", x: "not-a-coordinate", y: "also-not" } as JsonWebKey;
    // …against a key that cannot be imported. The only honest answer is false.
    await expect(verifyEventSig({ ...e, sig }, brokenJwk)).resolves.toBe(false);
  });

  it("§1281: an EMPTY JWK object → false (importKey rejects; still no throw, still not true)", async () => {
    const pair = await p256();
    const e = eventFixture("pod.signed");
    const sig = await signEvent(e, pair.privateKey);
    await expect(verifyEventSig({ ...e, sig }, {} as JsonWebKey)).resolves.toBe(false);
  });

  it("a genuine signature still verifies true (happy path preserved)", async () => {
    const pair = await p256();
    const e = eventFixture("pod.signed");
    const sig = await signEvent(e, pair.privateKey);
    await expect(verifyEventSig({ ...e, sig }, await pubJwkOf(pair))).resolves.toBe(true);
  });
});
