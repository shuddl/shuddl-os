import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { LedgerEvent } from "@shuddl/contracts";
import type { AppendedEvent } from "../src/do/sequencer.js";
import { hashEvent, verifyChain } from "@shuddl/ledger/chain";
import { rowToEvent } from "@shuddl/ledger/lens";
import { signEvent, verifyEventSig } from "@shuddl/ledger/sign";
import { TENANT_SLUG, TEST_DEVICE_ID, TEST_DEVICE_PUBLIC_JWK, ensureSchema, testDeviceSigningKey, token } from "./helpers.js";

// The Task-13 DO is the heart of the ledger: it assigns seq/prev_hash, verifies the device
// signature, enforces the invoice gate (I2), resolves visibility server-side, and writes the
// event + every projection in ONE db.batch() so I1 holds both directions (REQ-002/011/025).

const TENANT = TENANT_SLUG;
const HEX64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const GEO = { lat_e6: 37_421_000, lon_e6: -122_084_000 };

// The DO's RPC return type (a 35-member zod union with a recursive JsonObject payload) makes the
// generic DurableObjectStub<ShipmentSequencer> RPC mapper explode/degrade to `never`, so bind the
// stub to a hand-written surface. Runtime is unchanged — this is purely the call-site type.
type SeqStub = DurableObjectStub & {
  append(req: { tenant: string; streamId: string; input: unknown }): Promise<AppendedEvent>;
};
function stubFor(streamId: string): SeqStub {
  return env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${TENANT}|${streamId}`)) as unknown as SeqStub;
}

// A valid EventInput (the client-suppliable subset — NO seq/prev_hash/recorded_at/visibility/hash/
// stream_id). shipment_id is derived from the stream so the DB CHECK (stream_id='s:'||shipment_id)
// holds. Fresh uuid per call unless overridden.
function inputFor(streamId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: streamId.startsWith("s:") ? streamId.slice(2) : undefined,
    ts: 1_720_000_000_000,
    actor: { party: "party-shipper" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "quote.requested",
    payload: {},
    ...over,
  };
}

function invoicePayload(invoiceId: string): Record<string, unknown> {
  return {
    invoice_id: invoiceId,
    party_id: "party-bill-to",
    division: "main",
    lines: [{ line_no: 1, kind: "freight", amount_cents: 120_000, gl_map: "4000-REV" }],
  };
}

async function rawRows(streamId: string): Promise<Record<string, string | number | null>[]> {
  const res = await env.TENANT_A_DB.prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq").bind(streamId).all();
  return res.results as Record<string, string | number | null>[];
}

async function eventsFor(streamId: string): Promise<LedgerEvent[]> {
  return (await rawRows(streamId)).map((r) => rowToEvent(r));
}

// Shared, idempotent setup (migrations + control-plane seed + parties + the fixed device key). Safe
// under isolatedStorage:false where every file shares one D1 — see test/helpers.ts.
beforeAll(async () => {
  await ensureSchema(env);
});

// (a) concurrent appends -> dense, gapless seqs (PRODUCTION SHAPE: a fresh stub per request).
// PROVES: 100 concurrent appends, each via its OWN `stubFor(...)` (exactly as a real HTTP handler does
// `env.SHIPMENT_SEQ.get(idFromName(...))` per request — NOT 100 calls on one shared stub, which pipeline
// differently), land dense seqs 0..99 with no duplicate seq and a valid chain. All fresh stubs resolve
// to the SAME DO instance (idFromName is deterministic), so this is real cross-request concurrency.
//
// This test IS the mutex regression. Measured empirically (mutex deleted from `#append`, this exact
// fresh-stub test re-run): it goes RED with `D1_ERROR: I3: append-only: SQLITE_CONSTRAINT` — a DO input
// gate does NOT close across a plain D1 subrequest await, so unserialized appends read the same tail,
// assign the same seq, and collide on events_guard_ins. The mutex is therefore load-bearing, and this
// test protects it. The duplicate-seq query below observes that failure mode DIRECTLY (a regression shows
// up as duplicate rows / a Promise.all rejection here, not as a downstream verifyChain surprise).
it("assigns dense, gapless seqs under 100 concurrent appends via fresh stubs (production shape)", async () => {
  const streamId = "s:shp-a";
  const results = await Promise.all(
    Array.from({ length: 100 }, () => stubFor(streamId).append({ tenant: TENANT, streamId, input: inputFor(streamId) })),
  );
  expect(new Set(results.map((r) => r.seq)).size).toBe(100);
  expect(Math.max(...results.map((r) => r.seq))).toBe(99);
  // Direct observation of the failure mode: NO two rows may share a seq. A double-assign collides on the
  // (stream_id, seq) PK / events_guard_ins, so it would surface here (and Promise.all would have rejected).
  const dupes = await env.TENANT_A_DB.prepare(
    "SELECT seq, COUNT(*) AS n FROM events WHERE stream_id = ? GROUP BY seq HAVING n > 1",
  )
    .bind(streamId)
    .all();
  expect(dupes.results).toEqual([]);
  const events = await eventsFor(streamId);
  expect(events).toHaveLength(100);
  expect((await verifyChain(events)).ok).toBe(true);
});

// (b) structural tenant pinning by id-equality
it("a forged tenant in the RPC is rejected by id-equality (FORBIDDEN)", async () => {
  const streamId = "s:shp-b";
  const stub = stubFor(streamId); // id derived from tenant-a
  await expect(stub.append({ tenant: "tenant-b", streamId, input: inputFor(streamId) })).rejects.toThrow(/FORBIDDEN/);
  // and nothing was written to tenant-a's D1 under that stream
  expect(await eventsFor(streamId)).toHaveLength(0);
});

// (c) crash-heal: D1 is truth, the tail cache self-heals
it("crash-heal: wiping DO storage + nulling tail/pin resumes from the D1 tail", async () => {
  const streamId = "s:shp-c";
  const stub = stubFor(streamId);
  for (let i = 0; i < 3; i++) await stub.append({ tenant: TENANT, streamId, input: inputFor(streamId) });
  await runInDurableObject(stub, async (inst: unknown, state) => {
    await state.storage.deleteAll();
    (inst as { tail: unknown }).tail = null; // wiping storage alone leaves the cache warm — null it too
    (inst as { pin: unknown }).pin = null;
  });
  const r = await stub.append({ tenant: TENANT, streamId, input: inputFor(streamId) });
  expect(r.seq).toBe(3);
  const events = await eventsFor(streamId);
  const seq2 = events.find((e) => e.seq === 2)!;
  expect(r.prev_hash).toBe(seq2.hash); // prev_hash reloaded from D1, not from a stale cache
  expect((await verifyChain(events)).ok).toBe(true);
});

// (d) idempotent replay by event id
it("a duplicate event id returns the original row; the count is unchanged", async () => {
  const streamId = "s:shp-d";
  const stub = stubFor(streamId);
  const input = inputFor(streamId);
  const first = await stub.append({ tenant: TENANT, streamId, input });
  const again = await stub.append({ tenant: TENANT, streamId, input });
  expect(again.id).toBe(first.id);
  expect(again.seq).toBe(first.seq);
  expect(await eventsFor(streamId)).toHaveLength(1);
});

// (e) idempotent replay by (device_id, device_seq)
it("a duplicate (device_id, device_seq) returns the original (offline reserve)", async () => {
  const streamId = "s:shp-e";
  const stub = stubFor(streamId);
  const first = await stub.append({ tenant: TENANT, streamId, input: inputFor(streamId, { device_id: "dev-e", device_seq: 7 }) });
  // a DIFFERENT event id but the same device dedupe key must return the original row
  const again = await stub.append({ tenant: TENANT, streamId, input: inputFor(streamId, { device_id: "dev-e", device_seq: 7 }) });
  expect(again.id).toBe(first.id);
  expect(again.seq).toBe(first.seq);
  expect(await eventsFor(streamId)).toHaveLength(1);
});

// (f) I2 gate: no invoice without a signed POD
it("invoice.issued with no pod.signed on the stream -> GATE_BLOCKED carrying required_evidence", async () => {
  const streamId = "s:shp-f";
  const stub = stubFor(streamId);
  const err = await stub
    .append({ tenant: TENANT, streamId, input: inputFor(streamId, { kind: "invoice.issued", payload: invoicePayload("inv-f") }) })
    .then(() => null, (e: Error) => e);
  expect(err).not.toBeNull();
  const msg = String(err!.message);
  expect(msg.startsWith("GATE_BLOCKED:")).toBe(true);
  const gate = JSON.parse(msg.slice(msg.indexOf(":") + 1)) as { required_evidence: string[] };
  expect(gate.required_evidence).toEqual(["pod.signed"]);
  expect(await eventsFor(streamId)).toHaveLength(0);
});

// (g) I1 both directions: invoice.issued after pod.signed lands its money_lines in the SAME batch
it("invoice.issued after pod.signed projects money_lines in the same batch (I1)", async () => {
  const streamId = "s:shp-g";
  const stub = stubFor(streamId);
  await stub.append({
    tenant: TENANT,
    streamId,
    input: inputFor(streamId, { kind: "pod.signed", payload: { signature_hash: HEX64, geo: GEO, unwitnessed: true } }),
  });
  const inv = await stub.append({ tenant: TENANT, streamId, input: inputFor(streamId, { kind: "invoice.issued", payload: invoicePayload("inv-g") }) });
  const ml = await env.TENANT_A_DB.prepare("SELECT * FROM money_lines WHERE event_id = ?").bind(inv.id).all();
  expect(ml.results.length).toBeGreaterThan(0);
  expect((ml.results[0] as { event_id: string }).event_id).toBe(inv.id); // the line shares the event's id (I1)
});

// (h) client-supplied visibility can only NARROW, and never enters the hashed envelope
it("requested_visibility 'counterparty' on approval.requested is stored 'internal' and the hash verifies", async () => {
  const streamId = "s:shp-h";
  const stub = stubFor(streamId);
  const r = await stub.append({
    tenant: TENANT,
    streamId,
    input: inputFor(streamId, { kind: "approval.requested", requested_visibility: "counterparty" }),
  });
  expect(r.visibility).toBe("internal"); // counterparty is WIDER than the default internal -> not applied
  const row = (await env.TENANT_A_DB.prepare("SELECT * FROM events WHERE id = ?").bind(r.id).first<Record<string, string | number | null>>())!;
  expect(row.visibility).toBe("internal");
  // if requested_visibility had entered the hashed bytes, rowToEvent could never reproduce the hash
  expect(await hashEvent(rowToEvent(row))).toBe(row.hash);
});

// (i) positions bypass the sequencer
it("position.updated is rejected here (VALIDATION_FAILED) — the bypass route owns it", async () => {
  const streamId = "s:shp-i";
  const stub = stubFor(streamId);
  await expect(
    stub.append({ tenant: TENANT, streamId, input: inputFor(streamId, { kind: "position.updated", payload: { lat_e6: 1, lon_e6: 2 } }) }),
  ).rejects.toThrow(/VALIDATION_FAILED/);
});

// (j) device signature verification
it("a bad device signature is rejected (UNAUTHORIZED); a good one lands with sig stored and verifies on read-back", async () => {
  const streamId = "s:shp-j";
  const stub = stubFor(streamId);
  const signedActor = { party: "party-carrier", user: "user-driver", device: TEST_DEVICE_ID };

  await expect(
    stub.append({ tenant: TENANT, streamId, input: inputFor(streamId, { kind: "freight.photographed", actor: signedActor, sig: "AAAA" }) }),
  ).rejects.toThrow(/UNAUTHORIZED/);

  const good = inputFor(streamId, { kind: "freight.photographed", actor: signedActor });
  good.sig = await signEvent(good as Parameters<typeof signEvent>[0], await testDeviceSigningKey());
  const r = await stub.append({ tenant: TENANT, streamId, input: good });
  expect(r.sig).toBe(good.sig);
  const row = (await env.TENANT_A_DB.prepare("SELECT * FROM events WHERE id = ?").bind(r.id).first<Record<string, string | number | null>>())!;
  expect(row.sig).toBe(good.sig);
  expect(await verifyEventSig(rowToEvent(row), TEST_DEVICE_PUBLIC_JWK)).toBe(true);
});

// (k) the write path and the read path agree on the canonical bytes
it("every appended event round-trips: hashEvent(rowToEvent(row)) === row.hash", async () => {
  const streamId = "s:shp-k";
  const stub = stubFor(streamId);
  await stub.append({ tenant: TENANT, streamId, input: inputFor(streamId) }); // quote.requested
  await stub.append({
    tenant: TENANT,
    streamId,
    input: inputFor(streamId, {
      kind: "booking.created",
      payload: { division: "main", shipper_party_id: "party-shipper", consignee_party_id: "party-consignee", bill_to_party_id: "party-bill-to", created_ts: 1_720_000_000_000 },
    }),
  });
  await stub.append({
    tenant: TENANT,
    streamId,
    input: inputFor(streamId, { kind: "pod.signed", payload: { signature_hash: HEX64, geo: GEO, unwitnessed: true } }),
  });
  const rows = await rawRows(streamId);
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(await hashEvent(rowToEvent(row))).toBe(row.hash);
  }
});

