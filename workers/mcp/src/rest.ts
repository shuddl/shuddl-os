// WP-13 Task 10 (REQ-109) — THE PUBLIC JSON API MIRROR of the MCP tools (structural parity, not a second path).
//
// A plain-REST caller (curl, a partner backend, a non-MCP client) reaches the SAME six tools over ordinary
// HTTP+JSON. The parity is STRUCTURAL, not re-implemented: every REST endpoint maps its request to a
// `tools/call` JSON-RPC message and hands it to the EXACT SAME `dispatch` the `/mcp` transport uses. So a REST
// caller runs the identical pipeline — OAuth bearer → resolveTokenGrant → mintPrincipalJwt → (for a mutation)
// the beforeMutation chokepoint (caps + confirm) → the same tool handler → the same callApi round-trip (every
// api-side gate, REQ-030). There is NO forked tool logic and NO second gate here: rest.ts only TRANSLATES the
// envelope (REST request ⇄ JSON-RPC ⇄ REST response). A REST `POST /api/book` with no confirm / over-cap is
// refused EXACTLY as the MCP tool is (the parity test proves it is not a gate-bypass — REQ-109).
//
// PREFIX: `/api/*` on the mcp worker — deliberately NOT `/v1/*` (that is the api worker's namespace; this worker
// never serves /v1). The mount order in index.ts is OAuth AS → REST → `/mcp` → health.
import { dispatch, defaultDispatchDeps, type DispatchDeps, RPC } from "./tools/registry.js";
import type { Env } from "./index.js";

// The synthetic origin the reused dispatch Request carries — a service-internal URL, never resolved over the
// network (dispatch only reads its Authorization header + JSON body; the origin is irrelevant to routing).
const REST_ORIGIN = "https://shuddl-mcp.internal";
const REST_PREFIX = "/api/";

/** One REST route → one tool. `buildArgs` maps the HTTP request (path param + query + body) to the tool's
 *  `arguments`; the tool's own Zod schema is the single validator (a bad arg is the SAME INVALID_PARAMS a
 *  `tools/call` would raise, surfaced here as a 400). A `param` route captures a single trailing path segment. */
interface RestRoute {
  method: "GET" | "POST";
  /** The path template. `:param` captures exactly one trailing segment (e.g. `/api/track/:shipment_id`). */
  template: string;
  tool: string;
  buildArgs: (pathParam: string | null, url: URL, body: Record<string, unknown>) => Record<string, unknown>;
}

// The six mirrored tools. POST endpoints take the JSON body verbatim as `arguments` (the tool schema validates);
// GET endpoints build `arguments` from the path param + query string. Every endpoint routes through `dispatch`.
const ROUTES: readonly RestRoute[] = [
  { method: "POST", template: "/api/quote", tool: "quote_freight", buildArgs: (_p, _u, body) => body },
  { method: "POST", template: "/api/book", tool: "book_shipment", buildArgs: (_p, _u, body) => body },
  { method: "POST", template: "/api/approve", tool: "approve", buildArgs: (_p, _u, body) => body },
  { method: "POST", template: "/api/dispute", tool: "dispute", buildArgs: (_p, _u, body) => body },
  {
    method: "GET",
    template: "/api/track/:shipment_id",
    tool: "track",
    buildArgs: (shipmentId, url) => {
      const args: Record<string, unknown> = { shipment_id: shipmentId };
      const kind = url.searchParams.get("kind");
      if (kind !== null) args.kind = kind;
      return args;
    },
  },
  {
    method: "GET",
    template: "/api/documents/:shipment_id",
    tool: "get_document",
    buildArgs: (shipmentId, url) => {
      const args: Record<string, unknown> = { shipment_id: shipmentId };
      const documentId = url.searchParams.get("document_id");
      if (documentId !== null) args.document_id = documentId;
      // `?invoices=true` → the invoice-headers read (any other value is passed through and the tool's Zod, which
      // requires a boolean, rejects it as the same 400 a bad tools/call arg would raise).
      const invoices = url.searchParams.get("invoices");
      if (invoices !== null) args.invoices = invoices === "true";
      return args;
    },
  },
] as const;

/** Match a request to a route, extracting the single `:param` segment when the template has one. */
function matchRoute(method: string, pathname: string): { route: RestRoute; param: string | null } | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const paramIdx = route.template.indexOf("/:");
    if (paramIdx === -1) {
      if (route.template === pathname) return { route, param: null };
      continue;
    }
    // A `/prefix/:param` template: the pathname must start with `/prefix/` and carry exactly one more segment.
    const prefix = route.template.slice(0, paramIdx + 1); // includes the trailing slash
    if (!pathname.startsWith(prefix)) continue;
    const rest = pathname.slice(prefix.length);
    if (rest === "" || rest.includes("/")) continue; // exactly one non-empty segment, no deeper path
    return { route, param: decodeURIComponent(rest) };
  }
  return null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Map a JSON-RPC error code (from the reused dispatch) to the HTTP status a REST caller expects. A chokepoint
