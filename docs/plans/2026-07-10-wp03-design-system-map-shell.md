# WP-03 — Design System Package + Map Shell Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The craft anchor for every visual and map decision is the **`terminal-gallery-map-ui`** skill (`.claude/skills/terminal-gallery-map-ui/`) and its `operational-map.md` / `greige-style.json`; read it before Tasks 3–6.

**Goal:** Ship the SHUDDL design-system package (tokens + primitives + motion) and the operational map shell (greige MapLibre style, 1,000-entity GL layer with the three-tier state grammar, party-scoped subscription, exception world-dim, click→lens), plus the squint-test CI completion — meeting the WP-03 DoD: 5 canonical screens match blessed refs · squint CI passes · map renders 1K entities at 60fps desktop / 30fps mid-phone.

**Architecture:** `packages/design` grows from tokens-only into a typed token + React-primitive + motion library, every pixel obeying doc 07 and provable by the squint-test CI. A new `packages/map` owns the MapLibre greige style, the entity-layer builder (GL `circle`/`symbol` layers driven by `feature-state`, never DOM markers), the `useFleet` scoped-subscription hook (tying to the WP-02 lens/event contract), the exception world-dim, and the lens panel. The three app shells (Command / Driver-A2 / Portal) compose these into the five canonical screens, captured as Playwright screenshots. Design CI stays **advisory** (REQ-158, report-only until WP-10) so pixel/perf checks never block ledger work.

**Tech Stack:** React 19 + Vite (existing), TypeScript strict no-`any`, MapLibre GL JS (self-hosted-vectors-ready per REQ-075; demo tiles for the harness), Vitest + jsdom for component/unit tests, Playwright for screenshot diff + the 1K-entity perf harness (both advisory), the existing `tools/design/audit.ts` squint CI.

---

## Governing rows

- **WP row (`genesis/08 §03`):** "Tokens/components per doc 07; MapLibre greige style; entity layer w/ scoped subscriptions; reveal/count-up primitives." DoD: 5 canonical screens match blessed refs · squint CI passes · 1K entities 60fps/30fps.
- **REQ rows:** REQ-073 (full-viewport map backdrop), REQ-074 (party-scoped entities; consignee city-level until OFD), REQ-075 (self-hosted vector tiles; greige style; offline-ready), REQ-076 (entity grammar chevron/square/hollow/pulse; no new colors), REQ-077 (exception dims world to 35% + pulse), REQ-078 (teal = progress fills only), REQ-079 (1K entities 60fps/30fps), REQ-080 (click mark → dark lens panel; map never navigates away), REQ-115 (error state: FAILED + retry), REQ-145 (5-token color audit), REQ-146 (type law: condensed display + mono, uppercase, contrast pair), REQ-147 (no shadows/gradients/radius>4px; 1px dividers), REQ-148 (motion law: reveals/count-ups only; reduced-motion honored), REQ-149 (A1 deep-red ≥4.5:1, already locked).
- **Design law:** `genesis/07-DESIGN-SYSTEM.md` in full. `packages/design/tokens.css` (the 5 locked tokens). `tools/design/audit.ts` (the CI). REQ-158: advisory until WP-10.

## Stated assumptions (say these in the PR)

