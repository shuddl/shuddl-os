# SHUDDL.TECH v2 Demo-Spine Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the live waitlist site around a real Mapbox map running an autoplaying shipment-lifecycle demo, with replace→outcome clarity copy and the Founding 50 offer.

**Architecture:** Same Worker + D1 + static-assets deployment as v1 (`marketing-site/`). The page becomes a fixed full-viewport Mapbox GL map with scroll sections floating over it; a beat state machine (`demo.js`) drives camera, entities, an event ticker, and DOM artifacts; v1's canvas (`map.js`) demotes to the no-Mapbox fallback. One new read-only API route (`/api/founding-count`). Design authority: `docs/plans/2026-07-22-site-v2-demo-spine-design.md` (owner-approved; quote beat shows **under 15 seconds**).

**Tech Stack:** Cloudflare Workers + D1 (unchanged) · Mapbox GL JS v3 (CDN, SRI) + custom style via mapbox-devkit MCP · vanilla JS/CSS · node:test.

**Rules that bind every task:** Terminal Gallery law (5 tokens, 2 fonts, uppercase via CSS, no shadows/gradients/radius>4px, sanctioned motion only, reduced-motion = static) · REQ-167 (no tenant/person/incumbent names) · no dollar pricing anywhere (Founding 50 is % only) · claims only from `.agents/product-marketing-context.md` §12 plus the owner's <15s quote claim.

---

### Task 1: Mapbox style + token (MCP, no code)
**Tools:** `mcp__plugin_mapbox_mapbox-devkit__*` (load via ToolSearch). Read skills `mapbox:mapbox-style-patterns` and `mapbox:mapbox-token-security` first.
1. `list_tokens_tool` — find or create a **public** token, URL-restricted to `https://shuddl.tech` and `https://shuddl-tech.spencer-896.workers.dev`.
2. `create_style_tool` / `style_builder_tool`: base Standard/streets-v12 stripped to: land fill `#D5D1CC`; water `#1A1A1A` at 6% opacity; road network `#FF4A33` 5–8% (motorways .08, primary .06, rest .05); admin borders `#FF4A33` at .10; place labels: state+city only, JetBrains Mono (or closest available mono), uppercase, `#FF4A33` at .55, sizes 9–11px; ALL POI/transit/terrain/hillshade/landuse layers removed or opacity 0.
3. `preview_style_tool` at zooms 3.5 (continent), 6 (lane), 12 (city) — verify squint test: warm field, red engraving.
4. Record style URL + token in `marketing-site/config.notes.md` (gitignored-safe scratch note; token is public/URL-locked so exposure in HTML is by design — see token-security skill).

### Task 2: `/api/founding-count` (TDD)
**Files:** Create `marketing-site/worker/founding.js`, `marketing-site/tests/founding.test.mjs`; Modify `marketing-site/worker/index.js`.
1. Failing test first:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { foundingState } from "../worker/founding.js";
test("counts clamp and close", () => {
  assert.deepEqual(foundingState(0),  { claimed: 0,  open: true });
  assert.deepEqual(foundingState(37), { claimed: 37, open: true });
  assert.deepEqual(foundingState(50), { claimed: 50, open: false });
  assert.deepEqual(foundingState(93), { claimed: 50, open: false });
  assert.deepEqual(foundingState(-1), { claimed: 0,  open: true });
});
```
Run `node --test tests/founding.test.mjs` → FAIL (module missing).
2. Implement `foundingState(n)` (clamp 0..50, `open: n < 50`). Test → PASS.
3. Route in `index.js` before the `/api/` 404 fallthrough:
```js
if (url.pathname === "/api/founding-count" && request.method === "GET") {
  const row = await env.WAITLIST.prepare(
    "SELECT COUNT(*) AS n FROM waitlist WHERE segment = 'CARRIER'").first();
  return new Response(JSON.stringify({ ok: true, ...foundingState(row?.n ?? 0) }),
    { status: 200, headers: { ...JSON_HEADERS, "cache-control": "public, max-age=60" } });
}
```
4. Smoke: `npx wrangler dev --local --port 8791` → `curl localhost:8791/api/founding-count` → `{"ok":true,"claimed":N,"open":true}`.

### Task 3: Copy pass (before markup)
1. Attempt `Skill(universalwritingengine)` (user-named). If not found, use `marketing-skills:copywriting` + `elements-of-style:writing-clearly-and-concisely`.
2. Produce final copy for all sections per design doc §1/§4: hero + clarity bar, THE SWAP table rows, THE RACE pairs (7 rows incl. the MCP/Claude row), agents one-liners (reuse v1), overlay (reuse v1), Founding 50 block, waitlist. Every claim from the safe list; quote claim = "under 15 seconds".
3. Owner reviews copy inline in the session before Task 4 proceeds (single approval gate).

### Task 4: Page restructure
**Files:** Rewrite `marketing-site/public/index.html`; extend `marketing-site/public/styles.css`.
- `<div id="glmap">` fixed inset-0 behind everything; sections in `<main>` with alternating solid-field and transparent bands so the map shows through between sections.
- Section order (00)–(06) per design §4; keep both waitlist forms' existing markup/ids EXACTLY (JS contract: `[data-wl]`, `.wl-status` ids, `hp_check` honeypot, chips) — form mechanics are already reviewed and live.
- Demo chrome: `#ticker` (bottom-left mono event log, max 4 lines, oldest fades), `#meanwhile` (two-clock race strip), `#artifact-root` (email/gate artifacts pop here; reuse v1 `.email-artifact` styling for THE MOMENT).
- Founding 50 block with `<span data-founding>` counter.
- CSS additions stay inside the 5 tokens; artifacts/panels reuse v1 classes wherever possible.

