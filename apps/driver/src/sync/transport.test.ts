import { describe, expect, it } from "vitest";
import { createTransports } from "./transport.js";

// §849 — THE DRIVER'S HTTP BOUNDARY, WHICH HAD NO TEST AT ALL.
//
// `createTransports` was imported by ZERO tests (measured §849) — the whole thing deciding whether a signed
// capture leaves the device. §848 pinned `classifyStatus`, the pure function one layer up, and that gate is
// blind to everything below it: it can only classify the status the transport hands it.
//
// THE DEFECT THIS FILE EXISTS FOR. Without `redirect: "error"` the platform default `follow` applies and
// `res.status` is the FINAL response's status, so a captive portal answering 302 → login page has its
// redirect followed, the login page returns 200, and the queue reads that as the sequencer's ack and DROPS a
// signed capture that never arrived. The API never returns a 3xx, so a redirect here is always an
// interceptor — refusing it is a statement of fact, not a heuristic.

const EVENT = { id: "e-1", shipment_id: "s-1", kind: "freight.counted" } as never;
const DEFERRED = { bytes: new Uint8Array([1, 2, 3]), photo_hash: "a".repeat(64) } as never;

/** A fetch stand-in that records the RequestInit it was given and answers with `res`. */
function spyFetch(res: Response | Error): { fetchImpl: typeof fetch; seen: RequestInit[] } {
  const seen: RequestInit[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    seen.push(init ?? {});
    if (res instanceof Error) throw res;
    return res;
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const opts = (fetchImpl: typeof fetch) => ({ baseUrl: "", getToken: () => "tok", fetchImpl });

describe("§849: the driver transport refuses redirects", () => {
  it("BOTH legs send redirect:'error' — a captive portal's 302 can never be followed into a 200", async () => {
    // The assertion that would have caught the defect. It reads the RequestInit rather than the response,
    // because the bug is in what we ASK for: with `follow`, the 200 we get back is the login page's.
    const ev = spyFetch(new Response("{}", { status: 202 }));
    await createTransports(opts(ev.fetchImpl)).sendEvent(EVENT);
    expect(ev.seen[0]?.redirect, "the event leg must refuse redirects").toBe("error");

    const evi = spyFetch(new Response("{}", { status: 202 }));
    await createTransports(opts(evi.fetchImpl)).sendEvidence(DEFERRED, EVENT);
    expect(evi.seen[0]?.redirect, "the evidence leg must refuse redirects").toBe("error");
  });

  it("a redirect THROWS in fetch and surfaces as status 0 — retryable, so the capture stays queued", async () => {
    // What `redirect: "error"` actually does at runtime: fetch rejects. The existing catch maps that to 0,
    // and classifyStatus(0) is "retry" (§848). The capture is never dropped and never parked.
    const { fetchImpl } = spyFetch(new TypeError("Failed to fetch: redirect"));
    const t = createTransports(opts(fetchImpl));
    await expect(t.sendEvent(EVENT)).resolves.toEqual({ status: 0 });
    await expect(t.sendEvidence(DEFERRED, EVENT)).resolves.toEqual({ status: 0 });
  });

  it("a real acceptance still acks, and a 5xx still retries (non-vacuity)", async () => {
    // Without this, a transport that returned {status:0} unconditionally would satisfy the test above.
    const ok = createTransports(opts(spyFetch(new Response("{}", { status: 202 })).fetchImpl));
    await expect(ok.sendEvent(EVENT)).resolves.toEqual({ status: 202 });

    const down = createTransports(opts(spyFetch(new Response("", { status: 503 })).fetchImpl));
    await expect(down.sendEvent(EVENT)).resolves.toEqual({ status: 503 });
  });

  it("no session → 401 without touching the network; no shipment → 422", async () => {
    // Both legs refuse before spending a request. `getToken` returning null is the signed-out state the UI
    // clears on; a capture with no shipment cannot be routed and is an operator problem, not a retry.
    const spy = spyFetch(new Response("{}", { status: 202 }));
    const noTok = createTransports({ baseUrl: "", getToken: () => null, fetchImpl: spy.fetchImpl });
    await expect(noTok.sendEvent(EVENT)).resolves.toEqual({ status: 401 });
    await expect(noTok.sendEvidence(DEFERRED, EVENT)).resolves.toEqual({ status: 401 });

    const noShip = createTransports(opts(spy.fetchImpl));
    await expect(noShip.sendEvent({ id: "e-2" } as never)).resolves.toEqual({ status: 422 });
    expect(spy.seen, "neither refusal may reach the network").toHaveLength(0);
  });
});
