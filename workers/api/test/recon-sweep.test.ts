import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { eventFixture, type EventKind } from "@shuddl/contracts";
import { capture, type CaptureParams, type DeviceContext, type EvidenceField } from "@shuddl/driver-core";
import { RecordingSender } from "@shuddl/agents";
import type { EvidenceSender } from "@shuddl/agents";
import { eventToRow } from "@shuddl/ledger/lens";
import { TERMINAL_HOLD_BODY_REF_PREFIX, terminalHoldBodyRef } from "@shuddl/ledger/queries/unbilled";
import { reconcileCreditForParty } from "@shuddl/ledger/reconcile/credit";
import { CREDIT_PROJECTION_GAP_RULE } from "@shuddl/ledger/projection/status-cache";
import { handlePodSigned, PodSignedMessage } from "../../agents/src/biller.js";
import type { BillerDeps, SeqStubLike } from "../../agents/src/biller.js";
import { RECON_MIN_AGE_MS, sweepTenantUnbilledRedrive } from "../../agents/src/recon-sweep.js";
import type { QueueLike } from "../../agents/src/recon-sweep.js";
import { runWatchtowerSweep, watchtowerAlarmId } from "../../agents/src/watchtower.js";
import {
  ANOMALY_RATE_CONFIG,
  CONSENT,
  INSIDE,
  TENANT_SLUG,
  TEST_DEVICE_ID,
  TEST_RATE_CONFIG,
  ensureSchema,
  ensureTenantBSchema,
  nextEvidenceBytes,
  post,
  retryOnDoInvalidation,
  seedDeliveryLeg,
  seedRateConfig,
  seedShipment,
  testDeviceSigningKey,
  token,
  type Res,
} from "./helpers.js";

// ─── WP-11 Task 13 — THE BILLER RECONCILIATION SWEEP (REQ-169) ─────────────────────────────────────
//
// A committed pod.signed normally triggers the Biller VIA the queue. If that trigger is LOST (the
// commit→enqueue crash window), the POD is never billed — a silent revenue leak. This sweep, running
// per-tenant on the agents cron, RE-ENQUEUES any stream with a committed pod.signed but NO invoice.issued
// AND no terminal hold-marker, older than N minutes — closing the window. The whole Biller pipeline is
// idempotent (deterministic invoice id + DO dedupe), so re-driving is safe.
//
// THE BOUNDING PROBLEM: a PERMANENT Biller hold (below_floor / no_quote / interline_unresolved / anomaly)
// used to append NOTHING — so a pod-without-invoice anti-join would re-enqueue a permanently-held POD every
// cron cycle, forever. The fix: the Biller writes a durable, idempotent HOLD MARKER
// (message.received{note,internal}) on a terminal hold; the recon anti-join EXCLUDES any shipment with a
// marker → a held POD is re-enqueued AT MOST until the marker is written (once), then NEVER again.
//
// VENUE (like biller.test / sla-sweep.test): the real ShipmentSequencer DO + migrated tenant D1 live only in
// this api harness; the per-tenant sweep FUNCTION is imported from the agents worker and driven directly with
// an INJECTED clock + an INJECTED recording queue (the queue producer is cross-isolate in prod). isolatedStorage
// is OFF (shared D1), so every case scopes the sweep to its OWN shipment id.

const TENANT = TENANT_SLUG;
const REFERRAL_BASE = "https://shuddl.tech";
const BILL_TO_EMAIL = "billing@bill-to.test";
const MIN_AGE = RECON_MIN_AGE_MS;

// ── driver-core capture plumbing (mirrors biller.test; own counters, own streams) ──────────────────────
let deviceCtx: DeviceContext;
let opsTok: string;
let deviceSeq = 70_000; // distinct base from other files (own streams anyway)
let clock = 1_733_000_000_000;

async function driveStep(shipmentId: string, kind: EventKind, payload: Record<string, unknown>, evidenceField?: EvidenceField): Promise<Res> {
  const ts = clock++;
  const params: CaptureParams = { shipment_id: shipmentId, kind, payload, ts, captured_ts: ts, actor_user: "user-driver" };
  if (evidenceField !== undefined) params.evidence = { bytes: nextEvidenceBytes(), field: evidenceField };
  const { event } = await capture(params, deviceCtx);
  return post(shipmentId, event, opsTok);
}

