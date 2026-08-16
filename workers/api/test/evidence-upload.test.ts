import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { eventFixture, type EventKind } from "@shuddl/contracts";
import { capture, type CaptureParams, type DeviceContext, type EvidenceField } from "@shuddl/driver-core";
import { eventToRow } from "@shuddl/ledger/lens";
import { sweepTenantExpiredDocuments } from "@shuddl/ledger/documents/retention";
import { MAX_EVIDENCE_BYTES } from "../src/routes/evidence.js";
import { loadActivePodDocument } from "../../agents/src/biller.js";
import {
  CONSENT,
  INSIDE,
  TENANT_SLUG,
  TEST_DEVICE_ID,
  ensureSchema,
  ensureTenantBSchema,
  nextEvidenceBytes,
  post,
  seedShipment,
  testDeviceSigningKey,
  token,
} from "./helpers.js";

// ─── REQ-168 — EVIDENCE BYTE-VERIFY AT UPLOAD (WP-06) ───────────────────────────────────────────────
//
// The WP-05 exit audit proved the delivery gate binds the POD to a placed-photo EVENT+HASH but nothing
// verifies BYTES exist: a fabricated 64-hex hash bound to no stored photo could satisfy the gate.
// `POST /v1/evidence` is the byte authority: the recorded photo_hash must equal the SHA-256 of the
// uploaded bytes, or NOTHING is written (no R2 object, no documents row). DoD: "A fabricated evidence
// hash with no matching uploaded bytes fails the gate/upload."
//
// Contract under test:
//   POST /v1/evidence?shipment_id=…&photo_hash=…   (raw body = the evidence bytes; NO client-declared
//   document kind — documents.kind is DERIVED from the recording event: pod.signed → 'POD', else 'photo')
//   → 201 {document_id, r2_key} on first verified upload; 200 (same body) on an idempotent repeat
//   → 422 {reason:"hash_not_recorded"} when no event on THIS stream recorded the declared hash
//   → 422 {reason:"hash_mismatch"} when the bytes do not hash to the declared (recorded) hash
//   → 404 when the shipment is not in the session tenant's D1 (cross-tenant posture, REQ-025)
//   → 401 unauthenticated · 403 portal/read · 400 empty body / malformed params · 413 oversize
//
// isolatedStorage is OFF (all api test files share ONE D1) — every case scopes to its own shipment id.

const TENANT = TENANT_SLUG;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)); // fresh ArrayBuffer-backed copy — clean BufferSource type
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function r2Key(tenant: string, shipmentId: string, hash: string): string {
  return `evidence/${tenant}/${shipmentId}/${hash}`;
}

const YEAR_MS = 365 * 86_400_000;

// A unique 64-hex EVENT hash (distinct from any payload photo_hash) — keeps the UNIQUE(hash) + append-only
// insert guard happy for a direct-seeded event on the shared D1.
const randomHex64 = (): string => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");

// Direct-insert a `freight.photographed` recording event with an OLD server `recorded_at` (mirrors
// watchtower.test's seedEvent). The sequencer stamps recorded_at=Date.now() and `events` is append-only (no
// UPDATE path), so the ONLY way to pin a >1yr-old recording clock — the real "already-tombstoned" precondition
// for REQ-198 — is to seed the recording event directly. The route's RECORDING_EVENT_SQL then finds it and the
// re-instate branch re-reads THIS recorded_at (which the fix must NOT bind as the re-instated created_ts).
async function seedOldPlacedPhotoEvent(shipmentId: string, photoHash: string, recordedAt: number): Promise<void> {
  const e = eventFixture("freight.photographed", {
    id: crypto.randomUUID(),
    stream_id: `s:${shipmentId}`,
    shipment_id: shipmentId,
    seq: 0,
    ts: recordedAt,
    recorded_at: recordedAt,
    visibility: "internal",
    party_refs: [],
    payload: { photo_hash: photoHash, photo_kind: "placed" },
  });
  const row = eventToRow(e);
  row.hash = randomHex64();
  const cols = Object.keys(row);
  await env.TENANT_A_DB.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .bind(...cols.map((c) => row[c]))
    .run();
}

interface UploadRes {
  status: number;
  json: Record<string, unknown> | null;
}

function uploadHeaders(tok: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Idempotency-Key": crypto.randomUUID(), // fresh per call — replay caching is NOT what these tests probe
    "content-type": "application/octet-stream",
  };
  if (tok !== null) headers["Authorization"] = `Bearer ${tok}`;
  return headers;
}

