// WP-13 Task 1 (REQ-101) — THE MCP WORKER ENTRY + the api service-binding reuse seam.
//
// This task ships the scaffold only: a health `fetch` (MCP transport + OAuth land in later tasks) and
// `callApi` — THE seam every future MCP tool routes through. An MCP tool never touches D1/R2 or appends an
// event directly; it calls the api worker's authenticated /v1/* routes over the `API` service binding, so
// the api's server-side gates (auth, idempotency, Gatekeeper — REQ-030) run for an MCP caller exactly as for
// a browser caller. There is no second gate here and no bypass.

export interface Env {
  /** THE reuse seam: a service binding to the api worker (its Hono app + every /v1 gate). In the test pool
   *  this resolves to an auxiliary worker running the real api in-process; in staging/prod to the deployed
   *  `shuddl-api-*` worker. callApi() is the only path an MCP tool uses to reach freight reality. */
  API: Fetcher;
  /** Control plane (tenants +, later, OAuth client registrations). Auth-only; NEVER a tenant data path
   *  (REQ-025). Not read in Task 1. */
  CONTROL_DB: D1Database;
  /** HS256 secret used to MINT a session JWT for the api on behalf of an OAuth-authorized MCP client (later
   *  task's token exchange). Secret, never the toml (REQ-154) — injected via `wrangler secret`. */
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

export default {
  // Health probe only in Task 1. The MCP JSON-RPC transport + OAuth authorize/token endpoints mount here in
  // later tasks; until then every request returns the same liveness response.
  async fetch(_request: Request, env: Env): Promise<Response> {
    return Response.json({ ok: true, service: "mcp", env: env.ENVIRONMENT });
  },
};
