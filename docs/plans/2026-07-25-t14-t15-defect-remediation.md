# T14/T15 Defect Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the four defects that Tasks 14 and 15 surfaced — a mis-attributed perf budget hiding a real 60%-main-thread waste, a visual gate that cannot produce a trustworthy baseline, and a deploy configuration whose prod scope is empty and whose platform database resolves two ways.

**Architecture:** Fix causes, not symptoms, and correct the record where the earlier diagnosis was wrong. The map work removes per-frame work that provably changes no pixel; the visual work makes capture deterministic *before* blessing any baseline; the config work converges one logical binding onto one physical resource and closes the prod structural gap in-repo while leaving id provisioning as an honest external hold.

**Tech Stack:** TypeScript 5.9, Node 22.15, pnpm 11, Vitest, Playwright 1.61 + @axe-core/playwright, MapLibre GL 5.24, Cloudflare Workers/D1/R2/KV/Queues/DO.

---

## Execution rules

- Work only in `.worktrees/codex-v1-remediation-v2-framework`.
- Use Node through `PATH=/Users/spencerpro/.nvm/versions/node/v22.15.0/bin:$PATH`.
- Follow red → green → refactor for every behaviour change.
- Run `pnpm -r --workspace-concurrency=2 --if-present run typecheck` rather than bare `pnpm typecheck` — the unbounded recursive runner hangs on a loaded machine.
- Never bless a screenshot you have not looked at.
- Never invent a Cloudflare resource id. An unprovisioned resource gets an all-zero placeholder so the preflight keeps BLOCKING it.
- After each task run its focused tests and `git diff --check`.

## Why this plan exists (the corrected record)

Task 14 committed a claim that is **false** and must be retracted in code comments, runbooks and the register:

> "the production bundle blocks the main thread just as long as the dev server does (~580ms) … a real, reproducible REQ-079 defect"

Measured refutation (CDP `devtools.timeline` traces, production build via `vite preview`):

| Control | Result |
|---|---|
| Worst long task, harness browser | `RunTask` 560.4ms, of which **`Commit` 527.5ms (94%)**; all JS in that task 32.8ms |
| Same page, **zero entities** | still 358–366ms long task |
| Pulse loop **and** repeated `setData` both disabled | still **520ms** |
| Same build, **real GPU** (`--use-angle=metal --enable-gpu`) | **0 long tasks, 87fps** |

The harness browser reports renderer `SwiftShader driver`; the GPU run reports `ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max)`. The long task is **compositor rasterization at first paint**, not `packages/map`. The 100ms budget is unreachable on SwiftShader at any code quality — its floor is ~360–520ms.

The real, code-owned REQ-079 defect is different and was masked by the wrong one:

- **The board burns 58–62% of the main thread drawing a static picture** (measured on a real GPU, 3 repeats).
- `applyPulse` (`MapCanvas.tsx:105-123`) sets two **data-driven** paint expressions every rAF. MapLibre binds `kind === 'source'` expressions to a per-feature vertex attribute (`SourceExpressionBinder`), so two 1,000-element paint buffers are repopulated and re-uploaded ~100×/second. **Owns ~30 points of occupancy.**
- `pushDataIfReady` (`MapCanvas.tsx:91-97`) full-`setData`s 1,000 features every ≥33ms onto a `cluster: true` source. MapLibre's `_applyDiffToSource` short-circuits for clustered sources, so **every tile reloads and re-parses**: 48 worker round-trips/second, ~21,800 `gl.bufferData` calls/second. **Owns ~23 points.**
- In `?perf` mode that second path accomplishes **nothing**: over 8s, `pushDataIfReady` fired 177 times with a max |Δcoordinate| across all 1,000 features of **exactly 0**, and screenshots with the pulse frozen are byte-identical (`sha256 732f11e7bba11bdb`) between "setData at 30Hz" and "setData once". `animateToward` has zero delta from frame one because the animated mirror is seeded from the same fleet the targets derive from (`MapCanvas.tsx:177-178`) and the loop has no convergence or dirty check.