function uploadUrl(params: { shipment_id?: string; photo_hash?: string }): string {
  const qs = new URLSearchParams();
  if (params.shipment_id !== undefined) qs.set("shipment_id", params.shipment_id);
  if (params.photo_hash !== undefined) qs.set("photo_hash", params.photo_hash);
  return `https://api.local/v1/evidence?${qs.toString()}`;
}

async function toUploadRes(res: Response): Promise<UploadRes> {
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function upload(
  params: { shipment_id?: string; photo_hash?: string },
  body: Uint8Array | null,
  tok: string | null,
): Promise<UploadRes> {
  const init: RequestInit = { method: "POST", headers: uploadHeaders(tok) };
  if (body !== null) init.body = new Uint8Array(body); // ArrayBuffer-backed copy satisfies BodyInit cleanly
  return toUploadRes(await SELF.fetch(uploadUrl(params), init));
}

async function docCount(shipmentId: string, hash: string): Promise<number> {
  const row = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS n FROM documents WHERE shipment_id = ? AND hash = ?")
    .bind(shipmentId, hash)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ── one reused registered device + monotonic counters (mirrors pod.test) ─────────────────────────────
let deviceCtx: DeviceContext;
let opsTok: string;
let seq = 0;
let clock = 1_721_000_000_000;

// Capture a driver-core-signed event and POST it through the real sequencer; evidence-bearing captures
// hash their bytes AT capture (REQ-017) and return the hash the upload must byte-verify against.
async function appendEvent(
  shipmentId: string,
  kind: EventKind,
  payload: Record<string, unknown>,
  evidence?: { bytes: Uint8Array; field: EvidenceField },
): Promise<string | undefined> {
  const ts = clock++;
  const params: CaptureParams = { shipment_id: shipmentId, kind, payload, ts, captured_ts: ts, actor_user: "user-driver" };
  if (evidence !== undefined) params.evidence = evidence;
  const { event, deferred } = await capture(params, deviceCtx);
  const res = await post(shipmentId, event, opsTok);
  expect(res.status, `${kind} must append: ${JSON.stringify(res.json)}`).toBe(201);
  return deferred?.hash;
}

// Record a placed-photo capture EVENT on the stream (the standard recording fixture).
async function recordPlacedPhoto(shipmentId: string, bytes: Uint8Array): Promise<string> {
  const hash = await appendEvent(shipmentId, "freight.photographed", { photo_kind: "placed" }, { bytes, field: "photo_hash" });
  if (hash === undefined) throw new Error("capture with evidence bytes must return a deferred upload");
  return hash;
}

beforeAll(async () => {
  await ensureSchema(env);
  await ensureTenantBSchema(env);
  deviceCtx = {
    device_id: TEST_DEVICE_ID,
    privateKey: await testDeviceSigningKey(),
    party: "party-carrier",
    nextSeq: () => seq++,
  };
  opsTok = await token({ sub: "u-evidence-ops", tenant: TENANT, role: "ops" });
  for (const id of [
    "ev-mismatch",
    "ev-fab",
    "ev-happy",
    "ev-idem",
    "ev-pod",
    "ev-xtenant",
    "ev-badparam",
    "ev-borrow-a",
    "ev-borrow-b",
    "ev-stream",
    "ev-heal",
    "ev-retention",
    "ev-retention-pod",
    "ev-reinstate",
    "ev-req198",
    "ev-active-reup",
    "ev-torn",
  ]) {
    await seedShipment(id);
  }
});

describe("POST /v1/evidence — byte-verified evidence upload (REQ-168)", () => {
  it("REQ-168 DoD: DIFFERENT bytes declaring a recorded hash → 422 hash_mismatch, NO R2 object, NO documents row", async () => {
    const shp = "ev-mismatch";
    const realBytes = nextEvidenceBytes();
    const recordedHash = await recordPlacedPhoto(shp, realBytes); // the stream recorded sha256(realBytes)

    const forgedBytes = nextEvidenceBytes(); // different content — its sha256 !== recordedHash
    expect(await sha256Hex(forgedBytes)).not.toBe(recordedHash);

    const res = await upload({ shipment_id: shp, photo_hash: recordedHash }, forgedBytes, opsTok);
    expect(res.status).toBe(422);
    expect(res.json?.reason).toBe("hash_mismatch");
    expect(await env.EVIDENCE.get(r2Key(TENANT, shp, recordedHash)), "a mismatch must write NOTHING to R2").toBeNull();
    expect(await docCount(shp, recordedHash), "a mismatch must write NO documents row").toBe(0);
  });

  it("a fabricated hash never recorded on the stream → 422 hash_not_recorded, even when the bytes genuinely hash to it", async () => {
    const shp = "ev-fab";
    const bytes = nextEvidenceBytes();
    const fabricated = await sha256Hex(bytes); // honest bytes — but NO event ever recorded this hash

    const res = await upload({ shipment_id: shp, photo_hash: fabricated }, bytes, opsTok);
    expect(res.status).toBe(422);
    expect(res.json?.reason).toBe("hash_not_recorded");
    expect(await env.EVIDENCE.get(r2Key(TENANT, shp, fabricated)), "an orphan upload must write NOTHING to R2").toBeNull();
    expect(await docCount(shp, fabricated)).toBe(0);
  });

  it("CROSS-SHIPMENT BORROW: a hash recorded on stream A never clears stream B → 422 hash_not_recorded, nothing written", async () => {
    // Mutation-proof for the stream_id scope in RECORDING_EVENT_SQL: even the TRUE bytes of a hash
    // recorded on ev-borrow-a must NOT be uploadable against ev-borrow-b — the check is per-stream.
    const bytes = nextEvidenceBytes();
    const hash = await recordPlacedPhoto("ev-borrow-a", bytes);

    const res = await upload({ shipment_id: "ev-borrow-b", photo_hash: hash }, bytes, opsTok);
    expect(res.status).toBe(422);
    expect(res.json?.reason).toBe("hash_not_recorded");
    expect(await env.EVIDENCE.get(r2Key(TENANT, "ev-borrow-b", hash)), "a borrowed hash must write NOTHING").toBeNull();
    expect(await docCount("ev-borrow-b", hash)).toBe(0);
  });

  it("HONEST PATH: bytes whose sha256 equals the recorded hash → 201, R2 object stored, documents row correct", async () => {
    const shp = "ev-happy";
    const bytes = nextEvidenceBytes();
    const hash = await recordPlacedPhoto(shp, bytes);
    expect(await sha256Hex(bytes)).toBe(hash); // capture hashed the same bytes we will upload

    const res = await upload({ shipment_id: shp, photo_hash: hash }, bytes, opsTok);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const key = r2Key(TENANT, shp, hash);
    expect(res.json?.r2_key).toBe(key);
    expect(typeof res.json?.document_id).toBe("string");

    const obj = await env.EVIDENCE.get(key);
    expect(obj, "the verified bytes must exist at the deterministic evidence key").not.toBeNull();
    expect((await obj!.arrayBuffer()).byteLength).toBe(bytes.byteLength);

    const row = await env.TENANT_A_DB.prepare("SELECT id, shipment_id, kind, r2_key, hash FROM documents WHERE id = ?")
      .bind(res.json?.document_id)
      .first<{ id: string; shipment_id: string; kind: string; r2_key: string; hash: string }>();
    expect(row).not.toBeNull();
    expect(row!.shipment_id).toBe(shp);
    expect(row!.kind, "kind is DERIVED from the recording event (freight.photographed → photo)").toBe("photo");
    expect(row!.r2_key).toBe(key);
    expect(row!.hash).toBe(hash);
  });

  it("KIND DERIVATION: a pod.signed signature_hash stores as documents.kind 'POD' — never client-declared", async () => {
    const shp = "ev-pod";
    // Consent BEFORE the GPS-stamped pod.signed (REQ-166) — INSIDE derives to operating state CA.
    await appendEvent(shp, "document.attached", { ...CONSENT });
    const sigBytes = nextEvidenceBytes();
    const hash = await appendEvent(shp, "pod.signed", { geo: { ...INSIDE } }, { bytes: sigBytes, field: "signature_hash" });
    expect(hash).toBeDefined();

    const res = await upload({ shipment_id: shp, photo_hash: hash! }, sigBytes, opsTok);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const row = await env.TENANT_A_DB.prepare("SELECT kind FROM documents WHERE shipment_id = ? AND hash = ?")
      .bind(shp, hash!)
      .first<{ kind: string }>();
    expect(row?.kind, "pod.signed recording event → derived kind POD").toBe("POD");
  });

  it("IDEMPOTENT repeat of the same verified upload → 200, same document_id, exactly ONE documents row", async () => {
    const shp = "ev-idem";
    const bytes = nextEvidenceBytes();
    const hash = await recordPlacedPhoto(shp, bytes);

    const first = await upload({ shipment_id: shp, photo_hash: hash }, bytes, opsTok);
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    const repeat = await upload({ shipment_id: shp, photo_hash: hash }, bytes, opsTok); // fresh Idempotency-Key — the ROUTE dedupes
    expect(repeat.status).toBe(200);
    expect(repeat.json?.document_id).toBe(first.json?.document_id);
    expect(repeat.json?.r2_key).toBe(first.json?.r2_key);
    expect(await docCount(shp, hash), "re-upload must never duplicate the documents row").toBe(1);

    const row = await env.TENANT_A_DB.prepare("SELECT kind FROM documents WHERE shipment_id = ? AND hash = ?")
      .bind(shp, hash)
      .first<{ kind: string }>();
    expect(row?.kind, "kind stays the DERIVED one — a repeat can never relabel it").toBe("photo");
  });

  it("TORN-STATE HEALING: a pre-existing R2 object with NO documents row → honest upload 201, the row lands", async () => {
    // Simulates a crash between the R2 put and the documents INSERT: the retry must re-verify and heal
    // the missing row (INSERT OR IGNORE on the deterministic id), never fail or duplicate.
    const shp = "ev-heal";
    const bytes = nextEvidenceBytes();
    const hash = await recordPlacedPhoto(shp, bytes);
    const key = r2Key(TENANT, shp, hash);
    await env.EVIDENCE.put(key, new Uint8Array(bytes)); // pre-plant the object; NO row exists
    expect(await docCount(shp, hash)).toBe(0);

    const res = await upload({ shipment_id: shp, photo_hash: hash }, bytes, opsTok);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json?.r2_key).toBe(key);
    expect(await docCount(shp, hash), "the retry heals the torn state with exactly one row").toBe(1);
  });

  it("CROSS-TENANT (REQ-025): tenant B's token against tenant A's shipment → 404, NOTHING written anywhere", async () => {
    const shp = "ev-xtenant"; // exists ONLY in tenant A's D1
    const bytes = nextEvidenceBytes();
    const hash = await recordPlacedPhoto(shp, bytes); // recorded on tenant A's stream
    const tokB = await token({ sub: "u-evidence-b", tenant: "tenant-b", role: "ops" });

    const res = await upload({ shipment_id: shp, photo_hash: hash }, bytes, tokB);
    expect(res.status).toBe(404); // tenant B's D1 has no such shipment — indistinguishable from nonexistent
    expect(await env.EVIDENCE.get(r2Key("tenant-b", shp, hash))).toBeNull();
    expect(await env.EVIDENCE.get(r2Key(TENANT, shp, hash)), "a cross-tenant attempt must never write into tenant A's space").toBeNull();
    const rowB = await env.TENANT_B_DB.prepare("SELECT COUNT(*) AS n FROM documents WHERE hash = ?").bind(hash).first<{ n: number }>();
    expect(rowB?.n ?? 0).toBe(0);
    expect(await docCount(shp, hash)).toBe(0);
  });

  it("unauthenticated → 401; portal and read roles → 403", async () => {
    const bytes = nextEvidenceBytes();
    const hash = await sha256Hex(bytes);
    const params = { shipment_id: "ev-happy", photo_hash: hash };

    expect((await upload(params, bytes, null)).status).toBe(401);
    const portalTok = await token({ sub: "u-evidence-portal", tenant: TENANT, role: "portal", party: "party-consignee" });
    expect((await upload(params, bytes, portalTok)).status).toBe(403);
    const readTok = await token({ sub: "u-evidence-read", tenant: TENANT, role: "read" });
    expect((await upload(params, bytes, readTok)).status).toBe(403);
  });

  it("EMPTY body → 4xx, nothing written", async () => {
    const shp = "ev-badparam";
    const bytes = nextEvidenceBytes();
    const hash = await recordPlacedPhoto(shp, bytes);

    const res = await upload({ shipment_id: shp, photo_hash: hash }, new Uint8Array(0), opsTok);
    expect(res.status).toBe(400);
    expect(await env.EVIDENCE.get(r2Key(TENANT, shp, hash))).toBeNull();
    expect(await docCount(shp, hash)).toBe(0);
  });

  it("OVERSIZE body (> 10 MiB, declared Content-Length) → 413, nothing written", async () => {
    const shp = "ev-badparam";
    const oversize = new Uint8Array(MAX_EVIDENCE_BYTES + 1);
    const hash = await sha256Hex(oversize.slice(0, 32)); // any well-formed 64-hex — the declared size fails FIRST

    const res = await upload({ shipment_id: shp, photo_hash: hash }, oversize, opsTok);
    expect(res.status).toBe(413);
    expect(await env.EVIDENCE.get(r2Key(TENANT, shp, hash))).toBeNull();
  });

  it("OVERSIZE STREAM (no Content-Length): the capped stream-count is the authority → 413, nothing written", async () => {
    // Mutation-proof for the readBodyCapped early abort: a chunked body with NO Content-Length must be
    // cut off by the stream-count, not the header fast path. The shipment exists and the hash IS
    // recorded, so the request reaches the body read — then dies at the cap, before any verify/write.
    const shp = "ev-stream";
    const bytes = nextEvidenceBytes();
    const hash = await recordPlacedPhoto(shp, bytes);

    const CHUNK = new Uint8Array(1 << 20); // 1 MiB per pull
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_EVIDENCE_BYTES) {
          controller.close();
          return;
        }
        controller.enqueue(CHUNK);
        sent += CHUNK.byteLength;
      },
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: uploadHeaders(opsTok),
      body,
      duplex: "half", // streaming request body — no Content-Length is ever sent
    };
    const res = await toUploadRes(await SELF.fetch(uploadUrl({ shipment_id: shp, photo_hash: hash }), init));
    expect(res.status).toBe(413);
    expect(await env.EVIDENCE.get(r2Key(TENANT, shp, hash))).toBeNull();
    expect(await docCount(shp, hash)).toBe(0);
  });

  it("malformed photo_hash (63 chars / non-hex) or missing shipment_id → 400", async () => {
    const bytes = nextEvidenceBytes();
    const hex63 = "a".repeat(63);
    const nonHex = "z".repeat(64);
    const goodHash = await sha256Hex(bytes);

    expect((await upload({ shipment_id: "ev-badparam", photo_hash: hex63 }, bytes, opsTok)).status).toBe(400);
    expect((await upload({ shipment_id: "ev-badparam", photo_hash: nonHex }, bytes, opsTok)).status).toBe(400);
    expect((await upload({ photo_hash: goodHash }, bytes, opsTok)).status).toBe(400); // missing shipment_id
  });
});

