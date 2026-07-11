// REQ-004/REQ-027/REQ-040: the audited rating engine. WP-04 Task 3 ships the freight core here
// (zone + deficit-weight freight, UNKNOWN on missing physics); fsc/accessorials/floors and the
// 504-sweep + 48 engine tests (fixtures manifest M-01) land in later WP-04 tasks.
export { priceFreight } from "./engine.js";
export { roundHalfUp } from "./money.js";
export type {
  ShipmentPhysics,
  FreightResult,
  FreightPriced,
  FreightUnknown,
} from "./types.js";
