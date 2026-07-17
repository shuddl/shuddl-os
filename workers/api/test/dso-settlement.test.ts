import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { AppendedEvent } from "../src/do/sequencer.js";
import { TENANT_SLUG, ensureSchema } from "./helpers.js";

// ─── REQ-083 (WP-10 Task 4) — THE AR-SETTLEMENT DATA FOR AN HONEST DSO ──────────────────────────────
//
// The DSO KPI + the money queue's aging need to know which invoices are OPEN (issued, unpaid) and their
// ages. Two projection writes make that derivable WITHOUT fabricating a number:
//   1. invoice.issued populates invoices.terms + invoices.due_ts (server-sourced terms; net-30 default).
//   2. payment.received flips the matched OPEN invoice to status='paid' (matched by payload.invoice_id,
//      else the shipment's single open invoice) — while the cod_collect money_line stays UNCHANGED.
//
// This file drives the REAL ShipmentSequencer DO so the server-side #moneyDeps linkage runs (the terms
// source + the payment→invoice match). isolatedStorage is OFF (shared D1) — every id here is `dso-`/`inv-dso-`
// scoped, and every read filters to these ids so other files' invoices never bleed in.

const TENANT = TENANT_SLUG;
const HEX64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const GEO = { lat_e6: 37_421_000, lon_e6: -122_084_000 };
const ISSUE_TS = 1_720_000_000_000;
const DAY_MS = 86_400_000;

type SeqStub = DurableObjectStub & {
  append(req: { tenant: string; streamId: string; input: unknown }): Promise<AppendedEvent>;
};
function stubFor(streamId: string): SeqStub {
  return env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${TENANT}|${streamId}`)) as unknown as SeqStub;
}

// A valid EventInput (client-suppliable subset); shipment_id derived from the stream so the DB CHECK holds.
function inputFor(streamId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: streamId.startsWith("s:") ? streamId.slice(2) : undefined,
    ts: ISSUE_TS,
    actor: { party: "party-shipper" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "quote.requested",
    payload: { request: { origin_zip: "97201", dest_zip: "98101" } },
    ...over,
  };
}

function invoicePayload(invoiceId: string): Record<string, unknown> {
  return {
    invoice_id: invoiceId,
    party_id: "party-bill-to",
    division: "main",
    lines: [{ line_no: 1, kind: "freight", amount_cents: 120_000, gl_map: "4000-REV" }],
  };
}

// pod.signed then invoice.issued (the I2 gate needs the POD first), returning the issued invoice event id.
async function issueInvoice(streamId: string, invoiceId: string): Promise<string> {
  const stub = stubFor(streamId);
  await stub.append({
    tenant: TENANT,
    streamId,
    input: inputFor(streamId, { kind: "pod.signed", payload: { signature_hash: HEX64, geo: GEO, unwitnessed: true } }),
  });
  const inv = await stub.append({ tenant: TENANT, streamId, input: inputFor(streamId, { kind: "invoice.issued", payload: invoicePayload(invoiceId) }) });
  return inv.id;
}

async function invoiceRow(id: string): Promise<{ status: string; terms: string | null; due_ts: number | null; total_cents: number } | null> {
  return env.TENANT_A_DB.prepare("SELECT status, terms, due_ts, total_cents FROM invoices WHERE id = ?")
    .bind(id)
    .first<{ status: string; terms: string | null; due_ts: number | null; total_cents: number }>();
}

beforeAll(async () => {
  await ensureSchema(env);
});

describe("REQ-083 — invoice.issued populates terms + due_ts server-side (honest net-30 default)", () => {
  it("an issued invoice carries terms='net30' and due_ts = issue ts + 30 days (integer ms), status='issued'", async () => {
    await issueInvoice("s:dso-terms", "inv-dso-terms");
    const row = await invoiceRow("inv-dso-terms");
    expect(row).toEqual({ status: "issued", terms: "net30", due_ts: ISSUE_TS + 30 * DAY_MS, total_cents: 120_000 });
  });
});

describe("REQ-083 — payment.received flips the matched invoice to 'paid'", () => {
  it("SHIPMENT-LEVEL match (no invoice_id): a covering COD payment settles the shipment's open invoice; cod_collect UNCHANGED", async () => {
    const streamId = "s:dso-cod";
    await issueInvoice(streamId, "inv-dso-cod");
    expect((await invoiceRow("inv-dso-cod"))?.status).toBe("issued");

    const pay = await stubFor(streamId).append({
      tenant: TENANT,
      streamId,
      input: inputFor(streamId, { kind: "payment.received", payload: { method: "cod", amount_cents: 120_000, party_id: "party-bill-to", division: "main" } }),
    });

    // The invoice is settled by the shipment linkage (issued_event_id → events.shipment_id).
    expect((await invoiceRow("inv-dso-cod"))?.status).toBe("paid");

    // The cod_collect money_line is byte-for-byte what it always was (money-parity is sacred).
    const lines = await env.TENANT_A_DB.prepare("SELECT amount_cents, kind, direction FROM money_lines WHERE event_id = ?")
      .bind(pay.id)
      .all<{ amount_cents: number; kind: string; direction: string }>();
    expect(lines.results).toEqual([{ amount_cents: -120_000, kind: "cod_collect", direction: "ar" }]);
  });

  it("INVOICE-ID match: a non-COD payment naming the invoice settles it with NO money_line (method-agnostic)", async () => {
    const streamId = "s:dso-ach";
    await issueInvoice(streamId, "inv-dso-ach");

    const pay = await stubFor(streamId).append({
      tenant: TENANT,
      streamId,
      input: inputFor(streamId, { kind: "payment.received", payload: { method: "ach", amount_cents: 120_000, invoice_id: "inv-dso-ach" } }),
    });

    expect((await invoiceRow("inv-dso-ach"))?.status).toBe("paid");
    // An ACH payment posts NO money_line (unchanged) — settlement is a read-model flip, not a money line.
    const lines = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS n FROM money_lines WHERE event_id = ?").bind(pay.id).first<{ n: number }>();
    expect(lines?.n).toBe(0);
  });

  it("PAY-IN-FULL: a partial payment leaves the invoice OPEN (still outstanding AR)", async () => {
    const streamId = "s:dso-partial";
    await issueInvoice(streamId, "inv-dso-partial");
    await stubFor(streamId).append({
      tenant: TENANT,
      streamId,
      input: inputFor(streamId, { kind: "payment.received", payload: { method: "ach", amount_cents: 50_000, invoice_id: "inv-dso-partial" } }),
    });
    expect((await invoiceRow("inv-dso-partial"))?.status).toBe("issued"); // 50_000 < 120_000 -> not settled
  });

  it("DSO-relevant read: open = issued+unpaid is now derivable (paid invoices drop out; the partial stays)", async () => {
    const ids = ["inv-dso-cod", "inv-dso-ach", "inv-dso-partial", "inv-dso-terms"];
    const open = await env.TENANT_A_DB.prepare(
      `SELECT id FROM invoices WHERE id IN (${ids.map(() => "?").join(",")}) AND status = 'issued' AND due_ts IS NOT NULL ORDER BY id`,
    )
      .bind(...ids)
      .all<{ id: string }>();
    // cod + ach settled -> gone; the partial and the never-paid terms invoice remain OPEN, each with a due_ts.
    expect(open.results.map((r) => r.id)).toEqual(["inv-dso-partial", "inv-dso-terms"]);
  });
});
