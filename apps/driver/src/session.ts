// REQ-013/016/017 — the driver device's offline capture session, wiring @shuddl/driver-core to the
// PWA's IndexedDB ports. One lazily-initialized singleton per tab:
//   - a P-256 device key, PERSISTED across launches (so device_id is stable — the offline dedupe key),
//   - a DURABLE per-device sequence counter (monotonic across restarts — no reset-to-0 merge drops),
//   - the OfflineQueue over the durable IDB QueueStore (signed captures survive a tab-kill, rule 6).
// `captureAndEnqueue` runs the frozen capture leg (hash-at-capture, co-sign, stamp device_seq) and
// enqueues the event + any deferred evidence bytes for later sync — the airplane-mode path (Task 7).
import {
  capture,
  generateDeviceKey,
  OfflineQueue,
  type CaptureParams,
  type DeviceContext,
} from "@shuddl/driver-core";
import { IdbQueueStore } from "./storage/idb-queue-store.js";
import { DurableSeq, IdbSeqStore } from "./storage/durable-seq.js";
import { metaGet, metaPut, openDb } from "./storage/idb.js";

const DEVICE_KEY_META = "device_key";
const CARRIER_PARTY = "p:carrier";

/**
 * REQ-166 — the driver's location-tracking consent, acknowledged ONCE per session for its operating
 * state (a real app captures this on the day-sheet "start day" tap; here it's a fixed session ack for
 * the Portland loop). Consent is PER OPERATING STATE: a multi-state day needs one ack per state, and
 * each stop's arrive must emit a consent doc for the state it's in (a follow-up — the OR-only demo
 * needs exactly one). The stop's `arrive` capture materializes this ack as a `document.attached`
 * ConsentAck ON THAT STOP'S STREAM before its GPS stamp, because the server gate is per-stream.
 */
export interface SessionConsent {
  readonly operating_state: string;
  readonly policy_version: string;
}

export const SESSION_CONSENT: SessionConsent = { operating_state: "OR", policy_version: "v1" };

/**
 * The EXACT four-field `.strict()` ConsentAck payload derived from the session ack (doc 10). Any extra
 * key (a doc_id, hash, or captured_ts) would fail the gate's `ConsentAck.safeParse` and silently block
 * the driver from ALL GPS in that state — so only these four fields ever go in the consent payload.
 */
export function consentAckPayload(consent: SessionConsent = SESSION_CONSENT): {
  doc_kind: "consent";
  policy_version: string;
  operating_state: string;
  acknowledged: true;
} {
  return {
    doc_kind: "consent",
    policy_version: consent.policy_version,
    operating_state: consent.operating_state,
    acknowledged: true,
  };
}

interface StoredKey {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
  device_id: string;
}

export interface DriverSession {
  readonly deviceCtx: DeviceContext;
  readonly queue: OfflineQueue;
  readonly device_id: string;
}

// REQ-069 (driver auth + lockout — DEFERRED / follow-up): a stable per-device P-256 KEY session exists here
// (the offline dedupe identity + the signing key), but that is DEVICE identity, not a driver LOGIN. A simple
// driver auth (magic-link / PIN) plus a lockout policy on repeated failures is a follow-up — no login screen
// or lockout counter ships in WP-05. The device key is the substrate a later auth binds a signed-in driver to.
let sessionPromise: Promise<DriverSession> | null = null;

/** Load the persisted device key, or mint + persist a fresh one on first launch. */
async function loadOrCreateKey(): Promise<{ device_id: string; privateKey: CryptoKey }> {
  const db = await openDb();
  const stored = await metaGet<StoredKey>(db, DEVICE_KEY_META);
  if (stored) {
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      stored.privateJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    return { device_id: stored.device_id, privateKey };
  }
  const key = await generateDeviceKey();
  const privateJwk = await crypto.subtle.exportKey("jwk", key.keyPair.privateKey);
  await metaPut(db, DEVICE_KEY_META, { privateJwk, publicJwk: key.publicJwk, device_id: key.device_id });
  return { device_id: key.device_id, privateKey: key.keyPair.privateKey };
}

async function initSession(): Promise<DriverSession> {
  const { device_id, privateKey } = await loadOrCreateKey();
  const seq = await DurableSeq.open(new IdbSeqStore());
  const queue = new OfflineQueue(new IdbQueueStore());
  const deviceCtx: DeviceContext = {
    device_id,
    privateKey,
    party: CARRIER_PARTY,
    nextSeq: () => seq.nextSeq(), // sync draw from the durably-reserved block
  };
  return { deviceCtx, queue, device_id };
}

/** The one session for this tab, created on first use. */
export function getSession(): Promise<DriverSession> {
  if (!sessionPromise) sessionPromise = initSession();
  return sessionPromise;
}

/**
 * REQ-016 — best-effort ask the browser to make IndexedDB PERSISTENT (not evictable under storage
 * pressure). Eviction would wipe the `device_seq` ceiling + the offline queue, resetting `nextSeq` and
 * risking a silent merge-drop. Fully guarded: a denied request, or a browser without the API, is fine —
 * the app still runs, just more evictable. Fire-and-forget at startup; never throws, never blocks.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = globalThis.navigator?.storage;
    if (!storage?.persist) return false; // API absent (older browser / non-secure context) — no-op
    return await storage.persist(); // true = granted persistence; false = still evictable (best-effort)
  } catch {
    return false;
  }
}

/**
 * Capture a signed event offline and enqueue it (+ deferred evidence bytes) for later sync. Returns
 * the deferred evidence hash when the capture carried bytes — the driver threads a placed-photo hash
 * from photo_placed into the terminal delivery.evidenced.
 */
export async function captureAndEnqueue(params: CaptureParams): Promise<{ hash?: string }> {
  const session = await getSession();
  const result = await capture(params, session.deviceCtx);
  await session.queue.enqueue(result.event, result.deferred);
  return result.deferred ? { hash: result.deferred.hash } : {};
}

/**
 * How many captures are still awaiting sync.
 *
 * DEFER (Task 9 / WP-06 owns the sync UI): this is not yet wired into the UI — the driver screens show
 * a STATIC "OFFLINE — CAPTURING LOCALLY" caption. When the background sync loop lands, drive the
 * "OFFLINE / N QUEUED" count from this (and clear items via `queue.markSynced` on ACK).
 */
export async function pendingCount(): Promise<number> {
  const session = await getSession();
  return (await session.queue.pending()).length;
}
