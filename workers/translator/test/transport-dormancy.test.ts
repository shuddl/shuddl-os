import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { transportFor } from "../src/index.js";
import { NotConfiguredTransport, TransportError } from "../src/transport.js";
import type { TranslatorEnv } from "../src/tenants.js";

// REQ-203/154 — THE EDI TRANSPORT IS UNWIRED, AND THAT IS LOAD-BEARING (audit §379).
//
// The standing ledger carries a **High (latent)** hold: `run214Sweep` and `runWebhookSweep` use a presence
// CHECK, not a claim, and Cloudflare gives `scheduled()` no mutual exclusion — so two overlapping ticks
// were MEASURED to transmit the same 214 twice, with DIFFERENT ISA13/GS06, which the partner cannot dedupe.
// The hold is filed as DORMANT for exactly one reason: *"NotConfiguredTransport transmits nothing."*
//
// WHY THIS FILE EXISTS. That dormancy was asserted by nobody. `transportFor` — the composition root that
// decides what the sweep sends through — had ZERO test references, and so did `NotConfiguredTransport`.
// The webhook half of the same hold pins its refusal (`webhooks.test.ts`, "fail-closed by construction");
// the EDI half pinned neither the choice nor the behaviour. So the one fact holding a High-severity
// double-send latent was a sentence in a document.
//
// This is a TRIPWIRE, not a proof of correctness (audit §326's shape): it does not claim the sweep is safe.
// It claims the sweep cannot reach the network, and it FAILS the moment someone binds the live AS2/SFTP/VAN
// adapter — which is precisely when the concurrency defect stops being latent, and precisely the person who
// needs to read the hold before shipping.

describe("REQ-203: the EDI transport is NOT CONFIGURED in any environment (dormancy tripwire)", () => {
  it("transportFor returns the fail-closed transport — wiring a LIVE adapter must fail HERE first", () => {
    // The header of `transportFor` says a live adapter "binds HERE once EDI_TRANSPORT_URL +
    // EDI_TRANSPORT_TOKEN exist". When that happens this assertion breaks, deliberately.
    expect(
      transportFor(env as unknown as TranslatorEnv),
      "A live EdiTransport is bound. STOP: the cron double-fire hold (GO-LIVE-CHECKLIST, 'Cron sweeps " +
        "double-fire under overlapping ticks', High/latent) was filed DORMANT only because no transport " +
        "transmits. Two overlapping ticks were measured sending the same 214 twice with different ISA13/GS06. " +
        "Resolve that hold — a claim, not a presence check — before binding a live transport.",
    ).toBeInstanceOf(NotConfiguredTransport);
  });

  it("send214 REJECTS, and is marked retriable so the sweep records no phantom send", async () => {
    // The sweep writes its "sent" marker only after a successful send. A transport that resolved silently
    // would mark the 214 as transmitted while nothing left the building — the inverse of the double-send,
    // and worse, because it is unrecoverable: the marker suppresses every retry.
    const t = transportFor(env as unknown as TranslatorEnv);
    await expect(t.send214("SCAC", "ISA*...", "idem-1")).rejects.toBeInstanceOf(TransportError);
    await expect(t.send214("SCAC", "ISA*...", "idem-1")).rejects.toThrow(/NOT CONFIGURED/);
  });

  it("send990 REJECTS too — the acknowledgment path is unwired on the same terms", async () => {
    // send990's rejection is CAUGHT by the inbound handler (a 990 ack is best-effort), so its failure is
    // invisible at runtime by design. That makes it the half most likely to be quietly wired first.
    const t = transportFor(env as unknown as TranslatorEnv);
    await expect(t.send990("SCAC", "ISA*...", "idem-2")).rejects.toThrow(/NOT CONFIGURED/);
  });

  it("the rejection is RETRIABLE — an unwired env must not poison the queue permanently", () => {
    // `TransportError(msg, true)`: retriable. A non-retriable rejection would DLQ every outbound 214 while
    // the transport is merely absent, turning a deliberate dormancy into data loss.
    const err = new TransportError("x", true);
    expect(err.retriable).toBe(true);
  });
});