async function priceQuote(shipmentId: string, opts: { anomalous?: boolean } = {}): Promise<number> {
  await seedRateConfig(env.TENANT_A_DB, opts.anomalous ? ANOMALY_RATE_CONFIG : TEST_RATE_CONFIG);
  const res = await SELF.fetch("https://api.local/v1/rate", {
    method: "POST",
    headers: { Authorization: `Bearer ${opsTok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify({
      shipment_id: shipmentId,
      origin_zip: "97201",
      dest_zip: "80012",
      weight_lb: opts.anomalous ? 1 : 1000,
      dims: { l_in: 48, w_in: 40, h_in: 48, pieces: 2 },
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string; sell_cents: number };
  expect(body.status).toBe("PRICED");
  return body.sell_cents;
}

// The full gated delivery flow up to and including pod.signed (the Biller's trigger). Returns the committed
// pod.signed event id AND its recorded_at (the commit instant the age filter measures against).
async function driveToPod(shipmentId: string): Promise<{ podId: string; recordedAt: number }> {
  expect((await driveStep(shipmentId, "document.attached", { ...CONSENT })).status).toBe(201);
  expect((await driveStep(shipmentId, "stop.arrived", { geo: { ...INSIDE }, auto: false })).status).toBe(201);
  expect((await driveStep(shipmentId, "freight.photographed", { photo_kind: "placed" }, "photo_hash")).status).toBe(201);
  const signed = await driveStep(shipmentId, "pod.signed", { geo: { ...INSIDE } }, "signature_hash");
  expect(signed.status, JSON.stringify(signed.json)).toBe(201);
  const podId = (signed.json as { id: string }).id;
  const rec = await env.TENANT_A_DB.prepare("SELECT recorded_at FROM events WHERE id = ?").bind(podId).first<{ recorded_at: number }>();
  return { podId, recordedAt: rec!.recorded_at };
}

// ── consumer deps against the REAL DO + D1 (retry-wrapped: pool-workers may invalidate the DO mid-run) ──
const seqStub: SeqStubLike = {
  append: (req) =>
    retryOnDoInvalidation(() => (env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${req.tenant}|${req.streamId}`)) as unknown as SeqStubLike).append(req)),
};
function depsWith(sender: EvidenceSender): BillerDeps {
  return { db: env.TENANT_A_DB, seq: seqStub, sender, referralBase: REFERRAL_BASE };
}
function msgFor(shipmentId: string, podEventId: string): PodSignedMessage {
  return { kind: "pod.signed", tenant: TENANT, shipment_id: shipmentId, event_id: podEventId };
}

// A unique 64-hex EVENT hash — keeps the UNIQUE(hash) + append-only insert guard happy for a direct-seeded
// event on the shared D1 (distinct from the sequencer-produced hashes the other cases use).
const randomHex64 = (): string => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");

// Direct-insert a committed `pod.signed` on a stream (bypasses the sequencer + gates, mirrors watchtower.test's
// seedEvent). This seeds ONLY the ledger event — never a shipments row — so whether the stream is "booked"
// (billable) is decided SOLELY by whether the caller separately seedShipment'd it. Returns the pod event id.
async function seedPodEvent(shipmentId: string, recordedAt: number): Promise<string> {
  const id = crypto.randomUUID();
  const e = eventFixture("pod.signed", {
    id,
    stream_id: `s:${shipmentId}`,
    shipment_id: shipmentId,
    seq: 0,
    ts: recordedAt,
    recorded_at: recordedAt,
    visibility: "internal",
    party_refs: [],
  });
  const row = eventToRow(e);
  row.hash = randomHex64();
  const cols = Object.keys(row);
  await env.TENANT_A_DB.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .bind(...cols.map((c) => row[c]))
    .run();
  return id;
}

// A recording queue producer — the injected re-enqueue seam (prod binds env.AGENT_QUEUE, cross-isolate).
class RecordingQueue implements QueueLike {
  readonly messages: PodSignedMessage[] = [];
  async send(m: unknown): Promise<void> {
    this.messages.push(PodSignedMessage.parse(m)); // records + proves the re-enqueued shape satisfies the consumer's Zod boundary
  }
}

