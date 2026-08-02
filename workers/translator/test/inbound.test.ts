import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "@shuddl/ledger/migrate";
import { EventInput, partyIdForEmail } from "@shuddl/contracts";
import controlSql from "../../../db/control/migrations/0001_control.sql?raw";
import { handleInbound204, StaticSecretResolver, type InboundDeps, type SeqStubLike } from "../src/inbound.js";
import { RecordingTransport } from "../src/transport.js";
import { tenderPrefix } from "../src/sweep-214.js";
import { certifyPartner } from "../src/partners.js";
import { resolveTenantDb } from "../src/tenants.js";
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
function mkTender(opts: { isa?: string; sid?: string | null; bol?: string | null; l11?: Array<[string, string]>; l4?: boolean } = {}): string {
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
  // Extra L11 qualified refs (e.g. [["5000","PO"]] → refs.PO="5000") for the stable-ref-identity/convergence tests.
  for (const [value, qual] of opts.l11 ?? []) parts.push(seg("L11", value, qual));
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
    tenantDbFor: (slug) => resolveTenantDb(env, slug),
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

// The partner's persisted outbound interchange counter (integrations.config.$.outbound.isa) — so a test can
// prove a redelivered 990 does NOT re-allocate a fresh control number. undefined = never allocated.
async function readCounter(db: D1Database, id: string): Promise<number | undefined> {
  const row = await db.prepare("SELECT config FROM integrations WHERE kind='edi_partner' AND id=? LIMIT 1").bind(id).first<{ config: string }>();
  if (row === null) return undefined;
  return (JSON.parse(row.config) as { outbound?: { isa?: number } }).outbound?.isa;
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
  // REQ-203 cert gate: a tender is booked ONLY from a REPLAY-CERTIFIED partner. Certify the partner before each
  // booking test (seeded per-test — isolatedStorage rolls it back). The uncertified proving test revokes it in-test.
  beforeEach(async () => {
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_ID, null, "{}");
    await certifyPartner(env.TENANT_A_DB, PARTNER_ID, "fixtures/edi/roundtrip.json");
  });

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
    // The partner is certified with a fresh counter (beforeEach, config "{}") → the first allocation is
    // "000000001", provably NOT the inbound 204's ISA13.
    const transport = new RecordingTransport();
    const res = await handleInbound204(await signedRequest(tender204("000000042")), makeDeps(new RecordingSeq(), transport, goodSecrets()));
    expect(res.status).toBe(200);
    expect(transport.sent990, "the accepted tender is acknowledged with a 990").toHaveLength(1);
    const isa = transport.sent990[0]!.bytes.split("~")[0]!.split("*")[13];
    expect(isa, "SHUDDL's own first outbound interchange number").toBe("000000001");
    expect(isa, "NOT an echo of the inbound 204's ISA13").not.toBe("000000042");
  });

  // ── REQ-203 CERT GATE — a tender from an authenticated-but-UNCERTIFIED partner is HELD for certification, never
  //    booked. Certification exists precisely to prove a partner's format round-trips BEFORE going live; parsing +
  //    booking against an unverified (possibly wrong) mapping risks a mis-booking, which the zero-risk mandate
  //    forbids. This ALSO answers the 990 cert-gate question: only certified partners ever reach the 990-accept path. ──
  it("(g) an authenticated-but-UNCERTIFIED partner's 204 is QUARANTINED (edi_uncertified_partner): 200, NO shipment, NO appends, NO 990-accept", async () => {
    // Revoke certification for THIS test only (isolatedStorage rolls it back) — the partner is still authenticated.
    await env.TENANT_A_DB.prepare("UPDATE integrations SET cert_status = NULL WHERE kind='edi_partner' AND id = ?").bind(PARTNER_ID).run();
    const seq = new RecordingSeq();
    const transport = new RecordingTransport();
    const res = await handleInbound204(await signedRequest(tender204()), makeDeps(seq, transport, goodSecrets()));
    expect(res.status).toBe(200); // held for certification, never a retry-storm

    // exactly one anomalies row, named the uncertified rule (distinct from a malformed-parse / no-stable-ref quarantine).
    expect(await count(env.TENANT_A_DB, "anomalies")).toBe(1);
    const anomaly = await env.TENANT_A_DB.prepare("SELECT rule FROM anomalies LIMIT 1").first<{ rule: string }>();
    expect(anomaly?.rule).toBe("edi_uncertified_partner");
    // NO booking on an unverified mapping: no shipment, no party, no appends, no 990-accept.
    expect(await count(env.TENANT_A_DB, "shipments"), "no shipment on an unverified mapping").toBe(0);
    expect(await count(env.TENANT_A_DB, "parties")).toBe(0);
    expect(seq.appended, "no appends to the ledger").toHaveLength(0);
    expect(transport.sent990, "no 990-accept for an uncertified partner").toHaveLength(0);
    // the raw bytes are preserved in R2 (never a silent drop — Migrator rule).
    const quarantined = await env.EVIDENCE.list({ prefix: `edi/tenant-a/quarantine/${PARTNER_ID}/` });
    expect(quarantined.objects, "the raw tender is preserved in R2").toHaveLength(1);
  });

  // ── 2026-08-02 §19 (REQ-030/200) — THE TENANT-POLICY PREFLIGHT ──────────────────────────────────────
  //    The sequencer now REFUSES every append for a tenant whose control-plane policy is unusable, and for a
  //    tenant with no control row at all (proceeding on {} silently widens the dims gate, the geofence and —
  //    irreversibly — visibility on append-only events). Without a preflight that refusal surfaces only when
  //    the append throws: a 500, which the VAN retries forever against a DETERMINISTIC condition, while the
  //    persists and the tender marker at step 2 run BEFORE the appends and write straight to tenant D1 — so
  //    each retry accumulates parties, shipments and markers with NO ledger behind them. This handler's own
  //    law is that a deterministic bad document quarantines with a 200; a corrupt control row is exactly as
  //    deterministic as a malformed 204.
  it("(h) an UNUSABLE tenant policy is QUARANTINED (edi_tenant_policy_unusable): 200, NOTHING written, no retry-storm", async () => {
    await env.CONTROL_DB.prepare("UPDATE tenants SET policy = ? WHERE slug = ?").bind("{not json", "tenant-a").run();
    const seq = new RecordingSeq();
    const transport = new RecordingTransport();
    const res = await handleInbound204(await signedRequest(tender204()), makeDeps(seq, transport, goodSecrets()));

    expect(res.status, "deterministic → 200 ACK, never the 5xx a VAN retries forever").toBe(200);
    const anomaly = await env.TENANT_A_DB.prepare("SELECT rule FROM anomalies LIMIT 1").first<{ rule: string }>();
    expect(anomaly?.rule).toBe("edi_tenant_policy_unusable");

    // THE LOAD-BEARING HALF: the preflight runs BEFORE step 2, so no projection outlives the refusal.
    expect(await count(env.TENANT_A_DB, "shipments"), "no shipment without a ledger behind it").toBe(0);
    expect(await count(env.TENANT_A_DB, "parties"), "no party without a ledger behind it").toBe(0);
    expect(seq.appended, "no appends — the sequencer would have refused them anyway").toHaveLength(0);
    expect(transport.sent990, "no 990-accept for a tender that was never booked").toHaveLength(0);
    const markers = await env.EVIDENCE.list({ prefix: "edi/tenant-a/tender/" });
    expect(markers.objects, "no tender marker for a shipment that does not exist").toHaveLength(0);
    // never a silent drop (Migrator rule): the raw bytes are preserved.
    const quarantined = await env.EVIDENCE.list({ prefix: `edi/tenant-a/quarantine/${PARTNER_ID}/` });
    expect(quarantined.objects, "the raw tender is preserved in R2").toHaveLength(1);
  });

  it("(h3) a CLAIMED-POOL tenant that cannot RESOLVE refuses 422, never 5xx — the §19 hole (§29)", async () => {
    // §19 put the policy preflight 36 lines BELOW the tenant-D1 resolution. For a static tenant that is
    // fine (a pure map lookup). For a CLAIMED POOL tenant, tenantDbFor is resolveClaimedTenantDb, which
    // reads the SAME tenants.policy and throws UNKNOWN_TENANT on an unusable one — so the very condition
    // the preflight exists to catch still reached the runtime as a 500, which a VAN retries forever. The
    // §19 test only exercised the static path, which is why it passed while this stayed open.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const seq = new RecordingSeq();
      const deps = makeDeps(seq, new RecordingTransport(), goodSecrets());
      const boom = {
        ...deps,
        tenantDbFor: (): Promise<D1Database> => Promise.reject(new Error("UNKNOWN_TENANT: claimed row policy unusable")),
      };
      const res = await handleInbound204(await signedRequest(tender204()), boom);

      expect(res.status, "deterministic → 4xx, never the 5xx a VAN retries forever").toBe(422);
      expect(res.status, "and specifically not a 5xx").toBeLessThan(500);
      expect(seq.appended, "nothing appended").toHaveLength(0);
      expect(errSpy.mock.calls.flat().some((a) => typeof a === "string" && a.includes("could not be RESOLVED"))).toBe(true);

      // NEVER A SILENT DROP (CLAUDE.md #10). The first cut of this guard returned 422 and discarded the
      // tender — trading a retry-storm for a LOST DOCUMENT, the worse of the two. It cannot write an
      // anomalies row (that needs the tenant D1, which is what failed), but the R2 key is slug-only.
      const preserved = await env.EVIDENCE.list({ prefix: "edi/tenant-a/unresolvable/" });
      expect(preserved.objects, "the raw tender must survive an unresolvable tenant").toHaveLength(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("(h4) a TRANSIENT resolution fault stays RETRIABLE (5xx) — only a deterministic one is 422 (§36)", async () => {
    // The §29 guard caught EVERY throw from tenantDbFor and answered 422. But that call does a live
    // control-plane D1 read, so one blip on a HEALTHY claimed tenant became a PERMANENT refusal (a VAN does
    // not retry a 422) plus a tender preserved only under a prefix nothing enumerates. A lost tender from a
    // network hiccup — the exact failure the guard exists to prevent. Classify by the ERROR, not by where
    // it was thrown: this is the one condition where a VAN retry is the correct answer.
    const seq = new RecordingSeq();
    const deps = makeDeps(seq, new RecordingTransport(), goodSecrets());
    const blip = { ...deps, tenantDbFor: (): Promise<D1Database> => Promise.reject(new Error("D1_ERROR: Network connection lost")) };
    await expect(handleInbound204(await signedRequest(tender204()), blip)).rejects.toThrow(/Network connection lost/);
    expect(seq.appended, "nothing appended on a transient fault").toHaveLength(0);
  });

  it("(h2) a MISSING tenant control row fails closed EARLIER — 401 at auth, nothing written", async () => {
    // Written expecting a quarantine, and corrected to what actually happens. EDI auth resolves the tenant
    // THROUGH the control plane (the pairing names a tenant_id that must join to a tenants row), so a
    // missing row cannot even authenticate — the request 401s before the policy preflight is reached.
    // That is fail-closed a layer earlier than the sequencer refusal, and it means the preflight above
    // covers the case that CAN authenticate: a row that exists and carries an unusable policy.
    await env.CONTROL_DB.prepare("DELETE FROM tenants WHERE slug = ?").bind("tenant-a").run();
    const seq = new RecordingSeq();
    const res = await handleInbound204(await signedRequest(tender204()), makeDeps(seq, new RecordingTransport(), goodSecrets()));
    expect(res.status, "auth cannot resolve a tenant with no control row").toBe(401);
    expect(await count(env.TENANT_A_DB, "shipments"), "nothing written on a 401").toBe(0);
    expect(await count(env.TENANT_A_DB, "anomalies"), "a 401 is not a quarantine — no anomaly row").toBe(0);
    expect(seq.appended).toHaveLength(0);
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

  // ── EXIT-AUDIT F-1 (corrected): convergence is on LOAD-UNIQUE refs (SID/BM/PRO) ONLY. ──
  // PO is order-level, not a convergence key; a PO-only tender that later adds a primary id is treated as distinct
  // (prefer a visible duplicate over a silent drop). Full B2A replace-code convergence is a go-live hardening item
  // (REQ-205). So this {PO:5000} → {PO:5000, SID:9000} case yields TWO shipments (no shared LOAD-UNIQUE ref between
  // the two tenders — the first has no SID; PO does not converge them).
  it("(F-1) a PO-only tender that later re-tenders with a NEW primary id is treated as DISTINCT (PO never converges)", async () => {
    const seq = new RecordingSeq();
    const deps = makeDeps(seq, new RecordingTransport(), goodSecrets());
    await handleInbound204(await signedRequest(mkTender({ sid: null, bol: null, l11: [["5000", "PO"]] })), deps); // {PO:5000}
    await handleInbound204(await signedRequest(mkTender({ isa: "000000777", sid: "9000", bol: null, l11: [["5000", "PO"]] })), deps); // {PO:5000, SID:9000}
    expect(await count(env.TENANT_A_DB, "shipments"), "no shared LOAD-UNIQUE ref → two shipments (PO is not a merge key)").toBe(2);
    const accepted = seq.appended.filter((a) => a.event.kind === "quote.accepted");
    expect(accepted, "each distinct load books (visible duplicate over silent drop)").toHaveLength(2);
  });

  // The corrected-F-1 REGRESSION: the review's over-merge. Two DISTINCT loads (different SID) sharing a PO must
  // BOTH book — converging on the shared PO would silently drop the second (worse than a duplicate). RED before
  // the fix (PO was a convergence key → load B merged into load A).
  it("(F-1-fix) two DISTINCT loads sharing a PO but differing in SID BOTH book (no PO over-merge silent drop)", async () => {
    const seq = new RecordingSeq();
    const deps = makeDeps(seq, new RecordingTransport(), goodSecrets());
    await handleInbound204(await signedRequest(mkTender({ isa: "000000042", sid: "A1", bol: null, l11: [["5000", "PO"]] })), deps); // load A
    await handleInbound204(await signedRequest(mkTender({ isa: "000000777", sid: "B2", bol: null, l11: [["5000", "PO"]] })), deps); // load B
    expect(await count(env.TENANT_A_DB, "shipments"), "distinct SIDs = two loads; a shared PO must NOT merge them").toBe(2);
    expect(seq.appended.filter((a) => a.event.kind === "quote.accepted"), "both loads book — neither silently dropped").toHaveLength(2);
  });

  // PO-only distinct loads: two separate deliveries identified only by the same PO are TWO loads (order-level ref,
  // per-delivery id). RED before the fix (PO-only tenders got one deterministic PO id → the second merged/dropped).
  it("(F-1-fix) two PO-only tenders (distinct deliveries) BOTH book — PO spans many loads, never a silent merge", async () => {
    const seq = new RecordingSeq();
    const deps = makeDeps(seq, new RecordingTransport(), goodSecrets());
    await handleInbound204(await signedRequest(mkTender({ isa: "000000042", sid: null, bol: null, l11: [["5000", "PO"]] })), deps);
    await handleInbound204(await signedRequest(mkTender({ isa: "000000777", sid: null, bol: null, l11: [["5000", "PO"]] })), deps);
    expect(await count(env.TENANT_A_DB, "shipments"), "two distinct PO-only deliveries = two loads (visible duplicate over silent drop)").toBe(2);
    expect(seq.appended.filter((a) => a.event.kind === "quote.accepted")).toHaveLength(2);
  });

  // The TRUE F-1 win preserved: a realistic re-tender sharing a LOAD-UNIQUE SID converges onto ONE shipment/booking
  // (a redelivery under a new interchange that adds a PO must NOT create a second booking). Stays green.
  it("(F-1-fix) a re-tender sharing a load-unique SID converges to ONE shipment/booking (the real F-1 win)", async () => {
    const seq = new RecordingSeq();
    const deps = makeDeps(seq, new RecordingTransport(), goodSecrets());
    await handleInbound204(await signedRequest(mkTender({ isa: "000000042", sid: "9000", bol: null })), deps);
    await handleInbound204(await signedRequest(mkTender({ isa: "000000777", sid: "9000", bol: null, l11: [["5000", "PO"]] })), deps);
    expect(await count(env.TENANT_A_DB, "shipments"), "shared load-unique SID → one shipment").toBe(1);
    expect(seq.appended.filter((a) => a.event.kind === "quote.accepted"), "one booking, not two").toHaveLength(1);
  });

  // AMBIGUITY GUARD: a tender bridging TWO prior shipments (its SID matches load 1, its BM matches load 2 — a data
  // anomaly) must NOT converge onto the wrong one. The guard refuses to merge (mints per its own primary seed),
  // so no distinct prior load is silently absorbed. It lands on its SID seed (load 1), never load 2, and creates
  // no spurious third shipment.
  it("(F-1-fix) an AMBIGUOUS tender bridging two prior shipments does NOT wrong-merge (ambiguity guard)", async () => {
    const seq = new RecordingSeq();
    const deps = makeDeps(seq, new RecordingTransport(), goodSecrets());
    await handleInbound204(await signedRequest(mkTender({ isa: "000000042", sid: "S1", bol: null })), deps); // load 1 (SID:S1)
    await handleInbound204(await signedRequest(mkTender({ isa: "000000043", sid: null, bol: "M2" })), deps); // load 2 (BM:M2)
    expect(await count(env.TENANT_A_DB, "shipments")).toBe(2);
    // A tender carrying BOTH S1 and M2 bridges the two → ambiguous → do NOT converge; it lands on its own SID:S1
    // seed (= load 1), never merges load 2 away, and mints no third shipment.
    await handleInbound204(await signedRequest(mkTender({ isa: "000000044", sid: "S1", bol: "M2" })), deps);
    expect(await count(env.TENANT_A_DB, "shipments"), "the ambiguous bridge does not wrong-merge or spawn a third").toBe(2);
  });

  // ── EXIT-AUDIT F-2 (Low): two DIFFERENT loads sharing a bare ref VALUE across qualifiers must NOT collide. ──
  it("(F-2) SID:5000 and PO:5000 are DISTINCT loads (qualifier-namespaced id, no bare-value collision)", async () => {
    const seq = new RecordingSeq();
    const deps = makeDeps(seq, new RecordingTransport(), goodSecrets());
    await handleInbound204(await signedRequest(mkTender({ sid: "5000", bol: null })), deps); // SID:5000
    await handleInbound204(await signedRequest(mkTender({ sid: null, bol: null, l11: [["5000", "PO"]] })), deps); // PO:5000
    expect(await count(env.TENANT_A_DB, "shipments"), "SID:5000 ≠ PO:5000 — two shipments, not one swallowed").toBe(2);
    // Each redelivery reproduces its OWN qualified id — still two (never three, never merged to one).
    await handleInbound204(await signedRequest(mkTender({ sid: "5000", bol: null })), deps);
    await handleInbound204(await signedRequest(mkTender({ sid: null, bol: null, l11: [["5000", "PO"]] })), deps);
    expect(await count(env.TENANT_A_DB, "shipments")).toBe(2);
  });

  // ── EXIT-AUDIT F-3 (Low): a redelivered accepted 204 must NOT re-send the 990 nor re-allocate a control number. ──
  it("(F-3) a redelivered accepted 204 sends the 990 once and does NOT re-allocate the outbound control number", async () => {
    const transport = new RecordingTransport();
    const deps = makeDeps(new RecordingSeq(), transport, goodSecrets());
    await handleInbound204(await signedRequest(tender204()), deps);
    expect(transport.sent990, "the accepted tender is acknowledged with one 990").toHaveLength(1);
    expect(await readCounter(env.TENANT_A_DB, PARTNER_ID), "one allocation on the first delivery").toBe(1);
    expect((await env.EVIDENCE.list({ prefix: "edi/tenant-a/990/" })).objects, "a 990 ack-dedup marker written on success").toHaveLength(1);

    await handleInbound204(await signedRequest(tender204()), deps); // exact redelivery
    expect(transport.sent990, "no second 990 send").toHaveLength(1);
    expect(await readCounter(env.TENANT_A_DB, PARTNER_ID), "the outbound counter did NOT advance on redelivery").toBe(1);
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
