// RFC 3161 CMS SignerInfo signature + X.509 cert-chain verification (REQ-014, WP-16).
//
// `der.ts` PROTOCOL-verifies a TimeStampResp: granted status + echoed imprint + echoed nonce
// (assertGrantedReceipt). That proves the bytes are structurally a grant for OUR imprint — it does
// NOT prove an independent authority actually SIGNED it. This file adds the cryptographic half so an
// anchor receipt is sound, not merely well-formed:
//
//   1. Parse the CMS SignedData out of the TimeStampToken (ContentInfo{ id-signedData, SignedData }).
//   2. Verify the SignerInfo signature over the DER of signedAttrs (re-tagged SET, RFC 5652 §5.4)
//      using the signer certificate's public key via Web Crypto — and confirm the signedAttrs carry a
//      messageDigest attr equal to SHA-256(eContent) and a contentType attr = id-ct-TSTInfo. This binds
//      the signature to OUR exact TSTInfo bytes.
//   3. Chain the signer cert (issuer/signature) to a CONFIGURED trust anchor, time-valid at the receipt
//      genTime (or opts.at), carrying the id-kp-timeStamping Extended Key Usage (RFC 3161 §2.3).
//
// FAIL-CLOSED: any parse failure, invalid signature, digest mismatch, missing/expired/EKU-less cert, or
// unsupported algorithm THROWS TsaVerifyError. There is no fake pass. When no trustAnchors are supplied
// (today — the real RFC-3161 endpoint is an out-of-repo F1 CONFIRM), this returns an explicit
// "chain-not-configured" state (verified:false), NOT a silent pass: the protocol-only verify still
// stands and the caller records that the crypto chain was not checked.
//
// OUT OF SCOPE (correctly deferred, documented in docs/security/threat-model.md):
//   • Revocation (OCSP/CRL) — needs network; NOT part of offline-forever verification. A deployment /
//     monitoring concern, checked at stamping time against the live TSA, not during archival replay.
//   • The real TSA's trust-anchor certs — DEPLOYMENT CONFIG (opts.trustAnchors), out-of-repo.
//   • Full RFC 5280 path validation (name constraints, policy mapping, path-length) — beyond the
//     minimal chain-to-trusted-root + validity + timestamping-EKU pen-test-basics scope.
//
// PURE of I/O + LLM (REQ-024): the only inputs are the response bytes + injected trust anchors; all
// crypto is Web Crypto (crypto.subtle), the same primitive merkle.ts already uses.

import { readChildren, readTlv, TAG, tlv, type Tlv } from "./der.js";
import { bytesToHex } from "../merkle.js";

// ── OIDs (DER content bytes, sans tag/length) ───────────────────────────────────────────────────
const OID = {
  signedData: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02], // 1.2.840.113549.1.7.2
  ctTstInfo: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x04], // 1.2.840.113549.1.9.16.1.4
  contentType: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x03], // 1.2.840.113549.1.9.3
  messageDigest: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04], // 1.2.840.113549.1.9.4
  sha256: [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01], // 2.16.840.1.101.3.4.2.1
  rsaEncryption: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01], // 1.2.840.113549.1.1.1
  sha256WithRsa: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b], // 1.2.840.113549.1.1.11
  ecPublicKey: [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01], // 1.2.840.10045.2.1
  prime256v1: [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07], // 1.2.840.10045.3.1.7
  ecdsaWithSha256: [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02], // 1.2.840.10045.4.3.2
  extKeyUsage: [0x55, 0x1d, 0x25], // 2.5.29.37
  kpTimeStamping: [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x08], // 1.3.6.1.5.5.7.3.8
  commonName: [0x55, 0x04, 0x03], // 2.5.4.3
} as const;

/** Every fail-closed rejection carries a stable machine code; the message adds detail for logs. */
export class TsaVerifyError extends Error {
  constructor(
    readonly code: string,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "TsaVerifyError";
  }
}

