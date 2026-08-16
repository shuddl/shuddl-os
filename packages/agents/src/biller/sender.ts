import { z } from "@shuddl/contracts";

// THE EVIDENCE SENDER PORT (REQ-092/097/157) — the Biller's downstream, best-effort delivery seam.
//
// 1. Senders REJECT to signal failure; callers treat a rejection as retriable-or-hold and NEVER
//    roll back the invoice. The invoice is the ledger's (money is a projection of physics); the
//    email/sms is a projection of the invoice — it can lag, retry, or hold, but it can never
//    reach back and unmake the record.
// 2. Three adapters, one Zod boundary: RecordingSender for tests/dev; NotConfiguredSender when
//    no provider is bound (it validates, then rejects LOUDLY — a silent no-op is forbidden);
//    ResendSender is the live adapter, written now so going live is a config flip, awaiting the
//    CONFIRM-gated API key + verified tenant sending domain + DKIM + warmup (REQ-092/157).
// 3. Inbound email (REQ-091 per-shipment addresses) is webhook-based `email.received` with svix
//    verification — that is WP-07 Concierge territory, NOT this port. This port only sends.
//
// Retriable-vs-not is signaled via SendError.retriable: true means the queue consumer's
// redelivery IS the retry (429/5xx/unbound provider); false means redelivery cannot succeed
// (validation-adjacent 4xx, idempotency conflicts, sms-not-wired) and the message must hold
// for a human. No suppression-list logic lives here: Resend maintains bounce/complaint
// suppression server-side, and Watchtower watches the webhooks (REQ-157).

const CRLF = /[\r\n]/;
const NO_CRLF_MSG = "carries CR/LF — refusing to interpolate into a mail header";

// Shared fields of both channels. idempotency_key ≤256 chars is Resend's documented maximum.
const BASE_FIELDS = {
  to: z
    .string()
    .min(1, "to must be non-empty — a send with no recipient is a Biller bug")
    .refine((v) => !CRLF.test(v), `to ${NO_CRLF_MSG}`),
  // OPTIONAL (REQ-032): the Biller's evidence send ALWAYS names its shipment, but a Collector dunning send
  // (Task 7) is PARTY/INVOICE-scoped — there is no shipment. Optional (not just widened): an EMPTY string is
  // still a bug and rejected by min(1); only outright ABSENCE (a party-scoped send) is allowed.
  shipment_id: z.string().min(1, "shipment_id, when present, must be non-empty — an empty shipment_id is a bug").optional(),
  idempotency_key: z
    .string()
    .min(1, "idempotency_key must be non-empty — dedupe is load-bearing under queue redelivery")
    .max(256, "idempotency_key exceeds 256 chars — Resend's documented maximum")
    .refine((v) => !CRLF.test(v), "idempotency_key carries CR/LF — it rides verbatim in the Idempotency-Key HTTP header"),
};

/**
 * The port boundary (`.strict()` per variant): channel coherence is structural —
 * `email` REQUIRES subject+html (text is the optional plain alternative); `sms` REQUIRES text
 * and FORBIDS subject/html (strict rejects them as unrecognized keys).
 */
export const EvidenceMessageSchema = z.discriminatedUnion("channel", [
  z
    .object({
      channel: z.literal("email"),
      subject: z
        .string()
        .min(1, "email requires a subject")
        .refine((v) => !CRLF.test(v), `subject ${NO_CRLF_MSG}`),
      html: z
        .string()
        .min(1, "email requires html — the renderEvidenceEmail fragment")
        .refine(
          (v) => !/^\s*(<!doctype|<html)/i.test(v),
          "html is already a full document (doctype/<html>) — the port carries the FRAGMENT; the sender owes the wrap (double-wrap guard)",
        ),
      text: z.string().optional(),
      ...BASE_FIELDS,
    })
    .strict(),
  z
    .object({
      channel: z.literal("sms"),
      text: z.string().min(1, "sms requires text — there is nothing else to send"),
      ...BASE_FIELDS,
    })
    .strict(),
]);
type ParsedEvidenceMessage = z.infer<typeof EvidenceMessageSchema>;

/**
 * NOTE — the TS surface is LOOSER than the runtime boundary: Zod v4 `.strict()` rejects a stray
 * key by PRESENCE, not value, so `{channel:"sms", subject: undefined}` type-checks against this
 * interface but FAILS parse. Build messages without the other channel's keys; never spread-and-
 * undefined them.
 */
