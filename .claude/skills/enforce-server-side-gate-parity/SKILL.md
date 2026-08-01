---
name: enforce-server-side-gate-parity
description: Use when adding or reviewing any API route or DO path that persists a physical fact (raw GPS/positions, stop.arrived/departed, delivery/POD, custody, appointment, consent-gated location), when a route bypasses the sequencer, or when wiring driver/device authorization. Trigger on REQ-030, REQ-166, GATED_KINDS, or any client-supplied shipment_id/device_id write.
---

> **Grounding note (added 2026-08-01, on commit — 16 days after writing):** the examples and
> `path:line` citations in this skill are observations FROZEN as-of its writing (2026-07-15/16).
> Several RED examples have since been FIXED in live code — verify against HEAD before treating any
> cited defect as current. The LAW each skill states is current; the citations are its provenance,
> not its proof. Enrolled in the citation ratchet as a dated record (the 2026-07-15 audit precedent).

# Enforce Server-Side Gate Parity

## Overview
The API path is the real perimeter, not the UI. Every API-reachable write of a gated physical fact MUST enforce the SAME server-side predicate the sequencer DO would have (REQ-030). A route that "bypasses the sequencer" does not bypass the gates — it must re-implement every one of them.

REQUIRED BACKGROUND: `cloudflare:workers-best-practices` (generic auth). This skill adds SHUDDL's Gatekeeper, GATED_KINDS, consent-before-GPS, and the bypass-must-re-gate rule that generic auth knows nothing about.

## When to Use
- Adding/reviewing a route or DO method that persists positions, stop/arrival/POD/custody, an appointment, or any consent-gated location fact.
- A route is a **sanctioned sequencer bypass** (e.g. the positions partition) — it skips `seq`/hash-chain but NOT the gates.
- Wiring driver/device authorization, or any handler that binds a **client-supplied** `shipment_id`/`device_id` into a write.
- NOT for pure reads (lens scoping owns those) or server-internal seams (Biller/Rater call `SHIPMENT_SEQ.append` directly and re-traverse the DO gates).

## The RED this closes
`workers/api/src/routes/positions.ts:15-60` — the raw-GPS write does role-check + `PositionInput` parse + `INSERT OR IGNORE`, with **NO consent lookup and NO `deriveOperatingState`**. But `sequencer.ts:434-441` gates `stop.arrived` through `assertConsentBeforeGps`, and `sequencer.ts:92-93` explicitly names this route as the consent owner: *"position.updated ... owned by the positions bypass route, which must enforce the same consent gate."* The bypass shipped the fast path and dropped the gate (REQ-166 CRITICAL bypass).

Same file binds client `p.shipment_id`/`p.device_id` (position.ts:13-14) with **no assignment and no device-ownership check** — whereas `events.ts:167-173` 403s an unassigned driver and `sequencer.ts:237-256` requires the device co-signature to verify before a device may claim a slot. A driver can post GPS for a shipment they aren't on, under any `device_id`.

## The pattern: one shared predicate, invoked by BOTH paths
Factor `consentFor`, `assignmentOf`, `deviceOwnedBy` into one module (see `reference-predicates.ts`) so the route and the DO cannot drift. The bypass route re-enforces before its INSERT:

```ts
// positions.ts — BEFORE the INSERT OR IGNORE
const session = c.get("session");
// 1. driver-assignment (mirror events.ts:167-173)
if (session.role === "driver" && !(await assignmentOf(db, p.shipment_id, session.sub)))
  throw new ApiError("FORBIDDEN", 403, "DRIVER NOT ASSIGNED TO THIS SHIPMENT");
// 2. device ownership (mirror sequencer.ts:518-532 #deviceKey; client device_id is untrusted)
if (!(await deviceOwnedBy(c.env, session.tenant, p.device_id, session.sub)))
  throw new ApiError("FORBIDDEN", 403, "DEVICE NOT REGISTERED TO THIS DRIVER");
// 3. consent-before-GPS (mirror sequencer.ts:441 — derive state server-side, never from client)
const state = deriveOperatingState({ lat_e6: p.lat_e6, lon_e6: p.lon_e6 });
assertConsentBeforeGps(await streamPrior(db, p.shipment_id), asPositionStamp(p), { operating_state: state });
```

`deriveOperatingState` runs on the SERVER over the stamp's own coords — the client supplies geo, the server decides the jurisdiction (sequencer.ts:435-441). Consent gates the **raw positions partition**, not only `stop.arrived`.

## Quick Reference
| Gated write | DO enforces at | Bypass route must call |
|---|---|---|
| raw GPS / positions | route owns it (never hits DO) | `assignmentOf` + `deviceOwnedBy` + `assertConsentBeforeGps` |
| stop.arrived / departed | `sequencer.ts:409-442` | n/a — goes through DO |
| device-namespaced event | `sequencer.ts:237-256` (sig verify) | `deviceOwnedBy` before slot claim |
| driver write to shipment | route, `events.ts:167-173` | `assignmentOf(db, shipmentId, session.sub)` |
| server-emitted money kind | refused pre-append `events.ts:144-146` | reject at every client entry |

## Common Mistakes
- **"The PWA already checks consent / assignment."** A UI-only gate is not a gate (REQ-030). The API path is reachable directly.
- **Trusting client `shipment_id`/`device_id`.** Both are attacker-controlled until checked against assignment + device registration. `PositionInput` (position.ts:11-21) validates shape, not authority.
- **Gating only `stop.arrived` for consent.** The raw positions partition is a first GPS stamp too; gate it (REQ-166).
- **Deriving operating state from a client field.** Derive server-side from the stamp coords (sequencer.ts:441), else the state is a spoofable claim.
- **Adding a bypass route silently.** Register it in the bypass registry so the gate-parity lint (see `reference-gate-parity-lint.md`) covers it; an unregistered write path is an untested bypass.
- **Fail-open on a missing fence/state.** Mirror the DO: unknown jurisdiction blocks (sequencer/transition-gates fail-closed), never passes.