---

## Task 1: Retract the false perf attribution

Do this first so no later task inherits a claim the evidence killed.

**Files:**
- Modify: `packages/map/playwright.config.ts:11-16`
- Modify: `docs/ops/slo.md` (the `> **Open:**` block)
- Modify: `docs/ops/GO-LIVE-CHECKLIST.md` (the "1,000-entity long task" row)

**Step 1: Rewrite the config comment**

Replace the paragraph beginning "Task 14: this serves a PRODUCTION BUILD" with:

```ts
// Task 14 served a production build here to rule out `vite dev` as the source of the long tasks. That
// comparison was INVALID: both runs painted through the harness's software rasterizer, so it compared two
// SwiftShader runs and concluded the code was at fault. Traced properly (Task 1 of the 2026-07-25 plan),
// the worst 560ms task is 527ms of compositor `Commit` at first paint — a map with ZERO entities still
// blocks 358ms, and the identical build on a real GPU produces zero long tasks at 87fps. The long-task
// budget is therefore unreachable on SwiftShader at any code quality; see `use.launchOptions` below.
```

**Step 2: Correct `docs/ops/slo.md`**

Replace the `> **Open:**` block with:

```markdown
> **Corrected 2026-07-25.** An earlier note here claimed the 1,000-entity board blocked the main thread
> for ~580ms as product behaviour. That was a mis-attribution: the block is compositor rasterization in a
> GPU-less harness (527ms of a 560ms task is `Commit`, and a zero-entity board still blocks 358ms). On a
> real GPU the same build produces zero long tasks at 87fps. The long-task budget is enforced only where
> a hardware rasterizer is present — see the enforcement column.
>
> **The real REQ-079 finding:** the board spends 58–62% of the main thread rendering a *static* picture.
> The per-frame data-driven pulse and the 30Hz full-`setData` are the two owners. Tasks 2–3 remove them.
```

**Step 3: Correct the GO-LIVE row**

Change the `1,000-entity long task` row's Detail cell to:

```
compositor rasterization in a GPU-less harness, NOT map code (a zero-entity board blocks 358ms; a real
GPU blocks 0ms). Superseded by the real finding: 58-62% main-thread occupancy drawing a static picture.
```

**Step 4: Commit**

```bash
git add packages/map/playwright.config.ts docs/ops/slo.md docs/ops/GO-LIVE-CHECKLIST.md
git commit -m "docs(perf): retract the mis-attributed long-task finding

The Task 14 claim that the 1,000-entity long task reproduced on a production
build and was therefore product behaviour compared two SwiftShader runs. Traced:
527ms of the 560ms task is compositor Commit at first paint, a zero-entity board
still blocks 358ms, and the same build on a real GPU blocks 0ms at 87fps.
The real REQ-079 finding is 58-62% main-thread occupancy on a static picture."
```

---

## Task 2: Make the long-task budget measurable

A budget that cannot pass in its own harness is not a budget. Give the harness a real rasterizer, and when one is unavailable report the assertion as skipped-with-cause rather than failing the code for the runner's graphics stack — the same discipline the FPS budget already uses.

**Files:**
- Modify: `packages/map/playwright.config.ts`
- Modify: `packages/map/perf/perf.spec.ts`

**Step 1: Request a hardware rasterizer**

Add to `use` in `packages/map/playwright.config.ts`:

```ts
    launchOptions: {
      // SwiftShader's compositor Commit floor (~360-520ms at first paint) makes the 100ms long-task
      // budget unreachable regardless of code quality. Ask for the real GPU; the spec verifies whether
      // it was granted and refuses to assert the budget against a software rasterizer.
      args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-features=Vulkan"],
    },
```

**Step 2: Write the failing assertion — detect the renderer**

Add to `packages/map/perf/perf.spec.ts`, after the canvas wait:

