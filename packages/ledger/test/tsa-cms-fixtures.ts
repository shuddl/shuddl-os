// SYNTHETIC test fixtures for the RFC-3161 CMS/X.509 verifier (REQ-014, WP-16). These mint a
// SELF-GENERATED test CA + TSA signer cert and a CMS-signed granted TimeStampResp through the REAL
// DER encoder (der.ts primitives) so the tests drive the REAL parser + verifier — mirroring
// FakeTsaClient's "build through the real encoder" discipline, extended to signatures.
//
// NOT A REAL AUTHORITY. Every key here is generated at test time by Web Crypto; the CN is the literal
// string "SHUDDL Test <role>". No real TSA, CA, tenant, person, or vendor name appears (REQ-167 clean).
// The real RFC-3161 trust anchors are DEPLOYMENT CONFIG (out-of-repo F1 CONFIRM), never committed here.

import { concat, encodeDerInteger, explicit, generalizedTime, TAG, tlv } from "../src/tsa/der.js";

// OIDs (DER content bytes).
const OID_SHA256 = Uint8Array.from([0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);
const OID_RSA_ENCRYPTION = Uint8Array.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
const OID_SHA256_WITH_RSA = Uint8Array.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]);
const OID_ECDSA_WITH_SHA256 = Uint8Array.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]);
const OID_SIGNED_DATA = Uint8Array.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]);
const OID_CT_TSTINFO = Uint8Array.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x04]);
const OID_CONTENT_TYPE = Uint8Array.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x03]);
const OID_MESSAGE_DIGEST = Uint8Array.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04]);
const OID_EXT_KEY_USAGE = Uint8Array.from([0x55, 0x1d, 0x25]);
const OID_BASIC_CONSTRAINTS = Uint8Array.from([0x55, 0x1d, 0x13]);
const OID_KP_TIMESTAMPING = Uint8Array.from([0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x08]);
const OID_COMMON_NAME = Uint8Array.from([0x55, 0x04, 0x03]);
const OID_TSA_POLICY = Uint8Array.from([0x2a, 0x03, 0x04, 0x01]); // 1.2.3.4.1 placeholder

const oid = (bytes: Uint8Array): Uint8Array => tlv(TAG.OID, bytes);
const octet = (bytes: Uint8Array): Uint8Array => tlv(TAG.OCTET_STRING, bytes);
const bool = (b: boolean): Uint8Array => tlv(TAG.BOOLEAN, Uint8Array.from([b ? 0xff : 0x00]));
const seq = (...parts: Uint8Array[]): Uint8Array => tlv(TAG.SEQUENCE, concat(parts));
const set = (...parts: Uint8Array[]): Uint8Array => tlv(TAG.SET, concat(parts));
const bitString = (bytes: Uint8Array): Uint8Array => tlv(0x03, concat([Uint8Array.from([0x00]), bytes]));

function algId(algOid: Uint8Array, withNull = true): Uint8Array {
  return withNull ? seq(oid(algOid), tlv(TAG.NULL, new Uint8Array(0))) : seq(oid(algOid));
}

function derName(cn: string): Uint8Array {
  return seq(set(seq(oid(OID_COMMON_NAME), tlv(0x13 /* PrintableString */, new TextEncoder().encode(cn)))));
}

function extension(extnId: Uint8Array, critical: boolean, valueDer: Uint8Array): Uint8Array {
  return seq(oid(extnId), bool(critical), octet(valueDer));
}

const RSA_ALGO = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" } as const;

export interface TestKeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  spki: Uint8Array; // subjectPublicKeyInfo DER
}

export async function generateRsaKeyPair(): Promise<TestKeyPair> {
  const kp = (await crypto.subtle.generateKey(RSA_ALGO, true, ["sign", "verify"])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, spki };
}

async function rsaSign(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data as BufferSource));
}

const EC_ALGO = { name: "ECDSA", namedCurve: "P-256" } as const;

export async function generateEcKeyPair(): Promise<TestKeyPair> {
  const kp = (await crypto.subtle.generateKey(EC_ALGO, true, ["sign", "verify"])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, spki };
}

// A DER INTEGER (non-negative) from raw magnitude bytes, minimal + sign-padded.
function derIntegerFromBytes(b: Uint8Array): Uint8Array {
  let off = 0;
  while (off < b.length - 1 && b[off] === 0x00) off += 1;
  let body = b.subarray(off);
  if ((body[0]! & 0x80) !== 0) body = concat([Uint8Array.from([0x00]), body]);
  return tlv(TAG.INTEGER, body);
}

