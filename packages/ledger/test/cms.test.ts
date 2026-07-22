import { beforeAll, describe, expect, it } from "vitest";
import { verifyTsaSignature } from "../src/tsa/cms.js";
import { assertGrantedReceipt, FakeTsaClient } from "../src/tsa/client.js";
import { buildGrantedTimeStampResp, parseTimeStampResp } from "../src/tsa/der.js";
import { bytesToHex } from "../src/merkle.js";
import {
  buildSignerCert,
  buildSignedGrantedResp,
  buildTestCa,
  generateEcKeyPair,
  generateRsaKeyPair,
  type TestKeyPair,
} from "./tsa-cms-fixtures.js";

// REQ-014 (WP-16) — CMS SignerInfo signature + X.509 cert-chain verification. Fixtures are SYNTHETIC:
// a self-generated test CA ("SHUDDL Test Root CA") + TSA signer, NOT any real authority (REQ-167 clean).
// A fixed genTime + fixed imprint keep the assertions deterministic; keys are minted once in beforeAll.

const IMPRINT = Uint8Array.from({ length: 32 }, (_, i) => (i + 1) & 0xff);
const NONCE = 0x1234;
const GEN_TIME = new Date("2026-07-10T00:00:00Z");
const WIDE = { notBefore: new Date("2026-01-01T00:00:00Z"), notAfter: new Date("2027-01-01T00:00:00Z") };
const CA_CN = "SHUDDL Test Root CA";
const SIGNER_CN = "SHUDDL Test TSA Signer";

let caKey: TestKeyPair;
let signerKey: TestKeyPair;
let rogueCaKey: TestKeyPair;
let caCertDer: Uint8Array;
let rogueCaCertDer: Uint8Array;
let signerCertValid: Uint8Array;

async function mkResp(over: {
  signerCertDer: Uint8Array;
  messageDigestOverride?: Uint8Array;
  tamperSignature?: boolean;
}): Promise<Uint8Array> {
  return buildSignedGrantedResp({
    imprint: IMPRINT,
    nonce: NONCE,
    genTime: GEN_TIME,
    signerKey: signerKey.privateKey,
    signerCn: SIGNER_CN,
    caCn: CA_CN,
    ...over,
  });
}

beforeAll(async () => {
  caKey = await generateRsaKeyPair();
  signerKey = await generateRsaKeyPair();
  rogueCaKey = await generateRsaKeyPair();
  caCertDer = await buildTestCa({ cn: CA_CN, keyPair: caKey, ...WIDE });
  rogueCaCertDer = await buildTestCa({ cn: "SHUDDL Test Rogue CA", keyPair: rogueCaKey, ...WIDE, serial: 9 });
  signerCertValid = await buildSignerCert({ cn: SIGNER_CN, caCn: CA_CN, signerSpki: signerKey.spki, caKey: caKey.privateKey, ...WIDE });
});

describe("REQ-014 — verifyTsaSignature: valid CMS-signed receipt", () => {
  it("verifies the SignerInfo signature + chain to the test CA, and surfaces the bound imprint", async () => {
    const resp = await mkResp({ signerCertDer: signerCertValid });

    // the protocol verify is UNCHANGED and still passes on the (now signed) response
    expect(() => assertGrantedReceipt(resp, IMPRINT, BigInt(NONCE))).not.toThrow();
    expect(parseTimeStampResp(resp).granted).toBe(true);

    const result = await verifyTsaSignature(resp, { trustAnchors: [caCertDer] });
    expect(result.verified).toBe(true);
    expect(result.reason).toBe("verified");
    expect(result.imprintDigestHex).toBe(bytesToHex(IMPRINT)); // the signed TSTInfo binds OUR imprint
    expect(result.signatureAlgorithm).toBe("rsa-pkcs1-sha256");
    expect(result.signerCn).toBe(SIGNER_CN);
    expect(result.anchorCn).toBe(CA_CN);
    expect(result.genTime?.toISOString()).toBe(GEN_TIME.toISOString());
  });
});

