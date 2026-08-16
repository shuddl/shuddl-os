import { describe, expect, it } from "vitest";
import {
  buildGrantedTimeStampResp,
  encodeDerInteger,
  encodeLength,
  encodeTimeStampReq,
  parseTimeStampResp,
  readChildren,
  readTlv,
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

  // WP-02 exit audit (REQ-119) Minor: a DER INTEGER must carry ≥1 content byte. A zero-length PKIStatus
  // is malformed, but integerMagnitudeHex renders "" as "00" → parseInt 0 → granted. Such a receipt must
  // be REJECTED, not silently accepted as a grant. Bytes: TimeStampResp SEQ { PKIStatusInfo SEQ {
  // INTEGER len 0 } } = 30 04 30 02 02 00.
  it("REJECTS a zero-length PKIStatus INTEGER instead of reading it as granted", () => {
    const degenerate = Uint8Array.from([0x30, 0x04, 0x30, 0x02, 0x02, 0x00]);
    expect(() => parseTimeStampResp(degenerate)).toThrow(/zero-length|malformed/i);
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

// §1606 (REQ-014/118) — A DER CHILD MUST STAY INSIDE ITS PARENT, NOT MERELY INSIDE THE BUFFER.
//
// `readTlv` validates a declared length against `buf.length` — correct for the outermost element, too weak for
// every nested one. `readChildren` walks a parent's extent, so a child whose length reaches past the parent's
// `contentEnd` while still landing inside the buffer used to parse clean and SWALLOW the following sibling.
//
// Measured before the fix, on the ten-byte fixture below: a SEQUENCE declaring FOUR content bytes returned one
// child ending at offset 10 — four bytes beyond its parent — absorbing the OCTET STRING after it. In a
// signature verifier fed attacker-supplied bytes, that is the structure the code believes it read diverging
// from the structure the signer signed.
//
// No legitimate DER does this: a child overrunning its parent is malformed by definition, so refusing it breaks
// no traffic. That is what separates this from the EDI envelope's integrity fields (§1605), where strict
// enforcement is a decision because real senders emit wrong counts.
describe("§1606 REQ-014: DER nesting bounds", () => {
  // 30 04            SEQUENCE, content length 4  → contentEnd = 6
  //   02 06 AA BB    INTEGER declaring SIX content bytes (corrupt: only 2 remain inside the parent)
  //   04 02 CC DD    an OCTET STRING sibling that lives OUTSIDE the sequence
  const OVERRUN = Uint8Array.from([0x30, 0x04, 0x02, 0x06, 0xaa, 0xbb, 0x04, 0x02, 0xcc, 0xdd]);

  it("a child overrunning its parent is REFUSED, not silently extended over the next sibling", () => {
    const outer = readTlv(OVERRUN, 0);
    expect(outer.contentEnd, "fixture: the parent's content must end at 6 for this to be a parent overrun").toBe(6);
    expect(
      () => readChildren(OVERRUN, outer.contentStart, outer.contentEnd),
      "the child was accepted — it ends past its parent and absorbs the sibling, so the parsed structure is not " +
        "the signed structure",
    ).toThrow(/overruns its parent/);
  });

  it("a well-formed nesting still parses (without this the refusal above proves nothing)", () => {
    // Same shape, honest length: the INTEGER declares the two bytes it actually owns.
    const ok = Uint8Array.from([0x30, 0x04, 0x02, 0x02, 0xaa, 0xbb, 0x04, 0x02, 0xcc, 0xdd]);
    const outer = readTlv(ok, 0);
    const kids = readChildren(ok, outer.contentStart, outer.contentEnd);
    expect(kids).toHaveLength(1);
    expect(kids[0]?.contentEnd, "the child must end exactly at its parent's boundary").toBe(6);
  });
});

// §1607 (REQ-014/118) — THE SAME BOUND, AT THE THREE NESTED READS `readChildren` DOES NOT COVER.
//
// §1606 fixed the walk. It did not fix a DIRECT `readTlv` at a child offset, which is the same weakness with a
// different call shape: twelve call sites exist, eight pass offset 0 on a standalone buffer (where the buffer
// IS the parent and the old bound was right), one already carried its own guard (`der.ts` TSTInfo probe), and
// three read a nested element bounded only by `buf.length` — an extension's value, ContentInfo's content, and
// the eContent wrapper whose OCTET STRING becomes the TSTInfo digested against the SIGNED messageDigest.
//
// `readTlv` now takes an optional `limit` (the enclosing element's end), defaulting to the buffer so every
// outermost read is unchanged. The three nested sites pass their parent's `contentEnd`.
describe("§1607 REQ-014: readTlv's limit bounds a nested read by its parent", () => {
  // 04 06 …  an OCTET STRING declaring six content bytes, inside a buffer that has them.
  const BUF = Uint8Array.from([0x04, 0x06, 1, 2, 3, 4, 5, 6]);

  it("without a limit the read succeeds — the buffer holds the declared content (the control)", () => {
    const t = readTlv(BUF, 0);
    expect(t.contentEnd).toBe(8);
  });

  it("with a limit BELOW the declared end it is REFUSED, naming the enclosing element", () => {
    expect(
      () => readTlv(BUF, 0, 5),
      "a nested element reaching past its parent was accepted — the parsed structure can then differ from the " +
        "signed one",
    ).toThrow(/overruns its enclosing element/);
  });

  it("a limit exactly AT the declared end still parses (the boundary is inclusive, not off by one)", () => {
    expect(readTlv(BUF, 0, 8).contentEnd).toBe(8);
  });
});
