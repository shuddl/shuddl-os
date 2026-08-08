---
name: terminal-gallery-map-ui
description: Use when building the SHUDDL map surface — the operational infinite-canvas map that is the shared system of reference across Command, the Driver PWA, and the Client Portal, rendering ~1,000 live moving shipments at once with healthy / at-risk / exception state, or a marketing/promo page in the same greige-and-one-red "Terminal Gallery" aesthetic. Covers Mapbox GL JS / MapLibre GL JS at operational scale and the design law that keeps it cohesive.
---

> **Grounding note (added 2026-08-07, audit §639):** this skill's examples describe observations FROZEN
> as-of its writing. Unlike its siblings it cites no `path:line`, so nothing mechanical can tell you when
> its claims go stale — which makes this warning MORE load-bearing here, not less. The LAW it states is
> current; the examples are provenance, not proof. Verify against HEAD before treating any described
> defect as live.

# Terminal Gallery Map UI

## What this actually is (read this first)

The map is **not a decorative backdrop**. It is the **operational system of reference** — the single visual source of truth that Command, the Driver PWA, and the Client Portal all render, scoped by lens. One infinite, pannable/zoomable canvas showing **all ~1,000 moving shipments at once** (REQ-079: 60fps desktop / 30fps mid-phone), each truck tied to its driver and its shipment, updating live as ledger events land. Locations, trucks, drivers, and shipments are one connected graph drawn on this canvas. When something is wrong it is **obnoxiously loud and unmissable**; when something is *trending* wrong it carries a **visual early warning**. The whole thing is cohesive across all three surfaces because they share one entity contract, one style, and one state grammar.

A pretty landing-page hero is a *different, smaller* job (the "Promo mode" section at the end). Do not confuse them: the operational canvas is GL layers at scale; the promo is a self-contained backdrop. **Default to operational unless the task is explicitly a marketing page.**

## The one rule that makes scale possible: LAYERS, NOT MARKERS

Mapbox/MapLibre `Marker` objects are HTML elements. **Hundreds of them make the browser sluggish; a thousand makes it unresponsive.** The 1,000-shipment requirement is unbuildable with markers. Every entity is a feature in a GL `circle`/`symbol` **layer** rendered on the WebGL canvas, styled by data-driven expressions, with per-entity state applied via **`setFeatureState`** (which updates state without re-parsing geometry). This is not a preference — it is the difference between the product working and not. Full implementation in `operational-map.md`.

