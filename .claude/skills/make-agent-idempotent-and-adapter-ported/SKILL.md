---
name: make-agent-idempotent-and-adapter-ported
description: Use when building any new SHUDDL agent core or its external seam (email, LLM, routing, Stripe), when an agent runs under an at-least-once Queue, or when generating an event/shipment/party/send id. Trigger on new queue consumers, redelivery handling, or any raw fetch to a vendor from packages/agents.
---

> **Grounding note (added 2026-08-01, on commit — 16 days after writing):** the examples and
> `path:line` citations in this skill are observations FROZEN as-of its writing (2026-07-15/16).
> Several RED examples have since been FIXED in live code — verify against HEAD before treating any
> cited defect as current. The LAW each skill states is current; the citations are its provenance,
> not its proof. Enrolled in the citation ratchet as a dated record (the 2026-07-15 audit precedent).

# Make an Agent Idempotent & Adapter-Ported

## Overview
Cloudflare Queues is **at-least-once**: a message redelivers whenever the consumer does not `ack()` (docs: Queues `Message.retry()`). The single law that makes redelivery safe is **determinism** — every id an agent writes must be a pure function of the trigger event id. One `Date.now()` or `Math.random()` in a core breaks dedupe and double-sells freight. **Every agent repeats this exact recipe — the ones that exist and the next one.** (This sentence read *"Only 2 of 13 agents exist (Biller, Concierge)"* until audit §1024; the roster reached 13 of 13, and the count was **outside** the grounding note's scope above, which covers examples and `path:line` citations. §170 fixed the same class in this corpus's YAML `description`; a body count is the line that discipline stopped short of. Stated without a number so it cannot decay again.)

## When to Use
- Writing a new queue consumer in `workers/agents/` or a new core in `packages/agents/`.
- Any adapter that hits a vendor (Resend, Anthropic, Stripe) with a raw `fetch`.
- Reviewing redelivery / poison-message handling.
- **Not** for `packages/ledger` — LLM/vendor calls are statically forbidden there (REQ-024).

## The recipe (copy byte-for-byte)

**1. Twice-in → once-out.** Layer every defense; any one alone is insufficient:
- Deterministic ids (below) — the sequencer DO dedupes by event id.
- `INSERT OR IGNORE` on every read-model row (`workers/agents/src/concierge.ts:258@parties`, `:751@messages`).
  *(Both citations read `:201`/`:555` until 2026-08-04 — audit §192. Neither landed on an `INSERT OR IGNORE`
  even before this file shifted; they were among §175's deferred candidates and are now anchored, so the
  next shift fails the gate instead of drifting silently.)*
- A committed-terminal-event guard at the top → redelivery fast-path (`concierge.ts:245`).
- Sender/parser dedupe by an idempotency key derived from the terminal event id.

**2. The exact UUID-shaping recipe.** A domain-separated SHA-256 shaped into a v4-variant UUID so it passes `EventInput`'s `z.string().uuid()`. Identical bytes in `biller.ts:86-90`, `concierge.ts:118-122`, `sla-sweep.ts:80-84`:
```ts
const h = (await sha256Hex(`concierge:${domain}:${messageEventId}`)).slice(0, 32);
const variant = ((parseInt(h.slice(16, 17) || "0", 16) & 0x3) | 0x8).toString(16); // 8/9/a/b
return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
```
Non-UUID ids use the same hash, different prefix + domain tag: `shp_<16hex>` (`concierge.ts:127`), `party_<16hex>` (`concierge.ts:132`), `inv_<16hex>` (`biller.ts:94`). The **domain tag** is what keeps two ids off the same inbound from colliding. See `references/uuid-shaping.md` for test vectors.

**3. No `Date`, no `Math.random` in a core.** Timestamps come from the trigger event's `recorded_at` (`concierge.ts:369`, `:393`); the SLA due-ts is `recorded_at + WINDOW` (`concierge.ts:155`), never a fresh clock — so re-setting on redelivery is an exact no-op. The clock enters only at the composition root (the cron's `scheduledTime`, `index.ts:275-277`).

**4. The three-adapter port.** One Zod boundary, three implementations (`sender.ts`, `parse.ts`):
- **Deterministic** (`RecordingSender` / `DeterministicParser`) — pure, no network, the test + smoke fallback.
- **NotConfigured** — the default; **rejects LOUDLY and retriably**, never a silent no-op (`sender.ts:178-191`, `parse.ts:242-251`).
- **Live** (`ResendSender` / `ClaudeParser`) — **raw `fetch`, no vendor SDK** (worker-safe); secrets injected by the composition root, **never** read from `env` inside the adapter (`sender.ts:194`, `parse.ts:256`).
The root picks the adapter (`index.ts:67-87`) — the consumer never selects it.

**5. Typed retriable contract — never regex an error message.** `throw new SendError(msg, retriable, status?)` (`sender.ts:109`); `ParseError` mirrors it exactly (`parse.ts:64`). The consumer routes on the typed fields: retriable+429 → `retry({delaySeconds})`, else `retry()` (`index.ts:339-344`). Poison (bad shape / unknown tenant) → `ack()` with a loud log (`index.ts:298`, `:307`) — redelivery can't fix a shape.

**6. Redelivery fast-path.** Once the terminal event is committed, skip parse/resolve/judge and go straight to re-render from the committed events (`concierge.ts:245-248`, `resendCommittedReply` `:488`). Re-judging under context drift could flip a decision; re-parsing burns a second LLM call.

## Quick reference
| Concern | Rule | Anchor |
|---|---|---|
| Event id | domain-sep SHA-256 → v4-variant UUID | `biller.ts:86` |
| Doc/entity id | `prefix_<16hex>`, distinct domain tag | `concierge.ts:127` |
| Clock | trigger `recorded_at`, never `Date.now()` | `concierge.ts:369` |
| Unbound provider | reject loud + retriable | `sender.ts:182` |
| Vendor call | raw fetch, injected secret | `parse.ts:401` |
| Retriable | typed field on the error, not a regex | `sender.ts:110` |
| Poison | `ack()` + log, don't retry forever | `index.ts:298` |

## Common mistakes
- **`Date.now()` for an id or ts in a core.** Breaks dedupe on redelivery → double invoice/quote. Thread the trigger's `recorded_at` (`concierge.ts:369`).
- **NotConfigured silently no-ops.** An operator then believes evidence went out. It must reject loud + retriable (`sender.ts:182`).
- **Importing `@anthropic-ai/sdk` / a vendor SDK in an adapter.** Use a raw `fetch` (`parse.ts:401`); SDKs are not worker-runtime-safe and hide the retriable verdict.
- **`if (err.message.includes("rate limit"))`.** Provider wording drifts. Route on `err.status`/`err.retriable` (`index.ts:339`).
- **Re-judging on redelivery.** Context drift flips decisions. Fast-path from committed events (`concierge.ts:245`).
- **Adapter reads `env` for its key.** Reintroduces the env coupling. The root injects it (`index.ts:71`, `sender.ts:194`).
- **Keying identity off model output.** The LLM's `party_hint.email` is untrusted; key off the authenticated `from_ref` (`concierge.ts:280`, `:386`, REQ-172).

See `references/three-adapter-port.md` (shipped beside this file) for the port skeleton — one Zod boundary, one typed error, three adapters, with the composition root picking the adapter so going live is a CONFIRM-gated config flip rather than a code change.

REQUIRED BACKGROUND: cloudflare:durable-objects (the sequencer DO mutex is load-bearing across D1 awaits); see also the repo memory note "D1 append-only triggers".
