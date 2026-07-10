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
  it("a genuine signature still verifies true (happy path preserved)", async () => {
    const pair = await p256();
    const e = eventFixture("pod.signed");
    const sig = await signEvent(e, pair.privateKey);
    await expect(verifyEventSig({ ...e, sig }, await pubJwkOf(pair))).resolves.toBe(true);
  });
});
