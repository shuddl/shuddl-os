# Deterministic re-extraction fail-closed checklist

Before ANY agent auto-action driven by an LLM parse, re-derive the same raw input
with a deterministic parser and confirm every price-affecting field. Reference
implementation: `packages/agents/src/concierge/compose.ts:122-137` (`corroborates`).

## The rule
`sell = f(lane, weight, accessorials, dims@WP-09)`. Any field that feeds the price
must be independently confirmed OR the action queues. "Independently confirmed"
means a second parser that never saw the model's answer reproduced it from the bytes.
Confidence from the model is NOT confirmation.

## Per-field disposition (Concierge C1, REQ-171/175)
| Field | Check | On divergence | On model-present / det-absent |
|---|---|---|---|
| origin_zip | `det.origin_zip === model.origin_zip` | queue | queue (det undefined ⇒ no request → queue, `compose.ts:125`) |
| dest_zip | `det.dest_zip === model.dest_zip` | queue | queue |
| weight_lb | equal if model priced on a weight | queue | **FAIL CLOSED** — queue (`compose.ts:128-130`) |
| accessorials | order-independent set equality | queue | queue (set size differs) |
| dims | present in det if present in model | queue @WP-09 | **FAIL CLOSED on presence** — queue (`compose.ts:135`, REQ-175) |

"Fail closed" = the SAFE outcome (queue for a human) is chosen whenever the
independent parser cannot affirmatively confirm the model. Never allow-by-default.

## Adapting to a new agent (Scheduler, Dispatcher, ...)
1. Enumerate the fields the agent's auto-action depends on (for Scheduler: appointment
   window, stop sequence, dock/accessorial requirements — whatever the model extracted).
2. For each, decide: is there a deterministic source of truth? (a regex over the same
   text, a DB lookup, a config table). If yes, require agreement. If no independent
   source exists, that field alone forces a queue — you cannot auto-act on it.
3. Fail closed: absence of confirmation ⇒ queue, never proceed.
4. Keep the re-extraction pure/network-free where possible (`compose.ts:30` purity note)
   so the decision is byte-identical on redelivery.

## Anti-patterns (real holes this closes)
- "The deterministic parser missed the weight, but the model is usually right" → this is
  the exact injected/unconfirmable-weight under-quote REQ-171 forbids.
- "Dims don't affect price today, skip them" → REQ-175: the divergence-can't-send doctrine
  covers price-inert fields too; only the VALUE check waits for WP-09, not the presence check.
- Gating the whole thing on `parse.confidence` → prompt-injectable (`parse.ts:284`),
  never a gate (`compose.ts:26`).
