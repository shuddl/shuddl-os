import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "@shuddl/ledger/migrate";
import { EventInput, partyIdForEmail } from "@shuddl/contracts";
import { parse204, build214, DEFAULT_004010 } from "@shuddl/edi";
import controlSql from "../../../db/control/migrations/0001_control.sql?raw";
import { handleInbound204, StaticSecretResolver, type InboundDeps, type SeqStubLike } from "../src/inbound.js";
import { mapTenderToBooking, type BookingPlan } from "../src/core/map-204.js";
import { buildStatusView, type StatusEventRow } from "../src/core/build-214.js";
import { RecordingTransport } from "../src/transport.js";
import { tenderPrefix, tenderKey } from "../src/sweep-214.js";
import { certifyPartner } from "../src/partners.js";
import { resolveTenantDb } from "../src/tenants.js";
import { applyAll, seedEdiPartner } from "./helpers.js";
import primary204 from "./fixtures/edi/primary-204.edi?raw";
import malformed204 from "./fixtures/edi/malformed-204.edi?raw";
import expectedBookingRaw from "./fixtures/edi/expected-booking.json?raw";
import statusChainRaw from "./fixtures/edi/status-chain.json?raw";
import expected214 from "./fixtures/edi/expected-214.edi?raw";

// WP-12 Task 10 · REQ-034 (DoD gate) — THE EDI REPLAY HARNESS. "Primary-partner-format fixtures round-trip
// clean; malformed docs quarantine with evidence." A partner is replay-CERTIFIED (certifyPartner, Task 9) only
// after its synthetic X12 004010 fixtures round-trip clean — so this suite is BOTH the DoD proof AND the model
// the certification harness runs. Every fixture is SYNTHETIC (REQ-167 identity-leak: no real partner/tenant/
// person name — SCAC "SYNC", greek-letter placeholder firms, a `.example` bill-to email). Fully additive: the
// fixtures live under workers/translator/test/fixtures/edi/ and gate merges through THIS translator suite (no
// fixtures/manifest touch). It mirrors inbound.test.ts's pool-workers harness (tenant D1 seed, control-plane
// pairing, HMAC-signed 204 POST, the RecordingSeq that models the DO's dedupe-by-id).

// The pairing id IS the shipment-id seed (mapTenderToBooking keys shp_… on the QUALIFIER-NAMESPACED
// `edi:shipment:<partnerId>:<stableRefKey>:<stableRef>`), so this id is what makes the inbound handler reproduce
// the golden shipment id shp_4458e2c605473d38 below.
const PARTNER_ID = "partner-synthco";
const SECRET_REF = "edi-fixture-secret-ref";
const SECRET = "edi-fixture-shared-secret-synthetic-only";
const BILL_TO_EMAIL = "billing@synthbroker.example";
const PARTNER_SCAC = "SYNC";
// The primary-204.edi stable business ref (SID) → the deterministic golden shipment id, keyed on the partner +
// the WINNING qualifier (SID) + its value (SID-77012) — qualifier-namespaced so SID:x and PO:x never collide.
const GOLDEN_SHIPMENT_ID = "shp_4458e2c605473d38";
const INBOUND_ISA = "000000501"; // the primary-204.edi ISA13 (the partner's number; recorded on the tender marker)
// The 204-arrival clock the golden expected-booking.json was pinned against (Date.UTC(2026,6,17,12,0)). The
// mapping stamps it as the append `ts`, so the harness must inject the SAME value to reproduce the golden.
const T0 = 1_784_289_600_000;
// The FIXED outbound control numbers the golden expected-214.edi was serialized with (byte-stability: identical
// StatusView → identical bytes; the sweep allocates real ones at send time — here they are pinned constants).
const OUT_ISA = "000000042";
const OUT_GS = "42";
const FIXTURE_REF = "workers/translator/test/fixtures/edi/roundtrip";

