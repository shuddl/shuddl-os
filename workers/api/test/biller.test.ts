import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { rowToEvent } from "@shuddl/ledger/lens";
import type { EventKind, LedgerEvent } from "@shuddl/contracts";
import { capture, type CaptureParams, type DeviceContext, type EvidenceField } from "@shuddl/driver-core";
import { RecordingSender, SendError, formatCents } from "@shuddl/agents";
import type { EvidenceMessage, EvidenceSender, SendReceipt } from "@shuddl/agents";
import { handlePodSigned, PodSignedMessage, deliveryStopGeo } from "../../agents/src/biller.js";
import type { BillerDeps, SeqStubLike } from "../../agents/src/biller.js";
import type { Env } from "../src/index.js";
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
  seedDeliveryLeg,
  seedRateConfig,
  seedShipment,
  testDeviceSigningKey,
  token,
  type Res,
} from "./helpers.js";

// ─── WP-06 — THE BILLER CONSUMER (REQ-031 / REQ-040 / REQ-003) ─────────────────────────────────────
//
// The integration proof of "signature at a door → invoice + evidence email, the same second": a REAL
// quote.priced (POST /v1/rate, the recorded penny-parity source) + a REAL gated POD flow (the same
// driver-core captures pod.test drives) land on one stream, then `handlePodSigned` — the agents-worker
// queue consumer — composes the invoice and appends `invoice.issued` THROUGH the real sequencer DO
// (the I2 gate + the money projection run atomically there), then sends the evidence email through the
// EvidenceSender port.
//
// VENUE (why this file lives in workers/api/test and not workers/agents/test): the ShipmentSequencer
// class + the migrated tenant D1 + the pod-flow fixtures exist only in THIS harness — the agents
// worker's pool has no DO binding it could instantiate (the class is exported by the api worker). So
// the consumer FUNCTION is imported from the agents worker source and driven directly against the real
// DO + D1 + a RecordingSender; the queue() shell in workers/agents/src/index.ts is thin dispatch only.
//
// LAWS UNDER TEST:
//   · REQ-031 — the invoice is the ledger's: a send failure NEVER blocks or reverses it.
//   · REQ-040 — an anomalous recorded quote ($222,084/35-lb) HOLDS; it never auto-invoices. Permanent.
//   · REQ-003 — money lines exist only as projections of the invoice.issued event (I1, one batch).
//   · Idempotent under queue redelivery: append dedupes by the deterministic event id; the sender
//     dedupes by the `evidence-email/<invoice event id>` key. Twice in = once out, everywhere.
//
// isolatedStorage is OFF (shared D1): every case scopes to its OWN shipment/stream ids.

const TENANT = TENANT_SLUG;
const REFERRAL_BASE = "https://shuddl.tech"; // the owner-fixed brand base (matches the agents wrangler default)
const BILL_TO_EMAIL = "billing@bill-to.test";

// ── driver-core capture plumbing (mirrors pod.test.ts; own monotonic counters, own streams) ──────────
let deviceCtx: DeviceContext;
let opsTok: string;
let deviceSeq = 50_000; // per-device offline counter — distinct base from other files, own streams anyway
let clock = 1_721_000_000_000;

async function driveStep(
  shipmentId: string,
  kind: EventKind,
  payload: Record<string, unknown>,
  evidenceField?: EvidenceField,
): Promise<Res> {
  const ts = clock++;
  const params: CaptureParams = { shipment_id: shipmentId, kind, payload, ts, captured_ts: ts, actor_user: "user-driver" };
  if (evidenceField !== undefined) params.evidence = { bytes: nextEvidenceBytes(), field: evidenceField };
  const { event } = await capture(params, deviceCtx);
  return post(shipmentId, event, opsTok);
}

