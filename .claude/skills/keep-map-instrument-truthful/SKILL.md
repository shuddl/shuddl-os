---
name: keep-map-instrument-truthful
description: Use when editing packages/map/src/entities.ts or MapCanvas.tsx, adding an entity kind that can hold an exception, animating pulse/glide/heading, or when a symbol layer's paint differs from a sibling circle layer. Trigger on world-dim, exception pulse, heading chevron, or feature-state paint work. Symptoms - an exception dims the world but a mark never throbs; a parked truck points due-north; NE headings look off; a status change forces a full setData.
---

> **Grounding note (added 2026-08-01, on commit — 16 days after writing):** the examples and
> `path:line` citations in this skill are observations FROZEN as-of its writing (2026-07-15/16).
> Several RED examples have since been FIXED in live code — verify against HEAD before treating any
> cited defect as current. The LAW each skill states is current; the citations are its provenance,
> not its proof. Enrolled in the citation ratchet as a dated record (the 2026-07-15 audit precedent).

# Keep the Map Instrument Truthful

## Overview
The greige map is an instrument, not decoration. Quiet greige = nominal; coral at 100% opacity + the world dimming to 35% = exception (`genesis/07-DESIGN-SYSTEM.md:47`, acceptance demo #5). Every alarm the ledger records must render identically on the map, and every rendered heading must equal the ledger heading. Two failure classes recur: **dimmed-but-silent** exceptions and **glide-artifact headings**.

## When to Use
- Editing `packages/map/src/entities.ts` (layers/mutators) or `MapCanvas.tsx` (animation loop).
- Adding an `EntityKind` (`entities.ts:14`) or a new layer that can carry a `statusStr === "exception"`.
- Touching `applyPulse`, `animateToward`, `bearingTo`, `setWorldDim`, or any `setFeatureState`/`setPaintProperty` call.
- **NOT for** basemap/greige-token styling or generic MapLibre cartography — see `terminal-gallery-map-ui` and `mapbox:mapbox-cartography`.

## The core principle: alarm-parity across layer types
`applyPulse` (`MapCanvas.tsx:123-139`) throbs only `rest` and `clusters` **circle**-stroke on the 1.6s urgent sine. The `trucks` **symbol** layer's `icon-opacity` is written a *static* `keepLeaf` case in `setWorldDim` (`entities.ts:181`) and its `icon-size`/`icon-opacity` are never animated (`entities.ts:110-123`). Result: a moving truck holding an exception gets the world-dim exemption but **never throbs** — the coral chevron the eye tracks sits dead still while the world goes quiet. ~half of exceptions (the ones on trucks) dim-but-silent. Demo #5 half-fails.

Rule: **no exception kind may be dimmed-but-silent.** Because `feature-state` is paint-only and cannot drive a symbol's `icon-size` per-frame cheaply, the robust fix is a **kind-independent exception halo**: one `circle` layer drawn *under* every mark (trucks, at_rest, facility, delivered), filtered to the exception state, whose radius/stroke rides the same `urgent` sine in `applyPulse`. The halo throbs regardless of whether the mark above it is a circle or a symbol — parity is structural, not per-layer. See `reference/exception-halo-parity.md`.

## The core invariant: rendered bearing == ledger heading
`animateToward` (`MapCanvas.tsx:89-98`) overwrites `f.properties.bearing = bearingTo(lng, lat, t[0], t[1])` every frame. For a **static** entity, current==target, so `bearingTo` computes `atan2(0,0) === 0` → the chevron snaps **due north**, clobbering the real ledger heading. A parked truck lies about where it faces.

Rule: **never derive heading from a zero glide delta.** If `|target - current| ~ 0` (below an epsilon), leave `bearing` untouched — the ledger `bearing` property is truth. Only overwrite when the mark actually moved this frame.

Second bug, same function: `bearingTo` (`MapCanvas.tsx:49`) is `atan2(Δlng, Δlat)` with **no cos(lat)** correction. A degree of longitude is narrower than a degree of latitude, so the longitudinal term is overstated and the heading skews toward east as latitude rises — a true 45° NE course at 60°N renders ~63°. Apply `atan2(Δlng * cos(lat·π/180), Δlat)` (or great-circle). Vectors in `reference/geodesic-bearing-vectors.md`.

## Paint, not DOM; O(changed), not O(all)
World-dim is `setPaintProperty` on the existing layers (`entities.ts:171-185`), never a DOM veil over the canvas. A single status change is `setEntityState` → `setFeatureState` (`entities.ts:164`), O(1), no geometry re-parse — never a full `setData`. `setData` is only for position/property flushes on the throttled loop. Clusters have **no feature-state**, so their alarm reads the aggregated `maxStatus` property (`entities.ts:49,179`); leaves read `["coalesce", ["feature-state","status"], ["get","statusStr"], "healthy"]` so paint is correct whether or not state was applied yet.

## Quick reference
| Concern | Right way | Wrong way (seen in repo) |
|---|---|---|
| Exception throb | pulse a kind-independent halo under every mark | pulse only `rest`+`clusters` circle-stroke — trucks stay silent (`MapCanvas.tsx:125,134`) |
| Static heading | keep ledger `bearing` when delta≈0 | overwrite from zero delta → due-north (`MapCanvas.tsx:96-97`) |
| Bearing math | `atan2(Δlng·cos(lat), Δlat)` | `atan2(Δlng, Δlat)` — skews east at high lat (`MapCanvas.tsx:49`) |
| Status change | `setFeatureState` (paint-only) | full `setData` re-render |
| Symbol orientation/chip | mirror to `bearing`/`chip` **property** | try `feature-state` in `layout` — impossible, it's paint-only |
| World-dim | `setPaintProperty` opacity | DOM veil over the map |

## Common mistakes
1. **Adding an entity kind and only wiring its circle.** If it can hold an exception it must throb. Route every kind through the shared halo, not a per-kind pulse.
2. **Assuming feature-state can drive a symbol's icon.** MapLibre: feature-state "can only be used with paint properties that support data-driven styling" — not `layout`, not `filter` (maplibre.org/maplibre-style-spec/expressions). That is *why* `bearing` and `chip` are mirrored to properties; keep it that way.
3. **Recomputing bearing on every glide frame.** The glide is a render smoothing; the heading is ledger truth. Decouple them.
4. **Reaching for setData on a status tick.** That drops feature-state and re-parses geometry. Use `setEntityState`; the throttled loop flushes property mirrors.
5. **Forgetting clusters have no feature-state.** A cluster's alarm must go through `clusterProperties.maxStatus`, gated `["==",["get","maxStatus"],2]`.

REQUIRED BACKGROUND: `terminal-gallery-map-ui` (layer grammar). Design law: `genesis/07-DESIGN-SYSTEM.md:47,79` (pulse = 1.6s opacity sine, world→35%), REQ-077/078.
