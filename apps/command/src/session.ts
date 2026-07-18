// REQ-081 — the COMMAND surface's browser session. It holds the TENANT-lens JWT minted by a WP-14 magic
// link and exposes the claims the UI reads to scope its chrome. Unlike the portal (a party-scoped bearer),
// a command user is a tenant operator: the role is one of admin/ops/finance/read and there is NO party_id
// (the server lens is `1=1` for these roles — the tenant, not one party, is the scope). Three hard rules:
//
//   1. NEVER verify the token client-side — there is no secret on the client, so the server lens is the
//      only real gate (REQ-030). `getClaims` decodes the payload for DISPLAY/SCOPING ONLY (which role's
//      affordances to render, which tenant to label). A client claim is never trusted for security.
//   2. Every accessor degrades cleanly to "no session" so the api client keeps its token-less shape.
//   3. A magic-link token arrives as `?token=` on first load. We adopt it, persist it (localStorage), and
//      STRIP it from the URL so the bearer can never linger in browser history or a copied/shared link.
//
// This mirrors the portal's session singleton discipline (apps/portal/src/session.ts); the only surface
// difference is the storage key and that a command claim carries no party_id.
import { SessionClaims } from "@shuddl/contracts";

const STORAGE_KEY = "shuddl.command.token";
const TOKEN_PARAM = "token";

// localStorage is the durable per-origin store for the token (the "singleton"). Access is guarded:
// a privacy mode can throw on access, and SSR/non-browser contexts have no localStorage at all.
function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The raw bearer token, or null when there is no session. */
export function getToken(): string | null {
  return store()?.getItem(STORAGE_KEY) ?? null;
}

/** Persist a token (from the magic link, or a future explicit login). */
export function setToken(token: string): void {
  store()?.setItem(STORAGE_KEY, token);
}

/** Drop the session — logout, or a 401 from the api client. */
export function clear(): void {
  store()?.removeItem(STORAGE_KEY);
}

// Decode ONE base64url JWT segment to its UTF-8 string. base64url → base64, re-pad to a multiple of 4,
// then atob + TextDecoder (so multi-byte claim values survive). This does NOT verify anything.
function base64UrlDecode(segment: string): string {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * The decoded, UNVERIFIED session claims (tenant, role, sub — no party_id for a command user) for UI
 * scoping, or null when there is no token, the token is malformed, or the payload is not shaped like
 * SessionClaims. The server verifies the signature and re-derives these on every request; the client
 * only reads them to render the right chrome.
 */
export function getClaims(): SessionClaims | null {
  const token = getToken();
  if (!token) return null;
  const parts = token.split(".");
  const payload = parts.length === 3 ? parts[1] : undefined;
  if (!payload) return null;
  try {
    const json: unknown = JSON.parse(base64UrlDecode(payload));
    const parsed = SessionClaims.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Whether there is a usable session: a decodable token whose `exp` is still in the future. Expiry is read
 * from the (unverified) claim purely so the UI can pre-empt an obvious re-auth; the server remains the real
 * arbiter and will 401 an actually-expired token regardless of what the client believes.
 */
export function isAuthed(): boolean {
  const claims = getClaims();
  if (!claims) return false;
  return claims.exp * 1000 > Date.now();
}

/**
 * On first load, adopt a `?token=` magic-link token: persist it and STRIP it from the URL (so the bearer
 * never lingers in history or a shared link), preserving any other query params and the hash. Returns the
 * adopted token, or null when the URL carried none (the normal case for a returning visitor).
 */
export function adoptTokenFromUrl(): string | null {
  const loc = globalThis.location;
  if (!loc) return null;
  const url = new URL(loc.href);
  const token = url.searchParams.get(TOKEN_PARAM);
  if (!token) return null;
  setToken(token);
  url.searchParams.delete(TOKEN_PARAM);
  globalThis.history?.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return token;
}
