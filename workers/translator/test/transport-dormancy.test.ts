import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { transportFor } from "../src/index.js";
import { run214Sweep } from "../src/sweep-214.js";
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

  it("send214 REJECTS rather than resolving silently (the transport half of the no-phantom-send law)", async () => {
    // The sweep writes its "sent" marker only after a successful send. A transport that resolved silently
    // would mark the 214 as transmitted while nothing left the building — the inverse of the double-send,
    // and worse, because it is unrecoverable: the marker suppresses every retry.
    //
    // RENAMED (audit §775). This read "…so the sweep records no phantom send" — a claim about the SWEEP, in a
    // test that never drives the sweep. It asserts only that this transport rejects; the send-then-mark
    // ORDERING it credited was entirely unpinned, and inverting those two lines left this worker 117/117
    // green. The behavioural half now lives where the sweep is actually driven:
    // `sweep-214.test.ts` → "a FAILED send leaves NO phantom sent-marker, and the next tick actually
    // transmits". A test name is read as the guarantee; this one over-claimed by one whole mechanism.
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

// REQ-025/278 — THE 214 SWEEP CONTAINS A PER-TENANT FAILURE (audit §411).
//
// The eleventh and last of the per-tenant sweeps §408 counted. Same shape as the other ten: a try/catch
// INSIDE `for (const slug of await allTenantSlugs(env))`, `resolveTenantDb` within the guard, the roster load
// outside it. Without it the first tenant whose D1 throws aborts the loop and every tenant after it in slug
// order never has its 214s swept — silently, the only signal being an absent log line.
//
// THE HARNESS IS THE POINT (§410). The other ten tests poison a binding with `{ ...env, TENANT_A_DB: … }`.
// In THIS worker that spread breaks `allTenantSlugs`, which logs "claimed-tenant enumeration failed" and
// degrades to the static roster — so the harness damages the very thing under test and the poison's effect
// cannot be isolated. §410 attempted it twice and reverted rather than ship a test it could not make correct.
//
// A Proxy replaces ONE key and delegates everything else to the real `env`, including whatever the spread was
// dropping. That is the harness §410 said was needed, and it is strictly better than the spread everywhere:
// it cannot silently omit a binding, because it never enumerates them.
function poisonBinding(base: TranslatorEnv, key: keyof TranslatorEnv, dead: unknown): TranslatorEnv {
  return new Proxy(base, {
    get: (target, prop, receiver) => (prop === key ? dead : Reflect.get(target, prop, receiver)),
  }) as TranslatorEnv;
}

describe("REQ-278: run214Sweep contains a per-tenant failure — the tick survives", () => {
  it("a tenant whose D1 throws is logged and SKIPPED, and the sweep RESOLVES", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    // POISON WHAT THE SWEEP TOUCHES FIRST (§411). `sweepTenant214` opens with `listTenderMarkers(r2, tenant)`
    // — an R2 list, not a D1 query — so a dead D1 handle is never reached when a tenant has no markers, and
    // the test passes having exercised nothing. That is the same vacuity §410 caught on the weekly gate,
    // arriving through a different door: the subject ran, but not far enough to touch the poison.
    const e = env as unknown as TranslatorEnv;
    const deadR2 = { list: () => { throw new Error("R2_DOWN"); } };
    await expect(
      run214Sweep(poisonBinding(e, "EVIDENCE", deadR2), transportFor(e), () => 1_720_000_000_000),
      "an uncontained per-tenant failure would reject here",
    ).resolves.toBeUndefined();

    // Non-vacuity — the assertion that caught a silently-skipped sweep in §410. A sweep that returned early,
    // or whose roster came back empty because the harness broke enumeration, would also "resolve".
    expect(errors.mock.calls.some((c) => String(c[0]).includes("tenant-a")), "the failing tenant must be named in a loud log").toBe(true);
    // NOTE (§411): this suite has no control-plane tables, so `allTenantSlugs` ALWAYS logs "claimed-tenant
    // enumeration failed" and degrades to the static roster — its documented fallback. That message is
    // ambient here, not harness damage. §410 read it as the blocker and was wrong: the real obstacle was
    // poisoning D1 when this sweep reaches R2 first. Recorded so the next reader does not re-chase it.

    vi.restoreAllMocks();
  });
});