export interface EvidenceMessage {
  /** Recipient email address, or E.164 for sms (format not validated here; the provider rejects malformed recipients non-retriably). */
  to: string;
  channel: "email" | "sms";
  /** Email only. (`| undefined` = exactOptionalPropertyTypes' spelling of an optional string.) */
  subject?: string | undefined;
  /** Email only — the renderEvidenceEmail FRAGMENT (the sender owes the doctype+charset wrap). */
  html?: string | undefined;
  /** Sms body, or the email's plain-text alternative. */
  text?: string | undefined;
  /** The Biller's evidence send names its shipment; a Collector dunning send (Task 7) is party/invoice-scoped
   *  and omits it (`| undefined` = exactOptionalPropertyTypes' spelling of an optional string). */
  shipment_id?: string | undefined;
  /** The Biller derives it as `evidence-email/<invoice-event-id>` — one invoice, one message. */
  idempotency_key: string;
}

export interface SendReceipt {
  accepted: true;
  provider: string;
  provider_id: string;
}

export interface EvidenceSender {
  send(m: EvidenceMessage): Promise<SendReceipt>;
}

/**
 * Send failure. `retriable: true` ⇒ queue redelivery may succeed; `false` ⇒ hold for a human.
 * `status` carries the provider's HTTP status when a response existed (so the consumer can route
 * without regexing messages); undefined for network-level and local (config/validation) failures.
 */
export class SendError extends Error {
  readonly retriable: boolean;
  readonly status: number | undefined;
  constructor(message: string, retriable: boolean, status?: number) {
    super(message);
    this.name = "SendError";
    this.retriable = retriable;
    this.status = status;
  }
}

// Canonical payload string for idempotency comparison — explicit field order, so the comparison
// never depends on object-key enumeration. The idempotency_key itself is the map key.
function canonicalPayload(m: ParsedEvidenceMessage): string {
  return JSON.stringify([
    m.to,
    m.channel,
    m.channel === "email" ? m.subject : null,
    m.channel === "email" ? m.html : null,
    m.text ?? null,
    m.shipment_id ?? null,
  ]);
}

/**
 * RecordingSender — the tests/dev adapter. Mirrors Resend's documented idempotency semantics:
 * same key + same payload → the ORIGINAL receipt, no second recording; same key + DIFFERENT
 * payload → a conflict (catches Biller bugs where one invoice event id composes two different
 * emails). Deterministic: no Date, no random — the receipt is a pure function of the key.
 */
export class RecordingSender implements EvidenceSender {
  /** Every accepted message, in send order. Readable by tests and dev tooling. */
  readonly messages: EvidenceMessage[] = [];
  private readonly byKey = new Map<string, { payload: string; receipt: SendReceipt }>();

  // async so EVERY failure — validation included — surfaces as a rejection, never a sync throw
  // (a sync throw from a Promise-returning port would slip past a caller's .catch()).
  async send(m: EvidenceMessage): Promise<SendReceipt> {
    const parsed = EvidenceMessageSchema.parse(m);
    const payload = canonicalPayload(parsed);
    const prior = this.byKey.get(parsed.idempotency_key);
    if (prior !== undefined) {
      if (prior.payload !== payload) {
        throw new SendError(
          `RecordingSender: idempotency CONFLICT — key "${parsed.idempotency_key}" was already used with a ` +
            `different payload. One invoice event id must compose exactly one message; this is a Biller bug, ` +
            `not a retry.`,
          false,
        );
      }
      return prior.receipt; // same key + same payload → the original receipt
    }
    const receipt: SendReceipt = {
      accepted: true,
      provider: "recording",
      provider_id: `rec_${parsed.idempotency_key}`,
    };
    this.messages.push(parsed);
    this.byKey.set(parsed.idempotency_key, { payload, receipt });
    return receipt;
  }
}

/**
 * NotConfiguredSender — the default when no provider is bound. A silent no-op is forbidden
 * (an operator must never believe evidence went out when nothing is wired), so a VALID message
 * rejects loudly and actionably. A MALFORMED message rejects with the validation error instead —
 * the two failures must never be confused: one needs configuration, the other needs a code fix.
 */
export class NotConfiguredSender implements EvidenceSender {
  // async for the same reason as RecordingSender: the validation error must REJECT, not sync-throw.
  async send(m: EvidenceMessage): Promise<SendReceipt> {
    const parsed = EvidenceMessageSchema.parse(m); // a malformed message rejects HERE with the VALIDATION error
    throw new SendError(
      `EvidenceSender is NOT CONFIGURED: no provider is bound in this environment, so the ${parsed.channel} ` +
        `for ${parsed.shipment_id !== undefined ? `shipment ${parsed.shipment_id}` : "a party-scoped send"} was NOT sent. The invoice is unaffected — the ledger already holds ` +
        `it, and this send is retriable once a provider is bound. Live email requires the CONFIRM-gated Resend ` +
        `API key + verified tenant sending domain + DKIM (REQ-092) with warmup (REQ-157); sms requires REQ-097. ` +
        `See docs/wp/WP-06.md.`,
      true, // retriable: binding a provider and redelivering succeeds
    );
  }
}

