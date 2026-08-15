import { env } from "cloudflare:test";
import { z } from "zod";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import {
  buildRegistry,
  defaultDispatchDeps,
  defineTool,
  dispatch,
  mutatingCallApi,
  ToolRegistry,
  type DispatchDeps,
  type ToolCtx,
  type ToolDef,
} from "../src/tools/registry.js";
import {
  beforeMutation as gateBeforeMutation,
  composeMutationChecks,
  DEFAULT_MUTATION_CHECKS,
  MutationBlocked,
  registerMutationCheck,
  resetMutationChecks,
  type ComposedMutationGate,
} from "../src/gate.js";
import { deriveIdempotencyKey } from "../src/idempotency.js";
import { mintPrincipalJwt, PrincipalMintError, StaticSecretResolver } from "../src/principal.js";
import { handleOAuth, resolveTokenGrant, type OAuthDeps, type TokenGrant } from "../src/oauth.js";
import { applyControl, seedPairing, seedTenant } from "./helpers.js";

// WP-13 Task 3 (REQ-101/106) — THE MCP JSON-RPC TRANSPORT + TOOL DISPATCH + MUTATION CHOKEPOINT + IDEMPOTENCY.
//
// The dispatcher authenticates the OAuth bearer → pairing (else 401 before any mint/api call), routes JSON-RPC
// (initialize / tools/list / tools/call), Zod-validates arguments, runs the mutation chokepoint FIRST for a
// mutating tool, then invokes the handler through the api reuse seam with a freshly minted principal. These
// suites prove each seam — including the FULL OAuth→mint→callApi pipeline against the real api aux worker.

const ISSUER = "https://mcp.shuddl.test";
const PAIRING = "prn-mcp";
const TENANT_ID = "t-mcp";
const TENANT_SLUG = "tenant-mcp";
const SECRET_REF = "mcp-secret-ref-dispatch";
const CLIENT_SECRET = "mcp-client-secret-do-not-use-in-prod";
const REDIRECT_URI = "https://client.example/cb";

// ── JSON-RPC body typing (no `any`) ──────────────────────────────────────────────────────────────────────────
interface RpcBody {
  jsonrpc: string;
  id: unknown;
  result?: {
    content?: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
    tools?: Array<{ name: string; description: string; inputSchema: unknown }>;
    isError?: boolean;
    protocolVersion?: string;
    serverInfo?: { name: string };
  };
  error?: { code: number; message: string; data?: unknown };
}
async function bodyOf(res: Response): Promise<RpcBody> {
  return (await res.json()) as RpcBody;
}

// ── PKCE + real-OAuth-ceremony helper: mint a genuine Task-2 access token for PAIRING (real clock, so the grant
//    is valid under the wired worker's Date.now()). Proves a real token flows into the Task-3 dispatcher. ───────
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function challengeFor(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(d));
}
function ceremonyDeps(): OAuthDeps {
  return {
    controlDb: env.CONTROL_DB,
    grants: env.GRANTS,
    secrets: new StaticSecretResolver({ [SECRET_REF]: CLIENT_SECRET }),
    now: () => Date.now(),
    issuer: ISSUER,
  };
}
async function getAccessToken(): Promise<string> {
  const d = ceremonyDeps();
  await handleOAuth(
    new Request(`${ISSUER}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_id: PAIRING, redirect_uris: [REDIRECT_URI], client_secret: CLIENT_SECRET }),
    }),
    d,
  );
  const verifier = "verifier-dispatch-000000000000000000000000000000";
  const challenge = await challengeFor(verifier);
  const authUrl = new URL(`${ISSUER}/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: PAIRING,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s",
    scope: "mcp",
  })) {
    authUrl.searchParams.set(k, v);
  }
  const authRes = (await handleOAuth(new Request(authUrl.toString(), { redirect: "manual" }), d)) as Response;
  const code = new URL(authRes.headers.get("location") as string).searchParams.get("code") as string;
  const tokRes = (await handleOAuth(
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
    d,
  )) as Response;
  return ((await tokRes.json()) as { access_token: string }).access_token;
}

