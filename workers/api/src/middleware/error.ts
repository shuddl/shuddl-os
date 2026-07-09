import type { Context, Next } from "hono";
import type { ErrorCode, ErrorEnvelope as ErrorEnvelopeType } from "@shuddl/contracts";
import { logEvent } from "../log.js";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    public status: number,
    message: string,
    public gate?: { required_evidence: string[] },
  ) {
    super(message);
  }
}

type StatusCode = 400 | 401 | 403 | 404 | 500;

export function envelope(c: Context, code: ErrorCode, status: number, message: string, gate?: ErrorEnvelopeType["gate"]): Response {
  const body: ErrorEnvelopeType = {
    code,
    message,
    req_id: (c.get("req_id") as string | undefined) ?? crypto.randomUUID(),
    ...(gate ? { gate } : {}),
  };
  return c.json(body, status as StatusCode);
}

export async function reqId(c: Context, next: Next): Promise<void> {
  c.set("req_id", crypto.randomUUID());
  await next();
}

// REQ-156: every error leaving this worker is the envelope — wired via app.onError
// (Hono routes thrown errors to the app error handler, not to outer middleware).
export function handleError(err: Error, c: Context): Response {
  if (err instanceof ApiError) return envelope(c, err.code, err.status, err.message, err.gate);
  logEvent("error.unhandled", { message: err.message }, c.get("req_id") as string | undefined);
  return envelope(c, "INTERNAL", 500, "INTERNAL ERROR");
}
