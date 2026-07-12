// REQ-016 / REQ-017 / REQ-013: the offline signed-capture leg. A driver device builds a physical
// event, hashes any evidence bytes AT CAPTURE (the event carries only the hash; the raw bytes are
// queued for a LATER, deferred upload), stamps a per-device monotonic `device_seq`, and co-signs the
// FROZEN offline field set (`clientView`) with its P-256 private key. The result is a fully-formed,
// `EventInput.parse`-valid event the sequencer can verify against the registered device public JWK.
//
// Pure: no DOM, no IndexedDB, no network. Persistence (the queue store) and the eventual byte upload
// are injected ports the PWA wires in (Task 8). Crypto is REUSED from `@shuddl/ledger` — never
// reimplemented here.
import { EventInput, type EventKind } from "@shuddl/contracts";
import { signEvent } from "@shuddl/ledger/sign";
import { sha256Hex } from "@shuddl/ledger/canonical";

/** The three physical payload fields that hold an evidence content-hash (doc 10 §01, Task-1 payloads). */
export type EvidenceField = "photo_hash" | "placed_photo_hash" | "signature_hash";

export interface CaptureEvidence {
  /** Raw evidence bytes (photo / wet-ink signature pixels). Hashed at capture; the bytes are deferred. */
  bytes: Uint8Array;
  /** Which payload field receives the hash (and tags the deferred upload). */
  field: EvidenceField;
}

// Future compile-time safety: a generic `capture<K extends EventKind>` could bind `payload` to K's
// exact payload type (minus the evidence field), turning a kind/payload mismatch into a TYPE error
// rather than the runtime `EventInput.parse` throw below. Deferred — not needed for the WP-05 seam.
export interface CaptureParams {
  shipment_id?: string;
  kind: EventKind;
  /**
   * The kind's payload MINUS the evidence-hash field — capture fills that field in from the hashed
   * bytes (e.g. pass `{ geo }` for `pod.signed`; capture adds `signature_hash`).
   */
  payload: Record<string, unknown>;
  /** The party this capture is attributed to. Defaults to the device's registered party. */
  actor_party?: string;
  /** Optional driver-user attribution (Actor.user is optional; a POD may want the signing user). */
  actor_user?: string;
  /** Actor-claimed epoch ms. Also the default for `captured_ts`. */
  ts: number;
  /** When the bytes were physically captured (epoch ms). Defaults to `ts`. */
  captured_ts?: number;
  /** Confidence in basis points (0–10000). Defaults to full confidence for a first-party native capture. */
  confidence?: number;
  evidence?: CaptureEvidence;
}

export interface DeviceContext {
  device_id: string;
  /** The device's P-256 private key — signs the offline `clientView`. Stays on-device. */
  privateKey: CryptoKey;
  /** The device's registered party; the default `actor.party` when `params.actor_party` is omitted. */
  party: string;
  /**
   * Returns the next per-device `device_seq` (the offline dedupe key, REQ-016).
   *
   * DURABILITY CONTRACT (load-bearing — the PWA's implementation MUST honor this):
   *  - MONOTONIC ACROSS APP RESTARTS: the counter must be persisted durably BEFORE this returns, and
   *    must never reset. A counter that resets to 0 on reboot RE-EMITS `(device_id, seq)` pairs with
   *    DIFFERENT content; first-wins merge (`mergeByDeviceSeq`) and the sequencer's unique index then
   *    SILENTLY DROP the later one — signed airplane-mode data lost, with no error (CLAUDE.md rule 6).
   *    This reset-to-zero footgun is exactly what the persistence contract prevents.
   *  - A seq GAP is harmless — only REUSE is dangerous. So `capture` validates the payload BEFORE
   *    calling `nextSeq` (a bad capture never burns a seq), and contiguity is NOT required, just no-reuse.
   */
  nextSeq(): number;
}

export interface DeferredUpload {
  /** The 64-hex SHA-256 written into the event payload — the tamper-evident link to the bytes. */
  hash: string;
  /** The ORIGINAL evidence bytes, queued for a LATER upload (REQ-017). Never rehashed downstream. */
  bytes: Uint8Array;
  /** The payload field the hash landed in (an `EvidenceField`, tagging the upload). */
  field: EvidenceField;
}

export interface CaptureResult {
  event: EventInput;
  /** Present iff `params.evidence` was supplied — the raw bytes the PWA must queue + upload later. */
  deferred?: DeferredUpload;
}

const DEFAULT_CONFIDENCE = 10_000; // Bps: full confidence for a native, first-party device capture.

/**
 * Capture a signed physical event offline. If `evidence` bytes are supplied they are hashed at
 * capture (SHA-256 → the payload field), the raw bytes come back as a `deferred` upload, and the
 * event carries only the hash (REQ-017). The event is stamped with a per-device `device_seq`,
 * co-signed with the device key over the frozen `clientView`, and returned `EventInput.parse`-valid.
 */
export async function capture(params: CaptureParams, deviceCtx: DeviceContext): Promise<CaptureResult> {
  const ts = params.ts;
  const captured_ts = params.captured_ts ?? ts;
  const party = params.actor_party ?? deviceCtx.party;

  // Evidence bytes are hashed AT CAPTURE (REQ-017). The hash lands in the payload field the Gatekeeper
  // reads; the bytes ride out as a deferred upload. The envelope `evidence[]` stays empty here: the
  // upload has no `doc_id` yet, and `evidence[]` is part of the FROZEN signed set — attaching a
  // ref later would break the device signature. The content hash in the payload is the durable link.
  const payload: Record<string, unknown> = { ...params.payload };
  let deferred: DeferredUpload | undefined;
  if (params.evidence) {
    const hash = await sha256Hex(params.evidence.bytes);
    payload[params.evidence.field] = hash;
    deferred = { hash, bytes: params.evidence.bytes, field: params.evidence.field };
  }

  // Validate the capture BEFORE consuming a device_seq: a malformed payload/kind (e.g. an evidence
  // field that the kind's payload doesn't accept) must throw WITHOUT burning a sequence number. We
  // parse a DEVICE-LESS candidate — it validates the payload against its kind (and I4, since
  // `actor.device` is present) while omitting the offline dedupe fields, so the `device_id ⟹
  // device_seq` refine is satisfied without a seq. Only after this succeeds do we mint one.
  const candidate = EventInput.parse({
    id: crypto.randomUUID(),
    shipment_id: params.shipment_id,
    ts,
    actor: { party, user: params.actor_user, device: deviceCtx.device_id }, // device co-signs (I4)
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: params.confidence ?? DEFAULT_CONFIDENCE,
    captured_ts,
    kind: params.kind,
    payload,
  });

  const device_seq = deviceCtx.nextSeq();

  // Attach the offline dedupe fields, then the device signature over the frozen clientView. device_id
  // / device_seq / sig do NOT touch the kind↔payload discriminant, so the validated `candidate` stays
  // a valid EventInput of the same kind — no re-parse needed. (A second EventInput.parse would only
  // re-run Zod to re-check an unconstrained-optional `sig`: wasted cost in Task 7's 50-event soak.)
  const signable = { ...candidate, device_id: deviceCtx.device_id, device_seq };
  const sig = await signEvent(signable, deviceCtx.privateKey);
  const event: EventInput = { ...signable, sig };

  return deferred ? { event, deferred } : { event };
}
