import { z } from "zod";
import { SafeInt } from "./json.js";

// REQ-002 / doc 14 §06 — a raw GPS ping. positions are a PHYSICAL PARTITION of the ledger (doc 10
// entry 9): they bypass the sequencer/hash-chain and land directly in the `positions` table, deduped
// by the PK (shipment_id, device_id, ts). This is the client-suppliable subset — the server stamps
// `recorded_at` and computes the canonical `hash` (the Merkle leaf), never a client.
//
// Integer-only canonical law (Decision 6): coordinates are microdegrees (lat_e6/lon_e6), accuracy is
// whole metres, speed is cm/s. No REAL columns, ever. `.strict()` rejects any stray field.
export const PositionInput = z
  .object({
    shipment_id: z.string().min(1),
    device_id: z.string().min(1),
    ts: SafeInt.min(0), // capture epoch ms (device clock; advisory like an event's ts)
    lat_e6: SafeInt,
    lon_e6: SafeInt,
    accuracy_m: SafeInt.min(0).optional(),
    speed_cms: SafeInt.min(0).optional(),
  })
  .strict();
export type PositionInput = z.infer<typeof PositionInput>;
