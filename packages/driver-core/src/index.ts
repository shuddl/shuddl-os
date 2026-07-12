// @shuddl/driver-core — the pure offline signed-capture engine (REQ-013/016/017). No DOM, no
// IndexedDB, no network: persistence + upload are injected ports the driver PWA wires in (Task 8).
export { generateDeviceKey, type DeviceKey } from "./device-key.js";
export {
  capture,
  type CaptureParams,
  type CaptureEvidence,
  type CaptureResult,
  type DeviceContext,
  type DeferredUpload,
  type EvidenceField,
} from "./capture.js";
export { OfflineQueue, type QueueStore, type QueueItem } from "./queue.js";
export { mergeByDeviceSeq } from "./merge.js";
