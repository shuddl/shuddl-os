# WP-03 Live Verification — prove the map shell actually renders and performs

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. This plan exists because WP-03 shipped the map/screens with only code-level tests; the Playwright harnesses self-skipped and no pixel was ever rendered. **The deliverable of every task is real, committed evidence from an actual browser render — a screenshot or a measured number — not a passing unit test.** No task is "done" until its artifact exists on disk and has been looked at.

**Goal:** Render the five canonical screens and the 1,000-entity operational map in a real headless browser against real keyless vector tiles, commit the screenshots, measure the real framerate, and assert the specific behaviors (greige basemap, rotated chevrons, the exception dimming the world, clusters) — so "5 canonical screens match blessed refs · 1K entities at 60fps" is *observed*, not asserted. Then wire it to run in CI instead of self-skipping.

**Confirmed environment (probed 2026-07-10):** system Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` renders headless PNGs; `tiles.openfreemap.org/planet` and `demotiles.maplibre.org` return 200; npm registry reachable. **No Mapbox key needed or used** — MapLibre GL JS + OpenFreeMap keyless vectors (product path is self-hosted, REQ-075).

**Architecture:** A Vite production build of each app, served by a static file server, opened in headless Chrome via a small CDP/Playwright driver that waits for MapLibre's `idle` event, then screenshots. The greige style points at **OpenFreeMap** (OpenMapTiles schema, which `greige-style.json`'s source-layers already target — `transportation`/`water`/`place`). Behaviors are asserted by evaluating in-page (query the map's rendered features / layer paint). All keyless.

---

## Honesty contract (non-negotiable)

- A task passes ONLY when I have run the render and inspected the artifact. If it renders broken, the task's job becomes **fixing the real bug the render exposed** — that is the point of a live test.
- Every "it works" claim in the final report links to a committed PNG or a pasted measured number. No relayed second-hand claims.
- If a step genuinely cannot run here, say so exactly and move the evidence to CI — never mark it green.

---

### Task 1: The live-render harness (drive real Chrome, keyless tiles)

**Files:**
- Create: `tools/live/render.mjs` (serves a built app + a target screen, launches headless Chrome, waits for map `idle`, screenshots), `tools/live/openfreemap-greige.json` (the greige style pointed at OpenFreeMap), `tools/live/README.md`
- Modify: root `package.json` (`live:render` script)

**Step 1: Point the greige style at real vectors.** Copy `packages/map/greige-style.json`; set `sources.v.url` to `https://tiles.openfreemap.org/planet` (or the tiles.json), `glyphs` to OpenFreeMap's glyph endpoint. Confirm the source-layer names (`transportation`/`water`/`place`/`boundary`) match OpenFreeMap's schema; fix any mismatch.

**Step 2: The harness.** `render.mjs`: build the target app (`vite build`), serve `dist/` on a local port, launch Chrome headless (`--headless=new --disable-gpu`, or Playwright `channel:'chrome'` if installed — prefer the already-present system Chrome via CDP so no browser download is needed), navigate, `page.evaluate` to wait for `map.once('idle')` (or a `window.__mapReady` flag the app sets on load), then screenshot to `tools/live/out/<screen>.png`.

**Step 3: RUN IT on the Command screen.** `node tools/live/render.mjs command`. **Look at the PNG.** Expected: a warm greige field with faint red roads, red entity marks. If it's blank/errored, that's the first real bug — fix it (common: MapLibre CSS not loaded, style URL wrong, WebGL flag, canvas size 0). Iterate until the greige map genuinely renders. **Do not proceed until the screenshot shows a real map.**

**Step 4: Commit** — the harness + the first real Command screenshot — "live: headless-Chrome render harness (keyless OpenFreeMap); first real Command render — REQ-073/075".

---

### Task 2: Render + bless all five canonical screens

