// WP-13 Task 2 (REQ-102) — THE OAUTH 2.1 AUTHORIZATION SERVER (client-facing).
//
// A minimal, spec-shaped authorization_code + PKCE(S256) AS with dynamic client registration (DCR). Chosen over
// @cloudflare/workers-oauth-provider deliberately: the WP's security spine is the FAIL-CLOSED SecretResolver
// gating the token exchange (the twin of the translator's NotConfiguredSecretResolver), and a hand-rolled token
// endpoint keeps that seam injectable + deterministically testable — whereas the library takes over the whole
// worker default export with its own token store + consent UI and exposes no seam for that exact 401. The
// library remains the right migration when the interactive human-consent UI + DO-backed sessions land (a later
// task); this design keeps that door open (opaque bearer tokens, RFC-8414 metadata, PKCE S256, grants in KV).
//
// THE PAIRING IS THE CLIENT. A paired company's `mcp` pairing IS the confidential OAuth client: client_id =
// pairing id, and the client credential is the pairing's `secret_ref` resolved through the injected
// SecretResolver. So naming a pairing is not enough — the caller must present the pairing's secret to BOTH
// /register (so it cannot claim/overwrite another pairing-client's redirect_uris) AND /token, and with the
// fail-closed default NO secret ever resolves (every /register + /token 401s). The client only ever receives an
// OPAQUE access token this AS maps to the pairing; it NEVER receives the internal SessionClaims JWT (that is
// minted server-side per request in principal.ts). tenant/role are NEVER read from a client request; the grant
// records ONLY the pairing id + the VALIDATED scope (scope ⊆ server capability ∩ the pairing's own allowlist),
// so a client can influence neither the tenant, the role, nor an out-of-band scope.
import { resolveActiveMcpPairing, type SecretResolver } from "./principal.js";

export const OAUTH_METADATA_PATH = "/.well-known/oauth-authorization-server";
const AUTHORIZE_PATH = "/authorize";
const TOKEN_PATH = "/token";
const REGISTER_PATH = "/register";

// KV key namespaces. Codes are single-use + short-lived; tokens carry the session lifetime; clients persist.
const CODE_TTL_SECONDS = 60;
const TOKEN_TTL_SECONDS = 3600;
const CODE_PREFIX = "code:";
const TOKEN_PREFIX = "token:";
const CLIENT_PREFIX = "client:";

const DEFAULT_SCOPE = "mcp";
const SCOPES_SUPPORTED = [DEFAULT_SCOPE];

// The ports the OAuth ceremony needs; the composition root (index.ts) selects the fail-closed resolver, tests
// inject a static one — mirrors the translator's InboundDeps discipline (every port injected, none read inside).
export interface OAuthDeps {
  /** Control plane (pairings) — auth-resolution ONLY, never a tenant data path (REQ-025). */
  controlDb: D1Database;
  /** Authorization codes, access-token→pairing grants, and registered clients (all opaque, KV-backed). */
  grants: KVNamespace;
  /** Resolves a pairing's secret_ref → the client-secret bytes. NotConfigured (fail-closed) in prod. */
  secrets: SecretResolver;
  /** The clock (injectable for deterministic code/token expiry in tests). */
  now: () => number;
  /** The AS issuer origin, e.g. https://mcp.shuddl.com — the base for the advertised endpoints. */
  issuer: string;
}

interface RegisteredClient {
  clientId: string; // = the mcp pairing id
  redirectUris: string[];
}
interface AuthCodeRecord {
  pairingId: string;
  clientId: string;
  codeChallenge: string; // PKCE S256 challenge (base64url), verified against sha256(code_verifier) at /token
  redirectUri: string;
  scope: string;
  exp: number; // seconds
}
export interface TokenGrant {
  pairingId: string;
  scope: string;
  exp: number; // seconds
}