// A PRICEABLE synthetic tariff so the inbound round-trip's lane prices (dest 80216 → "802" → Z5 → rg-far) and the
// gated chain reaches quote.accepted. Mirrors inbound.test.ts's RATE_CONFIG shape (not importable cross-worker);
// the zip_to_zone keys are the 3-digit prefixes of the primary-204.edi stops (origin 97035, dest 80216).
const RATE_CONFIG: Array<{ id: string; kind: string; payload: unknown }> = [
  {
    id: "zt-fx",
    kind: "zone_tariff",
    payload: {
      kind: "zone_tariff",
      id: "zt-fx",
      version: "v1",
      zip_to_zone: { "802": "Z5", "970": "Z1" },
      rate_groups: [
        { id: "rg-near", zones: ["Z1"], breaks: [{ min_lb: 0, cwt_cents: 3800 }, { min_lb: 500, cwt_cents: 3200 }], min_charge_cents: 9500 },
        { id: "rg-far", zones: ["Z5"], breaks: [{ min_lb: 0, cwt_cents: 5200 }, { min_lb: 500, cwt_cents: 4500 }], min_charge_cents: 11500 },
      ],
    },
  },
  { id: "fl-fx", kind: "floors", payload: { kind: "floors", id: "fl-fx", version: "v1", target_or_bps: 9800, full_cost_bps: 9200, contribution_bps: 8500 } },
  { id: "fsc-fx", kind: "fsc", payload: { kind: "fsc", id: "fsc-fx", version: "v1", pct_bps: 2400 } },
  { id: "acc-fx", kind: "accessorials", payload: { kind: "accessorials", id: "acc-fx", version: "v1", items: { liftgate: 3500 } } },
];

// ── the pool-workers harness (mirrors inbound.test.ts) ─────────────────────────────────────────────────────
class RecordingSeq implements SeqStubLike {
  readonly appended: Array<{ tenant: string; streamId: string; event: ReturnType<typeof EventInput.parse> }> = [];
  private readonly byId = new Map<string, ReturnType<typeof EventInput.parse>>();
  async append(req: { tenant: string; streamId: string; input: unknown }): Promise<{ id: string }> {
    const parsed = EventInput.parse(req.input); // exactly what the DO does — a malformed append fails loudly
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

function makeDeps(seq: SeqStubLike, transport: RecordingTransport): InboundDeps {
  return {
    controlDb: env.CONTROL_DB,
    tenantDbFor: (slug) => resolveTenantDb(env, slug),
    evidence: env.EVIDENCE,
    seq,
    transport,
    secrets: new StaticSecretResolver({ [SECRET_REF]: SECRET }),
    now: () => T0,
  };
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const data = new TextEncoder().encode(body);
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, buf);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signedRequest(body: string): Promise<Request> {
  return new Request("https://translator.local/edi/204/inbound", {
    method: "POST",
    headers: {
      "content-type": "application/edi-x12",
      "X-Shuddl-Edi-Partner": PARTNER_ID,
      "X-Shuddl-Edi-Signature": await hmacHex(SECRET, body),
    },
    body,
  });
}

async function count(db: D1Database, table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

// Order-independent structural equality via canonical (recursively key-sorted) JSON — so a golden authored/
// regenerated with any key order still deep-matches the mapping output. Used by both DoD-1 and replayCertify.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key: string, val: unknown): unknown => {
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(Object.entries(val as Record<string, unknown>).sort((a, b) => a[0].localeCompare(b[0])));
    }
    return val;
  });
}

// ── the REPLAY-CERT harness (DoD tie-in): run a partner's 204 + 214 round-trips and certify ONLY if BOTH pass
//    byte/shape-clean. A parse throw OR a mismatch ⇒ the partner is left uncertified (certifyPartner is never
//    reached). This is the model Task 9's certification runs — a format is trusted to book only once proven. ──
interface ReplayFixtures {
  tender204: string;
  expectedBooking: unknown;
  statusEvents: StatusEventRow[];
  expected214: string;
  receivedTs: number;
  fixtureRef: string;
}

async function replayCertify(db: D1Database, partnerId: string, fx: ReplayFixtures): Promise<boolean> {
  try {
    const plan = await mapTenderToBooking(parse204(fx.tender204), { partnerId, receivedTs: fx.receivedTs });
    if (canonical(plan) !== canonical(fx.expectedBooking)) return false; // the 204 did not round-trip clean
    const { view } = buildStatusView({
      shipmentRef: GOLDEN_SHIPMENT_ID,
      partnerScac: PARTNER_SCAC,
      isaControl: OUT_ISA,
      gsControl: OUT_GS,
      mapping: DEFAULT_004010,
      events: fx.statusEvents,
    });
    if (build214(view) !== fx.expected214) return false; // the 214 did not round-trip byte-clean
  } catch {
    return false; // an unparseable / non-mappable fixture never certifies (fail-closed)
  }
  await certifyPartner(db, partnerId, fx.fixtureRef); // both round-trips clean → certify with the fixture ref
  return true;
}