// Price the shipment through the REAL /v1/rate route so the recorded quote.priced (itemized lines,
// floors, basis.anomaly) is exactly what production records — never a hand-crafted payload.
async function priceQuote(shipmentId: string, opts: { anomalous?: boolean; weightLb?: number } = {}): Promise<number> {
  await seedRateConfig(env.TENANT_A_DB, opts.anomalous ? ANOMALY_RATE_CONFIG : TEST_RATE_CONFIG);
  const res = await SELF.fetch("https://api.local/v1/rate", {
    method: "POST",
    headers: { Authorization: `Bearer ${opsTok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify({
      shipment_id: shipmentId,
      origin_zip: "97201",
      dest_zip: "80012",
      weight_lb: opts.weightLb ?? (opts.anomalous ? 1 : 1000), // 1 lb against the $250k min charge = the REQ-040 case
      dims: { l_in: 48, w_in: 40, h_in: 48, pieces: 2 },
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string; sell_cents: number; anomaly?: unknown };
  expect(body.status).toBe("PRICED");
  if (opts.anomalous) expect(body.anomaly, "the anomaly config must actually trip the net").toBeTruthy();
  return body.sell_cents;
}

// The full gated delivery flow up to and including pod.signed (the Biller's trigger event).
// Returns the committed pod.signed event id — the queue message's event_id.
async function driveToPod(shipmentId: string): Promise<string> {
  expect((await driveStep(shipmentId, "document.attached", { ...CONSENT })).status).toBe(201);
  expect((await driveStep(shipmentId, "stop.arrived", { geo: { ...INSIDE }, auto: false })).status).toBe(201);
  expect((await driveStep(shipmentId, "freight.photographed", { photo_kind: "placed" }, "photo_hash")).status).toBe(201);
  const signed = await driveStep(shipmentId, "pod.signed", { geo: { ...INSIDE } }, "signature_hash");
  expect(signed.status, JSON.stringify(signed.json)).toBe(201);
  return (signed.json as { id: string }).id;
}

// ── consumer deps against the REAL DO + D1 ────────────────────────────────────────────────────────────
const seqStub: SeqStubLike = {
  append: (req) =>
    (env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${req.tenant}|${req.streamId}`)) as unknown as SeqStubLike).append(req),
};
function depsWith(sender: EvidenceSender): BillerDeps {
  return { db: env.TENANT_A_DB, seq: seqStub, sender, referralBase: REFERRAL_BASE };
}
function msgFor(shipmentId: string, podEventId: string): PodSignedMessage {
  return { kind: "pod.signed", tenant: TENANT, shipment_id: shipmentId, event_id: podEventId };
}

// A sender that always fails — the two SendError arms of the isolation law.
class ThrowingSender implements EvidenceSender {
  constructor(private readonly retriable: boolean) {}
  async send(_m: EvidenceMessage): Promise<SendReceipt> {
    throw new SendError(this.retriable ? "resend answered 503" : "resend rejected the send (422)", this.retriable);
  }
}

// ── producer-side observation ─────────────────────────────────────────────────────────────────────────
// The pool exposes no API to read a producer queue's contents, so the HONEST mechanism is the one the
// crash-heal test already uses: runInDurableObject reaches the live DO instance (same isolate under
// singleWorker) and swaps a recording AGENT_QUEUE onto a per-instance COPY of env — the shared env
// object is never mutated, so no other stream's DO is affected. The spy records exactly what the DO
// would have handed Cloudflare Queues.
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

// ── DB probes ────────────────────────────────────────────────────────────────────────────────────────
async function streamEvents(shipmentId: string): Promise<LedgerEvent[]> {
  const res = await env.TENANT_A_DB.prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq")
    .bind(`s:${shipmentId}`)
    .all();
  return (res.results as Record<string, string | number | null>[]).map((r) => rowToEvent(r));
}
async function invoiceEvents(shipmentId: string): Promise<LedgerEvent[]> {
  return (await streamEvents(shipmentId)).filter((e) => e.kind === "invoice.issued");
}
async function moneyLines(shipmentId: string): Promise<{ event_id: string; amount_cents: number; party_id: string; direction: string }[]> {
  const res = await env.TENANT_A_DB.prepare(
    "SELECT event_id, amount_cents, party_id, direction FROM money_lines WHERE shipment_id = ? ORDER BY line_no",
  )
    .bind(shipmentId)
    .all<{ event_id: string; amount_cents: number; party_id: string; direction: string }>();
  return res.results;
}
async function invoiceRow(issuedEventId: string): Promise<{ id: string; party_id: string; total_cents: number; status: string } | null> {
  return env.TENANT_A_DB.prepare("SELECT id, party_id, total_cents, status FROM invoices WHERE issued_event_id = ?")
    .bind(issuedEventId)
    .first<{ id: string; party_id: string; total_cents: number; status: string }>();
}

