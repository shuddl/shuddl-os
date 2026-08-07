import { env } from "cloudflare:test";
import { decode } from "hono/jwt";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { NotConfiguredSecretResolver, StaticSecretResolver, mintPrincipalJwt } from "../src/principal.js";
import {
  handleOAuth,
  resolveTokenGrant,
  OAUTH_METADATA_PATH,
  type OAuthDeps,
} from "../src/oauth.js";
import { applyControl, seedPairing, seedTenant } from "./helpers.js";

// WP-13 Task 2 (REQ-102) — THE OAUTH 2.1 AUTHORIZATION SERVER (authorization_code + PKCE/S256 + DCR).
//
// A paired company's `mcp` pairing IS the confidential OAuth client: client_id = pairing id, and the client
// credential is the pairing's `secret_ref` resolved through the injected fail-closed SecretResolver (the twin
// of the translator's NotConfiguredSecretResolver). BOTH /register and /token authenticate the client with that
// secret, so knowing a pairing id (not a secret) grants nothing. The client NEVER receives the internal
// SessionClaims JWT — only an opaque access token this AS maps to the pairing. tenant/role are DERIVED from the
// pairing row and can never be influenced by the client; the requested scope is validated against the server
// capability AND the pairing's own scopes allowlist.

const ISSUER = "https://mcp.shuddl.test";
const PAIRING = "prn-oauth";
const PAIRING_NOSCOPE = "prn-oauth-noscope";
const TENANT_ID = "t-oauth";
const TENANT_SLUG = "tenant-oauth";
const SECRET_REF = "mcp-secret-ref-oauth";
const SECRET_REF_NOSCOPE = "mcp-secret-ref-noscope";
const CLIENT_SECRET = "mcp-client-secret-do-not-use-in-prod";
const REDIRECT_URI = "https://client.example/callback";
const T0 = 1_760_000_000_000;

function goodSecrets(): StaticSecretResolver {
  return new StaticSecretResolver({ [SECRET_REF]: CLIENT_SECRET, [SECRET_REF_NOSCOPE]: CLIENT_SECRET });
}
function deps(secrets: { resolve(ref: string): Promise<string | null> }, now = () => T0): OAuthDeps {
  return { controlDb: env.CONTROL_DB, grants: env.GRANTS, secrets, now, issuer: ISSUER };
}

// ── PKCE S256 helpers ──────────────────────────────────────────────────────────────────────────────────────
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function challengeFor(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(d));
}

// ── ceremony drivers (against an injected deps) ──────────────────────────────────────────────────────────────
async function register(
  d: OAuthDeps,
  pairingId: string,
  opts: { redirectUris?: string[]; clientSecret?: string | undefined } = {},
): Promise<Response> {
  const bodyObj: Record<string, unknown> = {
    pairing_id: pairingId,
    redirect_uris: opts.redirectUris ?? [REDIRECT_URI],
  };
  // client_secret is included by default (authenticated DCR); a test drops it by passing { clientSecret: undefined }.
  if (!("clientSecret" in opts)) bodyObj.client_secret = CLIENT_SECRET;
  else if (opts.clientSecret !== undefined) bodyObj.client_secret = opts.clientSecret;
  return handleOAuth(
    new Request(`${ISSUER}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bodyObj),
    }),
    d,
  ) as Promise<Response>;
}
async function authorize(d: OAuthDeps, params: Record<string, string>): Promise<Response> {
  const url = new URL(`${ISSUER}/authorize`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return handleOAuth(new Request(url.toString(), { method: "GET", redirect: "manual" }), d) as Promise<Response>;
}
async function token(d: OAuthDeps, form: Record<string, string>): Promise<Response> {
  const body = new URLSearchParams(form);
  return handleOAuth(
    new Request(`${ISSUER}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }),
    d,
  ) as Promise<Response>;
}
function codeFromRedirect(res: Response): string {
  const loc = res.headers.get("location");
  if (loc === null) throw new Error(`authorize did not redirect (status ${res.status})`);
  const code = new URL(loc).searchParams.get("code");
  if (code === null) throw new Error(`no code in redirect: ${loc}`);
  return code;
}
// Standard authorize params for PAIRING with a given PKCE challenge (+ optional extras/overrides).
function authParams(challenge: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    response_type: "code",
    client_id: PAIRING,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s",
    ...extra,
  };
}

