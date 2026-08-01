// Minimal DER (ASN.1 Distinguished Encoding Rules) for RFC 3161 timestamping (REQ-014).
//
// SCOPE (Decision 15): we encode a TimeStampReq and extract {status, imprint, nonce} from a
// TimeStampResp so the daily anchor can (a) send a request and (b) verify the TSA echoed our exact
// imprint + nonce with status `granted`. We do NOT verify the CMS signature or the TSA cert chain
// here — that lives in the WP-16 CMS verifier (./cms.ts `verifyTsaSignature`), which REUSES the DER
// primitives exported below (TAG, tlv, concat, readTlv, readChildren, …). The raw `.tsr` bytes are
// retained in R2 so the receipt stays cryptographically verifiable offline, forever.
//
// THE CLASSIC BUG this file exists to get right: a DER INTEGER is two's-complement SIGNED. A value
// whose most-significant bit is set (>= 0x80 in the top byte) MUST be prefixed with a 0x00 pad byte,
// or it decodes as NEGATIVE. A TSA that reads a negative nonce echoes a different value and the anchor
// silently accepts an unverified receipt. See encodeDerInteger + der.test.ts's high-bit golden.
//
// PURE: no I/O, no LLM (REQ-024).

import { bytesToHex, hexToBytes } from "../merkle.js";

// ---- primitive encoders -------------------------------------------------------------------------

// Generic DER primitives are exported so the WP-16 CMS/X.509 verifier (cms.ts) reuses this ONE
// reader/encoder instead of forking a second, subtly-different DER parser (REQ-014).
export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

