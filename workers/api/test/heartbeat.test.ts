import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyChain } from "@shuddl/ledger/chain";
import { rowToEvent } from "@shuddl/ledger/lens";
import type { EventKind, LedgerEvent } from "@shuddl/contracts";
import { capture, type CaptureParams, type DeviceContext, type EvidenceField } from "@shuddl/driver-core";
import { RecordingSender, formatCents } from "@shuddl/agents";
import type { EvidenceSender } from "@shuddl/agents";
import { handlePodSigned, invoiceEventIdFor, PodSignedMessage } from "../../agents/src/biller.js";
import type { BillerDeps, SeqStubLike } from "../../agents/src/biller.js";
import type { Env } from "../src/index.js";
import {
  CONSENT,
  FENCE_CENTER,
  INSIDE,
  TENANT_SLUG,
  TEST_DEVICE_ID,
  TEST_RATE_CONFIG,
  ensureSchema,
  nextEvidenceBytes,
  post,
  seedLeg,
  seedRateConfig,
  seedShipment,
  testDeviceSigningKey,
  token,
  type Res,
} from "./helpers.js";

// ─── WP-06 — THE HEARTBEAT (acceptance demo #1: "signature at a door → invoice + evidence email") ────
//
// The ONE end-to-end flow, causally chained, no seams skipped: a REAL /v1/rate quote (itemized,
// recorded), the REAL gated driver flow — pickup consent → arrive → count → freight photo → dims →
// custody → gated depart → delivery arrive → forced placed photo → signature on glass (pod.signed) →
// gated delivery.evidenced — every step a driver-core-signed capture POSTed through the real sequencer
// DO, then the EXACT queue message the DO enqueued for that pod.signed (captured with the same
// producer-spy biller.test uses) is handed to `handlePodSigned`, the agents-worker consumer, against
// the same DO + D1 + a RecordingSender. Then the whole causal chain is asserted END-TO-END:
//
//   a. invoice.issued lands on the SAME stream, prev_hash-chained — the full chain verifies;
//   b. its identifiers DERIVE from the POD event (deterministic, re-derived independently here);
//   c. Σ invoice lines === the rate response's sell_cents, line-for-line (penny parity, REQ-031);
//   d. the money projection (money_lines + invoices rows) exists and totals the same (REQ-003, I1);
//   e. exactly ONE evidence email, carrying the formatted total, the shipment ref, the referral base,
//      and the DELIVERED display type; idempotency key = evidence-email/<invoice event id> (REQ-087/129);
//   f. ORDERING: the invoice event's seq > the POD's seq; recorded_at is monotonic down the stream.
//
// HONESTY NOTE — the "<5s" half of REQ-031: p95 POD→email latency is a PILOT measurement taken on the
// real substrate (Cloudflare Queues delivery + real Resend sends); it cannot be measured inside this
// pool-workers harness and NO latency number is asserted or fabricated here. What THIS test proves is
// the other half: the causal chain is complete and code-path-real — the same second the queue delivers,
// the invoice and the email exist, with nothing left to build between the signature and the send.
//
// Piecewise variants (holds, idempotency, send-failure isolation, interline, redelivery) are
// biller.test.ts's job; the gate controls are pod.test.ts's. This file is the DEMO-shaped assertion.
// isolatedStorage is OFF (shared D1): everything here scopes to its own shipment/stream id.

const TENANT = TENANT_SLUG;
const REFERRAL_BASE = "https://shuddl.tech"; // the owner-fixed brand base (matches the agents wrangler default)
const BILL_TO_EMAIL = "billing@heartbeat.test";
const SHP = "heartbeat-demo-1";

// ── driver-core capture plumbing (own monotonic counters — never reused across files) ────────────────
let deviceCtx: DeviceContext;
let opsTok: string;
let deviceSeq = 90_000; // per-device offline counter — distinct base from other files, own stream anyway
let clock = 1_722_000_000_000;

async function driveStep(
  shipmentId: string,
  kind: EventKind,
  payload: Record<string, unknown>,
  evidenceField?: EvidenceField,
): Promise<{ res: Res; hash?: string }> {
  const ts = clock++;
  const params: CaptureParams = { shipment_id: shipmentId, kind, payload, ts, captured_ts: ts, actor_user: "user-driver" };
  if (evidenceField !== undefined) params.evidence = { bytes: nextEvidenceBytes(), field: evidenceField };
  const { event, deferred } = await capture(params, deviceCtx);
  const res = await post(shipmentId, event, opsTok);
  return deferred ? { res, hash: deferred.hash } : { res };
}