// ── small helpers ────────────────────────────────────────────────────────────────────────────────────────────
function json(status: number, body: unknown, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
}
// invalid_client ⇒ 401; invalid_grant / invalid_request ⇒ 400 (RFC 6749 §5.2).
function oauthError(status: number, error: string, description?: string): Response {
  return json(status, description === undefined ? { error } : { error, error_description: description });
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return prefix + base64url(bytes);
}
// PKCE S256: base64url(SHA-256(code_verifier)) (RFC 7636 §4.6).
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}
// Constant-time-ish hex/string compare (never short-circuit on the first mismatch) — the translator's discipline.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Parse a `pairings.scopes` JSON-array text (e.g. '["mcp"]') into a string[]; a malformed/absent value ⇒ [] (an
// empty allowlist grants nothing — fail-closed, never fail-open).
function parseScopeList(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

// A requested OAuth `scope` (space-delimited per RFC 6749 §3.3) is granted ONLY when EVERY token is both a server
// capability (SCOPES_SUPPORTED) AND in the pairing's own allowlist (`pairings.scopes`). An empty request grants
// nothing (no bare-token widening); an empty pairing allowlist grants nothing (fail-closed).
function scopeWithinAllowlist(requested: string, pairingScopesJson: string): boolean {
  const tokens = requested.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  const supported = new Set(SCOPES_SUPPORTED);
  const allowed = new Set(parseScopeList(pairingScopesJson));
  return tokens.every((t) => supported.has(t) && allowed.has(t));
}

async function readBody(request: Request): Promise<Record<string, string>> {
  const ctype = request.headers.get("content-type") ?? "";
  if (ctype.includes("application/json")) {
    const parsed: unknown = await request.json().catch(() => null);
    if (parsed === null || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
      else if (Array.isArray(v)) out[k] = JSON.stringify(v); // redirect_uris etc. round-trip as text
    }
    return out;
  }
  const form = await request.formData().catch(() => null);
  if (form === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") out[k] = v;
  return out;
}

// ── RFC 8414 metadata ────────────────────────────────────────────────────────────────────────────────────────
function metadata(issuer: string): Response {
  return json(200, {
    issuer,
    authorization_endpoint: `${issuer}${AUTHORIZE_PATH}`,
    token_endpoint: `${issuer}${TOKEN_PATH}`,
    registration_endpoint: `${issuer}${REGISTER_PATH}`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"], // PKCE REQUIRED — no plain, no implicit (OAuth 2.1)
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    scopes_supported: SCOPES_SUPPORTED,
  });
}

// ── dynamic client registration (RFC 7591, minimal) — AUTHENTICATED ──────────────────────────────────────────
// A client registers AGAINST an existing active `mcp` pairing (the paired company): the returned client_id IS
// the pairing id, so the whole ceremony keys off the pairing. Registering against an unknown/non-mcp/inactive
// pairing is refused (no client is created). CRITICAL: the registrant must AUTHENTICATE as the pairing owner by
// presenting the pairing's client secret (resolved via the SAME fail-closed SecretResolver /token uses) — else a
// caller who merely knows a pairing id (client_id is NOT a secret) could overwrite a pairing-client's
// redirect_uris and set up a code-delivery hijack. Without the secret — or with no secret store bound — /register
// 401s (fail-closed), symmetric with /token. The client_secret is NEVER returned in the DCR response.
async function handleRegister(request: Request, deps: OAuthDeps): Promise<Response> {
  const body = await readBody(request);
  const pairingId = body.pairing_id ?? body.client_id;
  if (pairingId === undefined || pairingId === "") return oauthError(400, "invalid_client_metadata", "pairing_id is required");

  // AUTHENTICATE the registrant as the pairing owner (the fail-closed gate — mirrors /token's client auth). F3: we
  // DO NOT pre-check the pairing's existence with a distinguishing 400 here — an unknown pairing_id and an active-
  // but-unauthenticated one both collapse to authenticateClient's single 401 invalid_client, so /register leaks no
  // pre-auth oracle for live mcp client-ids (client_id == pairing_id is a control-plane id, but need not be probeable).
  const authFailure = await authenticateClient(deps, pairingId, body.client_secret ?? "");
  if (authFailure !== null) return authFailure;

  let redirectUris: string[] = [];
  const raw = body.redirect_uris;
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) redirectUris = parsed.filter((u): u is string => typeof u === "string");
    } catch {
      redirectUris = [];
    }
  }
  if (redirectUris.length === 0) return oauthError(400, "invalid_redirect_uri", "at least one redirect_uri is required");

  const client: RegisteredClient = { clientId: pairingId, redirectUris };
  await deps.grants.put(CLIENT_PREFIX + pairingId, JSON.stringify(client));
  return json(201, {
    client_id: pairingId,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  });
}

async function loadClient(deps: OAuthDeps, clientId: string): Promise<RegisteredClient | null> {
  const raw = await deps.grants.get(CLIENT_PREFIX + clientId);
  return raw === null ? null : (JSON.parse(raw) as RegisteredClient);
}

