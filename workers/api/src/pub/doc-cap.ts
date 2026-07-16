import { sign, verify } from "hono/jwt";
import { z } from "zod";

// REQ-085 (WP-09 Task 6) — the signed DOCUMENT-DOWNLOAD capability. A `/pub/documents/<cap>` link is a
// bearer-only, forwardable URL that streams ONE document's bytes from R2.
//
// WHY A TOKENIZED PROXY (not a presigned R2 URL): the Cloudflare Workers R2 BINDING exposes only
// get/put/head/delete/list/multipart — there is NO presigned-URL method on the binding. Presigned URLs are
// an S3-API feature (aws4fetch `AwsClient.sign` / the AWS SDK presigner) that needs an R2 ACCESS KEY + SECRET
// this worker is not provisioned with (Env carries only the `EVIDENCE` R2 binding, index.ts). So the ledger's
// R2 ref is fronted by a proxy the API itself serves: the authed, lens-gated resolver mints THIS cap; the
// public download route verifies it and streams `EVIDENCE.get(k)`.
//
// Mirrors pub/status-cap.ts exactly:
//  1. DOMAIN SEPARATION. MAC'd under a secret = hex(HMAC-SHA256(JWT_SECRET, DOMAIN)) — cryptographically
//     DISJOINT from JWT_SECRET (the session secret) and from the status-cap secret, so a session JWT can
//     never verify as a doc cap, and a doc cap never as a session token or status cap.
//  2. TENANT + KEY INSIDE THE MAC. `t` (tenant) and `k` (R2 object key) live in the SIGNED payload, so
//     neither is client-forgeable and neither is enumerable from the URL.
//  3. UNIFORM failure — every rejection is the SAME DocCapError, so the public read maps them all to one
//     404 with no distinguishing oracle.
//
// Pure (takes the JWT secret as an ARG, never reads c.env), so it is unit-testable and REUSABLE: this same
// `mintDocDownloadCap` is the seam the Biller (workers/agents/src/biller.ts:409, the `photos: {}` gap) can
// later call to embed a signed evidence URL in the POD evidence email — WITHOUT this task rewiring the Biller.

const DOMAIN = "shuddl-doc-download-v1";
const CAP_TYP = "doc-download";

// `.strict()` so a MAC-valid token carrying ANY extra claim is rejected; typ pinned to the literal so a
// token minted for another purpose under the same derived secret cannot pass as a doc cap.
const DocCapPayload = z
  .object({
    typ: z.literal(CAP_TYP),
    t: z.string(),
    k: z.string(),
    exp: z.number(),
  })
  .strict();

export interface DocCapClaims {
  t: string;
  k: string;
}

export class DocCapError extends Error {
  constructor() {
    super("DOC_CAP_INVALID");
    this.name = "DocCapError";
  }
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// DOC_SECRET = hex(HMAC-SHA256(key=jwtSecret, message=DOMAIN)). Deterministic in jwtSecret, so mint and
// verify derive the identical secret from the same env binding.
export async function deriveDocSecret(jwtSecret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(jwtSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(DOMAIN));
  return toHex(mac);
}

// Mint an HS256 cap. `expSeconds` is the ABSOLUTE expiry (seconds since epoch) — the caller owns the clock.
export async function mintDocDownloadCap(jwtSecret: string, args: { t: string; k: string; expSeconds: number }): Promise<string> {
  const secret = await deriveDocSecret(jwtSecret);
  return sign({ typ: CAP_TYP, t: args.t, k: args.k, exp: args.expSeconds }, secret, "HS256");
}

// Verify a cap and return {t, k}. verify() throws on a bad MAC or a past exp; the .strict() parse enforces
// typ + shape. EVERY failure surfaces as the SAME DocCapError.
export async function verifyDocDownloadCap(cap: string, jwtSecret: string): Promise<DocCapClaims> {
  const secret = await deriveDocSecret(jwtSecret);
  let payload: unknown;
  try {
    payload = await verify(cap, secret, "HS256");
  } catch {
    throw new DocCapError();
  }
  const parsed = DocCapPayload.safeParse(payload);
  if (!parsed.success) throw new DocCapError();
  return { t: parsed.data.t, k: parsed.data.k };
}
