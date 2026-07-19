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

// REQ-180 — the NEVER-WIDEN FLOOR. Some kinds are inherently internal (margin/credit/consent/control):
// call transcripts, credit checks, approvals, agent actions, authority flips, interline/margin splits.
// A tenant POLICY override or a per-event `requested_visibility` must NEVER be able to WIDEN these past
// the tenant lens — a misconfigured policy naming `call.transcribed: counterparty` (or a spoofed request)
// cannot be allowed to surface a transcript or a credit decision to a counterparty/public reader. So after
// the normal default→policy→request resolution, `resolveVisibility` CLAMPS any kind in this set back to
// `internal`, regardless of what policy/request asked for. This is an ADDITIONAL clamp on the OVERRIDE path;
// KIND_VISIBILITY_DEFAULTS is untouched (these kinds already default to internal — the frozen 35-pair
// snapshot stays green).
//
// SCOPE (the 6-vs-7 discrepancy — fail-closed superset): genesis/09 REQ-180 names SIX kinds
// (call.transcribed, credit.checked, approval.requested, approval.decided, agent.acted, authority.flipped)
// and EXCLUDES split.computed. But split.computed is ALSO code-default-internal (see
// KIND_VISIBILITY_DEFAULTS above) and carries interline/margin internals (the executing-share + margin math);
// widening it would leak exactly the numbers I5/REQ-040 keep inside the tenant lens. Clamping the FAIL-CLOSED
// SUPERSET — all SEVEN code-default-internal kinds — is the safe choice: a floor can only ever be too strict,
// never too loose. PROPOSED REGISTER ALIGNMENT (a comment, not a register edit — the CSV is append-only and
// owner-signed): amend REQ-180's kind list to add `split.computed`, making the register's 6 match the code's 7.
const INTERNAL_FLOOR: ReadonlySet<EventKind> = new Set<EventKind>([
  "call.transcribed",
  "credit.checked",
  "approval.requested",
  "approval.decided",
  "agent.acted",
  "authority.flipped",
  "split.computed", // superset: NOT named by REQ-180, but code-default-internal + interline/margin-bearing
]);

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
  // REQ-180 NEVER-WIDEN FLOOR: an inherently-internal kind is clamped to `internal` no matter what a policy
  // or requested_visibility resolved above — the widen path can never surface it past the tenant lens.
  if (INTERNAL_FLOOR.has(kind)) return "internal";
  return v;
}
