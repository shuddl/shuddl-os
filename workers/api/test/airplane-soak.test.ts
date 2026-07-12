import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyChain } from "@shuddl/ledger/chain";
import { rowToEvent } from "@shuddl/ledger/lens";
import { signEvent } from "@shuddl/ledger/sign";
import { sha256Hex } from "@shuddl/ledger/canonical";
import type { EventInput, EventKind } from "@shuddl/contracts";
import {
  capture,
  generateDeviceKey,
  type CaptureParams,
  type DeviceContext,
  type EvidenceField,
} from "@shuddl/driver-core";
import { TENANT_SLUG, ensureSchema, token } from "./helpers.js";

// ─── REQ-016 / GA-14 / CLAUDE.md rule 6 — THE AIRPLANE-MODE SOAK (WP-05 Task 7) ─────────────────────
//
// The DoD proof that offline capture across TWO devices merges through the REAL sequencer with ZERO
// loss and ZERO dupes, and that the WP-02 hash-chain still verifies across the merged, interleaved,
// deduped set. This drives the honest path end to end: @shuddl/driver-core `capture` MINTS 50 signed
// offline events across two devices (each with its OWN generated P-256 key + its OWN monotonic
// `device_seq` 0,1,2,…), evidence bytes hashed AT capture (REQ-017); then those events are SYNCED in
// an airplane-recovery pattern (a seeded shuffle + duplicate re-sends) through the live DO, which
// verifies each device signature, dedups by `(device_id, device_seq)`, assigns the per-stream `seq`,
// and hash-chains — the same sequencer every REQ-030 gate test hits, not a stand-in.
//
// VENUE: the real sequencer (preferred by Task 7 STEP 0). The 2-device gate-valid setup is tractable —
// device keys register in the control plane (`users.device_keys[]`, read by the DO's #deviceKey), and
// legs/fence/consent seed exactly as the gates suite does. No fallback to the pure-merge venue.
//
// SCOPE (honest note): the sync POSTs use an OPS token (unrestricted write scope), NOT the driver
// write-scope path — the DoD here is offline merge / dedup / chain, and the device CO-SIGNATURE is
// still verified by the DO on every event. The driver-assignment gate (a driver may only write to a
// shipment assigned to them) is a separate concern, covered in gates.test / the route suite.
//
// GATES vs. SHUFFLE (honest note): the Gatekeeper is enforced SERVER-SIDE per stream, so a gated
// transition (e.g. `stop.departed`) is REFUSED until its evidence is already on that stream — a
// correctness property, not a bug. A pure global shuffle therefore cannot be appended in one pass:
// an out-of-order gated event returns 403 GATE_BLOCKED and appends NOTHING (a refusal never
// half-writes). We model the real offline drain faithfully: shuffle all arrivals (incl. duplicate
// re-sends) with a seeded PRNG, POST every item, and RE-QUEUE a GATE_BLOCKED item for a later pass —
// exactly the client's "keep retrying the queue until it drains" loop. The loop MUST drain (a
// permanent block or a lost event fails the assertion — a real finding), and duplicates collapse in
// the DO regardless of arrival order. Control flow is fully deterministic (seeded PRNG — no Date.now /
// Math.random); `crypto.randomUUID` for event ids is fine because dedup is by `(device_id, device_seq)`.

const TENANT = TENANT_SLUG;

// One delivery fence at FENCE_CENTER; INSIDE sits on it (distance 0 ≪ the 150 m default radius) and
// derives to operating state "CA" (deriveOperatingState), so ONE ConsentAck("CA") per stream covers
// every GPS stamp on that stream. Mirrors the gates suite's fixture exactly.
const FENCE_CENTER = { lat_e6: 37_421_000, lon_e6: -122_084_000 };
const INSIDE = { lat_e6: 37_421_000, lon_e6: -122_084_000, accuracy_m: 5 };
const CONSENT = { doc_kind: "consent", policy_version: "v1", operating_state: "CA", acknowledged: true } as const;

const SEED = 0x50a4b1e5; // fixed PRNG seed → the whole soak (shuffle + re-send choice) is reproducible.

// ── deterministic PRNG (mulberry32) — seeds the shuffle + re-send selection; NEVER Math.random ──────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: readonly T[], rnd: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