```ts
  // WebGL's unmasked renderer string is the ground truth for whether the long-task budget is meaningful.
  const renderer = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2") ?? document.createElement("canvas").getContext("webgl");
    if (!gl) return "no-webgl";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unknown";
  });
  const softwareRasterizer = /swiftshader|llvmpipe|software/i.test(renderer);
  console.log(`perf: renderer = ${renderer} (software=${String(softwareRasterizer)})`);
```

**Step 3: Gate the long-task assertion on it**

Replace the unconditional long-task expectation with:

```ts
  if (softwareRasterizer) {
    // Not a pass and not a failure of this code: the budget is unmeasurable here. Say so loudly so the
    // gate result records a real disposition instead of a fabricated green.
    console.log(`perf: long-task budget NOT ASSERTED — ${renderer} has a ~360-520ms compositor floor at first paint.`);
    console.log("perf: run on a GPU-capable machine, or in CI with a hardware rasterizer, to enforce it.");
  } else {
    expect(worst, `no main-thread task may exceed ${LONG_TASK_MS}ms while the board is live`).toBeLessThanOrEqual(LONG_TASK_MS);
  }
```

**Step 4: Verify**

```bash
pnpm perf:map
```

Expected on this machine: `renderer = ANGLE (Apple, ANGLE Metal Renderer…)`, `software=false`, and the long-task assertion **enforced**. If it still reports SwiftShader, the run prints NOT ASSERTED and the interaction budget still gates.

**Step 5: Commit**

```bash
git add packages/map/playwright.config.ts packages/map/perf/perf.spec.ts
git commit -m "test(perf): measure the long-task budget on a real rasterizer (REQ-079)"
```

---

## Task 3: Stop the setData that moves nothing

**Files:**
- Modify: `packages/map/src/MapCanvas.tsx`
- Test: `packages/map/test/glide.test.ts` (create)

**Step 1: Write the failing test**

`animateToward` must report whether it actually changed anything, so the caller can skip a full `setData`.

```ts
import { describe, expect, it } from "vitest";
import { animateToward } from "../src/glide.js";

const fc = (coords: [number, number][]) => ({
  type: "FeatureCollection" as const,
  features: coords.map((c, i) => ({
    type: "Feature" as const,
    id: `s${i}`,
    geometry: { type: "Point" as const, coordinates: [...c] as [number, number] },
    properties: { id: `s${i}`, statusStr: "healthy" },
  })),
});

describe("animateToward reports whether it moved anything", () => {
  it("returns false when every feature is already at its target", () => {
    const f = fc([[-98, 39]]);
    const targets = new Map([["s0", [-98, 39] as [number, number]]]);
    expect(animateToward(f as never, targets)).toBe(false);
  });

  it("returns true while a feature is still converging, and false once it arrives", () => {
    const f = fc([[-98, 39]]);
    const targets = new Map([["s0", [-90, 39] as [number, number]]]);
    expect(animateToward(f as never, targets)).toBe(true);
    for (let i = 0; i < 500; i += 1) animateToward(f as never, targets);
    expect(animateToward(f as never, targets)).toBe(false);
  });

  it("snaps to the target rather than approaching it forever", () => {
    const f = fc([[-98, 39]]);
    const targets = new Map([["s0", [-90, 39] as [number, number]]]);
    for (let i = 0; i < 500; i += 1) animateToward(f as never, targets);
    expect(f.features[0]!.geometry.coordinates[0]).toBeCloseTo(-90, 6);
  });
});
```

**Step 2: Run it and watch it fail**

```bash
pnpm --filter @shuddl/map test
```
Expected: FAIL — `animateToward` is not exported from `src/glide.ts` (it currently lives unexported in `MapCanvas.tsx`).

**Step 3: Extract and implement**

Move `animateToward` into `packages/map/src/glide.ts`, returning a boolean and snapping when within epsilon:

