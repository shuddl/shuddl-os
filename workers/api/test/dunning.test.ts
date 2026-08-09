import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { sweepTenantOverdueInvoices } from "../../agents/src/collector.js";
import {
  dunningDraftId,
  RecordingSender,
  SendError,
  type EvidenceMessage,
  type EvidenceSender,
  type SendReceipt,
} from "@shuddl/agents";
import { sendDunningDraft, listDunningDrafts, dunningSentEventId, type DunningSendDeps } from "../src/routes/dunning.js";
import { ensureSchema, TENANT_SLUG, token } from "./helpers.js";

// ─── WP-11 Task 7 — THE COLLECTOR human review-and-send (REQ-032) ───────────────────────────────────────────
//
// The other half of the Collector: an operator reviews the drafts (GET /v1/dunning?status=draft) and clicks
// send (POST /v1/dunning/:id/send). The HUMAN IS THE APPROVAL — no auto-send, no dual-control matrix. The send
// mirrors the Biller/Concierge append-then-send: message.sent appended THROUGH the sequencer FIRST, THEN the
// EvidenceSender; idempotent (deterministic id → one message.sent, ever); honest HOLD on a permanent send fault.
//
// VENUE (like collector-cron.test.ts / concierge.test.ts): the ShipmentSequencer DO + the migrated tenant D1
// live in THIS harness. The DRAFT is created by the REAL Collector sweep (imported from the agents worker); the
// send CORE (sendDunningDraft) is driven directly with an INJECTED sender + clock so "sent/held" is deterministic,
// while the ROUTE surface (role gating, tenant-lens) is exercised through SELF.fetch. isolatedStorage is OFF —
// every case uses a DISTINCT invoice/party id and asserts on its OWN deterministic draft/event id.

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-15T00:00:00Z");
const FROM_NAME = "Shuddl Billing"; // REQ-098/167 tenant voice (the API worker's DEFAULT_DUNNING_FROM_NAME)