// SHA-256: 2.16.840.1.101.3.4.2.1
const SHA256_OID_BYTES = Uint8Array.from([0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);

// DER length: short form (< 128) is one byte; long form is 0x80|n followed by n big-endian bytes.
export function encodeLength(len: number): Uint8Array {
  if (len < 0) throw new Error("encodeLength: negative length");
  if (len < 0x80) return Uint8Array.from([len]);
  const bytes: number[] = [];
  let v = len;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, content: Uint8Array): Uint8Array {
  const len = encodeLength(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

// DER INTEGER content for a NON-NEGATIVE integer, minimal, with the mandatory 0x00 high-bit pad.
export function encodeDerInteger(value: number | bigint): Uint8Array {
  let v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n) throw new Error("encodeDerInteger: only non-negative integers are supported");
  const bytes: number[] = [];
  if (v === 0n) {
    bytes.push(0);
  } else {
    while (v > 0n) {
      bytes.unshift(Number(v & 0xffn));
      v >>= 8n;
    }
  }
  if ((bytes[0]! & 0x80) !== 0) bytes.unshift(0x00); // sign pad — the classic bug
  return tlv(TAG.INTEGER, Uint8Array.from(bytes));
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// AlgorithmIdentifier { OID sha256, NULL } — the NULL parameters field is customary for SHA-256.
function sha256AlgorithmIdentifier(): Uint8Array {
  return tlv(TAG.SEQUENCE, concat([tlv(TAG.OID, SHA256_OID_BYTES), tlv(TAG.NULL, new Uint8Array(0))]));
}

// MessageImprint { AlgorithmIdentifier, OCTET STRING digest }
function messageImprint(digest: Uint8Array): Uint8Array {
  return tlv(TAG.SEQUENCE, concat([sha256AlgorithmIdentifier(), tlv(TAG.OCTET_STRING, digest)]));
}

export interface TimeStampReqInput {
  /** The message imprint (the hash to be stamped), lower-case hex; must be a 32-byte SHA-256 digest. */
  digestHex: string;
  /** Anti-replay nonce; echoed by the TSA in TSTInfo. */
  nonce: number | bigint;
}

// TimeStampReq { version INTEGER 1, MessageImprint, nonce INTEGER, certReq BOOLEAN TRUE }
export function encodeTimeStampReq({ digestHex, nonce }: TimeStampReqInput): Uint8Array {
  const digest = hexToBytes(digestHex);
  if (digest.length !== 32) throw new Error(`encodeTimeStampReq: SHA-256 imprint must be 32 bytes, got ${digest.length}`);
  const version = encodeDerInteger(1);
  const imprint = messageImprint(digest);
  const nonceInt = encodeDerInteger(nonce);
  const certReq = tlv(TAG.BOOLEAN, Uint8Array.from([0xff])); // request the TSA cert in the response
  return tlv(TAG.SEQUENCE, concat([version, imprint, nonceInt, certReq]));
}

// ---- TLV reader (for parsing a TimeStampResp) ---------------------------------------------------

export interface Tlv {
  tag: number;
  /** Offset of the identifier octet (the element's first byte) — needed to slice raw element DER. */
  start: number;
  contentStart: number;
  contentEnd: number;
  end: number;
}

export function readTlv(buf: Uint8Array, offset: number): Tlv {
  if (offset >= buf.length) throw new Error("DER: read past end");
  const tag = buf[offset]!;
  let pos = offset + 1;
  if (pos >= buf.length) throw new Error("DER: truncated length");
  const first = buf[pos]!;
  pos += 1;
  let len: number;
  if (first < 0x80) {
    len = first;
  } else {
    const numBytes = first & 0x7f;
    if (numBytes === 0 || numBytes > 4) throw new Error(`DER: unsupported length form (${numBytes} bytes)`);
    len = 0;
    for (let i = 0; i < numBytes; i++) {
      if (pos >= buf.length) throw new Error("DER: truncated long-form length");
      len = len * 256 + buf[pos]!;
      pos += 1;
    }
  }
  const contentStart = pos;
  const contentEnd = pos + len;
  if (contentEnd > buf.length) throw new Error("DER: content overruns buffer");
  return { tag, start: offset, contentStart, contentEnd, end: contentEnd };
}

export function readChildren(buf: Uint8Array, start: number, end: number): Tlv[] {
  const out: Tlv[] = [];
  let pos = start;
  while (pos < end) {
    const t = readTlv(buf, pos);
    out.push(t);
    pos = t.end;
  }
  return out;
}

export const isConstructed = (tag: number): boolean => (tag & 0x20) !== 0;

// Content of a DER INTEGER interpreted as a non-negative magnitude, lower-case hex (leading 0x00 sign
// pad stripped). Zero renders "00". Used to compare a response nonce against the request nonce.
function integerMagnitudeHex(buf: Uint8Array, t: Tlv): string {
  let s = t.contentStart;
  while (s < t.contentEnd - 1 && buf[s] === 0x00) s += 1; // strip leading zero bytes
  const hex = bytesToHex(buf.slice(s, t.contentEnd));
  return hex.length === 0 ? "00" : hex;
}

export interface ParsedTimeStampResp {
  /** PKIStatus name: "granted" (0) / "granted_with_mods" (1) / "rejection" (2) / "waiting"/"revocation*". */
  status: string;
  /** true iff the TSA granted the request (PKIStatus 0 or 1). */
  granted: boolean;
  /** The stamped imprint digest echoed in TSTInfo.messageImprint, lower-case hex — undefined on rejection. */
  imprintDigestHex?: string;
  /** The nonce echoed in TSTInfo, magnitude hex — undefined if the response carried no token/nonce. */
  nonceHex?: string;
}

const PKI_STATUS: Record<number, string> = {
  0: "granted",
  1: "granted_with_mods",
  2: "rejection",
  3: "waiting",
  4: "revocation_warning",
  5: "revocation_notification",
};

// Try to interpret a byte-run as TSTInfo (RFC 3161 §2.4.2):
//   SEQUENCE { version INTEGER, policy OID, messageImprint SEQUENCE{alg, OCTET STRING}, serial INTEGER,
//              genTime GeneralizedTime, [accuracy] [ordering] [nonce INTEGER] ... }
// Returns the echoed imprint + nonce, or null if the shape doesn't match.
function tryParseTstInfo(buf: Uint8Array, seq: Tlv): { imprintDigestHex: string; nonceHex?: string } | null {
  if (seq.tag !== TAG.SEQUENCE) return null;
  const kids = readChildren(buf, seq.contentStart, seq.contentEnd);
  if (kids.length < 5) return null;
  const [version, policy, imprint, serial, genTime] = kids;
  if (version!.tag !== TAG.INTEGER || policy!.tag !== TAG.OID || imprint!.tag !== TAG.SEQUENCE) return null;
  if (serial!.tag !== TAG.INTEGER || genTime!.tag !== 0x18 /* GeneralizedTime */) return null;
  const imprintKids = readChildren(buf, imprint!.contentStart, imprint!.contentEnd);
  if (imprintKids.length !== 2 || imprintKids[0]!.tag !== TAG.SEQUENCE || imprintKids[1]!.tag !== TAG.OCTET_STRING) {
    return null;
  }
  const digest = imprintKids[1]!;
  const imprintDigestHex = bytesToHex(buf.slice(digest.contentStart, digest.contentEnd));
  // nonce is the FIRST INTEGER after genTime (accuracy is a SEQUENCE, ordering is a BOOLEAN — skipped).
  const out: { imprintDigestHex: string; nonceHex?: string } = { imprintDigestHex };
  for (const k of kids.slice(5)) {
    if (k.tag === TAG.INTEGER) {
      out.nonceHex = integerMagnitudeHex(buf, k);
      break;
    }
  }
  return out;
}

// Recursively descend every constructed node looking for the TSTInfo carried (as DER) inside an
// OCTET STRING — the CMS eContent. This locates it in a real TSA's SignedData without a full CMS
// parse, and in the FakeTsaClient's structurally-identical token.
function findTstInfo(buf: Uint8Array, start: number, end: number, depth = 0): { imprintDigestHex: string; nonceHex?: string } | null {
  if (depth > 16) return null;
  for (const child of readChildren(buf, start, end)) {
    if (child.tag === TAG.OCTET_STRING || isConstructed(child.tag)) {
      // An OCTET STRING may wrap DER (the TSTInfo); a constructed node may hold it deeper.
      try {
        const inner = readTlv(buf, child.contentStart);
        if (inner.end <= child.contentEnd) {
          const hit = tryParseTstInfo(buf, inner);
          if (hit) return hit;
        }
      } catch {
        /* not DER at this position — fall through to recursion */
      }
      if (isConstructed(child.tag)) {
        const hit = findTstInfo(buf, child.contentStart, child.contentEnd, depth + 1);
        if (hit) return hit;
      }
    }
  }
  return null;
}

// TimeStampResp { status PKIStatusInfo{ status INTEGER, ... }, [timeStampToken] }
export function parseTimeStampResp(bytes: Uint8Array | ArrayBuffer): ParsedTimeStampResp {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const root = readTlv(buf, 0);
  if (root.tag !== TAG.SEQUENCE) throw new Error("TimeStampResp: expected SEQUENCE");
  const top = readChildren(buf, root.contentStart, root.contentEnd);
  const statusInfo = top[0];
  if (!statusInfo || statusInfo.tag !== TAG.SEQUENCE) throw new Error("TimeStampResp: missing PKIStatusInfo");
  const statusKids = readChildren(buf, statusInfo.contentStart, statusInfo.contentEnd);
  const statusInt = statusKids[0];
  if (!statusInt || statusInt.tag !== TAG.INTEGER) throw new Error("TimeStampResp: missing PKIStatus INTEGER");
  // A DER INTEGER MUST carry ≥1 content byte. A zero-length PKIStatus is malformed — but
  // integerMagnitudeHex renders it "00", which would parse as 0 → granted. Reject it up front: a
  // degenerate status must never read as a grant, or the anchor accepts an unverified receipt.
  if (statusInt.contentEnd <= statusInt.contentStart) {
    throw new Error("TimeStampResp: PKIStatus INTEGER is zero-length (malformed DER — refusing to read as granted)");
  }
  const statusValue = Number.parseInt(integerMagnitudeHex(buf, statusInt), 16);
  const status = PKI_STATUS[statusValue] ?? `unknown_${statusValue}`;
  const granted = statusValue === 0 || statusValue === 1;

  const tst = findTstInfo(buf, root.contentStart, root.contentEnd);
  const result: ParsedTimeStampResp = { status, granted };
  if (tst) {
    result.imprintDigestHex = tst.imprintDigestHex;
    if (tst.nonceHex !== undefined) result.nonceHex = tst.nonceHex;
  }
  return result;
}

// ---- response builder (FakeTsaClient uses this so tests exercise the REAL parser) ---------------

const OID_SIGNED_DATA = Uint8Array.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]); // 1.2.840.113549.1.7.2
const OID_CT_TSTINFO = Uint8Array.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x04]); // 1.2.840.113549.1.9.16.1.4
const OID_TSA_POLICY = Uint8Array.from([0x2a, 0x03, 0x04, 0x01]); // 1.2.3.4.1 — a placeholder policy id

