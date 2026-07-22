import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { eventFixture, type EventKind } from "@shuddl/contracts";
import { eventToRow, readEvents } from "@shuddl/ledger/lens";
import { computeModuleParity, type ParityValue } from "@shuddl/ledger/parity";
import { computeCostRatioBps } from "@shuddl/ledger/queries/metrics";
import type { AppendedEvent } from "../src/do/sequencer.js";
import { ensureSchema, ensureTenantPlaneSchema } from "./helpers.js";

// WP-15 Task 4b (REQ-021/022/030) — THE SOURCE-AWARE-LEDGER PROOF, against the REAL ShipmentSequencer DO.
//
// THE INVARIANT: a `source:'legacy'` event is a SHADOW — it exists in the `events` ledger for the native-vs-legacy
// PARITY compute ONLY, drives NO native read-model/projection, is EXEMPT from the native physical-precondition
// gates, and is producible ONLY by the internal mirror seam (never a client). Everything native is unchanged.
//
// This drives the ACTUAL DO append path (like sla-sweep/sequencer tests: the DO stub, exactly as the mirror seam
// `sweepTenantLegacyMirror` calls it), NOT a stub — so the gate carve-out (Change B) + projection skip (Change A)
// are proven against the crown-jewel sequencer, closing the review's key gap.
//
// TENANT ISOLATION FOR THIS SUITE: parity.test.ts (tenant-a) and isolation.test.ts (tenant-b) each pin an ABSOLUTE
// whole-tenant invoicing `legacy_value` as the SOLE legacy seeder in their D1. computeModuleParity is whole-tenant
// (no scope), so this suite must NOT add a legacy invoice to tenant-a/b. It runs on its OWN dedicated CLAIMED-POOL
// tenant (a distinct physical D1, TENANT_POOL_02_DB, reached via a dedicated control row → resolveClaimedTenantDb),
// and asserts parity by DELTA so any coexisting pool data (signup/provision suites) can never make it flaky.

const TENANT = "lgproof-tenant"; // a dedicated claimed tenant → its own pool D1 (never tenant-a/b)
const POOL_DB = env.TENANT_POOL_02_DB;

