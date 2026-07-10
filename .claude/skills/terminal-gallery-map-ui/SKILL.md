---
name: terminal-gallery-map-ui
description: Use when building any SHUDDL surface, landing/marketing page, or demo where a full-viewport live map is the backdrop and the design must be a scroll-stopping feature in itself — Command/Portal/status screens, promo pages, or any greige-and-one-red "Terminal Gallery" interface with Mapbox GL JS or MapLibre GL JS.
---

# Terminal Gallery Map UI

## Overview

The map is not a widget on the page — the page is a thin typographic layer floating over a living map of the tenant's physical world. **The emptiness of the greige map is the gallery wall; the freight is the art.** The design is a load-bearing feature: a Bloomberg-terminal-meets-architecture-monograph look so specific that fidelity to it *is* the distinctiveness. This skill is the craft of building that — reliably, audit-clean, and scroll-stopping — on top of the law in `genesis/07-DESIGN-SYSTEM.md`.

**Core moves that make it stop scroll:** (1) a full-bleed custom-styled map reading as *red engraving on warm concrete*; (2) monumental UPPERCASE condensed display type against micro-mono labels — the scale contrast IS the brand; (3) the live protocol running on the map (trucks glide, a delivered mark flips hollow the instant a POD lands); (4) the **exception dim** — when something breaks, the mark pulses and *the entire world dims to 35%*; the alarm is the room going quiet.

## When to use

- Command / Portal / public status surfaces (the map backdrop is REQ-073).
- A marketing / promo / launch page that must screenshot well ("free marketing").
- Any demo of the freight protocol on a map.