// ── HTTP helpers (the REAL append path: POST → sequencer DO → Gatekeeper), mirroring gates.test ──────
interface Res {
  status: number;
  json: Record<string, unknown> | null;
}
async function post(shipmentId: string, body: unknown, tok: string): Promise<Res> {
  const res = await SELF.fetch(`https://api.local/v1/shipments/${shipmentId}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function seedShipment(id: string): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, created_ts) VALUES (?,?,?,?,0)",
  )
    .bind(id, "party-shipper", "party-consignee", "party-bill-to")
    .run();
}
async function seedDeliveryLeg(shipmentId: string): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO legs (id, shipment_id, seq, kind, executor_party_id, geo) VALUES (?,?,?,?,?,?)",
  )
    .bind(`leg-${shipmentId}-0`, shipmentId, 0, "delivery", "party-carrier", JSON.stringify(FENCE_CENTER))
    .run();
}

// ── D1 read helpers, scoped to the soak's own streams / devices (isolatedStorage is OFF — never assume
//    an empty table; other files' rows persist) ──────────────────────────────────────────────────────
async function streamCount(shipmentId: string): Promise<number> {
  const row = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS n FROM events WHERE stream_id = ?")
    .bind(`s:${shipmentId}`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
async function deviceSeqs(deviceId: string): Promise<number[]> {
  const res = await env.TENANT_A_DB.prepare("SELECT device_seq FROM events WHERE device_id = ? ORDER BY device_seq")
    .bind(deviceId)
    .all<{ device_seq: number }>();
  return res.results.map((r) => r.device_seq);
}
async function streamRows(shipmentId: string): Promise<Record<string, string | number | null>[]> {
  const res = await env.TENANT_A_DB.prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq")
    .bind(`s:${shipmentId}`)
    .all();
  return res.results as Record<string, string | number | null>[];
}

// ── device factory: a fresh P-256 key + a monotonic device_seq counter (0,1,2,…) + a DeviceContext ───
interface SoakDevice {
  label: "A" | "B";
  device_id: string;
  publicJwk: JsonWebKey;
  ctx: DeviceContext;
}
async function makeDevice(label: "A" | "B"): Promise<SoakDevice> {
  const key = await generateDeviceKey();
  let seq = 0;
  const ctx: DeviceContext = {
    device_id: key.device_id,
    privateKey: key.keyPair.privateKey,
    party: "party-carrier", // a seeded party (passport accrual FK); the merge is device-driven, not party-driven
    nextSeq: () => seq++, // MONOTONIC per device — the offline dedupe counter (REQ-016)
  };
  return { label, device_id: key.device_id, publicJwk: key.publicJwk, ctx };
}

// ── a captured offline event + the metadata the sync/assert phases need ──────────────────────────────
interface Captured {
  device: SoakDevice;
  shipmentId: string;
  kind: EventKind;
  event: EventInput;
}

// A step of a stop sequence: [kind, payload-minus-evidence-field, evidence field?]. When the third
// element is present, capture hashes deterministic evidence bytes AT capture and writes the hash into
// that payload field (REQ-017); the raw bytes ride out as a deferred upload (unused here).
type Step = [EventKind, Record<string, unknown>, EvidenceField?];

let evidenceCounter = 0;
function nextEvidenceBytes(): Uint8Array {
  // Deterministic bytes (no Math.random): a 32-byte pattern keyed by a capture-ordinal counter, so the
  // captured content-hash is reproducible run to run.
  const n = evidenceCounter++;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (n + i * 7 + 3) & 0xff;
  return bytes;
}

let captureClock = 1_720_000_000_000; // epoch-ms base; +1 per capture so captured_ts is monotonic.

// Capture a device's stop sequence IN gate-valid causal order (the device physically captures count
// before depart, arrival before delivery, …). device_seq is stamped by capture in THIS call order, so
// each stream's per-device events are gate-ordered by device_seq — which is what lets the retry-drain
// converge without a permanent block.
async function captureStop(device: SoakDevice, shipmentId: string, steps: readonly Step[]): Promise<Captured[]> {
  const out: Captured[] = [];
  for (const [kind, payload, evidenceField] of steps) {
    const ts = captureClock++;
    const params: CaptureParams = { shipment_id: shipmentId, kind, payload, ts, captured_ts: ts };
    if (evidenceField !== undefined) params.evidence = { bytes: nextEvidenceBytes(), field: evidenceField };
    const { event, deferred } = await capture(params, device.ctx);
    // REQ-017 — the evidence content-hash is in the payload field AT capture (never re-keyed later).
    if (evidenceField !== undefined) {
      expect(deferred).toBeDefined();
      expect((event.payload as Record<string, unknown>)[evidenceField]).toBe(deferred!.hash);
      expect(deferred!.hash).toBe(await sha256Hex(deferred!.bytes));
    }
    out.push({ device, shipmentId, kind, event });
  }
  return out;
}

// A full single-device pickup+delivery stop (9 gate-valid events).
const FULL: readonly Step[] = [
  ["document.attached", { ...CONSENT }],
  ["stop.arrived", { geo: { ...INSIDE }, auto: true }],
  ["freight.counted", { pieces: 12 }],
  ["freight.photographed", { photo_kind: "freight" }, "photo_hash"],
  ["dims.captured", { l_in: 48, w_in: 40, h_in: 60, pieces: 4, method: "camera" }],
  ["custody.transferred", { from_party: "party-shipper", to_party: "party-carrier" }],
  ["stop.departed", { geo: { ...INSIDE }, auto: true }],
  ["pod.signed", { geo: { ...INSIDE } }, "signature_hash"],
  ["delivery.evidenced", { geo: { ...INSIDE } }, "placed_photo_hash"],
];
// The pickup half of a HANDOFF stop, captured by device A (6 events).
const HANDOFF_PICKUP: readonly Step[] = [
  ["document.attached", { ...CONSENT }],
  ["stop.arrived", { geo: { ...INSIDE }, auto: true }],
  ["freight.counted", { pieces: 12 }],
  ["freight.photographed", { photo_kind: "freight" }, "photo_hash"],
  ["custody.transferred", { from_party: "party-shipper", to_party: "party-carrier" }],
  ["stop.departed", { geo: { ...INSIDE }, auto: true }],
];
// The delivery half of the SAME HANDOFF stream, captured by device B (3 events) — proves the merge is
// keyed by DEVICE: B's device_seq 0/1/2 land on the same stream as A's device_seq 0/1/2, distinct only
// by device_id.
const HANDOFF_DELIVERY: readonly Step[] = [
  ["stop.arrived", { geo: { ...INSIDE }, auto: true }],
  ["pod.signed", { geo: { ...INSIDE } }, "signature_hash"],
  ["delivery.evidenced", { geo: { ...INSIDE } }, "placed_photo_hash"],
];
// A shorter device-B stop that ends in an exception (5 events) — brings the total to exactly 50.
const EXCEPTION_STOP: readonly Step[] = [
  ["document.attached", { ...CONSENT }],
  ["stop.arrived", { geo: { ...INSIDE }, auto: true }],
  ["freight.counted", { pieces: 12 }],
  ["freight.photographed", { photo_kind: "freight" }, "photo_hash"],
  ["exception.raised", { reason_code: "damage" }, "photo_hash"],
];

// The six soak streams and how many events each must hold after a loss-free, dup-free sync.
const EXPECTED_STREAM_COUNTS: Record<string, number> = {
  "soak-shared": 9, // 6 (device A pickup) + 3 (device B delivery)
  "soak-fa1": 9,
  "soak-fa2": 9,
  "soak-fb1": 9,
  "soak-fb2": 9,
  "soak-mb": 5,
};
const TOTAL = 50;

let opsTok: string;
let deviceA: SoakDevice;
let deviceB: SoakDevice;
let allEvents: Captured[]; // the 50 distinct captured events

beforeAll(async () => {
  await ensureSchema(env); // parties + tenant policy + the shared cast

  deviceA = await makeDevice("A");
  deviceB = await makeDevice("B");

  // Register BOTH device public JWKs so the sequencer verifies their signatures (the DO's #deviceKey
  // scans users.device_keys[] for the tenant). One soak-owned user carries both — untouched by other files.
  await env.CONTROL_DB.prepare("INSERT OR REPLACE INTO users (id, tenant_id, email, role, auth, device_keys) VALUES (?,?,?,?,?,?)")
    .bind(
      "u-soak",
      "t-a",
      "soak@tenant-a.test",
      "driver",
      "{}",
      JSON.stringify([
        { device_id: deviceA.device_id, public_jwk: deviceA.publicJwk },
        { device_id: deviceB.device_id, public_jwk: deviceB.publicJwk },
      ]),
    )
    .run();

  opsTok = await token({ sub: "u-soak-ops", tenant: TENANT, role: "ops" });

  // Seed the six streams (+ delivery fences for every stream that ends in a delivery.evidenced).
  for (const id of Object.keys(EXPECTED_STREAM_COUNTS)) await seedShipment(id);
  for (const id of ["soak-shared", "soak-fa1", "soak-fa2", "soak-fb1", "soak-fb2"]) await seedDeliveryLeg(id);

  // MINT the 50 signed offline events. Device A captures its streams first (device_seq 0..23), device B
  // captures its streams (device_seq 0..25) — each device's own monotonic counter, both starting at 0.
  const a1 = await captureStop(deviceA, "soak-shared", HANDOFF_PICKUP); // A device_seq 0..5
  const a2 = await captureStop(deviceA, "soak-fa1", FULL); //               A device_seq 6..14
  const a3 = await captureStop(deviceA, "soak-fa2", FULL); //               A device_seq 15..23
  const b1 = await captureStop(deviceB, "soak-shared", HANDOFF_DELIVERY); // B device_seq 0..2
  const b2 = await captureStop(deviceB, "soak-fb1", FULL); //               B device_seq 3..11
  const b3 = await captureStop(deviceB, "soak-fb2", FULL); //               B device_seq 12..20
  const b4 = await captureStop(deviceB, "soak-mb", EXCEPTION_STOP); //      B device_seq 21..25
  allEvents = [...a1, ...a2, ...a3, ...b1, ...b2, ...b3, ...b4];

  expect(allEvents).toHaveLength(TOTAL); // 24 (device A) + 26 (device B)
});

describe("airplane-mode soak — 50 events / 2 devices / real sequencer (REQ-016 / GA-14)", () => {
  it("MINTS 50 signed offline events across two devices, each device_seq monotonic from 0", () => {
    const seqsA = allEvents.filter((c) => c.device === deviceA).map((c) => c.event.device_seq);
    const seqsB = allEvents.filter((c) => c.device === deviceB).map((c) => c.event.device_seq);
    expect(seqsA).toEqual(Array.from({ length: 24 }, (_, i) => i)); // 0..23
    expect(seqsB).toEqual(Array.from({ length: 26 }, (_, i) => i)); // 0..25
    // every event is device-co-signed (I4) and carries its offline dedupe key
    for (const c of allEvents) {
      expect(c.event.sig).toBeDefined();
      expect(c.event.actor.device).toBe(c.device.device_id);
      expect(c.event.device_id).toBe(c.device.device_id);
    }
  });

  it("syncs (seeded shuffle + duplicate re-sends) and merges with ZERO loss and ZERO dupes; the chain verifies", async () => {
    const rnd = mulberry32(SEED);

    // ── WAVE 1: the airplane comes back online. Arrival = the 50 firsts PLUS exact duplicate re-sends
    //    (same signed event, re-flushed — the "came back online twice" case), shuffled together, then
    //    drained with retry. Exact dupes collapse in the DO by event-id idempotency, whatever the order.
    // A GUARANTEED-mixed re-send set: a deterministic every-4th slice of EACH device's events, so "both
    // devices re-send" is STRUCTURAL, not a lucky PRNG draw (a random filter would silently break if the
    // seed or the number of prior rnd() draws changed). Their arrival ORDER is still shuffled below.
    const eventsA = allEvents.filter((c) => c.device === deviceA);
    const eventsB = allEvents.filter((c) => c.device === deviceB);
    const dupSubset = [...eventsA.filter((_, i) => i % 4 === 0), ...eventsB.filter((_, i) => i % 4 === 0)];
    expect(dupSubset.some((c) => c.device === deviceA)).toBe(true);
    expect(dupSubset.some((c) => c.device === deviceB)).toBe(true);

    const arrivals = shuffle([...allEvents, ...dupSubset], rnd);

    // Retry-drain: POST every arrival; a GATE_BLOCKED item (evidence not yet on its stream) is re-queued
    // for a later pass — the honest client drain loop. Anything other than 201 / GATE_BLOCKED is a real
    // failure (a lost or corrupted append), surfaced loudly.
    let pending = arrivals;
    let passes = 0;
    const MAX_PASSES = 64;
    while (pending.length > 0 && passes < MAX_PASSES) {
      const next: Captured[] = [];
      for (const item of pending) {
        const r = await post(item.shipmentId, item.event, opsTok);
        if (r.status === 201) continue; // appended, OR an idempotent dedupe return — either way, done
        if (r.status === 403 && r.json?.code === "GATE_BLOCKED") {
          next.push(item); // evidence not on the stream yet — retry on a later pass
          continue;
        }
        throw new Error(`unexpected append status ${r.status} for ${item.kind} on ${item.shipmentId}: ${JSON.stringify(r.json)}`);
      }
      pending = next;
      passes++;
    }
    expect(pending, "the offline queue must fully drain — a permanent block is a lost event").toHaveLength(0);

    // ── ZERO LOSS — all 50 DISTINCT events are present on their streams ──────────────────────────────
    let total = 0;
    for (const [shipmentId, expected] of Object.entries(EXPECTED_STREAM_COUNTS)) {
      const n = await streamCount(shipmentId);
      expect(n, `stream ${shipmentId}`).toBe(expected);
      total += n;
    }
    expect(total, "50 distinct offline events merged").toBe(TOTAL);
    expect((await deviceSeqs(deviceA.device_id)).length + (await deviceSeqs(deviceB.device_id)).length).toBe(TOTAL);

    // ── WAVE 2: it comes back online AGAIN and re-sends a subset — this time as (device_id, device_seq)
    //    COLLISIONS with a NEW event id (the "counter re-emitted different content" footgun device-key.ts
    //    warns about). New id ⇒ the DO's id-idempotency misses ⇒ it falls to the (device_id, device_seq)
    //    dedupe, which returns the EXISTING row (first-wins, never overwrite). Proves the exact dedupe
    //    path the DoD names, and that the resent (mutated) content is DROPPED, not merged.
    const countedA = allEvents.filter((c) => c.device === deviceA && c.kind === "freight.counted");
    const countedB = allEvents.filter((c) => c.device === deviceB && c.kind === "freight.counted");
    const variants = [...shuffle(countedA, rnd).slice(0, 2), ...shuffle(countedB, rnd).slice(0, 2)]; // each device re-sends a subset
    expect(variants.length).toBe(4);

    for (const c of variants) {
      const orig = c.event;
      // A genuinely DIFFERENT signed event that reuses (device_id, device_seq): fresh id, mutated
      // payload (pieces 12 → 99), re-signed with the SAME device key over the new clientView.
      const mutated: EventInput = {
        ...orig,
        id: crypto.randomUUID(),
        payload: { ...(orig.payload as Record<string, unknown>), pieces: 99 },
      } as EventInput;
      const sig = await signEvent(mutated as Parameters<typeof signEvent>[0], c.device.ctx.privateKey);
      const resent: EventInput = { ...mutated, sig };

      const r = await post(c.shipmentId, resent, opsTok);
      expect(r.status).toBe(201); // dedupe returns the existing row (not a fresh append)
      expect(r.json?.id).toBe(orig.id); // FIRST-WINS: the original event is returned, not the mutant
      expect((r.json?.payload as { pieces?: number } | undefined)?.pieces).toBe(12); // content NOT overwritten
    }

    // ── ZERO DUPES — the collapse held: the stored count is still exactly 50, not 50 + the re-sends ──
    let afterResend = 0;
    for (const shipmentId of Object.keys(EXPECTED_STREAM_COUNTS)) afterResend += await streamCount(shipmentId);
    expect(afterResend, "duplicate re-sends collapsed — no row added").toBe(TOTAL);

    // ── PER-DEVICE SEQ MONOTONIC (no reuse; gaps would be allowed, here contiguous) ──────────────────
    expect(await deviceSeqs(deviceA.device_id)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(await deviceSeqs(deviceB.device_id)).toEqual(Array.from({ length: 26 }, (_, i) => i));
    // no (device_id, device_seq) pair is stored twice — the dedupe key held across the whole merge
    const dupKeys = await env.TENANT_A_DB.prepare(
      "SELECT device_id, device_seq, COUNT(*) AS n FROM events WHERE device_id IN (?,?) GROUP BY device_id, device_seq HAVING n > 1",
    )
      .bind(deviceA.device_id, deviceB.device_id)
      .all();
    expect(dupKeys.results).toHaveLength(0);

    // the shared handoff stream carries BOTH devices at device_seq 0/1/2 — merge keyed by device_id,
    // not by device_seq alone (two seq-0 events coexist because their device_id differs).
    const sharedRows = await streamRows("soak-shared");
    const sharedZeroSeq = sharedRows.filter((r) => r.device_seq === 0);
    expect(sharedZeroSeq).toHaveLength(2);
    expect(new Set(sharedZeroSeq.map((r) => r.device_id))).toEqual(new Set([deviceA.device_id, deviceB.device_id]));

    // ── THE CHAIN VERIFIES — per stream, ordered by seq, the WP-02 hash-chain holds across the merged,
    //    interleaved, deduped set (dense seq from 0; every prev_hash / hash link recomputes) ──────────
    for (const [shipmentId, expected] of Object.entries(EXPECTED_STREAM_COUNTS)) {
      const rows = await streamRows(shipmentId);
      expect(rows).toHaveLength(expected);
      expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: expected }, (_, i) => i)); // dense 0..k-1
      const events = rows.map((r) => rowToEvent(r));
      const result = await verifyChain(events);
      expect(result.ok, `chain for ${shipmentId}`).toBe(true);
    }
  });
});
