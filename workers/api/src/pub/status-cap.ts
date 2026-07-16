import { sign, verify } from "hono/jwt";
import { z } from "zod";

// REQ-187 (WP-09, D1 half A) — the signed status-capability token. A `/pub/status/<cap>` link hands a
// bearer-only, forwardable public URL to a shipment's status page; the cap IS the authorization, so its
// integrity is the whole security model. Two properties make it safe:
//
//  1. DOMAIN SEPARATION. The cap is MAC'd under STATUS_SECRET = hex(HMAC-SHA256(JWT_SECRET, DOMAIN)) —
//     a value cryptographically DISJOINT from JWT_SECRET (the auth-session secret, middleware/auth.ts).
//     A session JWT (signed with JWT_SECRET) can therefore NEVER MAC-verify as a cap, and a cap can never
//     verify as a session token — defense in depth BEYOND the typ check below. No new secret to provision.
//  2. TENANT + SHIPMENT INSIDE THE MAC. `t` and `s` live in the signed payload, so neither is
//     client-forgeable and neither is enumerable from the outside (there is no id in the URL to increment).
//
// This module is pure-ish: it takes the JWT secret as an argument (never reads c.env), so it is unit-testable
// and callable from BOTH the authed mint route (Task 2) and the public read (verifyStatusCap, Task 3).

const DOMAIN = "shuddl-status-cap-v1";
const CAP_TYP = "status-cap";

// The signed payload. `.strict()` so a MAC-valid token carrying ANY extra claim is rejected — a real
// session JWT that somehow shared the MAC would still fail here (it carries sub/role/…). typ is pinned to
// the literal so a token minted for another purpose under the same secret cannot pass as a status cap.
const StatusCapPayload = z
  .object({
    typ: z.literal(CAP_TYP),
    t: z.string(),
    s: z.string(),
    exp: z.number(),
  })
  .strict();

export interface StatusCapClaims {
  t: string;
  s: string;
}

// A UNIFORM failure — bad MAC, expiry, wrong/absent typ, and a malformed payload all throw the SAME error
// so the public read (Task 3) can map every failure mode to one 401 with no distinguishing oracle (a
// swapped `s`, a flipped `t`, and an expired cap must be indistinguishable to a prober — REQ-187 DoD).
export class StatusCapError extends Error {
  constructor() {
    super("STATUS_CAP_INVALID");
    this.name = "StatusCapError";
  }
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// STATUS_SECRET = hex(HMAC-SHA256(key=jwtSecret, message=DOMAIN)). Async (Web Crypto). Deterministic in
// jwtSecret, so the mint and the verify derive the identical secret from the same env binding.
export async function deriveStatusSecret(jwtSecret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(jwtSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(DOMAIN));
  return toHex(mac);
}

// Mint an HS256 cap. `expSeconds` is the ABSOLUTE expiry (seconds since epoch), so mintStatusCap stays pure
// (no Date.now() inside — the caller owns the clock); the route passes now + 30 days.
export async function mintStatusCap(jwtSecret: string, args: { t: string; s: string; expSeconds: number }): Promise<string> {
  const secret = await deriveStatusSecret(jwtSecret);
  return sign({ typ: CAP_TYP, t: args.t, s: args.s, exp: args.expSeconds }, secret, "HS256");
}

// Verify a cap and return {t, s}. verify() throws on a bad MAC or a past exp (hono checks the exp claim);
// the .strict() parse enforces typ + shape. EVERY failure surfaces as the SAME StatusCapError.
export async function verifyStatusCap(cap: string, jwtSecret: string): Promise<StatusCapClaims> {
  const secret = await deriveStatusSecret(jwtSecret);
  let payload: unknown;
  try {
    payload = await verify(cap, secret, "HS256");
  } catch {
    throw new StatusCapError();
  }
  const parsed = StatusCapPayload.safeParse(payload);
  if (!parsed.success) throw new StatusCapError();
  return { t: parsed.data.t, s: parsed.data.s };
}