// Web Crypto emits an ECDSA signature as fixed-width IEEE-P1363 r‖s; X.509/CMS want the DER
// ECDSA-Sig-Value SEQUENCE{ r INTEGER, s INTEGER }. Convert (the inverse of the verifier's helper).
async function ecdsaSignDer(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const p1363 = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data as BufferSource));
  return seq(derIntegerFromBytes(p1363.subarray(0, 32)), derIntegerFromBytes(p1363.subarray(32, 64)));
}

export type SignAlg = "rsa" | "ecdsa";

async function signBytes(alg: SignAlg, key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return alg === "ecdsa" ? ecdsaSignDer(key, data) : rsaSign(key, data);
}

// The AlgorithmIdentifier for a signature: sha256WithRSAEncryption (NULL params) or ecdsa-with-SHA256 (none).
function sigAlgId(alg: SignAlg): Uint8Array {
  return alg === "ecdsa" ? algId(OID_ECDSA_WITH_SHA256, false) : algId(OID_SHA256_WITH_RSA, true);
}

export interface CertOpts {
  serial: number;
  subjectCn: string;
  issuerCn: string;
  subjectSpki: Uint8Array;
  notBefore: Date;
  notAfter: Date;
  issuerKey: CryptoKey; // signs the tbsCertificate
  extensions?: Uint8Array[] | undefined; // pre-built Extension SEQUENCEs
  signAlg?: SignAlg | undefined; // issuer's signature algorithm (default rsa)
}

// Build + CA-sign an X.509 v3 certificate over the tbsCertificate (RSA-PKCS1-SHA256 or ECDSA-P256-SHA256).
export async function buildCertificate(opts: CertOpts): Promise<Uint8Array> {
  const alg = opts.signAlg ?? "rsa";
  const version = explicit(0, encodeDerInteger(2)); // v3
  const validity = seq(generalizedTime(opts.notBefore), generalizedTime(opts.notAfter));
  const extBlock = opts.extensions && opts.extensions.length > 0 ? [explicit(3, seq(...opts.extensions))] : [];
  const tbs = seq(
    version,
    encodeDerInteger(opts.serial),
    sigAlgId(alg),
    derName(opts.issuerCn),
    validity,
    derName(opts.subjectCn),
    opts.subjectSpki, // SPKI is already a complete SEQUENCE from exportKey("spki")
    ...extBlock,
  );
  const sig = await signBytes(alg, opts.issuerKey, tbs);
  return seq(tbs, sigAlgId(alg), bitString(sig));
}

export function ekuTimestampingExtension(): Uint8Array {
  return extension(OID_EXT_KEY_USAGE, true, seq(oid(OID_KP_TIMESTAMPING)));
}

export function basicConstraintsCaExtension(): Uint8Array {
  return extension(OID_BASIC_CONSTRAINTS, true, seq(bool(true)));
}

// A self-signed test CA (root trust anchor). Returns { der, keyPair }.
export async function buildTestCa(opts: { cn: string; keyPair: TestKeyPair; notBefore: Date; notAfter: Date; serial?: number; signAlg?: SignAlg | undefined }): Promise<Uint8Array> {
  return buildCertificate({
    serial: opts.serial ?? 1,
    subjectCn: opts.cn,
    issuerCn: opts.cn, // self-signed
    subjectSpki: opts.keyPair.spki,
    notBefore: opts.notBefore,
    notAfter: opts.notAfter,
    issuerKey: opts.keyPair.privateKey,
    extensions: [basicConstraintsCaExtension()],
    signAlg: opts.signAlg,
  });
}

// A TSA signer cert issued by the test CA. Includes the timestamping EKU unless withTimestampingEku=false.
export async function buildSignerCert(opts: {
  cn: string;
  caCn: string;
  signerSpki: Uint8Array;
  caKey: CryptoKey;
  notBefore: Date;
  notAfter: Date;
  serial?: number;
  withTimestampingEku?: boolean;
  signAlg?: SignAlg | undefined; // the CA's signature algorithm
}): Promise<Uint8Array> {
  const exts: Uint8Array[] = [];
  if (opts.withTimestampingEku ?? true) exts.push(ekuTimestampingExtension());
  return buildCertificate({
    serial: opts.serial ?? 2,
    subjectCn: opts.cn,
    issuerCn: opts.caCn,
    subjectSpki: opts.signerSpki,
    notBefore: opts.notBefore,
    notAfter: opts.notAfter,
    issuerKey: opts.caKey,
    extensions: exts,
    signAlg: opts.signAlg,
  });
}

