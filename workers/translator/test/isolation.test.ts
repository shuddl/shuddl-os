import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "@shuddl/ledger/migrate";
import { EventInput } from "@shuddl/contracts";
import controlSql from "../../../db/control/migrations/0001_control.sql?raw";
import { handleInbound204, StaticSecretResolver, INBOUND_204_PATH, type InboundDeps, type SeqStubLike } from "../src/inbound.js";
import { RecordingTransport } from "../src/transport.js";
import { run214Sweep, sweepTenant214, tenderKey, tenderPrefix, sent214Key, quarantineKey, unresolvableKey } from "../src/sweep-214.js";
import { allocatePartnerControls } from "../src/partners.js";
import { resolveTenantDb, tenantDb } from "../src/tenants.js";
import { applyAll, seedEdiPartner, seedEvent, resetCounter } from "./helpers.js";

// WP-12 Task 11 · REQ-025 (CLAUDE.md rule #8: a cross-tenant read/write ANYWHERE is a build failure) — THE
// COMPREHENSIVE EDI TENANT-ISOLATION PROOF. Every EDI storage path is exercised with a case that would go RED if
// the path leaked across tenants — i.e. if the code used a hardcoded/other-tenant D1 binding, dropped the
// `${tenant}` R2 prefix, or resolved the tenant from a client hint instead of the pairing. Both EDI surfaces:
//   · INBOUND 204 (inbound.ts): parties/shipments/anomalies (per-tenant D1), the DO append (stream tenant),
//     the integrations cert read + control-number write, the pairings auth read (shared CONTROL_DB), and the
//     edi/<tenant>/tender|quarantine R2 keys.
//   · OUTBOUND 214 sweep (sweep-214.ts): the per-tenant integrations read + control-number write, the tenant
//     ledger read, and the edi/<tenant>/tender|214 R2 keys.
// The tenant is ALWAYS derived server-side — from the pairing (inbound) or the TENANT_SLUGS allowlist (sweep) —
// never from anything the client supplies. TENANT_A_DB and TENANT_B_DB are physically distinct D1s; EVIDENCE is
// one shared bucket keyed by an edi/<tenant>/ prefix — so a dropped prefix is the whole risk this suite nets.
//
// This file is the BROADENED companion to sweep-214.test.ts's single REQ-025 case (the "partner certified only
// in tenant-B is invisible to tenant-A's sweep — noPartner, no cross-DB read" case stays THERE; this file does
// not duplicate it, it adds the both-tenants content/keyspace proofs).

const T0 = Date.UTC(2026, 6, 19, 12, 0);

// tenant-a's EDI partner (its pairing carries tenant_id → slug "tenant-a").
const PARTNER_A = "iso-partner-a";
const SECRET_REF_A = "iso-secret-ref-a";
const SECRET_A = "iso-shared-secret-a-do-not-use-in-prod";
// tenant-b's EDI partner — seeded fully live so a cross-tenant leak would be OBSERVABLE, never silently absent.
const PARTNER_B = "iso-partner-b";
const SECRET_REF_B = "iso-secret-ref-b";
const SECRET_B = "iso-shared-secret-b-do-not-use-in-prod";

const BILL_TO_EMAIL = "ap@iso-gamma.example";

// ── a complete, PRICEABLE synthetic 204 (mirrors inbound.test.ts's mkTender): shipper Z1 zip + consignee Z5 zip
//    + a bill-to PER email + L4 dims + AT8 weight — so the lane prices against RATE_CONFIG and the chain reaches
//    quote.accepted (which drives the 990 control-number allocation, exercising the integrations WRITE path). ──
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
function tender204(isa = "000000042"): string {
  return [
    isaHeader(isa),
    seg("GS", "SM", "MEGA", "SHUDDL", "20260719", "1200", "77", "X", "004010"),
    seg("ST", "204", "0001"),
    seg("B2", "", "MEGA", "", "SHIP123", "", "PP"),
    seg("B2A", "00"),
    seg("L11", "BOL987", "BM"),
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
    seg("L4", "48", "40", "60", "IN"),
    seg("AT8", "G", "L", "15000", "40"),
    seg("SE", "18", "0001"),
    seg("GE", "1", "77"),
    seg("IEA", "1", isa),
  ].join("");
}

