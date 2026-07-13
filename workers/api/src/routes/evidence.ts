import type { Context, Hono } from "hono";
import { Hash64, z } from "@shuddl/contracts";
import { ApiError, envelope } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { tenantDb } from "../tenants.js";
import type { Env, Vars } from "../index.js";

// REQ-168 — evidence byte-upload with SHA-256 verify (WP-06). The driver PWA hashes evidence AT
// CAPTURE (REQ-017): the event carries a Hash64, the bytes arrive LATER through this endpoint. The
// delivery gate binds the POD to a recording EVENT+HASH (transition-gates.ts); THIS route is the byte
// authority — the recorded photo_hash must equal the SHA-256 of the received bytes or NOTHING is
// stored (no R2 object, no documents row). Together they close the fabricated-hash path: a forged
// 64-hex hash bound to no captured photo can never become stored evidence.
//
// Tenant comes ONLY from the JWT claim (REQ-156/025) — never a header, query param, or body field.

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024; // 10 MiB — beyond any single evidence photo

// Raw-body upload; metadata rides the query string (a Worker-friendly shape — no multipart parsing).
// There is deliberately NO client-declared document kind: documents.kind is DERIVED from the recording
// event (documentKindFor below), so a signature can never be stored mislabeled as a photo or vice versa.
const EvidenceQuery = z
  .object({
    shipment_id: z.string().min(1).max(200), // length cap mirrors the events route (MAX_SHIPMENT_ID_LEN)
    photo_hash: Hash64,
  })
  .strict();

// The evidence-recording event kinds and the payload field each pins its capture hash to
// (packages/contracts/src/events.ts). An uploaded hash must already be RECORDED by one of these on
// this tenant's shipment stream — no orphan uploads, ever. SELECTs the recording event's kind (the
// EARLIEST one, ORDER BY seq, if the same hash is somehow pinned twice) so documents.kind is derived
// from the ledger, never trusted from the client.
//
// `exception.raised` is intentionally ABSENT: its loose JsonObject payload MAY carry a photo_hash, but
// no producer today defers bytes for it (driver-core capture hashes only into the three strict fields
// below). Add its branch here when a real producer exists — do not pre-open the door.
const RECORDING_EVENT_SQL = `SELECT kind FROM events WHERE stream_id = ? AND (
  (kind IN ('freight.photographed','seal.applied','osd.captured') AND json_extract(payload,'$.photo_hash') = ?)
  OR (kind = 'delivery.evidenced' AND json_extract(payload,'$.placed_photo_hash') = ?)
  OR (kind = 'pod.signed' AND json_extract(payload,'$.signature_hash') = ?)
) ORDER BY seq LIMIT 1`;

// documents.kind derivation: a pod.signed signature is a 'POD' document; every other recording kind
// (freight/placed/seal/OS&D photos — incl. delivery.evidenced, whose hash is the placed PHOTO's) is a
// 'photo'. Deriving (vs. declaring) also kills two races: a repeat upload declaring a different kind,
// and two concurrent first-uploads disagreeing on it.
function documentKindFor(recordingKind: string): "POD" | "photo" {
  return recordingKind === "pod.signed" ? "POD" : "photo";
}

// Deterministic ids: same (shipment, hash) → same document row + same R2 key, which is what makes the
// re-upload idempotent (documents.id is the PRIMARY KEY; INSERT OR IGNORE — never OR REPLACE).
export function evidenceDocId(shipmentId: string, hash: string): string {
  return `evidence:${shipmentId}:${hash}`;
}
export function evidenceKey(tenant: string, shipmentId: string, hash: string): string {
  return `evidence/${tenant}/${shipmentId}/${hash}`;
}

// The two REQ-168 refusals are semantic (well-formed request, unacceptable evidence) → 422 with a
// machine-readable `reason` riding the standard envelope via envelope()'s extras — ONE producer for
// every error body (REQ-156). The ErrorCode enum is closed, so the nearest stable code rides along.
function evidenceRejection(c: Ctx, reason: "hash_not_recorded" | "hash_mismatch", message: string): Response {
  return envelope(c, "VALIDATION_FAILED", 422, message, undefined, { reason });
}