function messageImprint(imprint: Uint8Array): Uint8Array {
  return seq(algId(OID_SHA256), octet(imprint));
}

function buildTstInfo(imprint: Uint8Array, nonce: number | bigint, genTime: Date): Uint8Array {
  return seq(
    encodeDerInteger(1), // version
    oid(OID_TSA_POLICY),
    messageImprint(imprint),
    encodeDerInteger(1), // serialNumber
    generalizedTime(genTime),
    encodeDerInteger(nonce),
  );
}

// DER SET OF requires canonical (sorted-by-encoding) element order. Sort the attribute encodings.
function sortSetOf(elements: Uint8Array[]): Uint8Array[] {
  return [...elements].sort((a, b) => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
  });
}

export interface SignedRespOpts {
  imprint: Uint8Array;
  nonce: number | bigint;
  genTime: Date;
  signerKey: CryptoKey; // signs the signedAttrs
  signerCertDer: Uint8Array; // embedded in SignedData.certificates
  signerCn: string; // used to build the sid issuer name
  caCn: string; // signer cert's issuer CN — the sid issuer
  signerSerial?: number; // must match the signer cert serial (default 2)
  /** Override the messageDigest attr value (to test digest-mismatch); the signature stays valid over it. */
  messageDigestOverride?: Uint8Array;
  /** Flip a byte of the signature after signing (to test tamper detection). */
  tamperSignature?: boolean;
  /** The signer's signature algorithm over signedAttrs (default rsa). */
  signAlg?: SignAlg | undefined;
}

// Build a granted TimeStampResp whose SignedData carries a populated SignerInfo (signedAttrs +
// signature) and the signer certificate — the REAL CMS shape the WP-16 verifier consumes.
export async function buildSignedGrantedResp(opts: SignedRespOpts): Promise<Uint8Array> {
  const tstInfo = buildTstInfo(opts.imprint, opts.nonce, opts.genTime);

  const digest = opts.messageDigestOverride ?? new Uint8Array(await crypto.subtle.digest("SHA-256", tstInfo as BufferSource));

  const contentTypeAttr = seq(oid(OID_CONTENT_TYPE), set(oid(OID_CT_TSTINFO)));
  const messageDigestAttr = seq(oid(OID_MESSAGE_DIGEST), set(octet(digest)));
  const sortedAttrs = sortSetOf([contentTypeAttr, messageDigestAttr]);

  const alg = opts.signAlg ?? "rsa";
  // Signed bytes: signedAttrs DER-encoded as a SET OF (0x31), per RFC 5652 §5.4.
  const signedAttrsForSigning = tlv(TAG.SET, concat(sortedAttrs));
  let signature = await signBytes(alg, opts.signerKey, signedAttrsForSigning);
  if (opts.tamperSignature) {
    signature = new Uint8Array(signature);
    const li = signature.length - 1;
    signature[li] = (signature[li] ?? 0) ^ 0x01;
  }
  // In the message the same attributes appear tagged [0] IMPLICIT (0xA0).
  const signedAttrsInMessage = tlv(0xa0, concat(sortedAttrs));

  const sid = seq(derName(opts.caCn), encodeDerInteger(opts.signerSerial ?? 2)); // issuerAndSerialNumber
  const signerInfo = seq(
    encodeDerInteger(1), // version (issuerAndSerialNumber => 1)
    sid,
    algId(OID_SHA256), // digestAlgorithm
    signedAttrsInMessage,
    alg === "ecdsa" ? algId(OID_ECDSA_WITH_SHA256, false) : algId(OID_RSA_ENCRYPTION), // signatureAlgorithm
    octet(signature),
  );

  const encapContentInfo = seq(oid(OID_CT_TSTINFO), explicit(0, octet(tstInfo)));
  const certificates = tlv(0xa0, opts.signerCertDer); // [0] IMPLICIT certificates (just the signer)
  const signedData = seq(
    encodeDerInteger(3), // version
    set(algId(OID_SHA256)), // digestAlgorithms
    encapContentInfo,
    certificates,
    set(signerInfo), // signerInfos
  );

  const contentInfo = seq(oid(OID_SIGNED_DATA), explicit(0, signedData));
  const pkiStatusInfo = seq(encodeDerInteger(0)); // granted
  return seq(pkiStatusInfo, contentInfo);
}
