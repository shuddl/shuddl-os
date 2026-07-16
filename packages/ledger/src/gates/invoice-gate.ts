// I2 / REQ-030: the invoice gate is enforced at the LEDGER level, so every API path that would
// append an `invoice.issued` hits the same server-side check (UIs merely reflect it). The Task-13
// sequencer calls assertPodSigned before it appends the event.

import { GATE_BLOCKED_PREFIX } from "@shuddl/contracts";

// The gate refusal must survive a Durable Object → Workers RPC hop, which preserves ONLY an
// Error's `name` and `message`. So the machine-readable evidence requirement is encoded INTO the
// message as `GATE_BLOCKED:{json}` (the ErrorEnvelope code, a colon, then the JSON payload). The
// wire prefix is the SHARED GATE_BLOCKED_PREFIX (derived from the ErrorCode enum) — the SAME constant the
// route (events.ts) and the Booking agent (booking.ts gateBlock) match on, so this producer can never
// drift from its consumers. The structured `required_evidence` field is a convenience for same-isolate callers.
export class GateError extends Error {
  readonly required_evidence: string[];
  constructor(requiredEvidence: string[]) {
    super(`${GATE_BLOCKED_PREFIX}${JSON.stringify({ required_evidence: requiredEvidence })}`);
    this.name = "GateError";
    this.required_evidence = requiredEvidence;
  }
}

export interface GatePolicy {
  gates?: {
    // Tenant-configured service classes allowed to invoice without a signed POD (e.g. blind ship,
    // will-call). Everything else is gated. A missing/empty list gates every class.
    invoice_without_pod_classes?: string[];
  };
}

/**
 * Throws GateError({ required_evidence: ["pod.signed"] }) unless a `pod.signed` event already
 * exists on this STREAM (caller passes the stream id, e.g. `s:shp-1`, never a bare shipment id),
 * or the shipment's `serviceClass` is on the tenant's invoice_without_pod_classes exception list.
 */
export async function assertPodSigned(
  db: D1Database,
  streamId: string,
  policy?: GatePolicy,
  serviceClass?: string,
): Promise<void> {
  const exempt = policy?.gates?.invoice_without_pod_classes ?? [];
  if (serviceClass !== undefined && exempt.includes(serviceClass)) return;

  const row = await db
    .prepare("SELECT 1 AS present FROM events WHERE stream_id = ? AND kind = 'pod.signed' LIMIT 1")
    .bind(streamId)
    .first<{ present: number }>();
  if (row === null) throw new GateError(["pod.signed"]);
}
