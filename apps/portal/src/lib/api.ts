// REQ-085 — the portal's typed fetch client: the FIRST browser→API client in the repo. It is a thin,
// honest wrapper over `fetch`:
//   - base URL from a build-time env var (VITE_API_BASE), defaulting to a SYNTHETIC `.example` host so no
//     real tenant/customer domain ever ships in source (REQ-167);
//   - EVERY mutation carries a FRESH `Idempotency-Key` — the API rejects `/v1/*` mutations without one and
//     replays a duplicate key's original result (workers/api/src/middleware/idempotency.ts, REQ-156);
//   - the session bearer is attached WHEN PRESENT, so `/pub/*` guest/public calls work token-less;
//   - a non-2xx becomes a typed `ApiError` carrying the server's stable `code` (the `{code, message, req_id}`
//     envelope, REQ-156). A 401 is distinguishable via `isAuthError` so a view can drop the session and
//     re-prompt for a magic link.
// CORS is handled server-side (WP-09 Task 5); this client just makes normal cross-origin fetches.
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
 * A typed API failure the portal views branch on. `code` is the server's stable ErrorCode when the body was
 * a well-formed envelope. `isAuthError` (a 401) is the re-auth signal: the caller should `session.clear()`
 * and re-prompt for a magic link.
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

  /** A 401 — the token is missing/expired/rejected; the portal must re-authenticate. */
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

  // Attach the party JWT when the session has one; `/pub/*` calls simply run token-less.
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

/** GET a path (token attached when present). Token-less for `/pub/*`. */
export function get<T>(path: string): Promise<T> {
  return request<T>("GET", path);
}

/** POST a JSON body to a path with a fresh Idempotency-Key + the bearer (when present). */
export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>("POST", path, body);
}