1. **Self-hosted Protomaps/OpenFreeMap tiles are deploy-time infra (F1/R2).** WP-03 builds the greige *style* and entity layers against a public demo tile source, with the tile URL a config value; the self-host + offline service-worker cache lands at deploy / WP-05 (Driver PWA). The style, entity grammar, and perf are fully built and tested now.
2. **On-map mono requires self-hosted glyph PBFs** (skill's glyph note). WP-03 uses the demo provider's glyphs for map labels; HTML chrome uses real fonts. Self-hosted JetBrains-Mono glyphs are a deploy line item.
3. **Design CI (screenshot diff + perf) is advisory** (REQ-158) — it reports, never blocks, until WP-10 exit. `pnpm verify` stays green even if a screenshot drifts; drift is surfaced loudly.
4. **The fleet/event contract** the map consumes is the WP-02 lens shape (`{id, lng, lat, bearing, kind, status, risk?, label, shipment_id, party_refs[]}`); WP-03 consumes it via a typed adapter with a synthetic source for tests. Live Durable-Object fan-out wiring is WP-10/board-DO.
5. Execution on branch `wp-03-design-map` in a worktree; commits cite REQ-IDs; `tools/traceability/active-wps.json` gains `WP-03` in the final task.

---

### Task 1: Squint-test CI completion (the audits that make the aesthetic a test suite)

**Files:**
- Modify: `tools/design/audit.ts`, `tools/design/design.test.ts`
- Create: `tools/design/motion.ts`

**Context:** `audit.ts` today does color/contrast/radius/shadow/gradient/font. Doc 07 §06 requires six audits; the missing ones are **case** (rendered text visually uppercase), **motion** (ban springs/parallax/rotation/particles/shimmer; require `prefers-reduced-motion`), **1px-divider/numbering discipline**, and the **screenshot diff** (Task 6). This task finishes the static audits (REQ-146 case, REQ-147 dividers, REQ-148 motion).

**Step 1: Write failing tests** — append to `tools/design/design.test.ts`:

```ts
import { auditMotion, auditCaseAndDividers } from "./audit.js";

describe("REQ-148: motion law", () => {
  it("flags a spring/parallax/particle/shimmer/rotate keyword in css/tsx", () => {
    for (const bad of [
      "transition: transform 200ms cubic-bezier(.34,1.56,.64,1);", // spring overshoot
      "animation: shimmer 1s infinite;",
      "background-attachment: fixed; /* parallax */",
      "transform: rotate(4deg);",
    ]) expect(auditMotion("x.tsx", bad).length).toBeGreaterThan(0);
  });
  it("passes reveal/count-up/opacity motion", () => {
    expect(auditMotion("x.tsx", "transition: opacity 600ms cubic-bezier(.16,1,.3,1);")).toEqual([]);
  });
  it("flags a keyframes/transition file that never references prefers-reduced-motion", () => {
    expect(auditMotion("anim.css", "@keyframes reveal { to { opacity: 1 } }").some(v => v.includes("reduced-motion"))).toBe(true);
  });
});

describe("REQ-147/146: dividers + case", () => {
  it("flags a border/divider thicker than 1px", () => {
    expect(auditCaseAndDividers("x.tsx", "border-bottom: 2px solid var(--signal);").some(v => v.includes("1px"))).toBe(true);
  });
  it("flags text-transform other than uppercase on a display/mono element", () => {
    expect(auditCaseAndDividers("x.tsx", "text-transform: capitalize;").some(v => v.includes("uppercase"))).toBe(true);
  });
});
```

**Step 2: Run → RED** (`pnpm test:tools`).

**Step 3: Implement** `tools/design/motion.ts` (the banned-motion regexes + the reduced-motion requirement) and add `auditMotion` + `auditCaseAndDividers` to `audit.ts`, wiring both into `auditRepo()` so `pnpm audit:design` runs them. Banned: `rotate(`, non-0 `rotate`, `scale(` on hover, spring cubic-beziers (overshoot: any control-point y>1 or <0), `@keyframes` named shimmer/skeleton/spin/parallax, `background-attachment: fixed`, `will-change: transform` paired with scroll. Required: any file defining `@keyframes` or a `transition`/`animation` must also contain a `prefers-reduced-motion` guard somewhere in the repo's global stylesheet (check `packages/design/motion.css` exists and is imported).

> **The color/font/glob audits must not be trivially foolable (WP-03 exit-audit lesson).** The gate is the SOLE enforcement of the pixel law: (1) **color** must catch `rgb()/rgba()/hsl()/hsla()`, CSS **named colors** (`blue`,`navy`,`rebeccapurple`), and **3/4/8-digit** hex — allowing only the 5 tokens + `rgba(255,74,51,x)`/`rgba(26,26,26,x)` + `var(--*)`/`transparent`/`currentColor`; (2) **font** must catch **camelCase `fontFamily`** and reject any value merely *containing* `sans-serif`/`monospace` (require an exact allowed stack or `var(--display|--mono)`); (3) shadow/radius/gradient must catch `filter:drop-shadow`, `textShadow`, every `border*Radius` corner, and `conic-gradient`; (4) the **glob** must scan `*.ts`, `*.jsx`, `*.mjs`, and `index.html` `<style>` — screens style from all of these. A gate fooled by `color:"blue"` in a `.ts` file is not a gate. Red-path test every one.

**Step 4: GREEN + commit** — `pnpm test:tools && pnpm audit:design` → `git commit` "design CI: motion + case + divider audits complete the squint test — REQ-146/147/148".

---

### Task 2: Design primitives + motion (`packages/design`)

**Files:**
- Create: `packages/design/src/{index.ts,tokens.ts,primitives.tsx,motion.tsx}`, `packages/design/motion.css`, `packages/design/vitest.config.ts`
- Modify: `packages/design/package.json` (exports, react dep, test script)
- Test: `packages/design/test/primitives.test.tsx`

**Context:** Build the doc-07 component vocabulary as React 19 primitives, every one audit-clean. The `terminal-gallery-map-ui` skill's law table is the spec.

**Primitives to build** (each a tiny component, tokens via `var(--…)`, uppercase via CSS `text-transform` so screen-readers get normal case — Amendment A5):
- `Display` (monumental, `--display`, 700, uppercase, LH .9, tracking −.015em; `size` prop: hero/section/sub/metric)
- `Mono` (micro-label, `--mono`, 400, uppercase, tracking)
- `Metric` — a count-up number (uses `CountUp`) over a `Mono` label, in a 1px-divided strip
- `Divider` (1px `--signal-12`), `Chip` (mono status pill, `--signal` border, no radius>2px)
- `Button` (dark primary `--ink-dark` ground, radius ≤4px, generous x-padding) and `TextLink` (red underlined with `→`)
- `Input` (dark, borderless, mono uppercase, red focus underline)
- `EmptyState` (one muted mono line), `Loading` ("SYNCING" muted mono, no skeleton), **`ErrorState` ("FAILED" display + one retry button, REQ-115)**
- Motion (`motion.tsx`): `Reveal` (fade-up 20–30px, cubic-bezier(.16,1,.3,1), 600–800ms, honors reduced-motion), `CountUp` (eased 1.2–1.8s; reduced-motion → value appears instantly). `motion.css` holds the `@keyframes` + the `@media (prefers-reduced-motion: reduce)` guard.

**Step 1: Failing tests** (`primitives.test.tsx`, vitest + jsdom):

```tsx
import { render } from "@testing-library/react";
import { Display, ErrorState, CountUp, Chip } from "../src/index.js";
it("Display renders uppercase via CSS text-transform, DOM stays normal-case (A5)", () => {
  const { getByText } = render(<Display size="hero">Board</Display>);
  const el = getByText("Board");                    // DOM text is normal case
  expect(getComputedStyle(el).textTransform).toBe("uppercase");
});
it("ErrorState shows FAILED + a retry button (REQ-115)", () => {
  const onRetry = vi.fn();
  const { getByText } = render(<ErrorState onRetry={onRetry} />);
  getByText("FAILED"); getByText(/retry/i).click(); expect(onRetry).toHaveBeenCalled();
});
it("CountUp with reduced-motion shows the final value immediately (REQ-148)", () => {
  matchMedia... // mock prefers-reduced-motion: reduce
  const { getByText } = render(<CountUp to={504} />); getByText("504");
});
it("Chip has no radius > 4px and only token colors (REQ-147)", () => { /* assert inline style */ });
```

**Step 2: RED → implement → GREEN.** Add `@testing-library/react`, `jsdom`, `vitest` devDeps; `vitest.config.ts` (environment jsdom). Every primitive uses only `var(--token)`; `pnpm audit:design` must stay clean on `packages/design/**`.

**Step 3: Commit** — "design: primitives (Display/Mono/Metric/Chip/Button/Input/states) + Reveal/CountUp motion — REQ-115/146/147/148".

---

### Task 3: Map package — greige style + entity layer builder (`packages/map`)

**Files:**
- Create: `packages/map/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/{index.ts,style.ts,entities.ts,chevron.ts}`, `greige-style.json` (copy the skill's, retargeted), `test/entities.test.ts`
- Read first: `.claude/skills/terminal-gallery-map-ui/operational-map.md` §§1–3.

**Context:** The map's look is 80% the custom style; the entities are the only saturated marks. This task builds the *pure, testable* layer/style builders (no browser): functions returning MapLibre style + layer specs and the feature-state expressions, so correctness is unit-testable without WebGL.

**Build:**
- `style.ts`: `greigeStyle(tileUrl, glyphsUrl)` → the style JSON (land `--field`, water `--ink-dark`@6%, roads `--signal`@5–8%, labels micro-mono `signal-55`; no terrain/POI/color). Copy `greige-style.json` and parameterize sources.
- `entities.ts`: `fleetSource()` (clustered GeoJSON source spec with `promoteId:'id'` + `clusterProperties.maxStatus`), `entityLayers()` → the `clusters`/`cluster-count`/`rest`/`trucks`/`eta` layer specs with the **exact** data-driven + feature-state paint from `operational-map.md` §3 (the paint-only rule for feature-state; `['get','statusStr']` mirror for layout/chip). `STATUS_NUM`, `setEntityState(map,id,status,risk)`, `setWorldDim(map,on)`.
- `chevron.ts`: `chevronImage()` → an SDF/`ImageData` chevron pointing north at 0° (so `icon-rotate:['get','bearing']` reads correctly).

**Step 1: Failing tests** — assert the *specs*, not a render:

```ts
it("greigeStyle carries ONLY the 5 tokens, no default street layers (REQ-075/145)", () => {
  const hex = JSON.stringify(greigeStyle("t","g")).match(/#[0-9A-Fa-f]{6}/g) ?? [];
  expect(new Set(hex.map(h=>h.toUpperCase()))).toEqual(new Set(["#D5D1CC","#FF4A33","#1A1A1A"])); // teal appears in entity layer, not basemap
});
it("entity layers use feature-state ONLY in paint, mirrored props in layout (the paint-only rule)", () => {
  const layers = entityLayers();
  for (const l of layers) {
    const layout = JSON.stringify(l.layout ?? {});
    expect(layout).not.toContain("feature-state");   // never in layout
  }
  const chip = layers.find(l=>l.id==="chips"); expect(JSON.stringify(chip.layout)).toContain("[\"get\",\"chip\"]");
});
it("teal appears ONLY on the eta layer (REQ-078)", () => {
  for (const l of entityLayers()) if (l.id!=="eta") expect(JSON.stringify(l)).not.toContain("00C4B4");
});
it("setWorldDim exempts exception via feature-state on leaves and maxStatus on clusters (REQ-077)", () => { /* assert the expressions */ });
it("clusters size by count not color; single red family (REQ-076)", () => { /* circle-radius is a step on point_count; circle-color constant signal */ });
```

**Step 2: RED → implement → GREEN.** MapLibre as a devDep (types only for specs). No WebGL in these tests.

**Step 3: Commit** — "map: greige MapLibre style + entity layer builders (feature-state paint-only, teal=eta-only, cluster-by-count) — REQ-075/076/078".

---

### Task 4: Map package — scoped subscription hook + lens panel + exception dim wiring

**Files:**
- Create: `packages/map/src/{MapCanvas.tsx,useFleet.ts,LensPanel.tsx,generalize.ts}`, `test/{useFleet.test.ts,generalize.test.ts}`
- Read first: `operational-map.md` §§4–9.

**Build:**
- `MapCanvas.tsx` — a React component that mounts a MapLibre map with `greigeStyle`, adds the fleet source + entity layers + chevron image on load, wires the animation loop (throttled `setData` ~20–30fps, ease-to-target), the pulse sine (reduced-motion aware), and `click→onSelect` (REQ-080). Full-viewport (REQ-073). Props: `{ tileUrl, glyphsUrl, fleet, onSelect, dim }`.
- `useFleet.ts` — `useFleet(lens, source)` → the scoped FeatureCollection + a `setState(id,status,risk)` that applies feature-state + mirrors props + flags dirty. Enforces **party scoping**: a party/consignee lens only receives its own shipments (REQ-074).
- `generalize.ts` — `generalizePosition(feature, outForDelivery)` rounds `lng/lat` to ~city (1 decimal ≈ 11km) and drops precision until OFD, for party lenses (REQ-074, mirrors the WP-02 redaction).
- `LensPanel.tsx` — the right-side `--ink-dark` panel (uses design primitives) showing a selected shipment's event tail; the map never navigates away (REQ-080).

**Step 1: Failing tests:**
```ts
it("generalizePosition coarsens to ~city pre-OFD, exact post-OFD (REQ-074)", () => {
  const f = { geometry:{coordinates:[-97.7431,30.2672]}, properties:{} };
  expect(generalizePosition(f,false).geometry.coordinates).toEqual([-97.7,30.3]);
  expect(generalizePosition(f,true).geometry.coordinates).toEqual([-97.7431,30.2672]);
});
it("useFleet party lens excludes other parties' shipments (REQ-074)", () => { /* seed 3 parties, assert scope */ });
it("useFleet.setState applies feature-state + mirrors statusStr for the chip", () => { /* ... */ });
```
(MapCanvas render tests use jsdom + a MapLibre mock — assert it constructs the map with the greige style and registers a click handler; the real WebGL render is exercised by Task 6's Playwright.)

**Step 2: RED → implement → GREEN. Step 3: Commit** — "map: MapCanvas + useFleet scoped subscription + city-generalization + lens panel — REQ-073/074/080".

---

### Task 5: The 1K-entity perf harness (REQ-079)

**Files:**
- Create: `packages/map/perf/fleet-1k.ts` (synthetic 1,000-entity generator, seeded, deterministic), `packages/map/perf/perf.spec.ts` (Playwright), `packages/map/playwright.config.ts`
- Modify: root `package.json` (`perf:map` script, advisory)

**Context:** DoD requires 1K entities at 60fps desktop / 30fps mid-phone. Build a Playwright harness that mounts `MapCanvas` with 1,000 synthetic moving entities against a demo tile source, drives the animation for N seconds, samples frame times, and asserts p95 frame ≤ 16.6ms (desktop budget) — **advisory** (report the number; fail only in a `--strict` local run, never block CI per REQ-158).

**Step 1:** `fleet-1k.ts` — deterministic 1,000 entities across CONUS with targets, ~12% at-risk, 1 exception (no `Date.now`/`Math.random`; seeded mulberry32). Unit-test it's deterministic + has the state mix.

**Step 2:** `perf.spec.ts` — launch the command app (or a harness page) with the 1K fleet, run the loop, collect `requestAnimationFrame` deltas via `page.evaluate`, compute p50/p95, `console.log` them, assert advisory. Document how to run `pnpm perf:map`.

**Step 3: Commit** — "map: 1,000-entity perf harness (advisory frame-budget, deterministic fixture) — REQ-079".

---

### Task 6: The five canonical screens + Playwright screenshot diff (audit #6)

**Files:**
- Create/modify: `apps/command/src/App.tsx` (map home: full-viewport `MapCanvas` + KPI strip + queues stub + ⌘K bar), `apps/portal/src/App.tsx` (scoped map + name hero + quote panel stub), `apps/portal/src/status.tsx` (public status page — one shipment, city-gen), `apps/driver/src/App.tsx` (dark A2 ground + gated-stop stub), and a fifth screen (the delivery evidence email as a rendered artifact, doc 07 §03)
- Create: `tests/visual/screens.spec.ts` (Playwright), `tests/visual/blessed/` (5 reference PNGs), `playwright.config.ts` (root), root `package.json` (`test:visual` advisory)

**Context:** Assemble the five canonical screens from the design + map packages, capture blessed references, and diff on every run (advisory, REQ-158). This is the "5 canonical screens match blessed refs" DoD line.

**Step 1:** Build the five screens as real routes/components using `@shuddl/design` + `@shuddl/map` (deterministic seed fleet so screenshots are stable). Each obeys the surface recipe (doc 07 §03): Command greige map home; Portal scoped hero; Status one-shipment city-gen; Driver dark A2; Evidence email greige "DELIVERED".

> **Wire the exception world-dim (REQ-077, acceptance demo #5) — never `dim={false}`.** The world-dim is doc 07's signature loud-alarm moment. `MapCanvas`/`useFleet` must derive `dim` from a visible `exception` in the scoped fleet (`fleet.some(f=>f.status==='exception')`) so the world drops to 35% automatically when a visible exception exists and lifts when it clears; the Command screen must actually demonstrate it. A hardcoded `dim={false}` (the first-cut mistake) means the alarm never fires.

**Step 2:** `screens.spec.ts` — render each, screenshot at a fixed viewport, `toMatchSnapshot` against `blessed/`. First run writes blessed refs (commit them); subsequent runs diff. **Advisory**: mismatches print a report + write diffs, never fail CI (REQ-158). Wire `pnpm test:visual` and add it to the design-advisory CI job (report-only).

**Step 3:** `pnpm audit:design` clean across all app + package tsx; commit — "screens: 5 canonical surfaces on the map shell + Playwright screenshot diff (advisory) — REQ-073/077/080, DoD".

---

### Task 7: Close-out — activate WP-03 traceability, checklist, DoD evidence

**Files:**
- Modify: `tools/traceability/active-wps.json` → `["WP-01","WP-02","WP-03"]`
- Create: `docs/wp/WP-03.md`
- Modify: `docs/security/threat-model.md` (WP-03 review: map tile provenance, no-3rd-party-branding, tile/PII in status pages)

**Step 1:** Flip active-wps → `pnpm check:traceability` RED until every WP-03 REQ (073–080, 115, 145–149) has an implementation annotation; add each at its real site.

**Step 2: DoD evidence run** (paste into `docs/wp/WP-03.md`):
1. `pnpm --filter @shuddl/design test` + `@shuddl/map test` green.
2. `pnpm audit:design` — all six audits clean on the real screens (squint CI passes).
3. `pnpm test:visual` — 5 canonical screens match blessed refs (advisory report).
4. `pnpm perf:map` — 1K-entity p95 frame time reported (advisory).
5. `pnpm verify` → exit 0 (WP-01/02 gates + design advisory all green).

**Step 3:** WP-03 checklist, proposed register notes (self-hosted tiles/glyphs are deploy-time; screenshot+perf advisory until WP-10), REQ-119 exit-audit box; commit — "WP-03 close: traceability active, checklist + DoD evidence, threat model reviewed — REQ-118/119/131".

**Step 4:** REQ-119 exit adversarial audit before merge — no open Criticals at close (design-law bypasses, cross-lens map leakage, perf regressions, non-token color reaching a screen).

---

## Deferred / out of WP-03 scope

- Self-hosted Protomaps/OpenFreeMap tiles on R2 + offline service-worker cache → deploy / WP-05 (Driver PWA airplane-mode).
- Self-hosted JetBrains-Mono glyph PBFs → deploy line item.
- Live Durable-Object board fan-out (marks move as events land) → WP-10; WP-03 ships the `useFleet` seam + synthetic source.
- Command bar natural-language actions, queues, KPI click-through → WP-10 (WP-03 ships the visual shells).
- Design CI flip advisory→blocking → WP-10 exit (REQ-158).
