---
name: preserve-canonical-hash-byte-law
description: Use when touching canonical.ts, chain.hashView, sign.clientView, lens.rowToEvent, or canonicalPositionBytes, when reading events back from D1, or when tempted to 'improve' number/key/null handling in a hashed structure. Trigger on any change near event hashing, signing, or chain verification.
---

> **Grounding note (added 2026-08-01, on commit — 16 days after writing):** the examples and
> `path:line` citations in this skill are observations FROZEN as-of its writing (2026-07-15/16).
> Several RED examples have since been FIXED in live code — verify against HEAD before treating any
> cited defect as current. The LAW each skill states is current; the citations are its provenance,
> not its proof. Enrolled in the citation ratchet as a dated record (the 2026-07-15 audit precedent).

# Preserve the Canonical-Hash Byte Law

## Overview
The SHUDDL ledger hashes and signs every event over a **frozen canonical-JSON byte law**. Any byte drift in the serializer — or any place that reconstructs a hashed structure — silently invalidates the entire hash chain. These files are frozen forever; you verify against them, you do not "improve" them.

## When to Use
Read this BEFORE editing any of: `packages/ledger/src/canonical.ts`, `chain.ts` (`hashView`/`hashEvent`), `sign.ts` (`clientView`/`signEvent`), `lens.ts` (`rowToEvent`/`eventToRow`), `anchor.ts` (`canonicalPositionBytes`), or `workers/api/src/routes/positions.ts`. Also when you touch how a number, key order, or SQL NULL flows into anything that gets hashed or signed.

Symptoms this prevents: `roundtrip.test.ts` snapshot diff; `chain.test.ts` `hash_mismatch`; every event read from D1 failing verification; a device signature that won't verify server-side.

NOT for: gate business logic that never feeds a hash, or projections that don't rehydrate the envelope.

