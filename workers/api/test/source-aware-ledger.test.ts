import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { eventFixture, type EventKind } from "@shuddl/contracts";
import { eventToRow, readEvents } from "@shuddl/ledger/lens";
import { computeModuleParity, type ParityValue } from "@shuddl/ledger/parity";
import { computeCostRatioBps } from "@shuddl/ledger/queries/metrics";
import type { AppendedEvent } from "../src/do/sequencer.js";
import { ensureSchema, ensureTenantPlaneSchema, post, token, requiredEvidence, streamCount, TENANT_SLUG } from "./helpers.js";

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

/** §1179 — seedNativeEvent's twin for `source:'edi'`: a direct row insert, no DO, no projection. */
async function seedEdiEvent(kind: EventKind, shipmentId: string, payload: Record<string, unknown>): Promise<void> {
  const overrides: Record<string, unknown> = {
    id: crypto.randomUUID(),
    stream_id: `s:${shipmentId}`,
    shipment_id: shipmentId,
    seq: 0,
    source: "edi",
    visibility: "internal",
    party_refs: [],
    payload,
  };
  const row = eventToRow(eventFixture(kind, overrides));
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

  it("(7) GET /v1/events honors includeShadow=true — the legacy shadow surfaces on the Task-7 parity drill-through ONLY when opted in (REQ-021/152/153)", async () => {
    // The Command v_parity dashboard's LEGACY drill reads GET /v1/events?kind=...&includeShadow=true. Prove the
    // HTTP firehose (not just readEvents) honors the opt-in: DEFAULT excludes the legacy invoice; includeShadow=true
    // includes it. Runs on the pool tenant (its token resolves to POOL_DB via the beforeAll control row).
    const ops = await token({ sub: "lgp-shadow-ops", tenant: TENANT, role: "ops" });
    const url = (extra: string): string => `https://api.local/v1/events?kind=invoice.issued&limit=1000${extra}`;

    // DEFAULT: the firehose is native-visible only — the legacy invoice is ABSENT (reconciles with the KPIs).
    const def = await SELF.fetch(url(""), { headers: { Authorization: `Bearer ${ops}` } });
    expect(def.status).toBe(200);
    const defBody = (await def.json()) as { events: Array<{ id: string; source: string }> };
    expect(defBody.events.some((e) => e.id === legacyInvoiceEventId)).toBe(false);
    expect(defBody.events.every((e) => e.source !== "legacy")).toBe(true);

    // OPT-IN: includeShadow=true INCLUDES the legacy shadow row — the drill's LEGACY side sees the mirror fact.
    const opt = await SELF.fetch(url("&includeShadow=true"), { headers: { Authorization: `Bearer ${ops}` } });
    expect(opt.status).toBe(200);
    const optBody = (await opt.json()) as { events: Array<{ id: string; source: string }> };
    expect(optBody.events.some((e) => e.id === legacyInvoiceEventId && e.source === "legacy")).toBe(true);
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

  // §1179 (REQ-021/022/030) — THE CARVE-OUT IS `legacy`-ONLY, AND THAT BOUNDARY WAS UNDEFENDED.
  //
  // The sequencer keys three independent carve-outs on `source === "legacy"`: the I2 POD gate, the transition-
  // gate short-circuit, and the projection skip. `edi` and `email` are NOT exempt — sequencer.ts says so
  // explicitly ("Native (native/edi/email) is byte-for-byte UNCHANGED"). Nothing tested that boundary.
  //
  // MEASURED at §1179: widening each of the three from `=== "legacy"` to `!== "native"` — a one-token change,
  // and a plausible one, since the same file legitimately uses BOTH idioms — left 65 tests across four suites
  // GREEN. Test (4) above does not catch it: it pins the NATIVE side, and every widening keeps native gated.
  //
  // This matters live rather than theoretically. `map-204.ts` stamps `source: "edi"` on EVERY EDI-tendered
  // event (WP-12), so a widening would silently convert every partner load tender into an ungated, unprojected
  // shadow record — no POD requirement, no money_lines, no AR — while the suite stayed green.
  //
  // `edi` is the right probe value precisely because it is PRODUCED. `email` is declared in the enum and
  // produced by nothing (§1178), so a test keyed on it would pin a value no seam emits.
  function ediInput(streamId: string, kind: string, payload: Record<string, unknown>): Record<string, unknown> {
    return { ...legacyInput(streamId, kind, payload), source: "edi", actor: { party: "agent:translator" } };
  }

  it("(4b) §1179 an EDI-sourced invoice.issued with no POD is STILL GATE_BLOCKED — the I2 carve-out is legacy-ONLY", async () => {
    const streamId = "s:lgproof-edi-nopod";
    await expect(
      stubFor(streamId).append({
        tenant: TENANT,
        streamId,
        input: ediInput(streamId, "invoice.issued", {
          invoice_id: "lgp-edi-nopod",
          party_id: "party-bill-to",
          division: "main",
          lines: [{ line_no: 1, kind: "freight", amount_cents: 10_000, gl_map: "4000-REV" }],
        }),
      }),
    ).rejects.toThrow(/GATE_BLOCKED/);
    const n = await POOL_DB.prepare("SELECT COUNT(*) AS n FROM events WHERE stream_id = ?").bind(streamId).first<{ n: number }>();
    expect(n?.n, "the gate blocks BEFORE the append, exactly as for native").toBe(0);
  });

  it("(4c) §1179 an EDI-sourced gated kind is still GATE-CHECKED — the transition short-circuit is legacy-ONLY", async () => {
    // dispatch.assigned is one of the three gated kinds the legacy carve-out lets through unjudged. On a stream
    // with no prior booking it must be REFUSED when it arrives as `edi`.
    const streamId = "s:lgproof-edi-dispatch";
    await expect(
      stubFor(streamId).append({ tenant: TENANT, streamId, input: ediInput(streamId, "dispatch.assigned", legacyDispatchPayload) }),
    ).rejects.toThrow(/GATE_BLOCKED/);
    const n = await POOL_DB.prepare("SELECT COUNT(*) AS n FROM events WHERE stream_id = ?").bind(streamId).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("(4d) §1179 an EDI-sourced invoice IS PROJECTED — the parity-only shadow path is legacy-ONLY", async () => {
    // The projection skip is the carve-out with NO gate to announce it: a widened `isLegacy` commits the event
    // and simply grows no read-model, which is silent by construction — the reason it needs its own pin.
    //
    // Uses test (2)'s own definitive observable in mirror image: "a native invoice.issued ALWAYS projects
    // money_lines + an invoices row". `pod.signed` is not in GATED_KINDS, so an EDI POD seeds the stream and
    // satisfies I2; the invoice then commits on the SAME terms a native one would, and must project.
    const shipmentId = "lgproof-edi-proj";
    const streamId = `s:${shipmentId}`;
    // The invoice projection writes real AR rows which FK to shipments — seed one exactly as beforeAll does.
    await POOL_DB.prepare(
      "INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, created_ts) VALUES (?,?,?,?,0)",
    )
      .bind(shipmentId, "legacy-party", "legacy-party", "legacy-party")
      .run();
    // I2 needs a committed pod.signed on the stream. DIRECT-INSERT it with source='edi' (the suite's own
    // seedNativeEvent pattern) rather than appending it: appending a POD drives the custody projection and its
    // own FK web, which is a different subsystem than the one under test here. assertPodSigned reads `events`,
    // and 'edi' is native-visible, so this satisfies the gate exactly as a native POD would.
    await seedEdiEvent("pod.signed", shipmentId, {
      ...(eventFixture("pod.signed").payload as Record<string, unknown>),
      unwitnessed: true, // I4 — a custody event needs actor.device OR unwitnessed; an EDI POD has no device.
    });
    const appended = (await stubFor(streamId).append({
      tenant: TENANT,
      streamId,
      input: ediInput(streamId, "invoice.issued", {
        invoice_id: "lgp-edi-proj",
        party_id: "legacy-party",
        division: "main",
        lines: [{ line_no: 1, kind: "freight", amount_cents: 12_500, gl_map: "4000-REV" }],
      }),
    })) as AppendedEvent;

    const row = await POOL_DB.prepare("SELECT source FROM events WHERE id = ?").bind(appended.id).first<{ source: string }>();
    expect(row?.source, "it lands as edi — the DO does not coerce a DO-direct append").toBe("edi");
    const ml = await POOL_DB.prepare("SELECT COUNT(*) AS n FROM money_lines WHERE event_id = ?").bind(appended.id).first<{ n: number }>();
    expect(ml?.n, "an EDI invoice projects money_lines exactly like a native one — it is NOT a parity-only shadow").toBeGreaterThan(0);
    const inv = await POOL_DB.prepare("SELECT COUNT(*) AS n FROM invoices WHERE issued_event_id = ?").bind(appended.id).first<{ n: number }>();
    expect(inv?.n, "and it backs a real AR row").toBe(1);
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

// WP-15 Task 4b (REQ-030/021) — THE FORGEABILITY LOCK, at the ROUTE (over real HTTP via `post`). The single
// most security-critical line is events.ts:200 (force source:'native'). These tests prove a CLIENT cannot forge
// `source:'legacy'` to reach the DO's legacy gate-carve-out. Run on tenant-a (ensureSchema seeds it); the forged
// gated append is GATE_BLOCKED so NOTHING lands — no parity pollution.
describe("WP-15 Task 4b — the forgeability lock at the events route (REQ-030/021)", () => {
  const evt = (shipmentId: string, kind: string, payload: Record<string, unknown>): Record<string, unknown> => ({
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: 1_720_000_000_000,
    actor: { party: "party-carrier" },
    party_refs: [],
    evidence: [],
    source: "legacy", // the FORGERY — the route MUST coerce this to native before the DO append
    confidence: 10_000,
    kind,
    payload,
  });

  it("a client POST of a GATED kind with source:'legacy' is COERCED to native → the native gate FIRES → GATE_BLOCKED, nothing lands", async () => {
    // dispatch.assigned is a CLIENT-APPENDABLE gated kind (unlike invoice.issued, which the route refuses upstream
    // as server-emitted — see the belt below). Forged source:'legacy' + no appointment/docs on the stream: the
    // route coerces to native, so #enforceDispatch runs and BLOCKS. This is the RED-sensitive proof — removing the
    // events.ts:200 coercion lets the legacy source survive → the DO gate-EXEMPTS it → it would 201-append instead.
    const ops = await token({ sub: "lgp-forge-ops", tenant: TENANT_SLUG, role: "ops" });
    const r = await post("lgp-forge-disp", evt("lgp-forge-disp", "dispatch.assigned", { driver_user_id: "d-forge" }), ops);
    expect(r.status).toBe(403);
    expect(requiredEvidence(r).length).toBeGreaterThan(0); // GATE_BLOCKED carries the missing evidence
    expect(await streamCount("lgp-forge-disp")).toBe(0); // append-on-block is impossible — nothing forged in
  });

  it("a client POST that COMMITS lands source='native' (the coercion is real, not just a gate side effect)", async () => {
    const ops = await token({ sub: "lgp-forge-ops2", tenant: TENANT_SLUG, role: "ops" });
    // quote.requested is ungated → it commits. Posted with source:'legacy'; the response event + the stored row
    // must both read source='native'.
    const r = await post("lgp-forge-commit", evt("lgp-forge-commit", "quote.requested", { request: { origin_zip: "97201", dest_zip: "98101" } }), ops);
    expect(r.status).toBe(201);
    expect(r.json?.source).toBe("native"); // the committed event, as returned by the route
    const row = await env.TENANT_A_DB.prepare("SELECT source FROM events WHERE stream_id = ? ORDER BY seq DESC LIMIT 1").bind("s:lgp-forge-commit").first<{ source: string }>();
    expect(row?.source).toBe("native"); // and as stored in the ledger
  });

  it("belt: invoice.issued is refused UPSTREAM as server-emitted (a second, independent lock) — never reaches the append", async () => {
    // invoice.issued can never be client-appended via this route (SERVER_EMITTED_KINDS), so the forged legacy
    // source is moot for it — a plain FORBIDDEN, not a GATE_BLOCKED (no required_evidence). Documents the layering.
    const ops = await token({ sub: "lgp-forge-ops3", tenant: TENANT_SLUG, role: "ops" });
    const r = await post(
      "lgp-forge-inv",
      evt("lgp-forge-inv", "invoice.issued", { invoice_id: "f1", party_id: "party-bill-to", division: "main", lines: [{ line_no: 1, kind: "freight", amount_cents: 10_000, gl_map: "4000-REV" }] }),
      ops,
    );
    expect(r.status).toBe(403);
    expect(requiredEvidence(r)).toHaveLength(0); // FORBIDDEN (server-emitted), not a gate block
    expect(await streamCount("lgp-forge-inv")).toBe(0);
  });
});

// I1 (genesis/10) — NO MONEY_LINE WITHOUT AN EVENT, AND D1 ACTUALLY ENFORCES IT (audit §535).
//
// `money_lines.event_id TEXT NOT NULL REFERENCES events(id)` carries the comment *"I1: no line without
// event, ever"*. A `REFERENCES` clause is a DECLARATION; whether it is a CONSTRAINT depends on the engine —
// SQLite ships `PRAGMA foreign_keys` OFF by default, and a decorative FK on the money table would let an
// orphan line exist with nothing pointing at the fact that produced it.
//
// `check:invariants` proves the clause is WRITTEN. Nothing proved D1 ENFORCES it. Measured (§535): an
// otherwise-valid insert naming a non-existent event is rejected with
// `D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT`.
//
// This pins a PLATFORM behaviour rather than our own code — which is exactly the kind that changes without
// a commit in this repo, and the kind a green suite would never notice losing.
describe("I1 (genesis/10): D1 enforces the money_lines → events foreign key", () => {
  it("an otherwise-valid money_line naming a non-existent event is REJECTED by the database", async () => {
    await ensureSchema(env);
    // Every column present and valid EXCEPT event_id — so the only thing that can reject this row is the
    // foreign key. The first version of this probe omitted party_id and was rejected by a NOT NULL, which
    // is a real refusal for the wrong reason and proves nothing about I1 (audit §535).
    const insert = env.TENANT_A_DB.prepare(
      "INSERT INTO money_lines (id, shipment_id, event_id, line_no, direction, kind, amount_cents, currency, party_id, division, gl_map, basis, created_ts) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind("ml-i1-orphan", "shp-i1", "evt-that-does-not-exist", 1, "ar", "freight", 100, "USD", "party-i1", "div", "{}", "{}", 1);

    await expect(insert.run(), "a money_line with no backing event must not be insertable").rejects.toThrow(/FOREIGN KEY constraint failed/);

    const count = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS n FROM money_lines WHERE id = ?")
      .bind("ml-i1-orphan")
      .first<{ n: number }>();
    expect(count?.n, "and nothing was written").toBe(0);
  });
});
