// WP-13 Task 3 (REQ-101/106) — THE TOOL REGISTRY + MCP JSON-RPC DISPATCH.
//
// The MCP transport is Streamable HTTP carrying JSON-RPC 2.0. We hand-roll the handler (rather than McpAgent from
// the `agents` SDK) deliberately — the same choice the OAuth AS made: McpAgent takes over the Worker default
// export with a Durable-Object session + SSE machinery and pulls in @modelcontextprotocol/sdk, which would fight
// the already-mounted hand-rolled OAuth AS and hide the exact seams this WP must test — the OAuth-bearer → mint →
// callApi pipeline and the mutation chokepoint. A hand-rolled dispatch keeps every port injected (grants store,
// grant resolver, principal mint, the chokepoint) and deterministically testable, mirroring oauth.ts's discipline.
//
// THE PIPELINE for a `tools/call`: extract the OAuth bearer → resolve it to a pairing (resolveTokenGrant) or 401 →
// look up the tool → Zod-validate `arguments` → build a ToolCtx (env, pairingId, a per-request principal MINT, the
// api seam, a derived Idempotency-Key) → for a MUTATING tool run beforeMutation FIRST (the chokepoint) → invoke the
// handler → wrap its value in the MCP result envelope. A tool never reaches D1/R2; it drives the api via ctx.callApi
// with a freshly minted principal, so every api-side gate (REQ-030) runs for the MCP caller exactly as for a browser.
import { z } from "zod";
import { callApi, type Env } from "../index.js";
import { mintPrincipalJwt } from "../principal.js";
import { resolveTokenGrant, type TokenGrant } from "../oauth.js";
import { beforeMutation as gateBeforeMutation, MutationBlocked } from "../gate.js";
import { deriveIdempotencyKey, type JsonRpcId } from "../idempotency.js";

// ── MCP protocol constants ───────────────────────────────────────────────────────────────────────────────────
const PROTOCOL_VERSION = "2025-06-18"; // the MCP revision this server implements (initialize handshake)
const SERVER_INFO = { name: "shuddl-mcp", version: "1.0.0" } as const;

// JSON-RPC 2.0 error codes: the reserved band (-32700..-32603) plus an implementation-defined server error
// (-32000..-32099) for a chokepoint refusal, so a MutationBlocked reads differently from a transport fault.
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  MUTATION_BLOCKED: -32001,
} as const;

// ── the tool contract ────────────────────────────────────────────────────────────────────────────────────────
/** The MCP tool-result envelope (a `content` block array, optionally flagged an error, plus structured data). */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** The execution context handed to a tool handler — every seam a tool needs, and nothing more. */
export interface ToolCtx {
  /** The worker env (so a handler can reach further bindings if a future tool needs one). */
  env: Env;
  /** The authenticated pairing this call acts as — the ONLY subject a tool may drive the api as. */
  pairingId: string;
  /** Mint a fresh short-lived api principal JWT for the pairing (tenant-derived, role=ops). Per call, never cached. */
  mintJwt: () => Promise<string>;
  /** THE api reuse seam — the only path to freight reality; every api-side gate runs on this round-trip. */
  callApi: typeof callApi;
  /** The derived Idempotency-Key for this tool call — passed to callApi on a mutation so a retry never double-applies. */
  idempotencyKey: string;
}

/** A registered tool. `mutating` decides whether the chokepoint runs; `inputSchema` validates `arguments` (Zod). */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  mutating: boolean;
  handler: (ctx: ToolCtx, args: unknown) => Promise<unknown>;
}

/**
 * Author a tool with a TYPED handler while storing it type-erased in the registry. The generic ties `handler`'s
 * `args` to the schema's output; the returned ToolDef exposes `args: unknown` (the dispatcher hands it the
 * already-validated `safeParse` output). No `any` — the erasure is a single assertion at the boundary.
 */
export function defineTool<A>(def: {
  name: string;
  description: string;
  inputSchema: z.ZodType<A>;
  mutating: boolean;
  handler: (ctx: ToolCtx, args: A) => Promise<unknown>;
}): ToolDef {
  return def as unknown as ToolDef;
}

