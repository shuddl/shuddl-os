import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { EventKind } from "@shuddl/contracts";
import { capture, type CaptureParams, type DeviceContext, type EvidenceField } from "@shuddl/driver-core";
import { RecordingSender } from "@shuddl/agents";
import type { EvidenceSender } from "@shuddl/agents";
import { TERMINAL_HOLD_BODY_REF_PREFIX, terminalHoldBodyRef } from "@shuddl/ledger/queries/unbilled";
import { handlePodSigned, PodSignedMessage } from "../../agents/src/biller.js";
import type { BillerDeps, SeqStubLike } from "../../agents/src/biller.js";
import { RECON_MIN_AGE_MS, sweepTenantUnbilledRedrive } from "../../agents/src/recon-sweep.js";
import type { QueueLike } from "../../agents/src/recon-sweep.js";
import {
  ANOMALY_RATE_CONFIG,
  CONSENT,
  INSIDE,
  TENANT_SLUG,
  TEST_DEVICE_ID,
  TEST_RATE_CONFIG,
  ensureSchema,
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
  for (const id of ["recon-selfclear", "recon-bound", "recon-window", "recon-marker-golden", "recon-marker-noquote", "recon-marker-anomaly", "recon-otherscope"]) {
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
