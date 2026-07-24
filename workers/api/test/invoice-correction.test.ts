import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { eventFixture, type Visibility } from "@shuddl/contracts";
import { eventToRow } from "@shuddl/ledger/lens";
import type { AppendedEvent } from "../src/do/sequencer.js";
import { TENANT_SLUG, ensureSchema, ensureTenantBSchema } from "./helpers.js";

// ─── Task 8 (REQ-015 / I7) — INVOICE-CORRECTION VISIBILITY FAILS CLOSED ─────────────────────────────────
//
// invoice.corrected INHERITS the visibility of the invoice.issued (or prior invoice.corrected) it nets against,
// so an I7 correction stays inside the parent's EXACT lens. The bug: an unresolved parent (missing / wrong-kind
// / cross-stream / cross-tenant reference) used to FALL BACK to the counterparty default — surfacing a phantom
// negative charge in a lens the original never appeared in. The fix resolves the parent by STREAM + KIND and
// REJECTS (VALIDATION_FAILED, ZERO append) when it cannot; only an exact parent yields a visibility.
//
// VENUE: the real ShipmentSequencer DO + migrated tenant D1. isolatedStorage is OFF (shared D1) — every case
// scopes to its OWN stream ids. invoice.corrected is server-emitted, so it is appended through the DO stub
// directly (never the public events route, which refuses server-emitted kinds).

const TENANT = TENANT_SLUG;
const HEX64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const GEO = { lat_e6: 37_421_000, lon_e6: -122_084_000 };