export interface ResendConfig {
  /** Injected by the composition root; NEVER read from process.env here. */
  apiKey: string;
  /** e.g. `SHUDDL <pod@tenant-domain>` — must be a VERIFIED domain (Resend 403s on mismatch). */
  from: string;
  /** Injected for tests; defaults to globalThis.fetch (a Workers platform global). */
  fetchImpl?: typeof fetch;
}

/**
 * The sender's half of the renderEvidenceEmail contract: the render emits an email-safe
 * FRAGMENT and documents that the sender owes the doctype + `<meta charset="utf-8">` wrap
 * (the copy uses `·` U+00B7 — the charset declaration is load-bearing).
 */
export function wrapFragment(fragment: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${fragment}</body></html>`;
}

const RESEND_EMAILS_URL = "https://api.resend.com/emails";

// Resend's 2xx response — only the id matters here; unknown keys are stripped, not rejected.
const ResendCreated = z.object({ id: z.string().min(1) });

// A proxy's full HTML 502 page must never land in queue logs verbatim — cap the raw fallback.
const MAX_ERROR_DETAIL_CHARS = 500;

// Pull Resend's error out of a non-2xx body ({statusCode, name, message}): `name` is the MACHINE
// code the 409 routing pivots on; `detail` is the human message, falling back to the raw text —
// TRUNCATED — so a non-JSON error page still surfaces without flooding logs.
/**
 * Scrub address-shaped substrings out of THIRD-PARTY error text (§575).
 *
 * `resendError` returns the provider's own `message` verbatim, and that string reaches two log sinks: the
 * biller's `console.error` and the `JSON.stringify(outcome)` line the queue consumer writes. A provider's
 * validation error commonly echoes the offending value — so an invalid recipient puts a customer's address
 * into operational logs, permanently, with no way to unsay it.
 *
 * This is not provider-specific and must not be reasoned about per-provider: the defect is that UNFILTERED
 * third-party text reaches a log sink. Scrubbing at the boundary where it enters is the only place that
 * covers every consumer downstream — including ones added later that nobody re-audits.
 *
 * The operator keeps everything diagnostic (status, provider error name, the rest of the message); only the
 * address itself is replaced.
 */
export function scrubAddresses(text: string): string {
  return text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "[address redacted]");
}

/**
 * TRUNCATE **then** scrub — §1657, and the order is the point.
 *
 * `scrubAddresses`'s pattern opens with `[A-Za-z0-9._%+-]+`, whose class contains `.` — so on text with NO
 * `@` the engine consumes a long run from every start position and backtracks out of each: quadratic.
 * MEASURED at §1657 on `"a.".repeat(50000)` (100 KB, no `@`): **15,947 ms**, and 639 ms at 20 KB. This runs on
 * the mail provider's error body, so one oversized response burned the Worker's entire CPU budget — on the
 * error path, where the send has already failed and the only job left is to say why.
 *
 * Three of the four detail paths already sliced to `MAX_ERROR_DETAIL_CHARS` first; the JSON `message` branch
 * did not. The single helper is what stops a fifth site diverging again.
 */
function boundedDetail(text: string): string {
  return text.length > MAX_ERROR_DETAIL_CHARS
    ? `${scrubAddresses(text.slice(0, MAX_ERROR_DETAIL_CHARS))} … [truncated]`
    : scrubAddresses(text);
}

async function resendError(res: Response): Promise<{ name: string | undefined; detail: string }> {
  const raw = await res.text();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const body = parsed as Record<string, unknown>;
      const name = typeof body["name"] === "string" && body["name"].length > 0 ? body["name"] : undefined;
      const message = body["message"];
      if (typeof message === "string" && message.length > 0) return { name, detail: boundedDetail(message) };
      return { name, detail: boundedDetail(raw) };
    }
  } catch {
    // not JSON — the truncated raw text below is the best detail available
  }
  return { name: undefined, detail: boundedDetail(raw) };
}

/**
 * ResendSender — the live adapter (email only; sms is REQ-097, deferred). Written now, exercised
 * against the network never-in-tests: `fetchImpl` is injected. Going live is a CONFIRM-gated
 * config flip (key + verified domain + DKIM + warmup, REQ-092/157), not a code task.
 *
 * The `Idempotency-Key` header is Resend's native retry-dedupe: same key + same payload returns
 * the original response, so Queue redelivery can never double-send. The CONCURRENT case matters
 * too: at-least-once delivery can race two consumers on one message (both appends dedupe cleanly
 * in the DO, then both send the same key at once) — Resend answers the loser 409
 * `concurrent_idempotent_requests`, documented safe-to-retry, so that name maps to
 * retriable:true; only `invalid_idempotent_request` (same key, different payload — a Biller bug)
 * holds. Suppression (bounces, complaints) is handled by Resend server-side — no local
 * suppression list (REQ-157 monitoring rides the webhooks into Watchtower, not this port).
 */
export class ResendSender implements EvidenceSender {
  private readonly config: ResendConfig;

  constructor(config: ResendConfig) {
    this.config = config;
  }

  async send(m: EvidenceMessage): Promise<SendReceipt> {
    const parsed = EvidenceMessageSchema.parse(m); // validation first — a malformed message never hits the wire
    if (parsed.channel === "sms") {
      throw new SendError(
        `ResendSender: sms is not wired (REQ-097 deferred) — the sms for ${parsed.shipment_id !== undefined ? `shipment ${parsed.shipment_id}` : "a party-scoped send"} was NOT ` +
          `sent and redelivery to this adapter cannot succeed; hold until an sms provider is bound.`,
        false,
      );
    }

    const fetchImpl = this.config.fetchImpl ?? globalThis.fetch;
    let res: Response;
    try {
      res = await fetchImpl(RESEND_EMAILS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": parsed.idempotency_key,
        },
        body: JSON.stringify({
          from: this.config.from,
          to: [parsed.to],
          subject: parsed.subject,
          html: wrapFragment(parsed.html),
          text: parsed.text,
        }),
      });
    } catch (err) {
      // NETWORK-level failure (DNS/timeout/reset) — no Response ever existed. This is the single
      // most common real failure and it MUST carry the retriability verdict: retriable, because
      // the Idempotency-Key makes redelivery safe even if the request actually landed. A network
      // error message carries no config (no key, no domain), so it is safe to carry verbatim.
      const cause = err instanceof Error ? err.message : String(err);
      throw new SendError(
        `ResendSender: network failure before any Resend response (${cause}) — retriable; the Idempotency-Key ` +
          `("${parsed.idempotency_key}") makes redelivery safe.`,
        true,
      );
    }

    if (res.ok) {
      // Guarded parse: a 2xx with a NON-JSON body (a proxy answering for a dead upstream) must
      // fall into the same retriable no-id branch, never escape as a raw SyntaxError.
      const raw = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        body = undefined;
      }
      const created = ResendCreated.safeParse(body);
      if (!created.success) {
        // A 2xx without a parseable id is malformed, but the Idempotency-Key makes redelivery SAFE.
        throw new SendError(
          `ResendSender: Resend answered ${res.status} without a parseable id — retriable; the Idempotency-Key ` +
            `("${parsed.idempotency_key}") makes redelivery safe.`,
          true,
          res.status,
        );
      }
      return { accepted: true, provider: "resend", provider_id: created.data.id };
    }

    if (res.status === 409) {
      // TWO distinct 409s ride the body's `name` (Resend's machine code — never regex the message):
      //   · concurrent_idempotent_requests — the SAME key is still IN FLIGHT. Resend documents this
      //     as safe to retry, and it is exactly what at-least-once delivery produces when two
      //     consumers race one message after the DO cleanly deduped both appends: the loser lands
      //     here while the winner's send completes. RETRIABLE — redelivery re-reads the ORIGINAL
      //     response via the same key; no double-send is possible.
      //   · invalid_idempotent_request (and any unrecognized 409) — same key, DIFFERENT payload.
      //     Redelivery replays the same mismatch — a Biller bug (one invoice event id composed two
      //     different emails), never a retry. Fail-closed: only the documented concurrent code retries.
      const conflict = await resendError(res);
      if (conflict.name === "concurrent_idempotent_requests") {
        throw new SendError(
          `ResendSender: concurrent idempotent requests (409) — key "${parsed.idempotency_key}" is still being ` +
            `processed by an earlier send; retriable — redelivery returns the original response: ${conflict.detail}`,
          true,
          res.status,
        );
      }
      throw new SendError(
        `ResendSender: idempotency CONFLICT (409${conflict.name !== undefined ? `, ${conflict.name}` : ""}) — key ` +
          `"${parsed.idempotency_key}" was already used with a different payload: ${conflict.detail}. ` +
          `Not retriable; hold for a human.`,
        false,
        res.status,
      );
    }

    if (res.status === 429 || res.status >= 500) {
      throw new SendError(
        `ResendSender: Resend answered ${res.status} — retriable; the queue consumer's redelivery is the retry ` +
          `(Idempotency-Key "${parsed.idempotency_key}" prevents a double-send): ${(await resendError(res)).detail}`,
        true,
        res.status,
      );
    }

    // Remaining 4xx (400/401/403/422): the request itself is wrong — redelivery cannot succeed.
    const hint =
      res.status === 403
        ? " (hint: the `from` address must belong to a VERIFIED sending domain — Resend 403s on mismatch, REQ-092)"
        : "";
    throw new SendError(
      `ResendSender: Resend rejected the send (${res.status}): ${(await resendError(res)).detail}${hint}. ` +
        `Not retriable; the invoice is unaffected.`,
      false,
      res.status,
    );
  }
}
