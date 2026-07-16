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

// The wire PREFIX a Durable Object refusal carries so its ErrorCode survives the DO→Workers RPC hop (which
// preserves only Error.name + message): every refusal is thrown as `Error("<CODE>:<json>")`. DERIVED from the
// ErrorCode enum value so it can NEVER drift from the code. ONE source of truth for the three modules that
// otherwise hardcode the literal disjointly: the PRODUCER (GateError in packages/ledger builds the message),
// the ROUTE consumer (workers/api/src/routes/events.ts maps it → 403), and the BOOKING-agent consumer
// (workers/agents/src/booking.ts gateBlock → held). If any of those drifted from this, a gate-blocked booking
// would silently DLQ-loop instead of holding (share-lint law: one rule enforced in >1 place shares its matcher).
export const GATE_BLOCKED_PREFIX = `${ErrorCode.enum.GATE_BLOCKED}:` as const;
export const VALIDATION_FAILED_PREFIX = `${ErrorCode.enum.VALIDATION_FAILED}:` as const;

export const ErrorEnvelope = z.object({
  code: ErrorCode,
  message: z.string(),
  req_id: z.string(),
  event_ids: z.array(z.string()).optional(),
  gate: z.object({ required_evidence: z.array(z.string()) }).optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
