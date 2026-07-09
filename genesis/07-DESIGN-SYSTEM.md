# SHUDDL — Design System: "TERMINAL GALLERY"
## Genesis doc 07 · 2026-07-09 · the aesthetic directive, adopted verbatim in spirit, amended only where physical operations force it — every amendment named and justified

The provided directive (Bloomberg terminal × architecture monograph; greige field, one coral-red voice, condensed display vs. micro-monospace, no shadows/gradients/radius, 1px dividers, parenthetical numbering, reveal-only motion) is **adopted as law**. This doc does three things: (1) locks tokens, (2) specs THE MAP — the living backdrop, (3) states the six Operational Amendments with reasons, so the aesthetic survives contact with docks, sunlight, invoices, and the ADA.

---

## (01) TOKENS — the entire palette and type system

```css
:root{
  /* the only colors that exist */
  --field:        #D5D1CC;              /* warm greige — every surface */
  --signal:       #FF4A33;              /* coral red — display type, dividers, entities, everything that speaks */
  --signal-deep:  #A93018;              /* AMENDMENT A1: same red family, darkened until small mono body passes WCAG AA (≥4.5:1 on --field). Final hex locked by the CI contrast test, not by taste. Used ONLY ≤14px text on --field. Display type ≥18px stays --signal. */
  --ink-dark:     #1A1A1A;              /* warm near-black — inverted surfaces, inputs, footer strips, driver night mode */
  --progress:     #00C4B4;              /* teal — progress FILLS only (ETA bars, upload %, count-up rings). Never text, never icons, never states. */

  /* transparent reds do all secondary work — there is no gray */
  --signal-55:    rgba(255,74,51,.55);  /* captions, labels, metadata */
  --signal-12:    rgba(255,74,51,.12);  /* 1px dividers, grid lines */
  --signal-07:    rgba(255,74,51,.07);  /* container tint (max chrome) */
  --field-on-dark:#D5D1CC;              /* text on --ink-dark */

  /* type */
  --display: 'Barlow Condensed', 'Oswald', sans-serif;   /* 700 only */
  --mono:    'JetBrains Mono', 'IBM Plex Mono', monospace; /* 400 only */
}
```
Display: UPPERCASE always · line-height .88–.95 · letter-spacing −0.015em · scale jumps are dramatic (hero 80–200px / section 40–64px / sub 24–32px / metric 20–28px). Mono: UPPERCASE always · 11–14px body (nav 10–12, labels 9–10) · tracking .04–.14em (smaller = wider) · line-height 1.6–1.8 · one weight. **The contrast between monumental display and micro mono IS the brand.** No other fonts, cases, weights, italics, shadows, gradients, or radii exist. Buttons: dark primary (radius ≤4px, generous x-padding) and red underlined text-links with →. Inputs: dark, borderless, mono uppercase, red focus underline. Empty state: one muted mono line. Error: "FAILED" in display type + one retry button. Loading: "SYNCING" in muted mono — no skeletons, no shimmer.

---

## (02) THE MAP — the backdrop is the operation

The signature move: **Command, the client portal, and every status page sit on a full-viewport live map.** Not a widget in a dashboard — the dashboard is a thin typographic layer floating over the tenant's physical world. The emptiness of the greige map is the gallery wall; the freight is the art.

**Basemap (custom vector style — this is 80% of the look):** self-hosted vector tiles (MapLibre GL + Protomaps/OpenFreeMap on our storage; no third-party branding, offline-cacheable for the driver PWA). Style rules: land `--field`; water `--ink-dark` at 6%; road network `--signal` at 5–8% (major roads slightly stronger — the map reads as red engraving on concrete); place labels micro-mono uppercase `--signal-55`, thinned aggressively (state + city scale only; the map is calm); **no** terrain shading, no satellite, no POI icons, no color anywhere. Squint test: a warm field with faint red circuitry.

**Entities (the only saturated marks on screen):**
| Entity | Mark | State grammar |
|---|---|---|
| Truck/driver in motion | Solid red chevron oriented to heading, 600ms fading position trail | Motion is shown by the trail, never by animation gimmicks |
| Shipment at rest (dock/terminal/yard) | Solid red square | Dwell time as micro-mono label beneath |
| Terminal/facility | Red outlined square, parenthetical number (01), (02)… | |
| Delivered (last 24h) | Hollow red outline at 55% | Fades from the map after 24h |
| **Exception** | The mark pulses at 100% opacity **and the rest of the map dims to 35%** | The alarm is the world going quiet — no new color needed |
| ETA/progress | Thin `--progress` teal fill along the remaining route line | The single sanctioned teal use |

Clicking any mark opens the shipment lens as a right-side dark panel (`--ink-dark`) — the map never navigates away; it IS the home. Live updates ride the ledger (Durable-Object fan-out): marks move when events land, and a delivered mark flips to hollow **in the same second the consignee's photo email sends** — watching that happen on the map is the demo.