**Files:** Create `tests/visual/blessed/*.png` (real references), modify `tests/visual/screens.spec.ts` (use the Task-1 harness / system Chrome, not a skipped Playwright), root `package.json` (`test:visual` actually runs).

**Step 1:** Ensure each screen sets a `window.__ready` flag once its map/content is painted (Command, Portal, Status, Driver, Evidence-email). The email/driver screens may have no map — they still must render their chrome.

**Step 2: RUN** the harness for all five → `tools/live/out/{command,portal,status,driver,evidence}.png`. **Look at each.** Fix whatever renders wrong (a driver screen that isn't ink-dark; a status page showing exact coords; a portal not scoped). Each must visibly obey its surface recipe (doc 07 §03).

**Step 3: Bless.** Copy the verified PNGs to `tests/visual/blessed/`. Make `screens.spec.ts` diff against them using pixelmatch (a real image compare), advisory (REQ-158) but **actually running** — it must fail loudly on a real regression, proven by mutating a screen and watching the diff.

**Step 4: Commit** — the 5 blessed screenshots + the real diff test — "visual: 5 canonical screens rendered + blessed (real pixels), pixelmatch diff runs — REQ-073/077/080, DoD".

---

### Task 3: Measure the real 1K-entity framerate

**Files:** Modify `packages/map/perf/perf.spec.ts` to run via the harness; create `tools/live/out/perf.json` (committed measured result).

**Step 1:** Mount Command with the deterministic 1,000-entity fleet, animation running, in headless Chrome. `page.evaluate` a loop that samples `requestAnimationFrame` deltas for ~5s; compute p50/p95/max; also assert the entities are GL layers (query `map.getStyle().layers` for the `trucks`/`rest` layers; assert **zero** DOM `.maplibregl-marker` elements — proving no markers).

**Step 2: RUN.** Record real p50/p95 to `perf.json`. Report the actual numbers. If p95 blows the 16.6ms budget, that's a real finding — record it honestly (headless GPU differs from a real desktop; note the caveat) rather than fake a pass.

**Step 3: Assert the behaviors on the rendered map** (in-page eval): chevron `trucks` layer present with `icon-rotate` bound to `bearing`; exactly 1 feature with `statusStr==='exception'`; the world-dim active (non-exception layer opacity ≈ 0.35 while an exception is visible); a cluster count symbol present at low zoom. Paste the results.

**Step 4: Commit** — "perf: real 1K-entity framerate measured (headless), GL-layers-not-markers proven, behaviors asserted on the rendered map — REQ-076/077/079".

---

### Task 4: Make it run in CI (stop the self-skip) + close-out

**Files:** Modify `.github/workflows/ci.yml` (a `live-render` advisory job: `npx playwright install chromium` or use the runner's Chrome, run `test:visual` + `perf:map`, upload screenshots as artifacts), `tools/harness/playwright-guard.ts` (still skip when truly no browser, but CI now HAS one), `docs/wp/WP-03.md` (replace the "advisory/unrun" notes with the real evidence + committed screenshot paths + measured p95).

**Step 1:** Add the CI job (advisory — uploads the rendered PNGs + perf.json as build artifacts so the pixels are reviewable on every PR; does not block, per REQ-158, until WP-10).

**Step 2:** Update `docs/wp/WP-03.md`: the two DoD lines move from "infrastructure ready" to "**observed**: see `tests/visual/blessed/*.png` (rendered) and `tools/live/out/perf.json` (p95 = <n>ms)". Correct the earlier overclaim in the record.

**Step 3: Full `pnpm verify` green + commit** — "live: CI renders the screens on every run (advisory, artifacts uploaded); WP-03 DoD now observed not asserted — REQ-118/158".

---

## Out of scope
- Self-hosted OpenFreeMap/Protomaps tiles on R2 + offline SW cache → deploy/WP-05 (the live test uses OpenFreeMap's public keyless endpoint).
- Blocking (non-advisory) design/visual CI → WP-10 exit (REQ-158).
