import { describe, expect, it } from "vitest";
import { z } from "@shuddl/contracts";
import {
  EvidenceMessageSchema,
  NotConfiguredSender,
  RecordingSender,
  ResendSender,
  SendError,
  wrapFragment,
} from "../src/index.js";
import type { EvidenceMessage, SendReceipt } from "../src/index.js";

// ============================================================================================
// WP-06 — the EvidenceSender PORT (REQ-092/097/157). The invoice is the ledger's; the send is
// DOWNSTREAM BEST-EFFORT: senders reject to signal failure, callers retry-or-hold and NEVER
// roll back the invoice. Three adapters under one Zod boundary:
//   · RecordingSender — tests/dev; dedupes by idempotency_key (Resend semantics: same key +
//     same payload → the ORIGINAL receipt; same key + DIFFERENT payload → conflict).
//   · NotConfiguredSender — the default when nothing is bound; validates first, then rejects
//     LOUDLY with what's missing. Silent no-ops are forbidden.
//   · ResendSender — the live adapter, written now, NEVER exercised against the network here:
//     every fetch below is a local stub. Going live is a CONFIRM-gated config flip.
// Retriable-vs-not rides SendError.retriable — the queue consumer's redelivery IS the retry.
// ============================================================================================

const EMAIL: EvidenceMessage = {
  to: "receiving@consignee.example",
  channel: "email",
  subject: "DELIVERED · SHP-40206 · PROOF + INVOICE",
  html: '<div style="color:#1A1A1A">Delivered · proof + invoice</div>', // ink token — REQ-145: only the five hexes exist
  text: "Delivered. Proof and invoice enclosed.",
  shipment_id: "shp-40206",
  idempotency_key: "evidence-email/evt-invoice-1",
};

const SMS: EvidenceMessage = {
  to: "+13035550142",
  channel: "sms",
  text: "DELIVERED SHP-40206 - proof + invoice sent to your inbox",
  shipment_id: "shp-40206",
  idempotency_key: "evidence-sms/evt-invoice-1",
};

/** Await a rejection and hand back the thrown value — asserting on error FIELDS needs the object. */
async function captureRejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

// ── the port boundary (Zod, .strict()) ─────────────────────────────────────────────────────