export interface VerifyTsaOptions {
  /** DER root/intermediate certs the signer must chain to. Deployment config; absent today (no real TSA). */
  trustAnchors?: Uint8Array[];
  /** Validity instant; defaults to the receipt's genTime. */
  at?: Date;
  /**
   * Lower-case hex of the imprint this receipt MUST attest. When set, the SIGNATURE-BOUND imprint from
   * the signed TSTInfo is asserted equal to it (throws IMPRINT_MISMATCH otherwise) — so a real TSA
   * receipt the authority signed for a DIFFERENT document cannot be replayed as ours when the seam is
   * wired (a multi-TSTInfo response could otherwise let the protocol layer find a decoy carrying our
   * imprint while the signature legitimately binds a different eContent).
   */
  expectedImprintHex?: string | undefined;
}

export interface TsaSignatureResult {
  /** true ONLY when the signature verified AND the signer chained to a configured trust anchor. */
  verified: boolean;
  reason: "verified" | "chain-not-configured";
  /** Signer certificate common name (informational). */
  signerCn?: string | undefined;
  /** The trust anchor common name the chain terminated at. */
  anchorCn?: string | undefined;
  /** TSTInfo genTime (the witnessed instant). */
  genTime?: Date | undefined;
  /** The imprint the signed TSTInfo binds, lower-case hex — so a caller can cross-check it vs the anchor. */
  imprintDigestHex?: string | undefined;
  /** Signature algorithm family that verified: "rsa-pkcs1-sha256" | "ecdsa-p256-sha256". */
  signatureAlgorithm?: string | undefined;
}

// ── byte helpers ────────────────────────────────────────────────────────────────────────────────
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function raw(buf: Uint8Array, t: Tlv): Uint8Array {
  return buf.subarray(t.start, t.end);
}

function content(buf: Uint8Array, t: Tlv): Uint8Array {
  return buf.subarray(t.contentStart, t.contentEnd);
}

function oidEquals(buf: Uint8Array, t: Tlv, oid: readonly number[]): boolean {
  if (t.tag !== TAG.OID) return false;
  const c = content(buf, t);
  return c.length === oid.length && oid.every((b, i) => c[i] === b);
}