// The SEED-1-shaped synthetic tariff (dest 800xx → Z5). Mirrors inbound.test.ts (not importable cross-file). Both
// stop zips resolve to a rate group, so a tender PRICES → the full chain runs → the 990 allocation writes.
const RATE_CONFIG: Array<{ id: string; kind: string; payload: unknown }> = [
  {
    id: "zt-iso",
    kind: "zone_tariff",
    payload: {
      kind: "zone_tariff",
      id: "zt-iso",
      version: "v1",
      zip_to_zone: { "800": "Z5", "970": "Z1" },
      rate_groups: [
        { id: "rg-near", zones: ["Z1"], breaks: [{ min_lb: 0, cwt_cents: 3800 }, { min_lb: 500, cwt_cents: 3200 }], min_charge_cents: 9500 },
        { id: "rg-far", zones: ["Z5"], breaks: [{ min_lb: 0, cwt_cents: 5200 }, { min_lb: 500, cwt_cents: 4500 }], min_charge_cents: 11500 },
      ],
    },
  },
  { id: "fl-iso", kind: "floors", payload: { kind: "floors", id: "fl-iso", version: "v1", target_or_bps: 9800, full_cost_bps: 9200, contribution_bps: 8500 } },
  { id: "fsc-iso", kind: "fsc", payload: { kind: "fsc", id: "fsc-iso", version: "v1", pct_bps: 2400 } },
  { id: "acc-iso", kind: "accessorials", payload: { kind: "accessorials", id: "acc-iso", version: "v1", items: { liftgate: 3500 } } },
];