// refusal (caps/confirm, MUTATION_BLOCKED) is a 403 (the request was well-formed + authenticated but POLICY
// refused it) — this is what proves a REST mutation is gated identically to an MCP one.
function httpForRpcError(code: number): number {
  switch (code) {
    case RPC.MUTATION_BLOCKED:
      return 403; // caps / confirm refusal — a policy block, not a client or server fault
    case RPC.INVALID_PARAMS:
    case RPC.INVALID_REQUEST:
    case RPC.PARSE_ERROR:
      return 400;
    case RPC.METHOD_NOT_FOUND:
      return 404;
    default:
      return 500; // INTERNAL_ERROR and anything unmapped — never leak internals (REQ-192)
  }
}

interface RpcEnvelope {
  result?: { content?: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
  error?: { code: number; message: string; data?: unknown };
}

// Translate the dispatch Response (a 401, or a 200 JSON-RPC envelope) into the REST response. Auth failures pass
// THROUGH verbatim (same 401 + WWW-Authenticate an MCP caller gets — parity at the auth edge too).
async function restFromDispatch(dispatchRes: Response): Promise<Response> {
  if (dispatchRes.status !== 200) return dispatchRes; // 401 (unauth) forwarded untouched — identical to /mcp

  const env = (await dispatchRes.json().catch(() => ({}))) as RpcEnvelope;
  if (env.error !== undefined) {
    const code = typeof (env.error.data as { code?: unknown } | undefined)?.code === "string" ? (env.error.data as { code: string }).code : undefined;
    const out: Record<string, unknown> = { error: env.error.message };
    if (code !== undefined) out.code = code; // the stable machine token (e.g. "confirm_required", "spend_cap_exceeded")
    return json(httpForRpcError(env.error.code), out);
  }
  const result = env.result;
  if (result?.isError === true) {
    // A tool-execution failure (the api returned non-2xx) — surfaced as a 502, carrying ONLY the tool's own
    // safe message (REQ-192: the tool already stripped the api's internal body to a status-only string).
    const text = result.content?.[0]?.text ?? "tool error";
    return json(502, { error: text });
  }
  // Success — the tool's structured output IS the REST body (byte-identical to the MCP structuredContent).
  return json(200, result?.structuredContent ?? {});
}

/**
 * THE REST MIRROR ENTRYPOINT. Returns a Response for an `/api/*` route, or null if the request is not one (so
 * index.ts falls through to `/mcp` / health). Reuses `dispatch` with the SAME composition-root deps the `/mcp`
 * path uses — so auth, the chokepoint, and every tool handler are structurally identical, never re-implemented.
 *
 * `deps` is injectable purely for the parity suite (which splices a recording `env.API` and asserts the REST and
 * MCP paths record the identical api call set); production calls with the default (defaultDispatchDeps(env)).
 */
export async function handleRest(request: Request, env: Env, deps: DispatchDeps = defaultDispatchDeps(env)): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(REST_PREFIX)) return null;

  const matched = matchRoute(request.method.toUpperCase(), url.pathname);
  if (matched === null) {
    // A path under /api/* with no matching route/method — a 404 owned by this mirror (never a fall-through to
    // the /mcp health probe, which would 200 misleadingly).
    return json(404, { error: `no such endpoint: ${request.method} ${url.pathname}` });
  }

  // Read the JSON body for a POST (GET carries none). A NON-EMPTY, unparseable/non-object body is a clean 400
  // BEFORE any dispatch; an empty body flows as `{}` so the tool's own Zod raises the SAME INVALID_PARAMS a
  // tools/call with missing arguments would (surfaced as a 400) — one validator, no divergence.
  let body: Record<string, unknown> = {};
  if (request.method.toUpperCase() === "POST") {
    const raw = await request.text();
    if (raw.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return json(400, { error: "request body must be valid JSON" });
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return json(400, { error: "request body must be a JSON object" });
      }
      body = parsed as Record<string, unknown>;
    }
  }

  const args = matched.route.buildArgs(matched.param, url, body);

  // Build the EXACT `tools/call` the MCP transport would dispatch, carrying the caller's Authorization header
  // verbatim (so auth is byte-identical), and hand it to the SAME dispatch. This is where parity is structural.
  const rpc = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: matched.route.tool, arguments: args } };
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = request.headers.get("authorization");
  if (auth !== null) headers["authorization"] = auth;
  const rpcRequest = new Request(new URL("/mcp", REST_ORIGIN), { method: "POST", headers, body: JSON.stringify(rpc) });

  const dispatchRes = await dispatch(env, deps, rpcRequest);
  return restFromDispatch(dispatchRes);
}