// ── /authorize (authorization_code + PKCE) ───────────────────────────────────────────────────────────────────
// Validates the request, mints a single-use authorization code bound to (pairing, PKCE challenge, redirect_uri),
// and 302-redirects to redirect_uri?code&state. NOTE: this task ships NO human-consent UI — the real gate is the
// token exchange (the caller must present the pairing secret), so the code alone grants nothing. Any tenant/role
// query param is NEVER read: the code records only the pairing id.
async function handleAuthorize(request: Request, deps: OAuthDeps): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const responseType = q.get("response_type");
  const clientId = q.get("client_id");
  const redirectUri = q.get("redirect_uri");
  const codeChallenge = q.get("code_challenge");
  const codeChallengeMethod = q.get("code_challenge_method");
  const state = q.get("state") ?? "";
  const scope = q.get("scope") ?? DEFAULT_SCOPE;

  if (clientId === null || redirectUri === null) return oauthError(400, "invalid_request", "client_id and redirect_uri are required");
  // A registered client is required, and the redirect_uri MUST be one it registered (no open redirect).
  const client = await loadClient(deps, clientId);
  if (client === null) return oauthError(400, "invalid_request", "unknown client_id — register first");
  if (!client.redirectUris.includes(redirectUri)) return oauthError(400, "invalid_request", "redirect_uri not registered");

  // From here, errors are reported to the client VIA the redirect (RFC 6749 §4.1.2.1) since redirect_uri is trusted.
  const fail = (error: string): Response => {
    const to = new URL(redirectUri);
    to.searchParams.set("error", error);
    if (state !== "") to.searchParams.set("state", state);
    return Response.redirect(to.toString(), 302);
  };
  if (responseType !== "code") return fail("unsupported_response_type");
  if (codeChallenge === null || codeChallengeMethod !== "S256") return fail("invalid_request"); // PKCE S256 REQUIRED

  // The pairing must still be an active mcp pairing at authorize time (belt with /token's re-resolution).
  const pairing = await resolveActiveMcpPairing(deps.controlDb, clientId);
  if (pairing === null) return fail("access_denied");

  // SCOPE — the requested scope must be ⊆ the server capability AND ⊆ the pairing's own allowlist (pairings.scopes).
  // An out-of-allowlist scope is rejected (RFC 6749 invalid_scope) rather than silently stored into the grant.
  if (!scopeWithinAllowlist(scope, pairing.scopes)) return fail("invalid_scope");

  const code = randomToken("mcpc_");
  const record: AuthCodeRecord = {
    pairingId: clientId,
    clientId,
    codeChallenge,
    redirectUri,
    scope,
    exp: Math.floor(deps.now() / 1000) + CODE_TTL_SECONDS,
  };
  // expirationTtl is a REAL-clock GC belt (KV validates it against wall time); logical expiry is `record.exp`,
  // checked with deps.now() at /token — so an injected test clock never collides with KV's wall-clock validation.
  await deps.grants.put(CODE_PREFIX + code, JSON.stringify(record), { expirationTtl: CODE_TTL_SECONDS });

  const to = new URL(redirectUri);
  to.searchParams.set("code", code);
  if (state !== "") to.searchParams.set("state", state);
  return Response.redirect(to.toString(), 302);
}