// ─── REQ-116 — RETENTION CLASS + CLOCK STAMPED AT WRITE, and re-instatement of a retention-tombstoned doc ───
describe("POST /v1/evidence — retention fields (REQ-116)", () => {
  it("a photo stores lifecycle_class 'default' (shorter hold); created_ts = the recording event's recorded_at", async () => {
    const shp = "ev-retention";
    const bytes = nextEvidenceBytes();
    const hash = await recordPlacedPhoto(shp, bytes);

    const res = await upload({ shipment_id: shp, photo_hash: hash }, bytes, opsTok);
    expect(res.status, JSON.stringify(res.json)).toBe(201);

    const doc = await env.TENANT_A_DB.prepare("SELECT lifecycle_class, created_ts, retention_status FROM documents WHERE shipment_id = ? AND hash = ?")
      .bind(shp, hash)
      .first<{ lifecycle_class: string; created_ts: number; retention_status: string }>();
    expect(doc?.lifecycle_class, "a photo is the shorter 'default' retention class").toBe("default");
    expect(doc?.retention_status, "a freshly-stored doc is active (bytes present)").toBe("active");
    // created_ts is the recording event's LEDGER time (recorded_at), not the upload wall-clock.
    const evt = await env.TENANT_A_DB.prepare("SELECT recorded_at FROM events WHERE stream_id = ? AND kind = 'freight.photographed' LIMIT 1")
      .bind(`s:${shp}`)
      .first<{ recorded_at: number }>();
    expect(doc?.created_ts).toBe(evt?.recorded_at);
  });

  it("a POD stores lifecycle_class 'pod-7yr' — the 7-year compliance hold", async () => {
    const shp = "ev-retention-pod";
    await appendEvent(shp, "document.attached", { ...CONSENT });
    const sigBytes = nextEvidenceBytes();
    const hash = await appendEvent(shp, "pod.signed", { geo: { ...INSIDE } }, { bytes: sigBytes, field: "signature_hash" });
    expect(hash).toBeDefined();

    const res = await upload({ shipment_id: shp, photo_hash: hash! }, sigBytes, opsTok);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const doc = await env.TENANT_A_DB.prepare("SELECT lifecycle_class FROM documents WHERE shipment_id = ? AND hash = ?")
      .bind(shp, hash!)
      .first<{ lifecycle_class: string }>();
    expect(doc?.lifecycle_class, "a POD is the 7-year 'pod-7yr' compliance class").toBe("pod-7yr");
  });

  it("ROW-IFF-BYTES: re-uploading a retention-TOMBSTONED doc RE-INSTATES it (active row, bytes restored, one row)", async () => {
    const shp = "ev-reinstate";
    const bytes = nextEvidenceBytes();
    const hash = await recordPlacedPhoto(shp, bytes);
    const first = await upload({ shipment_id: shp, photo_hash: hash }, bytes, opsTok);
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    const docId = first.json?.document_id as string;
    const key = r2Key(TENANT, shp, hash);

    // Simulate the retention sweep having run: bytes deleted, row tombstoned to 'expired'.
    await env.EVIDENCE.delete(key);
    await env.TENANT_A_DB.prepare("UPDATE documents SET retention_status = 'expired' WHERE id = ?").bind(docId).run();
    expect(await env.EVIDENCE.get(key), "the tombstoned doc's bytes are gone").toBeNull();

    // Re-upload the SAME verified bytes → re-instated (not a dead 200 pointing at deleted bytes).
    const again = await upload({ shipment_id: shp, photo_hash: hash }, bytes, opsTok);
    expect([200, 201]).toContain(again.status);
    expect(again.json?.document_id).toBe(docId);
    expect(await env.EVIDENCE.get(key), "the bytes are restored").not.toBeNull();
    const row = await env.TENANT_A_DB.prepare("SELECT retention_status FROM documents WHERE id = ?").bind(docId).first<{ retention_status: string }>();
    expect(row?.retention_status, "the row is active again — no active row ever claims deleted bytes").toBe("active");
    expect(await docCount(shp, hash), "re-instatement never duplicates the row").toBe(1);
  });

  it("§1672 ROW-IFF-BYTES vs the SWEEP: an 'active' row whose bytes the sweep already deleted must NOT yield a 200 claiming stored evidence", async () => {
    const shp = "ev-torn";
    const bytes = nextEvidenceBytes();
    const hash = await recordPlacedPhoto(shp, bytes);
    const first = await upload({ shipment_id: shp, photo_hash: hash }, bytes, opsTok);
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    const docId = first.json?.document_id as string;
    const key = r2Key(TENANT, shp, hash);

    // The sweep deletes bytes FIRST and tombstones SECOND (documents/retention.ts). Between those two awaits
    // the row still reads 'active' with its bytes gone. Reachable WITHOUT a crash: any request interleaving
    // with an ordinary sweep tick observes it, once per deleted document. Reproduce it exactly — delete the
    // bytes and leave the row alone (the sibling test at "RE-INSTATE" does BOTH halves, i.e. a COMPLETED
    // sweep, which is why this state had no coverage).
    await env.EVIDENCE.delete(key);
    const status = await env.TENANT_A_DB.prepare("SELECT retention_status FROM documents WHERE id = ?")
      .bind(docId)
      .first<{ retention_status: string }>();
    expect(status?.retention_status, "precondition: the interrupted sweep leaves the row ACTIVE").toBe("active");
    expect(await env.EVIDENCE.get(key), "precondition: the bytes are gone").toBeNull();

    // Re-upload the same verified bytes. Before §1672 this returned 200 + document_id + r2_key with NOTHING
    // stored: a driver retrying a capture is told the evidence landed, records success, and never re-sends.
    const again = await upload({ shipment_id: shp, photo_hash: hash }, bytes, opsTok);
    expect([200, 201]).toContain(again.status);
    expect(again.json?.document_id, "the same deterministic doc id").toBe(docId);
    expect(
      await env.EVIDENCE.get(key),
      "THE ASSERTION: a 2xx on the duplicate path must mean the bytes are actually present. The row said " +
        "'active' and the row was wrong — only a HEAD against R2 can tell the difference.",
    ).not.toBeNull();
    expect(await docCount(shp, hash), "the repair never duplicates the row").toBe(1);
  });

  it("REQ-198 — re-instating a >1yr-old tombstoned doc RESTARTS the retention clock from NOW, so the very next sweep does NOT re-delete the fresh bytes", async () => {
    const shp = "ev-req198";
    const bytes = nextEvidenceBytes();
    const photoHash = await sha256Hex(bytes);
    const key = r2Key(TENANT, shp, photoHash);
    // The recording event is genuinely >1yr old (2yr → past the 1yr 'default' hold) — the real
    // "already-tombstoned" precondition. Seed it directly (append-only events can't be back-dated by UPDATE).
    const RECORDED_OLD = Date.now() - 2 * YEAR_MS;
    await seedOldPlacedPhotoEvent(shp, photoHash, RECORDED_OLD);

    // FIRST upload: the first-INSERT path (UNCHANGED by the fix) binds the recording event's recorded_at, so
    // created_ts is genuinely >1yr old — a doc the retention sweep is entitled to tombstone.
    const first = await upload({ shipment_id: shp, photo_hash: photoHash }, bytes, opsTok);
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    const docId = first.json?.document_id as string;
    const firstDoc = await env.TENANT_A_DB.prepare("SELECT created_ts, lifecycle_class FROM documents WHERE id = ?")
      .bind(docId)
      .first<{ created_ts: number; lifecycle_class: string }>();
    expect(firstDoc?.lifecycle_class, "a photo is the shorter 'default' retention class").toBe("default");
    expect(firstDoc?.created_ts, "the first-INSERT path binds the recording event's recorded_at (>1yr old)").toBe(RECORDED_OLD);

    // Simulate the retention sweep having tombstoned this expired doc: bytes deleted, row → 'expired'.
    await env.EVIDENCE.delete(key);
    await env.TENANT_A_DB.prepare("UPDATE documents SET retention_status = 'expired' WHERE id = ?").bind(docId).run();
    expect(await env.EVIDENCE.get(key), "the tombstoned doc's bytes are gone").toBeNull();

    // RE-POST the same verified bytes → the re-instate branch. THE FIX: created_ts binds Date.now() (the
    // re-submission time), NOT the recording event's ancient recorded_at.
    const reSubmitStart = Date.now();
    const again = await upload({ shipment_id: shp, photo_hash: photoHash }, bytes, opsTok);
    expect([200, 201]).toContain(again.status);
    expect(again.json?.document_id).toBe(docId);
    expect(await docCount(shp, photoHash), "re-instatement never duplicates the row").toBe(1);
    expect(await env.EVIDENCE.get(key), "the bytes are restored on re-instatement").not.toBeNull();

    const reinstated = await env.TENANT_A_DB.prepare("SELECT created_ts, retention_status FROM documents WHERE id = ?")
      .bind(docId)
      .first<{ created_ts: number; retention_status: string }>();
    expect(reinstated?.retention_status).toBe("active");
    // THE CLOCK RESTARTED: created_ts is the fresh re-submission time, NOT the >1yr-old recorded_at.
    expect(reinstated!.created_ts, "the retention clock restarts from the re-submission").toBeGreaterThanOrEqual(reSubmitStart);
    expect(reinstated!.created_ts, "the re-instated clock is NOT the ancient recording time").not.toBe(RECORDED_OLD);

    // ONE retention sweep tick JUST AFTER the re-submission: the re-instated doc must SURVIVE — its bytes are
    // NOT re-deleted. RED WITHOUT THE FIX: binding recorded_at would leave created_ts >1yr old, so this very
    // sweep would immediately re-expire the freshly re-uploaded doc (bytes deleted, row tombstoned) — the exact
    // "re-instate then next-sweep re-deletes the fresh bytes" defect REQ-198 closes.
    await sweepTenantExpiredDocuments(env.TENANT_A_DB, env.EVIDENCE, TENANT, reSubmitStart + 1_000);
    const afterSweep = await env.TENANT_A_DB.prepare("SELECT retention_status FROM documents WHERE id = ?")
      .bind(docId)
      .first<{ retention_status: string }>();
    expect(afterSweep?.retention_status, "the freshly re-instated doc stays active — its clock restarted from NOW").toBe("active");
    expect(await env.EVIDENCE.get(key), "the re-instated bytes are NOT re-deleted by the next sweep").not.toBeNull();
  });
});