// Stream-count the body against the cap — never buffer past it. Chunks are held ONCE and joined; a
// stream that exceeds the cap is cancelled immediately ("oversize"), so a huge body costs at most
// MAX_EVIDENCE_BYTES of memory before the 413 — even with no (or a lying) Content-Length header.
async function readBodyCapped(body: ReadableStream<Uint8Array> | null, cap: number): Promise<Uint8Array<ArrayBuffer> | "oversize"> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return "oversize";
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function mountEvidenceRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // POST /v1/evidence?shipment_id=…&photo_hash=… — raw evidence bytes as the body.
  // driver uploads its own deferred capture; ops/admin can backfill. portal/read/finance never write
  // evidence. Order is fail-BEFORE-write, cheapest-first: params → declared-size fast 413 → the two
  // cheap SELECTs (shipment exists, hash recorded) so a garbage request is refused WITHOUT buffering
  // up to 10 MiB → capped body read (413 / empty 400) → byte-verify — still before ANY write — →
  // R2 put → documents row LAST (the anchor.ts pattern: the row exists iff the bytes are stored).
  app.post("/v1/evidence", requireRole("admin", "ops", "driver"), async (c) => {
    const session = c.get("session");

    const parsed = EvidenceQuery.safeParse({
      shipment_id: c.req.query("shipment_id"),
      photo_hash: c.req.query("photo_hash"),
    });
    if (!parsed.success) {
      throw new ApiError("VALIDATION_FAILED", 400, "REQUIRED QUERY PARAMS: shipment_id, photo_hash (64-hex lowercase)");
    }
    const { shipment_id, photo_hash } = parsed.data;

    // Fast 413 on a declared oversize before touching anything; the capped read below is the
    // authority when the header is absent or lies.
    const declared = Number(c.req.header("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > MAX_EVIDENCE_BYTES) {
      throw new ApiError("VALIDATION_FAILED", 413, "EVIDENCE BODY EXCEEDS 10 MiB");
    }

    // Tenant scoping (REQ-025): the D1 handle is keyed off the JWT claim. A shipment the session
    // tenant's D1 does not hold is a plain 404 — indistinguishable from nonexistent, no write anywhere.
    const db = tenantDb(c.env, session.tenant);
    const shipment = await db.prepare("SELECT 1 AS present FROM shipments WHERE id = ?").bind(shipment_id).first();
    if (shipment === null) throw new ApiError("NOT_FOUND", 404, "SHIPMENT NOT FOUND");

    // (1) RECORDING-EVENT CHECK — the declared hash must already be pinned by a capture event on THIS
    // stream (stream-scoped: a hash recorded on some OTHER shipment never clears it). Uploads never
    // create evidence claims; they fulfil ones the ledger already holds.
    const recording = await db
      .prepare(RECORDING_EVENT_SQL)
      .bind(`s:${shipment_id}`, photo_hash, photo_hash, photo_hash)
      .first<{ kind: string }>();
    if (recording === null) {
      return evidenceRejection(c, "hash_not_recorded", "NO EVENT ON THIS SHIPMENT STREAM RECORDS THE DECLARED photo_hash");
    }

    // The body is read only now — a request that already failed the cheap checks never buffers a byte.
    const bytes = await readBodyCapped(c.req.raw.body, MAX_EVIDENCE_BYTES);
    if (bytes === "oversize") throw new ApiError("VALIDATION_FAILED", 413, "EVIDENCE BODY EXCEEDS 10 MiB");
    if (bytes.byteLength === 0) throw new ApiError("VALIDATION_FAILED", 400, "EVIDENCE BODY MUST BE NON-EMPTY RAW BYTES");

    // (2) BYTE-VERIFY — the REQ-168 core. sha256(received bytes) must equal the recorded hash, or the
    // upload dies here with NOTHING written: no R2 object, no documents row.
    const actual = await sha256Hex(bytes);
    if (actual !== photo_hash) {
      return evidenceRejection(c, "hash_mismatch", "UPLOADED BYTES DO NOT HASH TO THE RECORDED photo_hash (REQ-168)");
    }

    // (3) IDEMPOTENT store. The doc id is deterministic per (shipment, hash); an existing row means
    // the verified bytes are already stored (row is written LAST) — repeat is a 200, no re-write.
    const documentId = evidenceDocId(shipment_id, photo_hash);
    const key = evidenceKey(session.tenant, shipment_id, photo_hash);
    const existing = await db.prepare("SELECT r2_key FROM documents WHERE id = ?").bind(documentId).first<{ r2_key: string }>();
    if (existing !== null) return c.json({ document_id: documentId, r2_key: existing.r2_key }, 200);

    // R2 FIRST, documents row LAST (anchor.ts pattern): the row exists iff the bytes are stored. A
    // crash between the two leaves no row; the retry re-verifies, the re-put is byte-identical (same
    // verified hash), and INSERT OR IGNORE heals the missing row. meta.changes distinguishes the true
    // first store (201) from the concurrent-duplicate loser whose row already landed (200).
    await c.env.EVIDENCE.put(key, bytes);
    // REQ-140 (LEGAL — CONFIRM-2, retention policy + consignee notice): the ENFORCEMENT MECHANISM lands
    // here. Every evidence object carries a `lifecycle_class` (retention bucket) and a `visibility` on
    // its documents row, so a published retention schedule + a consignee-notice/PII policy has a concrete
    // knob to attach to (a class-driven R2 lifecycle sweep + a visibility gate) — the bytes and the row
    // are never orphaned from a policy field. "default" is the placeholder class until the POLICY TEXT
    // itself (what is kept, how long, the consignee notice wording) is authored: that is a counsel /
    // CONFIRM-2 deliverable (genesis/08 GA-11), CONFIRM-GATED and not a code artifact of this WP.
    const inserted = await db
      .prepare("INSERT OR IGNORE INTO documents (id, shipment_id, party_id, kind, r2_key, hash, lifecycle_class, visibility) VALUES (?,?,?,?,?,?,?,?)")
      .bind(documentId, shipment_id, null, documentKindFor(recording.kind), key, photo_hash, "default", "internal")
      .run();
    return c.json({ document_id: documentId, r2_key: key }, inserted.meta.changes > 0 ? 201 : 200);
  });
}
