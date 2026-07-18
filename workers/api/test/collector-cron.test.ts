import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { sweepTenantOverdueInvoices } from "../../agents/src/collector.js";
import { dunningDraftId, dunningBodyRef } from "@shuddl/agents";
import { ensureSchema } from "./helpers.js";

// ─── WP-11 Task 6 — THE COLLECTOR dunning sweep (REQ-032) ───────────────────────────────────────────
//
// The per-tenant sweep's proof: it finds OPEN overdue invoices (`status='issued' AND due_ts < now` — the
// WP-10 AR-settlement projection populates terms/due_ts and flips a covered invoice to 'paid') and DRAFTS a
// tone-matched dunning `messages` row for each (drafted_by_agent='collector', channel='email', direction='out',
// shipment_id NULL — party/invoice-scoped — the deterministic body_ref the pointer Task 7 re-renders from).
// It appends NO `message.sent` and calls NO sender (DRAFT ONLY, REQ-032 DoD: "no auto-send"); the draft id is
// deterministic per (invoice, escalation bucket) so a re-sweep is a no-op (INSERT OR IGNORE) and an invoice
// that ages into a firmer bucket yields a NEW draft (never a clobber).
//
// VENUE (like sla-sweep.test.ts): the migrated tenant D1 lives in this api harness; the sweep FUNCTION is
// imported from the agents worker and driven directly with an INJECTED clock so "overdue" is deterministic.
// It needs no DO (it appends no event) and no sender (it sends nothing). isolatedStorage is OFF (shared D1) —
// every case uses a DISTINCT invoice/party id and asserts on its OWN deterministic draft id, so the global
// sweep drafting for other cases' invoices never disturbs a per-invoice assertion.

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-15T00:00:00Z");

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

interface DraftRow {
  id: string;
  channel: string;
  direction: string;
  party_id: string | null;
  shipment_id: string | null;
  body_ref: string | null;
  drafted_by_agent: string | null;
  sla_due_ts: number | null;
}
async function draftRows(invoiceId: string): Promise<DraftRow[]> {
  const res = await env.TENANT_A_DB.prepare(
    "SELECT id, channel, direction, party_id, shipment_id, body_ref, drafted_by_agent, sla_due_ts FROM messages WHERE id LIKE ?1 ORDER BY id",
  )
    .bind(`msg:dunning:${invoiceId}:%`)
    .all<DraftRow>();
  return res.results;
}
async function messageSentCount(): Promise<number> {
  const r = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'message.sent'").first<{ c: number }>();
  return r?.c ?? 0;
}

beforeAll(async () => {
  await ensureSchema(env);
});