```ts
/** Ease each feature toward its target. Returns TRUE only if some coordinate actually changed, so the
 * caller can skip a full setData — on a clustered source that skip avoids a whole-source tile reload. */
const EPSILON = 1e-7;

export function animateToward(fleet: FleetCollection, targets: Map<string, [number, number]>): boolean {
  let moved = false;
  for (const f of fleet.features) {
    const t = targets.get(String(f.id));
    if (!t) continue;
    const [x, y] = f.geometry.coordinates as [number, number];
    const nx = x + (t[0] - x) * 0.18;
    const ny = y + (t[1] - y) * 0.18;
    if (Math.abs(t[0] - nx) < EPSILON && Math.abs(t[1] - ny) < EPSILON) {
      if (x !== t[0] || y !== t[1]) moved = true;
      f.geometry.coordinates = [t[0], t[1]];
      continue;
    }
    f.geometry.coordinates = [nx, ny];
    moved = true;
  }
  return moved;
}
```

**Step 4: Use the signal in the tick loop**

In `MapCanvas.tsx`, import from `./glide.js` and make the push conditional:

```ts
    const tick = (now: number): void => {
      const moved = animateToward(animatedRef.current, targetsRef.current);
      // A clustered source cannot diff (MapLibre's _applyDiffToSource short-circuits on cluster:true), so
      // every setData reloads and re-parses EVERY tile. Pushing an unchanged collection costs a full
      // source rebuild and changes not one pixel — measured at 48 worker round-trips/second in ?perf.
      if (moved && now - lastDataRef.current >= 33) {
        pushDataIfReady(map, animatedRef.current);
        lastDataRef.current = now;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
```

**Step 5: Verify the tests pass and the behaviour holds**

```bash
pnpm --filter @shuddl/map test
pnpm perf:map
```
Expected: map tests green. Perf log shows the interaction budget still passing; main-thread occupancy drops (the diagnosis attributes ~23 points to this path).

**Step 6: Commit**

```bash
git add packages/map/src/glide.ts packages/map/src/MapCanvas.tsx packages/map/test/glide.test.ts
git commit -m "perf(map): skip the setData that moves nothing (REQ-079)

In ?perf mode pushDataIfReady fired 177 times over 8s with a max coordinate
delta of exactly 0, and the rendered frames were byte-identical. Because the
fleet source is clustered, MapLibre cannot diff it, so each of those no-op
pushes reloaded and re-parsed every tile of the source."
```

---

## Task 4: Stop the per-frame per-feature paint upload

**Files:**
- Modify: `packages/map/src/MapCanvas.tsx` (`applyPulse`)
- Modify: `packages/map/src/entities.ts` (layer split)
- Test: `packages/map/test/pulse.test.ts` (create)

**Step 1: Understand the mechanism before changing anything**

`applyPulse` sets `circle-stroke-width` on layer `rest` to a `match` over `["coalesce",["feature-state","status"],["get","statusStr"],"healthy"]`. That expression's kind is `source`, so MapLibre's `ProgramConfiguration` binds it with a `SourceExpressionBinder` — a **per-feature vertex attribute array** repopulated and re-uploaded for all 1,000 features on every change, ~100×/second. A **constant** expression binds to a GL uniform instead and costs nothing per feature.

**Step 2: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { pulseWidths } from "../src/pulse.js";

describe("pulse widths are constants, never per-feature expressions", () => {
  it("returns plain numbers so MapLibre binds a uniform, not a vertex attribute", () => {
    const w = pulseWidths(0);
    expect(typeof w.exception).toBe("number");
    expect(typeof w.atRisk).toBe("number");
  });

  it("throbs the exception on a 1.6s period and breathes at-risk on 3s", () => {
    expect(pulseWidths(800).exception).toBeLessThan(pulseWidths(0).exception);
    expect(pulseWidths(0).exception).toBeCloseTo(6, 5);
    expect(pulseWidths(1500).atRisk).toBeLessThan(pulseWidths(0).atRisk);
  });
});
```

**Step 3: Implement `packages/map/src/pulse.ts`**

```ts
/** The two pulses off one sine, as CONSTANTS. Keeping these scalar is the whole point: a data-driven
 * paint expression is bound per-feature and re-uploaded for all 1,000 entities every frame. */