// ── dispatch drivers (inject seams, mirroring the OAuth suite's deps discipline) ──────────────────────────────
function grantFor(pairingId: string): TokenGrant {
  return { pairingId, scope: "mcp", exp: Math.floor(Date.now() / 1000) + 3600 };
}
function deps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    grants: env.GRANTS,
    resolveGrant: async () => grantFor(PAIRING), // default: the bearer resolves to PAIRING (token value ignored)
    now: () => Date.now(),
    registry: buildRegistry(),
    beforeMutation: gateBeforeMutation,
    mintJwt: mintPrincipalJwt,
    ...overrides,
  };
}
// token === null means "omit the Authorization header" (a bare `undefined` would trip default-param semantics).
// The JSON-RPC message rides in the request body — dispatch authenticates FIRST, then parses it (auth before parse).
function mcpRequest(token: string | null, message: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  return new Request(`${ISSUER}/mcp`, { method: "POST", headers, body: JSON.stringify(message) });
}
async function call(d: DispatchDeps, message: unknown, token: string | null = "tok"): Promise<Response> {
  return dispatch(env, d, mcpRequest(token, message));
}
function toolsCall(id: number, name: string, args: Record<string, unknown> = {}): unknown {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

beforeAll(async () => {
  await applyControl(env.CONTROL_DB);
  await seedTenant(env.CONTROL_DB, TENANT_ID, TENANT_SLUG);
  await seedPairing(env.CONTROL_DB, {
    id: PAIRING,
    tenantId: TENANT_ID,
    kind: "mcp",
    secretRef: SECRET_REF,
    status: "active",
    scopes: '["mcp"]',
  });
});

// The empty chokepoint chain is the default; a suite that registers a spy check must not leak it to the next.
afterEach(() => resetMutationChecks());

describe("tools/list reflects the registry (names + JSON schemas)", () => {
  it("returns the registered tool names, each with a JSON schema derived from its Zod input", async () => {
    const res = await call(deps(), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const tools = body.result?.tools ?? [];
    const names = tools.map((t) => t.name);
    expect(names).toContain("whoami");
    expect(names).toContain("noop_mutation");
    const whoami = tools.find((t) => t.name === "whoami");
    expect((whoami?.inputSchema as { type?: string }).type).toBe("object"); // a real JSON Schema, not the Zod object
  });
});

describe("initialize handshake", () => {
  it("returns the protocol version + serverInfo + tools capability", async () => {
    const res = await call(deps(), { jsonrpc: "2.0", id: 0, method: "initialize" });
    const body = await bodyOf(res);
    expect(body.result?.protocolVersion).toBeDefined();
    expect(body.result?.serverInfo?.name).toBe("shuddl-mcp");
  });
});

describe("the FULL OAuth→mint→callApi pipeline (whoami through the real api aux worker)", () => {
  it("a tools/call for whoami with a real OAuth access token echoes the pairing's tenant + role=ops", async () => {
    const token = await getAccessToken();
    // Through the WIRED worker.fetch (POST /mcp) — proves index.ts routing + dispatch + the whole pipeline.
    const req = new Request(`${ISSUER}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(toolsCall(2, "whoami")),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    // whoami echoes the verified api session — proof the api decoded the MINTED principal (not the mcp worker).
    const session = JSON.parse(body.result?.content?.[0]?.text as string) as { tenant: string; role: string; sub: string };
    expect(session.tenant).toBe(TENANT_ID); // pairing-derived, never client-supplied
    expect(session.role).toBe("ops"); // the bounded MCP principal role
    expect(session.sub).toBe(`mcp:${PAIRING}`);
    expect(body.result?.structuredContent?.tenant).toBe(TENANT_ID);
  });
});

describe("authentication is required (401 with no mint, no api call)", () => {
  it("a MISSING bearer → 401 and the principal is never minted", async () => {
    let mints = 0;
    const d = deps({
      mintJwt: async () => {
        mints++;
        throw new Error("must not mint for an unauthenticated call");
      },
    });
    const res = await call(d, toolsCall(3, "whoami"), null);
    expect(res.status).toBe(401);
    expect(mints).toBe(0);
  });

  it("an INVALID bearer (no such grant) → 401 (real resolveTokenGrant against the KV)", async () => {
    const d = deps({ resolveGrant: resolveTokenGrant });
    const res = await call(d, toolsCall(4, "whoami"), "mcpt_not_a_real_token");
    expect(res.status).toBe(401);
  });

  it("an EXPIRED grant → 401 (a real token resolved under a clock past its exp)", async () => {
    const token = await getAccessToken();
    // Valid under the mint clock…
    const valid = await call(deps({ resolveGrant: resolveTokenGrant }), toolsCall(5, "whoami"), token);
    expect(valid.status).toBe(200);
    // …but 401 under a clock > 1h later, even though the KV record still exists.
    const wayLater = Date.now() + 4000 * 1000;
    const expired = await call(deps({ resolveGrant: resolveTokenGrant, now: () => wayLater }), toolsCall(6, "whoami"), token);
    expect(expired.status).toBe(401);
  });
});

describe("the mutation chokepoint runs for a mutating tool and is skipped for a read", () => {
  it("beforeMutation is invoked for the mutating stub and NOT for the read tool", async () => {
    const calls: string[] = [];
    const d = deps({
      beforeMutation: async (_ctx: ToolCtx, tool: ToolDef) => {
        calls.push(tool.name);
      },
    });
    await call(d, toolsCall(7, "whoami")); // a READ
    expect(calls).toEqual([]); // the chokepoint did NOT run for the read
    const res = await call(d, toolsCall(8, "noop_mutation")); // a MUTATION
    expect(calls).toEqual(["noop_mutation"]); // the chokepoint ran for the mutation
    expect((await bodyOf(res)).result?.structuredContent?.ok).toBe(true);
  });

  it("a chokepoint that THROWS blocks the mutating handler (JSON-RPC error) but a read still succeeds", async () => {
    const d = deps({
      beforeMutation: async () => {
        throw new MutationBlocked("caps_exceeded", "over the cap");
      },
    });
    // The mutation is blocked BEFORE its handler runs → a JSON-RPC error carrying the block code.
    const blocked = await bodyOf(await call(d, toolsCall(9, "noop_mutation")));
    expect(blocked.error?.code).toBe(-32001);
    expect((blocked.error?.data as { code: string }).code).toBe("caps_exceeded");
    // The SAME throwing gate never runs for a read — whoami succeeds.
    const read = await call(d, toolsCall(10, "whoami"));
    expect(read.status).toBe(200);
    expect((await bodyOf(read)).result?.content).toBeDefined();
  });

  it("a chokepoint check sees the tool + validated args (the injected-deps chain the composition uses)", async () => {
    const seen: Array<{ tool: string; args: unknown }> = [];
    const chain = composeMutationChecks([
      {
        name: "spy",
        check: async (_ctx, tool, args) => {
          seen.push({ tool: tool.name, args });
        },
      },
    ]);
    await call(deps({ beforeMutation: chain }), toolsCall(11, "noop_mutation", { note: "hi" }));
    expect(seen).toEqual([{ tool: "noop_mutation", args: { note: "hi" } }]);
  });
});

describe("[FIX 1] the mutation-check chain is composed EXPLICITLY, never a mutable import-side-effect global", () => {
  it("the live default-deps chokepoint IS DEFAULT_MUTATION_CHECKS by identity; a test-global registration never leaks in", async () => {
    // RED before the fix: defaultDispatchDeps ran a module-global that registerMutationCheck mutated, so a check
    // registered by side effect leaked into the live chain (and a real check tree-shaken out silently vanished —
    // caps+confirm fail OPEN). After: the production chain is the explicit array, decoupled from the test global.
    const fired: string[] = [];
    registerMutationCheck({
      name: "sneaky",
      check: async () => {
        fired.push("sneaky");
      },
    });

    const live = defaultDispatchDeps(env).beforeMutation;
    // Identity: the production chain IS the explicit source array — a declared-but-unlisted check is verifiably unrun.
    expect((live as ComposedMutationGate).checks).toBe(DEFAULT_MUTATION_CHECKS);
    // Task 8 (REQ-105) ADDED capsCheck and Task 9 (REQ-108) ADDED confirmCheck explicitly at the marker, IN ORDER.
    // A declared-but-unlisted check would fail this identity assertion (the whole point of the explicit array).
    expect(DEFAULT_MUTATION_CHECKS.map((c) => c.name)).toEqual(["confirm", "caps"]);

    // An empty tool ({}.name !== "book_shipment") is a pass-through for BOTH caps and confirm, so the live chain
    // resolves; the test global still must NOT fire (it is not a backdoor into production).
    await live({} as ToolCtx, {} as ToolDef, {});
    expect(fired).toEqual([]); // the test-global registration is NOT a backdoor into production
  });

  it("composeMutationChecks runs its checks in registration order (the mechanism Task 8/9 use)", async () => {
    const order: string[] = [];
    const gate = composeMutationChecks([
      { name: "a", check: async () => void order.push("a") },
      { name: "b", check: async () => void order.push("b") },
    ]);
    await gate({} as ToolCtx, {} as ToolDef, {});
    expect(order).toEqual(["a", "b"]);
    expect(gate.checks.length).toBe(2);
  });
});

describe("[FIX 3] idempotency keys off the SEMANTIC operation (arguments), never the JSON-RPC envelope id (REQ-106)", () => {
  it("two calls with the SAME arguments (any key order) derive the SAME key — a genuine retry dedupes", async () => {
    // RED before the fix: the key hashed the JSON-RPC id, so identical args under different ids diverged (double
    // -apply on retry) and different args under one reused id collided (silent drop). Now it hashes the args.
    const a = await deriveIdempotencyKey(PAIRING, "book", { shipment: "s1", pallets: 2 });
    const b = await deriveIdempotencyKey(PAIRING, "book", { pallets: 2, shipment: "s1" }); // key order differs
    expect(a).toBe(b);
  });

  it("NESTED arguments in a different key order derive the SAME key — the claim is recursive (audit §430)", async () => {
    // MEASURED: removing the recursion from `sortKeys` — sorting only the top level — left all 25 tests in
    // this file GREEN, and this is the only file that references deriveIdempotencyKey. The flat case above
    // cannot see it, because both its keys are top-level. What a regression costs: a genuine retry of a
    // MUTATING tool (book_shipment) whose arguments nest a stop or party object derives a DIFFERENT key, the
    // api does not recognise it as a replay, and the booking DOUBLE-APPLIES — the one failure mode REQ-106
    // exists to prevent, on the DoD's own MCP path.
    const a = await deriveIdempotencyKey(PAIRING, "book", { stop: { city: "PDX", seq: 1 }, ref: "r1" });
    const b = await deriveIdempotencyKey(PAIRING, "book", { ref: "r1", stop: { seq: 1, city: "PDX" } });
    expect(a).toBe(b);
  });

  it("nested ARRAY order is preserved, never sorted — [a,b] and [b,a] are different operations", async () => {
    // The mirror, and the reason `sortKeys` maps arrays instead of sorting them. Stop sequence is MEANING,
    // not key noise: a "helpful" array sort would collapse two genuinely different bookings into one key and
    // silently drop the second. Pinned so the recursion above cannot be "improved" into that.
    // PRIMITIVE elements deliberately. The first version of this test used [{id:"a"},{id:"b"}] and a
    // `.map(sortKeys).sort()` mutation left it GREEN: a comparator-less Array.sort stringifies every object
    // to "[object Object]", so it reorders nothing and the test could not see the very change it named.
    // Strings are what a naive sort actually reorders, which is what makes this assertion discriminating.
    const a = await deriveIdempotencyKey(PAIRING, "book", { stops: ["b", "a"] });
    const b = await deriveIdempotencyKey(PAIRING, "book", { stops: ["a", "b"] });
    expect(a).not.toBe(b);
  });

  it("two calls with DIFFERENT arguments derive DIFFERENT keys — no false replay", async () => {
    const a = await deriveIdempotencyKey(PAIRING, "book", { shipment: "s1" });
    const b = await deriveIdempotencyKey(PAIRING, "book", { shipment: "s2" });
    expect(a).not.toBe(b);
  });

  it("a client-supplied idempotency_key is authoritative (same op across differing other args); pairing/tool still scope it", async () => {
    const a = await deriveIdempotencyKey(PAIRING, "book", { idempotency_key: "op-1", shipment: "s1" });
    const b = await deriveIdempotencyKey(PAIRING, "book", { idempotency_key: "op-1", shipment: "s2" });
    expect(a).toBe(b); // the explicit operation token collapses them
    const other = await deriveIdempotencyKey("prn-other", "book", { idempotency_key: "op-1", shipment: "s1" });
    expect(a).not.toBe(other); // a different pairing never collides (REQ-025)
    expect(a.startsWith("mcp-idem-")).toBe(true); // header-safe token
  });

  it("the derived key threads into the tool ctx keyed off the validated ARGS (not the id)", async () => {
    const res = await call(deps(), toolsCall(42, "noop_mutation", { note: "x" }));
    const body = await bodyOf(res);
    expect(body.result?.structuredContent?.idempotencyKey).toBe(await deriveIdempotencyKey(PAIRING, "noop_mutation", { note: "x" }));
    // Same args under a DIFFERENT envelope id derive the SAME ctx key (the envelope id is irrelevant).
    const res2 = await call(deps(), toolsCall(99, "noop_mutation", { note: "x" }));
    expect((await bodyOf(res2)).result?.structuredContent?.idempotencyKey).toBe(body.result?.structuredContent?.idempotencyKey);
  });
});

describe("[FIX 2] mutatingCallApi structurally links a write to the chokepoint", () => {
  function baseCtx(overrides: Partial<ToolCtx> = {}): ToolCtx & { calls: number } {
    let calls = 0;
    const ctx = {
      env,
      pairingId: PAIRING,
      mintJwt: async () => "jwt",
      callApi: async () => {
        calls++;
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
      idempotencyKey: "mcp-idem-x",
      mutationCleared: false,
      ...overrides,
    } as ToolCtx & { calls: number };
    Object.defineProperty(ctx, "calls", { get: () => calls });
    return ctx;
  }

  it("a POST on an UNCLEARED ctx THROWS (never reaches the api)", async () => {
    const ctx = baseCtx({ mutationCleared: false });
    await expect(mutatingCallApi(ctx, { method: "POST", path: "/v1/book", body: {} })).rejects.toThrow();
    expect(ctx.calls).toBe(0);
  });

  it("a POST on a CLEARED ctx proceeds to the api", async () => {
    const ctx = baseCtx({ mutationCleared: true });
    const res = await mutatingCallApi(ctx, { method: "POST", path: "/v1/book", body: {} });
    expect(res.status).toBe(200);
    expect(ctx.calls).toBe(1);
  });

  it("a GET is allowed on an uncleared ctx (reads are not gated)", async () => {
    const ctx = baseCtx({ mutationCleared: false });
    const res = await mutatingCallApi(ctx, { method: "GET", path: "/v1/x" });
    expect(res.status).toBe(200);
    expect(ctx.calls).toBe(1);
  });
});

describe("[FIX 4] error hygiene — the catch-all never leaks internal messages (REQ-192)", () => {
  it("a handler throwing a PrincipalMintError yields a GENERIC client message (no pairing id / internal string)", async () => {
    // RED before the fix: the catch-all returned err.message verbatim → the pairing id leaked to the model.
    const boom = new ToolRegistry().register(
      defineTool({
        name: "boom",
        description: "throws a raw internal error",
        inputSchema: z.object({}),
        mutating: false,
        handler: async () => {
          throw new PrincipalMintError("no active mcp pairing: prn-SECRET-LEAK");
        },
      }),
    );
    const res = await call(deps({ registry: boom }), toolsCall(50, "boom"));
    const body = await bodyOf(res);
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toBe("internal error");
    expect(JSON.stringify(body)).not.toContain("prn-SECRET-LEAK"); // the internal detail never crosses the boundary
  });

  it("an INTENTIONAL ToolError still surfaces its message as an isError result (safe by design)", async () => {
    const res = await call(deps(), toolsCall(51, "whoami")); // whoami on default deps mints + reaches the api (200)
    expect(res.status).toBe(200); // control: the read path is unaffected
  });
});

describe("[FIX 5] auth before parse — an unauthenticated malformed request is a uniform 401", () => {
  it("no bearer + a malformed JSON body → 401 (not -32700)", async () => {
    // RED before the fix: index.ts pre-parsed the body and returned -32700 (HTTP 200) before auth ran.
    const req = new Request(`${ISSUER}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ this is not json",
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("an authenticated malformed body → a -32700 parse error (parse runs only after auth passes)", async () => {
    const token = await getAccessToken();
    const req = new Request(`${ISSUER}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{ still not json",
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).error?.code).toBe(-32700);
  });
});

describe("Zod-invalid arguments are rejected before anything downstream runs", () => {
  it("a bad argument type → a JSON-RPC error, and the chokepoint (hence any handler/api call) never runs", async () => {
    let gated = 0;
    const d = deps({
      beforeMutation: async () => {
        gated++;
      },
    });
    const res = await call(d, toolsCall(12, "noop_mutation", { note: 123 })); // note must be a string
    const body = await bodyOf(res);
    expect(body.error?.code).toBe(-32602); // invalid params
    expect(gated).toBe(0); // validation short-circuited before the mutation chokepoint (and before any api call)
  });

  it("an unknown tool name → a JSON-RPC error", async () => {
    const body = await bodyOf(await call(deps(), toolsCall(13, "no_such_tool")));
    expect(body.error?.code).toBe(-32602);
  });

  it("an unknown method → method-not-found", async () => {
    const body = await bodyOf(await call(deps(), { jsonrpc: "2.0", id: 14, method: "does/not/exist" }));
    expect(body.error?.code).toBe(-32601);
  });
});

// §1581 (REQ-035/192/118) — `isRecord` HAS TWO BEHAVIOURS IN ONE WORKER, AND THE PERMISSIVE ONE GUARDS THE WIRE.
//
// Three copies of `isRecord` live in `workers/mcp/src`. Two — `idempotency.ts` and `tools/document.ts` — read
// `typeof v === "object" && v !== null && !Array.isArray(v)`. The third, in `tools/registry.ts`, OMITS the array
// clause, so `isRecord([])` is **true** there and false in its siblings. That copy guards six call sites, four of
// them on model-supplied JSON-RPC.
//
// Three of the four are saved by the NEXT line — an array reaching `asJsonRpcRequest` dies on
// `message.jsonrpc !== "2.0"`, and `params.name` / `params.arguments` on an array are simply `undefined`. The
// fourth is not: `toToolResult` puts any `isRecord` value into `structuredContent`, so a tool returning an ARRAY
// produces `structuredContent: [...]` — not an object, which is what the field is specified to be, and what the
// REST mirror then answers as the whole body (§1575).
//
// Unreachable today: all six real tools return object literals. This pins the boundary anyway, because the
// distance between "no tool does that" and "a tool does that" is one handler.
describe("§1581 REQ-035: a non-object tool return does not become structuredContent", () => {
  it("a tool returning an ARRAY yields a text block only — arrays are not records", async () => {
    const arrayTool = new ToolRegistry().register(
      defineTool({
        name: "arr",
        description: "returns an array",
        inputSchema: z.object({}),
        mutating: false,
        handler: async () => [{ a: 1 }, { a: 2 }],
      }),
    );
    const res = await call(deps({ registry: arrayTool }), toolsCall(51, "arr"));
    const body = await bodyOf(res);
    expect(body.result?.content?.[0]?.text, "the array must still reach the caller as text").toBe('[{"a":1},{"a":2}]');
    expect(
      body.result?.structuredContent,
      "an ARRAY became structuredContent — the field is specified to be an object, and the REST mirror returns it " +
        "as the entire response body. `isRecord` in registry.ts is missing the `!Array.isArray(v)` its two siblings have.",
    ).toBeUndefined();
  });
});