// ── DB probes ────────────────────────────────────────────────────────────────────────────────────────
async function invoiceCount(shipmentId: string): Promise<number> {
  const r = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS n FROM events WHERE stream_id = ? AND kind = 'invoice.issued'").bind(`s:${shipmentId}`).first<{ n: number }>();
  return r?.n ?? 0;
}
// The internal terminal-hold marker notes on a shipment stream (message.received{channel:note}).
async function holdNotes(shipmentId: string): Promise<{ id: string; visibility: string; body_ref: string }[]> {
  const res = await env.TENANT_A_DB.prepare(
    "SELECT id, visibility, json_extract(payload,'$.body_ref') AS body_ref FROM events WHERE stream_id = ?1 AND kind = 'message.received' AND json_extract(payload,'$.channel') = 'note' ORDER BY seq",
  )
    .bind(`s:${shipmentId}`)
    .all<{ id: string; visibility: string; body_ref: string }>();
  return res.results.filter((n) => n.body_ref.startsWith(TERMINAL_HOLD_BODY_REF_PREFIX));
}

beforeAll(async () => {
  await ensureSchema(env);
  deviceCtx = { device_id: TEST_DEVICE_ID, privateKey: await testDeviceSigningKey(), party: "party-carrier", nextSeq: () => deviceSeq++ };
  opsTok = await token({ sub: "u-recon-ops", tenant: TENANT, role: "ops" });
  // The bill-to party's billing email — the honest recipient the Biller resolves for a re-driven bill.
  await env.TENANT_A_DB.prepare("UPDATE parties SET contacts = ? WHERE id = 'party-bill-to'").bind(JSON.stringify([{ kind: "billing", email: BILL_TO_EMAIL }])).run();
  for (const id of ["recon-selfclear", "recon-bound", "recon-window", "recon-marker-golden", "recon-marker-noquote", "recon-marker-anomaly", "recon-otherscope", "recon-orphan-booked"]) {
    await seedShipment(id);
    await seedDeliveryLeg(id);
  }
});