beforeAll(async () => {
  await applyControl(env.CONTROL_DB);
  await seedTenant(env.CONTROL_DB, TENANT_ID, TENANT_SLUG);
  // PAIRING grants the "mcp" scope; PAIRING_NOSCOPE grants NOTHING (empty allowlist) to prove the pairing dimension.
  await seedPairing(env.CONTROL_DB, {
    id: PAIRING,
    tenantId: TENANT_ID,
    kind: "mcp",
    secretRef: SECRET_REF,
    status: "active",
    scopes: '["mcp"]',
  });
  await seedPairing(env.CONTROL_DB, {
    id: PAIRING_NOSCOPE,
    tenantId: TENANT_ID,
    kind: "mcp",
    secretRef: SECRET_REF_NOSCOPE,
    status: "active",
    scopes: "[]",
  });
});

describe("AS metadata (RFC 8414) is served and wired into the worker fetch", () => {
  it("the well-known metadata endpoint returns a valid AS document (through the worker's default fetch)", async () => {
    const res = await worker.fetch(new Request(`${ISSUER}${OAUTH_METADATA_PATH}`), env);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.issuer).toBeDefined();
    expect(meta.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(meta.token_endpoint).toBe(`${ISSUER}/token`);
    expect(meta.registration_endpoint).toBe(`${ISSUER}/register`);
    expect(meta.code_challenge_methods_supported).toContain("S256");
    expect(meta.grant_types_supported).toContain("authorization_code");
    expect(meta.response_types_supported).toContain("code");
  });
});

describe("dynamic client registration (DCR) is authenticated by the pairing secret", () => {
  it("registering with the CORRECT client_secret returns client_id = pairing id (201)", async () => {
    const res = await register(deps(goodSecrets()), PAIRING);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string; redirect_uris: string[] };
    expect(body.client_id).toBe(PAIRING);
    expect(body.redirect_uris).toContain(REDIRECT_URI);
  });

  it("an UNAUTHENTICATED /register (no client_secret) for an active pairing → 401 (no client created/overwritten)", async () => {
    // RED before the fix: today this returns 201 and OVERWRITES the pairing-client's redirect_uris (hijack primitive).
    const res = await register(deps(goodSecrets()), PAIRING, { clientSecret: undefined });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client");
  });

  it("a /register with a WRONG client_secret → 401", async () => {
    const res = await register(deps(goodSecrets()), PAIRING, { clientSecret: "not-the-secret" });
    expect(res.status).toBe(401);
  });

  it("an UNKNOWN pairing_id is INDISTINGUISHABLE from an active-but-unauthenticated one (both 401 invalid_client) — no enumeration oracle", async () => {
    // F3 (RED before the fix): an unknown pairing returned a distinguishing 400 invalid_client_metadata while an
    // ACTIVE pairing with a bad secret returned 401 invalid_client — a pre-auth oracle for live mcp client-ids.
    const unknown = await register(deps(goodSecrets()), "prn-nope", { clientSecret: "garbage" });
    const activeWrongSecret = await register(deps(goodSecrets()), PAIRING, { clientSecret: "garbage" });

    expect(unknown.status).toBe(401);
    expect(activeWrongSecret.status).toBe(401);
    const unknownBody = (await unknown.json()) as { error: string };
    const activeBody = (await activeWrongSecret.json()) as { error: string };
    expect(unknownBody.error).toBe("invalid_client");
    // Byte-identical status AND body — an attacker cannot tell a real active mcp pairing from an invalid id.
    expect(unknownBody).toEqual(activeBody);
  });

  it("with the NotConfigured resolver /register fails closed (401) exactly like /token", async () => {
    const res = await register(deps(new NotConfiguredSecretResolver()), PAIRING);
    expect(res.status).toBe(401);
  });
});

