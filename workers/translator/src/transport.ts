// THE OUTBOUND EDI TRANSPORT PORT (REQ-200/REQ-035 seam) — the Translator's downstream, best-effort
// transmission seam for a serialized X12 214. Mirrors the Biller's EvidenceSender port discipline:
//
// 1. A transport REJECTS to signal failure; the sweep treats a rejection as "not sent" and writes the R2
//    "214 already sent" marker ONLY after a successful send. So a failed/unwired send NEVER leaves a
//    sent-marker behind, and the next sweep tick re-attempts — the marker is the truth of what went out.
// 2. NotConfiguredTransport is the default when no transport creds are bound: it rejects LOUDLY (a silent
//    no-op is forbidden — an operator must never believe a 214 went out when nothing is wired). Because the
//    sweep only marks-as-sent on success, an unconfigured environment can never transmit real EDI AND never
//    records a phantom send. Going live is a CONFIRM-gated config flip (creds + partner certification), not
//    code. `retriable: true` — binding a real transport and re-running the (idempotent) sweep succeeds.
// 3. RecordingTransport is the tests/dev adapter: it records every (partnerScac, bytes, idempotencyKey) it
//    accepts, in send order, so a test can assert exactly one byte-stable 214 was transmitted. Deterministic.
//
// The idempotency key the sweep passes is the buildStatusView dedupeKey (`edi214/<newest-status-event-id>`),
// so a live VAN/AS2 adapter can dedupe a redelivery the same way Resend dedupes on Idempotency-Key.

export interface EdiTransport {
  /** Transmit the serialized 214 wire bytes to the partner (keyed by SCAC). REJECTS on any failure. */
  send214(partnerScac: string, bytes: string, idempotencyKey: string): Promise<void>;
  /**
   * Transmit the serialized 990 (tender response) wire bytes to the partner (keyed by SCAC). REJECTS on any
   * failure — same discipline as send214: the Task-8 inbound handler treats a rejection as "not transmitted"
   * (best-effort acknowledgment; the 204 was still recorded). The idempotency key is the accepted-quote-derived
   * `edi990/<id>` so a live VAN/AS2 adapter dedupes a redelivered acceptance exactly as it dedupes a 214.
   */
  send990(partnerScac: string, bytes: string, idempotencyKey: string): Promise<void>;
}

/**
 * Transport failure. `retriable: true` ⇒ re-running the sweep may succeed (unwired transport, network/5xx);
 * `false` ⇒ re-attempting cannot help (a validation-adjacent reject) and the shipment holds for a human. The
 * sweep isolates this per shipment (log + continue) so one partner's outage never stalls the tenant's sweep.
 */
export class TransportError extends Error {
  readonly retriable: boolean;
  constructor(message: string, retriable: boolean) {
    super(message);
    this.name = "TransportError";
    this.retriable = retriable;
  }
}

/**
 * The default when no transport is bound. A VALID send rejects loudly and actionably (retriable), so the
 * sweep logs + continues and writes NO sent-marker — nothing is ever recorded as transmitted from an unwired
 * environment. async so the failure REJECTS (a sync throw from a Promise-returning port could slip a caller's
 * .catch()), matching NotConfiguredSender.
 */
export class NotConfiguredTransport implements EdiTransport {
  async send214(partnerScac: string, _bytes: string, idempotencyKey: string): Promise<void> {
    throw new TransportError(
      `EdiTransport is NOT CONFIGURED: no outbound transport is bound in this environment, so the 214 for ` +
        `SCAC ${partnerScac} (${idempotencyKey}) was NOT transmitted. Nothing is recorded as sent. Live EDI ` +
        `requires the CONFIRM-gated transport creds (EDI_TRANSPORT_URL + EDI_TRANSPORT_TOKEN via ` +
        `\`wrangler secret put\`) AND a replay-certified partner (REQ-203). Retriable once wired.`,
      true,
    );
  }

  // Same fail-closed discipline as send214: the 990 acknowledgment is best-effort, so the inbound handler
  // CATCHES this rejection and no-ops (the 204 was still recorded + the chain appended). No environment
  // transmits a real 990 until the CONFIRM-gated transport is wired.
  async send990(partnerScac: string, _bytes: string, idempotencyKey: string): Promise<void> {
    throw new TransportError(
      `EdiTransport is NOT CONFIGURED: no outbound transport is bound in this environment, so the 990 for ` +
        `SCAC ${partnerScac} (${idempotencyKey}) was NOT transmitted. The inbound 204 was still recorded and ` +
        `its gated chain appended; only the partner acknowledgment is deferred. Retriable once wired.`,
      true,
    );
  }
}

export interface TransmittedRecord {
  partnerScac: string;
  bytes: string;
  idempotencyKey: string;
}

/**
 * RecordingTransport — the tests/dev adapter. Records every accepted transmission in send order. Idempotent
 * by idempotencyKey: a repeat key + identical bytes returns without a second record (mirrors Resend's
 * Idempotency-Key semantics, so a test can prove a re-run transmits nothing new); a repeat key with DIFFERENT
 * bytes is a byte-stability bug and rejects loudly (one newest-status event must serialize to exactly one 214).
 */
export class RecordingTransport implements EdiTransport {
  readonly sent: TransmittedRecord[] = [];
  /** 990 acknowledgments recorded separately from the 214 status stream (distinct doc types, distinct assertions). */
  readonly sent990: TransmittedRecord[] = [];
  private readonly byKey = new Map<string, string>();

  async send214(partnerScac: string, bytes: string, idempotencyKey: string): Promise<void> {
    const prior = this.byKey.get(idempotencyKey);
    if (prior !== undefined) {
      if (prior !== bytes) {
        throw new TransportError(
          `RecordingTransport: byte-stability CONFLICT — idempotency key "${idempotencyKey}" was already ` +
            `transmitted with DIFFERENT bytes. One newest-status event must serialize to exactly one 214.`,
          false,
        );
      }
      return; // same key + same bytes → the original transmission; no second record
    }
    this.byKey.set(idempotencyKey, bytes);
    this.sent.push({ partnerScac, bytes, idempotencyKey });
  }

  // Mirrors send214's idempotency: a repeat key + identical bytes returns without a second record; a repeat key
  // with DIFFERENT bytes is a byte-stability bug and rejects loudly. Keyed in the SAME map so a 214 and a 990
  // can never collide on one key (they use disjoint `edi214/`/`edi990/` prefixes).
  async send990(partnerScac: string, bytes: string, idempotencyKey: string): Promise<void> {
    const prior = this.byKey.get(idempotencyKey);
    if (prior !== undefined) {
      if (prior !== bytes) {
        throw new TransportError(
          `RecordingTransport: byte-stability CONFLICT — idempotency key "${idempotencyKey}" was already ` +
            `transmitted with DIFFERENT bytes. One accepted tender must serialize to exactly one 990.`,
          false,
        );
      }
      return;
    }
    this.byKey.set(idempotencyKey, bytes);
    this.sent990.push({ partnerScac, bytes, idempotencyKey });
  }
}