describe("Biller reconciliation sweep — self-clearing re-enqueue (REQ-169)", () => {
  it("SELF-CLEARING (billed): a lost-trigger POD older than N min is RE-ENQUEUED → the Biller re-drives → invoice.issued → the stream drops out; the re-drive is idempotent (no double invoice)", async () => {
    const shp = "recon-selfclear";
    await priceQuote(shp);
    const { podId, recordedAt } = await driveToPod(shp); // the trigger was "lost" — the Biller never ran
    expect(await invoiceCount(shp)).toBe(0);

    // Sweep AFTER the window: the recon anti-join finds it and re-enqueues EXACTLY the consumer's message.
    const q1 = new RecordingQueue();
    await sweepTenantUnbilledRedrive(env.TENANT_A_DB, q1, TENANT, recordedAt + MIN_AGE + 1, { scope: shp, minAgeMs: MIN_AGE });
    expect(q1.messages).toEqual([msgFor(shp, podId)]);

    // Drive the Biller on the re-enqueued trigger (prod: the queue consumer does this) → it bills.
    const sender = new RecordingSender();
    const outcome = await handlePodSigned(q1.messages[0]!, depsWith(sender));
    expect(outcome.status, JSON.stringify(outcome)).toBe("issued_sent");
    expect(await invoiceCount(shp)).toBe(1);

    // SELF-CLEARING: the stream now has an invoice → the second sweep re-enqueues NOTHING.
    const q2 = new RecordingQueue();
    const r2 = await sweepTenantUnbilledRedrive(env.TENANT_A_DB, q2, TENANT, recordedAt + MIN_AGE + 1, { scope: shp, minAgeMs: MIN_AGE });
    expect(q2.messages).toHaveLength(0);
    expect(r2.enqueued).toBe(0);

    // IDEMPOTENT re-drive: even if the queue redelivered again, the Biller produces no second invoice.
    await handlePodSigned(msgFor(shp, podId), depsWith(new RecordingSender()));
    expect(await invoiceCount(shp)).toBe(1);
  });

  it("BOUNDING (held): a permanently-held POD is re-enqueued at most ONCE — the Biller writes the hold marker, then the recon anti-join EXCLUDES it (no re-enqueue on the 2nd sweep)", async () => {
    const shp = "recon-bound"; // no quote priced → the Biller HOLDS permanently (no_quote)
    const { podId, recordedAt } = await driveToPod(shp);
    expect(await invoiceCount(shp)).toBe(0);
    expect(await holdNotes(shp)).toHaveLength(0); // no marker yet — the trigger was lost, the Biller never ran

    // Sweep #1: no invoice, no marker, old enough → re-enqueue.
    const q1 = new RecordingQueue();
    await sweepTenantUnbilledRedrive(env.TENANT_A_DB, q1, TENANT, recordedAt + MIN_AGE + 1, { scope: shp, minAgeMs: MIN_AGE });
    expect(q1.messages).toEqual([msgFor(shp, podId)]);

    // Drive the Biller: it HOLDS (no_quote) AND writes the durable, internal hold marker.
    const outcome = await handlePodSigned(q1.messages[0]!, depsWith(new RecordingSender()));
    expect(outcome.status, JSON.stringify(outcome)).toBe("held");
    if (outcome.status !== "held") throw new Error("unreachable");
    expect(outcome.reason).toBe("no_quote");
    const notes = await holdNotes(shp);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.visibility).toBe("internal"); // surfaced as an internal ops note (REQ-036), redacted from the counterparty
    expect(notes[0]!.body_ref).toBe(terminalHoldBodyRef(shp, "no_quote"));

    // THE BOUNDING PROOF: sweep #2 — the marker now EXCLUDES the stream → re-enqueues NOTHING. Bounded.
    const q2 = new RecordingQueue();
    const r2 = await sweepTenantUnbilledRedrive(env.TENANT_A_DB, q2, TENANT, recordedAt + MIN_AGE + 1, { scope: shp, minAgeMs: MIN_AGE });
    expect(q2.messages).toHaveLength(0);
    expect(r2.enqueued).toBe(0);

    // The marker is idempotent: re-driving the Biller writes NO second marker (deterministic id → DO dedupe).
    await handlePodSigned(msgFor(shp, podId), depsWith(new RecordingSender()));
    expect(await holdNotes(shp)).toHaveLength(1);
  });

  it("THE WINDOW: a freshly-signed POD (younger than N min) is NOT swept; once past the window it IS", async () => {
    const shp = "recon-window";
    await priceQuote(shp);
    const { podId, recordedAt } = await driveToPod(shp);

    // Younger than the window — the commit→enqueue trigger may still be in flight; do NOT race it.
    const qFresh = new RecordingQueue();
    await sweepTenantUnbilledRedrive(env.TENANT_A_DB, qFresh, TENANT, recordedAt + MIN_AGE - 1, { scope: shp, minAgeMs: MIN_AGE });
    expect(qFresh.messages).toHaveLength(0);

    // Past the window — now it is a genuinely-lost trigger and gets re-enqueued.
    const qOld = new RecordingQueue();
    await sweepTenantUnbilledRedrive(env.TENANT_A_DB, qOld, TENANT, recordedAt + MIN_AGE + 1, { scope: shp, minAgeMs: MIN_AGE });
    expect(qOld.messages).toEqual([msgFor(shp, podId)]);
  });

  it("TENANT/SCOPE SAFETY: the sweep re-enqueues ONLY the scoped stream — a sibling unbilled POD outside the scope is never touched (REQ-025 discipline)", async () => {
    const shp = "recon-otherscope";
    await priceQuote(shp);
    const { recordedAt } = await driveToPod(shp);

    // Sweep scoped to a DIFFERENT shipment — this unbilled POD must not be enqueued.
    const q = new RecordingQueue();
    await sweepTenantUnbilledRedrive(env.TENANT_A_DB, q, TENANT, recordedAt + MIN_AGE + 1, { scope: "recon-selfclear", minAgeMs: MIN_AGE });
    expect(q.messages.some((m) => m.shipment_id === shp)).toBe(false);
  });
});

