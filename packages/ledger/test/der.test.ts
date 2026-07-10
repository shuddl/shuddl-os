import { describe, expect, it } from "vitest";
import {
  buildGrantedTimeStampResp,
  encodeDerInteger,
  encodeLength,
  encodeTimeStampReq,
  parseTimeStampResp,
} from "../src/tsa/der.js";
import { FakeTsaClient, assertGrantedReceipt, UnavailableTsaClient } from "../src/tsa/client.js";
import { bytesToHex, hexToBytes } from "../src/merkle.js";
import { sha256Hex } from "../src/canonical.js";

// RFC 3161 minimal DER (REQ-014). The golden bytes below were assembled by hand from the ASN.1
// structure (TimeStampReq{ version, MessageImprint{ SHA-256 AlgorithmIdentifier, OCTET STRING },
// nonce, certReq }), NOT by the encoder under test — so the encoder is checked against an independent
// witness.

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("REQ-014 — encodeTimeStampReq golden", () => {
  it("encodes version/imprint/nonce/certReq to the exact expected DER", () => {
    const der = encodeTimeStampReq({ digestHex: EMPTY_SHA256, nonce: 42 });
    expect(bytesToHex(der)).toBe(
      "303c0201013031300d060960864801650304020105000420" +
        EMPTY_SHA256 +
        "02012a0101ff",
    );
  });

  it("rejects a non-32-byte imprint (SHA-256 only)", () => {
    expect(() => encodeTimeStampReq({ digestHex: "abcd", nonce: 1 })).toThrow(/32 bytes/);
  });
});

describe("REQ-014 — the classic high-bit DER INTEGER pad", () => {
  it("prepends 0x00 when the top byte has its high bit set (else it decodes NEGATIVE)", () => {
    expect(bytesToHex(encodeDerInteger(0x80))).toBe("02020080"); // 0x80 -> 00 80
    expect(bytesToHex(encodeDerInteger(0xff))).toBe("020200ff");
    expect(bytesToHex(encodeDerInteger(0x1234))).toBe("02021234"); // high bit clear -> no pad
  });

  it("encodes small values, zero, and multi-byte magnitudes minimally", () => {
    expect(bytesToHex(encodeDerInteger(0))).toBe("020100");
    expect(bytesToHex(encodeDerInteger(0x7f))).toBe("02017f");
    expect(bytesToHex(encodeDerInteger(0x0102030405060708n))).toBe("02080102030405060708");
    // 0x80000000 = 80 00 00 00 (top bit set) -> one 0x00 pad -> content 00 80 00 00 00
    expect(bytesToHex(encodeDerInteger(0x80000000n))).toBe("02050080000000");
  });

  it("rejects negatives", () => {
    expect(() => encodeDerInteger(-1)).toThrow(/non-negative/);
  });
});

describe("REQ-014 — DER length encoding (short + long form)", () => {
  it("short form below 128, long form at/above", () => {
    expect(bytesToHex(encodeLength(0))).toBe("00");
    expect(bytesToHex(encodeLength(127))).toBe("7f");
    expect(bytesToHex(encodeLength(128))).toBe("8180");
    expect(bytesToHex(encodeLength(200))).toBe("81c8");
    expect(bytesToHex(encodeLength(300))).toBe("82012c");
    expect(bytesToHex(encodeLength(65535))).toBe("82ffff"); // long form, 2 length bytes
  });
});

describe("REQ-014 — parseTimeStampResp round-trips a granted response (real parser, real encoder)", () => {
  it("extracts status=granted, the echoed imprint, and the echoed nonce", () => {
    const imprint = hexToBytes(EMPTY_SHA256);
    const resp = buildGrantedTimeStampResp(imprint, 0x1234, new Date("2026-07-10T01:00:00Z"));
    const parsed = parseTimeStampResp(resp);
    expect(parsed.status).toBe("granted");
    expect(parsed.granted).toBe(true);
    expect(parsed.imprintDigestHex).toBe(EMPTY_SHA256);
    expect(parsed.nonceHex).toBe("1234");
  });

  it("handles a high-bit nonce echo (long TSTInfo forces long-form length in the parser)", () => {
    const imprint = hexToBytes(EMPTY_SHA256);
    const resp = buildGrantedTimeStampResp(imprint, 0x80n, new Date("2026-07-10T01:00:00Z"));
    const parsed = parseTimeStampResp(resp);
    expect(parsed.granted).toBe(true);
    expect(parsed.nonceHex).toBe("80"); // magnitude, sign-pad stripped
    expect(parsed.imprintDigestHex).toBe(EMPTY_SHA256);
  });
});

describe("REQ-014 — TsaClient (Fake exercises the real parser + verifier)", () => {
  it("FakeTsaClient produces a receipt that verifies granted + imprint + nonce", async () => {
    const imprint = hexToBytes(await sha256Hex(new TextEncoder().encode("shuddl-anchor-v1:tenant-a:2026-07-09:root:3")));
    const tsr = await new FakeTsaClient().timestamp(imprint);
    const parsed = parseTimeStampResp(tsr);
    expect(parsed.granted).toBe(true);
    expect(parsed.imprintDigestHex).toBe(bytesToHex(imprint));
  });

  it("assertGrantedReceipt throws on an imprint mismatch (substituted receipt)", () => {
    const imprint = hexToBytes(EMPTY_SHA256);
    const otherImprint = hexToBytes("00".repeat(32));
    const resp = buildGrantedTimeStampResp(imprint, 7n, new Date(0));
    // pretend we sent otherImprint; the receipt stamps a different digest -> reject
    expect(() => assertGrantedReceipt(resp, otherImprint, 7n)).toThrow(/IMPRINT_MISMATCH/);
  });

  it("assertGrantedReceipt throws on a nonce mismatch (replayed receipt)", () => {
    const imprint = hexToBytes(EMPTY_SHA256);
    const resp = buildGrantedTimeStampResp(imprint, 7n, new Date(0));
    expect(() => assertGrantedReceipt(resp, imprint, 8n)).toThrow(/NONCE_MISMATCH/);
  });

  it("UnavailableTsaClient always rejects", async () => {
    await expect(new UnavailableTsaClient().timestamp(hexToBytes(EMPTY_SHA256))).rejects.toThrow();
  });
});
