# SHUDDL.TECH v2 — Demo-Spine Redesign (Design Doc)

**Status:** Approved by owner 2026-07-22 (brainstorming session). Architecture A.
**Supersedes:** the v1 abstract-canvas page currently live at shuddl-tech.spencer-896.workers.dev.
**Owner decisions recorded here:** Architecture A (demo-spine) · Mapbox real map, infinite canvas, full viewport, mobile-optimized · Founding 50 offer, percentage-only framing · **demo quote beat shows < 15 seconds** (owner tightened from genesis "≤60s"; all site copy uses "under 15 seconds", demo timestamps show ~12s).

## 1. The clarity engine (copy architecture)

Every section answers two questions for ONE reader — the owner/GM of a US asset-based LTL/final-mile carrier (10–150 trucks) running a legacy TMS:
1. **What does this replace?** (the stack they run today)
2. **What is the situational outcome vs. now?** (before → after, falsifiable)

The replaced stack, stated on-page: AS/400-era / McLeod/TMW-class / homegrown TMS · paper or hostile driver app · billing desk keying probills + chasing PODs · phone/email status · interline spreadsheets · freight-audit + factoring. Sequencing honesty: day one SHUDDL replaces NOTHING (overlay beside the TMS); authority moves organ-by-organ; QuickBooks stays forever (journal export).

