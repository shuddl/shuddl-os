// WP-14 Task 10 · REQ-123/025/003 — THE PLATFORM-TENANT APPEND PORT, now ROUTED THROUGH THE REAL API SEQUENCER.
//
// Credits are MONEY EVENTS on the reserved `_platform` revenue tenant, PROJECTED — never a direct money_lines
// write (REQ-003). Task 7 shipped an interim `D1PlatformLedger` that MIRRORED the sequencer's append loop against
// the platform D1 (a documented stopgap, because the sequencer refused `_platform`). Task 10 RETIRES that mirror:
// the sequencer now resolves `_platform` (with the finding-C POD-gate exemption + the finding-D visibility clamp),
// so the credit emitter appends through the ONE canonical ledger core — the api worker's ShipmentSequencer DO —
// exactly like every other event in the system. There is no second append loop, no second hash chain, no drift.
//
// THE SEAM: `SequencerPlatformLedger` reaches the sequencer over the `API` SERVICE BINDING (mirrors mcp/translator's
// env.API.fetch), calling the INTERNAL, secret-gated platform-credit route (workers/api/src/routes/internal-platform.ts).
// That route is the ONLY caller that sets the sequencer's `platform: true` door, and it is NOT a customer /v1 route,
// so the ISOLATION INVARIANT (REQ-025) holds: a customer JWT can never drive a `_platform` append.
//
// FAIL-CLOSED (mirrors billing.ts NotConfiguredBilling): with no PLATFORM_INTERNAL_SECRET bound, the ledger REJECTS
// loudly (never a silent no-op) — the webhook returns 500 and Stripe redelivers; the emitter is idempotent, so a
// redrive is safe end to end. DARK until R4, alongside the Stripe webhook secret.
import type { EventInput } from "@shuddl/contracts";

/** The append seam the credit emitter (credits.ts) drives. `streamId` is the per-purchase credit stream; the DO is
 *  authoritative on seq/prev_hash/hash — this port only carries the client-suppliable EventInput to it. */
export interface PlatformLedger {
  append(req: { streamId: string; input: EventInput }): Promise<{ id: string }>;
  /** REQ-083 (finding A) — the RE-RUNNABLE AR settle catch-up: flip the credit invoice to 'paid' iff a covering
   *  payment.received event is already committed on the ledger AND the invoice is still 'issued'. It closes the
   *  out-of-order-webhook gap the append's own in-batch settle cannot (a settlement that landed BEFORE its invoice
   *  never flipped). Idempotent + money-as-events-safe: the api route verifies the payment.received exists first. */
  settleCreditInvoice(req: { invoiceId: string; paymentEventId: string; amountCents: number }): Promise<void>;
}

// The synthetic origin the service-binding Request carries — never resolved over the network (the binding
// dispatches in-process to the api worker). Mirrors workers/mcp/src/index.ts API_ORIGIN.
const API_ORIGIN = "https://shuddl-api.internal";
const CREDIT_APPEND_PATH = "/internal/platform/credit-append";
const CREDIT_SETTLE_PATH = "/internal/platform/credit-settle";

/** No platform-append secret bound (DARK). Thrown by SequencerPlatformLedger — the webhook maps a processing fault
 *  to a loud 500 so Stripe redelivers; the emitter is idempotent, so the redrive is safe once the secret is bound.
 *  A silent no-op is forbidden (an operator must never believe a credit was recorded when nothing was wired). */
export class PlatformLedgerNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformLedgerNotConfiguredError";
  }
}

/**
 * The live platform ledger: appends credit money events onto `_platform` through the REAL api sequencer over the
 * `API` service binding + the internal, secret-gated route. It enforces NOTHING itself — the api worker owns every
 * gate (the POD-gate exemption, the visibility clamp, the hash chain, tenant isolation). This is a thin transport.
 */
export class SequencerPlatformLedger implements PlatformLedger {
  private readonly api: Fetcher;
  private readonly secret: string | undefined;
  constructor(api: Fetcher, secret: string | undefined) {
    this.api = api;
    this.secret = secret;
  }

  async append({ streamId, input }: { streamId: string; input: EventInput }): Promise<{ id: string }> {
    const res = await this.#post(CREDIT_APPEND_PATH, { streamId, input });
    const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
    if (body === null || typeof body.id !== "string") {
      throw new Error(`platform credit append: the sequencer returned no event id (streamId=${streamId})`);
    }
    return { id: body.id };
  }

  async settleCreditInvoice(req: { invoiceId: string; paymentEventId: string; amountCents: number }): Promise<void> {
    await this.#post(CREDIT_SETTLE_PATH, req);
  }

  // The one transport method: fail-closed if DARK, then POST through the service binding with the shared secret. A
  // non-2xx is a PROCESSING fault (surfaced loud so the webhook 500s → Stripe redelivers → idempotent redrive).
  async #post(path: string, body: unknown): Promise<Response> {
    if (this.secret === undefined || this.secret === "") {
      throw new PlatformLedgerNotConfiguredError(
        "Platform credit ledger is NOT CONFIGURED: no PLATFORM_INTERNAL_SECRET is bound, so the credit money event " +
          "was NOT appended through the api sequencer and NOTHING was recorded. Bind the operator-injected secret " +
          "(`wrangler secret`, NEVER wrangler.toml — REQ-154) to select the live path. DARK until R4.",
      );
    }
    const res = await this.api.fetch(
      new Request(new URL(path, API_ORIGIN), {
        method: "POST",
        headers: { "content-type": "application/json", "X-Platform-Internal": this.secret },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`platform credit call ${path} failed: ${res.status} ${text.slice(0, 200)}`);
    }
    return res;
  }
}

/**
 * The composition root (REQ-154) — selects the live SequencerPlatformLedger with the `API` service binding + the
 * operator-injected secret. The secret is read HERE, never inside the class, and NEVER from wrangler.toml. When the
 * secret is unbound the ledger's own methods reject loudly (DARK), so this never returns a silently-broken ledger.
 */
export function platformLedgerFor(env: { API: Fetcher; PLATFORM_INTERNAL_SECRET?: string }): PlatformLedger {
  return new SequencerPlatformLedger(env.API, env.PLATFORM_INTERNAL_SECRET);
}
