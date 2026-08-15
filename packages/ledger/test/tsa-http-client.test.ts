import { describe, expect, it } from "vitest";
import { HttpTsaClient } from "../src/tsa/client.js";
import { buildGrantedTimeStampResp, readChildren, readTlv } from "../src/tsa/der.js";

// §1556 (REQ-014/118) — THE ONE OUTBOUND PATH NO TEST DRIVES IS THE ONE PROD RUNS FIRST.
//
// §1555's lesson — *a captured request is not an examined one* — swept across every outbound POST the system
// makes. Five sites. Three are the LLM callers §1555 closed. The evidence-email sender is exemplary: its case
// reads the URL, the method, all three headers and EVERY body field. The fifth is this one, and it is driven by
// nothing at all.
//
// `HttpTsaClient` is not dark by accident — `tsa-client-parity.test.ts` pins that non-prod returns a
// `FakeTsaClient` and only prod can reach the real one, and "Real TSA (RFC-3161) endpoint" is a filed go-live
// row. But those two facts TOGETHER are the hazard: the fake bypasses the HTTP client entirely, so the code that
// assembles the TimeStampReq, sets the content type and verifies the response against its OWN nonce has never
// executed. **The first thing to run it will be production**, on the anchor chain — the daily merkle receipt
// that makes the ledger verifiable, and the bytes §1536 stopped the retention sweep from deleting.
//
// The stub here does what a real TSA does: it DECODES the request, reads the imprint and nonce the client chose,
// and answers a granted response built for them. That is what makes this a round-trip rather than a shape check
// — the nonce is generated inside `timestamp()`, never passed in, so a response can only match if the request
// genuinely carried it.

const IMPRINT = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);

/** Decode a TimeStampReq: SEQUENCE { INTEGER version, SEQUENCE messageImprint, INTEGER nonce, BOOLEAN certReq }. */
function decodeReq(bytes: Uint8Array): { imprint: Uint8Array; nonce: bigint; version: number } {
  const outer = readTlv(bytes, 0);
  const kids = readChildren(bytes, outer.contentStart, outer.contentEnd);
  const version = Number(bytes[kids[0]!.contentStart]);
  const imprintKids = readChildren(bytes, kids[1]!.contentStart, kids[1]!.contentEnd);
  const digestTlv = imprintKids[1]!; // OCTET STRING, after the AlgorithmIdentifier SEQUENCE
  const imprint = bytes.slice(digestTlv.contentStart, digestTlv.contentEnd);
  let nonce = 0n;
  for (let i = kids[2]!.contentStart; i < kids[2]!.contentEnd; i += 1) nonce = (nonce << 8n) | BigInt(bytes[i]!);
  return { imprint, nonce, version };
}

interface Captured {
  url: string;
  contentType: string | null;
  req: { imprint: Uint8Array; nonce: bigint; version: number };
}

/** A stub that behaves like a TSA: decodes the query, grants a receipt for the nonce the CLIENT chose. */
function tsaStub(opts: { status?: number; nonceShift?: bigint } = {}): { calls: Captured[]; fetchImpl: typeof fetch } {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const bytes = new Uint8Array(init!.body as ArrayBuffer);
    const req = decodeReq(bytes);
    calls.push({
      url: typeof input === "string" ? input : String(input),
      contentType: new Headers(init!.headers).get("content-type"),
      req,
    });
    const status = opts.status ?? 200;
    if (status !== 200) return new Response("nope", { status });
    const resp = buildGrantedTimeStampResp(req.imprint, req.nonce + (opts.nonceShift ?? 0n), new Date("2026-01-01T00:00:00Z"));
    return new Response(resp as BodyInit, { status: 200, headers: { "content-type": "application/timestamp-reply" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

// NOTE the shape: `HttpTsaClient(config, fetchImpl)` takes the transport as a SECOND POSITIONAL argument, not
// as a config field. Writing `{ url, fetchImpl }` compiles — `fetchImpl` is simply an unknown extra key — and
// silently uses the REAL global fetch, which is how the first draft of this file reached a live DNS lookup
// inside workerd and failed with an opaque "internal error". A signature nothing calls is a signature nothing
// has had to get right.
const mk = (fetchImpl: typeof fetch): HttpTsaClient =>
  new HttpTsaClient({ url: "https://tsa.example/timestamp" }, fetchImpl);

describe("§1556 REQ-014: the real TSA client assembles a valid query and verifies the reply against its own nonce", () => {
  it("POSTs an RFC-3161 TimeStampReq to the configured URL carrying the imprint, and returns the granted receipt", async () => {
    const { calls, fetchImpl } = tsaStub();
    const receipt = await mk(fetchImpl).timestamp(IMPRINT);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url, "the client no longer posts to its configured endpoint").toBe("https://tsa.example/timestamp");
    expect(call.contentType, "a real TSA rejects a query that is not application/timestamp-query").toBe("application/timestamp-query");
    expect(call.req.version, "TimeStampReq version must be 1").toBe(1);
    expect([...call.req.imprint], "the query carried a different digest than the caller asked to stamp").toEqual([...IMPRINT]);
    expect(receipt.byteLength, "no receipt bytes came back").toBeGreaterThan(0);
  });

  it("the NONCE round-trips: a reply granted for a different nonce is REFUSED", async () => {
    // The nonce is generated inside timestamp() and never passed in, so this is the case that proves the request
    // genuinely carried it — a shape assertion could not. It is also the anti-replay property itself: a receipt
    // minted for someone else's query must not be accepted as this day's anchor.
    const ok = tsaStub();
    await expect(mk(ok.fetchImpl).timestamp(IMPRINT)).resolves.toBeInstanceOf(Uint8Array);

    const shifted = tsaStub({ nonceShift: 1n });
    await expect(
      mk(shifted.fetchImpl).timestamp(IMPRINT),
      "a receipt granted for a DIFFERENT nonce was accepted — the anti-replay check is not reached from the HTTP path",
    ).rejects.toThrow();
  });

  it("a non-2xx TSA answer is a named failure, not a silent unanchored day", async () => {
    const { fetchImpl } = tsaStub({ status: 503 });
    await expect(mk(fetchImpl).timestamp(IMPRINT)).rejects.toThrow(/TSA_HTTP_503/);
  });
});