// The DO's RPC surface (hand-written — the 35-member recursive union explodes the generic stub mapper).
type SeqStub = DurableObjectStub & {
  append(req: { tenant: string; streamId: string; input: unknown }): Promise<AppendedEvent>;
};
function stubFor(streamId: string): SeqStub {
  return env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${TENANT}|${streamId}`)) as unknown as SeqStub;
}

// A `source:'legacy'` EventInput on a synthetic legacy stream, shaped exactly like the mirror sweep's appends
// (actor = the `agent:legacy-mirror` sentinel, no parties FK; no device sig; the adapter's per-kind payloads).
function legacyInput(streamId: string, kind: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: streamId.startsWith("s:") ? streamId.slice(2) : undefined,
    ts: 1_720_000_000_000,
    actor: { party: "agent:legacy-mirror" },
    party_refs: [],
    evidence: [],
    source: "legacy",
    confidence: 10_000,
    kind,
    payload,
  };
}

// The adapter's canonical legacy payloads (packages/adapters legacy-mirror.ts buildPayload) — the exact shapes
// the live mirror produces for each mirrored kind.
const LEGACY_INVOICE_TOTAL = 63_100;
const legacyInvoicePayload = {
  invoice_id: "lgp-inv-1",
  party_id: "legacy-party",
  division: "main",
  lines: [{ line_no: 1, kind: "freight", amount_cents: LEGACY_INVOICE_TOTAL, gl_map: "legacy-mirror" }],
};
const legacyApptPayload = {
  leg_kind: "pickup",
  facility_id: "lgp-fac",
  slot_key: "lgp-slot",
  window_start_ts: 1_720_000_000_000,
  window_end_ts: 1_720_003_600_000,
};
const legacyDispatchPayload = { driver_user_id: "lgp-driver" };
const legacyQuotePayload = {
  sell: 50_000,
  lines: [{ kind: "freight", code: "legacy", amount_cents: 50_000 }],
  floors: { contribution: 0, full: 46_000, target: 0 },
  versions: { rate_config_ids: ["legacy-mirror"] },
  basis: { mirror: "legacy" },
};

// A NATIVE event, DIRECT-inserted (parity/cost-ratio read `events` raw by kind+source, so no chain/projection is
// needed for the native side). Synthetic unique hash (a separate physical D1 from tenant-a/b — no cross-DB clash).
let hashN = 0xf10000;
const nextHash = (): string => (hashN++).toString(16).padStart(64, "0");
async function seedNativeEvent(kind: EventKind, shipmentId: string, payload: Record<string, unknown>): Promise<void> {
  // Mirror parity.test.ts / isolation.test.ts: build the overrides as a Record<string, unknown> variable (NOT an
  // object literal, which would be exact-checked against the per-kind payload union).
  const overrides: Record<string, unknown> = {
    id: crypto.randomUUID(),
    stream_id: `s:${shipmentId}`,
    shipment_id: shipmentId,
    seq: 0,
    source: "native",
    visibility: "internal",
    party_refs: [],
    payload,
  };
  const e = eventFixture(kind, overrides);
  const row = eventToRow(e);
  row.hash = nextHash();
  const cols = Object.keys(row);
  await POOL_DB.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .bind(...cols.map((c) => row[c]))
    .run();
}

const num = (v: ParityValue): number => (v === "UNKNOWN" ? 0 : v);

// Captured across the append sequence (before/after), so every parity/KPI assertion is a DELTA — robust to
// whatever the signup/provision suites leave in the shared pool D1.
let invParityBefore: Awaited<ReturnType<typeof computeModuleParity>>;
let invParityAfter: Awaited<ReturnType<typeof computeModuleParity>>;
let dispParityBefore: Awaited<ReturnType<typeof computeModuleParity>>;
let dispParityAfter: Awaited<ReturnType<typeof computeModuleParity>>;
let costRatioNativeOnly: Awaited<ReturnType<typeof computeCostRatioBps>>;
let costRatioWithLegacy: Awaited<ReturnType<typeof computeCostRatioBps>>;
let legacyInvoiceEventId = "";
let legacyApptEventId = "";
let legacyDispatchEventId = "";

beforeAll(async () => {
  await ensureSchema(env); // control plane
  await ensureTenantPlaneSchema(POOL_DB); // migrate the pool D1 (idempotent, guarded)
  // A dedicated control row → resolveClaimedTenantDb("lgproof-tenant") returns TENANT_POOL_02_DB. A DISTINCT id
  // from the `_pool_0N` sentinels, so provision.test's resetPool (which keys by `_pool_0N`) never touches it.
  await env.CONTROL_DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, name, slug, plan, policy, created_ts) VALUES (?,?,?,?,?,?)",
  )
    .bind("t-lgproof", "Legacy-Proof Tenant", TENANT, "pilot", JSON.stringify({ pool_binding: "TENANT_POOL_02_DB" }), 0)
    .run();

  // A pickup leg on the legacy-appointment shipment — so a NATIVE appointment.set WOULD claim its slot
  // (UPDATE legs.appt_slot_key). Its slot staying NULL after the legacy append PROVES the projection was skipped.
  // The leg FKs shipment_id → shipments(id), so materialize a minimal shipments row first (no party FK exists).
  await POOL_DB.prepare(
    "INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, created_ts) VALUES (?,?,?,?,0)",
  )
    .bind("lgproof-appt", "legacy-party", "legacy-party", "legacy-party")
    .run();
  await POOL_DB.prepare("INSERT OR IGNORE INTO legs (id, shipment_id, seq, kind, executor_party_id, geo) VALUES (?,?,?,?,?,?)")
    .bind("leg-lgproof-appt", "lgproof-appt", 0, "pickup", "agent:legacy-mirror", "{}")
    .run();

  // ── baseline (before ANY of this suite's events) ───────────────────────────────────────────────────────────
  invParityBefore = await computeModuleParity(POOL_DB, "invoicing");
  dispParityBefore = await computeModuleParity(POOL_DB, "dispatch");

  // ── the 3 GATED legacy kinds, via the REAL DO. Without the Change-B carve-out these would GATE_BLOCK
  //    (invoice→POD I2; appointment→facility+leg; dispatch→claimed appointment + carrier docs). ─────────────────
  legacyInvoiceEventId = (
    await stubFor("s:lgproof-inv").append({ tenant: TENANT, streamId: "s:lgproof-inv", input: legacyInput("s:lgproof-inv", "invoice.issued", legacyInvoicePayload) })
  ).id;
  legacyApptEventId = (
    await stubFor("s:lgproof-appt").append({ tenant: TENANT, streamId: "s:lgproof-appt", input: legacyInput("s:lgproof-appt", "appointment.set", legacyApptPayload) })
  ).id;
  legacyDispatchEventId = (
    await stubFor("s:lgproof-disp").append({ tenant: TENANT, streamId: "s:lgproof-disp", input: legacyInput("s:lgproof-disp", "dispatch.assigned", legacyDispatchPayload) })
  ).id;

  // native side for invoicing parity (direct insert) → both sides present ⇒ a real MATCH/DRIFT verdict.
  await seedNativeEvent("invoice.issued", "lgproof-nat-inv", {
    invoice_id: "lgp-nat-1",
    party_id: "party-bill-to",
    division: "main",
    lines: [{ line_no: 1, kind: "freight", amount_cents: 90_000, gl_map: "4000-REV" }],
  });
  invParityAfter = await computeModuleParity(POOL_DB, "invoicing");
  dispParityAfter = await computeModuleParity(POOL_DB, "dispatch");

  // ── KPI exclusion (Change D): a native quote.priced sets a real cost ratio; a legacy quote.priced (an events
  //    aggregate KPI reads) must NOT move it. Capture native-only, append legacy, capture again. ────────────────
  await seedNativeEvent("quote.priced", "lgproof-nat-qp", {
    sell: 100_000,
    lines: [{ kind: "freight", code: "std", amount_cents: 100_000 }],
    floors: { contribution: 80_000, full: 90_000, target: 95_000 },
    versions: { rate_config_ids: ["zt-x"] },
    basis: { anomaly: null },
  });
  costRatioNativeOnly = await computeCostRatioBps(POOL_DB);
  await stubFor("s:lgproof-qp").append({ tenant: TENANT, streamId: "s:lgproof-qp", input: legacyInput("s:lgproof-qp", "quote.priced", legacyQuotePayload) });
  costRatioWithLegacy = await computeCostRatioBps(POOL_DB);
});

describe("WP-15 Task 4b — source-aware ledger: legacy is a parity-only shadow (REQ-021/022/030)", () => {
  it("(1) the 3 GATED legacy kinds APPEND via the real DO — gate carve-out works, and they land with source='legacy'", async () => {
    for (const [id, sid] of [
      [legacyInvoiceEventId, "s:lgproof-inv"],
      [legacyApptEventId, "s:lgproof-appt"],
      [legacyDispatchEventId, "s:lgproof-disp"],
    ] as const) {
      expect(id).not.toBe(""); // the append returned (no GATE_BLOCK / throw)
      const row = await POOL_DB.prepare("SELECT source, stream_id FROM events WHERE id = ?").bind(id).first<{ source: string; stream_id: string }>();
      expect(row?.source).toBe("legacy"); // landed in `events` as the legacy shadow
      expect(row?.stream_id).toBe(sid);
    }
  });

  it("(2) the legacy events create ZERO native read-model rows — every projection was SKIPPED", async () => {
    // the money projection (definitive: a native invoice.issued ALWAYS projects money_lines + an invoices row):
    const ml = await POOL_DB.prepare("SELECT COUNT(*) AS n FROM money_lines WHERE event_id = ?").bind(legacyInvoiceEventId).first<{ n: number }>();
    expect(ml?.n).toBe(0);
    const inv = await POOL_DB.prepare("SELECT COUNT(*) AS n FROM invoices WHERE issued_event_id = ?").bind(legacyInvoiceEventId).first<{ n: number }>();
    expect(inv?.n).toBe(0);
    // the appointment projection (definitive: the pre-seeded pickup leg's slot would be CLAIMED by a native
    // appointment.set — it stays NULL, so the projection did not run for the legacy mirror record):
    const leg = await POOL_DB.prepare("SELECT appt_slot_key FROM legs WHERE shipment_id = ? AND kind = 'pickup'").bind("lgproof-appt").first<{ appt_slot_key: string | null }>();
    expect(leg?.appt_slot_key).toBe(null);
  });

  it("(3) computeModuleParity PICKS THEM UP as the legacy side — invoicing (Σ cents) + dispatch (count), end-to-end", async () => {
    // invoicing: legacy side rose by EXACTLY the mirrored invoice total; native side present ⇒ a real verdict.
    expect(num(invParityAfter.legacy_value) - num(invParityBefore.legacy_value)).toBe(LEGACY_INVOICE_TOTAL);
    expect(typeof invParityAfter.legacy_value).toBe("number");
    expect(typeof invParityAfter.native_value).toBe("number");
    expect(invParityAfter.status).not.toBe("UNKNOWN");
    // dispatch: a COUNT of dispatch.assigned + appointment.set — the legacy side gained exactly my 2 legacy facts.
    expect(num(dispParityAfter.legacy_value) - num(dispParityBefore.legacy_value)).toBe(2);
  });

  it("(4) a NATIVE invoice.issued with no POD is STILL GATE_BLOCKED — the I2 gate is intact for source='native'", async () => {
    const streamId = "s:lgproof-nat-nopod";
    await expect(
      stubFor(streamId).append({
        tenant: TENANT,
        streamId,
        input: {
          id: crypto.randomUUID(),
          shipment_id: "lgproof-nat-nopod",
          ts: 1_720_000_000_000,
          actor: { party: "party-bill-to" },
          party_refs: [],
          evidence: [],
          source: "native",
          confidence: 10_000,
          kind: "invoice.issued",
          payload: { invoice_id: "lgp-nopod", party_id: "party-bill-to", division: "main", lines: [{ line_no: 1, kind: "freight", amount_cents: 10_000, gl_map: "4000-REV" }] },
        },
      }),
    ).rejects.toThrow(/GATE_BLOCKED/);
    // nothing was written — the native gate blocks BEFORE the append.
    const n = await POOL_DB.prepare("SELECT COUNT(*) AS n FROM events WHERE stream_id = ?").bind(streamId).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("(6) readEvents (tenant lens) EXCLUDES the legacy shadow by DEFAULT (timeline/queues/export/copilot reconcile with the KPIs); includeShadow:true opts it back in", async () => {
    // DEFAULT: the native lens read of the legacy invoice's stream returns NOTHING — a source:'legacy' event
    // never surfaces on the Command timeline / queues / export / copilot grounding (all readEvents-backed).
    const def = await readEvents(POOL_DB, { scope: "tenant" }, { shipment_id: "lgproof-inv" });
    expect(def).toHaveLength(0);
    // OPT-IN (the Task-7 parity dashboard drill-through): includeShadow:true INCLUDES the legacy backing event.
    const opt = await readEvents(POOL_DB, { scope: "tenant" }, { shipment_id: "lgproof-inv", includeShadow: true });
    expect(opt.length).toBeGreaterThan(0);
    expect(opt.every((e) => e.source === "legacy")).toBe(true);
    expect(opt.map((e) => e.kind)).toContain("invoice.issued");
    // native/edi/email are STILL returned by the default read — the filter excludes ONLY legacy. The direct-
    // inserted NATIVE invoice on lgproof-nat-inv surfaces normally (proving the default is not a blanket block).
    const nat = await readEvents(POOL_DB, { scope: "tenant" }, { shipment_id: "lgproof-nat-inv" });
    expect(nat.map((e) => e.kind)).toContain("invoice.issued");
    expect(nat.every((e) => e.source === "native")).toBe(true);
  });

  it("(5) KPIs/AR exclude the legacy shadow — a legacy quote.priced does NOT move the native cost-ratio KPI; the legacy invoice backs no AR", async () => {
    // the cost-ratio KPI (an events-aggregate read, Change D) is a REAL number from the native quote and is
    // UNCHANGED by the legacy quote.priced — the `source IN ('native','edi','email')` filter excluded it.
    expect(costRatioNativeOnly).not.toBe("UNKNOWN");
    expect(costRatioWithLegacy).toBe(costRatioNativeOnly);
    // AR: the legacy invoice backs NO money_line and NO invoices row (re-asserted here as the AR statement of (2)).
    const ar = await POOL_DB.prepare("SELECT COUNT(*) AS n FROM money_lines WHERE event_id = ?").bind(legacyInvoiceEventId).first<{ n: number }>();
    expect(ar?.n).toBe(0);
  });
});