export function pulseWidths(ts: number): { exception: number; atRisk: number } {
  const urgent = 0.5 + 0.5 * Math.sin((ts / 1600) * 2 * Math.PI);
  const calm = 0.5 + 0.5 * Math.sin((ts / 3000) * 2 * Math.PI);
  return { exception: 2 + 4 * urgent, atRisk: 1 + 1.5 * calm };
}
```

**Step 4: Split the layer so each pulse target is its own constant**

In `entities.ts`, replace the single `rest` circle layer with three layers filtered on the **static** `statusStr` property (`feature-state` is not usable in a layer filter): `rest-healthy` (constant width 1), `rest-at-risk`, `rest-exception`. Keep draw order and every other paint value byte-identical to today.

Then `applyPulse` becomes two constant writes:

```ts
function applyPulse(map: maplibregl.Map, ts: number): void {
  const w = pulseWidths(ts);
  map.setPaintProperty("rest-exception", "circle-stroke-width", w.exception);
  map.setPaintProperty("rest-at-risk", "circle-stroke-width", w.atRisk);
}
```

**Step 5: Verify — and expect the pixels to move**

```bash
pnpm --filter @shuddl/map test
pnpm perf:map
pnpm audit:design
```
Expected: tests green; occupancy drops (the diagnosis attributes ~30 points here); `audit:design` still clean. **This task deliberately precedes any screenshot blessing** — blessing first would invalidate every baseline.

**Step 6: Commit**

```bash
git add packages/map/src/pulse.ts packages/map/src/entities.ts packages/map/src/MapCanvas.tsx packages/map/test/pulse.test.ts
git commit -m "perf(map): pulse via constant paint values, not per-feature expressions (REQ-079)"
```

---

## Task 5: Repair the three stale visual ready-selectors

Measured current renders (Playwright page snapshots), all three fail-closed states introduced at Task 10:

| Screen | Waits for | Actually renders |
|---|---|---|
| `portal.png` (`?screen=portal`) | `canvas` | `ReAuthPrompt` — "SESSION EXPIRED / SIGN IN AGAIN" (`?screen=portal` is not a known value; `router.ts:41` falls through to the authed board) |
| `status.png` (`?screen=status`) | `canvas` | `Unavailable()` — "STATUS UNAVAILABLE" (`router.ts:36` yields `cap = null`) |
| `driver.png` (`/`) | `text=Photograph` | `MessageScreen` "Sign in" (that string lives three interactions deep in `GatedFlow`) |

`command.png` and `evidence-email.png` resolve correctly and must not change.

**Files:**
- Modify: `tests/visual/screens.spec.ts`

**Step 1: Give each screen its own setup**

Replace the flat `SCREENS` array with entries carrying an optional `setup(page)` that seeds the session and intercepts the reads, mirroring `tests/e2e/driver-offline-sync.spec.ts` (token key `shuddl.driver.session.token`) and `tests/e2e/portal-isolation.spec.ts` (token key `shuddl.portal.token`). Each screen must render its REAL authed surface, deterministically:

- `portal.png` — seed `shuddl.portal.token`, fulfil `**/v1/board` with a fixed 3-shipment payload, ready on `canvas`.
- `status.png` — fulfil `**/pub/status/**` with a fixed delivered-status payload and navigate to `/status/e2e-cap`, ready on `canvas`.
- `driver.png` — seed the driver token, fulfil `**/v1/driver/manifest` with the fixed two-stop manifest, ready on `getByRole("heading", { name: "Day sheet" })`.

**Step 2: Verify each screen resolves**

```bash
pnpm test:visual
```
Expected: no `TimeoutError` for any of the five. All five now fail only with "A snapshot doesn't exist" — which Task 7 resolves.

**Step 3: Commit**

```bash
git add tests/visual/screens.spec.ts
git commit -m "test(visual): repair the three ready-selectors that rotted at Task 10 (REQ-158)"
```

---

## Task 6: Make the capture deterministic

A baseline is worthless if a third party can break CI. Measured: the basemap is fetched live from `https://tiles.openfreemap.org/planet` (`demo.ts:119`), which serves a moving `latest` build, and it owns **3.57% of the 1440×900 frame** against a `maxDiffPixelRatio` of **0.02**. A tile update alone therefore fails the diff. No font is self-hosted either.