Outcome pairs (the page's spine, each falsifiable):
- Signature at door: POD rides the cab for days → invoice + signed photo in the client's inbox < 5 s.
- Quote request: hours-to-days rating backlog → bookable price in **under 15 seconds**.
- Month-end: unbilled found late or never (~$402K story) → alarm the day unbilled ≠ $0.
- "Where's my truck?": check calls → live status link.
- New EDI partner: months → ~a day.
- New hire: weeks of training → first booking < 10 min.
- Dispute: paper argument → co-signed, hash-anchored evidence packet.

Copy production: attempt `/universalwritingengine` (user-named; not in current skill listing — verify at implementation), fallback `marketing-skills:copywriting` + `elements-of-style:writing-clearly-and-concisely`. Voice stays Terminal Gallery (declarative, falsifiable, uppercase display statements) but every claim is concrete replace→outcome.

## 2. The map (the whole backdrop)

- **Mapbox GL JS** with a custom Terminal Gallery style (built via mapbox-devkit MCP): land `#D5D1CC`, water `#1A1A1A` at ~6%, road network `#FF4A33` at 5–8% (majors slightly stronger), place labels micro-mono uppercase red-55, aggressively thinned (state+city scale), no POI, no terrain, no satellite. Squint test: warm field, red engraving — now over real America.
- **Full viewport, infinite canvas:** the map IS the page background; sections float over it. Camera drifts continuously — following the demo truck during transit beats, easing between cities (that is "the way the map moves").
- **Mobile:** same map, thinner layers (fewer labels/roads at low zoom), DPR-aware, camera moves shortened; sections stack; demo loop identical.
- **Reduced motion:** static framed map (no camera drift, no autoplay; the lifecycle renders as a completed timeline).
- **Token security** (per mapbox-token-security skill): public scoped token, URL-restricted to shuddl.tech + the workers.dev preview host.
- Fallback if Mapbox fails to load (offline/blocked): the existing v1 canvas network renders behind a mono "MAP OFFLINE — THE DEMO CONTINUES" note; the lifecycle ticker still plays.

## 3. The autoplay demo (map-driven lifecycle loop, ~45 s, loops forever)

One shipment, real lanes (e.g. Chicago → Denver), driven by a beat state machine; every beat = map action + event-ticker line + (sometimes) a DOM artifact popping over the map:

| t | Beat | On the map | Artifact / ticker |
|---|---|---|---|
| 0s | quote.requested | camera on origin city | inbound email artifact: "2 pallets to Denver by Friday…" |
| ~12s (shown clock) | quote.priced | — | reply artifact: bookable price, floors honored — "UNDER 15 SECONDS" caption |
| +5s | booking.created | origin terminal square lights | ticker: credit OK · appointment set |
| +6s | pickup gate | dwell square + gate checklist | forced-photo + count chips tick green |
| +12s | in transit | chevron + trail; camera follows; teal remaining-route fill | position.updated ticker; "meanwhile on your current system: POD is paper in a cab" counter runs |
| +5s | geofence arrival | arrival ring at destination | stop.arrived ±4 m |
| +4s | pod.signed → delivery.evidenced | mark flips hollow | THE MOMENT: DELIVERED email artifact (signature + placed-freight + invoice) pops full treatment |
| +3s | invoice.issued | — | "SAME SECOND" stamp; meanwhile-counter still says legacy invoice is 11 days away |
| loop | reset | camera eases back | new pro number so the loop reads as fleet, not replay |

The "meanwhile" counter is the embedded side-by-side: a persistent two-line strip (SHUDDL clock vs "your current system" clock) racing through the loop.

## 4. Page sections (over the map)

(00) HERO — headline + sub + email capture; demo already playing behind. Clarity bar directly under the headline: "Replaces the reconciliation half of your TMS stack. Keeps your TMS. Books from email in under 15 seconds. Invoices the second the driver signs."
(01) THE SWAP — 1px table: what you run today → what runs itself on SHUDDL (replace-stack list above).
(02) THE RACE — the outcome pairs as a dual-timeline (scroll-driven; the legacy column visibly lags).
(03) WHAT RUNS ITSELF — 13 agents, one line each (condensed from v1).
(04) KEEP YOUR TMS — overlay 5 steps + parity gates (kept from v1).
(05) FOUNDING 50 — the offer (below) + design-partner secondary.
(06) WAITLIST — capture (email → segment chips, unchanged mechanics) + ink footer.
Laws section retired in v2 (poetic; replaced by the clarity bar). Claude/MCP booking moves into (02) as one race row + a short strip — still present, no longer a full section.

## 5. The offer — Founding 50 (percentage-only, REQ-130 intact)

"FIRST 50 CARRIERS: 80% OFF MONTHS 3–6, LOCKED AT SIGNUP. FIRST 2 MONTHS ON US WHILE THE OVERLAY PROVES PARITY." No dollar price anywhere. Live honest counter: "N OF 50 CLAIMED" fed by `GET /api/founding-count` = count of carrier-segment waitlist rows (capped display at 50; when full, flips to "FOUNDING 50 CLOSED — JOIN THE LIST"). Design-partner 10-seat program remains as the secondary CTA for case-study-rights carriers. Offer terms are marketing framing of hypothesis pricing — final dollar terms re-based per REQ-130 before invoicing anyone.

## 6. Engineering notes

- Keep: Worker + D1 + `/api/waitlist` (validated, honeypot, origin check) unchanged; add `/api/founding-count` (read-only, cached 60s).
- New: `map-gl.js` (Mapbox init + style + camera choreography), `demo.js` (beat state machine + ticker + artifacts), restructured `index.html`/`styles.css`. v1 `map.js` becomes the no-Mapbox fallback.
- Budget: Mapbox GL ~230KB gz is accepted (owner call — real map outranks payload); everything else stays hand-crafted.
- Testing: node:test for founding-count logic; browser pass (desktop + 375px mobile) verifying loop, camera, artifacts, capture flow; review swarm re-run (design law, claims/REQ-167, a11y, mobile perf) before deploy.

## 6b. Accepted design-law exemptions (post-swarm)

- **Mapbox wordmark logo** (`.mapboxgl-ctrl-logo`, white): required by Mapbox TOS to remain displayed unmodified; recoloring it would breach TOS. Kept as-is, small, bottom-left. The attribution *text bar* IS restyled to tokens; the logo is the one sanctioned off-token mark, analogous to documentary evidence in the design law.
- **Font fallback stacks** (`'Oswald'`, `'IBM Plex Mono'`): these are the fallbacks the repo's own `terminal-gallery-map-ui` skill law table explicitly names; both primary faces are self-hosted same-origin woff2, so fallbacks render only on a fetch failure. Kept.
- **WCAG 2.2.2 (auto-updating demo):** satisfied by bounding, not a button — the demo animates only while the hero map is on screen and the tab is visible (IntersectionObserver + visibilitychange), and is fully static under `prefers-reduced-motion`. A literal pause control was rejected as conflicting with the chrome-free aesthetic; the scoped auto-pause is the recorded posture.

## 7. Out of scope (unchanged from v1 follow-ups)

shuddl.tech domain attach (zone in the other Cloudflare account) · Turnstile/edge rate limits · Resend confirmation email (REQ-157 warmup) · og:image (worth adding with the new map hero).
