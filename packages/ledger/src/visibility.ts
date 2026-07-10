import type { EventKind, Visibility } from "@shuddl/contracts";

// REQ-015 / I6: visibility is stamped at APPEND time by the server, never accepted from a
// client. Resolution order is default -> tenant policy override -> per-event request that
// may only NARROW. Every view (lens) then respects the stamped value; I6 is tested
// adversarially. The `Record<EventKind, Visibility>` type makes the map compile-time
// exhaustive — omit a kind and this file fails to typecheck; a runtime length check backs it.
export const KIND_VISIBILITY_DEFAULTS: Record<EventKind, Visibility> = {
  // counterparty: the physical world + the commercial artifacts a party is part of.
  "quote.requested": "counterparty",
  "quote.priced": "counterparty",
  "quote.sent": "counterparty",
  "quote.accepted": "counterparty",
  "quote.expired": "counterparty",
  "booking.created": "counterparty",
  "appointment.set": "counterparty",
  "pickup.scheduled": "counterparty",
  "dispatch.assigned": "counterparty",
  "stop.arrived": "counterparty",
  "freight.counted": "counterparty",
  "freight.photographed": "counterparty",
  "dims.captured": "counterparty",
  "custody.transferred": "counterparty",
  "seal.applied": "counterparty",
  "stop.departed": "counterparty",
  "position.updated": "counterparty",
  "exception.raised": "counterparty",
  "osd.captured": "counterparty",
  "pod.signed": "counterparty",
  "delivery.evidenced": "counterparty",
  "invoice.issued": "counterparty",
  "invoice.corrected": "counterparty",
  "payment.received": "counterparty",
  "settlement.executed": "counterparty",
  "message.received": "counterparty",
  "message.sent": "counterparty",
  "document.attached": "counterparty",
  // internal: margin, credit, consent, control — never leaves the tenant lens by default.
  "credit.checked": "internal",
  "split.computed": "internal",
  "call.transcribed": "internal",
  "approval.requested": "internal",
  "approval.decided": "internal",
  "agent.acted": "internal",
  "authority.flipped": "internal",
};

// internal (most restrictive) < counterparty < public (widest). Narrowing = moving to a
// lower rank; a per-event request may only lower, never raise.
const RANK: Record<Visibility, number> = { internal: 0, counterparty: 1, public: 2 };

/**
 * Server-side, append-time visibility resolution (REQ-015). Clients never set visibility
 * directly — `requested` is advisory and may only NARROW the resolved value.
 *
 * @param correctedEventVisibility — for `invoice.corrected` only: the visibility of the
 *   `invoice.issued` it corrects. A correction inherits it verbatim so I7 netting stays
 *   inside a single counterparty lens (a correction visible where the original is not would
 *   leave a party seeing a phantom charge).
 */
export function resolveVisibility(
  kind: EventKind,
  policy: Record<string, Visibility> | undefined,
  requested: Visibility | undefined,
  correctedEventVisibility?: Visibility,
): Visibility {
  if (kind === "invoice.corrected" && correctedEventVisibility) return correctedEventVisibility;
  let v = policy?.[kind] ?? KIND_VISIBILITY_DEFAULTS[kind];
  if (requested && RANK[requested] < RANK[v]) v = requested; // narrow-only
  return v;
}