async function hmacHex(secret: string, body: string): Promise<string> {
  const data = new TextEncoder().encode(body);
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, buf);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signedRequest(
  body: string,
  opts: { partner: string; secret: string; signature?: string; extraHeaders?: Record<string, string> },
): Promise<Request> {
  const signature = opts.signature ?? (await hmacHex(opts.secret, body));
  return new Request(`https://translator.local${INBOUND_204_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/edi-x12",
      "X-Shuddl-Edi-Partner": opts.partner,
      "X-Shuddl-Edi-Signature": signature,
      ...(opts.extraHeaders ?? {}),
    },
    body,
  });
}

// A RecordingSeq that models the api sequencer DO's contract the handler depends on: dedupe by event id and
// Zod-validate the input (EventInput.parse — exactly what the DO does). It is the ONLY place the append TENANT
// is observed — so `appended[].tenant` is the DO-append isolation assertion: a hardcoded/other-tenant stream
// routing would surface here as a wrong tenant.
class RecordingSeq implements SeqStubLike {
  readonly appended: Array<{ tenant: string; streamId: string; event: ReturnType<typeof EventInput.parse> }> = [];
  private readonly byId = new Map<string, ReturnType<typeof EventInput.parse>>();
  async append(req: { tenant: string; streamId: string; input: unknown }): Promise<{ id: string }> {
    const parsed = EventInput.parse(req.input);
    // §1375 — KEYED BY (tenant|id), NOT id. Production's dedupe is a property of the DURABLE OBJECT INSTANCE,
    // and `sequencer.ts:202@ShipmentSequencer` is explicit: "one Durable Object per (tenant|stream) IS the sequencer", addressed
    // by `idFromName(`${tenant}|${streamId}`)`. A same-id append under a DIFFERENT tenant therefore reaches a
    // DIFFERENT DO and is NOT deduped in production. Keying this map on the bare id made the double dedupe
    // across tenants where production does not — and in THIS file, whose entire purpose is REQ-025 isolation,
    // that swallowed exactly the violation under test: a cross-tenant append reusing an id was never recorded,
    // so `appended.every((a) => a.tenant === "tenant-a")` passed without ever seeing it.
    const key = `${req.tenant}|${parsed.id}`;
    const existing = this.byId.get(key);
    if (existing !== undefined) return { id: existing.id };
    this.byId.set(key, parsed);
    this.appended.push({ tenant: req.tenant, streamId: req.streamId, event: parsed });
    return { id: parsed.id };
  }
}

function makeDeps(seq: SeqStubLike, transport: RecordingTransport, secrets: StaticSecretResolver, now = T0): InboundDeps {
  return {
    controlDb: env.CONTROL_DB,
    // The ONLY tenant→D1 map (REQ-025). The handler picks the slug from the pairing, never from a client hint.
    tenantDbFor: (slug) => resolveTenantDb(env, slug),
    evidence: env.EVIDENCE,
    seq,
    transport,
    secrets,
    now: () => now,
  };
}

function bothSecrets(): StaticSecretResolver {
  return new StaticSecretResolver({ [SECRET_REF_A]: SECRET_A, [SECRET_REF_B]: SECRET_B });
}

async function count(db: D1Database, table: "shipments" | "parties" | "anomalies" | "integrations"): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

async function listKeys(prefix: string): Promise<number> {
  return (await env.EVIDENCE.list({ prefix })).objects.length;
}

// The 14th ISA element (index 13) is the interchange control number the wire actually carries — so a test can
// prove WHICH tenant's OWN outbound counter stamped a 214 (a leak that read the sibling's counter shows here).
function isaOf(bytes: string): string {
  return bytes.split("~")[0]!.split("*")[13]!;
}

// Read a partner's persisted outbound counter (integrations.config.$.outbound.isa) so a test can prove a tenant-A
// allocation neither read nor incremented tenant-B's counter (undefined = no such integrations row at all).
async function readCounter(db: D1Database, id: string): Promise<number | undefined> {
  const row = await db.prepare("SELECT config FROM integrations WHERE kind='edi_partner' AND id=? LIMIT 1").bind(id).first<{ config: string }>();
  if (row === null) return undefined;
  const cfg = JSON.parse(row.config) as { outbound?: { isa?: number } };
  return cfg.outbound?.isa;
}

// A key-recording R2 wrapper: forwards every call to the real bucket but records each key/prefix touched, so a
// per-tenant sweep can be PROVEN to read/write ONLY its own edi/<tenant>/ keyspace — the sharpest form of the
// "no edi/tenant-a/ key is read while building tenant-b's 214" claim. Only get/head/put/list carry keys (the
// only methods the sweep uses); everything else forwards unchanged.
type UnknownFn = (...args: unknown[]) => unknown;
function recordingBucket(inner: R2Bucket, keys: string[]): R2Bucket {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      const fn = value as UnknownFn;
      if (prop === "get" || prop === "head" || prop === "put") {
        return (key: string, ...rest: unknown[]) => {
          keys.push(key);
          return fn.call(target, key, ...rest);
        };
      }
      if (prop === "list") {
        return (opts?: { prefix?: string; cursor?: string }) => {
          if (opts?.prefix !== undefined) keys.push(opts.prefix);
          return fn.call(target, opts);
        };
      }
      return fn.bind(target);
    },
  });
}

beforeAll(async () => {
  await applyAll(env.TENANT_A_DB);
  await applyAll(env.TENANT_B_DB);
  const hasTenants = await env.CONTROL_DB.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='tenants'").first();
  if (hasTenants === null) await applyMigrations(env.CONTROL_DB, [{ path: "0001_control.sql", sql: controlSql }]);

  // TWO tenants, each with its OWN active EDI pairing. The pairing carries the tenant (tenant_id → slug); auth
  // resolves the tenant from HERE, never from a client header — this is the whole point of case "auth".
  for (const [id, slug] of [["iso-t-a", "tenant-a"], ["iso-t-b", "tenant-b"]] as const) {
    await env.CONTROL_DB.prepare("INSERT OR IGNORE INTO tenants (id, name, slug, plan, policy, created_ts) VALUES (?,?,?,?,?,?)")
      .bind(id, `Iso ${slug}`, slug, "pilot", "{}", 0)
      .run();
  }
  await env.CONTROL_DB.prepare("INSERT OR IGNORE INTO pairings (id, tenant_id, kind, scopes, caps, secret_ref, status) VALUES (?,?,?,?,?,?,?)")
    .bind(PARTNER_A, "iso-t-a", "edi", "[]", "{}", SECRET_REF_A, "active")
    .run();
  await env.CONTROL_DB.prepare("INSERT OR IGNORE INTO pairings (id, tenant_id, kind, scopes, caps, secret_ref, status) VALUES (?,?,?,?,?,?,?)")
    .bind(PARTNER_B, "iso-t-b", "edi", "[]", "{}", SECRET_REF_B, "active")
    .run();

  // Tariff in tenant-a only (the only tenant a 204 in this suite ever resolves to → the only one that prices).
  for (const r of RATE_CONFIG) {
    await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO rate_config (id, version, kind, payload, effective_ts, approved_by) VALUES (?,?,?,?,?,?)")
      .bind(r.id, 1, r.kind, JSON.stringify(r.payload), 0, "seed")
      .run();
  }
});

beforeEach(() => resetCounter());

// ── SURFACE 1: the INBOUND 204 handler (parties/shipments/anomalies D1, the DO append, integrations, R2). ──
describe("REQ-025 — inbound 204 tenant isolation", () => {
  // CASE 1. A tenant-a partner's tender writes tenant-a's D1 + edi/tenant-a R2 ONLY — zero tenant-b footprint.
  // CATCHES: a hardcoded/other-tenant tenantDbFor binding, a dropped `${tenant}` R2 prefix, or a DO append routed
  // to the wrong tenant — any of these would put a row/key in tenant-b (asserted to have NONE).
  it("(1) a valid tenant-a 204 lands in tenant-a's D1 + edi/tenant-a/ R2 only; tenant-b has zero footprint", async () => {
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_A, "certified", "{}"); // certified in tenant-a → the chain runs
    const seq = new RecordingSeq();
    const res = await handleInbound204(await signedRequest(tender204(), { partner: PARTNER_A, secret: SECRET_A }), makeDeps(seq, new RecordingTransport(), bothSecrets()));
    expect(res.status).toBe(200);

    // tenant-a: the shipment, the email-keyed party, every append routed to tenant-a, the tender marker.
    expect(await count(env.TENANT_A_DB, "shipments")).toBe(1);
    expect(await count(env.TENANT_A_DB, "parties")).toBe(1);
    expect(seq.appended.length, "the priceable chain appended").toBeGreaterThan(0);
    expect(seq.appended.every((a) => a.tenant === "tenant-a"), "EVERY append is routed to tenant-a's stream").toBe(true);
    expect(await listKeys(tenderPrefix("tenant-a")), "the tender marker is under edi/tenant-a/tender/").toBe(1);

    // tenant-b: ZERO rows in every table the handler could touch, and NOT ONE edi/tenant-b/ key.
    expect(await count(env.TENANT_B_DB, "shipments"), "tenant-b shipments").toBe(0);
    expect(await count(env.TENANT_B_DB, "parties"), "tenant-b parties").toBe(0);
    expect(await count(env.TENANT_B_DB, "anomalies"), "tenant-b anomalies").toBe(0);
    expect(await count(env.TENANT_B_DB, "integrations"), "tenant-b integrations untouched by the 990 allocation").toBe(0);
    expect(await listKeys("edi/tenant-b/"), "no edi/tenant-b/ R2 key was written").toBe(0);
  });

  // §1375 — THE DOUBLE ITSELF, TESTED. The assertion above can only see appends the double RECORDS, and this
  // double dedupes. Keyed on the bare event id (as it was until §1375) a cross-tenant append reusing an id was
  // returned early and never pushed, so `every(... === "tenant-a")` passed WITHOUT the leak ever being visible
  // — the mask sitting on the one file that exists to catch that leak (REQ-025, CLAUDE.md rule 8).
  //
  // Production does not dedupe across tenants: `workers/api/src/do/sequencer.ts:202@ShipmentSequencer` — "one Durable Object per
  // (tenant|stream) IS the sequencer", addressed by idFromName(`${tenant}|${streamId}`). A same-id append for
  // another tenant reaches a different DO. The double must be faithful to that, or the suite certifies a
  // property the code does not have.
  it("§1375: the recorder does NOT collapse a same-id append across tenants (it would hide the leak)", async () => {
    // A REAL event, taken from this file's own flow — hand-built inputs do not satisfy EventInput, and guessing
    // the schema would test the fixture rather than the double.
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_A, "certified", "{}");
    const probe = new RecordingSeq();
    await handleInbound204(await signedRequest(tender204(), { partner: PARTNER_A, secret: SECRET_A }), makeDeps(probe, new RecordingTransport(), bothSecrets()));
    expect(probe.appended.length, "the flow appended nothing — this probe proves nothing").toBeGreaterThan(0);

    const real = probe.appended[0]!;
    const seq = new RecordingSeq();
    await seq.append({ tenant: "tenant-a", streamId: real.streamId, input: real.event });
    await seq.append({ tenant: "tenant-b", streamId: real.streamId, input: real.event });
    expect(
      seq.appended.map((a) => a.tenant),
      "the double swallowed the second tenant's append — every isolation assertion in this file is then blind " +
        "to exactly the cross-tenant leak it is written to catch",
    ).toEqual(["tenant-a", "tenant-b"]);
  });


  // CASE 2. Auth cannot cross tenants: tenant is derived from the PAIRING, never a client hint. The EDI webhook
  // contract has NO client-tenant header at all — so a spoofed X-Tenant-Id: tenant-b is inert. tenant-b is seeded
  // fully live (certified partner) so, were the header ever honored, the leak would be OBSERVABLE.
  // CATCHES: any code that resolves the tenant from a request header/body instead of pairings.tenant_id.
  it("(2) tenant resolves from the pairing (tenant-a); a spoofed X-Tenant-Id: tenant-b header changes nothing", async () => {
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_A, "certified", "{}");
    await seedEdiPartner(env.TENANT_B_DB, PARTNER_B, "certified", "{}"); // tenant-b is live — a leak would show
    const seq = new RecordingSeq();
    const res = await handleInbound204(
      await signedRequest(tender204(), { partner: PARTNER_A, secret: SECRET_A, extraHeaders: { "X-Tenant-Id": "tenant-b" } }),
      makeDeps(seq, new RecordingTransport(), bothSecrets()),
    );
    expect(res.status).toBe(200);

    // The resolved tenant is A (from PARTNER_A's pairing), NOT the header's "tenant-b".
    expect(seq.appended.length).toBeGreaterThan(0);
    expect(seq.appended.every((a) => a.tenant === "tenant-a"), "the spoofed header never re-routed a single append").toBe(true);
    expect(await count(env.TENANT_A_DB, "shipments"), "the shipment landed in tenant-a").toBe(1);
    expect(await listKeys(tenderPrefix("tenant-a"))).toBe(1);

    // tenant-b — named by the spoofed header — is completely untouched.
    expect(await count(env.TENANT_B_DB, "shipments"), "the header did NOT route the tender to tenant-b").toBe(0);
    expect(await listKeys(tenderPrefix("tenant-b")), "no edi/tenant-b/ tender marker from a tenant-a partner").toBe(0);
  });

  // CASE 3. Quarantine isolation: a malformed 204 from a tenant-a partner writes the anomalies row + the raw
  // bytes under edi/tenant-a/quarantine/ in tenant A ONLY (the quarantine path also uses tenantDbFor + the
  // edi/<tenant>/ key). CATCHES: a quarantine that hardcoded a tenant D1 or dropped its `${tenant}` prefix.
  it("(3) a malformed tenant-a 204 quarantines in tenant-a only (anomaly + edi/tenant-a/quarantine bytes); tenant-b untouched", async () => {
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_A, "certified", "{}");
    const seq = new RecordingSeq();
    const bad = "NOT-AN-EDI-DOCUMENT-AT-ALL";
    const res = await handleInbound204(await signedRequest(bad, { partner: PARTNER_A, secret: SECRET_A }), makeDeps(seq, new RecordingTransport(), bothSecrets()));
    expect(res.status).toBe(200); // ack, never a retry-storm

    // tenant-a: exactly one anomaly + the raw bytes under edi/tenant-a/quarantine/<partner>/…
    expect(await count(env.TENANT_A_DB, "anomalies")).toBe(1);
    const quarantined = await env.EVIDENCE.list({ prefix: `edi/tenant-a/quarantine/${PARTNER_A}/` });
    expect(quarantined.objects).toHaveLength(1);
    expect(await (await env.EVIDENCE.get(quarantined.objects[0]!.key))!.text()).toBe(bad);
    expect(seq.appended, "a malformed tender appends nothing").toHaveLength(0);

    // tenant-b: zero anomalies, and NOT ONE edi/tenant-b/ key.
    expect(await count(env.TENANT_B_DB, "anomalies")).toBe(0);
    expect(await listKeys("edi/tenant-b/"), "no edi/tenant-b/ quarantine key").toBe(0);
  });

  // CASE 3b (exit-audit F-3). The NEW 990 ack-dedup R2 key builder gets an isolation case (per the tenant-isolation
  // skill: every new edi/<tenant>/ key builder is proven tenant-scoped). A tenant-a accepted tender writes its 990
  // marker under edi/tenant-a/990/ ONLY — never edi/tenant-b/. CATCHES a dropped `${tenant}` prefix on the 990 key.
  it("(3b) a tenant-a accepted 204's 990 ack marker lands under edi/tenant-a/990/ only; tenant-b keyspace untouched", async () => {
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_A, "certified", "{}");
    const transport = new RecordingTransport();
    const res = await handleInbound204(await signedRequest(tender204(), { partner: PARTNER_A, secret: SECRET_A }), makeDeps(new RecordingSeq(), transport, bothSecrets()));
    expect(res.status).toBe(200);
    expect(transport.sent990, "the accepted tender is acknowledged with a 990").toHaveLength(1);
    expect(await listKeys("edi/tenant-a/990/"), "the 990 ack-dedup marker is under edi/tenant-a/990/").toBe(1);
    expect(await listKeys("edi/tenant-b/"), "no edi/tenant-b/ key from a tenant-a 990 ack").toBe(0);
  });
});

// ── SURFACE 2: the OUTBOUND 214 sweep (per-tenant integrations + ledger read, edi/<tenant>/ R2). ──
describe("REQ-025 — outbound 214 sweep tenant isolation", () => {
  const SHARED_SHP = "iso-shp-shared"; // the SAME shipment id in BOTH tenants — a strong cross-tenant stressor
  const PARTNER_SHARED = "iso-partner-shared"; // the SAME partner id, one integrations row per tenant
  const SCAC_A = "AAAA";
  const SCAC_B = "BBBB";

  // Seed the SAME shipment id + SAME partner id into BOTH tenants, but with DISTINCT status arcs, SCACs, and
  // outbound counters — so a leak surfaces as the WRONG SCAC / WRONG ISA13 / WRONG arc on the wire.
  async function seedBothTenants(): Promise<void> {
    // tenant-a: full arc arrived→departed→pod, marker SCAC AAAA, counter seeded 41 → first alloc 42.
    await seedEvent(env.TENANT_A_DB, "stop.arrived", { stream_id: `s:${SHARED_SHP}`, shipment_id: SHARED_SHP, seq: 0, ts: T0 });
    await seedEvent(env.TENANT_A_DB, "stop.departed", { stream_id: `s:${SHARED_SHP}`, shipment_id: SHARED_SHP, seq: 1, ts: T0 + 1_000 });
    await seedEvent(env.TENANT_A_DB, "pod.signed", { stream_id: `s:${SHARED_SHP}`, shipment_id: SHARED_SHP, seq: 2, ts: T0 + 2_000 });
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_SHARED, "certified", JSON.stringify({ outbound: { isa: 41, gs: 41 } }));
    await env.EVIDENCE.put(tenderKey("tenant-a", SHARED_SHP), JSON.stringify({ partnerId: PARTNER_SHARED, partnerScac: SCAC_A, isaControl: "000000999" }));

    // tenant-b: partial arc arrived→departed (distinct newest event → distinct dedupeKey), marker SCAC BBBB,
    // counter seeded 100 → first alloc 101 (clearly NOT tenant-a's 42).
    await seedEvent(env.TENANT_B_DB, "stop.arrived", { stream_id: `s:${SHARED_SHP}`, shipment_id: SHARED_SHP, seq: 0, ts: T0 + 5_000 });
    await seedEvent(env.TENANT_B_DB, "stop.departed", { stream_id: `s:${SHARED_SHP}`, shipment_id: SHARED_SHP, seq: 1, ts: T0 + 6_000 });
    await seedEdiPartner(env.TENANT_B_DB, PARTNER_SHARED, "certified", JSON.stringify({ outbound: { isa: 100, gs: 100 } }));
    await env.EVIDENCE.put(tenderKey("tenant-b", SHARED_SHP), JSON.stringify({ partnerId: PARTNER_SHARED, partnerScac: SCAC_B, isaControl: "000000888" }));
  }

  // CASE 4a. One run214Sweep produces EACH tenant's 214 from ITS OWN events, integrations counter, and marker,
  // into ITS OWN edi/<tenant>/214/ keyspace. CATCHES: a cross-tenant ledger read (wrong arc), a cross-tenant
  // integrations read (wrong ISA13), or a cross-tenant marker read (wrong SCAC) — none of tenant-a's content
  // may appear in tenant-b's 214, and vice-versa.
  it("(4a) run214Sweep builds each tenant's 214 from its OWN events/counter/marker — no cross content, no cross keyspace", async () => {
    await seedBothTenants();
    const transport = new RecordingTransport();
    await run214Sweep(env, transport);

    expect(transport.sent, "one 214 per tenant").toHaveLength(2);
    const a = transport.sent.find((s) => s.partnerScac === SCAC_A);
    const b = transport.sent.find((s) => s.partnerScac === SCAC_B);
    expect(a, "tenant-a's 214 was transmitted").toBeDefined();
    expect(b, "tenant-b's 214 was transmitted").toBeDefined();

    // Each 214 carries its OWN tenant's allocated ISA13 (from that tenant's OWN integrations counter).
    expect(isaOf(a!.bytes), "tenant-a counter 41 → 42").toBe("000000042");
    expect(isaOf(b!.bytes), "tenant-b counter 100 → 101, NOT tenant-a's 42").toBe("000000101");

    // Content isolation: neither 214 carries the sibling tenant's SCAC.
    expect(a!.bytes).toContain(SCAC_A);
    expect(a!.bytes, "tenant-a's 214 never carries tenant-b's SCAC").not.toContain(SCAC_B);
    expect(b!.bytes).toContain(SCAC_B);
    expect(b!.bytes, "tenant-b's 214 never carries tenant-a's SCAC").not.toContain(SCAC_A);

    // Distinct newest-status events ⇒ distinct dedupe keys ⇒ sent markers under DISJOINT edi/<tenant>/214/ prefixes.
    expect(a!.idempotencyKey).not.toBe(b!.idempotencyKey);
    expect(await listKeys("edi/tenant-a/214/"), "tenant-a's sent marker under its own prefix").toBe(1);
    expect(await listKeys("edi/tenant-b/214/"), "tenant-b's sent marker under its own prefix").toBe(1);

    // The counters advanced in each tenant's OWN row only.
    expect(await readCounter(env.TENANT_A_DB, PARTNER_SHARED)).toBe(42);
    expect(await readCounter(env.TENANT_B_DB, PARTNER_SHARED)).toBe(101);
  });

  // CASE 4b. Sweeping ONE tenant touches ONLY that tenant's edi/<tenant>/ R2 keyspace — the sharpest form of the
  // "no edi/tenant-a/ key is read while building tenant-b's 214" claim, proven by recording every key the sweep
  // touches. CATCHES: any R2 key builder that dropped/hardcoded the tenant segment.
  it("(4b) sweepTenant214 for one tenant reads/writes ONLY its own edi/<tenant>/ keyspace (both directions)", async () => {
    await seedBothTenants();

    // Sweep tenant-b through a key-recording bucket; every R2 key touched must be edi/tenant-b/… — and the wire
    // carries tenant-b's OWN counter (101), proving the integrations read was tenant-b's D1, not tenant-a's.
    const keysB: string[] = [];
    const txB = new RecordingTransport();
    await sweepTenant214(tenantDb(env, "tenant-b"), recordingBucket(env.EVIDENCE, keysB), "tenant-b", txB);
    expect(txB.sent).toHaveLength(1);
    expect(txB.sent[0]!.partnerScac).toBe(SCAC_B);
    expect(isaOf(txB.sent[0]!.bytes), "tenant-b's OWN counter — never tenant-a's 42").toBe("000000101");
    expect(keysB.length).toBeGreaterThan(0);
    for (const k of keysB) expect(k, `sweeping tenant-b touched a non-tenant-b R2 key: ${k}`).toMatch(/^edi\/tenant-b\//);

    // Symmetric: sweeping tenant-a touches ONLY edi/tenant-a/… keys.
    const keysA: string[] = [];
    await sweepTenant214(tenantDb(env, "tenant-a"), recordingBucket(env.EVIDENCE, keysA), "tenant-a", new RecordingTransport());
    expect(keysA.length).toBeGreaterThan(0);
    for (const k of keysA) expect(k, `sweeping tenant-a touched a non-tenant-a R2 key: ${k}`).toMatch(/^edi\/tenant-a\//);
  });

  // CASE 5. Control-number allocation isolation: each tenant's partner counter lives in ITS OWN integrations row.
  // Allocating for tenant-a neither reads nor increments tenant-b's counter (and vice-versa). CATCHES: an
  // allocate that ignored its `db` param / shared a physical handle — the counters would interfere.
  it("(5) control-number allocation reads/increments ONLY the passed tenant's integrations row", async () => {
    const PID = "iso-partner-alloc";
    await seedEdiPartner(env.TENANT_A_DB, PID, "certified", JSON.stringify({ outbound: { isa: 41, gs: 41 } }));
    await seedEdiPartner(env.TENANT_B_DB, PID, "certified", JSON.stringify({ outbound: { isa: 100, gs: 100 } }));

    // Allocate on tenant-a's handle → 42 from tenant-a's OWN counter; tenant-b's counter is neither read nor bumped.
    expect(await allocatePartnerControls(tenantDb(env, "tenant-a"), PID)).toEqual({ isaControl: "000000042", gsControl: "42" });
    expect(await readCounter(env.TENANT_B_DB, PID), "tenant-b counter untouched by a tenant-a allocation").toBe(100);

    // Symmetric: allocate on tenant-b's handle → 101 from tenant-b's OWN counter; tenant-a stays at 42.
    expect(await allocatePartnerControls(tenantDb(env, "tenant-b"), PID)).toEqual({ isaControl: "000000101", gsControl: "101" });
    expect(await readCounter(env.TENANT_A_DB, PID), "tenant-a counter untouched by a tenant-b allocation").toBe(42);
  });
});

// ── The prefix-regression NET (skill: a route test can't catch a dropped `${tenant}` if both tenants return
//    empty). Assert the literal key strings + that two tenants never collide up to the tenant slug. ──
describe("REQ-025 — EDI R2 key builders embed the tenant slug", () => {
  it("(6) tenderKey / tenderPrefix / sent214Key embed the tenant and never collide across tenants", () => {
    expect(tenderKey("tenant-a", "s1")).toBe("edi/tenant-a/tender/s1");
    expect(tenderKey("tenant-a", "s1")).toContain("tenant-a/");
    expect(tenderPrefix("tenant-a")).toBe("edi/tenant-a/tender/");
    expect(sent214Key("tenant-a", "k1")).toBe("edi/tenant-a/214/k1");
    // The whole point: two tenants' keys are identical EXCEPT the tenant slug — a dropped segment collapses them.
    expect(tenderKey("tenant-a", "s1")).not.toBe(tenderKey("tenant-b", "s1"));
    expect(sent214Key("tenant-a", "k1")).not.toBe(sent214Key("tenant-b", "k1"));
    expect(tenderPrefix("tenant-a")).not.toBe(tenderPrefix("tenant-b"));
  });

  // 2026-08-02 §37 — the two REFUSAL keys. Both were inline template literals in inbound.ts with no
  // builder and no case here, so this net could not see them: quarantine since WP-12, unresolvable since
  // §29. A review flagged the newer one; the older had the same gap.
  it("(7) quarantineKey / unresolvableKey embed the tenant, and NO discriminator content can escape it", () => {
    expect(quarantineKey("tenant-a", "p1", "000000001")).toBe("edi/tenant-a/quarantine/p1/000000001");
    expect(unresolvableKey("tenant-a", "p1", "000000001-abcdef")).toBe("edi/tenant-a/unresolvable/p1/000000001-abcdef");
    expect(quarantineKey("tenant-a", "p1", "x")).not.toBe(quarantineKey("tenant-b", "p1", "x"));
    expect(unresolvableKey("tenant-a", "p1", "x")).not.toBe(unresolvableKey("tenant-b", "p1", "x"));

    // THE LOAD-BEARING PROPERTY (REQ-025). The discriminator is partner-influenced — an ISA13 read verbatim
    // off the wire. It is appended AFTER the tenant segment, so however many slashes or traversal-looking
    // segments it carries, the object still lands under its OWN tenant prefix: a crafted ISA cannot make a
    // tenant-a refusal appear in a tenant-b listing. (R2 keys are flat strings, so .. is literal, not a path.)
    const hostile = "../../tenant-b/quarantine/p9/steal";
    for (const k of [quarantineKey("tenant-a", "p1", hostile), unresolvableKey("tenant-a", "p1", hostile)]) {
      expect(k.startsWith("edi/tenant-a/"), k + " must stay under its own tenant prefix").toBe(true);
      expect(k.startsWith("edi/tenant-b/")).toBe(false);
    }
    // …and the partnerId segment is likewise after the tenant (it comes from the pairing row, but pin it).
    expect(quarantineKey("tenant-a", hostile, "x").startsWith("edi/tenant-a/")).toBe(true);
  });
});
