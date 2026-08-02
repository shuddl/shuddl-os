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

// The sequencer's TENANT-POLICY refusal reason, shared for exactly the reason stated above (2026-08-02 §31).
//
// The DO refuses every append for a tenant whose control-plane policy is unusable or absent (§18/§19), and
// the agents queue consumer classifies that refusal as DETERMINISTIC so its DLQ path logs an operator action
// instead of five "retriable failure" lines. §23 shipped that consumer as a free-text regex over the message
// — four lines from `GATE_BLOCKED_PREFIX`, which exists BECAUSE this repo already learned that a rule
// enforced in more than one place must share its matcher. The test hardcoded the same literal, so rewording
// the producer's `reason` would have left the branch dead AND the test green: the "fix that cannot fail"
// shape, one level up.
//
// A review's probe (a real cross-script DO whose append throws) confirmed the message DOES survive the RPC
// hop intact, so the consumer branch is live — the risk was drift, not reachability.
export const TENANT_POLICY_MALFORMED_REASON = "tenant policy malformed" as const;

/** True for the sequencer's tenant-policy refusal, whatever wrapping the RPC hop applied. Producer and every
 *  consumer must go through this — never a literal (see above). */
export function isTenantPolicyRefusal(err: unknown): boolean {
  return err instanceof Error && err.message.includes(TENANT_POLICY_MALFORMED_REASON);
}

export const ErrorEnvelope = z.object({
  code: ErrorCode,
  message: z.string(),
  req_id: z.string(),
  event_ids: z.array(z.string()).optional(),
  gate: z.object({ required_evidence: z.array(z.string()) }).optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
