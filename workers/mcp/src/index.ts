// WP-13 Task 1 (REQ-101) — THE MCP WORKER ENTRY + the api service-binding reuse seam.
//
// Task 1 shipped the scaffold + `callApi` — THE seam every MCP tool routes through: an MCP tool never touches
// D1/R2 or appends an event directly; it calls the api worker's authenticated /v1/* routes over the `API`
// service binding, so the api's server-side gates (auth, idempotency, Gatekeeper — REQ-030) run for an MCP
// caller exactly as for a browser caller. There is no second gate here and no bypass.
//
// WP-13 Task 2 (REQ-102) adds the client-facing OAuth 2.1 AS (oauth.ts) + the fail-closed pairing→SessionClaims
// mint (principal.ts). The composition root here selects the FAIL-CLOSED SecretResolver (prod cannot complete a
// token exchange until the CONFIRM-gated secret store is bound) and wires the AS into `fetch`.
import { handleOAuth, type OAuthDeps } from "./oauth.js";
import { NotConfiguredSecretResolver, type SecretResolver } from "./principal.js";
import { dispatch, defaultDispatchDeps, RPC } from "./tools/registry.js";

export interface Env {
  /** THE reuse seam: a service binding to the api worker (its Hono app + every /v1 gate). In the test pool
   *  this resolves to an auxiliary worker running the real api in-process; in staging/prod to the deployed
   *  `shuddl-api-*` worker. callApi() is the only path an MCP tool uses to reach freight reality. */
  API: Fetcher;
  /** Control plane (tenants + `pairings` — the OAuth grant target). Auth-only; NEVER a tenant data path
   *  (REQ-025). Read in Task 2 by the principal mint + OAuth AS to resolve an active `mcp` pairing. */
  CONTROL_DB: D1Database;
  /** OAuth grants store (WP-13 Task 2): authorization codes, access-token→pairing grants, and registered
   *  clients — all opaque, KV-backed. Never holds a SessionClaims JWT (that is minted per request, never stored). */
  GRANTS: KVNamespace;
  /** HS256 secret used to MINT a session JWT for the api on behalf of an OAuth-authorized MCP client (the
   *  Task-2 principal mint). Secret, never the toml (REQ-154) — injected via `wrangler secret`. */
  JWT_SECRET: string;
  /** dev | staging | prod (the toml [vars] value). */
  ENVIRONMENT: string;
}

/** The verbs an MCP tool drives the api with. `path` is an absolute /v1 (or /pub) path; `body` is JSON. */
export interface CallApiOptions {
  method: string;
  path: string;
  /** The api session JWT (Authorization: Bearer). Omitted for the api's unauthenticated /v1/health probe. */
  jwt?: string;
  /** Idempotency-Key — REQUIRED by the api on every mutation (REQ-156). Set for POST/PUT/PATCH/DELETE. */
  idempotencyKey?: string;
  /** JSON request body (serialized here). Omitted for GET/DELETE-style reads. */
  body?: unknown;
}

// The service binding ignores the request origin, but Request needs an absolute URL — this synthetic host is
// never resolved over the network (the binding dispatches in-process to the api worker).
const API_ORIGIN = "https://shuddl-api.internal";

/**
 * THE api reuse seam. Builds the Request every MCP tool sends and dispatches it through the `API` service
 * binding, returning the api worker's own Response untouched. It sets Authorization / Idempotency-Key /
 * Content-Type; it enforces NOTHING itself — authorization and every gate are the api worker's job (REQ-030).
 */
export async function callApi(env: Pick<Env, "API">, opts: CallApiOptions): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.jwt !== undefined) headers["Authorization"] = `Bearer ${opts.jwt}`;
  if (opts.idempotencyKey !== undefined) headers["Idempotency-Key"] = opts.idempotencyKey;

  const init: RequestInit = { method: opts.method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  const request = new Request(new URL(opts.path, API_ORIGIN), init);
  return env.API.fetch(request);
}

// THE COMPOSITION ROOT for OAuth client authentication (mirrors the translator's secretResolverFor). Resolving a
// pairing's client secret from a real secret store is the CONFIRM-gated live flip (secrets never in the toml,
// REQ-154); until then this FAILS CLOSED — NotConfiguredSecretResolver resolves nothing, so the token exchange
// 401s in every environment. The OAuth ceremony ships fully tested via an injected static resolver; going live
// is a config flip, not code.
export function secretResolverFor(env: Env): SecretResolver {
  void env; // read here when the live secret store binds — see the header
  return new NotConfiguredSecretResolver();
}

// Assemble the OAuth deps from the request + env — every port selected HERE (the fail-closed resolver, the KV
// grants store, the control DB), none read from inside the ceremony. The issuer is this request's origin.
function oauthDeps(request: Request, env: Env): OAuthDeps {
  return {
    controlDb: env.CONTROL_DB,
    grants: env.GRANTS,
    secrets: secretResolverFor(env),
    now: () => Date.now(),
    issuer: new URL(request.url).origin,
  };
}

// THE MCP JSON-RPC ENDPOINT. A `POST /mcp` carries one JSON-RPC 2.0 message (Streamable HTTP). We parse the body
// here and hand it to dispatch, which authenticates the OAuth bearer → pairing, then routes initialize/tools.* .
// A body that is not JSON is a JSON-RPC parse error (-32700). The OAuth AS routes (Task 2) stay mounted ahead of it.
const MCP_PATH = "/mcp";

export default {
  // Order: OAuth AS (Task 2) → the MCP JSON-RPC transport (Task 3) → the health probe. dispatch maps an opaque
  // access token → pairing via resolveTokenGrant, then mintPrincipalJwt for callApi (all inside the tool ctx).
  async fetch(request: Request, env: Env): Promise<Response> {
    const oauth = await handleOAuth(request, oauthDeps(request, env));
    if (oauth !== null) return oauth;

    const { pathname } = new URL(request.url);
    if (pathname === MCP_PATH && request.method === "POST") {
      let message: unknown;
      try {
        message = await request.json();
      } catch {
        return Response.json({ jsonrpc: "2.0", id: null, error: { code: RPC.PARSE_ERROR, message: "invalid JSON" } });
      }
      return dispatch(env, defaultDispatchDeps(env), request, message);
    }

    return Response.json({ ok: true, service: "mcp", env: env.ENVIRONMENT });
  },
};