describe("REQ-014 — verifyTsaSignature: fail-closed rejections", () => {
  it("tampered signature -> SIGNATURE_INVALID", async () => {
    const resp = await mkResp({ signerCertDer: signerCertValid, tamperSignature: true });
    await expect(verifyTsaSignature(resp, { trustAnchors: [caCertDer] })).rejects.toThrow(/SIGNATURE_INVALID/);
  });

  it("signer not chaining to a configured trust anchor -> NO_CHAIN", async () => {
    const resp = await mkResp({ signerCertDer: signerCertValid });
    await expect(verifyTsaSignature(resp, { trustAnchors: [rogueCaCertDer] })).rejects.toThrow(/NO_CHAIN/);
  });

  it("expired signer cert (genTime outside validity) -> CERT_EXPIRED", async () => {
    const expiredCert = await buildSignerCert({
      cn: SIGNER_CN,
      caCn: CA_CN,
      signerSpki: signerKey.spki,
      caKey: caKey.privateKey,
      notBefore: new Date("2020-01-01T00:00:00Z"),
      notAfter: new Date("2021-01-01T00:00:00Z"),
    });
    const resp = await mkResp({ signerCertDer: expiredCert });
    await expect(verifyTsaSignature(resp, { trustAnchors: [caCertDer] })).rejects.toThrow(/CERT_EXPIRED/);
  });

  it("missing timestamping EKU -> MISSING_TIMESTAMPING_EKU", async () => {
    const noEkuCert = await buildSignerCert({
      cn: SIGNER_CN,
      caCn: CA_CN,
      signerSpki: signerKey.spki,
      caKey: caKey.privateKey,
      ...WIDE,
      withTimestampingEku: false,
    });
    const resp = await mkResp({ signerCertDer: noEkuCert });
    await expect(verifyTsaSignature(resp, { trustAnchors: [caCertDer] })).rejects.toThrow(/MISSING_TIMESTAMPING_EKU/);
  });

  it("messageDigest attr != SHA-256(TSTInfo) (substituted content) -> DIGEST_MISMATCH", async () => {
    // a valid signature over a BOGUS messageDigest: isolates the digest-binding check from the sig check
    const resp = await mkResp({ signerCertDer: signerCertValid, messageDigestOverride: new Uint8Array(32) });
    await expect(verifyTsaSignature(resp, { trustAnchors: [caCertDer] })).rejects.toThrow(/DIGEST_MISMATCH/);
  });
});

describe("REQ-014 — verifyTsaSignature: ECDSA-P256 signer + CA", () => {
  it("verifies an ECDSA-P256/SHA-256 chain end-to-end", async () => {
    const ecCa = await generateEcKeyPair();
    const ecSigner = await generateEcKeyPair();
    const ecCaCn = "SHUDDL Test EC Root CA";
    const ecCaCert = await buildTestCa({ cn: ecCaCn, keyPair: ecCa, ...WIDE, signAlg: "ecdsa" });
    const ecSignerCert = await buildSignerCert({
      cn: SIGNER_CN,
      caCn: ecCaCn,
      signerSpki: ecSigner.spki,
      caKey: ecCa.privateKey,
      ...WIDE,
      signAlg: "ecdsa",
    });
    const resp = await buildSignedGrantedResp({
      imprint: IMPRINT,
      nonce: NONCE,
      genTime: GEN_TIME,
      signerKey: ecSigner.privateKey,
      signerCertDer: ecSignerCert,
      signerCn: SIGNER_CN,
      caCn: ecCaCn,
      signAlg: "ecdsa",
    });

    const result = await verifyTsaSignature(resp, { trustAnchors: [ecCaCert] });
    expect(result.verified).toBe(true);
    expect(result.signatureAlgorithm).toBe("ecdsa-p256-sha256");
    expect(result.imprintDigestHex).toBe(bytesToHex(IMPRINT));

    // and an ECDSA chain to a DIFFERENT trust anchor still fails closed
    const rogueEc = await buildTestCa({ cn: "SHUDDL Test EC Rogue CA", keyPair: await generateEcKeyPair(), ...WIDE, signAlg: "ecdsa", serial: 9 });
    await expect(verifyTsaSignature(resp, { trustAnchors: [rogueEc] })).rejects.toThrow(/NO_CHAIN/);
  });
});

describe("REQ-014 — verifyTsaSignature: opt-in seam (no configured trust anchor)", () => {
  it("with NO trust anchors returns an explicit unverified state, never a silent pass", async () => {
    const resp = await mkResp({ signerCertDer: signerCertValid });
    const none = await verifyTsaSignature(resp, {});
    expect(none.verified).toBe(false);
    expect(none.reason).toBe("chain-not-configured");

    const empty = await verifyTsaSignature(resp, { trustAnchors: [] });
    expect(empty.verified).toBe(false);
    expect(empty.reason).toBe("chain-not-configured");
  });

  it("an UNSIGNED token (empty signerInfos, no certs) fails CLOSED when a trust anchor is configured", async () => {
    // buildGrantedTimeStampResp builds the pre-WP-16 empty-signerInfos token; the protocol verify still
    // passes, but the crypto verify has nothing to check and must REFUSE rather than fake a pass.
    const unsigned = buildGrantedTimeStampResp(IMPRINT, NONCE, GEN_TIME);
    expect(parseTimeStampResp(unsigned).granted).toBe(true); // protocol layer unaffected
    await expect(verifyTsaSignature(unsigned, { trustAnchors: [caCertDer] })).rejects.toThrow();
  });

  it("FakeTsaClient's receipt protocol-verifies but is not crypto-verifiable (fail-closed)", async () => {
    const tsr = await new FakeTsaClient({ genTime: GEN_TIME }).timestamp(IMPRINT);
    expect(parseTimeStampResp(tsr).granted).toBe(true);
    await expect(verifyTsaSignature(tsr, { trustAnchors: [caCertDer] })).rejects.toThrow();
  });
});
