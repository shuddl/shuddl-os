import { describe, expect, it } from "vitest";
import type { EventInput } from "@shuddl/contracts";
import { SequencerPlatformLedger, PlatformLedgerNotConfiguredError, platformLedgerFor } from "../src/platform-ledger.js";

// §1291 (REQ-123/154/025/206) — THE PLATFORM APPEND TRANSPORT, WHICH NO TEST TOUCHED.
//
// Found by the ownership map, not by reading: `git grep -l platformLedgerFor -- '*test*'` returned NOTHING.
// Every webhook and credits test injects a `RecordingLedger` through the emitter's seam, so the class that
// actually carries a credit money event to the api sequencer — over the API service binding, behind the
// operator-injected secret — was never exercised. The seam that makes those tests clean is exactly what hid
// this: a well-placed injection point moves the untested surface, it does not remove it.
//
// Each behaviour below is load-bearing on the money path, and its failure mode is named where it is asserted.
// The class needs only a Fetcher and a string, so this is a plain unit test — no worker, no D1.

interface Call {
  readonly url: string;
  readonly method: string;
  readonly secret: string | null;
  readonly body: string;
}

/** A Fetcher stand-in that records the request and returns a scripted response. */
function fakeApi(res: () => Response): { fetcher: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = {
    async fetch(req: Request): Promise<Response> {
      calls.push({ url: req.url, method: req.method, secret: req.headers.get("X-Platform-Internal"), body: await req.text() });
      return res();
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

const INPUT = { id: "evt-1", kind: "invoice.issued" } as unknown as EventInput;
const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("§1291 SequencerPlatformLedger — DARK is a LOUD refusal, never a silent no-op", () => {
  it("an UNBOUND secret rejects and makes NO call (nothing is silently 'recorded')", async () => {
    const { fetcher, calls } = fakeApi(ok({ id: "x" }));
    const led = new SequencerPlatformLedger(fetcher, undefined);
    await expect(led.append({ streamId: "s:credit-1", input: INPUT })).rejects.toBeInstanceOf(PlatformLedgerNotConfiguredError);
    expect(calls, "a DARK ledger must not reach the api at all").toHaveLength(0);
  });

  it("an EMPTY-STRING secret is DARK too — an unset secret often arrives as \"\", not undefined", async () => {
    const { fetcher, calls } = fakeApi(ok({ id: "x" }));
    const led = new SequencerPlatformLedger(fetcher, "");
    await expect(led.append({ streamId: "s:credit-1", input: INPUT })).rejects.toBeInstanceOf(PlatformLedgerNotConfiguredError);
    expect(calls).toHaveLength(0);
  });

  it("the refusal NAMES the missing secret, so an operator can act on it", async () => {
    const led = new SequencerPlatformLedger(fakeApi(ok({ id: "x" })).fetcher, undefined);
    await expect(led.append({ streamId: "s", input: INPUT })).rejects.toThrow(/PLATFORM_INTERNAL_SECRET/);
  });
});

describe("§1291 SequencerPlatformLedger — the live transport", () => {
  it("append POSTs the internal credit-append path, carries the secret header, and returns the sequencer's id", async () => {
    const { fetcher, calls } = fakeApi(ok({ id: "evt-from-sequencer" }));
    const led = new SequencerPlatformLedger(fetcher, "s3cret");
    const out = await led.append({ streamId: "s:credit-9", input: INPUT });
    expect(out.id, "the caller must get the SEQUENCER's id, never a locally-minted one").toBe("evt-from-sequencer");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/internal/platform/credit-append");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.secret, "the operator secret is what gates the internal route").toBe("s3cret");
    expect(JSON.parse(calls[0]!.body)).toEqual({ streamId: "s:credit-9", input: INPUT });
  });

  it("a NON-2xx from the api THROWS — the webhook must 500 so Stripe redelivers (§1290)", async () => {
    const { fetcher } = fakeApi(() => new Response("nope", { status: 503 }));
    const led = new SequencerPlatformLedger(fetcher, "s3cret");
    // Swallowing this would ACK a delivery whose credit event never landed — §1290's loss, one layer down.
    await expect(led.append({ streamId: "s", input: INPUT })).rejects.toThrow(/503/);
  });

  it("a 2xx with NO event id THROWS — an append that recorded nothing is not a success", async () => {
    const { fetcher } = fakeApi(ok({ ok: true }));
    const led = new SequencerPlatformLedger(fetcher, "s3cret");
    await expect(led.append({ streamId: "s", input: INPUT })).rejects.toThrow(/no event id/);
  });

  it("a 2xx with a NON-STRING id THROWS too (present is not the same as valid)", async () => {
    const { fetcher } = fakeApi(ok({ id: 42 }));
    const led = new SequencerPlatformLedger(fetcher, "s3cret");
    await expect(led.append({ streamId: "s", input: INPUT })).rejects.toThrow(/no event id/);
  });

  it("settleCreditInvoice POSTs the settle path with its own body", async () => {
    const { fetcher, calls } = fakeApi(ok({}));
    const led = new SequencerPlatformLedger(fetcher, "s3cret");
    await led.settleCreditInvoice({ invoiceId: "inv-1", paymentEventId: "pay-1", amountCents: 500 });
    expect(calls[0]!.url).toContain("/internal/platform/credit-settle");
    expect(JSON.parse(calls[0]!.body)).toEqual({ invoiceId: "inv-1", paymentEventId: "pay-1", amountCents: 500 });
  });

  it("a NON-2xx on settle THROWS as well (the catch-up must not fail silently)", async () => {
    const { fetcher } = fakeApi(() => new Response("bad", { status: 500 }));
    const led = new SequencerPlatformLedger(fetcher, "s3cret");
    await expect(led.settleCreditInvoice({ invoiceId: "i", paymentEventId: "p", amountCents: 1 })).rejects.toThrow(/500/);
  });
});

describe("§1291 platformLedgerFor — the composition root reads the secret from env (REQ-154)", () => {
  it("wires the API binding and the operator secret", async () => {
    const { fetcher, calls } = fakeApi(ok({ id: "evt-wired" }));
    const led = platformLedgerFor({ API: fetcher, PLATFORM_INTERNAL_SECRET: "from-env" });
    await led.append({ streamId: "s", input: INPUT });
    expect(calls[0]!.secret, "the secret must come from env, never a literal in the class").toBe("from-env");
  });

  it("an env with NO secret yields a ledger that is DARK, not one that silently succeeds", async () => {
    const { fetcher, calls } = fakeApi(ok({ id: "x" }));
    const led = platformLedgerFor({ API: fetcher });
    await expect(led.append({ streamId: "s", input: INPUT })).rejects.toBeInstanceOf(PlatformLedgerNotConfiguredError);
    expect(calls).toHaveLength(0);
  });
});