export function explicit(tagNumber: number, content: Uint8Array): Uint8Array {
  return tlv(0xa0 | tagNumber, content); // context-specific, constructed, EXPLICIT
}

export function generalizedTime(d: Date): Uint8Array {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  const s = `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x18, new TextEncoder().encode(s));
}

// Build a granted TimeStampResp whose TSTInfo echoes `imprint` and `nonce`. Structurally a real CMS
// SignedData wrapping a real TSTInfo (empty signerInfos — the SYNTHETIC fixture stays unsigned; a real
// `.tsr`'s SignerInfo signature + cert chain verify via cms.ts, landed WP-16),
// so parseTimeStampResp walks the identical shape it would on a live TSA `.tsr`.
export function buildGrantedTimeStampResp(imprint: Uint8Array, nonce: number | bigint, genTime: Date): Uint8Array {
  if (imprint.length !== 32) throw new Error(`buildGrantedTimeStampResp: imprint must be 32 bytes, got ${imprint.length}`);
  const pkiStatusInfo = tlv(TAG.SEQUENCE, encodeDerInteger(0)); // status = granted

  const tstInfo = tlv(
    TAG.SEQUENCE,
    concat([
      encodeDerInteger(1), // version
      tlv(TAG.OID, OID_TSA_POLICY),
      messageImprint(imprint),
      encodeDerInteger(1), // serialNumber
      generalizedTime(genTime),
      encodeDerInteger(nonce),
    ]),
  );

  const encapContentInfo = tlv(
    TAG.SEQUENCE,
    concat([tlv(TAG.OID, OID_CT_TSTINFO), explicit(0, tlv(TAG.OCTET_STRING, tstInfo))]),
  );

  const signedData = tlv(
    TAG.SEQUENCE,
    concat([
      encodeDerInteger(3), // CMS SignedData version
      tlv(TAG.SET, new Uint8Array(0)), // digestAlgorithms (empty)
      encapContentInfo,
      tlv(TAG.SET, new Uint8Array(0)), // signerInfos (empty — synthetic fixture; cms.ts verifies real ones)
    ]),
  );

  const contentInfo = tlv(TAG.SEQUENCE, concat([tlv(TAG.OID, OID_SIGNED_DATA), explicit(0, signedData)]));

  return tlv(TAG.SEQUENCE, concat([pkiStatusInfo, contentInfo]));
}
