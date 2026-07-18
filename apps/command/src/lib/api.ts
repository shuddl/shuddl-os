// REQ-081 — the COMMAND surface's typed fetch client. A thin, honest wrapper over `fetch`, adapted from the
// portal's (apps/portal/src/lib/api.ts) so both surfaces share one discipline:
//   - base URL from a build-time env var (VITE_API_BASE), defaulting to a SYNTHETIC `.example` host so no
//     real tenant/customer domain ever ships in source (REQ-167);
//   - EVERY mutation carries a FRESH `Idempotency-Key` — the API rejects `/v1/*` mutations without one and
//     replays a duplicate key's original result (workers/api/src/middleware/idempotency.ts, REQ-156);
//   - the session bearer is attached WHEN PRESENT (the token-less shape is kept even though the command
//     surface has no public calls today — the api client only ever READS the token, never writes it);
//   - a non-2xx becomes a typed `ApiError` carrying the server's stable `code` (the `{code, message, req_id}`
//     envelope, REQ-156). A 401 is distinguishable via `isAuthError` so the shell can drop the session and
//     re-prompt for a magic link. The server lens (`1=1` for the tenant roles) remains the real gate (REQ-030).
import { ErrorEnvelope, type ErrorCode } from "@shuddl/contracts";
import { getToken } from "../session.js";

// A SYNTHETIC placeholder (REQ-167). `.example` is a reserved TLD (RFC 2606), so it can never resolve to
// a real customer/tenant host. The real per-environment origin is injected at build via VITE_API_BASE.
const DEFAULT_API_BASE = "https://api.shuddl.example";

/** The API origin, read LAZILY so a build-time VITE_API_BASE (or a test stub) always wins. No trailing slash. */
export function apiBase(): string {
  const configured = import.meta.env.VITE_API_BASE;
  return (configured ?? DEFAULT_API_BASE).replace(/\/+$/, "");
}

// Server ErrorCodes plus two client-only sentinels: BAD_RESPONSE (a non-2xx whose body was not the
// envelope — e.g. an edge 502 HTML page) and NETWORK (fetch itself rejected, e.g. offline).
export type ApiErrorCode = ErrorCode | "BAD_RESPONSE" | "NETWORK";

/**
 * A typed API failure command views branch on. `code` is the server's stable ErrorCode when the body was a
 * well-formed envelope. `isAuthError` (a 401) is the re-auth signal: the caller should `session.clear()` and
 * re-prompt for a magic link.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    message: string,
    readonly reqId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** A 401 — the token is missing/expired/rejected; the command shell must re-authenticate. */
  get isAuthError(): boolean {
    return this.status === 401 || this.code === "UNAUTHORIZED";
  }
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// Map a non-2xx response to a typed error. A well-formed envelope carries its stable `code`/`req_id`
// through; anything else (proxy error page, empty body) collapses to BAD_RESPONSE so callers still get
// a typed failure rather than a raw parse throw.
function toApiError(status: number, body: unknown): ApiError {
  const env = ErrorEnvelope.safeParse(body);
  if (env.success) return new ApiError(env.data.code, status, env.data.message, env.data.req_id);
  return new ApiError("BAD_RESPONSE", status, `HTTP ${status}`);
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };

  // Attach the tenant JWT when the session has one; the client keeps working token-less otherwise.
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  // A FRESH key per mutation — never reused across calls, so a retry of THIS call replays but a distinct
  // action gets a distinct key.
  if (method !== "GET") headers["idempotency-key"] = crypto.randomUUID();

  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, init);
  } catch {
    throw new ApiError("NETWORK", 0, "NETWORK REQUEST FAILED");
  }

  const text = await res.text();
  const parsed: unknown = text ? tryJson(text) : undefined;
  if (!res.ok) throw toApiError(res.status, parsed);
  return parsed as T;
}

/** GET a path (token attached when present). */
export function get<T>(path: string): Promise<T> {
  return request<T>("GET", path);
}

/** POST a JSON body to a path with a fresh Idempotency-Key + the bearer (when present). */
export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>("POST", path, body);
}