describe("Biller terminal-hold marker — emitted on holds only, never the golden path (REQ-169/036)", () => {
  it("GOLDEN PATH writes NO marker (the invoice/evidence path is unchanged)", async () => {
    const shp = "recon-marker-golden";
    await priceQuote(shp);
    const { podId } = await driveToPod(shp);
    const outcome = await handlePodSigned(msgFor(shp, podId), depsWith(new RecordingSender()));
    expect(outcome.status).toBe("issued_sent");
    expect(await holdNotes(shp)).toHaveLength(0); // a billed POD is not a hold — no marker
    expect(await invoiceCount(shp)).toBe(1);
  });

  it("NO-QUOTE hold (a direct terminal branch) writes an internal marker keyed by (shipment, reason)", async () => {
    const shp = "recon-marker-noquote";
    const { podId } = await driveToPod(shp); // no priceQuote → held(no_quote)
    const outcome = await handlePodSigned(msgFor(shp, podId), depsWith(new RecordingSender()));
    expect(outcome.status).toBe("held");
    const notes = await holdNotes(shp);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body_ref).toBe(terminalHoldBodyRef(shp, "no_quote"));
    expect(notes[0]!.visibility).toBe("internal");
  });

  it("ANOMALY hold (the composed-invoice terminal branch, the $222k case) ALSO writes an internal marker (REQ-040)", async () => {
    const shp = "recon-marker-anomaly";
    await priceQuote(shp, { anomalous: true });
    const { podId } = await driveToPod(shp);
    const outcome = await handlePodSigned(msgFor(shp, podId), depsWith(new RecordingSender()));
    expect(outcome.status).toBe("held");
    if (outcome.status !== "held") throw new Error("unreachable");
    expect(outcome.reason).toBe("anomaly");
    const notes = await holdNotes(shp);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body_ref).toBe(terminalHoldBodyRef(shp, "anomaly"));
    expect(await invoiceCount(shp)).toBe(0); // the anomaly never auto-invoices — permanent hold
  });
});

// ─── WP-11 exit audit — REQ-199: the recon re-drive EXCLUDES un-booked (orphan) POD streams ────────────
//
// An orphan `pod.signed` — a committed POD on a stream with NO `shipments` row (an un-booked / legacy-replayed
// stream) — can NEVER be billed: the Biller returns `shipment_not_found` and writes no marker, so a
// pod-without-invoice-without-marker anti-join would re-enqueue it EVERY cron tick, forever (unbounded, futile).
// unbilledRedriveSql now appends `AND EXISTS (shipments row)` so the re-drive skips it. The SHARED
// unbilledShipmentsSql is UNCHANGED, so the Watchtower `unbilled` alarm STILL surfaces the orphan — the data
// fault is reported to ops, just not futilely re-driven.
describe("Biller reconciliation sweep — REQ-199: excludes orphan (un-booked) POD streams, but the Watchtower still surfaces them", () => {
  it("an ORPHAN pod.signed (no shipments row) is NEVER re-enqueued while a BOOKED pod on the same sweep IS — yet the orphan STILL fires the Watchtower 'unbilled' alarm (surfaced, not re-driven)", async () => {
    const orphan = "recon-orphan-nobook"; // deliberately NOT seedShipment'd → NO shipments row (un-booked)
    const booked = "recon-orphan-booked"; // seeded in beforeAll → HAS a shipments row (billable)
    const BASE = 1_733_500_000_000;

    // Seed a committed pod.signed on EACH stream, directly. The ONLY difference between the two is whether a
    // shipments row exists — both are pod.signed-without-invoice (unbilled) and neither carries a hold marker.
    const orphanPodId = await seedPodEvent(orphan, BASE);
    const bookedPodId = await seedPodEvent(booked, BASE);

    // Age both past the recon window; sweep the shared "recon-orphan-" prefix covering BOTH streams.
    const now = BASE + MIN_AGE + 1;
    const q = new RecordingQueue();
    const res = await sweepTenantUnbilledRedrive(env.TENANT_A_DB, q, TENANT, now, { scope: "recon-orphan-", minAgeMs: MIN_AGE });

    // The booked stream is re-enqueued; the orphan is EXCLUDED (REQ-199 — no shipments row → futile to re-drive).
    expect(res.enqueued).toBe(1);
    expect(q.messages).toEqual([msgFor(booked, bookedPodId)]);
    expect(q.messages.some((m) => m.shipment_id === orphan), "the orphan pod is never re-enqueued").toBe(false);
    // Guard against a false pass: the booked POD IS the one enqueued (the normal re-drive path still works).
    expect(q.messages[0]!.event_id).toBe(bookedPodId);
    void orphanPodId;

    // BUT the fault is NOT hidden: the SHARED unbilled predicate (unchanged) still surfaces the orphan. Scope the
    // Watchtower sweep to the orphan alone → its 'unbilled' alarm RAISES, proving the orphan is reported, not lost.
    const wt = await runWatchtowerSweep(env.TENANT_A_DB, TENANT, now, { scope: orphan });
    expect(wt.unbilled.count, "the orphan is a genuine POD-without-invoice — the alarm must see it").toBe(1);
    const alarm = await env.TENANT_A_DB.prepare("SELECT rule, status FROM anomalies WHERE id = ?")
      .bind(watchtowerAlarmId(TENANT, "unbilled", { scope: orphan }))
      .first<{ rule: string; status: string }>();
    expect(alarm, "the orphan STILL raises the Watchtower unbilled alarm").not.toBeNull();
    expect(alarm!.rule).toBe("unbilled");
    expect(alarm!.status).toBe("open");
  });
});

