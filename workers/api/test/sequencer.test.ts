import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { LedgerEvent } from "@shuddl/contracts";
import type { AppendedEvent } from "../src/do/sequencer.js";
import { hashEvent, verifyChain } from "@shuddl/ledger/chain";
import { rowToEvent } from "@shuddl/ledger/lens";
import { signEvent, verifyEventSig } from "@shuddl/ledger/sign";
import { applyMigrations } from "@shuddl/ledger/migrate";
import controlSql from "../../../db/control/migrations/0001_control.sql?raw";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";
import partyRefsGuard from "../../../db/tenant/migrations/0004_party_refs_guard.sql?raw";

// The Task-13 DO is the heart of the ledger: it assigns seq/prev_hash, verifies the device
// signature, enforces the invoice gate (I2), resolves visibility server-side, and writes the
// event + every projection in ONE db.batch() so I1 holds both directions (REQ-002/011/025).

const TENANT = "tenant-a";
const HEX64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const GEO = { lat_e6: 37_421_000, lon_e6: -122_084_000 };

let privateKey: CryptoKey;
let publicJwk: JsonWebKey;

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

beforeAll(async () => {
  // Control plane: migrate + seed a tenant (policy {}) and a driver user carrying a real P-256
  // device JWK — #policy / #deviceKey read these on every append.
  await applyMigrations(env.CONTROL_DB, [{ path: "0001_control.sql", sql: controlSql }]);
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  privateKey = kp.privateKey;
  publicJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);

  await env.CONTROL_DB.prepare("INSERT INTO tenants (id, name, slug, plan, policy, created_ts) VALUES (?,?,?,?,?,?)")
    .bind("t-a", "Tenant A", TENANT, "pilot", "{}", 0)
    .run();
  await env.CONTROL_DB.prepare("INSERT INTO users (id, tenant_id, email, role, auth, device_keys) VALUES (?,?,?,?,?,?)")
    .bind("u-driver", "t-a", "driver@tenant-a.test", "driver", "{}", JSON.stringify([{ device_id: "device-1", public_jwk: publicJwk }]))
    .run();

  // Tenant plane: full ledger schema + parties (passport accrual FK requires the party to exist).
  await applyMigrations(env.TENANT_A_DB, [
    { path: "0001_ledger_core.sql", sql: ledgerCore },
    { path: "0002_domain.sql", sql: domain },
    { path: "0003_insert_guards.sql", sql: insertGuards },
    { path: "0004_party_refs_guard.sql", sql: partyRefsGuard },
  ]);
  const parties: [string, string][] = [
    ["party-shipper", "shipper"],
    ["party-carrier", "carrier"],
    ["party-consignee", "consignee"],
    ["party-bill-to", "broker"],
    ["party-interline", "carrier"],
  ];
  for (const [id, kind] of parties) {
    await env.TENANT_A_DB.prepare("INSERT INTO parties (id, kind, names) VALUES (?,?,?)").bind(id, kind, "{}").run();
  }
});

// (a) the mutex proof
it("assigns dense seqs 0..99 under 100 concurrent appends; verifyChain green", async () => {
  const streamId = "s:shp-a";
  const stub = stubFor(streamId);
  const results = await Promise.all(
    Array.from({ length: 100 }, () => stub.append({ tenant: TENANT, streamId, input: inputFor(streamId) })),
  );
  expect(new Set(results.map((r) => r.seq)).size).toBe(100);
  expect(Math.max(...results.map((r) => r.seq))).toBe(99);
  const events = await eventsFor(streamId);
  expect(events).toHaveLength(100);
  const chain = await verifyChain(events);
  expect(chain.ok).toBe(true);
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
  const signedActor = { party: "party-carrier", user: "user-driver", device: "device-1" };

  await expect(
    stub.append({ tenant: TENANT, streamId, input: inputFor(streamId, { kind: "freight.photographed", actor: signedActor, sig: "AAAA" }) }),
  ).rejects.toThrow(/UNAUTHORIZED/);

  const good = inputFor(streamId, { kind: "freight.photographed", actor: signedActor });
  good.sig = await signEvent(good as Parameters<typeof signEvent>[0], privateKey);
  const r = await stub.append({ tenant: TENANT, streamId, input: good });
  expect(r.sig).toBe(good.sig);
  const row = (await env.TENANT_A_DB.prepare("SELECT * FROM events WHERE id = ?").bind(r.id).first<Record<string, string | number | null>>())!;
  expect(row.sig).toBe(good.sig);
  expect(await verifyEventSig(rowToEvent(row), publicJwk)).toBe(true);
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

describe("sequencer wiring sanity", () => {
  it("CONTROL_DB seeded the tenant + device key", async () => {
    const t = await env.CONTROL_DB.prepare("SELECT policy FROM tenants WHERE slug = ?").bind(TENANT).first<{ policy: string }>();
    expect(t?.policy).toBe("{}");
  });
});