// ── /token (authorization_code exchange) ─────────────────────────────────────────────────────────────────────
// Order is deliberate: consume the code (single-use) → authenticate the CONFIDENTIAL CLIENT via the fail-closed
// SecretResolver (this is where NotConfigured makes EVERY exchange 401 — the security spine) → verify PKCE →
// issue an opaque access token mapped to the pairing. tenant/role are never read.
async function handleToken(request: Request, deps: OAuthDeps): Promise<Response> {
  const body = await readBody(request);
  if (body.grant_type !== "authorization_code") return oauthError(400, "unsupported_grant_type");

  const code = body.code;
  const clientId = body.client_id;
  const redirectUri = body.redirect_uri;
  const codeVerifier = body.code_verifier;
  const clientSecret = body.client_secret ?? "";
  if (code === undefined || clientId === undefined || redirectUri === undefined || codeVerifier === undefined) {
    return oauthError(400, "invalid_request", "code, client_id, redirect_uri, code_verifier are required");
  }

  // Consume the single-use code up front (delete regardless of what follows, so a code never survives a failed try).
  const rawCode = await deps.grants.get(CODE_PREFIX + code);
  await deps.grants.delete(CODE_PREFIX + code);
  if (rawCode === null) return oauthError(400, "invalid_grant", "unknown or expired code");
  const record = JSON.parse(rawCode) as AuthCodeRecord;
  if (record.exp < Math.floor(deps.now() / 1000)) return oauthError(400, "invalid_grant", "expired code");
  if (record.clientId !== clientId) return oauthError(400, "invalid_grant", "client_id mismatch");
  if (record.redirectUri !== redirectUri) return oauthError(400, "invalid_grant", "redirect_uri mismatch");

  // CLIENT AUTHENTICATION — the FAIL-CLOSED gate. Resolve the pairing's secret; NotConfigured ⇒ null ⇒ 401 for
  // every environment until the CONFIRM-gated secret store is bound. The confidential client must present the
  // matching secret (timing-safe). This runs BEFORE PKCE so an unwired env 401s (never a 400) — the task's
  // "the token exchange 401s (no principal minted)" contract.
  const authFailure = await authenticateClient(deps, record.pairingId, clientSecret);
  if (authFailure !== null) return authFailure;

  // PKCE — proof of possession of the code_verifier (RFC 7636). A mismatch is invalid_grant (400).
  if (!timingSafeEqual(record.codeChallenge, await s256(codeVerifier))) return oauthError(400, "invalid_grant", "PKCE verification failed");

  // Issue the opaque access token and record the token→pairing grant. The ONLY things persisted are the pairing
  // id + the ALREADY-VALIDATED scope (checked ⊆ allowlist at /authorize) — never a client-chosen tenant/role.
  const accessToken = randomToken("mcpt_");
  const grant: TokenGrant = {
    pairingId: record.pairingId,
    scope: record.scope,
    exp: Math.floor(deps.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  await deps.grants.put(TOKEN_PREFIX + accessToken, JSON.stringify(grant), { expirationTtl: TOKEN_TTL_SECONDS });
  return json(
    200,
    { access_token: accessToken, token_type: "Bearer", expires_in: TOKEN_TTL_SECONDS, scope: record.scope },
    { "cache-control": "no-store", pragma: "no-cache" },
  );
}

// The pairing's secret_ref (the resolver's input). Read separately from resolveActiveMcpPairing to keep that
// helper's surface to what the principal mint needs; secret_ref is auth-only and never leaves this module.
async function pairingSecretRef(db: D1Database, pairingId: string): Promise<string> {
  const row = await db.prepare("SELECT secret_ref FROM pairings WHERE id = ?1 AND kind = 'mcp' LIMIT 1").bind(pairingId).first<{ secret_ref: string }>();
  return row?.secret_ref ?? "";
}

// THE FAIL-CLOSED CLIENT-AUTHENTICATION gate, shared by /register and /token. The pairing must still be active,
// and the presented client_secret must equal the pairing's secret resolved through the SecretResolver. Returns
// null on success, or ONE indistinguishable 401 invalid_client on ANY failure — an inactive/unknown pairing, an
// unresolvable secret (NotConfigured ⇒ null ⇒ fail-closed everywhere), an empty secret, or a mismatch all yield
// the SAME status + body (F3: no pre-auth enumeration oracle for live mcp client-ids). Timing-safe compare.
async function authenticateClient(deps: OAuthDeps, pairingId: string, presentedSecret: string): Promise<Response | null> {
  const denied = oauthError(401, "invalid_client");
  const pairing = await resolveActiveMcpPairing(deps.controlDb, pairingId);
  if (pairing === null) return denied;
  const expected = await deps.secrets.resolve(await pairingSecretRef(deps.controlDb, pairingId));
  if (expected === null || expected === "") return denied;
  if (!timingSafeEqual(expected, presentedSecret)) return denied;
  return null;
}

/**
 * Resolve an opaque access token → its pairing grant (the MCP session→pairing mapping), or null if unknown or
 * EXPIRED. Enforces grant.exp against the injected clock (not merely KV TTL) so a still-present record past its
 * lifetime never authorizes an MCP session — mirrors the code path's expiry check.
 */
export async function resolveTokenGrant(
  grants: KVNamespace,
  accessToken: string,
  now: () => number = () => Date.now(),
): Promise<TokenGrant | null> {
  const raw = await grants.get(TOKEN_PREFIX + accessToken);
  if (raw === null) return null;
  const grant = JSON.parse(raw) as TokenGrant;
  if (grant.exp <= Math.floor(now() / 1000)) return null; // expired — fail-closed even if KV still holds it
  return grant;
}

/**
 * THE OAuth router. Returns a Response for an OAuth path, or null if the request is not an OAuth request (so the
 * caller can fall through to its own handling). Every OAuth surface is here; there is no OAuth logic elsewhere.
 */
export async function handleOAuth(request: Request, deps: OAuthDeps): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const method = request.method.toUpperCase();

  if (pathname === OAUTH_METADATA_PATH && method === "GET") return metadata(deps.issuer);
  if (pathname === REGISTER_PATH && method === "POST") return handleRegister(request, deps);
  if (pathname === AUTHORIZE_PATH && method === "GET") return handleAuthorize(request, deps);
  if (pathname === TOKEN_PATH && method === "POST") return handleToken(request, deps);
  return null;
}
