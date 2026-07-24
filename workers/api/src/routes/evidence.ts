import type { Context, Hono } from "hono";
import { Hash64, z } from "@shuddl/contracts";
import { retentionClassFor } from "@shuddl/ledger/documents/retention";
import { ApiError, envelope } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { resolveTenantDb } from "../tenants.js";
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
// SELECTs the recording event's kind AND its server-STAMPED `visibility` (the EARLIEST one, ORDER BY seq,
// if the same hash is somehow pinned twice) so BOTH documents.kind AND documents.visibility are derived
// from the ledger, never trusted from the client (REQ-085 / D4 / I6).
// `recorded_at` (the server-stamped ledger time) rides the SELECT too — it is the retention CLOCK START the
// documents row records at write (REQ-116): a doc's 7yr-POD / shorter-other hold is measured from when the
// ledger witnessed the recording event, NOT the upload wall-clock (an airplane-mode late upload cannot reset it).
const RECORDING_EVENT_SQL = `SELECT id, kind, visibility, recorded_at FROM events WHERE stream_id = ? AND (
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

// REQ-085 (WP-09 Task 6) — THE CRUX. documents.visibility is DERIVED from the RECORDING event's RESOLVED
// visibility (the `visibility` column the sequencer STAMPED at append time via resolveVisibility — I6/I5),
// so a counterparty-visible POD/placed-photo produces a counterparty-visible doc row the portal party lens
// can surface, while an internal recording stays internal. It is a REAL widening driven by the event's OWN
// resolved visibility — NEVER a lens bypass.
//
// FAIL CLOSED (skill fail-closed-on-inherited-visibility): inheriting a security attribute needs a KNOWN
// value, not a truthy one. ONLY the two known WIDE ranks inherit; ANY other input — 'internal', an
// absent/NULL column (should be impossible: events.visibility is NOT NULL and the row was just SELECTed,
// but we never trust it), or an unrecognized string — collapses to 'internal', the narrowest rank. The
// widest default is exactly the leak this derivation exists to prevent, so the safe miss is 'internal'.
export function documentVisibilityFor(recordingVisibility: string | null | undefined): "internal" | "counterparty" | "public" {
  return recordingVisibility === "counterparty" || recordingVisibility === "public" ? recordingVisibility : "internal";
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

// Task 9 (REQ-170 / REQ-169) — RE-DRIVE THE BILLER AFTER A POD SIGNATURE UPLOAD. The Biller now HOLDS
// (evidence_missing) a POD whose signature bytes are not yet stored; storing them is what unblocks it. So on a
// successful POD-signature store, enqueue EXACTLY the pod.signed Biller trigger the sequencer would have — the
// consumer re-runs the Biller, whose evidence precondition now passes, and the invoice + proof email go out.
// Deterministic (the trigger names the recording pod event id), best-effort (a failed push is logged, never
// thrown — the byte store is committed truth, and the REQ-169 recon sweep re-drives the still-unbilled POD as
// the backstop), and idempotent downstream (the Biller dedupes the invoice + the send). Fires ONLY for a POD
// signature (recording.kind === 'pod.signed'); a placed/freight/seal photo does not gate the invoice.
function redrivePodBilling(c: Ctx, tenant: string, shipmentId: string, recording: { id: string; kind: string }): void {
  if (recording.kind !== "pod.signed") return;
  const trigger = { kind: "pod.signed", tenant, shipment_id: shipmentId, event_id: recording.id };
  c.executionCtx.waitUntil(
    c.env.AGENT_QUEUE.send(trigger).catch((err: unknown) => {
      console.error(`evidence: Biller re-drive enqueue failed for pod ${recording.id} on ${shipmentId} (bytes stored; the REQ-169 recon sweep recovers it):`, err);
    }),
  );
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
    const db = await resolveTenantDb(c.env, session.tenant);
    const shipment = await db.prepare("SELECT 1 AS present FROM shipments WHERE id = ?").bind(shipment_id).first();
    if (shipment === null) throw new ApiError("NOT_FOUND", 404, "SHIPMENT NOT FOUND");

    // (1) RECORDING-EVENT CHECK — the declared hash must already be pinned by a capture event on THIS
    // stream (stream-scoped: a hash recorded on some OTHER shipment never clears it). Uploads never
    // create evidence claims; they fulfil ones the ledger already holds.
    const recording = await db
      .prepare(RECORDING_EVENT_SQL)
      .bind(`s:${shipment_id}`, photo_hash, photo_hash, photo_hash)
      .first<{ id: string; kind: string; visibility: string; recorded_at: number }>();
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

    // (3) IDEMPOTENT store. The doc id is deterministic per (shipment, hash). The documents row derives kind,
    // visibility (REQ-085), AND the retention class + clock (REQ-116) from the recording event.
    const documentId = evidenceDocId(shipment_id, photo_hash);
    const key = evidenceKey(session.tenant, shipment_id, photo_hash);
    const docKind = documentKindFor(recording.kind);
    // REQ-116 — the retention CLASS stamped at write from the doc kind (POD → 'pod-7yr' 7-year compliance hold,
    // else → 'default' shorter hold), so a doc's retention is RECORDED at creation and the class-driven sweep
    // (packages/ledger/src/documents/retention.ts) has a concrete field to act on. This REPLACES the former
    // hardcoded "default" (REQ-140's placeholder) with the kind-derived class; the POLICY TEXT (what is kept,
    // how long, the consignee-notice wording) is still a counsel / CONFIRM-2 deliverable (genesis/08 GA-11).
    const lifecycleClass = retentionClassFor(docKind);

    // ROW-IFF-BYTES (REQ-116): an ACTIVE row means the verified bytes are already stored (the row is written
    // LAST) → 200, no re-write. A row TOMBSTONED by the retention sweep ('expired', bytes deleted) is NOT a
    // live claim of present bytes — a genuine re-upload of the same verified evidence RE-INSTATES it (re-store
    // the bytes below, flip back to 'active', restart the retention clock) rather than hand back a 200 that
    // points at deleted bytes. That keeps "active row ⟺ bytes present" airtight in BOTH directions.
    const existing = await db
      .prepare("SELECT r2_key, retention_status FROM documents WHERE id = ?")
      .bind(documentId)
      .first<{ r2_key: string; retention_status: string }>();
    if (existing !== null && existing.retention_status === "active") {
      // Bytes already stored — re-drive the Biller too (a prior re-drive may have been lost; the Biller dedupes).
      redrivePodBilling(c, session.tenant, shipment_id, recording);
      return c.json({ document_id: documentId, r2_key: existing.r2_key }, 200);
    }

    // R2 FIRST, documents row LAST (anchor.ts pattern): the row exists iff the bytes are stored. A crash
    // between the two leaves no row (fresh) or a tombstoned row (re-instate); the retry re-verifies, the re-put
    // is byte-identical (same verified hash), and INSERT OR IGNORE heals the missing row.
    await c.env.EVIDENCE.put(key, bytes);
    if (existing === null) {
      // First store. meta.changes distinguishes the true first store (201) from the concurrent-duplicate loser
      // whose row already landed (200). visibility is DERIVED from the recording event's resolved visibility
      // (documentVisibilityFor, fail-closed, REQ-085); created_ts is the recording event's ledger time (REQ-116).
      const inserted = await db
        .prepare(
          "INSERT OR IGNORE INTO documents (id, shipment_id, party_id, kind, r2_key, hash, lifecycle_class, visibility, created_ts) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .bind(documentId, shipment_id, null, docKind, key, photo_hash, lifecycleClass, documentVisibilityFor(recording.visibility), recording.recorded_at)
        .run();
      redrivePodBilling(c, session.tenant, shipment_id, recording); // Task 9 — a stored POD signature unblocks the Biller
      return c.json({ document_id: documentId, r2_key: key }, inserted.meta.changes > 0 ? 201 : 200);
    }
    // RE-INSTATE a retention-tombstoned doc: the bytes were just restored above; mark the row active again and
    // restart its retention clock from THIS RE-SUBMISSION (a wall-clock now, NOT recording.recorded_at — the
    // recording event's ledger time is >retention old by definition of "already tombstoned", so binding it
    // would make the next sweep tick re-delete the freshly re-uploaded bytes, REQ-198). The first-insert path
    // above correctly binds recorded_at (a fresh capture is legitimately recent). Plain UPDATE — documents is
    // a mutable projection.
    await db
      .prepare("UPDATE documents SET retention_status = 'active', created_ts = ? WHERE id = ?")
      .bind(Date.now(), documentId)
      .run();
    redrivePodBilling(c, session.tenant, shipment_id, recording); // Task 9 — a re-instated POD signature unblocks the Biller
    return c.json({ document_id: documentId, r2_key: key }, 200);
  });
}