function expect(t: Tlv | undefined, tag: number, code: string, what: string): Tlv {
  if (!t) throw new TsaVerifyError(code, `missing ${what}`);
  if (t.tag !== tag) throw new TsaVerifyError(code, `${what}: expected tag 0x${tag.toString(16)}, got 0x${t.tag.toString(16)}`);
  return t;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

// ── ASN.1 time ──────────────────────────────────────────────────────────────────────────────────
// GeneralizedTime "YYYYMMDDHHMMSSZ" (tag 0x18) and UTCTime "YYMMDDHHMMSSZ" (tag 0x17, YY<50 => 20YY).
function parseAsn1Time(buf: Uint8Array, t: Tlv): Date {
  const s = new TextDecoder().decode(content(buf, t));
  let yyyy: number;
  let rest: string;
  if (t.tag === 0x18) {
    yyyy = Number.parseInt(s.slice(0, 4), 10);
    rest = s.slice(4);
  } else if (t.tag === 0x17) {
    const yy = Number.parseInt(s.slice(0, 2), 10);
    yyyy = yy < 50 ? 2000 + yy : 1900 + yy;
    rest = s.slice(2);
  } else {
    throw new TsaVerifyError("MALFORMED", `unexpected time tag 0x${t.tag.toString(16)}`);
  }
  const mo = Number.parseInt(rest.slice(0, 2), 10);
  const da = Number.parseInt(rest.slice(2, 4), 10);
  const hh = Number.parseInt(rest.slice(4, 6), 10);
  const mi = Number.parseInt(rest.slice(6, 8), 10);
  const se = Number.parseInt(rest.slice(8, 10), 10);
  const ms = Date.UTC(yyyy, mo - 1, da, hh, mi, se);
  if (Number.isNaN(ms)) throw new TsaVerifyError("MALFORMED", `unparseable ASN.1 time "${s}"`);
  return new Date(ms);
}

// ── X.509 certificate ───────────────────────────────────────────────────────────────────────────
interface X509 {
  der: Uint8Array; // full certificate DER (for trust-anchor byte equality)
  tbsRaw: Uint8Array; // tbsCertificate raw DER (the signed bytes)
  sigAlgOid: Tlv; // outer signatureAlgorithm OID
  sigValue: Uint8Array; // signature BIT STRING payload (unused-bits byte stripped)
  issuerRaw: Uint8Array; // issuer Name raw DER
  subjectRaw: Uint8Array; // subject Name raw DER
  serial: Uint8Array; // serialNumber content bytes
  notBefore: Date;
  notAfter: Date;
  spki: Uint8Array; // subjectPublicKeyInfo raw DER (feeds crypto.subtle.importKey "spki")
  ekuOids: Uint8Array[]; // ExtKeyUsage KeyPurposeId content bytes (empty if no EKU extension)
  subjectCn?: string | undefined;
}

function commonNameOf(buf: Uint8Array, nameSeq: Tlv): string | undefined {
  // Name ::= SEQUENCE OF RDN; RDN ::= SET OF ATV; ATV ::= SEQUENCE { type OID, value }
  for (const rdn of readChildren(buf, nameSeq.contentStart, nameSeq.contentEnd)) {
    if (rdn.tag !== TAG.SET) continue;
    for (const atv of readChildren(buf, rdn.contentStart, rdn.contentEnd)) {
      const kids = readChildren(buf, atv.contentStart, atv.contentEnd);
      if (kids.length === 2 && oidEquals(buf, kids[0]!, OID.commonName)) {
        return new TextDecoder().decode(content(buf, kids[1]!));
      }
    }
  }
  return undefined;
}

function parseCertificate(der: Uint8Array): X509 {
  const cert = readTlv(der, 0);
  if (cert.tag !== TAG.SEQUENCE) throw new TsaVerifyError("MALFORMED", "certificate: not a SEQUENCE");
  const [tbs, sigAlg, sigBits] = readChildren(der, cert.contentStart, cert.contentEnd);
  expect(tbs, TAG.SEQUENCE, "MALFORMED", "tbsCertificate");
  expect(sigAlg, TAG.SEQUENCE, "MALFORMED", "signatureAlgorithm");
  expect(sigBits, 0x03, "MALFORMED", "signatureValue BIT STRING");

  const sigAlgKids = readChildren(der, sigAlg!.contentStart, sigAlg!.contentEnd);
  const sigAlgOid = expect(sigAlgKids[0], TAG.OID, "MALFORMED", "signatureAlgorithm OID");
  // BIT STRING: first content byte is the unused-bit count (0 for a signature); strip it.
  const sigValue = der.subarray(sigBits!.contentStart + 1, sigBits!.contentEnd);

  const tbsKids = readChildren(der, tbs!.contentStart, tbs!.contentEnd);
  // [0] EXPLICIT version is OPTIONAL (absent => v1). Detect it by the context tag 0xA0.
  let i = 0;
  if (tbsKids[i] && tbsKids[i]!.tag === 0xa0) i += 1; // skip version
  const serialT = expect(tbsKids[i++], TAG.INTEGER, "MALFORMED", "serialNumber");
  expect(tbsKids[i++], TAG.SEQUENCE, "MALFORMED", "inner signature AlgorithmIdentifier");
  const issuerT = expect(tbsKids[i++], TAG.SEQUENCE, "MALFORMED", "issuer");
  const validityT = expect(tbsKids[i++], TAG.SEQUENCE, "MALFORMED", "validity");
  const subjectT = expect(tbsKids[i++], TAG.SEQUENCE, "MALFORMED", "subject");
  const spkiT = expect(tbsKids[i++], TAG.SEQUENCE, "MALFORMED", "subjectPublicKeyInfo");

  const [nb, na] = readChildren(der, validityT.contentStart, validityT.contentEnd);
  if (!nb || !na) throw new TsaVerifyError("MALFORMED", "validity: missing notBefore/notAfter");

  // extensions live in a [3] EXPLICIT wrapper after the SPKI.
  const ekuOids: Uint8Array[] = [];
  for (; i < tbsKids.length; i++) {
    const ext = tbsKids[i]!;
    if (ext.tag !== 0xa3) continue; // [3] EXPLICIT Extensions
    const extSeq = readChildren(der, ext.contentStart, ext.contentEnd)[0];
    if (!extSeq || extSeq.tag !== TAG.SEQUENCE) continue;
    for (const e of readChildren(der, extSeq.contentStart, extSeq.contentEnd)) {
      const ek = readChildren(der, e.contentStart, e.contentEnd);
      const extnId = ek[0];
      if (!extnId || !oidEquals(der, extnId, OID.extKeyUsage)) continue;
      const extnValue = ek[ek.length - 1]!; // OCTET STRING (after optional critical BOOLEAN)
      if (extnValue.tag !== TAG.OCTET_STRING) continue;
      const seq = readTlv(der, extnValue.contentStart);
      for (const purpose of readChildren(der, seq.contentStart, seq.contentEnd)) {
        if (purpose.tag === TAG.OID) ekuOids.push(new Uint8Array(content(der, purpose)));
      }
    }
  }

  return {
    der,
    tbsRaw: new Uint8Array(raw(der, tbs!)),
    sigAlgOid,
    sigValue: new Uint8Array(sigValue),
    issuerRaw: new Uint8Array(raw(der, issuerT)),
    subjectRaw: new Uint8Array(raw(der, subjectT)),
    serial: new Uint8Array(content(der, serialT)),
    notBefore: parseAsn1Time(der, nb),
    notAfter: parseAsn1Time(der, na),
    spki: new Uint8Array(raw(der, spkiT)),
    ekuOids,
    subjectCn: commonNameOf(der, subjectT),
  };
}

// ── signature verification via Web Crypto ───────────────────────────────────────────────────────
// The public-key algorithm is read from the signer's SPKI (its AlgorithmIdentifier OID), NOT trusted
// from a caller-supplied hint — RSASSA-PKCS1-v1_5+SHA-256 or ECDSA-P256+SHA-256, both over SHA-256.
async function verifyWithSpki(spki: Uint8Array, signature: Uint8Array, data: Uint8Array): Promise<{ ok: boolean; alg: string }> {
  const spkiSeq = readTlv(spki, 0);
  const [algId] = readChildren(spki, spkiSeq.contentStart, spkiSeq.contentEnd);
  const algKids = readChildren(spki, algId!.contentStart, algId!.contentEnd);
  const algOid = algKids[0]!;

  if (oidEquals(spki, algOid, OID.rsaEncryption)) {
    const key = await crypto.subtle.importKey("spki", spki as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature as BufferSource, data as BufferSource);
    return { ok, alg: "rsa-pkcs1-sha256" };
  }
  if (oidEquals(spki, algOid, OID.ecPublicKey)) {
    const curve = algKids[1];
    if (!curve || !oidEquals(spki, curve, OID.prime256v1)) throw new TsaVerifyError("UNSUPPORTED_ALG", "EC curve is not P-256");
    const key = await crypto.subtle.importKey("spki", spki as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, ecdsaDerToP1363(signature) as BufferSource, data as BufferSource);
    return { ok, alg: "ecdsa-p256-sha256" };
  }
  throw new TsaVerifyError("UNSUPPORTED_ALG", `public-key OID ${bytesToHex(content(spki, algOid))}`);
}

// X.509/CMS carry an ECDSA signature as DER SEQUENCE{ r INTEGER, s INTEGER }; Web Crypto wants the
// fixed-width IEEE-P1363 r‖s (32+32 for P-256). Convert, stripping sign pads / left-padding to 32.
function ecdsaDerToP1363(der: Uint8Array): Uint8Array {
  const seq = readTlv(der, 0);
  if (seq.tag !== TAG.SEQUENCE) throw new TsaVerifyError("MALFORMED", "ECDSA signature: not a SEQUENCE");
  const [r, s] = readChildren(der, seq.contentStart, seq.contentEnd);
  if (!r || !s) throw new TsaVerifyError("MALFORMED", "ECDSA signature: missing r/s");
  const fix = (t: Tlv): Uint8Array => {
    let b = content(der, t);
    let off = 0;
    while (off < b.length - 1 && b[off] === 0x00) off += 1; // strip sign pad / leading zeros
    b = b.subarray(off);
    if (b.length > 32) throw new TsaVerifyError("MALFORMED", "ECDSA integer > 32 bytes");
    const out = new Uint8Array(32);
    out.set(b, 32 - b.length);
    return out;
  };
  const out = new Uint8Array(64);
  out.set(fix(r), 0);
  out.set(fix(s), 32);
  return out;
}

// ── cert-chain validation ───────────────────────────────────────────────────────────────────────
async function verifyChain(signer: X509, pool: X509[], trustAnchors: Uint8Array[], at: Date): Promise<X509> {
  const isAnchor = (c: X509): boolean => trustAnchors.some((a) => bytesEqual(a, c.der));
  let cert = signer;
  for (let depth = 0; depth < 8; depth++) {
    if (at.getTime() < cert.notBefore.getTime() || at.getTime() > cert.notAfter.getTime()) {
      throw new TsaVerifyError(
        "CERT_EXPIRED",
        `${cert.subjectCn ?? "cert"} valid [${cert.notBefore.toISOString()} .. ${cert.notAfter.toISOString()}], checked at ${at.toISOString()}`,
      );
    }
    if (isAnchor(cert)) return cert; // reached a configured trust anchor
    const issuer = pool.find((c) => bytesEqual(c.subjectRaw, cert.issuerRaw));
    if (!issuer) throw new TsaVerifyError("NO_CHAIN", `no issuer for ${cert.subjectCn ?? "cert"} among trust anchors/intermediates`);
    const { ok } = await verifyWithSpki(issuer.spki, cert.sigValue, cert.tbsRaw);
    if (!ok) throw new TsaVerifyError("NO_CHAIN", `signature of ${cert.subjectCn ?? "cert"} not valid under issuer ${issuer.subjectCn ?? "cert"}`);
    if (bytesEqual(issuer.der, cert.der)) throw new TsaVerifyError("NO_CHAIN", "self-signed cert is not a configured trust anchor");
    cert = issuer;
  }
  throw new TsaVerifyError("NO_CHAIN", "chain exceeds max depth");
}

// ── the entry point ─────────────────────────────────────────────────────────────────────────────
export async function verifyTsaSignature(respBytes: Uint8Array, opts: VerifyTsaOptions = {}): Promise<TsaSignatureResult> {
  const trustAnchors = opts.trustAnchors ?? [];
  // Opt-in seam: with no configured trust anchor there is nothing to chain to. Return an explicit
  // unverified state — the protocol-only verify still stands; we never claim crypto verification.
  if (trustAnchors.length === 0) return { verified: false, reason: "chain-not-configured" };

  const buf = respBytes;
  let anchors: X509[];
  try {
    anchors = trustAnchors.map(parseCertificate);
  } catch (err) {
    throw new TsaVerifyError("MALFORMED", `trust anchor parse failed: ${(err as Error).message}`);
  }

  // TimeStampResp ::= SEQUENCE { PKIStatusInfo, timeStampToken TimeStampToken OPTIONAL }
  const root = readTlv(buf, 0);
  if (root.tag !== TAG.SEQUENCE) throw new TsaVerifyError("MALFORMED", "TimeStampResp: not a SEQUENCE");
  const top = readChildren(buf, root.contentStart, root.contentEnd);
  const token = top[1];
  if (!token) throw new TsaVerifyError("NO_TOKEN", "response carries no timeStampToken (rejection or protocol-only)");

  // ContentInfo ::= SEQUENCE { contentType OID = id-signedData, [0] EXPLICIT content SignedData }
  expect(token, TAG.SEQUENCE, "MALFORMED", "timeStampToken ContentInfo");
  const ciKids = readChildren(buf, token.contentStart, token.contentEnd);
  if (!oidEquals(buf, ciKids[0]!, OID.signedData)) throw new TsaVerifyError("MALFORMED", "ContentInfo: not id-signedData");
  const ciContent = expect(ciKids[1], 0xa0, "MALFORMED", "ContentInfo [0] content");
  const signedData = readTlv(buf, ciContent.contentStart);
  expect(signedData, TAG.SEQUENCE, "MALFORMED", "SignedData");

  // SignedData ::= SEQUENCE { version, digestAlgorithms SET, encapContentInfo,
  //   [0] certificates OPTIONAL, [1] crls OPTIONAL, signerInfos SET }
  const sdKids = readChildren(buf, signedData.contentStart, signedData.contentEnd);
  const encap = expect(sdKids[2], TAG.SEQUENCE, "MALFORMED", "encapContentInfo");
  let certsNode: Tlv | undefined;
  let signerInfos: Tlv | undefined;
  for (const k of sdKids.slice(3)) {
    if (k.tag === 0xa0) certsNode = k; // [0] IMPLICIT certificates
    else if (k.tag === TAG.SET) signerInfos = k; // signerInfos
    // 0xA1 crls ignored (revocation is out of scope)
  }
  if (!certsNode) throw new TsaVerifyError("SIGNER_CERT_NOT_FOUND", "SignedData has no certificates");
  if (!signerInfos) throw new TsaVerifyError("MALFORMED", "SignedData has no signerInfos");

  // EncapsulatedContentInfo ::= SEQUENCE { eContentType OID = id-ct-TSTInfo, [0] EXPLICIT OCTET STRING }
  const encapKids = readChildren(buf, encap.contentStart, encap.contentEnd);
  if (!oidEquals(buf, encapKids[0]!, OID.ctTstInfo)) throw new TsaVerifyError("MALFORMED", "eContentType is not id-ct-TSTInfo");
  const eContentWrap = expect(encapKids[1], 0xa0, "MALFORMED", "eContent [0]");
  const eContentOctet = readTlv(buf, eContentWrap.contentStart);
  expect(eContentOctet, TAG.OCTET_STRING, "MALFORMED", "eContent OCTET STRING");
  const eContent = new Uint8Array(content(buf, eContentOctet)); // the TSTInfo DER

  // certificates: parse each; classify signer by SignerInfo.sid later.
  const certs = readChildren(buf, certsNode.contentStart, certsNode.contentEnd)
    .filter((c) => c.tag === TAG.SEQUENCE)
    .map((c) => parseCertificate(new Uint8Array(raw(buf, c))));

  // SignerInfo ::= SEQUENCE { version, sid IssuerAndSerialNumber, digestAlgorithm,
  //   [0] signedAttrs, signatureAlgorithm, signature OCTET STRING }
  const siList = readChildren(buf, signerInfos.contentStart, signerInfos.contentEnd);
  const si = expect(siList[0], TAG.SEQUENCE, "MALFORMED", "SignerInfo");
  const siKids = readChildren(buf, si.contentStart, si.contentEnd);
  const sid = expect(siKids[1], TAG.SEQUENCE, "MALFORMED", "SignerInfo.sid (issuerAndSerialNumber)");
  const digestAlg = expect(siKids[2], TAG.SEQUENCE, "MALFORMED", "SignerInfo.digestAlgorithm");
  const signedAttrs = siKids[3];
  if (!signedAttrs || signedAttrs.tag !== 0xa0) throw new TsaVerifyError("MISSING_SIGNED_ATTRS", "SignerInfo has no signedAttrs [0]");
  const signature = expect(siKids[5], TAG.OCTET_STRING, "MALFORMED", "SignerInfo.signature");

  // digestAlgorithm must be SHA-256 (the only supported digest).
  const digestAlgOid = readChildren(buf, digestAlg.contentStart, digestAlg.contentEnd)[0]!;
  if (!oidEquals(buf, digestAlgOid, OID.sha256)) throw new TsaVerifyError("UNSUPPORTED_ALG", "digestAlgorithm is not SHA-256");

  // Walk signedAttrs: require contentType = id-ct-TSTInfo and messageDigest = SHA-256(eContent).
  let sawContentType = false;
  let messageDigest: Uint8Array | undefined;
  for (const attr of readChildren(buf, signedAttrs.contentStart, signedAttrs.contentEnd)) {
    const [attrType, attrVals] = readChildren(buf, attr.contentStart, attr.contentEnd);
    if (!attrType || !attrVals) continue;
    const vals = readChildren(buf, attrVals.contentStart, attrVals.contentEnd);
    if (oidEquals(buf, attrType, OID.contentType)) {
      if (!vals[0] || !oidEquals(buf, vals[0], OID.ctTstInfo)) throw new TsaVerifyError("CONTENT_TYPE_MISMATCH", "signed contentType attr != id-ct-TSTInfo");
      sawContentType = true;
    } else if (oidEquals(buf, attrType, OID.messageDigest)) {
      if (!vals[0] || vals[0].tag !== TAG.OCTET_STRING) throw new TsaVerifyError("MALFORMED", "messageDigest attr value is not an OCTET STRING");
      messageDigest = new Uint8Array(content(buf, vals[0]));
    }
  }
  if (!sawContentType) throw new TsaVerifyError("CONTENT_TYPE_MISMATCH", "no signed contentType attribute");
  if (!messageDigest) throw new TsaVerifyError("MALFORMED", "no signed messageDigest attribute");
  const eContentHash = await sha256(eContent);
  if (!bytesEqual(messageDigest, eContentHash)) {
    throw new TsaVerifyError("DIGEST_MISMATCH", "messageDigest attr does not equal SHA-256(TSTInfo) — content substituted");
  }

  // Find the signer cert by matching SignerInfo.sid (issuer + serialNumber).
  const sidKids = readChildren(buf, sid.contentStart, sid.contentEnd);
  const sidIssuer = new Uint8Array(raw(buf, sidKids[0]!));
  const sidSerial = new Uint8Array(content(buf, sidKids[1]!));
  const signer = certs.find((c) => bytesEqual(c.issuerRaw, sidIssuer) && bytesEqual(c.serial, sidSerial));
  if (!signer) throw new TsaVerifyError("SIGNER_CERT_NOT_FOUND", "no certificate matches SignerInfo.sid");

  // Verify the signature over the DER of signedAttrs — RE-TAGGED from [0] IMPLICIT (0xA0) to SET OF
  // (0x31) per RFC 5652 §5.4. The TSA signed the SET encoding, not the tag-stolen message bytes.
  const signedAttrsDer = tlv(TAG.SET, content(buf, signedAttrs));
  const { ok, alg } = await verifyWithSpki(signer.spki, new Uint8Array(content(buf, signature)), signedAttrsDer);
  if (!ok) throw new TsaVerifyError("SIGNATURE_INVALID", "SignerInfo signature does not verify under the signer certificate");

  // Signer cert must carry the id-kp-timeStamping EKU (RFC 3161 §2.3).
  if (!signer.ekuOids.some((o) => o.length === OID.kpTimeStamping.length && OID.kpTimeStamping.every((b, i) => o[i] === b))) {
    throw new TsaVerifyError("MISSING_TIMESTAMPING_EKU", "signer cert lacks the id-kp-timeStamping Extended Key Usage");
  }

  // TSTInfo: pull genTime (default validity instant) + the bound imprint for the caller to cross-check.
  const { genTime, imprintDigestHex } = parseTstInfoFields(eContent);
  // Bind the imprint AT THE SOURCE: when the caller declares the imprint this receipt must attest, the
  // SIGNATURE-BOUND imprint must equal it — so a validly-signed receipt for a DIFFERENT document cannot
  // be replayed as ours (closes the decoy-TSTInfo vector before the seam is wired into the anchor flow).
  if (opts.expectedImprintHex !== undefined && opts.expectedImprintHex !== imprintDigestHex) {
    throw new TsaVerifyError("IMPRINT_MISMATCH", `signature binds imprint ${imprintDigestHex}, expected ${opts.expectedImprintHex}`);
  }
  const at = opts.at ?? genTime;

  // Chain the signer to a configured trust anchor, time-valid at `at`.
  const anchor = await verifyChain(signer, [...certs, ...anchors], trustAnchors, at);

  return {
    verified: true,
    reason: "verified",
    signerCn: signer.subjectCn,
    anchorCn: anchor.subjectCn,
    genTime,
    imprintDigestHex,
    signatureAlgorithm: alg,
  };
}

// TSTInfo ::= SEQUENCE { version, policy OID, messageImprint SEQUENCE{ algId, OCTET STRING digest },
//   serialNumber, genTime GeneralizedTime, ... } — extract genTime + the stamped imprint.
function parseTstInfoFields(tstInfo: Uint8Array): { genTime: Date; imprintDigestHex: string } {
  const seq = readTlv(tstInfo, 0);
  if (seq.tag !== TAG.SEQUENCE) throw new TsaVerifyError("MALFORMED", "TSTInfo: not a SEQUENCE");
  const kids = readChildren(tstInfo, seq.contentStart, seq.contentEnd);
  const imprint = kids[2];
  const genTimeT = kids[4];
  if (!imprint || imprint.tag !== TAG.SEQUENCE || !genTimeT) throw new TsaVerifyError("MALFORMED", "TSTInfo: bad messageImprint/genTime");
  const imprintKids = readChildren(tstInfo, imprint.contentStart, imprint.contentEnd);
  const digest = imprintKids[1];
  if (!digest || digest.tag !== TAG.OCTET_STRING) throw new TsaVerifyError("MALFORMED", "TSTInfo: bad imprint digest");
  return {
    genTime: parseAsn1Time(tstInfo, genTimeT),
    imprintDigestHex: bytesToHex(content(tstInfo, digest)),
  };
}
