// RFC 3161 Time-Stamp Authority client (REQ-014). The daily anchor hands the TSA a message imprint
// (a 32-byte SHA-256 digest binding the day's Merkle root) and gets back a signed `.tsr` receipt that
// third parties can later verify: proof that the ledger's state for day D existed at a known instant,
// witnessed by an independent authority. That receipt is the evidentiary spine of "a signature at a
// door was seen by someone other than us."
//
// A client's job is protocol correctness: send a nonce, and REFUSE any response that isn't `granted`,
// that stamps a different imprint, or that echoes a different nonce (a replayed/substituted receipt).
// CMS signature + cert-chain verification is deferred to WP-16 (Decision 15) — the raw bytes are kept
// in R2 so that verification can run offline later, forever.
//
// PURE of I/O except the injected fetch; no LLM (REQ-024).

import { bytesToHex } from "../merkle.js";
import { buildGrantedTimeStampResp, encodeTimeStampReq, parseTimeStampResp } from "./der.js";

export interface TsaClient {
  /** Stamp a 32-byte message imprint; resolves to the raw DER `.tsr` receipt bytes (verified granted). */
  timestamp(imprint: Uint8Array): Promise<Uint8Array>;
}

export interface TsaConfig {
  /** RFC 3161 HTTP endpoint. */
  url: string;
}

// A cryptographically-random 63-bit nonce (top bit clear so it stays a modest positive integer; the
// DER encoder still handles the high-bit pad for any value the TSA might echo).
function randomNonce(): bigint {
  const b = crypto.getRandomValues(new Uint8Array(8));
  let n = 0n;
  for (const byte of b) n = (n << 8n) | BigInt(byte);
  return n & 0x7fffffffffffffffn;
}

function nonceHex(n: bigint): string {
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  return hex === "" ? "00" : hex;
}

// Reject anything that isn't a granted receipt echoing OUR imprint and nonce. Throws on mismatch so a
// forged/substituted receipt can never be persisted as an anchor.
export function assertGrantedReceipt(respBytes: Uint8Array, imprint: Uint8Array, nonce: bigint): void {
  const parsed = parseTimeStampResp(respBytes);
  if (!parsed.granted) throw new Error(`TSA_NOT_GRANTED: status=${parsed.status}`);
  const wantImprint = bytesToHex(imprint);
  if (parsed.imprintDigestHex !== wantImprint) {
    throw new Error(`TSA_IMPRINT_MISMATCH: sent ${wantImprint} got ${parsed.imprintDigestHex ?? "none"}`);
  }
  if (parsed.nonceHex !== nonceHex(nonce)) {
    throw new Error(`TSA_NONCE_MISMATCH: sent ${nonceHex(nonce)} got ${parsed.nonceHex ?? "none"}`);
  }
}

export class HttpTsaClient implements TsaClient {
  constructor(
    private readonly config: TsaConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async timestamp(imprint: Uint8Array): Promise<Uint8Array> {
    const nonce = randomNonce();
    const req = encodeTimeStampReq({ digestHex: bytesToHex(imprint), nonce });
    const res = await this.fetchImpl(this.config.url, {
      method: "POST",
      headers: { "Content-Type": "application/timestamp-query" },
      body: req as BodyInit,
    });
    if (!res.ok) throw new Error(`TSA_HTTP_${res.status}`);
    const respBytes = new Uint8Array(await res.arrayBuffer());
    assertGrantedReceipt(respBytes, imprint, nonce);
    return respBytes;
  }
}

// A deterministic-shape fake that builds a granted response through the REAL der encoder, so tests
// drive the REAL parser + verifier — not a mock that could paper over an encoding bug.
export class FakeTsaClient implements TsaClient {
  constructor(private readonly opts: { genTime?: Date } = {}) {}

  async timestamp(imprint: Uint8Array): Promise<Uint8Array> {
    const nonce = randomNonce();
    const resp = buildGrantedTimeStampResp(imprint, nonce, this.opts.genTime ?? new Date("2026-01-01T00:00:00Z"));
    assertGrantedReceipt(resp, imprint, nonce); // exercise the real verify path
    return resp;
  }
}

// A TSA that always fails — for tests and for a prod deployment with no configured endpoint (the
// anchor then leaves the day unanchored and escalates after repeated failures).
export class UnavailableTsaClient implements TsaClient {
  constructor(private readonly reason = "TSA_UNCONFIGURED") {}
  timestamp(imprint: Uint8Array): Promise<Uint8Array> {
    void imprint; // signature parity with TsaClient; this client never stamps
    return Promise.reject(new Error(this.reason));
  }
}
