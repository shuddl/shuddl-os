---
name: park-unroutable-work-never-destroy-it
description: Use when a queue consumer decides ack vs retry, when handling an "unknown tenant/stream/kind" branch, when a worker keeps a static roster (tenant map, binding allowlist) that a sibling service exceeds, or when writing a recovery sweep/cron that enumerates tenants. Symptoms — message.ack() in a catch branch, "ack as poison", a DLQ declared in config while a consumer destroys instead of retrying, a sweep iterating a static slug list.
---

# Park Unroutable Work, Never Destroy It

## Overview
POISON means "redelivery can never fix this" — an unparseable body, and only that. UNROUTABLE-HERE
means "this consumer's roster can't resolve it" — and rosters lag their producers. Poison is ACKed
with a loud log; unroutable work RETRIES toward the DLQ, parking a recoverable record. An ack in the
wrong branch silently destroys money-bearing work, and the sweep that would recover it usually shares
the same roster blind spot.

## When to Use
- Writing any `queue()` consumer's dispatch/error branches.
- A worker resolves tenants through a static map while a sibling (api worker, sequencer DO) resolves
  a wider set (claimed pool tenants).
- Writing a recovery sweep or cron fan-out — ask: does its enumeration cover every tenant whose work
  can reach this worker?
- NOT for genuinely unparseable bodies: no shape ⇒ no tenant ⇒ nothing to recover for ⇒ ack + log.

## The RED this closes (real defect, 2026-08-01 audit C3)
`workers/agents/src` resolved tenants through a static two-slug map and its consumer ACKed any
trigger naming an unknown tenant — "ack as poison: redelivery cannot fix it" — while the api worker
and sequencer DO fully serve CLAIMED POOL tenants. So a pool tenant's committed `pod.signed`
enqueued a Biller trigger this worker destroyed: no invoice, no DLQ record, one log line. The
rationalization in the comment ("the DLQ + exceptions surface land WP-11") had EXPIRED — WP-11 had
closed and `dead_letter_queue = "shuddl-agent-dlq-*"` was declared in every env — and the recovery
paths for exactly this loss (the REQ-169 recon sweep, the Watchtower unbilled alarm) iterate only
the same static `TENANT_SLUGS`, so they excluded the same tenants. Fail-SILENT, not fail-closed:
the append succeeds, the money projection never happens, nothing alarms.

## The pattern
```ts
const parsed = AgentTrigger.safeParse(message.body);
if (!parsed.success) { console.error(`unparseable ${message.id} — ack as poison`); message.ack(); continue; }
let db: D1Database;
try {
  db = tenantDb(env, trigger.tenant);
} catch (err) {
  // NOT poison: "unknown" may mean "not yet rostered HERE". Retry toward the DLQ (max_retries then
  // dead_letter_queue) so the trigger survives as a recoverable record.
  console.error(`message ${message.id} names a tenant outside this worker's static roster — retrying toward the DLQ:`, err);
  message.retry();
  continue;
}
```

## The checklist this forces
1. Ack only what redelivery provably cannot fix (shape, not membership).
2. A declared DLQ that no branch can reach is a lie in the config — route the unroutable to it.
3. Any claim "the sweep recovers it" must state its roster: a sweep enumerating `TENANT_SLUGS`
   recovers static-roster tenants ONLY, and its log line should say so.
4. Before widening who can PRODUCE work (a provisioning flip, a new tenant class), grep every
   consumer + cron for static rosters — the gap is a ledgered, grade-blocking row until closed.

## Red flags
- `message.ack()` inside a `catch`.
- A comment justifying an ack with a future deliverable ("until WP-N lands") — check whether it landed.
- max_retries + dead_letter_queue configured, zero call sites that retry().
- A recovery sweep whose tenant list is a compile-time constant.