**Files:**
- Modify: `playwright.config.ts` (the `visual` project)
- Modify: `tests/visual/screens.spec.ts`

**Step 1: Abort every third-party tile/glyph request in the visual project**

In the visual screens spec, before each navigation:

```ts
  // The greige ground, the entity layers and the chrome are OURS and are what the blessed refs assert.
  // The basemap is a live third-party fetch of a moving `latest` build that owns ~3.6% of the frame —
  // more than the 2% diff tolerance — so leaving it in makes a stranger's deploy able to fail our CI.
  await page.route(/tiles\.openfreemap\.org/, (route) => route.abort());
```

**Step 2: Prove determinism before blessing**

```bash
pnpm test:visual                     # writes refs on first run
pnpm test:visual                     # second run must match
```
Expected: run 2 reports 5 passed. Then delete the refs and repeat once more to confirm run-to-run stability from cold.

**Step 3: Commit**

```bash
git add playwright.config.ts tests/visual/screens.spec.ts
git commit -m "test(visual): block the moving third-party basemap from the blessed capture (REQ-158/075)"
```

---

## Task 7: Bless and review the five baselines

**Files:**
- Create: `tests/visual/blessed/{command,portal,status,driver,evidence-email}.png`

**Step 1: Generate**

```bash
pnpm exec playwright test -c playwright.config.ts --project visual --update-snapshots
```

**Step 2: LOOK at all five**

Open each PNG. Confirm: greige ground, coral only where an exception is, no third-party attribution, no `NETWORK REQUEST FAILED` panels, no spinner mid-flight, correct 1440×900. **A baseline you have not looked at is a bug you have promoted to a specification.** If a screen shows an error state, fix its setup in Task 5 and regenerate — do not bless the error.

**Step 3: Verify the gate is genuinely green**

```bash
pnpm test:visual -- --mode merge
```
Expected: `visual: PASS — 5 passed` and a `##SHUDDL-GATE##` line with `"assertions":5`.

**Step 4: Commit**

```bash
git add tests/visual/blessed/
git commit -m "test(visual): bless the five canonical screens (REQ-158)"
```

---

## Task 8: Converge PLATFORM_TENANT_DB onto one database

`shuddl-t-platform-<env>` is authoritative. Proof: the repo already shipped this exact sentinel transform — control slugs `_pool_01`/`_pool_02` (`db/control/migrations/0003_tenant_pool.sql:26-27`) map to `shuddl-t-pool-01-dev`/`shuddl-t-pool-02-dev` (`workers/api/wrangler.toml:41,46`), dropping the leading underscore. `.github/workflows/nightly.yml:62` and `docs/ops/dr-backups.md:13` both name `shuddl-t-platform-staging`. No runtime code reads `database_name` at all — both resolvers return the binding object (`workers/api/src/tenants.ts:69`, `workers/billing/src/tenants.ts:56`) — so nothing depends on the underscore form.

The second, more dangerous half: billing's staging `database_id` is a well-formed UUID that **passes** the placeholder check, so an unprovisioned database looks provisioned, while api's all-zero id is correctly flagged. `docs/ops/DEPLOYMENT.md:14-21` confirms no platform D1 exists in staging.

