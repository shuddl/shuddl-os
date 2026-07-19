import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "@shuddl/ledger/migrate";
import { EventInput, partyIdForEmail } from "@shuddl/contracts";
import controlSql from "../../../db/control/migrations/0001_control.sql?raw";
import { handleInbound204, StaticSecretResolver, type InboundDeps, type SeqStubLike } from "../src/inbound.js";
import { RecordingTransport } from "../src/transport.js";
import { tenderPrefix } from "../src/sweep-214.js";
import { tenantDb } from "../src/tenants.js";
import { applyAll, seedEdiPartner } from "./helpers.js";

// WP-12 Task 8 · REQ-201/202 — THE INBOUND 204 HANDLER. A partner load tender authenticates by HMAC (the
// partner's `pairings.secret_ref`, NOT a JWT), parses to a TenderDoc, materializes the party + a QUOTE-STAGE
// shipment, and appends the SAME gated chain a CSR produces — quote.requested → quote.priced → … →
// quote.accepted — THROUGH the cross-script api sequencer DO, stopping AT quote.accepted. It NEVER appends
// booking.created: the UNCHANGED Booking agent does that behind the credit/evidence gates (a broker tender
// with no email/credit → HELD is the gate WORKING). This suite proves the NO-BYPASS invariant end to end,
// driving handleInbound204 with a RecordingSeq that models the DO's dedupe-by-id (mirrors the agents worker
// tests, which drive handleQuoteAccepted with an injected recording seq — the real cross-script DO is a 501
// stub in the pool runtime, so the append chain is asserted through the injected port).

const PARTNER_ID = "partner-acme";
const SECRET_REF = "edi-secret-ref-1";
const SECRET = "edi-shared-secret-do-not-use-in-prod";
const BILL_TO_EMAIL = "ap@gamma.example";
const T0 = Date.UTC(2026, 6, 19, 12, 0);

// ── a complete, PRICEABLE synthetic 204: shipper (Z1 zip) + consignee (Z5 zip) + a bill-to with a PER email,
//    plus an AT8 weight — so the lane prices against the seeded tariff and the chain reaches quote.accepted. ──
function isaHeader(control: string): string {
  const c = control.padStart(9, "0").slice(-9);
  const sender = "MEGA".padEnd(15, " ");
  const receiver = "SHUDDL".padEnd(15, " ");
  const fields = ["ISA", "00", "          ", "00", "          ", "ZZ", sender, "ZZ", receiver, "260719", "1200", "U", "00401", c, "0", "P", ">"];
  return fields.join("*") + "~";
}
function seg(...f: string[]): string {
  return f.join("*") + "~";
}
// A parameterized PRICEABLE synthetic 204: shipper (Z1) + consignee (Z5) + a bill-to PER email + L4 dims + AT8
// weight/pieces. `sid`/`bol` may be omitted (null) to exercise the stable-business-ref identity priority
// (SID → BOL → PRO → PO) and the no-stable-ref quarantine; `l4:false` drops the measurement (no price on air).
function mkTender(opts: { isa?: string; sid?: string | null; bol?: string | null; l4?: boolean } = {}): string {
  const isa = opts.isa ?? "000000042";
  const sid = opts.sid === undefined ? "SHIP123" : opts.sid;
  const bol = opts.bol === undefined ? "BOL987" : opts.bol;
  const l4 = opts.l4 ?? true;
  const parts: string[] = [
    isaHeader(isa),
    seg("GS", "SM", "MEGA", "SHUDDL", "20260719", "1200", "77", "X", "004010"),
    seg("ST", "204", "0001"),
    seg("B2", "", "MEGA", "", sid ?? "", "", "PP"),
    seg("B2A", "00"),
  ];
  if (bol !== null) parts.push(seg("L11", bol, "BM"));
  parts.push(
    seg("N1", "SH", "ACME SHIPPING"),
    seg("N3", "100 DOCK ST"),
    seg("N4", "PORTLAND", "OR", "97035"),
    seg("N1", "CN", "BETA RECEIVING"),
    seg("N3", "200 PORT AVE"),
    seg("N4", "DENVER", "CO", "80012"),
    seg("N1", "BT", "GAMMA BROKERS"),
    seg("N3", "300 FINANCE BLVD"),
    seg("N4", "CHICAGO", "IL", "60601"),
    seg("PER", "BI", "ACCTS", "EM", BILL_TO_EMAIL),
  );
  // L4 measurement (l/w/h inches) + AT8 lading quantity (AT804=40 pieces): the measured physics the rater's "no
  // price on air" gate requires. Dropping L4 → dims UNKNOWN → the tender rests at quote.requested.
  if (l4) parts.push(seg("L4", "48", "40", "60", "IN"));
  parts.push(seg("AT8", "G", "L", "15000", "40"), seg("SE", "18", "0001"), seg("GE", "1", "77"), seg("IEA", "1", isa));
  return parts.join("");
}
function tender204(isa = "000000042"): string {
  return mkTender({ isa });
}