describe("authorization_code + PKCE round-trip", () => {
  it("a valid code→token exchange (correct verifier + client_secret) issues an opaque access token mapped to the pairing", async () => {
    const d = deps(goodSecrets());
    await register(d, PAIRING);
    const verifier = "verifier-0123456789-abcdefghijklmnopqrstuvwxyz-ABCDEFG";
    const challenge = await challengeFor(verifier);

    const authRes = await authorize(d, authParams(challenge, { state: "state-xyz" }));
    expect(authRes.status).toBe(302);
    expect(new URL(authRes.headers.get("location") as string).searchParams.get("state")).toBe("state-xyz");
    const code = codeFromRedirect(authRes);

    const tokRes = await token(d, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: PAIRING,
      code_verifier: verifier,
      client_secret: CLIENT_SECRET,
    });
    expect(tokRes.status).toBe(200);
    const tok = (await tokRes.json()) as { access_token: string; token_type: string; expires_in: number };
    expect(tok.token_type).toBe("Bearer");
    expect(tok.access_token.length).toBeGreaterThan(16);
    // The access token is OPAQUE and NOT the internal SessionClaims JWT (a JWT has two dots; this must not).
    expect(tok.access_token.split(".").length).toBe(1);

    // The AS maps the token to the pairing — resolved under the SAME clock the grant was minted with.
    const grant = await resolveTokenGrant(env.GRANTS, tok.access_token, () => T0);
    expect(grant?.pairingId).toBe(PAIRING);
  });

  it("a MISMATCHED PKCE verifier is rejected (400) — no token issued", async () => {
    const d = deps(goodSecrets());
    await register(d, PAIRING);
    const challenge = await challengeFor("the-real-verifier-aaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    const authRes = await authorize(d, authParams(challenge));
    const code = codeFromRedirect(authRes);

    const tokRes = await token(d, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: PAIRING,
      code_verifier: "a-DIFFERENT-verifier-bbbbbbbbbbbbbbbbbbbbbbbb",
      client_secret: CLIENT_SECRET,
    });
    expect(tokRes.status).toBe(400);
  });
});

