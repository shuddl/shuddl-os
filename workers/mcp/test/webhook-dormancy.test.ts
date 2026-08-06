import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { NotConfiguredSecretResolver } from "../src/principal.js";
import { NotConfiguredEventSource, NotConfiguredWebhookTransport, webhookDepsFor } from "../src/webhooks.js";

// REQ-154 — THE WEBHOOK SWEEP CANNOT REACH THE NETWORK, AND THAT IS LOAD-BEARING (audit §380).
//
// The mirror of `workers/translator/test/transport-dormancy.test.ts`. Same standing hold — *"Cron sweeps
// double-fire under overlapping ticks"*, **High (latent)**, measured at 2 deliveries of one event — and the
// same reason it is filed dormant: nothing in this worker delivers.
//
// WHY THIS FILE EXISTS. §379 closed the EDI half and recorded the webhook half as a stated bound. The three
// fail-closed classes each had tests (7 / 3 / 3 references); `webhookDepsFor` — the composition root that
// decides whether the production sweep uses them — had **zero**. That is the same shape §379 found: the
// BEHAVIOUR of each default was pinned, the CHOICE of them was not, so swapping in a live implementation
// broke nothing.
//
// A TRIPWIRE, not a correctness proof. It asserts the sweep cannot deliver, and fails at the go-live config
// flip — which is exactly when the concurrency defect stops being latent.

const HOLD =
  "STOP: the cron double-fire hold (GO-LIVE-CHECKLIST, 'Cron sweeps double-fire under overlapping ticks', " +
  "High/latent) was filed DORMANT only because nothing here delivers. Two concurrent runWebhookSweep calls " +
  "were measured delivering ONE event TWICE. Resolve that hold — a claim, not a presence check — first.";

describe("REQ-154: the production webhook deps are fail-closed (dormancy tripwire)", () => {
  const deps = (): ReturnType<typeof webhookDepsFor> => webhookDepsFor(env as unknown as Parameters<typeof webhookDepsFor>[0]);

  it("the transport is the NotConfigured one — wiring a live deliverer must fail HERE first", () => {
    expect(deps().transport, HOLD).toBeInstanceOf(NotConfiguredWebhookTransport);
  });

  it("the event source is the NotConfigured one — the sweep scans NOTHING", () => {
    // The strongest of the three anchors and the quietest: `recentTerminalEvents()` returns `[]`, so a live
    // source is the single change that turns a sweep which visits zero events into one that visits all of
    // them. It fails no assertion anywhere on being swapped, and it emits nothing when it does.
    expect(deps().eventSource, HOLD).toBeInstanceOf(NotConfiguredEventSource);
  });

  it("the secret resolver is the NotConfigured one — no signature can be produced", () => {
    // Independent of the other two: even a live transport plus a live source cannot deliver a SIGNED hook
    // without a secret. Asserted separately so a partial wiring cannot pass by leaning on its neighbours.
    expect(deps().secrets, HOLD).toBeInstanceOf(NotConfiguredSecretResolver);
  });

  it("is non-vacuous: the deps that ARE wired today are present and real", () => {
    // Without this, a `webhookDepsFor` that returned an empty object would satisfy nothing above and still
    // pass — the shape this audit rejects repeatedly. The marker store and clock are genuinely wired.
    const d = deps();
    expect(d.markers).toBeDefined();
    expect(typeof d.now()).toBe("number");
    expect(typeof d.resolveSubscription).toBe("function");
  });
});
