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
const INTERNAL_FLOOR: ReadonlySet<EventKind> = new Set<EventKind>(
  // DERIVED from KIND_VISIBILITY_DEFAULTS, not re-typed (audit §267). This set IS "every code-default-
  // internal kind" — that is the definition above, and it was maintained by hand as seven literals that
  // happened to match. Deriving it means a NEW kind whose default is `internal` is clamped the moment it
  // is added, instead of on the day someone remembers this second list. The direction is the safe one the
  // comment argues for: a floor can only ever be too strict, never too loose, so auto-inclusion cannot
  // leak. (Verified identical at the time of the change: 7 of 35 kinds, same seven.)
  (Object.entries(KIND_VISIBILITY_DEFAULTS) as ReadonlyArray<[EventKind, Visibility]>)
    .filter(([, v]) => v === "internal")
    .map(([k]) => k),
);

// Task 8 (REQ-015 / I7) — the INHERITED-VISIBILITY kinds: kinds whose visibility is NOT a default of their own
// but is INHERITED from a specific parent event (today only invoice.corrected, which inherits the visibility of
// the invoice.issued / prior invoice.corrected it nets against). For these kinds there is NO fallback default:
// the resolution is exact-parent-or-nothing.
const INHERITED_VISIBILITY_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(["invoice.corrected"]);

// Task 8 (REQ-015 / I7) — the sentinel returned when an INHERITED-visibility kind's parent visibility could NOT
// be resolved (the parent is missing, the wrong kind, on another stream, or in another tenant). It is NOT a
// Visibility and is NEVER stored: the append-time caller (the sequencer) MUST reject a correction that resolves
// to it, failing closed. A correction that instead defaulted to `counterparty` when its parent could not be
// resolved could surface a phantom charge in a lens the original never appeared in — I7 netting must stay inside
// the parent's EXACT lens, so an unresolved parent is a hard refusal, never a permissive default.
export const UNRESOLVED_VISIBILITY = "unresolved" as const;
export type ResolvedVisibility = Visibility | typeof UNRESOLVED_VISIBILITY;

/**
 * Server-side, append-time visibility resolution (REQ-015). Clients never set visibility
 * directly — `requested` is advisory and may only NARROW the resolved value.
 *
 * @param correctedEventVisibility — for an INHERITED-visibility kind (`invoice.corrected`) only: the
 *   resolved visibility of the `invoice.issued` / prior `invoice.corrected` it corrects (the sequencer
 *   resolves it by exact stream + kind). A correction inherits it VERBATIM so I7 netting stays inside the
 *   parent's single lens (a correction visible where the original is not would leave a party seeing a phantom
 *   charge). When it is undefined the parent could not be resolved, so this returns `UNRESOLVED_VISIBILITY`
 *   (fail closed) — NEVER the per-kind default.
 */
export function resolveVisibility(
  kind: EventKind,
  policy: Record<string, Visibility> | undefined,
  requested: Visibility | undefined,
  correctedEventVisibility?: Visibility,
): ResolvedVisibility {
  // An inherited-visibility kind resolves to its parent's EXACT visibility, or UNRESOLVED when the parent could
  // not be resolved. It has no default of its own (KIND_VISIBILITY_DEFAULTS keeps an entry only for map
  // exhaustiveness) and its inheritance is verbatim — a requested_visibility can neither widen nor narrow it.
  if (INHERITED_VISIBILITY_KINDS.has(kind)) return correctedEventVisibility ?? UNRESOLVED_VISIBILITY;
  let v = policy?.[kind] ?? KIND_VISIBILITY_DEFAULTS[kind];
  if (requested && RANK[requested] < RANK[v]) v = requested; // narrow-only
  // REQ-180 NEVER-WIDEN FLOOR: an inherently-internal kind is clamped to `internal` no matter what a policy
  // or requested_visibility resolved above — the widen path can never surface it past the tenant lens.
  if (INTERNAL_FLOOR.has(kind)) return "internal";
  return v;
}
