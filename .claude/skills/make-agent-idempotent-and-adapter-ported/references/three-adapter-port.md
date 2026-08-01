# The three-adapter port — skeleton & rules

Every external seam an agent touches (email → `sender.ts`, LLM → `parse.ts`; next: routing,
Stripe) is a **port**: one Zod boundary, one typed error, three adapters. The composition root
(`workers/agents/src/index.ts`) picks the adapter; the consumer never does. This is what makes
"going live" a CONFIRM-gated config flip, not a code change.

## The typed error (copy the shape exactly)
`SendError` (`sender.ts:109-118`) and `ParseError` (`parse.ts:64-73`) are identical by design so
the consumer routes both the same way:
```ts
export class SendError extends Error {
  readonly retriable: boolean;      // true ⇒ queue redelivery may succeed; false ⇒ hold for a human
  readonly status: number | undefined; // provider HTTP status when a response existed; else undefined
  constructor(message: string, retriable: boolean, status?: number) {
    super(message); this.name = "SendError"; this.retriable = retriable; this.status = status;
  }
}
```
Rule: error messages **never** carry the api key. Network-level failures (no Response) set
`status: undefined` but are still `retriable: true` (the idempotency key makes a re-send safe).

## Adapter 1 — Deterministic (tests + smoke fallback)
`RecordingSender` (`sender.ts:139-170`) / `DeterministicParser` (`parse.ts:165-212`).
- Pure, no network; same input → byte-identical output.
- `RecordingSender` mirrors the provider's idempotency: same key + same payload → the ORIGINAL
  receipt; same key + DIFFERENT payload → a non-retriable conflict (`sender.ts:152`) — that catches
  a core bug where one terminal event id composes two different messages.
- `async` even for pure failures, so a validation fault REJECTS rather than sync-throwing past a
  caller's `.catch()` (`sender.ts:144-146`).

## Adapter 2 — NotConfigured (the default, rejects LOUD)
`NotConfiguredSender` (`sender.ts:178-191`) / `NotConfiguredParser` (`parse.ts:242-251`).
- A silent no-op is **forbidden** — an operator must never believe evidence went out / an email was
  understood when nothing is wired.
- Validate first (a MALFORMED message rejects with the *validation* error — a code bug), then throw
  the typed error with `retriable: true` and an actionable message (bind the CONFIRM-gated secret).
- Retriable so that binding the provider + letting the queue redeliver simply works.

## Adapter 3 — Live (raw fetch, no SDK, injected secrets)
`ResendSender` (`sender.ts:253-373`) / `ClaudeParser` (`parse.ts:390-459`).
- **Raw `fetch`** to the vendor REST endpoint — no `@anthropic-ai/sdk`, no `resend` npm pkg. SDKs are
  not reliably worker-runtime-safe and they bury the retriable verdict.
- Config injected via constructor (`{ apiKey, from, fetchImpl? }`), **never** read from `env`/`process.env`
  inside the adapter (`sender.ts:194`, `parse.ts:256`). `fetchImpl` defaults to `globalThis.fetch` and is
  injected in tests so the live adapter is exercised without ever touching the network.
- Status→retriable mapping (the canonical table, `sender.ts:301-372`):
  - network throw (no Response) → retriable, no status
  - 2xx but unparseable id → retriable (idempotency key makes re-send safe)
  - 409 `concurrent_idempotent_requests` → retriable; any other 409 (same key, different payload) → NOT retriable (a core bug)
  - 429 / ≥500 → retriable
  - other 4xx (400/401/403/422) → NOT retriable (redelivery can't fix a bad key/request)
  - route on the body's machine `name` / the HTTP status — **never regex the human message** (`sender.ts:324`).
- LLM-specific (`parse.ts:425-435`): a MALFORMED model response fail-safes to `{intent:"unknown",
  confidence:0}` through the schema — the model never writes ledger-affecting structure unvalidated.
  The model's self-reported `confidence` may steer routing but must NEVER gate auto-send (that is
  derived independently downstream).

## The composition root selects the adapter (never the consumer)
`index.ts:67-87`: both halves of the config present ⇒ Live; anything less ⇒ NotConfigured.
```ts
function evidenceSender(env: AgentsEnv): EvidenceSender {
  const apiKey = env.RESEND_API_KEY, from = env.EVIDENCE_FROM;
  if (apiKey && from) return new ResendSender({ apiKey, from });
  return new NotConfiguredSender();   // rejects loud + retriable
}
```
`conciergeParser` mirrors it for `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL`. The consumer receives the
port via `deps` and calls `.send()` / `.parse()` — it has no idea which adapter it holds.

## The consumer's retriable routing (the other half)
`index.ts:334-344` — the ONLY place that inspects the typed error:
```ts
} catch (err) {
  const status = err instanceof SendError || err instanceof ParseError ? err.status : undefined;
  if ((err instanceof SendError || err instanceof ParseError) && err.retriable && status === 429) {
    message.retry({ delaySeconds: RATE_LIMIT_RETRY_DELAY_S }); // back off a throttle window
  } else {
    message.retry();
  }
}
```
Poison (a body matching no trigger shape, an unknown tenant) is `ack()`ed with a loud log
(`index.ts:296-310`) — redelivery cannot fix a shape, and retrying forever only delays real work
until the DLQ + exceptions surface land (WP-11).