beforeAll(async () => {
  await ensureSchema(env);
  deviceCtx = {
    device_id: TEST_DEVICE_ID,
    privateKey: await testDeviceSigningKey(),
    party: "party-carrier",
    nextSeq: () => deviceSeq++,
  };
  opsTok = await token({ sub: "u-biller-ops", tenant: TENANT, role: "ops" });

  // The bill-to party's billing email lives in parties.contacts (the tenant plane's ONLY email-bearing
  // column) — the honest recipient source the consumer resolves.
  await env.TENANT_A_DB.prepare("UPDATE parties SET contacts = ? WHERE id = 'party-bill-to'")
    .bind(JSON.stringify([{ kind: "billing", email: BILL_TO_EMAIL }]))
    .run();

  for (const id of [
    "biller-happy",
    "biller-idem",
    "biller-anom",
    "biller-noquote",
    "biller-retriable",
    "biller-permanent",
    "biller-poison",
    "biller-producer",
    "biller-requote",
    "biller-fastpath",
  ]) {
    await seedShipment(id);
    await seedDeliveryLeg(id);
  }

  // The interline shipment carries its OWN legs (split_bps set on every leg — seedDeliveryLeg's
  // NULL-split leg would make the split incomplete): the tenant executes delivery at 1000 bps, the
  // partner's interline leg carries 9000 bps. The executing share is 10% of gross — far below floor.
  await seedShipment("biller-interline");
  for (const [seq, kind, executor, split] of [
    [0, "delivery", "party-carrier", 1_000],
    [1, "interline", "party-interline", 9_000],
  ] as const) {
    await env.TENANT_A_DB.prepare(
      "INSERT OR IGNORE INTO legs (id, shipment_id, seq, kind, executor_party_id, split_bps, geo) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(`leg-biller-interline-${seq}`, "biller-interline", seq, kind, executor, split, kind === "delivery" ? JSON.stringify({ lat_e6: 37_421_000, lon_e6: -122_084_000 }) : "{}")
      .run();
  }

  // INTERLINE BY DATA, NOT LABEL (REQ-040 fail-closed): the partner leg is recorded under kind
  // 'linehaul' — NOT 'interline' — yet still carries a real split_bps (9000 bps). The tenant executes
  // only the 10% delivery leg. Before the fix, resolveInterline classified this DIRECT (no leg wore the
  // 'interline' label) and billed at FULL GROSS, skipping the executing-share floor check entirely.
  await seedShipment("biller-interline-mislabel");
  for (const [seq, kind, executor, split] of [
    [0, "delivery", "party-carrier", 1_000],
    [1, "linehaul", "party-interline", 9_000],
  ] as const) {
    await env.TENANT_A_DB.prepare(
      "INSERT OR IGNORE INTO legs (id, shipment_id, seq, kind, executor_party_id, split_bps, geo) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(`leg-biller-interline-mislabel-${seq}`, "biller-interline-mislabel", seq, kind, executor, split, kind === "delivery" ? JSON.stringify({ lat_e6: 37_421_000, lon_e6: -122_084_000 }) : "{}")
      .run();
  }

  // INTERLINE ABOVE-FLOOR (the ISSUE path of resolveInterline): the tenant (the POD signer, party-carrier)
  // executes the MAJORITY 9000-bps delivery leg, the partner the 1000-bps linehaul. The 90% executing
  // share clears the target floor (floors are cost-basis × bps → target = 0.98·freight; share = 0.90·sell
  // = 1.116·freight ≥ target), so the interline shipment ISSUES at full gross. Pins the issue-path so an
  // over-correction of resolveInterline into always-hold cannot slip past the suite (both other interline
  // integration cases put the tenant on the 10% leg and HOLD).
  await seedShipment("biller-interline-majority");
  for (const [seq, kind, executor, split] of [
    [0, "delivery", "party-carrier", 9_000],
    [1, "linehaul", "party-interline", 1_000],
  ] as const) {
    await env.TENANT_A_DB.prepare(
      "INSERT OR IGNORE INTO legs (id, shipment_id, seq, kind, executor_party_id, split_bps, geo) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(`leg-biller-interline-majority-${seq}`, "biller-interline-majority", seq, kind, executor, split, kind === "delivery" ? JSON.stringify({ lat_e6: 37_421_000, lon_e6: -122_084_000 }) : "{}")
      .run();
  }
});

describe("Biller consumer — POD fires invoice.issued + evidence send (REQ-031/040/003)", () => {
  it("GOLDEN PATH: quote.priced + gated POD → invoice.issued penny-exact, money projected, ONE evidence email", async () => {
    const shp = "biller-happy";
    const sell = await priceQuote(shp);
    const podId = await driveToPod(shp);

    const sender = new RecordingSender();
    const outcome = await handlePodSigned(msgFor(shp, podId), depsWith(sender));
    expect(outcome.status).toBe("issued_sent");
    if (outcome.status !== "issued_sent") throw new Error("unreachable");

    // The invoice.issued is ON the stream, its lines a verbatim penny-exact projection (Σ === quote sell).
    const invoices = await invoiceEvents(shp);
    expect(invoices).toHaveLength(1);
    const inv = invoices[0]!;
    expect(inv.id).toBe(outcome.invoice_event_id);
    const payload = inv.payload as { invoice_id: string; party_id: string; lines: { amount_cents: number }[] };
    expect(payload.invoice_id).toBe(outcome.invoice_id);
    expect(payload.party_id).toBe("party-bill-to"); // shipments.bill_to_party_id — never guessed
    expect(payload.lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(sell);

    // The money projection ran in the SAME batch (I1): money_lines rows + the invoices row exist.
    const lines = await moneyLines(shp);
    expect(lines.length).toBe(payload.lines.length);
    expect(lines.every((l) => l.event_id === inv.id && l.direction === "ar" && l.party_id === "party-bill-to")).toBe(true);
    expect(lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(sell);
    const row = await invoiceRow(inv.id);
    expect(row).not.toBeNull();
    expect(row!.total_cents).toBe(sell);
    expect(row!.status).toBe("issued");
    expect(row!.id).toBe(payload.invoice_id);

    // Exactly ONE recorded email: formatted total + referral url in the html; the idempotency key is
    // derived from the invoice EVENT id (one invoice, one message, forever).
    expect(sender.messages).toHaveLength(1);
    const mail = sender.messages[0]!;
    expect(mail.to).toBe(BILL_TO_EMAIL);
    expect(mail.idempotency_key).toBe(`evidence-email/${inv.id}`);
    expect(mail.html).toContain(formatCents(sell));
    expect(mail.html).toContain(`${REFERRAL_BASE}?ref=${shp}`);
    expect(mail.subject).toContain(shp);
    expect(mail.shipment_id).toBe(shp);
  });

  it("IDEMPOTENCY: the same message twice → ONE invoice event, ONE money projection, ONE email", async () => {
    const shp = "biller-idem";
    const sell = await priceQuote(shp);
    const podId = await driveToPod(shp);

    const sender = new RecordingSender();
    const first = await handlePodSigned(msgFor(shp, podId), depsWith(sender));
    const second = await handlePodSigned(msgFor(shp, podId), depsWith(sender)); // queue redelivery
    expect(first.status).toBe("issued_sent");
    expect(second.status).toBe("issued_sent");
    if (first.status !== "issued_sent" || second.status !== "issued_sent") throw new Error("unreachable");
    expect(second.invoice_event_id).toBe(first.invoice_event_id); // deterministic id — derived, never minted

    const invoices = await invoiceEvents(shp);
    expect(invoices).toHaveLength(1); // the sequencer deduped by event id
    const lines = await moneyLines(shp);
    expect(lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(sell); // projected exactly once
    expect(sender.messages).toHaveLength(1); // the sender's same-key dedupe held
  });

  it("THE $222K HOLD: an anomalous recorded quote → held(anomaly), NO invoice, NO money, NO email (REQ-040)", async () => {
    const shp = "biller-anom";
    await priceQuote(shp, { anomalous: true }); // the recorded basis.anomaly rides the quote.priced
    const podId = await driveToPod(shp);

    const sender = new RecordingSender();
    const outcome = await handlePodSigned(msgFor(shp, podId), depsWith(sender));
    expect(outcome.status).toBe("held");
    if (outcome.status !== "held") throw new Error("unreachable");
    expect(outcome.reason).toBe("anomaly");

    expect(await invoiceEvents(shp)).toHaveLength(0);
    expect(await moneyLines(shp)).toHaveLength(0);
    expect(sender.messages).toHaveLength(0);
  });

  it("NO-QUOTE HOLD: pod.signed with no quote.priced on the stream → held(no_quote), nothing appended/sent", async () => {
    const shp = "biller-noquote";
    const podId = await driveToPod(shp); // no /v1/rate call — an unquoted shipment must never invoice ad hoc

    const sender = new RecordingSender();
    const outcome = await handlePodSigned(msgFor(shp, podId), depsWith(sender));
    expect(outcome.status).toBe("held");
    if (outcome.status !== "held") throw new Error("unreachable");
    expect(outcome.reason).toBe("no_quote");

    expect(await invoiceEvents(shp)).toHaveLength(0);
    expect(await moneyLines(shp)).toHaveLength(0);
    expect(sender.messages).toHaveLength(0);
  });

  it("SEND-FAILURE ISOLATION (retriable): handlePodSigned THROWS for redelivery, but the invoice STANDS (REQ-031)", async () => {
    const shp = "biller-retriable";
    const sell = await priceQuote(shp);
    const podId = await driveToPod(shp);

    await expect(handlePodSigned(msgFor(shp, podId), depsWith(new ThrowingSender(true)))).rejects.toThrow();

    // The invoice is the ledger's — committed BEFORE the send, never unwound by its failure.
    const invoices = await invoiceEvents(shp);
    expect(invoices).toHaveLength(1);
    expect((await invoiceRow(invoices[0]!.id))?.total_cents).toBe(sell);

    // And the redelivery completes cleanly: same invoice event, the email finally goes out.
    const sender = new RecordingSender();
    const redelivered = await handlePodSigned(msgFor(shp, podId), depsWith(sender));
    expect(redelivered.status).toBe("issued_sent");
    expect(await invoiceEvents(shp)).toHaveLength(1); // still exactly one
    expect(sender.messages).toHaveLength(1);
  });

  it("SEND-FAILURE ISOLATION (permanent): returns issued_send_pending — no throw, no rollback (REQ-031)", async () => {
    const shp = "biller-permanent";
    const sell = await priceQuote(shp);
    const podId = await driveToPod(shp);

    const outcome = await handlePodSigned(msgFor(shp, podId), depsWith(new ThrowingSender(false)));
    expect(outcome.status).toBe("issued_send_pending"); // redelivery cannot help a permanent refusal
    if (outcome.status !== "issued_send_pending") throw new Error("unreachable");
    expect(outcome.reason).toBe("send_failed_permanent");

    const invoices = await invoiceEvents(shp);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.id).toBe(outcome.invoice_event_id);
    expect((await invoiceRow(outcome.invoice_event_id))?.total_cents).toBe(sell); // never rolled back
  });

  it("I2 BACKSTOP / POISON: a message whose pod event id is not on the stream → skipped, nothing appended", async () => {
    const shp = "biller-poison";
    await priceQuote(shp); // a quote exists — only the POD reference is bogus

    const sender = new RecordingSender();
    const outcome = await handlePodSigned(msgFor(shp, crypto.randomUUID()), depsWith(sender));
    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") throw new Error("unreachable");
    expect(outcome.reason).toBe("pod_not_found");

    expect(await invoiceEvents(shp)).toHaveLength(0);
    expect(await moneyLines(shp)).toHaveLength(0);
    expect(sender.messages).toHaveLength(0);
  });

  it("RECIPIENT UNRESOLVED: a bill-to party with no contact email → invoice STANDS, send held as issued_send_pending", async () => {
    const shp = "biller-noemail";
    // bill-to = party-shipper, whose contacts are the '[]' default — no email anywhere in the tenant plane.
    await env.TENANT_A_DB.prepare(
      "INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, created_ts) VALUES (?,?,?,?,0)",
    )
      .bind(shp, "party-shipper", "party-consignee", "party-shipper")
      .run();
    await seedDeliveryLeg(shp);
    await priceQuote(shp);
    const podId = await driveToPod(shp);

    const sender = new RecordingSender();
    const outcome = await handlePodSigned(msgFor(shp, podId), depsWith(sender));
    expect(outcome.status).toBe("issued_send_pending"); // NOT a silent skip — recorded loudly
    if (outcome.status !== "issued_send_pending") throw new Error("unreachable");
    expect(outcome.reason).toBe("recipient_unresolved");

    expect(await invoiceEvents(shp)).toHaveLength(1); // the invoice is the ledger's regardless
    expect(sender.messages).toHaveLength(0);
  });

  it("PRODUCER: a committed pod.signed enqueues EXACTLY the consumer's message; a rejected push never fails the append", async () => {
    const shp = "biller-producer";
    const sent: unknown[] = [];
    await patchAgentQueue(shp, async (m) => {
      sent.push(m);
    });

    // Four appends land (consent/arrival/photo/pod) — ONLY the pod.signed may enqueue.
    const podId = await driveToPod(shp);
    await settle(() => sent.length > 0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ kind: "pod.signed", tenant: TENANT, shipment_id: shp, event_id: podId });
    expect(() => PodSignedMessage.parse(sent[0])).not.toThrow(); // the producer satisfies the consumer's Zod boundary

    // A queue push that REJECTS must not fail the append: the POD is committed truth; the lost
    // trigger is the REQ-169 sweep's job, never the driver's problem.
    await patchAgentQueue(shp, async () => {
      throw new Error("queue outage (simulated)");
    });
    const again = await driveStep(shp, "pod.signed", { geo: { ...INSIDE } }, "signature_hash");
    expect(again.status, JSON.stringify(again.json)).toBe(201);
    expect((await streamEvents(shp)).filter((e) => e.kind === "pod.signed")).toHaveLength(2);
  });

  it("DISPUTE RE-QUOTE: a quote.priced recorded AFTER the pod is IGNORED — the invoice projects the pre-POD quote", async () => {
    const shp = "biller-requote";
    const sellBefore = await priceQuote(shp); // 1000 lb
    const podId = await driveToPod(shp);
    const sellAfter = await priceQuote(shp, { weightLb: 400 }); // a post-POD re-quote (dispute/what-if)
    expect(sellAfter).not.toBe(sellBefore); // the mutation this test kills: seq< must matter

    const sender = new RecordingSender();
    const outcome = await handlePodSigned(msgFor(shp, podId), depsWith(sender));
    expect(outcome.status).toBe("issued_sent");

    // Penny-exact against the quote the shipment MOVED under — the later one never reprices the record.
    const inv = (await invoiceEvents(shp))[0]!;
    const lines = (inv.payload as { lines: { amount_cents: number }[] }).lines;
    expect(lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(sellBefore);
    expect(sender.messages[0]!.html).toContain(formatCents(sellBefore));
  });

  it("INTERLINE BELOW-FLOOR: the EXECUTING SHARE (never gross) is judged → held(below_floor), nothing appended/sent (REQ-040)", async () => {
    const shp = "biller-interline";
    await priceQuote(shp); // gross clears the floors; the 10% executing share cannot
    const podId = await driveToPod(shp);

    const sender = new RecordingSender();
    const outcome = await handlePodSigned(msgFor(shp, podId), depsWith(sender));
    expect(outcome.status).toBe("held");
    if (outcome.status !== "held") throw new Error("unreachable");
    expect(outcome.reason).toBe("below_floor");
    expect(outcome.detail).toContain("executing share"); // the share was judged, not the gross

    expect(await invoiceEvents(shp)).toHaveLength(0);
    expect(await moneyLines(shp)).toHaveLength(0);
    expect(sender.messages).toHaveLength(0);
  });

  it("INTERLINE BY DATA, NOT LABEL: a partner leg under kind='linehaul' carrying a real split_bps still judges the EXECUTING SHARE → held(below_floor), never billed at gross (REQ-040 fail-closed)", async () => {
    const shp = "biller-interline-mislabel";
    await priceQuote(shp); // gross clears the floors; the tenant's 10% executing share cannot
    const podId = await driveToPod(shp);

    const sender = new RecordingSender();
    const outcome = await handlePodSigned(msgFor(shp, podId), depsWith(sender));
    // Before the fix this returned issued_sent at full gross — the partner leg wore a non-'interline'
    // kind, so classification-by-LABEL skipped the executing-share floor check (REQ-040 fail-OPEN).
    expect(outcome.status).toBe("held");
    if (outcome.status !== "held") throw new Error("unreachable");
    expect(outcome.reason).toBe("below_floor");
    expect(outcome.detail).toContain("executing share"); // the share was judged, not the gross

    expect(await invoiceEvents(shp)).toHaveLength(0);
    expect(await moneyLines(shp)).toHaveLength(0);
    expect(sender.messages).toHaveLength(0);
  });

  it("INTERLINE ABOVE-FLOOR ISSUES: the tenant executes the MAJORITY leg (9000 bps) → the executing share CLEARS the floor → issued_sent at FULL GROSS + one email (REQ-040 issue-path)", async () => {
    const shp = "biller-interline-majority";
    const sell = await priceQuote(shp); // the tenant's 90% executing share ≥ the target floor
    const podId = await driveToPod(shp);

    const sender = new RecordingSender();
    const outcome = await handlePodSigned(msgFor(shp, podId), depsWith(sender));
    // NOT held: an interline share that clears the floor issues via the consumer. Guards resolveInterline's
    // ISSUE branch against an over-correction into always-hold (the other two interline cases HOLD at 10%).
    expect(outcome.status).toBe("issued_sent");
    if (outcome.status !== "issued_sent") throw new Error("unreachable");

    // The invoice bills the CUSTOMER the FULL recorded gross — the executing share judged only the floor,
    // never the amount billed (REQ-040: compare the share, but still invoice the whole move's sell).
    const invoices = await invoiceEvents(shp);
    expect(invoices).toHaveLength(1);
    const payload = invoices[0]!.payload as { lines: { amount_cents: number }[] };
    expect(payload.lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(sell);

    // Money projected in the same batch, and exactly ONE evidence email carrying the full-gross total.
    const lines = await moneyLines(shp);
    expect(lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(sell);
    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]!.html).toContain(formatCents(sell));
  });

  it("REDELIVERY FAST PATH: once the invoice is committed, later context drift can NEVER flip redelivery to a hold — the email still goes out", async () => {
    const shp = "biller-fastpath";
    const sell = await priceQuote(shp);
    const podId = await driveToPod(shp);

    // First delivery: the invoice commits, then the send fails retriably → the handler throws.
    await expect(handlePodSigned(msgFor(shp, podId), depsWith(new ThrowingSender(true)))).rejects.toThrow();
    expect(await invoiceEvents(shp)).toHaveLength(1);

    // Context drift between deliveries: an AMBIGUOUS interline leg appears (NULL split_bps) — the
    // fresh path would hold(interline_unresolved) on this. A redelivered message must NOT re-judge
    // the committed issue; orphaning the email forever would break "POD → invoice + evidence, same
    // second" on nothing but a data edit.
    await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO legs (id, shipment_id, seq, kind, executor_party_id, geo) VALUES (?,?,?,?,?,?)")
      .bind(`leg-${shp}-drift`, shp, 9, "interline", "party-interline", "{}")
      .run();

    const sender = new RecordingSender();
    const outcome = await handlePodSigned(msgFor(shp, podId), depsWith(sender));
    expect(outcome.status).toBe("issued_sent"); // the fast path sends from the STORED payload
    if (outcome.status !== "issued_sent") throw new Error("unreachable");
    expect(await invoiceEvents(shp)).toHaveLength(1); // still exactly one
    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]!.idempotency_key).toBe(`evidence-email/${outcome.invoice_event_id}`);
    expect(sender.messages[0]!.html).toContain(formatCents(sell)); // the stored payload's total, verbatim
  });
});

// ─── Task 7 (REQ-031/003) — THE INVOICE BINDS TO THE EXACT ACCEPTED BOOKING QUOTE ──────────────────────
//
// A booked shipment's invoice MUST project the quote the booking ACCEPTED — never the "latest quote.priced
// before the POD". The bug: a re-quote (quote B) priced AFTER the booking but BEFORE the POD used to win the
// latest-pre-POD selection, billing quote B instead of the booked quote A. The fix binds the Biller to
// booking.created.payload.quote_event_id. An inconsistent booking quote (dangling / wrong-kind / not-accepted
// on this stream) FAILS CLOSED: a durable held invoice reason, zero money/send.
describe("Task 7 — the invoice projects the exact accepted booking quote, not a later quote (REQ-031/003)", () => {
  let t7clock = 1_744_000_000_000;
  // A penny-parity-valid quote.priced with a chosen sell (lines sum to sell), appended through the real DO.
  async function seedQuotePricedSell(shipmentId: string, sell: number): Promise<string> {
    const id = crypto.randomUUID();
    await seqStub.append({
      tenant: TENANT,
      streamId: `s:${shipmentId}`,
      input: {
        id,
        shipment_id: shipmentId,
        ts: t7clock++,
        actor: { party: "agent:concierge" },
        party_refs: [],
        evidence: [],
        source: "native",
        confidence: 10_000,
        kind: "quote.priced",
        payload: {
          sell,
          lines: [{ kind: "freight", code: "freight", amount_cents: sell }],
          floors: { contribution: 1, full: 1, target: 1 }, // sell ≫ target ⇒ clears the floor (issues)
          versions: { rate_config_ids: ["rc-t7-v1"] },
          basis: {},
        },
      },
    });
    return id;
  }
  async function seedAccepted(shipmentId: string, quoteId: string): Promise<string> {
    const id = crypto.randomUUID();
    await seqStub.append({
      tenant: TENANT,
      streamId: `s:${shipmentId}`,
      input: {
        id, shipment_id: shipmentId, ts: t7clock++, actor: { party: "party-shipper" },
        party_refs: [], evidence: [], source: "native", confidence: 10_000,
        kind: "quote.accepted", payload: { quote_event_id: quoteId },
      },
    });
    return id;
  }
  // booking.created through the real gated DO — refs `quoteId`. bill_to = party-bill-to (deliverable email,
  // clear credit) so the T6 gates pass and the booking commits.
  async function seedBooking(shipmentId: string, quoteId: string): Promise<void> {
    await seqStub.append({
      tenant: TENANT,
      streamId: `s:${shipmentId}`,
      input: {
        id: crypto.randomUUID(), shipment_id: shipmentId, ts: t7clock++, actor: { party: "party-shipper" },
        party_refs: [], evidence: [], source: "native", confidence: 10_000,
        kind: "booking.created",
        payload: {
          quote_event_id: quoteId,
          shipper_party_id: "party-shipper",
          consignee_party_id: "party-consignee",
          bill_to_party_id: "party-bill-to",
          division: "main",
        },
      },
    });
    // booking.created materializes skeleton legs whose provisional executor is the bill_to; simulate dispatch
    // provisioning the tenant's OWN executor (the POD signer, party-carrier) so the shipment is DIRECT — not
    // misread as interline by resolveInterline (2 distinct executors). The seeded delivery leg keeps its geo.
    await env.TENANT_A_DB.prepare("UPDATE legs SET executor_party_id = 'party-carrier' WHERE shipment_id = ?").bind(shipmentId).run();
  }

  it("AUTHORITY CHAIN: quote A priced → accepted → booking refs A → quote B priced later → POD → the invoice equals A (never the later B)", async () => {
    const shp = "biller-t7-authority";
    await seedShipment(shp);
    await seedDeliveryLeg(shp);
    const sellA = 111_100;
    const sellB = 222_200; // a DIFFERENT, later quote — must be IGNORED
    const quoteA = await seedQuotePricedSell(shp, sellA);
    await seedAccepted(shp, quoteA);
    await seedBooking(shp, quoteA);
    await seedQuotePricedSell(shp, sellB); // priced AFTER the booking, BEFORE the POD — the latest-pre-POD trap
    const podId = await driveToPod(shp);

    const sender = new RecordingSender();
    const outcome = await handlePodSigned(msgFor(shp, podId), depsWith(sender));
    expect(outcome.status, JSON.stringify(outcome)).toBe("issued_sent");

    // The invoice projects the BOOKED quote A, never the later B.
    const inv = (await invoiceEvents(shp))[0]!;
    const lines = (inv.payload as { lines: { amount_cents: number }[] }).lines;
    expect(lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(sellA);
    expect(lines.reduce((s, l) => s + l.amount_cents, 0)).not.toBe(sellB);
    const moneyTotal = (await moneyLines(shp)).reduce((s, l) => s + l.amount_cents, 0);
    expect(moneyTotal).toBe(sellA);
    expect(sender.messages[0]!.html).toContain(formatCents(sellA));
  });

  it("INCONSISTENT BOOKING QUOTE: a booking whose quote_event_id is not an accepted quote.priced on the stream → held(no_quote), ZERO invoice/money/send", async () => {
    const shp = "biller-t7-dangling";
    await seedShipment(shp);
    await seedDeliveryLeg(shp);
    // A booking that references a NON-EXISTENT quote (never priced/accepted) — an authority inconsistency.
    await seedBooking(shp, crypto.randomUUID());
    // A stray quote.priced exists on the stream, but it is NOT the booked one — the Biller must NOT fall back to it.
    await seedQuotePricedSell(shp, 150_000);
    const podId = await driveToPod(shp);

    const sender = new RecordingSender();
    const outcome = await handlePodSigned(msgFor(shp, podId), depsWith(sender));
    expect(outcome.status, JSON.stringify(outcome)).toBe("held");
    if (outcome.status !== "held") throw new Error("unreachable");
    expect(outcome.reason).toBe("no_quote");

    expect(await invoiceEvents(shp)).toHaveLength(0);
    expect(await moneyLines(shp)).toHaveLength(0);
    expect(sender.messages).toHaveLength(0);
  });
});

// ─── WP-08 T5 hardening (REQ-028/052) — deliveryStopGeo must PREFER a non-empty-geo delivery leg so the
// empty booking.created skeleton (deterministic `${id}:delivery`, geo '{}') can never SHADOW the real
// coordinates T8/dispatch provisions — even if the real leg lands at a HIGHER seq (INSERT, not UPDATE). ──
describe("deliveryStopGeo prefers non-empty geo over the empty skeleton (T5 shadowing, REQ-028/052)", () => {
  async function insertDeliveryLeg(shipmentId: string, id: string, seq: number, geo: string): Promise<void> {
    await env.TENANT_A_DB.prepare(
      "INSERT OR IGNORE INTO legs (id, shipment_id, seq, kind, executor_party_id, geo) VALUES (?,?,?,?,?,?)",
    )
      .bind(id, shipmentId, seq, "delivery", "party-carrier", geo)
      .run();
  }

  it("returns the REAL geo even when the empty skeleton sits at a LOWER seq", async () => {
    const shp = "biller-geo-shadow";
    await seedShipment(shp);
    await insertDeliveryLeg(shp, `${shp}:delivery`, 1, "{}"); // booking skeleton — LOWER seq, empty
    await insertDeliveryLeg(shp, `${shp}:delivery-real`, 2, JSON.stringify({ lat_e6: 37_421_000, lon_e6: -122_084_000 })); // HIGHER seq, real
    expect(await deliveryStopGeo(env.TENANT_A_DB, shp)).toEqual({ lat_e6: 37_421_000, lon_e6: -122_084_000 });
  });

  it("still returns undefined when ONLY the empty skeleton exists (fail-closed, unchanged)", async () => {
    const shp = "biller-geo-skeleton-only";
    await seedShipment(shp);
    await insertDeliveryLeg(shp, `${shp}:delivery`, 1, "{}");
    expect(await deliveryStopGeo(env.TENANT_A_DB, shp)).toBeUndefined();
  });
});