describe("EvidenceMessageSchema — the port boundary", () => {
  it("accepts a well-formed email message (text as the optional plain alternative)", () => {
    expect(EvidenceMessageSchema.safeParse(EMAIL).success).toBe(true);
    const { text: _text, ...noText } = EMAIL;
    expect(EvidenceMessageSchema.safeParse(noText).success).toBe(true);
  });

  it("accepts a well-formed sms message", () => {
    expect(EvidenceMessageSchema.safeParse(SMS).success).toBe(true);
  });

  it("rejects an email without subject, and without html — channel coherence", () => {
    const { subject: _s, ...noSubject } = EMAIL;
    const { html: _h, ...noHtml } = EMAIL;
    expect(EvidenceMessageSchema.safeParse(noSubject).success).toBe(false);
    expect(EvidenceMessageSchema.safeParse(noHtml).success).toBe(false);
  });

  it("rejects an sms carrying subject or html — forbidden on the sms channel", () => {
    expect(EvidenceMessageSchema.safeParse({ ...SMS, html: "<p>no</p>" }).success).toBe(false);
    expect(EvidenceMessageSchema.safeParse({ ...SMS, subject: "no" }).success).toBe(false);
  });

  it("rejects an sms without text — there is nothing to send", () => {
    const { text: _t, ...noText } = SMS;
    expect(EvidenceMessageSchema.safeParse(noText).success).toBe(false);
  });

  it("rejects CR/LF in `to` and in `subject` — header-injection hygiene, same posture as the render's shipment_ref guard", () => {
    expect(EvidenceMessageSchema.safeParse({ ...EMAIL, to: "a@b.example\r\nbcc: x@y.example" }).success).toBe(false);
    expect(EvidenceMessageSchema.safeParse({ ...EMAIL, to: "a@b.example\nX" }).success).toBe(false);
    expect(EvidenceMessageSchema.safeParse({ ...EMAIL, subject: "DELIVERED\r\nbcc: x@y.example" }).success).toBe(false);
    expect(EvidenceMessageSchema.safeParse({ ...EMAIL, subject: "DELIVERED\nX" }).success).toBe(false);
  });

  it("rejects empty to / shipment_id / idempotency_key", () => {
    expect(EvidenceMessageSchema.safeParse({ ...EMAIL, to: "" }).success).toBe(false);
    expect(EvidenceMessageSchema.safeParse({ ...EMAIL, shipment_id: "" }).success).toBe(false);
    expect(EvidenceMessageSchema.safeParse({ ...EMAIL, idempotency_key: "" }).success).toBe(false);
  });

  it("rejects an unknown field — the boundary is .strict()", () => {
    expect(EvidenceMessageSchema.safeParse({ ...EMAIL, cc: "boss@carrier.example" }).success).toBe(false);
  });

  it("rejects even an undefined-VALUED stray key — Zod v4 .strict() checks key PRESENCE, not value", () => {
    // {...SMS, subject: undefined} TYPE-checks against EvidenceMessage but must fail parse:
    // the runtime boundary is stricter than the TS surface, and that is deliberate.
    expect(EvidenceMessageSchema.safeParse({ ...SMS, subject: undefined }).success).toBe(false);
    expect(EvidenceMessageSchema.safeParse({ ...SMS, html: undefined }).success).toBe(false);
  });

  it("rejects CR/LF in idempotency_key — it rides verbatim in the Idempotency-Key HTTP header", () => {
    expect(
      EvidenceMessageSchema.safeParse({ ...EMAIL, idempotency_key: "evidence-email/evt-1\r\nX-Evil: 1" }).success,
    ).toBe(false);
    expect(EvidenceMessageSchema.safeParse({ ...EMAIL, idempotency_key: "evidence-email/evt-1\n" }).success).toBe(false);
  });

  it("rejects html that is already a full document — the port carries the FRAGMENT; the sender owes the wrap (double-wrap guard)", () => {
    expect(
      EvidenceMessageSchema.safeParse({ ...EMAIL, html: "<!doctype html><html><body>x</body></html>" }).success,
    ).toBe(false);
    expect(EvidenceMessageSchema.safeParse({ ...EMAIL, html: "  <HTML><body>x</body></html>" }).success).toBe(false);
  });

  it("accepts a 256-char idempotency_key and rejects 257 (Resend's documented max)", () => {
    expect(EvidenceMessageSchema.safeParse({ ...EMAIL, idempotency_key: "k".repeat(256) }).success).toBe(true);
    expect(EvidenceMessageSchema.safeParse({ ...EMAIL, idempotency_key: "k".repeat(257) }).success).toBe(false);
  });
});

// ── RecordingSender ─────────────────────────────────────────────────────────────────────────

describe("RecordingSender — tests/dev adapter with Resend idempotency semantics", () => {
  it("records a valid message and returns the receipt shape", async () => {
    const sender = new RecordingSender();
    const receipt = await sender.send(EMAIL);
    expect(receipt).toEqual({ accepted: true, provider: "recording", provider_id: "rec_evidence-email/evt-invoice-1" });
    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]).toEqual(EMAIL);
  });

  it("same key + same payload twice → ONE recorded message, the ORIGINAL receipt again", async () => {
    const sender = new RecordingSender();
    const first = await sender.send(EMAIL);
    const second = await sender.send({ ...EMAIL });
    expect(sender.messages).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("same key + DIFFERENT payload → conflict (a Biller bug: one invoice id, two different emails)", async () => {
    const sender = new RecordingSender();
    await sender.send(EMAIL);
    const err = await captureRejection(sender.send({ ...EMAIL, subject: "DELIVERED · SHP-40207 · PROOF + INVOICE" }));
    expect(err).toBeInstanceOf(SendError);
    if (!(err instanceof SendError)) throw new Error("expected SendError");
    expect(err.retriable).toBe(false);
    expect(err.message).toMatch(/conflict/i);
    expect(err.message).toContain(EMAIL.idempotency_key);
    expect(sender.messages).toHaveLength(1); // the conflicting message was NOT recorded
  });

  it("different keys → two messages, in send order", async () => {
    const sender = new RecordingSender();
    await sender.send(EMAIL);
    await sender.send({ ...EMAIL, idempotency_key: "evidence-email/evt-invoice-2" });
    expect(sender.messages).toHaveLength(2);
    expect(sender.messages.map((m) => m.idempotency_key)).toEqual([
      "evidence-email/evt-invoice-1",
      "evidence-email/evt-invoice-2",
    ]);
  });

  it("is deterministic — no Date, no random: two fresh senders yield byte-identical receipts", async () => {
    const a = await new RecordingSender().send(EMAIL);
    const b = await new RecordingSender().send(EMAIL);
    expect(a).toEqual(b);
  });

  it("a malformed message rejects with the VALIDATION error and records nothing", async () => {
    const sender = new RecordingSender();
    const err = await captureRejection(sender.send({ ...EMAIL, to: "" }));
    expect(err).toBeInstanceOf(z.ZodError);
    expect(sender.messages).toHaveLength(0);
  });
});

