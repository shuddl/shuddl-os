import type { EventTransport, EvidenceTransport } from "@shuddl/driver-core/sync";

// Task 11 (REQ-016/017/030) — the driver PWA's REAL HTTP transports for the pure sync engine
// (@shuddl/driver-core/sync). The event leg POSTs the signed offline event to the sequencer; the evidence
// leg POSTs the deferred bytes to the byte-verify endpoint. Both carry the authenticated bearer and a
// fresh Idempotency-Key per attempt — a transient failure is never memoized, and true duplicate
// suppression is owned server-side (the sequencer dedupes by event id; /v1/evidence by (shipment, hash)).
// A network throw maps to status 0 (retryable). All authorization is server-side (REQ-030); this only
// carries the token.

export interface TransportOptions {
  /** The API origin (same-origin "" in dev). */
  readonly baseUrl: string;
  /** The authenticated bearer, or null when there is no session. */
  readonly getToken: () => string | null;
  /** Injectable for tests; defaults to the platform fetch. */
  readonly fetchImpl?: typeof fetch;
}

export interface DriverTransports {
  sendEvent: EventTransport;
  sendEvidence: EvidenceTransport;
}

export function createTransports(opts: TransportOptions): DriverTransports {
  const doFetch = opts.fetchImpl ?? fetch;

  const sendEvent: EventTransport = async (event) => {
    const token = opts.getToken();
    if (!token) return { status: 401 }; // no session → auth block (the engine halts, the UI clears)
    const shipmentId = event.shipment_id;
    if (!shipmentId) return { status: 422 }; // a driver capture with no shipment can't route — operator block
    try {
      const res = await doFetch(`${opts.baseUrl}/v1/shipments/${encodeURIComponent(shipmentId)}/events`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      return { status: res.status };
    } catch {
      return { status: 0 }; // network error — retryable
    }
  };

  const sendEvidence: EvidenceTransport = async (deferred, event) => {
    const token = opts.getToken();
    if (!token) return { status: 401 };
    const shipmentId = event.shipment_id;
    if (!shipmentId) return { status: 422 };
    try {
      const url = `${opts.baseUrl}/v1/evidence?shipment_id=${encodeURIComponent(shipmentId)}&photo_hash=${encodeURIComponent(deferred.hash)}`;
      const res = await doFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/octet-stream" },
        body: deferred.bytes as BodyInit,
      });
      return { status: res.status };
    } catch {
      return { status: 0 };
    }
  };

  return { sendEvent, sendEvidence };
}
