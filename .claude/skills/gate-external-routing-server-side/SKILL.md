---
name: gate-external-routing-server-side
description: Use when the Scheduler/Dispatcher or any agent considers an external travel-time, ETA, isochrone, or route-optimization API (Mapbox Matrix/Directions/Optimization/Isochrone, or a self-hosted OSRM/Valhalla) for appointment feasibility, ETA enrichment, stop sequencing, or catchment. Trigger on WP-08 appointment feasibility, ETA/transit enrichment, dispatch sequencing, or any call that turns coordinates into minutes.
---

> **Grounding note (added 2026-08-01, on commit — 16 days after writing):** the examples and
> `path:line` citations in this skill are observations FROZEN as-of its writing (2026-07-15/16).
> Several RED examples have since been FIXED in live code — verify against HEAD before treating any
> cited defect as current. The LAW each skill states is current; the citations are its provenance,
> not its proof. Enrolled in the citation ratchet as a dated record (the 2026-07-15 audit precedent).

# Gate External Routing Server-Side

## Overview
An external routing estimate is **operational hint, never truth.** It may inform a suggestion or a feasibility flag, but it can never become a sold window, a gate fact, a price input, sit on the offline driver path, or lock SHUDDL to a vendor. Wrap it behind an OSRM-shaped interface, call it only server-side inside `packages/agents/*`, and let the ledger stay the source of truth.

## When to Use
- WP-08 asks "can this appointment be met?" → travel-time between two facilities (Matrix `/table`).
- Enriching a live ETA on Command for an in-progress leg (Directions `driving-traffic`).
- Dispatcher sequencing multiple stops (Optimization) — **REQ-029 vNEXT, suggestion-only.**
- Catchment / "what's within 45 min of this dock" (Isochrone).

**Do NOT use when:** you need the *sold* transit window — that is the config-driven `transit_matrix` / `resolveTransitDays` (REQ-059), never a live API call. And never on the driver PWA path (REQ-061 airplane-mode soak).

## The Core Pattern

**1. Never let an estimate become the sold window.** The honest quote window is already a deterministic config lookup, not a routing call — `resolveTransitDays` uses the *same* `matchZone` longest-prefix resolver a price uses (`packages/rater/src/engine.ts:20`), and returns UNKNOWN rather than a guess when a lane is unresolvable. An external ETA may sharpen an *operational* display; it must never overwrite that committed window (REQ-059).

**2. Wrap every call behind an OSRM-shaped port.** One interface, three adapters, so a Valhalla/OSRM self-host is drop-in and there is no vendor lock-in. See `reference/travel-matrix.ts`. This mirrors how SHUDDL already isolates side-effecting truth behind ports (the Concierge resolves parties through `port.createParty`/`port.createShipment`, `packages/agents/src/concierge/resolve.ts:159-176`) — the agent logic never names the vendor.

**3. It is a feasibility flag, never a gate or price fact.** Gates are pure and take **server-sourced** context only (`packages/ledger/src/gates/transition-gates.ts:4-8` — "no D1, no R2, no Date, no random, no LLM"). An external minutes-estimate is none of those; it must never enter `#enforceTransitionGate`. Feasibility ("this appointment is reachable") is advisory UI on the board, not the `appointment.set` capacity gate (which is D1 slot occupancy + the partial-UNIQUE index, per the WP-08 plan Decision 1).

**4. Optimization output is a proposal a human accepts.** REQ-029 is "Dispatcher copilot suggestion-only v1 — Board approves required for any change" (`genesis/09-REQUIREMENTS-REGISTER.csv:30`, vNEXT). A route plan is rendered for approval; on accept it becomes an append-only event through the sequencer — never an auto-mutation.

**5. Only coordinates leave the tenant.** Send lon/lat, never a party/consignee name — keeps the REQ-167 identity-leak lint clean.

## Quick Reference

| Need | Source | Rule |
|---|---|---|
| Sold transit window | `resolveTransitDays` config (REQ-059) | Deterministic; UNKNOWN not a guess. Never a live API |
| Appointment feasibility | Matrix `/table` via port | Advisory flag; never the capacity gate |
| Live ETA (in-progress leg) | Directions `driving-traffic` | Server-side, Command only; off the driver PWA |
| Stop sequencing | Optimization (REQ-029, vNEXT) | Suggestion → board approves → append-only event |
| Catchment | Isochrone → **self-host Valhalla** | Mapbox display-ToS forbids non-Mapbox renderers; advisory, never a price |

Mapbox Matrix returns durations/distances only (no geometry), server-side HTTP GET, ≤25 coords/60rpm standard, ≤10 coords/30rpm for `driving-traffic` ([docs.mapbox.com/api/navigation/matrix](https://docs.mapbox.com/api/navigation/matrix/)). Directions adds geometry + `driving-traffic` congestion ([docs.mapbox.com/api/navigation/directions](https://docs.mapbox.com/api/navigation/directions/)).

## Common Mistakes

- **Calling a routing API for the quoted window.** The committed window is config (`transit_matrix`, REQ-059). A live ETA drifts and would make the sold number non-deterministic and non-reproducible. Fix: honest window = `resolveTransitDays`; routing only decorates operational views.
- **Putting the ETA on the driver PWA.** REQ-061 requires the full stop cycle to complete in airplane mode. A network routing call breaks the soak. Fix: driver sees the last cached value or the static REQ-059 standard; live driving-traffic is a Command-side (online) enrichment only.
- **Feeding minutes into a gate.** Gates must be pure over server-sourced ledger/D1 facts (`transition-gates.ts:4-8`). A vendor estimate is nondeterministic I/O. Fix: keep feasibility advisory; the `appointment.set` gate stays D1 occupancy + UNIQUE index.
- **Auto-applying an optimized plan.** Violates REQ-029 board-approves. Fix: emit a suggestion; the accepted plan is a new append-only event.
- **Rendering Mapbox isochrones on the MapLibre+Protomaps map.** Breaches Mapbox display ToS and the offline-capable renderer law. Fix: self-host Valhalla isochrones; treat output as advisory, never a price input.
- **Adopting a routing call with no REQ row.** Scope law: add a register row first (REQ-028/029/059 are the anchors), then wrap it behind the port.