// ── NotConfiguredSender ─────────────────────────────────────────────────────────────────────

describe("NotConfiguredSender — an unconfigured environment REJECTS loudly, never no-ops", () => {
  it("a valid message rejects with the actionable config error: names what's missing, invoice unaffected, retriable, points at the doc", async () => {
    const err = await captureRejection(new NotConfiguredSender().send(EMAIL));
    expect(err).toBeInstanceOf(SendError);
    if (!(err instanceof SendError)) throw new Error("expected SendError");
    expect(err.retriable).toBe(true); // retriable once a provider is bound
    expect(err.message).toContain("REQ-092"); // live email = Resend API key + verified sending domain + DKIM
    expect(err.message).toContain("REQ-097"); // sms
    expect(err.message).toContain("invoice is unaffected");
    expect(err.message).toMatch(/no provider/i);
    expect(err.message).toContain("docs/wp/WP-06.md");
  });

  it("a malformed message rejects with the VALIDATION error, not the config error — the distinction holds", async () => {
    const err = await captureRejection(new NotConfiguredSender().send({ ...EMAIL, idempotency_key: "" }));
    expect(err).toBeInstanceOf(z.ZodError);
    expect(err).not.toBeInstanceOf(SendError);
  });
});

// ── ResendSender (stubbed fetch — ZERO network) ─────────────────────────────────────────────

interface CapturedCall {
  url: string;
  init: RequestInit;
}

/**
 * A local fetch stub: captures the call, answers with the given status/body. No network, ever.
 * A STRING body is sent raw as text/html (the proxy-error-page case); anything else is JSON.
 */
function stubFetch(status: number, body: unknown): { calls: CapturedCall[]; fetchImpl: typeof fetch } {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    const raw = typeof body === "string";
    return Promise.resolve(
      new Response(raw ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": raw ? "text/html" : "application/json" },
      }),
    );
  };
  return { calls, fetchImpl };
}

function mkResend(status: number, body: unknown): { sender: ResendSender; calls: CapturedCall[] } {
  const { calls, fetchImpl } = stubFetch(status, body);
  const sender = new ResendSender({ apiKey: "re_test_key", from: "SHUDDL <pod@tenant.example>", fetchImpl });
  return { sender, calls };
}