**When NOT to use:** print/PDF artifacts (that's doc 07 Amendment A3), or a surface with no map. The driver PWA inverts to dark ground (A2) but keeps everything else — this skill's type/motion/token rules still apply.

## The law you may not break (from doc 07; the squint-test CI enforces it)

| Rule | Value |
|---|---|
| Colors | EXACTLY 5: `--field #D5D1CC` · `--signal #FF4A33` · `--signal-deep #A52F18` (≤14px text on field, locked ≥4.5:1) · `--ink-dark #1A1A1A` · `--progress #00C4B4`. Transparent reds (`rgba(255,74,51,…)`) do all secondary/gray work. **No gray, no blue, no green/yellow — ever.** Stay audit-clean by construction: define the 5 hexes once in `:root`, reference everything else via `var()` and `rgba(255,74,51,x)` / `rgba(26,26,26,x)` — never scatter a raw `#hex` elsewhere. **Readable secondary/body text on field = `--signal-deep`** (it is the only token that passes AA at small sizes); reserve `rgba(255,74,51,.55)` and lower for atmospheric labels only, not copy someone must read. |
| Fonts | 2 only: `--display 'Barlow Condensed','Oswald'` then the condensed **system fallback** `'Arial Narrow','Roboto Condensed',sans-serif` (700, UPPERCASE, LH .88–.95, tracking −0.015em) · `--mono 'JetBrains Mono','IBM Plex Mono',ui-monospace,'Cascadia Mono',Menlo,Consolas,monospace` (400, UPPERCASE, 9–14px, tracking .04–.14em). Name the fallbacks — "2 families" degrades unpredictably otherwise. |
| Forbidden | shadows, gradients, border-radius >4px, springs, parallax, **decorative** rotation, particles, shimmer/skeleton loaders, hover-lift, emoji, stock art, icons on the map. |
| Status | expressed by **geometry + opacity + motion + mono chips**, never by adding a color. Teal is **progress fills only** (ETA line, upload %, count-up rings) — never text, icons, or state. |
| Motion | reveals (fade-up 20–30px, `cubic-bezier(.16,1,.3,1)`, 600–800ms), eased count-ups, hovers ≤150ms underline/opacity only. Map marks glide linearly; exception pulse is a 1.6s opacity sine. Honor `prefers-reduced-motion`: values appear at their final state, trucks sit static mid-route, the teal ETA shows partially filled, and a **looping** effect (the exception dim) rests in its calm/undimmed state. |

## The map — the custom style is 80% of the look

Never ship a default street style. Build the greige style from scratch: land `--field`; water `--ink-dark` @ 6%; roads `--signal` @ 5–8% opacity (majors slightly stronger, so it reads as faint red circuitry etched on concrete); place labels micro-mono uppercase `rgba(255,74,51,.55)`, thinned to state+city only; **no terrain, no satellite, no POI, no color anywhere.** Squint test: a warm field with faint red veins.

A ready style that works for **both** Mapbox GL JS and MapLibre GL JS (shared style spec) is in `greige-style.json` — set its `sources` to your tile provider and go.

**Mapbox vs MapLibre — decide by surface:**
- **Shipped SHUDDL product** → MapLibre GL JS + self-hosted Protomaps/OpenFreeMap vectors. REQ-075 forbids third-party branding and requires offline cache. Do **not** use Mapbox-hosted tiles in the product.
- **Marketing/promo/prototype** → Mapbox GL JS is fine and fast; use a custom (never default) style. MapLibre is a drop-in fork, so the same `greige-style.json` and entity code port with only the token/tile-source swapped.

**Entities are the only saturated marks** (doc 07 §02): moving truck = solid red chevron **oriented to heading** (this orient-to-heading rotation is a required entity semantic, not the banned decorative rotation) + 600ms fading trail; at rest = solid red square with a mono dwell label; facility = red outlined square + parenthetical `(01)`; delivered <24h = hollow red @55%, fades out; **exception = the offending mark (a solid red square + one concentric outlined ring + an "EXCEPTION" mono chip) pulses @100% on the 1.6s sine while a greige veil dims everything else to 35%**; ETA = thin teal fill on the remaining route line. Click a mark → a right-side `--ink-dark` lens panel; the map never navigates away (REQ-080).

**Teal is literally one moment.** "Progress fills only" permits ETA/upload/rings, but on a promo hero show exactly **one** teal element (a single ETA fill). Restraint reads as confidence; a second teal dilutes the whole color story.

**Sanctioned motion exceptions to the "reveals-only" list:** the map marks gliding, the exception pulse, and the ⌘K command-bar typewriter + caret. These are the product speaking, not decoration — allow them, and still gate them behind `prefers-reduced-motion` (static final query + result).

## Design as a feature — the scroll-stopping checklist

- **Run the product live on the map**, don't screenshot it: trucks in motion, a POD flipping a mark hollow, one exception dimming the world on a loop. Watching the protocol happen is the demo.
- **Monumental ↔ micro.** Hero display 80–200px next to 10px mono labels. Timid type kills it.
- **The command bar (⌘K)** typing a natural-language booking is a signature moment for promo.
- **One teal moment** (a single ETA fill) is the whole color story — restraint reads as confidence.
- **Numbers count up** into a 1px-ruled KPI strip (`UNBILLED $0` is the flex).

## Two traps that pass a casual eye but fail the gate

1. **Hex-looking content trips the color audit.** The squint CI greps `#[0-9A-Fa-f]{6}`. A fake hash/ID in mock UI (`#7c04e1`) is flagged as an illegal color even though it's text. Render fake hashes truncated and non-hex-shaped (`7c04…e1a9` or `sha256:7C04…`), never a bare `#`+6 hex. Same for any hex in copy.
2. **A claude.ai Artifact cannot load a tile map.** The Artifact CSP blocks every external host — Mapbox/MapLibre CDN scripts, tile PBFs, Google Fonts. For a shareable **Artifact** promo, the map backdrop must be self-contained: hand-draw the "red engraving" road network as inline **SVG or canvas** on the greige field (it's a stylized backdrop, not a real map — and it's more on-brand for a hero than live tiles), and embed the font via `@font-face` data-URI or fall back to a condensed system stack. Use real Mapbox/MapLibre GL only when the page is hosted somewhere without that CSP (the product, or a standalone HTML file).

## Common mistakes

- Default Mapbox Streets/Dark style → instant generic. Custom greige style always.
- Reaching for a second accent color (blue links, green "success", yellow "warning"). Status is geometry + a mono chip. Delete the color.
- Drop shadows / rounded cards / gradients to create hierarchy → the 1px `--signal-12` divider and whitespace do that.
- Icon libraries on the map. The only marks are the entity geometry; the only imagery anywhere is documentary evidence photos (A6).
- Centered timid hero. Go monumental and left-anchored; let the map breathe.

## Reference

- `greige-style.json` — the custom map style (Mapbox + MapLibre).
- `genesis/07-DESIGN-SYSTEM.md` — the full law and the six Operational Amendments.
- `packages/design/tokens.css` — the locked tokens; `tools/design/audit.ts` — the CI that enforces them.
- Mapbox styling craft: the mapbox skills (`mapbox-cartography`, `mapbox-style-patterns`, `mapbox-web-integration-patterns`) are good companions for the GL-JS mechanics — apply this skill's palette/type law on top of them.