// (l) REQ-133 — a malformed stream id must be a clean VALIDATION_FAILED, never a leaked ZodError.
// EventInput.parse does NOT validate `stream_id` (it isn't an input field), so a shipment id with an
// apostrophe/space/semicolon slips through the input schema, then fails LedgerEvent's stream_id regex at
// the batch-build parse. Unwrapped, that raw ZodError crosses the RPC hop as a JSON issues array (`[{...`)
// — Task 14 splits on the first colon, gets a non-code, and returns 500 INTERNAL while leaking Zod detail.
// The DO must reject the format UP FRONT with the `CODE:json` contract intact.
describe("malformed stream id -> VALIDATION_FAILED, not a leaked ZodError (REQ-133)", () => {
  for (const bad of ["s:o'brien", "s:has space", "s:semi;colon"]) {
    it(`rejects ${JSON.stringify(bad)} with the contract shape (not a raw "[{...}]")`, async () => {
      const err = await stubFor(bad)
        .append({ tenant: TENANT, streamId: bad, input: inputFor(bad) })
        .then(() => null, (e: Error) => e);
      expect(err).not.toBeNull();
      const msg = String(err!.message);
      expect(msg).toMatch(/^VALIDATION_FAILED:/); // contract shape holds
      expect(msg.startsWith("[")).toBe(false); // NOT a raw Zod issues array
      expect(msg).not.toContain("invalid_string"); // no Zod internals leaked
    });
  }

  it("a well-formed stream id still appends (regex not over-tightened)", async () => {
    const streamId = "s:shp-streamok";
    const r = await stubFor(streamId).append({ tenant: TENANT, streamId, input: inputFor(streamId) });
    expect(r.seq).toBe(0);
  });
});

// (m) The client-facing proof: the malformed id, URL-encoded, through the real route.
it("POST /v1/shipments/o%27brien/events -> 400 VALIDATION_FAILED with no Zod internals in the body", async () => {
  const tok = await token({ sub: "u-ops-streamid", tenant: TENANT, role: "ops" });
  const res = await SELF.fetch("https://api.local/v1/shipments/o%27brien/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify(inputFor("s:o'brien")),
  });
  expect(res.status).toBe(400);
  const body = await res.text();
  expect(JSON.parse(body).code).toBe("VALIDATION_FAILED");
  expect(body).not.toContain("invalid_string");
  expect(body).not.toContain("ZodError");
  expect(body).not.toContain("[{");
});

describe("sequencer wiring sanity", () => {
  it("CONTROL_DB seeded the tenant + device key", async () => {
    const t = await env.CONTROL_DB.prepare("SELECT policy FROM tenants WHERE slug = ?").bind(TENANT).first<{ policy: string }>();
    expect(t?.policy).toBe("{}");
  });
});