describe("Collector dunning sweep — DRAFTS a tone-matched dunning for an OPEN overdue invoice (REQ-032)", () => {
  it("does NOT draft before due; DRAFTS exactly one 'reminder' draft AFTER due — a draft row, NEVER a message.sent", async () => {
    await seedParty("collector-p-remind", "billing@collector-remind.example.com");
    await seedInvoice("collector-inv-remind", "collector-p-remind", { dueTs: NOW - 10 * DAY }); // 10 days overdue → reminder

    // BEFORE due — the invoice is not yet overdue at this clock, so nothing is drafted.
    await sweepTenantOverdueInvoices(env.TENANT_A_DB, NOW - 20 * DAY);
    expect(await draftRows("collector-inv-remind")).toHaveLength(0);

    // AFTER due — one 'reminder' draft lands. No message.sent event is appended (the sweep has no sender/seq).
    const sentBefore = await messageSentCount();
    await sweepTenantOverdueInvoices(env.TENANT_A_DB, NOW);
    expect(await messageSentCount()).toBe(sentBefore); // NO auto-send — the count is unchanged

    const rows = await draftRows("collector-inv-remind");
    expect(rows).toHaveLength(1);
    const d = rows[0]!;
    expect(d.id).toBe(dunningDraftId("collector-inv-remind", "reminder"));
    expect(d.channel).toBe("email");
    expect(d.direction).toBe("out");
    expect(d.drafted_by_agent).toBe("collector");
    expect(d.party_id).toBe("collector-p-remind"); // the bill-to party (Task 7 re-resolves the recipient off it)
    expect(d.shipment_id).toBeNull(); // party/invoice-scoped — NOT shipment-scoped (the sender-widening motive)
    expect(d.sla_due_ts).toBeNull(); // a dunning draft is not an SLA-tracked inbound
    expect(d.body_ref).toBe(dunningBodyRef("collector-inv-remind", "reminder"));
  });

  it("IDEMPOTENT — a re-sweep of the SAME overdue state drafts ZERO new (INSERT OR IGNORE), still exactly one row", async () => {
    await seedParty("collector-p-idem", "billing@collector-idem.example.com");
    await seedInvoice("collector-inv-idem", "collector-p-idem", { dueTs: NOW - 5 * DAY });

    await sweepTenantOverdueInvoices(env.TENANT_A_DB, NOW);
    await sweepTenantOverdueInvoices(env.TENANT_A_DB, NOW); // aggressive re-run at the same clock
    expect(await draftRows("collector-inv-idem")).toHaveLength(1); // no duplicate — bounded, not per-tick re-draft
  });

  it("ESCALATES — an invoice that ages into a firmer bucket gets a NEW draft (never a clobber of the reminder)", async () => {
    await seedParty("collector-p-esc", "billing@collector-esc.example.com");
    await seedInvoice("collector-inv-esc", "collector-p-esc", { dueTs: NOW - 10 * DAY }); // start 10 days overdue

    await sweepTenantOverdueInvoices(env.TENANT_A_DB, NOW); // reminder
    await sweepTenantOverdueInvoices(env.TENANT_A_DB, NOW + 35 * DAY); // now 45 days overdue → firm

    const ids = (await draftRows("collector-inv-esc")).map((r) => r.id);
    expect(ids).toContain(dunningDraftId("collector-inv-esc", "reminder"));
    expect(ids).toContain(dunningDraftId("collector-inv-esc", "firm"));
    expect(ids).toHaveLength(2); // both tones present — the firmer draft did not overwrite the reminder
  });

  it("buckets by whole-days-overdue — 45d → firm, 90d → final", async () => {
    await seedParty("collector-p-buckets", "billing@collector-buckets.example.com");
    await seedInvoice("collector-inv-firm", "collector-p-buckets", { dueTs: NOW - 45 * DAY });
    await seedInvoice("collector-inv-final", "collector-p-buckets", { dueTs: NOW - 90 * DAY });

    await sweepTenantOverdueInvoices(env.TENANT_A_DB, NOW);
    expect((await draftRows("collector-inv-firm")).map((r) => r.id)).toEqual([dunningDraftId("collector-inv-firm", "firm")]);
    expect((await draftRows("collector-inv-final")).map((r) => r.id)).toEqual([dunningDraftId("collector-inv-final", "final")]);
  });

  it("does NOT draft a CURRENT (not-yet-due) invoice, nor a PAID one, nor one with NO terms (NULL due_ts)", async () => {
    await seedParty("collector-p-skip", "billing@collector-skip.example.com");
    await seedInvoice("collector-inv-current", "collector-p-skip", { dueTs: NOW + 5 * DAY }); // due in the future
    await seedInvoice("collector-inv-paid", "collector-p-skip", { status: "paid", dueTs: NOW - 30 * DAY }); // overdue but PAID
    await seedInvoice("collector-inv-noterms", "collector-p-skip", { dueTs: null }); // no terms → no due date → cannot be overdue

    await sweepTenantOverdueInvoices(env.TENANT_A_DB, NOW);
    expect(await draftRows("collector-inv-current")).toHaveLength(0);
    expect(await draftRows("collector-inv-paid")).toHaveLength(0);
    expect(await draftRows("collector-inv-noterms")).toHaveLength(0);
  });

  it("does NOT draft an overdue invoice whose bill-to party has NO resolvable billing email (counted, not drafted)", async () => {
    await seedParty("collector-p-noemail", null); // no contacts → resolveRecipient returns undefined
    await seedInvoice("collector-inv-noemail", "collector-p-noemail", { dueTs: NOW - 15 * DAY });

    const res = await sweepTenantOverdueInvoices(env.TENANT_A_DB, NOW);
    expect(await draftRows("collector-inv-noemail")).toHaveLength(0);
    expect(res.no_recipient).toBeGreaterThanOrEqual(1); // surfaced in the result (a data fault, not a draft)
  });
});
