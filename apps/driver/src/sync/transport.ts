import type { EventTransport, EvidenceTransport } from "@shuddl/driver-core/sync";

// Task 11 (REQ-016/017/030) — the driver PWA's REAL HTTP transports for the pure sync engine
// (@shuddl/driver-core/sync). The event leg POSTs the signed offline event to the sequencer; the evidence
// leg POSTs the deferred bytes to the byte-verify endpoint. Both carry the authenticated bearer and a
// fresh Idempotency-Key per attempt — a transient failure is never memoized, and true duplicate
// suppression is owned server-side (the sequencer dedupes by event id; /v1/evidence by (shipment, hash)).
// A network throw maps to status 0 (retryable). All authorization is server-side (REQ-030); this only
// carries the token.
//
// `redirect: "error"` ON BOTH LEGS (audit §849). Without it the platform default `follow` applies, and
// `res.status` is the status of the FINAL response — so a CAPTIVE PORTAL on truck-stop or depot wifi that
// answers 302 → login page has its redirect FOLLOWED, the login page returns 200, and `classifyStatus` reads
// that as the sequencer's ack and DROPS a signed capture that never reached the server.
//
// §848 pinned `classifyStatus` so a 3xx retries — and that gate is blind here, because the function is handed
// the portal's 200 and never sees the 302. Pinning a pure function proves nothing about what its caller feeds
// it.
//
// This is safe to state absolutely rather than heuristically: the API NEVER returns a 3xx (no `.redirect(`,
// no 30x status anywhere in workers/api/src — measured §849), so a redirect on this path is always an
// interceptor and never our sequencer. `fetch` throws on one, the `catch` below maps it to status 0, and
// `classifyStatus(0)` retries — the capture stays queued for the next drain.

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
        redirect: "error", // §849 — a 3xx here is an interceptor, never the sequencer

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
        redirect: "error", // §849 — a 3xx here is an interceptor, never the sequencer

      });
      return { status: res.status };
    } catch {
      return { status: 0 };
    }
  };

  return { sendEvent, sendEvidence };
}