// ── consumer deps against the REAL DO + D1 (mirrors biller.test) ──────────────────────────────────────
const seqStub: SeqStubLike = {
  append: (req) =>
    (env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${req.tenant}|${req.streamId}`)) as unknown as SeqStubLike).append(req),
};
function depsWith(sender: EvidenceSender): BillerDeps {
  return { db: env.TENANT_A_DB, seq: seqStub, sender, referralBase: REFERRAL_BASE };
}

// ── producer-side observation (the same honest spy biller.test documents): reach the live DO instance
// and swap a recording AGENT_QUEUE onto a per-instance COPY of env — the message recorded is exactly
// what the DO would have handed Cloudflare Queues, so the consumer is fed the REAL wire payload. ──────
async function patchAgentQueue(shipmentId: string, send: (m: unknown) => Promise<void>): Promise<void> {
  const stub = env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${TENANT}|s:${shipmentId}`));
  await runInDurableObject(stub, (instance) => {
    const inst = instance as unknown as { env: Env };
    inst.env = { ...inst.env, AGENT_QUEUE: { send } as unknown as Env["AGENT_QUEUE"] };
  });
}

// The enqueue rides ctx.waitUntil (off the response path by design), so give it a beat to settle.
async function settle(cond: () => boolean, ms = 1_000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10));
}

