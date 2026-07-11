// REQ-004/REQ-027/REQ-040/I5: the audited rating engine. WP-04 Task 3 ships the freight core here (zone +
// deficit-weight freight, UNKNOWN on missing physics); Task 4 the composer (fsc + accessorials); Task 5
// the three floors + the unified priceShipment that pins every rate_config version it priced against. The
// 504-sweep + 48 engine tests (fixtures manifest M-01) land in later WP-04 tasks.
export { priceFreight } from "./engine.js";
export { roundHalfUp, mulDivHalfUp } from "./money.js";
export { compose } from "./compose.js";
export type { PriceLineKind, PriceLine, Composed } from "./compose.js";
export { computeFloors } from "./floors.js";
export type { Floors } from "./floors.js";
export { priceShipment } from "./price.js";
export type { RateRequest, TenantRatingConfig, PricedQuote, QuoteResult } from "./price.js";
export { evaluateApproval, executingShare, executingShareCents, assessApproval } from "./approval.js";
export type { ApprovalKind, ApprovalRule, ApprovalDecision, Leg } from "./approval.js";
export type {
  ShipmentPhysics,
  FreightResult,
  FreightPriced,
  FreightUnknown,
} from "./types.js";