// ── the sequencer append surface against the REAL DO (mirrors concierge.test.ts) ─────────────────────────────
const seqStub = {
  append: (req: { tenant: string; streamId: string; input: unknown }) =>
    (env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${req.tenant}|${req.streamId}`)) as unknown as {
      append: (r: { tenant: string; streamId: string; input: unknown }) => Promise<{ id: string; ts: number; payload: Record<string, unknown> }>;
    }).append(req),
};

function depsWith(sender: EvidenceSender, now = () => NOW): DunningSendDeps {
  return { db: env.TENANT_A_DB, tenant: TENANT_SLUG, seq: seqStub as unknown as DunningSendDeps["seq"], sender, tenantFromName: FROM_NAME, now };
}

// A sender that always fails — retriable (transient) OR permanent (held). Mirrors concierge.test's ThrowingSender.
class ThrowingSender implements EvidenceSender {
  constructor(private readonly retriable: boolean) {}
  async send(_m: EvidenceMessage): Promise<SendReceipt> {
    throw new SendError(this.retriable ? "resend answered 503" : "resend rejected the send (422)", this.retriable);
  }
}

async function seedParty(partyId: string, email: string | null): Promise<void> {
  const contacts = email === null ? "[]" : JSON.stringify([{ kind: "billing", email }]);
  await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO parties (id, kind, names, contacts) VALUES (?,?,?,?)")
    .bind(partyId, "shipper", "{}", contacts)
    .run();
}
async function seedInvoice(id: string, partyId: string, opts: { status?: string; dueTs: number | null; totalCents?: number }): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO invoices (id, party_id, division, shipment_ids, total_cents, status, issued_event_id, terms, due_ts) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(id, partyId, "main", "[]", opts.totalCents ?? 100_000, opts.status ?? "issued", `evt-${id}`, opts.dueTs === null ? null : "net30", opts.dueTs)
    .run();
}

async function messageSentCount(eventId: string): Promise<number> {
  const r = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS c FROM events WHERE id = ?1 AND kind = 'message.sent'").bind(eventId).first<{ c: number }>();
  return r?.c ?? 0;
}

// Seed a party + invoice + DRAFT via the REAL Collector sweep, returning the deterministic draft id.
async function seedDraft(invoiceId: string, partyId: string, email: string | null, opts: { dueTs?: number; status?: string } = {}): Promise<string> {
  await seedParty(partyId, email);
  await seedInvoice(invoiceId, partyId, { dueTs: opts.dueTs ?? NOW - 10 * DAY, ...(opts.status !== undefined ? { status: opts.status } : {}) });
  await sweepTenantOverdueInvoices(env.TENANT_A_DB, NOW); // DRAFTS a 'reminder' for a 10-day-overdue invoice
  return dunningDraftId(invoiceId, "reminder");
}

beforeAll(async () => {
  await ensureSchema(env);
});

describe("the draft-queue read (GET /v1/dunning?status=draft) — lists the Collector's drafts, re-rendered (REQ-032)", () => {
  it("lists an unsent draft with its invoice / party / bucket / amount / recipient / re-rendered subject", async () => {
    await seedDraft("dun-inv-read", "dun-p-read", "billing@dun-read.example.com");

    const drafts = await listDunningDrafts(env.TENANT_A_DB, "draft", FROM_NAME, NOW);
    const item = drafts.find((d) => d.invoice_id === "dun-inv-read");
    expect(item).toBeDefined();
    expect(item!.draft_id).toBe(dunningDraftId("dun-inv-read", "reminder"));
    expect(item!.bucket).toBe("reminder");
    expect(item!.party_id).toBe("dun-p-read");
    expect(item!.amount_cents).toBe(100_000);
    expect(item!.days_overdue).toBe(10);
    expect(item!.recipient).toBe("billing@dun-read.example.com");
    expect(item!.subject).toContain("REMINDER"); // the FIXED per-bucket subject tag (re-rendered from committed state)
    expect(item!.subject).toContain("dun-inv-read");
    expect(item!.preview_html).toContain("Shuddl Billing"); // the tenant voice signs the re-rendered body
  });

  it("excludes a draft whose invoice has since SETTLED (paid) — a settled AR is not dunnable", async () => {
    await seedDraft("dun-inv-settled", "dun-p-settled", "billing@dun-settled.example.com");
    // The AR settles after drafting — the draft must drop out of the draft queue (nothing to dun).
    await env.TENANT_A_DB.prepare("UPDATE invoices SET status = 'paid' WHERE id = ?1").bind("dun-inv-settled").run();

    const drafts = await listDunningDrafts(env.TENANT_A_DB, "draft", FROM_NAME, NOW);
    expect(drafts.some((d) => d.invoice_id === "dun-inv-settled")).toBe(false);
  });

  it("GET /v1/dunning is a money-lens surface (ops 200); an unknown status is a hard 400", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const ok = await SELF.fetch("https://api.local/v1/dunning?status=draft", { headers: { Authorization: `Bearer ${t}` } });
    expect(ok.status).toBe(200);
    const bad = await SELF.fetch("https://api.local/v1/dunning?status=bogus", { headers: { Authorization: `Bearer ${t}` } });
    expect(bad.status).toBe(400);
  });
});

describe("the approve-and-send route (POST /v1/dunning/:id/send) — append-then-send, idempotent, honest hold (REQ-032)", () => {
  it("addresses the BILLING contact, not merely the first one (§785 — the mirror of the Biller's rule)", async () => {
    // `resolveDunningRecipient` is a byte-for-byte re-implementation of the Biller's `resolveRecipient`
    // (the api worker cannot import the agents worker's internals). Its header claims "no drift". Nothing
    // checked either half: deleting `if (billing !== undefined) return plausibleEmail(billing)` here left
    // this worker at 803/803, exactly as the same deletion left the Biller's copy silent in BOTH suites.
    //
    // The reason is the fixture, not the rule: `seedParty` seeds exactly ONE contact, always `kind:"billing"`,
    // so preference and first-match are indistinguishable in every existing case. A dunning notice is a
    // demand for money — sending it to a dispatcher instead of AP is the wrong human at the right company,
    // and it looks identical to success from every angle except the unpaid invoice.
    //
    // The ORDER is the test (§772): dispatch first, billing second.
    await env.TENANT_A_DB.prepare("INSERT OR REPLACE INTO parties (id, kind, names, contacts) VALUES (?,?,?,?)")
      .bind(
        "dun-p-order",
        "shipper",
        "{}",
        JSON.stringify([
          { kind: "dispatch", email: "dispatch@dun-order.example.com" },
          { kind: "billing", email: "ap@dun-order.example.com" },
        ]),
      )
      .run();
    await seedInvoice("dun-inv-order", "dun-p-order", { dueTs: NOW - 10 * DAY });
    await sweepTenantOverdueInvoices(env.TENANT_A_DB, NOW);

    const sender = new RecordingSender();
    const outcome = await sendDunningDraft(depsWith(sender), dunningDraftId("dun-inv-order", "reminder"));

    expect(outcome.status).toBe("sent");
    expect(sender.messages).toHaveLength(1);
    expect(
      sender.messages[0]!.to,
      "a dunning notice addressed to dispatch instead of AP — the demand never reaches the payer",
    ).toBe("ap@dun-order.example.com");
  });

  it("SENDS: appends message.sent THROUGH the sequencer + calls the sender; the draft then LEAVES the draft queue", async () => {
    const draftId = await seedDraft("dun-inv-send", "dun-p-send", "billing@dun-send.example.com");
    const sentId = await dunningSentEventId("dun-inv-send", "reminder");
    expect(await messageSentCount(sentId)).toBe(0); // nothing sent yet — the sweep never sends

    const sender = new RecordingSender();
    const outcome = await sendDunningDraft(depsWith(sender), draftId);

    expect(outcome.status).toBe("sent");
    expect(await messageSentCount(sentId)).toBe(1); // message.sent is now on the timeline
    expect(sender.messages).toHaveLength(1); // the sender was called ONCE
    const sent = sender.messages[0]!;
    expect(sent.to).toBe("billing@dun-send.example.com");
    expect(sent.shipment_id).toBeUndefined(); // the widened, party-scoped send — NO shipment_id
    expect(sent.subject).toContain("dun-inv-send");
    expect(sent.html).toContain("Shuddl Billing");

    // the draft has LEFT the ?status=draft queue (a message.sent now shares its body_ref)
    const drafts = await listDunningDrafts(env.TENANT_A_DB, "draft", FROM_NAME, NOW);
    expect(drafts.some((d) => d.draft_id === draftId)).toBe(false);
    // …and shows up under status=sent
    const sentList = await listDunningDrafts(env.TENANT_A_DB, "sent", FROM_NAME, NOW);
    expect(sentList.some((d) => d.draft_id === draftId)).toBe(true);
  });

  it("IDEMPOTENT: a double-send is a no-op — exactly ONE message.sent, the sender deduped by the key", async () => {
    const draftId = await seedDraft("dun-inv-idem", "dun-p-idem", "billing@dun-idem.example.com");
    const sentId = await dunningSentEventId("dun-inv-idem", "reminder");

    const sender = new RecordingSender();
    const first = await sendDunningDraft(depsWith(sender), draftId);
    const second = await sendDunningDraft(depsWith(sender), draftId); // re-POST via the fast path

    expect(first.status).toBe("sent");
    expect(second.status).toBe("sent");
    expect(await messageSentCount(sentId)).toBe(1); // ONE event — the sequencer deduped by the deterministic id
    expect(sender.messages).toHaveLength(1); // ONE recorded send — the sender deduped by the idempotency key
  });

  it("HONEST HOLD: a PERMANENT send fault → held (never a false 'sent'); the message.sent event still stands", async () => {
    const draftId = await seedDraft("dun-inv-hold", "dun-p-hold", "billing@dun-hold.example.com");
    const sentId = await dunningSentEventId("dun-inv-hold", "reminder");

    const outcome = await sendDunningDraft(depsWith(new ThrowingSender(false)), draftId);
    expect(outcome.status).toBe("held");
    if (outcome.status === "held") expect(outcome.reason).toBe("send_failed_permanent");
    expect(await messageSentCount(sentId)).toBe(1); // the append happened FIRST — the send is on the timeline, held
  });

  it("HOLD (no recipient): a bill-to with NO billing email holds with NOTHING appended (no false send record)", async () => {
    const draftId = await seedDraft("dun-inv-noemail", "dun-p-noemail", "seed@dun-noemail.example.com");
    // strip the billing email AFTER drafting → the send can't address it
    await env.TENANT_A_DB.prepare("UPDATE parties SET contacts = '[]' WHERE id = ?1").bind("dun-p-noemail").run();
    const sentId = await dunningSentEventId("dun-inv-noemail", "reminder");

    const sender = new RecordingSender();
    const outcome = await sendDunningDraft(depsWith(sender), draftId);
    expect(outcome.status).toBe("held");
    if (outcome.status === "held") expect(outcome.reason).toBe("recipient_unresolved");
    expect(await messageSentCount(sentId)).toBe(0); // NOTHING appended — a message.sent with no to_ref would lie
    expect(sender.messages).toHaveLength(0);
  });

  it("REFUSES a settled invoice: a since-paid AR gets no fresh dunning (nothing appended, nothing sent)", async () => {
    const draftId = await seedDraft("dun-inv-refuse", "dun-p-refuse", "billing@dun-refuse.example.com");
    await env.TENANT_A_DB.prepare("UPDATE invoices SET status = 'paid' WHERE id = ?1").bind("dun-inv-refuse").run();
    const sentId = await dunningSentEventId("dun-inv-refuse", "reminder");

    const sender = new RecordingSender();
    const outcome = await sendDunningDraft(depsWith(sender), draftId);
    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") expect(outcome.reason).toBe("invoice_not_open");
    expect(await messageSentCount(sentId)).toBe(0);
    expect(sender.messages).toHaveLength(0);
  });

  it("a RETRIABLE send fault THROWS (so the POST is a 5xx a retry re-sends) — the message.sent still stands", async () => {
    const draftId = await seedDraft("dun-inv-retry", "dun-p-retry", "billing@dun-retry.example.com");
    const sentId = await dunningSentEventId("dun-inv-retry", "reminder");

    await expect(sendDunningDraft(depsWith(new ThrowingSender(true)), draftId)).rejects.toBeInstanceOf(SendError);
    expect(await messageSentCount(sentId)).toBe(1); // appended first; a retry hits the fast path + re-sends
  });

  it("a missing draft is a clean skip (draft_not_found) — never a crash, never a phantom send", async () => {
    const sender = new RecordingSender();
    const outcome = await sendDunningDraft(depsWith(sender), "msg:dunning:does-not-exist:reminder");
    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") expect(outcome.reason).toBe("draft_not_found");
    expect(sender.messages).toHaveLength(0);
  });
});

describe("role gating (REQ-030) — only admin/ops/finance reach the dunning surface", () => {
  it("a driver is 403 on the draft queue AND on the send", async () => {
    const driver = await token({ sub: "d1", tenant: TENANT_SLUG, role: "driver" });
    const read = await SELF.fetch("https://api.local/v1/dunning?status=draft", { headers: { Authorization: `Bearer ${driver}` } });
    expect(read.status).toBe(403);
    const send = await SELF.fetch("https://api.local/v1/dunning/msg:dunning:x:reminder/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${driver}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
      body: "{}",
    });
    expect(send.status).toBe(403);
  });

  it("a read-only role is 403 on the send (it may not initiate a send)", async () => {
    const reader = await token({ sub: "r1", tenant: TENANT_SLUG, role: "read" });
    const send = await SELF.fetch("https://api.local/v1/dunning/msg:dunning:x:reminder/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${reader}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
      body: "{}",
    });
    expect(send.status).toBe(403);
  });

  it("POST /v1/dunning/:id/send REQUIRES an Idempotency-Key (the mutation middleware)", async () => {
    const ops = await token({ sub: "o1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/dunning/msg:dunning:x:reminder/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${ops}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400); // IDEMPOTENCY_KEY_REQUIRED
  });
});