**Party scoping (lens discipline, L2):** ops lens = whole fleet + all shipments; shipper lens = *their* shipments only; consignee/status page = one shipment, position generalized to ~city granularity until out-for-delivery (geo-privacy: exact coordinates are an ops/driver privilege); cartage partner = their legs only; SHUDDL Direct guest = their booking. Same map, same style, scoped data — never a filtered screenshot of someone else's world. Positions: driver PWA GPS (30s cadence in motion, event-stamped at gates) now; ELD/telematics adapters later (REQ'd in register).

---

## (03) SURFACE RECIPES

**Command (web):** map backdrop; fixed transparent nav (wordmark left, micro-mono links, one dark CTA); left-bottom: the day's KPIs as a 1px-divided strip (mono labels over display-font values that count up); right: queues (approvals/exceptions/money) as dark panels sliding up 300ms. Command bar (⌘K) is a dark strip, mono uppercase, red caret. Sections numbered (01) BOARD, (02) QUEUES, (03) MONEY.

**Client portal:** same map (scoped), hero = the customer's name in display type over their live freight; quote→book is one dark panel with 4 fields; documents/invoices are 1px-ruled lists, no cards. Delivery notification email inherits the system: greige background, display-type "DELIVERED", signature + placed-freight photos full-bleed, mono metadata, red rules — **the email is the brand's furthest-traveling artifact; it gets design-system treatment equal to the app.**

**Driver PWA:** gates as full-screen questions — one display-type instruction ("PHOTOGRAPH THE FREIGHT WHERE IT SITS"), one primary button, mono caption. **Amendment A2:** driver surfaces default to `--ink-dark` ground with `--field` type (docks at 5am, sunlight glare — dark ground with huge light type wins outdoors; the gallery inverts, the rules don't). Camera screens always dark. Progress of the stop = teal fill line. Offline = "OFFLINE — CAPTURING LOCALLY" mono banner, nothing else changes (L1 doesn't care about signal).

**Data displays everywhere:** metric strips and 1px-grid tables (no gaps — grid lines are `--signal-12`); numbers count up 1.2–1.8s eased; bars/rings fill teal. Scoreboards, lane P&L, aging — all this one pattern.

---

## (04) OPERATIONAL AMENDMENTS (all six — nothing else deviates)
- **A1 · Deep signal red for small text** (`--signal-deep`): #FF4A33 on #D5D1CC is ~2.8:1 — beautiful at 96px, illegal at 11px. Same hue family, darkened to ≥4.5:1, locked by CI test. The squint test still reads "red on greige."
- **A2 · Driver dark ground** (above). Same tokens, inverted relationship — already sanctioned by the directive's dark-surface rule.
- **A3 · Print/PDF (BOL, invoice, rate con, POD packet):** paper is white; body prints `--ink-dark` for legibility and toner economics; display headlines, totals, and rules stay red; mono/uppercase/1px grammar unchanged. A BOL should look like it came from the same building as the app.
- **A4 · Status is grammar, not color:** states are expressed by geometry (solid/hollow/square/chevron), opacity (100/55/35), motion (trail/pulse), and mono chips ("IN TRANSIT", "EXCEPTION") — never by adding greens/yellows. Teal remains fills-only.
- **A5 · Accessibility without visual compromise:** uppercase is CSS `text-transform` (DOM/screen-readers get normal case); focus = 2px red underline + visible outline on dark; `prefers-reduced-motion` kills trails/count-ups (values just appear); map marks carry aria labels; hit targets ≥44px on driver surfaces even when the visual mark is small.
- **A6 · Photography discipline:** evidence photos (PODs, freight, damage) render full-bleed, unrounded, unfiltered — documentary by definition. They are the only imagery in the product. No stock, no illustration, no emoji, anywhere, ever.

---

## (05) MOTION LAW (unchanged from directive, made testable)
Reveals: fade-up 20–30px, cubic-bezier(.16,1,.3,1), 600–800ms, 100–200ms stagger. Numbers count up eased. Hovers ≤150ms, underline/opacity only — nothing lifts, scales, or shadows. View changes: 300ms crossfade or rise. Map: marks glide between event positions (linear, duration = real elapsed time capped 800ms); the exception pulse is a 1.6s opacity sine. **Banned and CI-linted:** springs, parallax, rotation, particles, shimmer skeletons, hover-lift.

## (06) THE SQUINT TEST, OPERATIONALIZED (CI acceptance)
Automated on every merge: (1) color audit — any computed style outside the five tokens + opacities fails; (2) contrast audit — all text ≥4.5:1 (A1 enforced); (3) radius/shadow lint — any border-radius >4px or box-shadow fails; (4) font audit — any family outside the two stacks fails; (5) case audit — rendered text nodes must be visually uppercase; (6) screenshot diff of the five canonical screens vs. blessed references. The aesthetic is a test suite, not a mood board — that is how it survives a hundred PRs.