describe("ResendSender — the live adapter, exercised only against a stub", () => {
  it("POSTs the Resend contract: URL, Authorization, Idempotency-Key, and a WRAPPED html body", async () => {
    const { sender, calls } = mkResend(200, { id: "re_123" });
    await sender.send(EMAIL);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("expected one captured call");
    expect(call.url).toBe("https://api.resend.com/emails");
    expect(call.init.method).toBe("POST");

    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe("Bearer re_test_key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBe("evidence-email/evt-invoice-1");

    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body["from"]).toBe("SHUDDL <pod@tenant.example>");
    expect(body["to"]).toEqual(["receiving@consignee.example"]);
    expect(body["subject"]).toBe(EMAIL.subject);
    expect(body["text"]).toBe(EMAIL.text);
    const html = body["html"] as string;
    expect(html.startsWith("<!doctype html>")).toBe(true); // the fragment is WRAPPED, per the render's contract
    expect(html).toContain('<meta charset="utf-8">'); // the · U+00B7 needs the charset
    expect(html).toContain(EMAIL.html as string); // the fragment rides inside, byte-intact
  });

  it("2xx {id} → the receipt projects Resend's id", async () => {
    const { sender } = mkResend(200, { id: "re_123" });
    const receipt: SendReceipt = await sender.send(EMAIL);
    expect(receipt).toEqual({ accepted: true, provider: "resend", provider_id: "re_123" });
  });

  it("a NETWORK-level fetch failure (DNS/timeout/reset) → SendError retriable===true, never a raw TypeError", async () => {
    // The single most common real failure MUST carry the retriability verdict.
    const sender = new ResendSender({
      apiKey: "re_test_key",
      from: "SHUDDL <pod@tenant.example>",
      fetchImpl: () => Promise.reject(new TypeError("fetch failed: getaddrinfo ENOTFOUND api.resend.com")),
    });
    const err = await captureRejection(sender.send(EMAIL));
    expect(err).toBeInstanceOf(SendError);
    if (!(err instanceof SendError)) throw new Error("expected SendError");
    expect(err.retriable).toBe(true);
    expect(err.status).toBeUndefined(); // no Resend response ever existed
    expect(err.message).toContain("ENOTFOUND"); // the cause rides along (a network error carries no config)
    expect(err.message).toContain("redelivery"); // the Idempotency-Key makes redelivery safe
  });

  it("2xx with a NON-JSON body → retriable SendError, never a raw SyntaxError", async () => {
    const { sender } = mkResend(200, "<html>ok, but not json</html>");
    const err = await captureRejection(sender.send(EMAIL));
    expect(err).toBeInstanceOf(SendError);
    if (!(err instanceof SendError)) throw new Error("expected SendError");
    expect(err.retriable).toBe(true); // the Idempotency-Key makes redelivery safe
    expect(err.status).toBe(200);
  });

  it("2xx WITHOUT an id ({}) → retriable SendError (the Idempotency-Key makes redelivery safe)", async () => {
    const { sender } = mkResend(200, {});
    const err = await captureRejection(sender.send(EMAIL));
    expect(err).toBeInstanceOf(SendError);
    if (!(err instanceof SendError)) throw new Error("expected SendError");
    expect(err.retriable).toBe(true);
    expect(err.status).toBe(200);
    expect(err.message).toContain("redelivery");
  });

  it("409 → NON-retriable idempotency conflict naming the key, status on the error", async () => {
    const { sender } = mkResend(409, { statusCode: 409, name: "conflict", message: "Idempotency key already used" });
    const err = await captureRejection(sender.send(EMAIL));
    expect(err).toBeInstanceOf(SendError);
    if (!(err instanceof SendError)) throw new Error("expected SendError");
    expect(err.retriable).toBe(false);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/conflict/i);
    expect(err.message).toContain("evidence-email/evt-invoice-1");
  });

  it("409 concurrent_idempotent_requests → RETRIABLE (same key still in flight — the at-least-once race, documented safe-to-retry)", async () => {
    // Two consumers race one message: both appends dedupe cleanly in the DO, both send the same key;
    // Resend answers the loser with this name. Redelivery re-reads the winner's original response.
    const { sender } = mkResend(409, {
      statusCode: 409,
      name: "concurrent_idempotent_requests",
      message: "Same idempotency key used while original request is still processing",
    });
    const err = await captureRejection(sender.send(EMAIL));
    expect(err).toBeInstanceOf(SendError);
    if (!(err instanceof SendError)) throw new Error("expected SendError");
    expect(err.retriable).toBe(true);
    expect(err.status).toBe(409);
    expect(err.message).toContain("evidence-email/evt-invoice-1");
    expect(err.message).toMatch(/still being processed/i);
  });

  it("409 invalid_idempotent_request → NON-retriable (same key, DIFFERENT payload — a Biller bug, never a retry)", async () => {
    const { sender } = mkResend(409, {
      statusCode: 409,
      name: "invalid_idempotent_request",
      message: "Same idempotency key used with a different request payload",
    });
    const err = await captureRejection(sender.send(EMAIL));
    expect(err).toBeInstanceOf(SendError);
    if (!(err instanceof SendError)) throw new Error("expected SendError");
    expect(err.retriable).toBe(false);
    expect(err.status).toBe(409);
    expect(err.message).toContain("invalid_idempotent_request");
    expect(err.message).toContain("evidence-email/evt-invoice-1");
  });

  it("429 → RETRIABLE (the queue consumer's redelivery is the retry)", async () => {
    const { sender } = mkResend(429, { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests" });
    const err = await captureRejection(sender.send(EMAIL));
    expect(err).toBeInstanceOf(SendError);
    if (!(err instanceof SendError)) throw new Error("expected SendError");
    expect(err.retriable).toBe(true);
    expect(err.status).toBe(429);
    expect(err.message).toContain("redelivery"); // unambiguous — "Not retriable" could satisfy /retriable/i
  });

  it("500 → RETRIABLE", async () => {
    const { sender } = mkResend(500, { statusCode: 500, name: "internal_server_error", message: "boom" });
    const err = await captureRejection(sender.send(EMAIL));
    expect(err).toBeInstanceOf(SendError);
    if (!(err instanceof SendError)) throw new Error("expected SendError");
    expect(err.retriable).toBe(true);
    expect(err.status).toBe(500);
    expect(err.message).toContain("redelivery");
  });

  it("503 → RETRIABLE too — 5xx is a RANGE, not one status", async () => {
    const { sender } = mkResend(503, { statusCode: 503, name: "application_error", message: "service unavailable" });
    const err = await captureRejection(sender.send(EMAIL));
    expect(err).toBeInstanceOf(SendError);
    if (!(err instanceof SendError)) throw new Error("expected SendError");
    expect(err.retriable).toBe(true);
    expect(err.status).toBe(503);
  });

  it("a NON-JSON error body is carried but TRUNCATED — a proxy's full 502 page never floods queue logs", async () => {
    const marker = "TAIL-MARKER-MUST-NOT-APPEAR";
    const { sender } = mkResend(502, `<html><body>Bad gateway ${"x".repeat(600)}${marker}</body></html>`);
    const err = await captureRejection(sender.send(EMAIL));
    expect(err).toBeInstanceOf(SendError);
    if (!(err instanceof SendError)) throw new Error("expected SendError");
    expect(err.retriable).toBe(true);
    expect(err.status).toBe(502);
    expect(err.message).toContain("Bad gateway"); // the head of the page survives as detail
    expect(err.message).not.toContain(marker); // the tail past 500 chars does not
    expect(err.message).toMatch(/truncated/i);
  });

  it("403 → NON-retriable, carries Resend's message and the verified-domain hint", async () => {
    const { sender } = mkResend(403, { statusCode: 403, name: "validation_error", message: "Domain is not verified" });
    const err = await captureRejection(sender.send(EMAIL));
    expect(err).toBeInstanceOf(SendError);
    if (!(err instanceof SendError)) throw new Error("expected SendError");
    expect(err.retriable).toBe(false);
    expect(err.status).toBe(403);
    expect(err.message).toContain("Domain is not verified"); // Resend's own message rides along
    expect(err.message).toMatch(/VERIFIED sending domain/); // the from-domain hint
  });

  it("sms → the not-wired error (REQ-097 deferred); fetch is never touched", async () => {
    const { sender, calls } = mkResend(200, { id: "re_never" });
    const err = await captureRejection(sender.send(SMS));
    expect(err).toBeInstanceOf(SendError);
    if (!(err instanceof SendError)) throw new Error("expected SendError");
    expect(err.message).toMatch(/sms/i);
    expect(err.message).toContain("REQ-097");
    expect(calls).toHaveLength(0);
  });

  it("a malformed message rejects with the VALIDATION error; fetch is never touched", async () => {
    const { sender, calls } = mkResend(200, { id: "re_never" });
    const err = await captureRejection(sender.send({ ...EMAIL, to: "a@b.example\r\nbcc: x@y" }));
    expect(err).toBeInstanceOf(z.ZodError);
    expect(calls).toHaveLength(0);
  });
});

// ── wrapFragment ────────────────────────────────────────────────────────────────────────────

describe("wrapFragment — the sender's half of the render contract (doctype + charset)", () => {
  it("wraps the fragment exactly: doctype, charset meta, body around the fragment", () => {
    expect(wrapFragment("<p>proof</p>")).toBe(
      '<!doctype html><html><head><meta charset="utf-8"></head><body><p>proof</p></body></html>',
    );
  });
});