// The SEED-1-shaped synthetic tariff (dest 802xx → Z5 → rg-far). Mirrors workers/api/test/helpers.ts
// TEST_RATE_CONFIG (not importable cross-worker). Both stop zips resolve to a zone with a rate group, so the
// lane PRICES (a priceable tender is what drives the full chain).
const RATE_CONFIG: Array<{ id: string; kind: string; payload: unknown }> = [
  {
    id: "zt-test",
    kind: "zone_tariff",
    payload: {
      kind: "zone_tariff",
      id: "zt-test",
      version: "v1",
      zip_to_zone: { "800": "Z5", "970": "Z1" },
      rate_groups: [
        { id: "rg-near", zones: ["Z1"], breaks: [{ min_lb: 0, cwt_cents: 3800 }, { min_lb: 500, cwt_cents: 3200 }], min_charge_cents: 9500 },
        { id: "rg-far", zones: ["Z5"], breaks: [{ min_lb: 0, cwt_cents: 5200 }, { min_lb: 500, cwt_cents: 4500 }], min_charge_cents: 11500 },
      ],
    },
  },
  { id: "fl-test", kind: "floors", payload: { kind: "floors", id: "fl-test", version: "v1", target_or_bps: 9800, full_cost_bps: 9200, contribution_bps: 8500 } },
  { id: "fsc-test", kind: "fsc", payload: { kind: "fsc", id: "fsc-test", version: "v1", pct_bps: 2400 } },
  { id: "acc-test", kind: "accessorials", payload: { kind: "accessorials", id: "acc-test", version: "v1", items: { liftgate: 3500 } } },
];

async function hmacHex(secret: string, body: string): Promise<string> {
  const data = new TextEncoder().encode(body);
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, buf);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signedRequest(body: string, opts: { partner?: string; signature?: string } = {}): Promise<Request> {
  const signature = opts.signature ?? (await hmacHex(SECRET, body));
  return new Request("https://translator.local/edi/204/inbound", {
    method: "POST",
    headers: {
      "content-type": "application/edi-x12",
      "X-Shuddl-Edi-Partner": opts.partner ?? PARTNER_ID,
      "X-Shuddl-Edi-Signature": signature,
    },
    body,
  });
}

// A RecordingSeq that models the sequencer DO's contract the handler depends on: dedupe by event id (a
// redelivered append returns the ORIGINAL, records nothing new) and Zod-validate the input (EventInput.parse,
// exactly what the DO does), so a malformed append fails the test loudly. It is the ONLY place the append set
// is observed — the no-bypass assertion reads `kinds`.
class RecordingSeq implements SeqStubLike {
  readonly appended: Array<{ tenant: string; streamId: string; event: ReturnType<typeof EventInput.parse> }> = [];
  private readonly byId = new Map<string, ReturnType<typeof EventInput.parse>>();
  async append(req: { tenant: string; streamId: string; input: unknown }): Promise<{ id: string }> {
    const parsed = EventInput.parse(req.input);
    const existing = this.byId.get(parsed.id);
    if (existing !== undefined) return { id: existing.id }; // DO dedupe-by-id: a redelivery is a no-op
    this.byId.set(parsed.id, parsed);
    this.appended.push({ tenant: req.tenant, streamId: req.streamId, event: parsed });
    return { id: parsed.id };
  }
  get kinds(): string[] {
    return this.appended.map((a) => a.event.kind);
  }
}

function makeDeps(seq: SeqStubLike, transport: RecordingTransport, secrets: StaticSecretResolver, now = T0): InboundDeps {
  return {
    controlDb: env.CONTROL_DB,
    tenantDbFor: (slug) => tenantDb(env, slug),
    evidence: env.EVIDENCE,
    seq,
    transport,
    secrets,
    now: () => now,
  };
}