// Independent re-derivation of the Biller's deterministic ids — asserting the DERIVATION, not merely
// that two calls into the same code agree.
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The invoice EVENT id derivation, REPLICATED from the Biller spec (workers/agents/src/biller.ts):
// SHA-256 over the domain-separated POD event id, shaped into a v4-variant UUID. Kept as a local
// copy on purpose — if production drifts from this derivation, THIS test fails.
async function expectedInvoiceEventId(podEventId: string): Promise<string> {
  const h = (await sha256Hex(`biller:invoice-event:${podEventId}`)).slice(0, 32);
  const variant = ((parseInt(h.slice(16, 17) || "0", 16) & 0x3) | 0x8).toString(16); // 8/9/a/b
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function streamEvents(shipmentId: string): Promise<LedgerEvent[]> {
  const res = await env.TENANT_A_DB.prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq")
    .bind(`s:${shipmentId}`)
    .all();
  return (res.results as Record<string, string | number | null>[]).map((r) => rowToEvent(r));
}

beforeAll(async () => {
  await ensureSchema(env);
  deviceCtx = {
    device_id: TEST_DEVICE_ID,
    privateKey: await testDeviceSigningKey(),
    party: "party-carrier",
    nextSeq: () => deviceSeq++,
  };
  opsTok = await token({ sub: "u-heartbeat-ops", tenant: TENANT, role: "ops" });

  // The bill-to party's billing email — parties.contacts is the tenant plane's only email-bearing
  // column, the honest recipient source the consumer resolves (same row biller.test uses; each file
  // sets what it asserts in its own beforeAll, so file order never matters).
  await env.TENANT_A_DB.prepare("UPDATE parties SET contacts = ? WHERE id = 'party-bill-to'")
    .bind(JSON.stringify([{ kind: "billing", email: BILL_TO_EMAIL }]))
    .run();

  // One shipment, TWO legs — the full physical move: a pickup leg and the delivery leg whose dest geo
  // IS the delivery fence (server-sourced gate context, never from the client event).
  await seedShipment(SHP);
  await seedLeg(SHP, 0, "pickup", { lat_e6: 45_523_100, lon_e6: -122_676_500 });
  await seedLeg(SHP, 1, "delivery", FENCE_CENTER);
});

describe("HEARTBEAT — quote → gated driver flow → pod.signed → queue → invoice.issued + evidence email (REQ-031/087/129/003)", () => {
  it("the full causal chain of acceptance demo #1, end to end, through every real seam", async () => {
    // ── 1. A REAL quote through POST /v1/rate: the recorded quote.priced (itemized lines, floors,
    //       pinned versions) is exactly what production records — never a hand-crafted payload.
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    const rateRes = await SELF.fetch("https://api.local/v1/rate", {
      method: "POST",
      headers: { Authorization: `Bearer ${opsTok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
      body: JSON.stringify({
        shipment_id: SHP,
        origin_zip: "97201",
        dest_zip: "80012",
        weight_lb: 1000,
        dims: { l_in: 48, w_in: 40, h_in: 48, pieces: 2 },
      }),
    });
    expect(rateRes.status).toBe(200);
    const rate = (await rateRes.json()) as {
      status: string;
      sell_cents: number;
      lines: { kind: string; code: string; amount_cents: number }[];
    };
    expect(rate.status).toBe("PRICED");
    expect(rate.lines.length).toBeGreaterThan(1); // itemized — freight + fsc at minimum
    expect(rate.lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(rate.sell_cents);

    // ── 2. Arm the producer spy BEFORE any append lands, so the pod.signed enqueue is captured.
    const enqueued: unknown[] = [];
    await patchAgentQueue(SHP, async (m) => {
      enqueued.push(m);
    });

    // ── 3. The REAL gated driver flow — the full stop sequence a driver actually runs (the same
    //       driver-core `capture` the PWA uses, POSTed through the real sequencer + Gatekeeper).
    // Pickup stop: consent (REQ-166, before any GPS stamp on the stream) → arrive → count → freight
    // photo → dims → custody handoff → the GATED stop.departed (REQ-044).
    expect((await driveStep(SHP, "document.attached", { ...CONSENT })).res.status).toBe(201);
    expect((await driveStep(SHP, "stop.arrived", { geo: { ...INSIDE }, auto: false })).res.status).toBe(201);
    expect((await driveStep(SHP, "freight.counted", { pieces: 2 })).res.status).toBe(201);
    expect((await driveStep(SHP, "freight.photographed", { photo_kind: "freight" }, "photo_hash")).res.status).toBe(201);
    expect((await driveStep(SHP, "dims.captured", { l_in: 48, w_in: 40, h_in: 48, pieces: 2, method: "manual" })).res.status).toBe(201);
    expect(
      (await driveStep(SHP, "custody.transferred", { from_party: "party-shipper", to_party: "party-carrier", geo: { ...INSIDE } })).res.status,
    ).toBe(201);
    expect((await driveStep(SHP, "stop.departed", { geo: { ...INSIDE }, auto: false, out_for_delivery: true })).res.status).toBe(201);
    // Delivery stop: arrive INSIDE the seeded fence → the FORCED placed photo (REQ-063, hash threaded)
    // → the signature on glass (pod.signed — the Biller's trigger) → the GATED delivery.evidenced.
    expect((await driveStep(SHP, "stop.arrived", { geo: { ...INSIDE }, auto: false })).res.status).toBe(201);
    const placed = await driveStep(SHP, "freight.photographed", { photo_kind: "placed" }, "photo_hash");
    expect(placed.res.status).toBe(201);
    const signed = await driveStep(SHP, "pod.signed", { geo: { ...INSIDE } }, "signature_hash");
    expect(signed.res.status, JSON.stringify(signed.res.json)).toBe(201);
    const podId = (signed.res.json as { id: string }).id;
    const pod = await driveStep(SHP, "delivery.evidenced", { placed_photo_hash: placed.hash, geo: { ...INSIDE } });
    expect(pod.res.status, JSON.stringify(pod.res.json)).toBe(201);

    // ── 4. The queue seam: the committed pod.signed enqueued EXACTLY ONE message — the consumer's
    //       wire payload — and nothing else on the stream did.
    await settle(() => enqueued.length > 0);
    // Drain beat AFTER the first message lands: settle() resolves on the FIRST enqueue, so a buggy
    // duplicate arriving a few (macro)tasks later would otherwise slip past the length assert.
    await new Promise((r) => setTimeout(r, 25));
    expect(enqueued).toHaveLength(1);
    const message = PodSignedMessage.parse(enqueued[0]); // the consumer's own Zod boundary accepts it
    expect(message).toEqual({ kind: "pod.signed", tenant: TENANT, shipment_id: SHP, event_id: podId });

    // ── 5. Simulate the queue delivery: hand the CAPTURED message to the real consumer against the
    //       same DO + D1, with a RecordingSender on the sender port.
    const sender = new RecordingSender();
    const outcome = await handlePodSigned(message, depsWith(sender));
    expect(outcome.status).toBe("issued_sent");
    if (outcome.status !== "issued_sent") throw new Error("unreachable");

    // ── a. invoice.issued is ON THE SAME STREAM and the whole chain verifies (dense seq, every
    //       prev_hash → hash link holds — quote, driver flow, POD, invoice, one unbroken record).
    const events = await streamEvents(SHP);
    expect(events.map((e) => e.kind)).toEqual([
      "quote.priced",
      "agent.acted",
      "document.attached",
      "stop.arrived",
      "freight.counted",
      "freight.photographed",
      "dims.captured",
      "custody.transferred",
      "stop.departed",
      "stop.arrived",
      "freight.photographed",
      "pod.signed",
      "delivery.evidenced",
      "invoice.issued",
    ]);
    expect((await verifyChain(events)).ok).toBe(true);
    const inv = events[events.length - 1]!;
    expect(inv.kind).toBe("invoice.issued");
    expect(inv.id).toBe(outcome.invoice_event_id);
    expect(inv.prev_hash).toBe(events[events.length - 2]!.hash); // explicitly prev_hash-chained onto the POD flow

    // ── b. its identifiers DERIVE from the POD event — BOTH re-derived here independently (the local
    //       replicas of the derivation spec), so the deterministic derivation itself (redelivery-
    //       stable, REQ-031) is the thing asserted — plus corroboration that the exported production
    //       function is that same derivation.
    expect(inv.id).toBe(await expectedInvoiceEventId(podId));
    expect(inv.id).toBe(await invoiceEventIdFor(podId));
    const payload = inv.payload as { invoice_id: string; party_id: string; lines: { kind: string; amount_cents: number; gl_map: string }[] };
    expect(payload.invoice_id).toBe(`inv_${(await sha256Hex(`biller:invoice:${podId}`)).slice(0, 16)}`);
    expect(payload.invoice_id).toBe(outcome.invoice_id);
    expect(payload.party_id).toBe("party-bill-to"); // shipments.bill_to_party_id — never guessed

    // ── c. penny parity against the RATE RESPONSE the shipment was sold under: Σ invoice lines ===
    //       sell_cents, and line-for-line (kind + amount) the invoice is the quote's verbatim projection.
    expect(payload.lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(rate.sell_cents);
    expect(payload.lines.map((l) => ({ kind: l.kind, amount_cents: l.amount_cents }))).toEqual(
      rate.lines.map((l) => ({ kind: l.kind, amount_cents: l.amount_cents })),
    );

    // ── d. the money PROJECTION ran in the same batch (REQ-003, I1): money_lines + invoices rows
    //       exist and total the same penny-exact figure.
    const moneyLines = await env.TENANT_A_DB.prepare(
      "SELECT event_id, amount_cents, party_id, direction FROM money_lines WHERE shipment_id = ? ORDER BY line_no",
    )
      .bind(SHP)
      .all<{ event_id: string; amount_cents: number; party_id: string; direction: string }>();
    expect(moneyLines.results).toHaveLength(payload.lines.length);
    expect(moneyLines.results.every((l) => l.event_id === inv.id && l.direction === "ar" && l.party_id === "party-bill-to")).toBe(true);
    expect(moneyLines.results.reduce((s, l) => s + l.amount_cents, 0)).toBe(rate.sell_cents);
    const invoiceRow = await env.TENANT_A_DB.prepare("SELECT id, total_cents, status FROM invoices WHERE issued_event_id = ?")
      .bind(inv.id)
      .first<{ id: string; total_cents: number; status: string }>();
    expect(invoiceRow).not.toBeNull();
    expect(invoiceRow!.id).toBe(payload.invoice_id);
    expect(invoiceRow!.total_cents).toBe(rate.sell_cents);
    expect(invoiceRow!.status).toBe("issued");

    // ── e. exactly ONE evidence email: the formatted total, the shipment ref, the referral base
    //       (REQ-129), the DELIVERED display type; idempotency key = evidence-email/<invoice event id>.
    expect(sender.messages).toHaveLength(1);
    const mail = sender.messages[0]!;
    expect(mail.to).toBe(BILL_TO_EMAIL);
    expect(mail.shipment_id).toBe(SHP);
    expect(mail.idempotency_key).toBe(`evidence-email/${inv.id}`);
    expect(mail.subject).toBe(`DELIVERED · ${SHP} · PROOF + INVOICE`);
    expect(mail.html).toContain(formatCents(rate.sell_cents));
    expect(mail.html).toContain(SHP);
    expect(mail.html).toContain(`${REFERRAL_BASE}?ref=${SHP}`);
    expect(mail.html).toContain(">Delivered<"); // the Display hero (painted uppercase by the primitive)

    // ── f. ORDERING: the invoice event follows the POD (seq strictly greater) and recorded_at is
    //       monotonic (non-decreasing) down the whole stream — cause before effect, forever.
    const podEvent = events.find((e) => e.id === podId)!;
    expect(inv.seq).toBeGreaterThan(podEvent.seq);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.recorded_at).toBeGreaterThanOrEqual(events[i - 1]!.recorded_at);
    }
  });
});