describe("requested scope is validated (server capability ∩ pairing allowlist)", () => {
  it("an OUT-OF-ALLOWLIST scope (not in scopes_supported) is rejected → invalid_scope", async () => {
    // RED before the fix: today /authorize stores scope unchecked and redirects with a code (no error).
    const d = deps(goodSecrets());
    await register(d, PAIRING);
    const challenge = await challengeFor("verifier-scope-badbadbadbadbadbadbadbadbadbad");
    const authRes = await authorize(d, authParams(challenge, { scope: "billing" }));
    expect(authRes.status).toBe(302);
    const loc = new URL(authRes.headers.get("location") as string);
    expect(loc.searchParams.get("error")).toBe("invalid_scope");
    expect(loc.searchParams.get("code")).toBeNull();
  });

  it("a VALID subset scope ('mcp') is accepted (a code is issued)", async () => {
    const d = deps(goodSecrets());
    await register(d, PAIRING);
    const challenge = await challengeFor("verifier-scope-goodgoodgoodgoodgoodgoodgood");
    const authRes = await authorize(d, authParams(challenge, { scope: "mcp" }));
    expect(authRes.status).toBe(302);
    expect(codeFromRedirect(authRes)).toBeTruthy();
  });

  it("a server-SUPPORTED scope NOT in the pairing's own allowlist is rejected → invalid_scope", async () => {
    // PAIRING_NOSCOPE has scopes=[] — even the supported "mcp" scope is not granted to it.
    const d = deps(goodSecrets());
    await register(d, PAIRING_NOSCOPE);
    const challenge = await challengeFor("verifier-noscope-cccccccccccccccccccccccccccc");
    const url = new URL(`${ISSUER}/authorize`);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: PAIRING_NOSCOPE,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s",
      scope: "mcp",
    })) {
      url.searchParams.set(k, v);
    }
    const authRes = (await handleOAuth(new Request(url.toString(), { redirect: "manual" }), d)) as Response;
    expect(authRes.status).toBe(302);
    expect(new URL(authRes.headers.get("location") as string).searchParams.get("error")).toBe("invalid_scope");
  });

  // ── open redirect / code interception ────────────────────────────────────────────────────────────────────────
  // The classic OAuth flaw: /authorize redirects to a caller-supplied URI, so an attacker who can get a victim to
  // hit the link receives the authorization code at their own endpoint. The guard existed from the start; until
  // 2026-08-02 (audit §50) NOTHING PINNED IT — every test above uses the registered REDIRECT_URI, so deleting the
  // `client.redirectUris.includes(...)` line left the whole suite green. Both cases below fail without it.
  it("an UNREGISTERED redirect_uri is refused DIRECTLY (400) — never a 302 to the attacker's endpoint", async () => {
    const d = deps(goodSecrets());
    await register(d, PAIRING); // registers REDIRECT_URI only
    const challenge = await challengeFor("verifier-redirect-eeeeeeeeeeeeeeeeeeeeeeee");
    const res = await authorize(d, authParams(challenge, { redirect_uri: "https://attacker.example/steal" }));
    // A 302 here would BE the vulnerability, whatever the query string says.
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_request" });
  });

  it("the redirect_uri check runs BEFORE any error is reported via redirect — a second, invalid param cannot turn it into a 302", async () => {
    // Ordering guard. handleAuthorize defines fail() (which 302s to redirectUri) only after the URI is trusted;
    // if that check were moved below fail(), this request would 302 to the attacker carrying error+state — a
    // redirect primitive on an unregistered endpoint. response_type is the first thing fail() handles.
    const d = deps(goodSecrets());
    await register(d, PAIRING);
    const challenge = await challengeFor("verifier-ordering-ffffffffffffffffffffffff");
    const res = await authorize(
      d,
      authParams(challenge, { redirect_uri: "https://attacker.example/steal", response_type: "token" }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("resolveTokenGrant enforces grant.exp (not just KV TTL)", () => {
  it("a grant whose exp is in the past resolves to null even though the KV record is still present", async () => {
    // RED before the fix: resolveTokenGrant relied solely on KV TTL and returned the grant regardless of the clock.
    const d = deps(goodSecrets());
    await register(d, PAIRING);
    const verifier = "verifier-expiry-dddddddddddddddddddddddddddddddd";
    const challenge = await challengeFor(verifier);
    const authRes = await authorize(d, authParams(challenge));
    const code = codeFromRedirect(authRes);
    const tokRes = await token(d, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: PAIRING,
      code_verifier: verifier,
      client_secret: CLIENT_SECRET,
    });
    const tok = (await tokRes.json()) as { access_token: string };

    // Still valid at T0 (the mint clock)…
    expect(await resolveTokenGrant(env.GRANTS, tok.access_token, () => T0)).not.toBeNull();
    // …but a clock past the grant's exp (T0 + > 1h) returns null even though KV still holds the record.
    const wayLater = T0 + 4000 * 1000;
    expect(await resolveTokenGrant(env.GRANTS, tok.access_token, () => wayLater)).toBeNull();
  });
});

describe("fail-closed token exchange (the NotConfigured resolver)", () => {
  it("with the NotConfigured resolver every token exchange 401s — no principal minted, no token issued", async () => {
    // Register + authorize with the GOOD resolver (so a client + code exist in the shared KV), then exchange with
    // a fail-closed resolver: /token cannot resolve the client secret → 401 (the security spine).
    const good = deps(goodSecrets());
    await register(good, PAIRING);
    const verifier = "verifier-failclosed-eeeeeeeeeeeeeeeeeeeeeeeeee";
    const challenge = await challengeFor(verifier);
    const authRes = await authorize(good, authParams(challenge));
    const code = codeFromRedirect(authRes);

    const failClosed = deps(new NotConfiguredSecretResolver());
    const tokRes = await token(failClosed, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: PAIRING,
      code_verifier: verifier,
      client_secret: CLIENT_SECRET,
    });
    expect(tokRes.status).toBe(401);
  });

  it("the WIRED worker default fetch is fail-closed: /register 401s in prod (NotConfigured)", async () => {
    const res = await worker.fetch(
      new Request(`${ISSUER}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pairing_id: PAIRING, redirect_uris: [REDIRECT_URI], client_secret: CLIENT_SECRET }),
      }),
      env,
    );
    expect(res.status).toBe(401); // no secret store bound → the pairing secret never resolves → fail-closed DCR
  });

  it("the WIRED worker default fetch is fail-closed at /token (a code minted through the wired /authorize still 401s at exchange)", async () => {
    // Seed a registered client via injected GOOD deps (shared KV/DB), then run /authorize AND /token through
    // worker.fetch (prod NotConfigured, real clock) — proving the wired token endpoint fails closed at exchange.
    const good = deps(goodSecrets());
    await register(good, PAIRING);
    const verifier = "verifier-worker-ffffffffffffffffffffffffffffffff";
    const challenge = await challengeFor(verifier);
    const authRes = await worker.fetch(
      new Request(
        `${ISSUER}/authorize?response_type=code&client_id=${PAIRING}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256&state=s&scope=mcp`,
        { redirect: "manual" },
      ),
      env,
    );
    const code = codeFromRedirect(authRes);

    const tokRes = await worker.fetch(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          client_id: PAIRING,
          code_verifier: verifier,
          client_secret: CLIENT_SECRET,
        }).toString(),
      }),
      env,
    );
    expect(tokRes.status).toBe(401);
  });
});

describe("tenant/role are pairing-derived, never client-influenced", () => {
  it("a client-supplied tenant/role in authorize AND token is IGNORED — the minted principal is the pairing's tenant + role=ops", async () => {
    const d = deps(goodSecrets());
    await register(d, PAIRING);
    const verifier = "verifier-influence-gggggggggggggggggggggggggggg";
    const challenge = await challengeFor(verifier);

    const authRes = await authorize(d, authParams(challenge, { tenant: "t-EVIL", role: "admin" }));
    const code = codeFromRedirect(authRes);

    const tokRes = await token(d, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: PAIRING,
      code_verifier: verifier,
      client_secret: CLIENT_SECRET,
      tenant: "t-EVIL",
      role: "finance",
    });
    expect(tokRes.status).toBe(200);
    const tok = (await tokRes.json()) as { access_token: string };

    // The grant records ONLY the pairing (+ validated scope) — nothing the client typed. Mint the principal.
    const grant = await resolveTokenGrant(env.GRANTS, tok.access_token, () => T0);
    const jwt = await mintPrincipalJwt(env, grant?.pairingId as string);
    const { payload } = decode(jwt);
    expect((payload as { tenant: string }).tenant).toBe(TENANT_ID); // NOT t-EVIL
    expect((payload as { role: string }).role).toBe("ops"); // NOT admin / finance
  });
});

// REQ-106/118 §596 — AN AUTHORIZATION CODE IS SINGLE-USE, AND SPENDING IT IS UNCONDITIONAL.
//
// §595 closed session expiry on the api surface and named this one as a SEPARATE implementation its tests
// said nothing about. Measured across the 18 cases above: grant (token) expiry is covered three times,
// including the exact fail-closed-past-KV property. Two adjacent properties were covered by nothing.
//
// CODE EXPIRY has a real backstop — the code is written with `expirationTtl: CODE_TTL_SECONDS`, so KV evicts
// it on the same 60s clock the explicit `record.exp` check uses. Removing the check leaves the eviction, so a
// mutation there can be silent and CORRECTLY so — §589's shape, where two mechanisms agree on every reachable
// input and neither is load-bearing alone.
//
// SINGLE-USE HAS NO BACKSTOP. `oauth.ts` reads the code and DELETES it before validating anything, so a code
// is spent whether or not the exchange succeeds. That ordering is the security property: validate-then-delete
// would let a wrong `code_verifier` be retried against the same code, turning a 60-second window into a PKCE
// brute-force oracle. Nothing tested either half.
describe("REQ-106 §596: the authorization code is spent on first use", () => {
  it("a code cannot be exchanged TWICE — the second attempt is refused, no second token", async () => {
    const d = deps(goodSecrets());
    await register(d, PAIRING);
    const verifier = "verifier-0123456789-abcdefghijklmnopqrstuvwxyz-ABCDEFG";
    const challenge = await challengeFor(verifier);
    const code = codeFromRedirect(await authorize(d, authParams(challenge)));

    const exchange = (): Promise<Response> =>
      token(d, {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: PAIRING,
        code_verifier: verifier,
        client_secret: CLIENT_SECRET,
      });

    expect((await exchange()).status, "the first exchange must succeed").toBe(200);
    const second = await exchange();
    expect(second.status, "a replayed authorization code minted a second token").not.toBe(200);
  });

  it("a FAILED exchange still spends the code — a wrong verifier cannot be retried against it", async () => {
    // The ordering that matters: read-then-DELETE-then-validate. Validate-then-delete would leave the code
    // alive after a rejected attempt, giving an attacker a 60-second window to brute-force the PKCE verifier
    // against a code they hold.
    const d = deps(goodSecrets());
    await register(d, PAIRING);
    const verifier = "verifier-0123456789-abcdefghijklmnopqrstuvwxyz-ABCDEFG";
    const challenge = await challengeFor(verifier);
    const code = codeFromRedirect(await authorize(d, authParams(challenge)));

    const wrong = await token(d, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: PAIRING,
      code_verifier: "verifier-WRONG-0000000000-abcdefghijklmnopqrstuvwxyz",
      client_secret: CLIENT_SECRET,
    });
    expect(wrong.status, "a mismatched verifier must be refused").not.toBe(200);

    // …and now the CORRECT verifier must also fail, because the code was consumed by the failed attempt.
    const retry = await token(d, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: PAIRING,
      code_verifier: verifier,
      client_secret: CLIENT_SECRET,
    });
    expect(retry.status, "the code survived a failed exchange — it is retryable, and PKCE becomes guessable").not.toBe(200);
  });
});