function goodSecrets(): StaticSecretResolver {
  return new StaticSecretResolver({ [SECRET_REF]: SECRET });
}

async function count(db: D1Database, table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  await applyAll(env.TENANT_A_DB);
  const hasTenants = await env.CONTROL_DB.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='tenants'").first();
  if (hasTenants === null) await applyMigrations(env.CONTROL_DB, [{ path: "0001_control.sql", sql: controlSql }]);
  // Base-seed (persists across the isolatedStorage layers): the tenant, the EDI pairing (auth), and the tariff.
  await env.CONTROL_DB.prepare("INSERT OR IGNORE INTO tenants (id, name, slug, plan, policy, created_ts) VALUES (?,?,?,?,?,?)")
    .bind("t-a", "Tenant A", "tenant-a", "pilot", "{}", 0)
    .run();
  await env.CONTROL_DB.prepare("INSERT OR IGNORE INTO pairings (id, tenant_id, kind, scopes, caps, secret_ref, status) VALUES (?,?,?,?,?,?,?)")
    .bind(PARTNER_ID, "t-a", "edi", "[]", "{}", SECRET_REF, "active")
    .run();
  for (const r of RATE_CONFIG) {
    await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO rate_config (id, version, kind, payload, effective_ts, approved_by) VALUES (?,?,?,?,?,?)")
      .bind(r.id, 1, r.kind, JSON.stringify(r.payload), 0, "seed")
      .run();
  }
});