// ─── Task 9 (REQ-170) — A VERIFIED POD SIGNATURE UPLOAD SATISFIES THE BILLER'S EVIDENCE PRECONDITION ────
//
// The Biller HOLDS a POD whose signature bytes are not stored; a verified upload is what unblocks it. This binds
// the upload route directly to loadActivePodDocument — the EXACT query the Biller's evidence gate runs — so the
// two cannot drift: before the upload the precondition is null; after it, it resolves the ACTIVE, tenant-scoped
// POD doc. A placed-photo upload is a 'photo' doc, so it NEVER satisfies the POD precondition (kind filter).
// (The route's Biller re-drive enqueue is best-effort on AGENT_QUEUE — a cross-isolate producer not observable
// from this harness; its end-to-end effect is proven in biller.test.ts's "upload then re-drive".)
describe("POST /v1/evidence — Task 9: a POD signature upload satisfies the Biller's evidence precondition (REQ-170)", () => {
  it("before upload loadActivePodDocument is null; after a verified POD upload it resolves the tenant-scoped active doc", async () => {
    const shp = "ev-t9-precond";
    await seedShipment(shp);
    await appendEvent(shp, "document.attached", { ...CONSENT }); // consent-before-GPS (REQ-166)
    const sigBytes = nextEvidenceBytes();
    const sigHash = await appendEvent(shp, "pod.signed", { geo: { ...INSIDE } }, { bytes: sigBytes, field: "signature_hash" });

    // Before the upload: the Biller's precondition is UNMET (no active POD doc for the recorded signature hash).
    expect(await loadActivePodDocument(env.TENANT_A_DB, TENANT, shp, sigHash!)).toBeNull();

    // A verified upload → the precondition resolves the active, tenant-scoped POD document.
    expect((await upload({ shipment_id: shp, photo_hash: sigHash! }, sigBytes, opsTok)).status).toBe(201);
    const doc = await loadActivePodDocument(env.TENANT_A_DB, TENANT, shp, sigHash!);
    expect(doc, "a verified POD upload satisfies the Biller's evidence gate").not.toBeNull();
    expect(doc!.r2_key).toBe(r2Key(TENANT, shp, sigHash!));

    // A placed-photo upload is a 'photo' doc — it NEVER satisfies the POD precondition (the kind filter holds).
    const shp2 = "ev-t9-photo";
    await seedShipment(shp2);
    const photoBytes = nextEvidenceBytes();
    const photoHash = await recordPlacedPhoto(shp2, photoBytes);
    expect((await upload({ shipment_id: shp2, photo_hash: photoHash }, photoBytes, opsTok)).status).toBe(201);
    expect(await loadActivePodDocument(env.TENANT_A_DB, TENANT, shp2, photoHash), "a photo upload is NOT a POD document").toBeNull();
  });
});