## The frozen byte law (`canonical.ts:21-47`)
JCS (RFC 8785) restricted to **integer-only numbers**. Five rules, all load-bearing:
1. **Numbers**: only `Number.isSafeInteger`; `-0`, floats, and non-safe integers **throw** (`canonical.ts:25`). Money = signed cents, geo = `lat_e6`/`lon_e6` microdegrees, confidence = basis points, time = integer epoch-ms.
2. **Keys sorted** by UTF-16 code unit, no whitespace (`canonical.ts:41-44`).
3. **`undefined` members OMITTED** (`.filter(([, val]) => val !== undefined)`), but **`null` is EMITTED** as `null` (`canonical.ts:22`). This asymmetry is the whole game — see below.
4. **Strings**: escape only `"`, `\`, control chars; Unicode emitted literally (NO NFC — composed vs decomposed hash differently); lone surrogates throw (`canonical.ts:10`).
5. **Sparse-array holes throw** — index-iterate, never `.map` (`canonical.ts:34-36`).

`sha256(canonical({}))` = `44136fa3...aff8a`, pinned by `test/__snapshots__/roundtrip.test.ts.snap`. Any diff to that snapshot is a chain-format break = Critical.

## The load-bearing example: SQL NULL → OMITTED key, never `null`
This is the subtlety that breaks everything if you get it wrong. When an event is read back from D1, `rowToEvent` must map a SQL `NULL` column to an **absent key**, not a literal `null`:

```ts
// packages/ledger/src/lens.ts:267-271@shipment_id — present only when non-NULL
// (this fence read `:188-193` until 2026-08-04, audit §195: that range is the COMMENT stating the rule,
//  not the code implementing it — the guards live inside rowToEvent)
if (r.shipment_id !== null) e.shipment_id = r.shipment_id;
if (r.sig !== null)         e.sig = r.sig;
if (r.device_id !== null)   e.device_id = r.device_id;
if (r.device_seq !== null)  e.device_seq = r.device_seq;
if (r.captured_ts !== null) e.captured_ts = r.captured_ts;
```

Why: the canonicalizer OMITS `undefined` but EMITS `null`. If you "simplify" this to `e.shipment_id = r.shipment_id` (which yields `null` for a NULL column), the canonical form gains `"shipment_id":null`, the recomputed hash drifts, and **every event fails chain verification** (`hashEvent(rowToEvent(row)) !== row.hash`). The override column takes the same care: `r.override_json ?? null` collapses both SQL NULL and a missing pre-migration column to an omitted key, keeping a non-override event byte-identical to an old row that never had the column (`lens.ts:194-199`). `eventToRow` is the exact inverse (`?? null`), so the round-trip reproduces the stored row.

## Position leaf bytes must stay byte-identical in two places
`canonicalPositionBytes` (`anchor.ts:80-91`) IS the Merkle leaf for a position, and it MUST produce the same bytes the `/v1/positions` ingest route hashed as the row's integrity anchor (`workers/api/src/routes/positions.ts:24-33`). Both build `{shipment_id, device_id, ts, lat_e6, lon_e6}` and conditionally add `accuracy_m`/`speed_cms` only when present — the ingest uses `!== undefined`, the anchor uses `!== null`, converging on the same omit-when-absent rule. Change one side and the daily anchor stops matching what was ingested. The comment at `anchor.ts:77-79` says "Keep in lockstep" — obey it.

## The two views, and the two RPC error envelopes
- **`hashView`** (`chain.ts:9-14`) = the full envelope minus `sig` and minus the stored `hash`. Everything else (`prev_hash`, `seq`, `id`, `ts`, `recorded_at`) is covered, so tampering anywhere breaks the next link.
- **`clientView`** (`sign.ts:7-16`) = the smaller field set a device knows OFFLINE: `{id, shipment_id, kind, payload, evidence, actor, ts, device_id, device_seq, captured_ts}` — notably NOT `source`, `confidence`, or `party_refs`. The device signature does not bind those (a bounded WP-02 audit Major; they are hash/anchor-locked post-append and visibility is server-set).
- Gate refusals cross a Durable Object → Workers RPC hop that preserves ONLY `Error.name` + `Error.message`. So the machine-readable detail is encoded INTO the message as `CODE:{json}`: `GATE_BLOCKED:{"required_evidence":[...]}` (`packages/ledger/src/gates/invoice-gate.ts:16@GATE_BLOCKED_PREFIX`) and `VALIDATION_FAILED:{"reason":...}` (`packages/ledger/src/gates/transition-gates.ts:74@VALIDATION_FAILED`). Both codes are in `packages/contracts/src/errors.ts` (`ErrorCode` enum, with `GATE_BLOCKED_PREFIX`/`VALIDATION_FAILED_PREFIX` derived from it). Do not "clean up" these strings into structured throws — the structure would not survive the hop.

## Why gates are PURE (and thus exhaustively testable)
Transition gates are pure deterministic decisions over `(prior events, incoming event, context)` — **no D1, no R2, no Date, no random, no LLM** (`gates/transition-gates.ts:4-8`, REQ-024). The impure inputs (prior stream, clock) are supplied by the caller (the sequencer loads `prior` from D1 before calling). Keep them pure: it is what makes the whole gate catalog unit-testable without a database.

## Quick Reference
| Element | Rule | Cite |
|---|---|---|
| Numbers | integer-only; `-0`/float/unsafe throw | `canonical.ts:25` |
| Keys | sorted, no whitespace | `canonical.ts:41-44` |
| `undefined` | OMITTED | `canonical.ts:42` |
| `null` | EMITTED as `null` | `canonical.ts:22` |
| SQL NULL read-back | → omitted key, never `null` | `packages/ledger/src/lens.ts:197@undefined` (rule) · `:245@shipment_id` (impl) |
| Position leaf | byte-identical ingest ↔ anchor | `packages/ledger/src/anchor.ts:88@canonicalPositionBytes` |
| hashView | envelope − `sig` − `hash` | `chain.ts:9` |
| clientView | offline field set (no source/confidence/party_refs) | `sign.ts:7` |
| Gate errors | `CODE:{json}` in Error.message | `packages/ledger/src/gates/invoice-gate.ts:16@GATE_BLOCKED_PREFIX` |
| Gate purity | no D1/Date/random/LLM | `transition-gates.ts:4` |

## Common Mistakes
- **Assigning a nullable column directly** (`e.shipment_id = r.shipment_id`) → injects `null`, chain fails. Fix: guard with `if (r.x !== null)`.
- **"Optimizing" the serializer** — using `JSON.stringify`, `.map` over arrays, Number formatting, or NFC-normalizing strings. Fix: don't. It is frozen; the snapshot is the law.
- **Adding a field to `clientView` or `hashView`** without regenerating the snapshot and understanding you just re-versioned the signature/chain format.
- **Editing `canonicalPositionBytes` OR the positions route alone.** Fix: change both, keep bytes identical.
- **Refactoring gate errors into structured objects** — they vanish across the DO→Workers RPC hop. Fix: keep `CODE:{json}` in the message.

## The test that proves you didn't break it
```
pnpm --filter @shuddl/ledger test canonical.test.ts roundtrip.test.ts chain.test.ts lens.test.ts sign.test.ts anchor.test.ts
```
Green snapshot + `hashEvent(rowToEvent(row)) === row.hash` across all 35 kinds against real D1 = the byte law held. A red `roundtrip` snapshot diff is not a snapshot to update — it is a Critical you introduced.

REQUIRED BACKGROUND: cloudflare:durable-objects (DO mechanics; the mutex is load-bearing across D1 awaits, but that is a separate contract from this serialization law).

Sources: `genesis/10-EVENT-TAXONOMY-DATA-MODEL.md:11` (envelope shape, Merkle root); MEMORY `canonical-json-hash-fidelity.md` (the frozen law + NULL→undefined rule).