describe("REQ-201/202 — inbound 204 → gated chain, NO booking.created", () => {
  it("(a) a valid 204 → one shipment + one email-keyed party, and the chain quote.requested{edi} → … → quote.accepted with NO booking.created", async () => {
    const seq = new RecordingSeq();
    const res = await handleInbound204(await signedRequest(tender204()), makeDeps(seq, new RecordingTransport(), goodSecrets()));
    expect(res.status).toBe(200);

    // exactly one shipment + one party, the party keyed by the SHARED email matcher (REQ-196 convergence).
    expect(await count(env.TENANT_A_DB, "shipments")).toBe(1);
    expect(await count(env.TENANT_A_DB, "parties")).toBe(1);
    const expectedPartyId = await partyIdForEmail(BILL_TO_EMAIL);
    const party = await env.TENANT_A_DB.prepare("SELECT id, kind FROM parties LIMIT 1").first<{ id: string; kind: string }>();
    expect(party?.id).toBe(expectedPartyId);
    const shipment = await env.TENANT_A_DB
      .prepare("SELECT shipper_party_id AS sh, consignee_party_id AS cn, bill_to_party_id AS bt FROM shipments LIMIT 1")
      .first<{ sh: string; cn: string; bt: string }>();
    expect(shipment).toEqual({ sh: expectedPartyId, cn: expectedPartyId, bt: expectedPartyId });

    // THE NO-BYPASS INVARIANT: the append set stops at quote.accepted; booking.created is NEVER in it.
    const kinds = seq.kinds;
    expect(kinds[0]).toBe("quote.requested");
    expect(kinds).toContain("quote.priced");
    expect(kinds[kinds.length - 1]).toBe("quote.accepted");
    expect(kinds).not.toContain("booking.created");

    // the leading request is EDI-sourced; the accepted quote names the priced event on the stream.
    const requested = seq.appended[0]!.event;
    expect(requested.kind).toBe("quote.requested");
    expect(requested.source).toBe("edi");
    const pricedId = seq.appended.find((a) => a.event.kind === "quote.priced")!.event.id;
    const accepted = seq.appended.find((a) => a.event.kind === "quote.accepted")!.event;
    expect((accepted.payload as { quote_event_id: string }).quote_event_id).toBe(pricedId);
  });

  it("(b) a REDELIVERED 204 (same ISA) → still one shipment, and no duplicate appends (DO dedupe-by-id)", async () => {
    const seq = new RecordingSeq();
    const deps = makeDeps(seq, new RecordingTransport(), goodSecrets());
    await handleInbound204(await signedRequest(tender204()), deps);
    const afterFirst = seq.appended.length;
    expect(await count(env.TENANT_A_DB, "shipments")).toBe(1);

    await handleInbound204(await signedRequest(tender204()), deps); // exact redelivery
    expect(seq.appended.length, "redelivery reproduces the same event ids → no second append").toBe(afterFirst);
    expect(await count(env.TENANT_A_DB, "shipments")).toBe(1);
    expect(await count(env.TENANT_A_DB, "parties")).toBe(1);
  });

  it("(c) a MALFORMED 204 → exactly one anomalies row + the R2 quarantine bytes + HTTP 200, and NO shipment", async () => {
    const seq = new RecordingSeq();
    const bad = "NOT-AN-EDI-DOCUMENT-AT-ALL";
    const res = await handleInbound204(await signedRequest(bad), makeDeps(seq, new RecordingTransport(), goodSecrets()));
    expect(res.status).toBe(200); // ack, never a retry-storm

    expect(await count(env.TENANT_A_DB, "anomalies")).toBe(1);
    expect(await count(env.TENANT_A_DB, "shipments")).toBe(0);
    expect(await count(env.TENANT_A_DB, "parties")).toBe(0);
    expect(seq.appended, "a malformed tender appends NOTHING to the ledger").toHaveLength(0);

    const quarantined = await env.EVIDENCE.list({ prefix: `edi/tenant-a/quarantine/${PARTNER_ID}/` });
    expect(quarantined.objects).toHaveLength(1);
    const obj = await env.EVIDENCE.get(quarantined.objects[0]!.key);
    expect(await obj!.text()).toBe(bad);
  });

  it("(d) a BAD-SECRET POST → 401, and NOTHING is written", async () => {
    const seq = new RecordingSeq();
    const req = await signedRequest(tender204(), { signature: "deadbeef".repeat(8) }); // wrong HMAC
    const res = await handleInbound204(req, makeDeps(seq, new RecordingTransport(), goodSecrets()));
    expect(res.status).toBe(401);

    expect(seq.appended).toHaveLength(0);
    expect(await count(env.TENANT_A_DB, "shipments")).toBe(0);
    expect(await count(env.TENANT_A_DB, "parties")).toBe(0);
    expect(await count(env.TENANT_A_DB, "anomalies")).toBe(0);
    const anyR2 = await env.EVIDENCE.list({ prefix: "edi/tenant-a/" });
    expect(anyR2.objects, "a bad-secret POST writes no R2 objects").toHaveLength(0);
  });

  it("(e) the tender marker edi/<tenant>/tender/<shipmentId> is written with {partnerId, partnerScac, isaControl}", async () => {
    const seq = new RecordingSeq();
    await handleInbound204(await signedRequest(tender204()), makeDeps(seq, new RecordingTransport(), goodSecrets()));

    const markers = await env.EVIDENCE.list({ prefix: tenderPrefix("tenant-a") });
    expect(markers.objects).toHaveLength(1);
    const marker = await env.EVIDENCE.get(markers.objects[0]!.key);
    expect(JSON.parse(await marker!.text())).toEqual({ partnerId: PARTNER_ID, partnerScac: "MEGA", isaControl: "000000042" });
  });

  it("(f) the 990 acknowledgment carries SHUDDL's ALLOCATED outbound control number, NOT the inbound 204's ISA13 (Task 9)", async () => {
    // Seed the partner's integrations row (the outbound-counter store) in tenant-A — id = the pairing id the
    // handler authenticates. A fresh counter → the first allocation is "000000001", provably NOT the inbound ISA.
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_ID, "certified");
    const transport = new RecordingTransport();
    const res = await handleInbound204(await signedRequest(tender204("000000042")), makeDeps(new RecordingSeq(), transport, goodSecrets()));
    expect(res.status).toBe(200);
    expect(transport.sent990, "the accepted tender is acknowledged with a 990").toHaveLength(1);
    const isa = transport.sent990[0]!.bytes.split("~")[0]!.split("*")[13];
    expect(isa, "SHUDDL's own first outbound interchange number").toBe("000000001");
    expect(isa, "NOT an echo of the inbound 204's ISA13").not.toBe("000000042");
  });

  it("a DIMS-LESS tender rests at quote.requested (no price on air) — no quote.priced, no quote.accepted, no bypass", async () => {
    // Drop the L4 measurement → the rater's dims gate returns UNKNOWN → the handler records the tender (shipment +
    // quote.requested) but appends NO price/accept. The Booking agent is never triggered.
    const noDims = mkTender({ l4: false });
    const seq = new RecordingSeq();
    const res = await handleInbound204(await signedRequest(noDims), makeDeps(seq, new RecordingTransport(), goodSecrets()));
    expect(res.status).toBe(200);
    expect(await count(env.TENANT_A_DB, "shipments")).toBe(1); // the tender IS recorded
    expect(seq.kinds).toEqual(["quote.requested"]); // …but rests here — no price on air (CLAUDE.md #4)
    expect(seq.kinds).not.toContain("quote.accepted");
    expect(seq.kinds).not.toContain("booking.created");
  });

  it("an unknown/inactive partner id → 401 (fail-closed), nothing written", async () => {
    const seq = new RecordingSeq();
    const res = await handleInbound204(await signedRequest(tender204(), { partner: "partner-nope" }), makeDeps(seq, new RecordingTransport(), goodSecrets()));
    expect(res.status).toBe(401);
    expect(seq.appended).toHaveLength(0);
    expect(await count(env.TENANT_A_DB, "shipments")).toBe(0);
  });

  // ── Finding 1 (Medium): a no-SID tender must key its identity off a STABLE business ref (SID→BOL→PRO→PO),
  //    NEVER the per-interchange ISA13 (which differs per redelivery → two streams → two bookings → duplicate
  //    freight commitment; REQ-191 one-booking-per-stream fires only WITHIN a stream). ──
  it("(1a) a no-SID tender sent under TWO different ISA13 collapses to ONE shipment via its BOL (no ISA13 dup)", async () => {
    const seq = new RecordingSeq();
    const deps = makeDeps(seq, new RecordingTransport(), goodSecrets());
    // Same BOL, DIFFERENT interchange controls — normal per-interchange behavior.
    await handleInbound204(await signedRequest(mkTender({ isa: "000000042", sid: null, bol: "BOL-STABLE-1" })), deps);
    await handleInbound204(await signedRequest(mkTender({ isa: "000000777", sid: null, bol: "BOL-STABLE-1" })), deps);
    expect(await count(env.TENANT_A_DB, "shipments"), "one physical load = one shipment, regardless of ISA13").toBe(1);
    // Idempotent via the stable BOL: the second interchange reproduces the same event ids → no second append set.
    const acceptedCount = seq.appended.filter((a) => a.event.kind === "quote.accepted").length;
    expect(acceptedCount, "one booking-triggering acceptance, not two").toBe(1);
  });

  it("(1b) a priceable 204 carrying NO SID/BOL/PRO/PO is QUARANTINED (no stable id) — no shipment, no appends", async () => {
    const seq = new RecordingSeq();
    const res = await handleInbound204(await signedRequest(mkTender({ sid: null, bol: null })), makeDeps(seq, new RecordingTransport(), goodSecrets()));
    expect(res.status).toBe(200); // ack, never a retry-storm
    expect(await count(env.TENANT_A_DB, "anomalies")).toBe(1);
    expect(await count(env.TENANT_A_DB, "shipments"), "a tender with no stable ref mints NO id → NO shipment").toBe(0);
    expect(seq.appended, "and appends NOTHING to the ledger").toHaveLength(0);
    // The anomaly names the no-shipment-ref rule (distinct from a malformed-parse quarantine).
    const anomaly = await env.TENANT_A_DB.prepare("SELECT rule FROM anomalies LIMIT 1").first<{ rule: string }>();
    expect(anomaly?.rule).toBe("edi_no_shipment_ref");
    const quarantined = await env.EVIDENCE.list({ prefix: `edi/tenant-a/quarantine/${PARTNER_ID}/` });
    expect(quarantined.objects, "the raw bytes are preserved in R2 (never a silent drop)").toHaveLength(1);
  });

  // ── Finding 3 (Low): a storage-DoS cap — an over-cap body is rejected 413 BEFORE any read/persist. ──
  it("(3) an over-cap POST → 413, nothing written (no shipment, no anomaly, no R2)", async () => {
    const seq = new RecordingSeq();
    const huge = "A".repeat(1_048_576 + 1); // > 1 MB
    const res = await handleInbound204(await signedRequest(huge, { signature: "00" }), makeDeps(seq, new RecordingTransport(), goodSecrets()));
    expect(res.status).toBe(413);
    expect(seq.appended).toHaveLength(0);
    expect(await count(env.TENANT_A_DB, "shipments")).toBe(0);
    expect(await count(env.TENANT_A_DB, "anomalies")).toBe(0);
    expect((await env.EVIDENCE.list({ prefix: "edi/tenant-a/" })).objects).toHaveLength(0);
  });
});
