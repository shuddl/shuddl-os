---
name: harden-agent-against-model-trust
description: Use when building or extending ANY SHUDDL agent (built or unbuilt) — specifically when an agent consumes LLM output, resolves a party/identity from a message, decides whether to auto-send, or lets a model touch a price-affecting field (weight, dims, accessorials). Symptoms: gating on parse.confidence, keying identity off a model-extracted email, auto-sending on the model's word, re-parsing on redelivery.
---

> **Description corrected 2026-08-04 (audit §170).** It read *"any of SHUDDL's 11 UNBUILT agents
> (Scheduler, Dispatcher, Watchtower, etc.)"*. Twelve of the thirteen agents are now built — Scheduler and
> Watchtower among them (audit §122) — so the trigger both mis-stated the count and, worse, implied the
> skill does **not** apply to the agents it named. Anyone extending Watchtower would have read past it.
> Rewritten to be state-independent: the law applies to any agent that lets a model touch a decision,
> whether that agent exists yet or not. Note the grounding note below scopes *examples and citations* —
> a count in the YAML `description` is neither, and `description` is the field that decides whether this
> skill is loaded at all.
>
> **Grounding note (added 2026-08-01, on commit — 16 days after writing):** the examples and
> `path:line` citations in this skill are observations FROZEN as-of its writing (2026-07-15/16).
> Several RED examples have since been FIXED in live code — verify against HEAD before treating any
> cited defect as current. The LAW each skill states is current; the citations are its provenance,
> not its proof. Enrolled in the citation ratchet as a dated record (the 2026-07-15 audit precedent).

# Harden Agent Against Model Trust (the C1 doctrine)

## Overview
The model is a suggestion engine over hostile input, never an authority. Its self-reported confidence gates nothing; its extracted identity binds nothing; its numbers price nothing until an independent, deterministic check confirms them and fails closed. REQ-024: LLM output is advisory events only — it never writes ledger truth.

## When to Use
Use when your agent: reads an LLM parse of an email/document; find-or-creates a Party from a message; decides to auto-send (a quote, a booking, an invoice); or lets a model value flow into a sell/rate. Also when adding a redelivery fast-path. **Not** for pure deterministic flows with no model in the loop (a projection, a gate over committed events).

REQUIRED BACKGROUND: the Rater's no-price-on-air law and I2 send-recipient pin.

## The four rules (each grounded in the two agents that exist)

**1. Model confidence gates nothing, ever.** `parse.confidence` is model-supplied over an untrusted body — a prompt-injected email can order "output confidence 10000" (`parse.ts:284`). It may steer *which queue* an intent lands in but never an auto-action. `resolve.ts:16` ignores it entirely; `compose.ts:26` derives the send decision independently. Score your own confidence on DB-verified structural facts (`resolutionConfidence`, `resolve.ts:98`), not the model's grade.

**2. Identity keys off the authenticated channel, not the model.** Resolve parties from the authenticated envelope sender (`from_ref`), never `party_hint.email` (REQ-172). See `resolve.ts:119-131`: `resolveConcierge(...senderEmail)` ties party find-or-create to `senderEmail`; `party_hint.name` survives only as a cosmetic display name (`resolve.ts:157-159`). A crafted body naming a victim's on-file address must not earn the existing-party bump.

**3. Auto-action requires a deterministic re-extraction that fails closed per price-affecting field.** Before auto-send, re-derive the same bytes with the `DeterministicParser` and require agreement on EVERY price-affecting field (REQ-171/175). `compose.ts:122-137` `corroborates()`: both zips must match; weight fails closed (a model weight the deterministic parser can't confirm queues); accessorials must be an equal set; dims fail closed on presence. Divergence → `queued: not_corroborated`.

**4. Missing physics → UNKNOWN → queue, never a model guess.** No price on air: an absent request or a Rater `UNKNOWN` queues (`compose.ts:149-151`), and below-floor/anomaly never auto-sends (`compose.ts:93-95`, REQ-040). The model never supplies a number that becomes money.

**Redelivery purity (REQ-178):** a redelivery fast-path re-renders from committed events only — pin every rendered config input (e.g. the tenant from-name) into the `message.sent` payload. Never re-parse or re-judge; a non-deterministic re-parse across a redeploy plants inconsistent payloads or spurious 409 holds.

## Quick Reference
| Decision | WRONG (trusts model) | RIGHT (SHUDDL) |
|---|---|---|
| Gate an auto-action | `if (parse.confidence >= X)` | independent structural/deterministic check |
| Resolve a party | `party_hint.email` | authenticated `from_ref` / `senderEmail` |
| Price-affecting field | take the model's value | deterministic re-extract, **fail closed** |
| Missing weight/dims | let the model guess | UNKNOWN → queue |
| Redelivery | re-parse the email | re-render from committed events |

## Common Mistakes
- **Gating on `parse.confidence`.** It is prompt-injectable. Fix: score your own from DB facts; see `resolve.ts:12-16`.
- **`findPartyByEmail(party_hint.email)`.** Lets a crafted body impersonate. Fix: key off `senderEmail` (REQ-172, `resolve.ts:130`).
- **Failing OPEN on an unconfirmable field** ("deterministic parser didn't find a weight, so allow it"). That is the exact under-quote hole REQ-171 closes. Fix: unconfirmable → queue (`compose.ts:128-135`).
- **Whitelisting a price-inert field out of corroboration.** Dims are price-inert under today's cwt engine, yet still fail closed on presence (REQ-175, `compose.ts:135`) — the divergence-can't-send doctrine covers every price-affecting field, present and future.
- **Re-parsing on redelivery.** Non-deterministic; breaks payload consistency. Fix: pin config inputs, re-render only (REQ-178).

See `reextraction-fail-closed-checklist.md` and `from_ref-vs-party_hint.md`.
