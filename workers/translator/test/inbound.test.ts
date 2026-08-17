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
  /** §1374 — how many times append was CALLED, which `appended.length` cannot show. */
  calls = 0;
  readonly appended: Array<{ tenant: string; streamId: string; event: ReturnType<typeof EventInput.parse> }> = [];
  private readonly byId = new Map<string, ReturnType<typeof EventInput.parse>>();
  async append(req: { tenant: string; streamId: string; input: unknown }): Promise<{ id: string }> {
    const parsed = EventInput.parse(req.input);
    const existing = this.byId.get(parsed.id);
    this.calls += 1; // §1374 — CALLS, not rows: the DO dedupe saves the ROW, never the subrequest that reached it.
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

    // THE NO-BYPASS INVARIANT — asserted as the EXHAUSTIVE chain, not as endpoints (audit §773).
    //
    // This read `kinds[0] === quote.requested` + `toContain("quote.priced")` + `last === quote.accepted` +
    // `not.toContain("booking.created")`. Those four pin the ENDS and TWO named members, and the module header
    // states the append set is {quote.requested, quote.priced, agent.acted, approval.requested?, quote.accepted}
    // — so a MISSING middle append and an EXTRA middle append were both invisible. Measured, not supposed:
    // deleting the agent.acted append left this suite 116/116 GREEN, and forcing an unconditional extra append
    // did too. `not.toContain` catches only the kind you already thought to name; the whole point of a bypass is
    // that it is a kind nobody named. `toEqual` on the sequence is the assertion that cannot be evaded — it
    // fails on any kind that is missing, extra, or out of order, including booking.created.
    //
    // The below-floor variant of this chain (with approval.requested spliced before quote.accepted) is pinned
    // by its own test below; the default tariff clears its floors, so this fixture's chain has four members.
    expect(seq.kinds).toEqual(["quote.requested", "quote.priced", "agent.acted", "quote.accepted"]);

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
    // §1374 — the assertion above is about ROWS; this one is about WORK. A redelivered 204 re-derives every
    // event and still CALLS the sequencer for each, because idempotence is enforced at the DO — downstream of
    // the subrequest. `appended.length` cannot show that, because this double collapses repeats (§1373 found
    // the same double hiding the same quantity in mirror-sweep). Bounded here — one message, a handful of
    // events — so this pins the cost rather than filing a hazard.
    expect(seq.calls, "a redelivery did no sequencer work at all — then the dedupe moved upstream of the DO").toBeGreaterThan(afterFirst);
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

  // (c2) §1539 (REQ-202/030) — A RESOLVED QUARANTINE MUST REOPEN WHEN THE DOCUMENT IS STILL BAD.
  //
  // `anomalies` has two writers with different recurrence semantics. Watchtower's raiseAlarm is an upsert that
  // sets `status = 'open'` ON CONFLICT, and its clearAlarm comment states the property outright: *"a re-raise
  // flips it back"*. The quarantine path used a plain INSERT OR IGNORE, which cannot flip anything — so once an
  // operator cleared the row, every later redelivery of the SAME still-broken interchange was swallowed in
  // silence. `status = 'open'` is the filter on all three ops reads of this table (the watchtower route, the
  // sequencer's gate probe, the credit sweep), so the failure is invisible exactly where it is looked for while
  // the handler keeps answering 200 "quarantined" — a fail-open on an ops surface, in the row that exists to
  // satisfy rule 10's no-silent-drop law.
  //
  // The collapse-to-ONE-row property (a deterministic id per partner + ISA control) is DELIBERATE, and is
  // asserted here beside the reopen because the fix must keep it: one row, reopened — never a second row.
  it("(c2) a RESOLVED quarantine REOPENS when the same malformed interchange redelivers, still as ONE row", async () => {
    const bad = "NOT-AN-EDI-DOCUMENT-AT-ALL";
    const first = await handleInbound204(await signedRequest(bad), makeDeps(new RecordingSeq(), new RecordingTransport(), goodSecrets()));
    expect(first.status).toBe(200);
    const row = await env.TENANT_A_DB.prepare("SELECT id FROM anomalies LIMIT 1").first<{ id: string }>();
    expect(row?.id, "no anomaly was raised — this case cannot test a reopen").toBeDefined();

    // An operator clears it — byte-identical to watchtower's clearAlarm, the only clear this table has.
    await env.TENANT_A_DB.prepare("UPDATE anomalies SET status = 'resolved' WHERE id = ?").bind(row!.id).run();

    // The partner redelivers the SAME interchange. Nothing was fixed; the document is still unparseable.
    const again = await handleInbound204(await signedRequest(bad), makeDeps(new RecordingSeq(), new RecordingTransport(), goodSecrets()));
    expect(again.status).toBe(200);

    expect(await count(env.TENANT_A_DB, "anomalies"), "a redelivery forked a second row — the deterministic id stopped collapsing").toBe(1);
    const after = await env.TENANT_A_DB.prepare("SELECT status FROM anomalies WHERE id = ?").bind(row!.id).first<{ status: string }>();
    expect(
      after?.status,
      "a still-failing document sits behind a 'resolved' anomaly — every ops read of this table filters " +
        "status = 'open', so the operator sees nothing while documents keep quarantining",
    ).toBe("open");
  });

  // §1282 — THE OTHER FOUR REFUSALS. `authenticate()` has FIVE fail-closed exits and every one returns `null`,
  // so a test asserting 401 cannot tell which fired. Measured: only the HMAC comparison was pinned — dropping
  // `p.kind = 'edi'`, dropping `p.status = 'active'`, allowing an empty secret, and allowing an empty header
  // each left workers/translator at 124/124 GREEN. The same two predicates ARE pinned on the MCP boundary
  // (§1265, `resolveActiveMcpPairing`): one rule, two boundaries, defended at one of them.
  //
  // The fixtures below differ from the PASSING request in exactly one column. Same body, same secret_ref, same
  // HMAC — so a 401 can only come from the predicate under test, which is what the shared-`null` exits
  // otherwise make impossible to attribute.
  it("§1282: a REVOKED edi pairing → 401, even with a perfectly valid signature", async () => {
    await env.CONTROL_DB.prepare("INSERT OR IGNORE INTO pairings (id, tenant_id, kind, scopes, caps, secret_ref, status) VALUES (?,?,?,?,?,?,?)")
      .bind("partner-revoked", "t-a", "edi", "[]", "{}", SECRET_REF, "revoked")
      .run();
    const body = tender204();
    const req = await signedRequest(body, { partner: "partner-revoked", signature: await hmacHex(SECRET, body) });
    const res = await handleInbound204(req, makeDeps(new RecordingSeq(), new RecordingTransport(), goodSecrets()));
    expect(res.status, "revocation must refuse a correctly-signed request").toBe(401);
  });

  it("§1282: a NON-EDI pairing (kind='mcp') → 401, even active and correctly signed", async () => {
    await env.CONTROL_DB.prepare("INSERT OR IGNORE INTO pairings (id, tenant_id, kind, scopes, caps, secret_ref, status) VALUES (?,?,?,?,?,?,?)")
      .bind("partner-mcp", "t-a", "mcp", "[]", "{}", SECRET_REF, "active")
      .run();
    const body = tender204();
    const req = await signedRequest(body, { partner: "partner-mcp", signature: await hmacHex(SECRET, body) });
    const res = await handleInbound204(req, makeDeps(new RecordingSeq(), new RecordingTransport(), goodSecrets()));
    expect(res.status, "an mcp/api pairing must not authenticate on the EDI seam").toBe(401);
  });

  // The EMPTY-SECRET exit, with my first hypothesis CORRECTED by the runtime. I assumed a "" secret made the
  // expected HMAC `hmac("", body)` — computable by anyone, so a forgeable shared secret. It is not: WebCrypto
  // REFUSES a zero-length HMAC key (`DataError: Imported HMAC key length (0)`), which is what the first draft
  // of this test hit while trying to sign with it. So an empty secret cannot be used to forge — it makes
  // `hmacHex` THROW.
  //
  // That makes the guard's real job turning a 500 into a clean 401 on an operational fault (a rotated-away or
  // unset secret), which is §1281's charset-guard shape: the refusal happens either way, but one path is an
  // uncaught throw. The discriminating request therefore carries ANY well-formed signature and asserts the
  // STATUS is 401 — with the guard removed, `hmacHex` throws before any comparison.
  it("§1282: a pairing whose secret resolves to EMPTY is a clean 401, never a throw", async () => {
    await env.CONTROL_DB.prepare("INSERT OR IGNORE INTO pairings (id, tenant_id, kind, scopes, caps, secret_ref, status) VALUES (?,?,?,?,?,?,?)")
      .bind("partner-nosecret", "t-a", "edi", "[]", "{}", "ref-empty", "active")
      .run();
    const body = tender204();
    const secrets = new StaticSecretResolver({ [SECRET_REF]: SECRET, "ref-empty": "" });
    const req = await signedRequest(body, { partner: "partner-nosecret", signature: await hmacHex(SECRET, body) });
    const res = await handleInbound204(req, makeDeps(new RecordingSeq(), new RecordingTransport(), secrets));
    expect(res.status, "an unresolvable secret must refuse cleanly, not fault").toBe(401);
  });
  it("§1282: an EMPTY partner header → 401 (empty is not merely 'present')", async () => {
    const body = tender204();
    const req = await signedRequest(body, { partner: "", signature: await hmacHex(SECRET, body) });
    const res = await handleInbound204(req, makeDeps(new RecordingSeq(), new RecordingTransport(), goodSecrets()));
    expect(res.status).toBe(401);
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

  it("§1676 (h3b) when preserving the unresolvable tender FAILS, the log must not claim it was preserved", async () => {
    // The refusal is best-effort about the bytes and deliberate about the status: an R2 fault must not turn a
    // deterministic 422 into a 5xx retry-storm. What it must not do is LIE about the outcome. The claim and
    // the catch print one line apart, and an operator reading "could not preserve X" followed by "is
    // preserved at X" has to guess which one is true — during the incident where the answer decides whether
    // the document still exists anywhere.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const seq = new RecordingSeq();
      const deps = makeDeps(seq, new RecordingTransport(), goodSecrets());
      const boom = {
        ...deps,
        tenantDbFor: (): Promise<D1Database> => Promise.reject(new Error("UNKNOWN_TENANT: claimed row policy unusable")),
        evidence: { ...deps.evidence, put: (): Promise<never> => Promise.reject(new Error("R2 unavailable")) } as unknown as R2Bucket,
      };
      const res = await handleInbound204(await signedRequest(tender204()), boom);

      expect(res.status, "an R2 fault must NOT convert the deterministic refusal into a retriable 5xx").toBe(422);
      const logged = errSpy.mock.calls.flat().filter((a): a is string => typeof a === "string");
      expect(logged.some((s) => s.includes("could not preserve")), "the failure itself is still reported").toBe(true);
      expect(
        logged.some((s) => s.includes("is preserved at")),
        "THE ASSERTION: nothing may claim the tender was preserved when the put threw — the operator acts on this line",
      ).toBe(false);
      expect(logged.some((s) => s.includes("NOT preserved")), "and the truthful outcome is stated positively").toBe(true);
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

  it("a 204 CANNOT reach the approval.requested branch — even at the schema's MAXIMUM floors (§773)", async () => {
    // §773. `handleInbound204` carries a below-floor recording branch (REQ-030/048, the ops-approval queue).
    // NO test had ever entered it — proved, not assumed: a probe that THREW inside
    // `if (decision.approval !== "none")` left this suite 116/116 GREEN.
    //
    // The reason turned out NOT to be a weak fixture. The branch is UNREACHABLE THROUGH THIS DOOR by
    // construction, and the three facts that make it so are each pinned elsewhere:
    //
    //   1. `costBasis(freight, config) === freight.freight_cents` (rater/price.ts) — the cost basis IS the
    //      linehaul freight, nothing more.
    //   2. every floor is `cost x bps / 10000` with `bps <= 10000` (FloorsConfig's schema max), so
    //      `target <= cost` — ALWAYS.
    //   3. `compose` only ever pushes POSITIVE lines (I7: an amount_cents is a positive charge; a credit is
    //      its own kind, never a negative), so `sell = freight + fsc + accessorials >= freight === cost`.
    //
    // Therefore `sell >= cost >= target` and `evaluateApproval` returns "none" for every valid tariff. The
    // only way under a floor is a NEGOTIATED sell below the list price (`proposedSellCents`), and a 204
    // carries none — which is exactly why this handler calls `assessApproval(quote, {})` with no opts. The
    // CSR path reaches the same branch through the rep's negotiated price and pins it in
    // `workers/api/test/approvals.test.ts`; the EDI path structurally cannot.
    //
    // So the branch is correct DEFENSIVE code, not dead weight to delete: `costBasis`'s own comment marks it
    // as "the future multi-factor surface plugs in there", and the day cost stops equalling freight, a 204
    // CAN land below target and the branch goes live UNTESTED.
    //
    // THIS TEST IS THAT TRIPWIRE. It drives the handler at the strongest below-floor pressure the schema
    // permits — all three floors at 100% of cost — and asserts the chain is still FOUR members. It fails the
    // day any of facts 1-3 changes, and its failure means: the approval branch just became reachable over
    // EDI, go write its behavioural test. A prose reopen-trigger cannot do that (§750: a comment naming its
    // own falsification is a check; one merely explaining a hazard is a reason).
    await env.TENANT_A_DB.prepare(
      "INSERT OR REPLACE INTO rate_config (id, version, kind, payload, effective_ts, approved_by) VALUES (?,?,?,?,?,?)",
    )
      .bind(
        "fl-test",
        1,
        "floors",
        JSON.stringify({ kind: "floors", id: "fl-test", version: "v1", target_or_bps: 10_000, full_cost_bps: 10_000, contribution_bps: 10_000 }),
        0,
        "seed",
      )
      .run();

    const seq = new RecordingSeq();
    const res = await handleInbound204(await signedRequest(tender204()), makeDeps(seq, new RecordingTransport(), goodSecrets()));
    expect(res.status).toBe(200);
    // Asserted as the ABSENCE of the one kind this test is about, NOT as the whole chain. The first cut used
    // `toEqual([...four kinds])` and duplicated (a)'s exhaustive assertion — so deleting the UNRELATED
    // agent.acted append made this test red too, reporting "the approval branch became reachable" about a
    // mutation that did nothing of the sort. A gate that fires for a reason other than its own subject is a
    // misattribution engine (audit §"attribute the RED"); scope it to what it actually watches.
    expect(
      seq.kinds,
      "a 204 reached the approval branch — cost/floors/compose changed, so the below-floor recording is now LIVE over EDI and needs its own behavioural test (it has never had one)",
    ).not.toContain("approval.requested");

    // Non-vacuity, and the arithmetic the claim above rests on: the tender really did PRICE (an UNKNOWN would
    // rest at quote.requested and satisfy nothing), and its sell really is at-or-above the maximum floor.
    const priced = seq.appended.find((a) => a.event.kind === "quote.priced")!.event;
    const pp = priced.payload as { sell: number; floors: { contribution: number; full: number; target: number }; basis: { cost_cents: number } };
    expect(pp.sell).toBeGreaterThan(0);
    expect(pp.floors.target, "floors are cost-relative and bps <= 10000 — the target can never exceed the cost basis").toBe(pp.basis.cost_cents);
    expect(pp.sell, "sell = freight + only-positive lines, and cost === freight — so the sell can never fall under").toBeGreaterThanOrEqual(pp.floors.target);
  });

  // ── §795 — A KNOWN GAP, PINNED. This test asserts behaviour that is WRONG, on purpose. ──────────────────
  //
  // X12 B2A01 carries the tender's purpose: 00 = original, 01 = CANCELLATION, 04 = change, 05 = replace.
  // `parse-204.ts` reads it, types it (`z.enum(["00","01"])`) and puts it on the TenderDoc — and then
  // **nothing in workers/translator ever reads `doc.purpose`** (measured: zero consumers in src; every
  // existing fixture uses "00"). So a partner's CANCELLATION is understood and then booked like any other
  // load: 200, the full gated chain, one shipment, and — the part that stings — ZERO anomalies. In
  // production the committed quote.accepted enqueues the Booking agent, so SHUDDL commits freight the
  // partner explicitly cancelled, with no signal anywhere.
  //
  // WHY THIS IS NOT FIXED HERE: cancellation handling is not in the register. REQ-205 covers the 04/05
  // REVISION case only (a PO-only re-tender yielding a visible duplicate), and CLAUDE.md rule 1 is explicit
  // — if it isn't a REQ row, it doesn't get built. The proposed row is recorded in the audit (§795) and the
  // GO-LIVE-CHECKLIST hold now names this case, which it previously did not.
  //
  // WHAT THIS TEST IS FOR: it is a TRIPWIRE, not an endorsement. The day `purpose` gains a consumer, this
  // reds — and whoever wired it must update the checklist row and delete this test. A gap described only in
  // prose is a gap nobody is watching (§792); this makes the suite state it out loud.
  it("§795 GAP: a B2A*01 CANCELLATION is booked like an original — parsed, ignored, and NOT anomalied", async () => {
    const cancel = mkTender({}).replace("B2A*00~", "B2A*01~");
    expect(cancel, "the fixture no longer carries a B2A segment — this test stopped testing its subject").toContain("B2A*01~");

    const seq = new RecordingSeq();
    const res = await handleInbound204(await signedRequest(cancel), makeDeps(seq, new RecordingTransport(), goodSecrets()));

    expect(res.status).toBe(200);
    // The SAME chain an original tender produces — the cancellation changes nothing.
    expect(seq.kinds, "if this no longer matches the original-tender chain, purpose is being consumed — see the header").toEqual([
      "quote.requested",
      "quote.priced",
      "agent.acted",
      "quote.accepted",
    ]);
    expect(await count(env.TENANT_A_DB, "shipments")).toBe(1);
    expect(
      await count(env.TENANT_A_DB, "anomalies"),
      "a cancellation now raises an anomaly — the gap is closing; update the GO-LIVE-CHECKLIST row and remove this test",
    ).toBe(0);
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

  it("a MALFORMED rate_config rests the tender at quote.requested — 200, never a 5xx retry storm (audit §406)", async () => {
    // The handler's own law, stated at its tenant-resolution guard: "a deterministic condition never returns
    // 5xx", with a TRANSIENT fault deliberately rethrown so the VAN does retry. A malformed tariff row is
    // deterministic — no retry can fix it — yet `loadTenantRatingConfig` threw straight through to a 5xx,
    // telling the VAN to retry forever.
    //
    // Contained now, treated as NO CONFIG: the same outcome as the dims-less case above. The tender is already
    // durably appended by that point, so nothing is lost either way; what changes is that the VAN gets a clean
    // 200 instead of an unfixable retry loop. Mirror of §404's Concierge fix, whose symptom from the same root
    // was the opposite — a DLQ'd customer email rather than a retry storm.
    await env.TENANT_A_DB.prepare(
      "INSERT OR REPLACE INTO rate_config (id, version, kind, payload, effective_ts, approved_by) VALUES (?,?,?,?,?,?)",
    )
      .bind("zt-malformed-204", 1, "zone_tariff", JSON.stringify({ kind: "zone_tariff", id: "zt-bad", version: "v1", zones: "not-an-object" }), 1, "test")
      .run();

    const seq = new RecordingSeq();
    const res = await handleInbound204(await signedRequest(mkTender({})), makeDeps(seq, new RecordingTransport(), goodSecrets()));

    expect(res.status, "a deterministic config fault must not 5xx the VAN").toBe(200);
    expect(seq.kinds).toEqual(["quote.requested"]);
    expect(seq.kinds).not.toContain("quote.priced");
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

  // §1502 (REQ-202/118) — THE UP-FRONT REFUSAL, which the over-cap case below cannot reach.
  //
  // The cap is TWO guards for two different situations, and the source says so: a declared Content-Length over
  // the ceiling is refused *"without reading the stream"*, and the post-read `byteLength` check is *"the belt
  // for a chunked/absent Content-Length"*. MEASURED at §1502: deleting the DECLARED branch left this suite
  // 131/131 green while deleting the post-read branch reds case (3) — so the belt was pinned and the primary
  // guard, the one that exists to avoid buffering a hostile body at all, was not.
  //
  // The failure it prevents is the whole point of REQ-202: without it a 10 GB declared body is fully read into
  // the isolate by `request.arrayBuffer()` before anything rejects it. Case (3) cannot see this — it sends a
  // genuinely large body, so BOTH branches fire and either one alone satisfies it.
  //
  // The discriminator is a SMALL body with a LARGE declared length: the post-read check passes it, so a 413
  // can only have come from the declared branch.
  it("(3a) a small body with an over-cap declared Content-Length → 413 before the read (the declared branch)", async () => {
    const seq = new RecordingSeq();
    const body = "A".repeat(64); // well under the cap — the post-read check would let this through
    const req = await signedRequest(body, { signature: "00" });
    const spoofed = new Request(req, { headers: new Headers({ ...Object.fromEntries(req.headers), "content-length": "1048577" }) });
    expect(spoofed.headers.get("content-length"), "the harness could not set a declared length — this case proves nothing").toBe("1048577");
    const res = await handleInbound204(spoofed, makeDeps(seq, new RecordingTransport(), goodSecrets()));
    expect(res.status).toBe(413);
    expect(seq.appended).toHaveLength(0);
    expect(await count(env.TENANT_A_DB, "anomalies")).toBe(0); // refused before auth/persist — nothing written
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

// §1728 (REQ-201/205/118) — THE ORDER-LEVEL-ONLY IDENTITY, WHOSE THREE CLAIMS WERE ALL COUNTED AND NONE PINNED.
//
// There are TWO `edi:shipment:` derivations, and that mattered. `map-204.ts` seeds the STABLE-REF id (SID → BM
// → PRO) that virtually every tender takes; `inbound.ts@orderLevelOnlyShipmentId` seeds the PO-only fallback,
// folding the interchange control in as a per-delivery discriminator. §1717 probed "the translator EDI shipment
// id", mutated `inbound.ts`, and read the resulting 141/141 green as "unpinned". Half right: re-measured
// separately, the map-204 path reds **3** cases (the round-trip fixture carries a derived id), and the
// inbound path reds **none** — the probe had mutated the branch the default tenders never take.
//
// The PO-only branch IS exercised, by three cases above. Every one of them asserts a COUNT — two shipments,
// two `quote.accepted` — so a derivation that changed every id it produces keeps all three counts identical
// and all three green. The comment on the seed states three claims and the counts reach only the middle one:
//
//   1. a same-interchange retry REPRODUCES the id (idempotent)          — counted, not pinned
//   2. two deliveries on one PO are two loads (visible over silent)     — counted
//   3. the id is stable across deploys                                  — unreachable by any count
//
// (3) is the one that bites: this id is `shipments.id` and the root of an `s:<id>` stream. A changed seed makes
// the retry in (1) mint a SECOND shipment for a delivery already in the ledger — the silent duplicate the
// comment says it prefers a visible one over, arriving by the back door.
describe("§1728 the PO-only shipment id is byte-stable, and the ISA is its discriminator (REQ-205)", () => {
  // The same per-test setup the booking cases use: REQ-203 books only from a REPLAY-CERTIFIED partner, and
  // isolatedStorage rolls the seed back after each test. Without it the tender is refused and the assertion
  // below reads `undefined` — which is how this block failed on its first run.
  beforeEach(async () => {
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_ID, null, "{}");
    await certifyPartner(env.TENANT_A_DB, PARTNER_ID, "fixtures/edi/roundtrip.json");
  });

  it("a PO-only tender derives exactly this id; the same interchange re-derives it; a different one does not", async () => {
    const seq = new RecordingSeq();
    const deps = makeDeps(seq, new RecordingTransport(), goodSecrets());
    await handleInbound204(await signedRequest(mkTender({ isa: "000000042", sid: null, bol: null, l11: [["5000", "PO"]] })), deps);

    const first = await env.TENANT_A_DB.prepare("SELECT id FROM shipments").first<{ id: string }>();
    expect(
      first?.id,
      "the PO-only shipment id moved. It is `shipments.id` and the root of an `s:<id>` stream, and it is " +
        "already persisted: a changed seed makes a same-interchange RETRY mint a second shipment for a " +
        "delivery already in the ledger — the silent duplicate this derivation exists to avoid.",
    ).toBe("shp_4e7205e7b3cb666c");

    // (1) idempotent under the SAME interchange — the claim the counts could only reach indirectly.
    await handleInbound204(await signedRequest(mkTender({ isa: "000000042", sid: null, bol: null, l11: [["5000", "PO"]] })), deps);
    expect(await count(env.TENANT_A_DB, "shipments"), "a same-ISA retry is the SAME load").toBe(1);

    // (2) the ISA really is the discriminator — a different interchange is a different delivery, and the
    // literal proves it is discriminated BY THE ISA rather than by anything incidental in the tender.
    await handleInbound204(await signedRequest(mkTender({ isa: "000000777", sid: null, bol: null, l11: [["5000", "PO"]] })), deps);
    const ids = await env.TENANT_A_DB.prepare("SELECT id FROM shipments ORDER BY id").all<{ id: string }>();
    expect(ids.results.map((r) => r.id).sort()).toEqual(["shp_4e7205e7b3cb666c", "shp_8bf46387254e0465"].sort());
  });
});

// §1737 (REQ-040/CLAUDE.md Law 5) — WHY `assessApproval(quote, {})` IS CORRECT HERE, ASSERTED RATHER THAN ASSUMED.
//
// Law 5: an interline floor compares the tenant's EXECUTING SHARE, never the gross. `inbound.ts` calls
// `assessApproval(quote, {})` — no legs, no tenantParty — which routes to the DIRECT branch and compares the
// quoted sell itself. Its comment says why: *"A 204 carries no negotiated sell / interline legs."*
//
// That premise is true today by construction — `map-204.ts` has no legs concept and this worker writes no
// `legs` row — but it is asserted by nothing, and the omission is what makes the call correct. The Biller
// judges the same shipment through `resolveInterline`, which is fail-closed (an interline-shaped leg set with
// an incomplete split returns `unresolved`, never a gross comparison). The translator opts out of that check
// entirely by passing `{}`. So if a 204-created shipment ever became interline-shaped, the two would diverge:
// the Biller would refuse and the translator would already have compared the gross — the one thing Law 5
// forbids.
//
// This ties the omission to the leg state through the REAL resolver rather than restating the premise, so the
// two sides cannot drift apart silently.
describe("§1737 a 204-created shipment is DIRECT, which is what makes the translator's gross comparison legal", () => {
  beforeEach(async () => {
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_ID, null, "{}");
    await certifyPartner(env.TENANT_A_DB, PARTNER_ID, "fixtures/edi/roundtrip.json");
  });

  it("the legs a tender leaves behind resolve as `direct` under the Biller's own resolver", async () => {
    const seq = new RecordingSeq();
    await handleInbound204(await signedRequest(mkTender({ isa: "000000042" })), makeDeps(seq, new RecordingTransport(), goodSecrets()));

    const shp = await env.TENANT_A_DB.prepare("SELECT id FROM shipments").first<{ id: string }>();
    expect(shp?.id, "the tender must have produced a shipment, or this case proves nothing").toBeDefined();
    const legs = await env.TENANT_A_DB.prepare("SELECT kind, executor_party_id, split_bps FROM legs WHERE shipment_id = ? ORDER BY seq")
      .bind(shp!.id)
      .all<{ kind: string; executor_party_id: string; split_bps: number | null }>();

    // MEASURED, and the first draft of this case got it wrong: it asserted that two skeleton legs exist here,
    // because `booking.created` projects a pickup + delivery pair. They do not — the 204 chain STOPS at
    // `quote.accepted` and never appends `booking.created` (the Booking agent owns that, behind the credit and
    // evidence gates). So at the moment `inbound.ts` calls assessApproval, the shipment has NO legs at all.
    //
    // That makes the property stronger, not weaker: an empty leg set has no split and no second executor, so
    // `resolveInterline` calls it direct — and the assertion below therefore pins BOTH that the append set
    // stops short of booking.created AND that the gross comparison is legal at that point.
    expect(legs.results.length, "the 204 chain stops at quote.accepted, so no leg skeleton exists yet").toBe(0);
    // WHY THIS ASSERTS THE LEG STATE AND NOT `resolveInterline` ITSELF: importing the Biller into this suite
    // pulls the whole agents package graph, which contains `.tsx`, and this worker's tsconfig sets no `--jsx`
    // — the typecheck gate caught that attempt. So the claim is carried in two halves, deliberately, and this
    // is the half that belongs here: at the moment `inbound.ts` compares the gross, the shipment has NO legs.
    // The other half — that a leg set with no split and no second executor resolves `direct` — lives with
    // `resolveInterline` in `workers/agents` and is exercised there (weakening its direct condition reds a
    // case in each suite). Nothing joins the two halves mechanically; the join is this comment, which is the
    // honest position rather than a re-implementation of the resolver here.
    expect(
      legs.results.every((r) => r.split_bps === null),
      "a 204-created shipment carries a revenue split. `inbound.ts` calls assessApproval(quote, {}) — the " +
        "DIRECT branch, which compares the GROSS — on the stated premise that a 204 carries no interline " +
        "legs. If that premise has changed, this call now breaks CLAUDE.md Law 5 (REQ-040) and must pass " +
        "legs + tenantParty the way rate.ts does.",
    ).toBe(true);
  });
});
