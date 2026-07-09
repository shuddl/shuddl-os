import { z } from "zod";

// REQ-156: stable error codes; gate refusals carry the evidence requirement (doc 14 §04, L6).
export const ErrorCode = z.enum([
  "GATE_BLOCKED",
  "FLOOR_APPROVAL_REQUIRED",
  "UNKNOWN_NO_PRICE",
  "VALIDATION_FAILED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "TENANT_MISMATCH",
  "IDEMPOTENCY_KEY_REQUIRED",
  "NOT_FOUND",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelope = z.object({
  code: ErrorCode,
  message: z.string(),
  req_id: z.string(),
  event_ids: z.array(z.string()).optional(),
  gate: z.object({ required_evidence: z.array(z.string()) }).optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
