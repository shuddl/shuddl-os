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

export async function errorEnvelope(c: Context, next: Next): Promise<Response | void> {
  c.set("req_id", crypto.randomUUID());
  try {
    await next();
  } catch (err) {
    if (err instanceof ApiError) return envelope(c, err.code, err.status, err.message, err.gate);
    logEvent("error.unhandled", { message: err instanceof Error ? err.message : String(err) }, c.get("req_id") as string);
    return envelope(c, "INTERNAL", 500, "INTERNAL ERROR");
  }
}