**Files:**
- Modify: `workers/billing/wrangler.toml:54,100,101`
- Modify: `tools/deploy/preflight.test.ts:383-388`

**Step 1: Converge name *and* id**

`preflight.ts:231` compares `${databaseName}|${databaseId}`, so the name alone will not clear the drift. Set billing's dev/staging `database_name` to the api form and its staging `database_id` to api's all-zero placeholder. This deliberately **adds** a `placeholder-resource-id` BLOCK — correct: the database genuinely does not exist.

**Step 2: Invert the test that pins the defect**

`tools/deploy/preflight.test.ts:383-388` currently asserts the drift **is present**. Rename it to "…is CLOSED" and assert `.not.toContain("binding-drift")`. Leave the synthetic drift case at `:210-226` intact — it hand-builds its inputs and is the real regression lock.

**Step 3: Verify**

```bash
pnpm exec tsx tools/deploy/preflight.ts --env staging
pnpm test:tools
```
Expected: the `binding-drift PLATFORM_TENANT_DB` line disappears (9 BLOCKs → 8); a new `placeholder-resource-id` BLOCK names the billing binding; tools suite green.

**Step 4: Commit**

```bash
git add workers/billing/wrangler.toml tools/deploy/preflight.test.ts
git commit -m "fix(deploy): converge PLATFORM_TENANT_DB onto one physical database"
```

---

## Task 9: Fix the preflight's own false positive

Found while measuring: `--env dev` reports `binding-drift` for `TENANT_A_DB`, `TENANT_B_DB` and `CONTROL_DB` purely because each worker carries a different `local-*` **alias** id for the same `database_name`. Local aliases are per-worker by design; only a divergent `database_name`, or divergent real ids, is drift.

Also: `REQUIRED_BINDINGS.billing.secrets` is `[]` while `docs/ops/DEPLOYMENT.md:102` requires `STRIPE_WEBHOOK_SECRET` and `PLATFORM_INTERNAL_SECRET`; `agents` is missing `RESEND_API_KEY` the same way.

**Files:**
- Modify: `tools/deploy/preflight.ts`
- Modify: `tools/deploy/preflight.test.ts`

**Step 1: Write failing tests** — a dev target where one binding name maps to several `local-*` ids must produce **no** `binding-drift`; the same names with divergent real UUIDs still must. Add a test asserting `REQUIRED_BINDINGS.billing.secrets` contains both secrets and `agents.secrets` contains `RESEND_API_KEY`.

**Step 2: Implement** — in the drift comparison, compare `databaseName` always, and compare ids only when neither is a `local-` alias. Add the missing secrets to the contract.

**Step 3: Verify**

```bash
pnpm test:tools && pnpm exec tsx tools/deploy/preflight.ts --env dev
```
Expected: dev reports no `binding-drift`; staging/prod still report the real ones; `missing-secret` now names the billing and agents secrets.

**Step 4: Commit**

```bash
git add tools/deploy/preflight.ts tools/deploy/preflight.test.ts
git commit -m "fix(deploy): local-* aliases are not binding drift; complete the required-secret contract"
```

---

## Task 10: Catch an empty deploy scope at merge time

The prod gap is invisible to CI because the preflight is a **release**-profile gate run by hand. A binding-name parity check belongs in the merge profile, where a scope that forgets a binding fails the PR.

**Files:**
- Modify: `tools/deploy/preflight.ts` (export the matcher)
- Create: `tools/deploy/wrangler-scope-parity.test.ts`

**Step 1: Publish the matcher — one rule, one implementation**

`WORKER_CONFIGS` is module-local at `preflight.ts:445` and `preflight.test.ts:369-375` re-lists the same five paths by hand — exactly the duplication the repo's share-lint-matchers discipline forbids. Export `WORKER_CONFIGS`, add `DEPLOYABLE_SCOPES = ["staging", "prod"] as const`, and add `bindingSets(t: WorkerTarget)` returning the six name sets. Have the test import them rather than restate them.