Corollaries (from Mapbox's performance guidance):
- **Combine layers.** One `circle` layer + one `symbol` (chevron) layer driven by expressions — not one layer per state. Fewer layers = faster render.
- **A separate GeoJSON source for the things that move.** Live positions live in their own small source you `setData()` each animation frame (or each event batch); heavy static geometry lives in other sources so a position tick doesn't reprocess everything.
- **Cluster when zoomed out.** `cluster: true` collapses 1,000 points into counts at low zoom; `getClusterExpansionZoom` zooms into a cluster on click. The fleet reads as calm density from orbit and resolves to individual trucks as you descend.
- **Drive size/opacity by `["zoom"]`** with `interpolate` so marks stay legible across the whole zoom range.

## The three-tier state grammar (this is the heart of the ask)

State is carried by **geometry + opacity + motion + a mono chip — never by adding a color** (doc 07 A4). Applied per-feature with `setFeatureState({source, id}, {status, risk})` and read in paint via `["coalesce", ["feature-state", "status"], "healthy"]`.

| Tier | What it means | Visual grammar (all within the 5 tokens) |
|---|---|---|
| **healthy** | on plan | solid `--signal` chevron/square, full opacity, mono dwell/ETA label. Calm. |
| **at-risk** | *may* indicate future trouble — dwell creeping, ETA slipping, detention/appointment/credit risk, driver-hours tight | the mark gains a **slow-breathing outline ring** (a calmer ~3s pulse, distinct from the exception's urgent 1.6s) **plus a mono chip naming the risk** (`DWELL 4:12`, `ETA +38m`, `DETENTION RISK`, `HOS 0:45`). Predictive, not yet an alarm. This is the "visual warning for all items that may indicate future trouble." |
| **exception** | wrong now | **obnoxiously loud:** the offending mark pulses `--signal` @100% on the 1.6s sine, enlarged, **while the entire rest of the world dims to ≤35%** (a `--field` veil above the basemap + all non-exception entities, below the pulsing mark). Optionally a `--signal` viewport-edge flash and a klaxon mono chip (`EXCEPTION · OS&D`). |

**Reconciling "obnoxiously loud color" with the five-token law:** the loudness comes from **contrast, not a new hue.** In a world dimmed to 35%, one full-100% screaming-red pulsing mark is the *only lit thing* — that is louder and more unmissable than adding a sixth alarm color would be, and it stays cohesive (doc 07 A4: "the alarm is the world going quiet"). Crank it as hard as needed within the palette: dim harder (to 20%), enlarge the mark, flash a `--signal` viewport vignette, invert that region to `--ink-dark` ground momentarily (the driver-A2 inversion) with the mark in `--signal`. **If the owner truly wants a literal sixth alarm hue, that is a doc-07 / register amendment (REQ-076/078/145) — name it and get it ratified; do not smuggle a new color past the squint-test color audit.**

## Cohesion across the three surfaces — one canvas, scoped

Same GeoJSON entity contract, same custom style, same grammar everywhere. Only the *data scope* and *ground* change:
- **Command** — whole fleet + all shipments; greige ground; the fleet at 1,000-scale is the point.
- **Driver PWA** — only this driver's assigned stops/legs; **`--ink-dark` ground (Amendment A2)** for dock/sunlight legibility; everything else identical.
- **Client Portal / status** — only this party's shipments; positions **generalized to ~city granularity until out-for-delivery** (geo-privacy, REQ-074 / lens redaction) — the map data is scoped server-side, never a filtered screenshot of someone else's world.

The entity contract each surface consumes (keep it stable so all three stay coherent):
`{ id, lng, lat, bearing, kind: "truck|at_rest|facility|delivered", status: "healthy|at-risk|exception", risk?: "DWELL|ETA|DETENTION|HOS|CREDIT", label, shipment_id, party_refs[] }`

## The custom basemap is 80% of the look

Never a default street/dark style — that reads instantly generic. Build the greige style from scratch: land `--field`; water `--ink-dark`@6%; roads `--signal`@5–8% (majors stronger, so it reads as faint red circuitry etched on concrete); place labels micro-mono uppercase `rgba(255,74,51,.55)`, thinned to state+city; **no terrain, satellite, POI, buildings, or landuse color.** Squint test: a warm field with faint red veins. Ready style (Mapbox **and** MapLibre, shared spec) in `greige-style.json`.

**Mapbox vs MapLibre — decide by surface:**
- **Shipped product** → MapLibre GL JS + self-hosted Protomaps/OpenFreeMap vectors. REQ-075 forbids third-party branding and requires offline cache (the Driver PWA must load its map in airplane mode). Do **not** ship Mapbox-hosted tiles in the product.
- **Marketing / prototype** → Mapbox GL JS is fine and fast; use a custom (never default) style. MapLibre is a drop-in fork — the same `greige-style.json`, entity layers, `setFeatureState`, and cluster code port with only the token/tile-source swap. (One API note: Mapbox GL v3 introduced `map.addInteraction(...)`; on MapLibre and older Mapbox, use `map.on('click', layerId, handler)`. `operational-map.md` uses the portable `map.on` form.)

## The law (doc 07; the squint-test CI enforces it)

| Rule | Value |
|---|---|
| Colors | EXACTLY 5: `--field #D5D1CC` · `--signal #FF4A33` · `--signal-deep #A52F18` (≤14px text on field, locked ≥4.5:1) · `--ink-dark #1A1A1A` · `--progress #00C4B4`. Transparent reds (`rgba(255,74,51,…)`) do all secondary/gray work. **No gray, no blue, no green/yellow — ever.** Define the 5 hexes once in `:root`, reference via `var()`/`rgba()` — never scatter raw hex (the audit greps `#[0-9A-Fa-f]{6}`). Readable secondary/body text on field = `--signal-deep`. |
| Fonts | 2 only: `--display 'Barlow Condensed','Oswald','Arial Narrow','Roboto Condensed',sans-serif` (700, UPPERCASE, LH .88–.95, tracking −0.015em) · `--mono 'JetBrains Mono','IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace` (400, UPPERCASE, 9–14px, tracking .04–.14em). Name the fallbacks. |
| Teal | `--progress` is **progress fills only** (ETA line, upload %, count-up rings). Never text, icons, or state. On the map: exactly one teal moment — the ETA fill on the remaining route. |
| Forbidden | shadows, gradients, border-radius >4px, springs, parallax, *decorative* rotation (chevron orient-to-heading is a required entity semantic, not this), particles, shimmer/skeleton loaders, hover-lift, emoji, stock art, icon libraries on the map. |
| Motion | reveals (fade-up 20–30px, `cubic-bezier(.16,1,.3,1)`, 600–800ms), eased count-ups, hovers ≤150ms. Map marks glide linearly between event positions (duration = real elapsed, capped 800ms); at-risk breathes ~3s; exception pulses 1.6s sine. Sanctioned motion beyond "reveals-only": mark glide, the two pulses, and the ⌘K command-bar typewriter — the product speaking, not decoration. Honor `prefers-reduced-motion`: values appear at final state, trucks sit static mid-route, looping effects (the exception dim) rest calm/undimmed. |

## Entity marks (doc 07 §02 — the only saturated marks on screen)

Moving truck = solid `--signal` chevron oriented to heading (`icon-rotate: ["get","bearing"]`, `icon-rotation-alignment:"map"`) + a 600ms fading trail; at rest = solid `--signal` square + mono dwell label; facility = `--signal` outlined square + parenthetical `(01)`; delivered <24h = hollow `--signal`@55%, fades out; at-risk/exception per the grammar above. Click a mark → a right-side `--ink-dark` lens panel; **the map never navigates away — it IS the home** (REQ-080).

## Common mistakes

- **DOM markers for entities.** The single biggest failure — dies at scale. GL layers + feature-state, always.
- Default Mapbox Streets/Standard/Dark style. Custom greige style, always.
- One layer per state, or a `setData` of the whole fleet on every tick. Combine layers; separate the moving source; use `setFeatureState` for state.
- Reaching for a second accent color (blue links, green "ok", yellow "warn", a red alarm hue). Status is geometry + motion + a mono chip. Loudness is contrast, not a new color.
- Drop shadows / rounded cards / gradients for hierarchy → the 1px `--signal-12` divider and whitespace do that.
- Building the operational canvas as a self-contained SVG (that's promo-only — it can't scale or update live) or building the promo with external tile CDNs (that can't ship as a claude.ai Artifact — see Promo mode).

## Promo mode (marketing pages only)

A shareable **claude.ai Artifact** cannot load Mapbox/MapLibre tiles, CDN scripts, or remote fonts — its CSP blocks every external host. So for a promo Artifact the map backdrop must be a **self-contained inline SVG/canvas** "red engraving on greige" (it's a stylized still, not a live map), fonts a condensed system stack, everything inline; and don't put a bare `#`+6-hex in visible copy (the color audit flags it). Use real Mapbox/MapLibre GL only when the page is hosted somewhere without that CSP. **The operational product is the opposite: real GL, real tiles, live data — never the SVG stand-in.**

## Reference

- `operational-map.md` — copy-paste Mapbox/MapLibre GL JS for the 1,000-entity live canvas: sources, the combined layers, the `setFeatureState` state machine, clustering, the animation loop, the exception world-dim. Grounded in current GL JS v3 API.
- `greige-style.json` — the custom basemap style (Mapbox + MapLibre).
- `genesis/07-DESIGN-SYSTEM.md` — the full law + six Operational Amendments. `packages/design/tokens.css` — locked tokens. `tools/design/audit.ts` — the CI that enforces them. REQ-073…080 (map), REQ-145…149 (design) in `genesis/09`.
- Mapbox GL mechanics: companion skills `mapbox-web-integration-patterns`, `mapbox-data-visualization-patterns`, `mapbox-style-patterns`, `mapbox-cartography` — apply this skill's palette/type/state law on top of them.