// REQ-116/198 §756 — RE-UPLOADING AN ALREADY-ACTIVE DOC MUST NOT RESTART ITS RETENTION CLOCK.
//
// The route short-circuits an ACTIVE row to 200 with the stored key. That line is load-bearing for RETENTION,
// not merely efficiency, and MUTATION-MEASURED it was undefended: disabling the short-circuit left this suite
// at 18/18 GREEN.
//
// Without it, an already-active doc falls into the RE-INSTATE branch, whose `UPDATE … created_ts = ?` binds a
// wall-clock `Date.now()`. That binding is deliberate and correct for a TOMBSTONED doc (REQ-198 — the ancient
// recorded_at would make the next sweep tick re-delete freshly restored bytes) and WRONG for an active one:
// every re-upload pushes the retention clock forward, so a document could outlive its policy indefinitely.
// Photo/PII retention is REQ-140, and the driver's evidence leg RE-PROBES parked uploads on a bounded schedule
// (§754/§755) — repeat uploads of an already-stored document are the normal case, not an edge one.
//
// The tombstoned sibling is tested above (the clock SHOULD restart there). This is the branch that was not —
// the §749 shape: two branches of one decision, one covered.
describe("REQ-116/198 §756: a re-upload of an ACTIVE doc leaves the retention clock alone", () => {
  it("second upload of the same verified bytes → 200, same row, created_ts UNCHANGED", async () => {
    const shp = "ev-active-reup";
    const bytes = nextEvidenceBytes();
    const photoHash = await recordPlacedPhoto(shp, bytes);

    const first = await upload({ shipment_id: shp, photo_hash: photoHash }, bytes, opsTok);
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    const docId = first.json?.document_id as string;
    const before = await env.TENANT_A_DB.prepare("SELECT created_ts, retention_status FROM documents WHERE id = ?")
      .bind(docId)
      .first<{ created_ts: number; retention_status: string }>();
    expect(before?.retention_status).toBe("active");

    // The driver's parked evidence leg re-probes; this is that second POST.
    const again = await upload({ shipment_id: shp, photo_hash: photoHash }, bytes, opsTok);
    expect(again.status, "an already-stored doc is a SUCCESS, not a refusal — the driver needs to drain").toBe(200);
    expect(again.json?.document_id).toBe(docId);
    expect(await docCount(shp, photoHash), "a re-upload never duplicates the row").toBe(1);

    const after = await env.TENANT_A_DB.prepare("SELECT created_ts, retention_status FROM documents WHERE id = ?")
      .bind(docId)
      .first<{ created_ts: number; retention_status: string }>();
    expect(after?.retention_status).toBe("active");
    expect(
      after!.created_ts,
      "re-uploading an ACTIVE doc restarted its retention clock — the active-row short-circuit is gone, so the " +
        "re-instate branch (correct only for a TOMBSTONED row, REQ-198) bound Date.now(). A document re-uploaded " +
        "periodically would then never expire (REQ-116/140)",
    ).toBe(before!.created_ts);
  });
});