**Step 2: Write the failing parity test**

For each config and each deployable scope, assert the scope declares the **same set of binding names** as the top-level dev scope. Expected first run: **10 failures** — four workers with no prod scope, plus api's empty one.

**Step 3: Verify it runs in the merge gate**

```bash
pnpm test:tools
```
`vitest.tools.config.ts` includes `tools/**/*.test.ts`, and `run-gate.ts:46` puts `test` in the merge profile — no CI wiring needed.

**Step 4: Commit** (red is expected here; Task 11 turns it green.)

---

## Task 11: Give every worker a complete `[env.prod]`

Wrangler does not inherit top-level bindings into a named environment, so a scope that declares none genuinely has none. Mirror `[env.staging]` structurally in all five configs — **binding names and resource names only, every id an all-zero placeholder**, so the preflight keeps BLOCKING until the resources are actually provisioned.

**Files:** `workers/{api,agents,billing,mcp,translator}/wrangler.toml`

Deliberate omissions, each a fail-closed posture to preserve:
- agents prod gets **no** `EVIDENCE_FROM` → `evidenceSender()` stays `NotConfiguredSender`.
- translator prod gets **no** `EDI_TRANSPORT_URL`/`_TOKEN` → the CONFIRM-gated transport stays dark (REQ-154).
- No `ALLOW_TEST_SEND`/`TEST_SEND_*` anywhere in prod — the preflight already BLOCKS those.

**Verify**

```bash
pnpm test:tools
pnpm exec tsx tools/deploy/preflight.ts --env prod
```
Expected: parity test green (10 failures → 0); preflight reports `workers=5` with no "declares no [env.prod] scope" warnings, and every remaining BLOCK is a `placeholder-resource-id` or a genuinely absent secret. **`[env.prod]` is still not deployable — that is the honest state.**

**Commit**

```bash
git add workers/*/wrangler.toml tools/deploy/preflight.ts tools/deploy/wrangler-scope-parity.test.ts
git commit -m "fix(deploy): declare complete prod scopes for all five workers (REQ-114)"
```

---

## Task 12: Reconcile the record and re-run every gate

**Files:** `docs/ops/DEPLOYMENT.md`, `docs/ops/GO-LIVE-CHECKLIST.md`, `genesis/09-REQUIREMENTS-REGISTER.csv`

**Step 1: Update the defect lists** — delete the PLATFORM_TENANT_DB drift bullet (fixed); restate prod as "structurally complete, every id a placeholder pending provisioning"; move the visual rows out of "repository-owned failures" once green.

**Step 2: Every hold maps to exactly one gate**

Re-run `--env staging` and `--env prod` and confirm each remaining BLOCK maps to exactly one surviving row in the holds table — no hold without a gate, no gate without a hold.

**Step 3: Full verification**

```bash
pnpm -r --workspace-concurrency=2 --if-present run typecheck
pnpm lint
pnpm test
pnpm verify:dev
pnpm test:a11y -- --mode merge
pnpm test:e2e -- --mode merge
pnpm test:visual -- --mode merge
pnpm perf:map -- --mode merge
git diff --check
```
Expected: `verify:dev` green; a11y/e2e/visual PASS; perf PASS on a GPU machine (long-task NOT ASSERTED on a software rasterizer, with the interaction budget still enforced).

**Step 4: Commit**

```bash
git add docs/ops genesis/09-REQUIREMENTS-REGISTER.csv
git commit -m "docs(ops): reconcile holds and defects after the T14/T15 remediation"
```

---

## Out of scope (do not do here)

- Provisioning real Cloudflare resources or inventing ids — external hold, owner: infrastructure.
- Self-hosting Protomaps tiles and glyphs (REQ-075). Task 6 blocks the third-party basemap from the *capture*; the production tile source stays a documented hold.
- Tasks 16–17 of the V1 remediation plan (register reconciliation, final evidence sweep) — they consume this work's output.