// ─── Task 6 (REQ-042/183) — THE CREDIT PROJECTION-GAP RECONCILIATION ────────────────────────────────
//
// A historical/imported credit.checked whose party had not materialized leaves an OPEN credit_projection_gap
// anomaly and an UNPROJECTED parties.credit_status — a silent-defeat risk (a later booking reads NULL and passes
// as if clear). The SHARED ledger reconcile fn (packages/ledger/src/reconcile/credit.ts) — invoked by the DO
// booking gate AND the agents cron — applies the LATEST valid decision once the party exists and marks the gap
// resolved, in ONE idempotent D1 batch. FAIL CLOSED: while the party is absent or no decision is on file it does
// NOTHING (the gap stays open, booking stays blocked). It NEVER fabricates a party (append-only law).

describe("Task 6 — credit projection-gap reconciliation (shared ledger fn, REQ-042/183/025)", () => {
  const CREDIT_HEX = randomHex64;

  async function partyCredit(db: D1Database, id: string): Promise<string | null> {
    const r = await db.prepare("SELECT credit_status FROM parties WHERE id = ?").bind(id).first<{ credit_status: string | null }>();
    return r?.credit_status ?? null;
  }
  async function gapStatus(db: D1Database, id: string): Promise<string | null> {
    const r = await db.prepare("SELECT status FROM anomalies WHERE id = ?").bind(id).first<{ status: string }>();
    return r?.status ?? null;
  }
  // Direct-seed a committed credit.checked on a shipment stream (bypasses the sequencer, mirrors seedPodEvent) —
  // simulating a historical/imported decision. Distinct recorded_at controls the latest-wins ordering.
  async function seedCredit(db: D1Database, sid: string, partyId: string, status: string, recordedAt: number): Promise<string> {
    const e = eventFixture("credit.checked", {
      id: crypto.randomUUID(),
      stream_id: `s:${sid}`,
      shipment_id: sid,
      seq: 0,
      ts: recordedAt,
      recorded_at: recordedAt,
      visibility: "internal",
      party_refs: [],
      payload: { party_id: partyId, status },
    });
    const row = eventToRow(e);
    row.hash = CREDIT_HEX();
    const cols = Object.keys(row);
    await db.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...cols.map((c) => row[c])).run();
    return e.id;
  }
  async function seedGap(db: D1Database, id: string, partyId: string): Promise<void> {
    await db
      .prepare("INSERT OR IGNORE INTO anomalies (id, rule, object_kind, object_id, severity, detail, status) VALUES (?,?,?,?,?,?,'open')")
      .bind(id, CREDIT_PROJECTION_GAP_RULE, "party", partyId, "critical", "{}")
      .run();
  }
  async function seedParty(db: D1Database, id: string): Promise<void> {
    await db.prepare("INSERT OR IGNORE INTO parties (id, kind, names, contacts) VALUES (?,?,?,?)").bind(id, "broker", "{}", "[]").run();
  }

  it("party creation + reconcile applies the latest valid decision and resolves the anomaly; re-running is idempotent", async () => {
    const P = "party-t6-recon";
    const gapId = "credit-projection-gap:t6-recon-1";
    await seedCredit(env.TENANT_A_DB, "t6cr-recon", P, "hold", 1_000);
    await seedGap(env.TENANT_A_DB, gapId, P);

    // party ABSENT → reconcile is a FAIL-CLOSED no-op (gap stays open; NO party fabricated)
    const before = await reconcileCreditForParty(env.TENANT_A_DB, P);
    expect(before.resolved).toBe(false);
    expect(before.applied_status).toBeNull();
    expect(await partyCredit(env.TENANT_A_DB, P)).toBeNull();
    expect(await gapStatus(env.TENANT_A_DB, gapId)).toBe("open");
    expect(await env.TENANT_A_DB.prepare("SELECT 1 AS x FROM parties WHERE id = ?").bind(P).first()).toBeNull();

    // create the party → reconcile applies the hold + resolves the gap, in one batch
    await seedParty(env.TENANT_A_DB, P);
    const res = await reconcileCreditForParty(env.TENANT_A_DB, P);
    expect(res.resolved).toBe(true);
    expect(res.applied_status).toBe("hold");
    expect(await partyCredit(env.TENANT_A_DB, P)).toBe("hold");
    expect(await gapStatus(env.TENANT_A_DB, gapId)).toBe("resolved");

    // IDEMPOTENT — a second run changes nothing and does not throw
    await reconcileCreditForParty(env.TENANT_A_DB, P);
    expect(await partyCredit(env.TENANT_A_DB, P)).toBe("hold");
    expect(await gapStatus(env.TENANT_A_DB, gapId)).toBe("resolved");
  });

  it("a later CLEAR supersedes an earlier HOLD (the latest valid decision wins)", async () => {
    const P = "party-t6-supersede";
    const gapId = "credit-projection-gap:t6-supersede-1";
    await seedParty(env.TENANT_A_DB, P);
    await seedCredit(env.TENANT_A_DB, "t6cr-sup-a", P, "hold", 1_000); // earlier
    await seedCredit(env.TENANT_A_DB, "t6cr-sup-b", P, "clear", 2_000); // later — higher recorded_at wins
    await seedGap(env.TENANT_A_DB, gapId, P);

    const res = await reconcileCreditForParty(env.TENANT_A_DB, P);
    expect(res.applied_status).toBe("clear");
    expect(await partyCredit(env.TENANT_A_DB, P)).toBe("clear");
    expect(await gapStatus(env.TENANT_A_DB, gapId)).toBe("resolved");
  });

  it("REQ-025 isolation — a cross-tenant credit.checked / gap NEVER affects the current tenant", async () => {
    await ensureTenantBSchema(env);
    const P = "party-t6-xtenant";
    const gapA = "credit-projection-gap:t6-xtenant-A";
    const gapB = "credit-projection-gap:t6-xtenant-B";
    // tenant A: party + a HOLD decision + an open gap
    await seedParty(env.TENANT_A_DB, P);
    await seedCredit(env.TENANT_A_DB, "t6cr-xt-a", P, "hold", 1_000);
    await seedGap(env.TENANT_A_DB, gapA, P);
    // tenant B: the SAME party id + a CLEAR decision (later) + an open gap — must never leak into A
    await seedParty(env.TENANT_B_DB, P);
    await seedCredit(env.TENANT_B_DB, "t6cr-xt-b", P, "clear", 5_000);
    await seedGap(env.TENANT_B_DB, gapB, P);

    // reconcile ONLY tenant A → applies A's HOLD, never B's later CLEAR
    const res = await reconcileCreditForParty(env.TENANT_A_DB, P);
    expect(res.applied_status).toBe("hold");
    expect(await partyCredit(env.TENANT_A_DB, P)).toBe("hold");
    expect(await gapStatus(env.TENANT_A_DB, gapA)).toBe("resolved");
    // tenant B is UNTOUCHED — no leak in either direction
    expect(await partyCredit(env.TENANT_B_DB, P)).toBeNull();
    expect(await gapStatus(env.TENANT_B_DB, gapB)).toBe("open");
  });
});