async function readCert(id: string): Promise<{ cert_status: string | null; replay_fixture_ref: string | null }> {
  const row = await env.TENANT_A_DB
    .prepare("SELECT cert_status, replay_fixture_ref FROM integrations WHERE kind='edi_partner' AND id=? LIMIT 1")
    .bind(id)
    .first<{ cert_status: string | null; replay_fixture_ref: string | null }>();
  return row!;
}

function goodFixtures(): ReplayFixtures {
  return {
    tender204: primary204,
    expectedBooking: JSON.parse(expectedBookingRaw),
    statusEvents: JSON.parse(statusChainRaw) as StatusEventRow[],
    expected214,
    receivedTs: T0,
    fixtureRef: FIXTURE_REF,
  };
}

beforeAll(async () => {
  await applyAll(env.TENANT_A_DB);
  const hasTenants = await env.CONTROL_DB.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='tenants'").first();
  if (hasTenants === null) await applyMigrations(env.CONTROL_DB, [{ path: "0001_control.sql", sql: controlSql }]);
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// DoD-1 & DoD-2 are PURE (no I/O): the format adapter round-trips independent of the worker wiring.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("REQ-034 DoD — the primary-partner format round-trips clean (pure adapter)", () => {
  it("(1) 204 round-trip: parse204 + mapTenderToBooking deep-equals expected-booking.json", async () => {
    const plan: BookingPlan = await mapTenderToBooking(parse204(primary204), { partnerId: PARTNER_ID, receivedTs: T0 });
    const expected = JSON.parse(expectedBookingRaw) as BookingPlan;

    // (a) the whole plan is the golden, byte/shape-for-shape (order-independent structural equality).
    expect(canonical(plan)).toBe(canonical(expected));

    // (b) the DoD-named semantic invariants, asserted explicitly (a regression in any one fails LOUDLY):
    //   · the party id is the SHARED email matcher's id (REQ-196 convergence — same id a CSR/Concierge derive).
    expect(plan.party.id).toBe(await partyIdForEmail(BILL_TO_EMAIL));
    expect(plan.party.kind).toBe("broker");
    //   · the shipment id is keyed on the STABLE business ref (SID), NOT the per-interchange ISA13.
    expect(plan.shipment.id).toBe(GOLDEN_SHIPMENT_ID);
    expect(plan.shipment.refs).toEqual({ SID: "SID-77012", BM: "BOL-55023", PO: "PO-33001" });
    //   · both freight stops survive with their firm NAMES + postal addresses (Migrator rule — no silent drop).
    expect(plan.stops.shipper?.name).toBe("DELTA SHIPPING CO");
    expect(plan.stops.shipper?.address.zip).toBe("97035");
    expect(plan.stops.consignee?.name).toBe("EPSILON RECEIVING LLC");
    expect(plan.stops.consignee?.address.zip).toBe("80216");
    //   · the append is EDI-sourced and PRICEABLE (weight + complete inch-unit dims present → not "price on air").
    const requested = plan.appends[0]!;
    expect(requested.kind).toBe("quote.requested");
    expect(requested.source).toBe("edi");
    const req = (requested.payload as { request: { weight_lb?: number; dims?: unknown } }).request;
    expect(req.weight_lb).toBe(18500);
    expect(req.dims).toEqual({ l_in: 96, w_in: 48, h_in: 52, pieces: 24 });
  });

  it("(2) 214 byte round-trip: buildStatusView + build214 is byte-identical to expected-214.edi", () => {
    const events = JSON.parse(statusChainRaw) as StatusEventRow[];
    const { view } = buildStatusView({
      shipmentRef: GOLDEN_SHIPMENT_ID,
      partnerScac: PARTNER_SCAC,
      isaControl: OUT_ISA,
      gsControl: OUT_GS,
      mapping: DEFAULT_004010,
      events,
    });
    const bytes = build214(view);
    expect(bytes).toBe(expected214); // identical StatusView → identical bytes (no Date, no counters)
    // spot-check the arc actually serialized (arrived→X3, departed→AF, pod→D1 via DEFAULT_004010.statusDialect).
    expect(bytes).toContain("AT7*X3****20260717*1430");
    expect(bytes).toContain("AT7*AF****20260717*1545");
    expect(bytes).toContain("AT7*D1****20260718*1015");
    expect(bytes.endsWith("~")).toBe(true); // byte-exact: terminates on the segment delimiter, no trailing junk
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// DoD-3 & DoD-4 are the INTEGRATION round-trip: the fixture driven through the real inbound handler.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("REQ-034 DoD — the fixture driven end-to-end through the inbound handler", () => {
  beforeEach(async () => {
    // Certify the partner (Task-9 entrypoint) so the cert gate admits the tender; isolatedStorage rolls it back.
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_ID, null, "{}");
    await certifyPartner(env.TENANT_A_DB, PARTNER_ID, FIXTURE_REF);
  });

  it("(3) full inbound round-trip: primary-204.edi → ONE shipment + the gated quote.requested{edi} → … → quote.accepted (NO booking.created) + the tender marker", async () => {
    const seq = new RecordingSeq();
    const res = await handleInbound204(await signedRequest(primary204), makeDeps(seq, new RecordingTransport()));
    expect(res.status).toBe(200);

    // exactly one shipment, and it is the DETERMINISTIC golden id (partnerId + stable SID) — the same id the
    // pure 204 round-trip (DoD-1) produced, proving the handler and the adapter agree.
    expect(await count(env.TENANT_A_DB, "shipments")).toBe(1);
    const shipment = await env.TENANT_A_DB.prepare("SELECT id FROM shipments LIMIT 1").first<{ id: string }>();
    expect(shipment?.id).toBe(GOLDEN_SHIPMENT_ID);
    // one party, keyed by the shared email matcher (REQ-196).
    expect(await count(env.TENANT_A_DB, "parties")).toBe(1);
    const party = await env.TENANT_A_DB.prepare("SELECT id FROM parties LIMIT 1").first<{ id: string }>();
    expect(party?.id).toBe(await partyIdForEmail(BILL_TO_EMAIL));

    // THE NO-BYPASS INVARIANT: the append set starts at an EDI quote.requested, prices, and STOPS at
    // quote.accepted — booking.created is NEVER in it (that gate lives behind the Booking agent + the DO).
    //
    // EXHAUSTIVE, not endpoints (audit §773). This read `kinds[0]` + `toContain("quote.priced")` +
    // `last === quote.accepted` + `not.toContain("booking.created")` — the SECOND instance of that shape on
    // this handler, and independently silent: with `inbound.test.ts` fixed, deleting the agent.acted append
    // still left THIS file 6/6 green. A named-absence assertion only ever catches the kind you already
    // thought to name; `toEqual` on the sequence catches a member missing, extra, or out of order.
    expect(seq.kinds).toEqual(["quote.requested", "quote.priced", "agent.acted", "quote.accepted"]);
    expect(seq.appended[0]!.event.source).toBe("edi");

    // the tender marker links the shipment to the partner, carrying the PARTNER's inbound-204 ISA13 (never
    // echoed onto an outbound doc — the 214/990 carry SHUDDL's OWN allocated numbers).
    const markers = await env.EVIDENCE.list({ prefix: tenderPrefix("tenant-a") });
    const marker = await env.EVIDENCE.get(tenderKey("tenant-a", GOLDEN_SHIPMENT_ID));
    expect(markers.objects.some((o) => o.key === tenderKey("tenant-a", GOLDEN_SHIPMENT_ID))).toBe(true);
    expect(JSON.parse(await marker!.text())).toEqual({ partnerId: PARTNER_ID, partnerScac: PARTNER_SCAC, isaControl: INBOUND_ISA });
  });

  it("(4) malformed-204.edi → quarantine with evidence: one anomalies row (edi_malformed) + the raw bytes retained in R2 + HTTP 200 + NO shipment", async () => {
    const seq = new RecordingSeq();
    const res = await handleInbound204(await signedRequest(malformed204), makeDeps(seq, new RecordingTransport()));
    expect(res.status).toBe(200); // ACK — a malformed doc is quarantined, never dropped and never a retry-storm

    // exactly one anomalies row, named the malformed-parse rule (the missing-IEA envelope failure).
    expect(await count(env.TENANT_A_DB, "anomalies")).toBe(1);
    const anomaly = await env.TENANT_A_DB.prepare("SELECT rule FROM anomalies LIMIT 1").first<{ rule: string }>();
    expect(anomaly?.rule).toBe("edi_malformed");
    // NO booking off a doc that would not parse: no shipment, no party, no ledger append.
    expect(await count(env.TENANT_A_DB, "shipments")).toBe(0);
    expect(await count(env.TENANT_A_DB, "parties")).toBe(0);
    expect(seq.appended, "a malformed tender appends NOTHING to the ledger").toHaveLength(0);
    // THE EVIDENCE: the raw doc is retained verbatim in R2 (never a silent drop — Migrator rule / CLAUDE.md #10).
    const quarantined = await env.EVIDENCE.list({ prefix: `edi/tenant-a/quarantine/${PARTNER_ID}/` });
    expect(quarantined.objects).toHaveLength(1);
    const obj = await env.EVIDENCE.get(quarantined.objects[0]!.key);
    expect(await obj!.text()).toBe(malformed204);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// DoD-5: the replay-CERT tie-in — a partner is certified ONLY once its fixtures round-trip clean.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("REQ-034/203 DoD — replay-cert: fixtures must round-trip clean to certify", () => {
  it("(5a) an ALL-CLEAN fixture set flips cert_status='certified' and records replay_fixture_ref", async () => {
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_ID, null, "{}"); // starts UNcertified
    expect((await readCert(PARTNER_ID)).cert_status).toBeNull();

    const certified = await replayCertify(env.TENANT_A_DB, PARTNER_ID, goodFixtures());
    expect(certified, "the clean fixtures round-trip → the partner is certified").toBe(true);

    const cert = await readCert(PARTNER_ID);
    expect(cert.cert_status).toBe("certified");
    expect(cert.replay_fixture_ref).toBe(FIXTURE_REF);
  });

  it("(5b) a fixture that does NOT round-trip leaves the partner UNCERTIFIED (both a mismatch and an unparseable doc)", async () => {
    // (i) a parseable 204 whose expected-booking golden was tampered → the booking compare fails → no certify.
    const mismatchId = "partner-mismatch";
    await seedEdiPartner(env.TENANT_A_DB, mismatchId, null, "{}");
    const tampered = JSON.parse(expectedBookingRaw) as { party: { name: string } };
    tampered.party.name = "TAMPERED — NOT THE WIRE VALUE";
    const mismatchCertified = await replayCertify(env.TENANT_A_DB, mismatchId, { ...goodFixtures(), expectedBooking: tampered });
    expect(mismatchCertified, "a booking mismatch must refuse certification").toBe(false);
    const mismatchCert = await env.TENANT_A_DB
      .prepare("SELECT cert_status FROM integrations WHERE kind='edi_partner' AND id=? LIMIT 1").bind(mismatchId)
      .first<{ cert_status: string | null }>();
    expect(mismatchCert?.cert_status, "a refused certification leaves the partner uncertified").not.toBe("certified");

    // (ii) an unparseable fixture (the malformed doc) → parse throws → fail-closed, never certified.
    const badFmtId = "partner-badfmt";
    await seedEdiPartner(env.TENANT_A_DB, badFmtId, null, "{}");
    const badCertified = await replayCertify(env.TENANT_A_DB, badFmtId, { ...goodFixtures(), tender204: malformed204 });
    expect(badCertified, "an unparseable fixture must refuse certification").toBe(false);
    const badCert = await env.TENANT_A_DB
      .prepare("SELECT cert_status FROM integrations WHERE kind='edi_partner' AND id=? LIMIT 1").bind(badFmtId)
      .first<{ cert_status: string | null }>();
    expect(badCert?.cert_status).toBeNull();
  });
});
