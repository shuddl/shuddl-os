import { z } from "zod";
import { SafeInt } from "./json.js";

// Task 10 (REQ-030/025/013) — the driver PWA's day-sheet contract. The manifest is an AUTHENTICATED,
// server-scoped read: the server resolves tenant + driver from the verified JWT ONLY and returns a
// STRICT allowlist of the driver's assigned stops with a server timestamp. It REPLACES the fictional
// DAY_SHEET client fixture — no field here is a client input, and no precise future-stop field is
// returned outside the current V1 reveal policy.
//
// POD-before-next-address (server-side, V1): a stop is `revealed` only once every earlier stop's
// terminal evidence is committed. A withheld (future) stop carries `geo: null` — the precise field is
// NOT serialized until the driver has earned it. The client can render an honest "locked" row but can
// never learn the withheld coordinate.

// The precise stop coordinate (integer microdegrees, canonical-law). Present ONLY on a revealed stop.
export const DriverStopGeo = z.object({ lat_e6: SafeInt, lon_e6: SafeInt }).strict();
export type DriverStopGeo = z.infer<typeof DriverStopGeo>;

export const DriverStop = z
  .object({
    shipment_id: z.string().min(1),
    seq: SafeInt.min(0), // the leg order within the stop's shipment
    kind: z.enum(["pickup", "delivery"]),
    // Derived SERVER-SIDE from the append-only ledger, never a client claim:
    //   pending  — no stop.arrived yet · arrived — stop.arrived committed · done — terminal committed.
    status: z.enum(["pending", "arrived", "done"]),
    // The V1 reveal bit. false ⇒ this is a future stop the driver has not earned; geo is null.
    revealed: z.boolean(),
    // The precise coordinate — null whenever `revealed` is false (withheld future-stop field).
    geo: DriverStopGeo.nullable(),
  })
  .strict();
export type DriverStop = z.infer<typeof DriverStop>;

export const DriverManifest = z
  .object({
    server_ts: SafeInt.min(0), // the server clock at read — the client's freshness anchor
    tenant: z.string().min(1), // echoed from the JWT claim (server-resolved), never a request body id
    driver_id: z.string().min(1), // the authenticated principal (session.sub), never a client-supplied id
    stops: z.array(DriverStop),
  })
  .strict();
export type DriverManifest = z.infer<typeof DriverManifest>;
