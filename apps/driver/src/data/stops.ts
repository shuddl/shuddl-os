import type { StopKind } from "../flow/stop-flow.js";

// Task 10 (REQ-030/025) — the PRODUCTION day-sheet read path is GONE: the App now fetches an
// authenticated server manifest (api/client.ts) and maps it to `Stop`. `Stop` is the shared display
// shape; `DAY_SHEET` below is a TEST-ONLY fixture (consumed by GatedFlow.test.tsx), never imported by a
// production module — so it is tree-shaken out of the client bundle (App.test.tsx greps the build to
// prove it). FICTIONAL consignees + generic addresses only — no real tenant/customer name ever lands in
// a repo artifact (REQ-167).
export interface Stop {
  readonly id: string;
  readonly seq: number;
  readonly kind: StopKind;
  readonly name: string;
  readonly address: string;
  readonly window: string;
  /** Pickup lanes that are dims-fitted require a dims.captured before departure. */
  readonly dimsRequired?: boolean;
}

// TEST-ONLY fixture (GatedFlow.test.tsx). Not a production read path — App renders from the server
// manifest. Kept here so the flow orchestration tests have deterministic pickup/delivery stops.
export const DAY_SHEET: readonly Stop[] = [
  { id: "s1", seq: 1, kind: "pickup", name: "Rivergate Dry Goods", address: "4200 NW Front Ave", window: "08:00–10:00", dimsRequired: true },
  { id: "s2", seq: 2, kind: "delivery", name: "Eastbank Grocery DC", address: "1815 SE 6th Ave", window: "10:30–12:00" },
  { id: "s3", seq: 3, kind: "pickup", name: "Cascade Hardware Co", address: "700 N Hayden Island Dr", window: "12:30–14:00" },
  { id: "s4", seq: 4, kind: "delivery", name: "Trillium Outfitters", address: "3344 SE Powell Blvd", window: "14:30–16:00" },
];