### Task 5: `map-gl.js` (map + camera + entity layers)
**Files:** Create `marketing-site/public/map-gl.js`; keep `map.js` as fallback (loaded only if `window.mapboxgl` fails).
- Init: script tag `mapbox-gl@3` CDN with SRI + preconnect; style URL from Task 1; `projection:'mercator'`, `attributionControl` compact (legally required — style it mono/small, do NOT remove).
- Fallback: `script.onerror` OR `!mapboxgl.supported()` → inject v1 `map.js` canvas + mono note "MAP OFFLINE — THE DEMO CONTINUES".
- Camera API for demo.js: `cam.overview()` (US frame z~3.8), `cam.lane(from,to)` (fitBounds padded), `cam.follow(lngLat)` (easeTo z~6.5, 900ms, linear-ish), `cam.city(lngLat)` (z~11). All easeTo/flyTo curves gentle; no spinning.
- Entity layers (GeoJSON sources updated per frame): route line (red .10) + teal remaining-line · truck chevron (symbol layer, red triangle sprite oriented to bearing) · trail (line with per-vertex opacity via gradient—if unsupported, 8 fading segments) · terminal/dwell/delivered marks · exception pulse = opacity sine on the mark + map container CSS overlay dimming to 35% (the world-goes-quiet move).
- Lane data: Chicago `[-87.6298,41.8781]` → Denver `[-104.9903,39.7392]`, great-circle interpolation (~140 points precomputed).
- Mobile (`max-width:900px`): start z 3.2, `cooperativeGestures:true`, label layers further thinned via `setLayoutProperty` on load.
- Reduced motion: no camera moves, no rAF; render completed-state frame (truck at destination, hollow mark, full route).

### Task 6: `demo.js` (beat state machine)
**Files:** Create `marketing-site/public/demo.js`.
- Data-driven: `const BEATS = [{at:0, id:'quote.requested', cam:'overview', ticker:'…', artifact:'inbound-email'}, {at:12,…}]` per design §3 table (total ~45s, then `loop()` with a new pro number from a counter — no `Date.now()` dependency issues here, browser JS is fine).
- Runs on `requestAnimationFrame` clock; pauses when `document.hidden` or map container off-viewport (IntersectionObserver) — same discipline the swarm enforced on v1.
- `#meanwhile` strip: SHUDDL clock advances with beats; legacy clock ticks days ("DAY 4 — POD STILL IN THE CAB") on a mapping table.
- Artifacts: prebuilt hidden DOM nodes revealed/hidden per beat (sanctioned crossfade), never innerHTML from data.
- Reduced motion: render the full ticker + THE MOMENT artifact statically, no clocks.

### Task 7: THE RACE section (scroll-driven)
**Files:** `index.html` (Task 4 markup) + small handler in `main.js`.
- Dual-column 1px grid; each row reveals with the legacy cell delayed 400ms after the SHUDDL cell (the lag IS the message). Reuse `.reveal` machinery + `transition-delay`; no new motion primitives.

### Task 8: Founding 50 wiring
**Files:** Modify `marketing-site/public/main.js`.
- On load: `fetch('/api/founding-count')` → `data-founding` text "N OF 50 CLAIMED" (count-up animation, existing helper); `open:false` → swap block copy to "FOUNDING 50 CLOSED — JOIN THE LIST". Fetch failure → hide counter line (never show fake scarcity).

### Task 9: Verify + swarm + deploy
1. `node --test tests/` (both files, direct paths) → all PASS.
2. Local `wrangler dev` smoke: page 200, both APIs, fallback path (`?nogl=1` test hook that skips Mapbox).
3. Re-run the review-swarm Workflow (same 5 lenses; add "mobile perf" emphasis + "Mapbox attribution present" check). Fix confirmed findings.
4. `npx wrangler deploy` → browser verify at desktop AND 375px width: loop plays, camera follows, artifacts pop, capture flow end-to-end, no horizontal scroll, reduced-motion static.
5. Update memory file `shuddl-tech-site-launch.md` (v2 shipped; style URL; token id).

**Commits:** the site dir is currently untracked and the checkout sits on a WP branch shared with parallel sessions — commit only if the owner says where (suggest a dedicated `site` branch once WP-16 merges).
