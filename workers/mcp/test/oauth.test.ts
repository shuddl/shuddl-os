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
// of the translator's NotConfiguredSecretResolver). The client NEVER receives the internal SessionClaims JWT —
// only an opaque access token this AS maps to the pairing. tenant/role are DERIVED from the pairing row at mint
// time and can never be influenced by the client.

const ISSUER = "https://mcp.shuddl.test";
const PAIRING = "prn-oauth";
const TENANT_ID = "t-oauth";
const TENANT_SLUG = "tenant-oauth";
const SECRET_REF = "mcp-secret-ref-oauth";
const CLIENT_SECRET = "mcp-client-secret-do-not-use-in-prod";
const REDIRECT_URI = "https://client.example/callback";
const T0 = 1_760_000_000_000;

function goodSecrets(): StaticSecretResolver {
  return new StaticSecretResolver({ [SECRET_REF]: CLIENT_SECRET });
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
async function register(d: OAuthDeps, pairingId: string, redirectUris = [REDIRECT_URI]): Promise<Response> {
  return handleOAuth(
    new Request(`${ISSUER}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_id: pairingId, redirect_uris: redirectUris }),
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

beforeAll(async () => {
  await applyControl(env.CONTROL_DB);
  await seedTenant(env.CONTROL_DB, TENANT_ID, TENANT_SLUG);
  await seedPairing(env.CONTROL_DB, { id: PAIRING, tenantId: TENANT_ID, kind: "mcp", secretRef: SECRET_REF, status: "active" });
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

describe("dynamic client registration (DCR)", () => {
  it("registering against an ACTIVE mcp pairing returns client_id = pairing id", async () => {
    const res = await register(deps(goodSecrets()), PAIRING);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string; redirect_uris: string[] };
    expect(body.client_id).toBe(PAIRING);
    expect(body.redirect_uris).toContain(REDIRECT_URI);
  });

  it("registering against an UNKNOWN / non-mcp pairing is rejected (no client is created)", async () => {
    const res = await register(deps(goodSecrets()), "prn-nope");
    expect(res.status).toBe(400);
  });
});

describe("authorization_code + PKCE round-trip", () => {
  it("a valid code→token exchange (correct verifier + client_secret) issues an opaque access token mapped to the pairing", async () => {
    const d = deps(goodSecrets());
    await register(d, PAIRING);
    const verifier = "verifier-0123456789-abcdefghijklmnopqrstuvwxyz-ABCDEFG";
    const challenge = await challengeFor(verifier);

    const authRes = await authorize(d, {
      response_type: "code",
      client_id: PAIRING,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "state-xyz",
    });
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

    // The AS maps the token to the pairing — the seam the MCP session uses to mint the api principal.
    const grant = await resolveTokenGrant(env.GRANTS, tok.access_token);
    expect(grant?.pairingId).toBe(PAIRING);
  });

  it("a MISMATCHED PKCE verifier is rejected (400) — no token issued", async () => {
    const d = deps(goodSecrets());
    await register(d, PAIRING);
    const challenge = await challengeFor("the-real-verifier-aaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    const authRes = await authorize(d, {
      response_type: "code",
      client_id: PAIRING,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s",
    });
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

describe("fail-closed token exchange (the NotConfigured resolver)", () => {
  it("with the NotConfigured resolver every token exchange 401s — no principal minted, no token issued", async () => {
    const failClosed = deps(new NotConfiguredSecretResolver());
    await register(failClosed, PAIRING);
    const verifier = "verifier-failclosed-cccccccccccccccccccccccccccc";
    const challenge = await challengeFor(verifier);

    const authRes = await authorize(failClosed, {
      response_type: "code",
      client_id: PAIRING,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s",
    });
    const code = codeFromRedirect(authRes);

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

  it("the WIRED worker default fetch is fail-closed (prod NotConfigured): a full ceremony through worker.fetch 401s at /token", async () => {
    const verifier = "verifier-worker-dddddddddddddddddddddddddddddddd";
    const challenge = await challengeFor(verifier);
    await worker.fetch(
      new Request(`${ISSUER}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pairing_id: PAIRING, redirect_uris: [REDIRECT_URI] }),
      }),
      env,
    );
    const authRes = await worker.fetch(
      new Request(
        `${ISSUER}/authorize?response_type=code&client_id=${PAIRING}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256&state=s`,
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
    expect(tokRes.status).toBe(401); // no secret store bound → the pairing secret never resolves → fail-closed
  });
});

describe("tenant/role are pairing-derived, never client-influenced", () => {
  it("a client-supplied tenant/role in authorize AND token is IGNORED — the minted principal is the pairing's tenant + role=ops", async () => {
    const d = deps(goodSecrets());
    await register(d, PAIRING);
    const verifier = "verifier-influence-eeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const challenge = await challengeFor(verifier);

    const authRes = await authorize(d, {
      response_type: "code",
      client_id: PAIRING,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s",
      tenant: "t-EVIL", // hostile: try to steer the tenant
      role: "admin", // hostile: try to escalate the role
    });
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

    // The grant records ONLY the pairing — nothing the client typed. Mint the principal and prove tenant/role.
    const grant = await resolveTokenGrant(env.GRANTS, tok.access_token);
    const jwt = await mintPrincipalJwt(env, grant?.pairingId as string);
    const { payload } = decode(jwt);
    expect((payload as { tenant: string }).tenant).toBe(TENANT_ID); // NOT t-EVIL
    expect((payload as { role: string }).role).toBe("ops"); // NOT admin / finance
  });
});