/** Thrown by a handler for a tool-execution failure (e.g. the api returned non-2xx). Rendered as an isError result
 *  (MCP convention: an execution error is visible to the model), distinct from a JSON-RPC protocol error. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

// ── the registry ─────────────────────────────────────────────────────────────────────────────────────────────
/** The set of tools this server exposes. `tools/list` reflects it; `tools/call` looks up by name. */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register(def: ToolDef): this {
    this.tools.set(def.name, def);
    return this;
  }
  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }
  list(): ToolDef[] {
    return [...this.tools.values()];
  }
  /** The `tools/list` payload: name + description + the JSON Schema derived from each tool's Zod input schema. */
  listForRpc(): Array<{ name: string; description: string; inputSchema: unknown }> {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.inputSchema),
    }));
  }
}

// ── the proof tools (real tools land in Tasks 4-7) ───────────────────────────────────────────────────────────
// `whoami` is a READ tool that proves the FULL pipeline end-to-end: OAuth token → mintPrincipalJwt → callApi →
// the api aux worker's /v1/whoami, which echoes the verified session. If it returns tenant=<pairing tenant> +
// role=ops, every seam in the chain is wired. It touches no chokepoint (mutating=false).
const whoamiTool = defineTool({
  name: "whoami",
  description: "Return the api session the MCP principal acts as (its tenant + bounded role). A read; no mutation.",
  inputSchema: z.object({}),
  mutating: false,
  handler: async (ctx) => {
    const res = await ctx.callApi(ctx.env, { method: "GET", path: "/v1/whoami", jwt: await ctx.mintJwt() });
    if (!res.ok) throw new ToolError(`whoami failed: api returned ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  },
});

// A no-op MUTATING stub that proves the chokepoint runs for a mutating tool (and NOT for a read). It performs no
// api write — the real mutating tools (booking, etc.) land in Tasks 4-7; this exists only to exercise beforeMutation.
const noopMutationTool = defineTool({
  name: "noop_mutation",
  description: "A no-op mutating stub proving the mutation chokepoint runs before a mutating handler. No-op write.",
  inputSchema: z.object({ note: z.string().optional() }),
  mutating: true,
  handler: async (ctx) => ({ ok: true, idempotencyKey: ctx.idempotencyKey }),
});

/** Build the default registry with the proof tools registered. Later tasks register their tools here. */
export function buildRegistry(): ToolRegistry {
  return new ToolRegistry().register(whoamiTool).register(noopMutationTool);
}

// ── JSON-RPC envelope helpers ────────────────────────────────────────────────────────────────────────────────
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
// Narrow an arbitrary parsed body to a JSON-RPC request, or null if it is not one. `id` defaults to null (a
// notification / id-less call) so an error can still be addressed to the caller.
function asJsonRpcRequest(message: unknown): JsonRpcRequest | null {
  if (!isRecord(message)) return null;
  if (message.jsonrpc !== "2.0") return null;
  if (typeof message.method !== "string") return null;
  const id = message.id;
  const normId: JsonRpcId = typeof id === "string" || typeof id === "number" ? id : null;
  return { jsonrpc: "2.0", id: normId, method: message.method, params: message.params };
}
function rpcResult(id: JsonRpcId, result: unknown): Response {
  return jsonResponse(200, { jsonrpc: "2.0", id, result });
}
function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Response {
  const error = data === undefined ? { code, message } : { code, message, data };
  return jsonResponse(200, { jsonrpc: "2.0", id, error });
}
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
// A missing/invalid/expired OAuth bearer → HTTP 401 (MCP auth spec: the transport, not a JSON-RPC error, carries
// auth failure), with WWW-Authenticate so a client knows to (re)authorize. NO principal minted, NO api call.
function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "invalid_token" }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="mcp", error="invalid_token"' },
  });
}
function bearerFrom(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token === "" ? null : token;
}

// Wrap a handler's return value in the MCP result envelope: an object becomes both a text block (canonical MCP)
// and structuredContent (typed access); a non-object value becomes a text block only.
function toToolResult(value: unknown): ToolResult {
  const text = JSON.stringify(value);
  if (isRecord(value)) return { content: [{ type: "text", text }], structuredContent: value };
  return { content: [{ type: "text", text }] };
}

// ── the dispatcher ───────────────────────────────────────────────────────────────────────────────────────────
/** The ports dispatch needs — every one injected (the composition root selects the live ones, tests inject spies),
 *  mirroring OAuthDeps. `resolveGrant` / `mintJwt` / `beforeMutation` are seams the suite overrides to prove the
 *  auth-first ordering, the end-to-end pipeline, and the chokepoint invocation in isolation. */
export interface DispatchDeps {
  grants: KVNamespace;
  resolveGrant: (grants: KVNamespace, token: string, now: () => number) => Promise<TokenGrant | null>;
  now: () => number;
  registry: ToolRegistry;
  beforeMutation: (ctx: ToolCtx, tool: ToolDef, args: unknown) => Promise<void>;
  mintJwt: (env: Pick<Env, "CONTROL_DB" | "JWT_SECRET">, pairingId: string) => Promise<string>;
}

/** The composition-root deps: live grant resolver + principal mint + the module-level chokepoint + the proof tools. */
export function defaultDispatchDeps(env: Env): DispatchDeps {
  return {
    grants: env.GRANTS,
    resolveGrant: resolveTokenGrant,
    now: () => Date.now(),
    registry: buildRegistry(),
    beforeMutation: gateBeforeMutation,
    mintJwt: mintPrincipalJwt,
  };
}

/**
 * Dispatch one MCP JSON-RPC message. AUTHENTICATE FIRST (OAuth bearer → pairing, else 401 with no mint/no api
 * call), then route: `initialize` handshake, `tools/list`, `tools/call` (validate → chokepoint-if-mutating →
 * handler). Returns the HTTP Response the /mcp endpoint sends (401 for auth failure; 200 with a JSON-RPC
 * result/error envelope otherwise).
 */
export async function dispatch(env: Env, deps: DispatchDeps, request: Request, message: unknown): Promise<Response> {
  // 1. AUTH — the OAuth bearer maps to a pairing, or the call is refused before anything else happens.
  const token = bearerFrom(request);
  const grant = token === null ? null : await deps.resolveGrant(deps.grants, token, deps.now);
  if (grant === null) return unauthorized();

  // 2. JSON-RPC envelope.
  const req = asJsonRpcRequest(message);
  if (req === null) {
    const id = isRecord(message) && (typeof message.id === "string" || typeof message.id === "number") ? message.id : null;
    return rpcError(id, RPC.INVALID_REQUEST, "not a valid JSON-RPC 2.0 request");
  }

  // 3. Route by method.
  switch (req.method) {
    case "initialize":
      return rpcResult(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "tools/list":
      return rpcResult(req.id, { tools: deps.registry.listForRpc() });
    case "tools/call":
      return handleToolsCall(env, deps, grant.pairingId, req);
    default:
      // A notification (e.g. notifications/initialized) carries no result — acknowledge with 202, no body.
      if (req.method.startsWith("notifications/")) return new Response(null, { status: 202 });
      return rpcError(req.id, RPC.METHOD_NOT_FOUND, `unknown method: ${req.method}`);
  }
}

async function handleToolsCall(env: Env, deps: DispatchDeps, pairingId: string, req: JsonRpcRequest): Promise<Response> {
  const params = req.params;
  const name = isRecord(params) ? params.name : undefined;
  if (typeof name !== "string") return rpcError(req.id, RPC.INVALID_PARAMS, "tools/call requires a string `name`");

  const tool = deps.registry.get(name);
  if (tool === undefined) return rpcError(req.id, RPC.INVALID_PARAMS, `unknown tool: ${name}`);

  // Validate `arguments` against the tool's Zod schema — a failure is a JSON-RPC error and NOTHING downstream runs
  // (no principal minted for the call's handler, no api round-trip, no chokepoint).
  const rawArgs = isRecord(params) && params.arguments !== undefined ? params.arguments : {};
  const parsed = tool.inputSchema.safeParse(rawArgs);
  if (!parsed.success) return rpcError(req.id, RPC.INVALID_PARAMS, "invalid arguments", parsed.error.issues);

  const ctx: ToolCtx = {
    env,
    pairingId,
    mintJwt: () => deps.mintJwt(env, pairingId),
    callApi,
    idempotencyKey: await deriveIdempotencyKey(pairingId, tool.name, req.id),
  };

  try {
    // THE CHOKEPOINT — for a mutating tool it runs BEFORE the handler; a refusal (MutationBlocked) means the
    // handler never runs. A read tool skips it entirely.
    if (tool.mutating) await deps.beforeMutation(ctx, tool, parsed.data);
    const value = await tool.handler(ctx, parsed.data);
    return rpcResult(req.id, toToolResult(value));
  } catch (err) {
    if (err instanceof MutationBlocked) return rpcError(req.id, RPC.MUTATION_BLOCKED, err.message, { code: err.code });
    // A tool-execution failure is an isError RESULT (visible to the model), not a protocol error.
    if (err instanceof ToolError) return rpcResult(req.id, { content: [{ type: "text", text: err.message }], isError: true });
    return rpcError(req.id, RPC.INTERNAL_ERROR, err instanceof Error ? err.message : "internal error");
  }
}