type SeqStub = DurableObjectStub & { append(req: { tenant: string; streamId: string; input: unknown }): Promise<AppendedEvent> };
function stubFor(tenant: string, streamId: string): SeqStub {
  return env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${tenant}|${streamId}`)) as unknown as SeqStub;
}

function baseInput(shipmentId: string, over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: 1_720_000_000_000,
    actor: { party: "party-shipper" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    ...over,
  };
}

// Drive a stream to a committed invoice.issued (pod.signed satisfies the I2 gate) and return the invoice event id.
async function seedIssuedInvoice(shipmentId: string, requested?: Visibility): Promise<string> {
  const stub = stubFor(TENANT, `s:${shipmentId}`);
  await stub.append({ tenant: TENANT, streamId: `s:${shipmentId}`, input: baseInput(shipmentId, { kind: "pod.signed", payload: { signature_hash: HEX64, geo: GEO, unwitnessed: true } }) });
  const inv = await stub.append({
    tenant: TENANT,
    streamId: `s:${shipmentId}`,
    input: baseInput(shipmentId, {
      kind: "invoice.issued",
      ...(requested !== undefined ? { requested_visibility: requested } : {}),
      payload: { invoice_id: `inv-${shipmentId}`, party_id: "party-bill-to", division: "main", lines: [{ line_no: 1, kind: "freight", amount_cents: 120_000, gl_map: "4000-REV" }] },
    }),
  });
  return inv.id;
}

// A void invoice.corrected (reissue_lines: []) naming `correctsEventId`.
function correctionInput(shipmentId: string, correctsEventId: string): Record<string, unknown> {
  return baseInput(shipmentId, {
    kind: "invoice.corrected",
    payload: { invoice_id: `inv-${shipmentId}-c`, corrects_event_id: correctsEventId, reason: "reweigh correction", reissue_lines: [] },
  });
}

// Direct-seed a bare invoice.issued EVENT (no money projection) on a stream in `db` — enough for its id to
// EXIST on another stream/tenant, for the cross-stream / cross-tenant rejection cases.
const randomHex64 = (): string => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
async function seedBareIssued(db: D1Database, shipmentId: string): Promise<string> {
  const id = crypto.randomUUID();
  const e = eventFixture("invoice.issued", { id, stream_id: `s:${shipmentId}`, shipment_id: shipmentId, seq: 0, visibility: "counterparty", party_refs: [] });
  const row = eventToRow(e);
  row.hash = randomHex64();
  const cols = Object.keys(row);
  await db.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...cols.map((c) => row[c])).run();
  return id;
}

async function eventCount(shipmentId: string): Promise<number> {
  const r = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS n FROM events WHERE stream_id = ?").bind(`s:${shipmentId}`).first<{ n: number }>();
  return r?.n ?? 0;
}
async function correctionCount(shipmentId: string): Promise<number> {
  const r = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS n FROM events WHERE stream_id = ? AND kind = 'invoice.corrected'").bind(`s:${shipmentId}`).first<{ n: number }>();
  return r?.n ?? 0;
}
async function moneyLineCount(shipmentId: string): Promise<number> {
  const r = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS n FROM money_lines WHERE shipment_id = ?").bind(shipmentId).first<{ n: number }>();
  return r?.n ?? 0;
}
async function invoiceRowCount(shipmentId: string): Promise<number> {
  const r = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS n FROM invoices WHERE id LIKE ?").bind(`inv-${shipmentId}%`).first<{ n: number }>();
  return r?.n ?? 0;
}
async function visibilityOf(shipmentId: string, kind: string): Promise<string | null> {
  const r = await env.TENANT_A_DB.prepare("SELECT visibility FROM events WHERE stream_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1").bind(`s:${shipmentId}`, kind).first<{ visibility: string }>();
  return r?.visibility ?? null;
}

beforeAll(async () => {
  await ensureSchema(env);
});

describe("Task 8 — invoice.corrected inherits its parent's EXACT visibility (REQ-015 / I7)", () => {
  it("a COUNTERPARTY original → the correction inherits counterparty", async () => {
    const shp = "ic-counterparty";
    const issuedId = await seedIssuedInvoice(shp); // default counterparty
    expect(await visibilityOf(shp, "invoice.issued")).toBe("counterparty");
    const c = await stubFor(TENANT, `s:${shp}`).append({ tenant: TENANT, streamId: `s:${shp}`, input: correctionInput(shp, issuedId) });
    expect(c.visibility).toBe("counterparty");
    expect(await visibilityOf(shp, "invoice.corrected")).toBe("counterparty");
  });

  it("an INTERNAL original → the correction inherits internal (never a widened default)", async () => {
    const shp = "ic-internal";
    const issuedId = await seedIssuedInvoice(shp, "internal"); // narrowed to internal at issue
    expect(await visibilityOf(shp, "invoice.issued")).toBe("internal");
    const c = await stubFor(TENANT, `s:${shp}`).append({ tenant: TENANT, streamId: `s:${shp}`, input: correctionInput(shp, issuedId) });
    expect(c.visibility).toBe("internal");
    expect(await visibilityOf(shp, "invoice.corrected")).toBe("internal");
  });
});

describe("Task 8 — an unresolved correction parent FAILS CLOSED (VALIDATION_FAILED, zero effects)", () => {
  it("MISSING original → rejected; events/corrections/money/invoices unchanged", async () => {
    const shp = "ic-missing";
    const before = await eventCount(shp);
    await expect(
      stubFor(TENANT, `s:${shp}`).append({ tenant: TENANT, streamId: `s:${shp}`, input: correctionInput(shp, crypto.randomUUID()) }),
    ).rejects.toThrow(/VALIDATION_FAILED/);
    expect(await eventCount(shp)).toBe(before);
    expect(await correctionCount(shp)).toBe(0);
    expect(await moneyLineCount(shp)).toBe(0);
    expect(await invoiceRowCount(shp)).toBe(0);
  });

  it("WRONG-KIND original (corrects_event_id names a non-invoice event on the stream) → rejected, zero append", async () => {
    const shp = "ic-wrongkind";
    // A real on-stream event that is NOT an invoice (a pod.signed), then a correction pointing at it.
    const pod = await stubFor(TENANT, `s:${shp}`).append({ tenant: TENANT, streamId: `s:${shp}`, input: baseInput(shp, { kind: "pod.signed", payload: { signature_hash: HEX64, geo: GEO, unwitnessed: true } }) });
    const before = await eventCount(shp);
    await expect(
      stubFor(TENANT, `s:${shp}`).append({ tenant: TENANT, streamId: `s:${shp}`, input: correctionInput(shp, pod.id) }),
    ).rejects.toThrow(/VALIDATION_FAILED/);
    expect(await eventCount(shp)).toBe(before); // no correction appended
    expect(await correctionCount(shp)).toBe(0);
    expect(await moneyLineCount(shp)).toBe(0);
  });

  it("CROSS-STREAM original (the invoice.issued lives on a DIFFERENT stream, same tenant) → rejected, zero append", async () => {
    const other = "ic-xstream-parent";
    const foreignId = await seedBareIssued(env.TENANT_A_DB, other); // a real invoice.issued id, but on `other`
    const shp = "ic-xstream";
    const before = await eventCount(shp);
    await expect(
      stubFor(TENANT, `s:${shp}`).append({ tenant: TENANT, streamId: `s:${shp}`, input: correctionInput(shp, foreignId) }),
    ).rejects.toThrow(/VALIDATION_FAILED/);
    expect(await eventCount(shp)).toBe(before);
    expect(await correctionCount(shp)).toBe(0);
  });

  it("CROSS-TENANT original (the invoice.issued id exists only in tenant B) → rejected, zero append (REQ-025)", async () => {
    await ensureTenantBSchema(env);
    const foreignId = await seedBareIssued(env.TENANT_B_DB, "ic-xtenant-parent"); // exists ONLY in tenant B
    const shp = "ic-xtenant";
    const before = await eventCount(shp);
    await expect(
      stubFor(TENANT, `s:${shp}`).append({ tenant: TENANT, streamId: `s:${shp}`, input: correctionInput(shp, foreignId) }),
    ).rejects.toThrow(/VALIDATION_FAILED/);
    expect(await eventCount(shp)).toBe(before);
    expect(await correctionCount(shp)).toBe(0);
  });
});
