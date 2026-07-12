# WP-04 — Rater Service Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, and superpowers:subagent-driven-development for per-task execution + review. Close with superpowers:finishing-a-development-branch.

**Goal:** Build the config-driven rating engine (`packages/rater`) and its `/rate` service (`workers/api`): every price is computed from a tenant's versioned `rate_config` with **zero hardcodes**, carries its three floors, enforces the approval matrix server-side, refuses to price on missing physics, compares interline floors on the executing share (never gross), and pins the $222,084/35-lb anomaly as a permanent regression.

**Architecture:** `packages/rater` is a **pure, deterministic, LLM-free** engine (integer cents only, like `allocateCents`): `(shipment physics + rate_config) → { sell, floors{contribution,full,target}, money_lines[], versions, basis, approval }`. `workers/api` exposes `POST /v1/rate`, Zod-validated at the boundary, tenant-scoped; it emits `quote.priced` (+ `agent.acted` with basis, REQ-005) via the DO sequencer, and when a price is below floor it emits `approval.requested` and writes an `approvals` row — the gate is server-side (REQ-030), UIs only reflect it. SEED-1 (REQ-155) gains a deterministic `rating-config` so the whole engine is testable against a config **we control**.

**Tech Stack:** TypeScript strict (no `any`), Zod at every boundary, integer-cents arithmetic (contracts `Cents`), Hono + D1 + Durable Object sequencer (from WP-02), Vitest.

---

## The honest scope split (read before writing any code)

The audited engine's **48 embedded tests**, the **504-sweep**, the **tenant-0 tariff/roster**, and the **legacy-export replay** live in the tenant engagement workspace, **outside this repo** (genesis/13 §02; REQ-163 "reference never merge"). `fixtures/manifest.json` lists them all as `status: pending`. Therefore:

- **CLOSES NOW (built against SEED-1 + in-repo unit fixtures — no engagement data):** the engine; UNKNOWN-no-sell (REQ-004); the three floors on every price (REQ-027); the approval matrix + dual-approval (REQ-048); the interline executing-share floor and the **$222,084/35-lb permanent regression** (REQ-040, manifest says "encode as unit fixture"); a synthetic **monotonic sweep** standing in for the 504 invariant; the class adapter isolation (REQ-004); the `/rate` service with server-side gate + tenant isolation (REQ-030/025); version pinning (I5).
- **CANNOT CLOSE HERE — build the harness, mark pending, DO NOT fabricate data:** REQ-027 "48 legacy tests pass in service" and REQ-165 "reproduces tenant-0 quotes exactly." Task 11 builds a runner that executes these the moment the fixtures are vendored and **loud-skips** (printing the pending row) until then — the same discipline as `tools/fixtures/verify.ts`. **Marking either green without the real fixtures is a plan violation.**

Every "it works" claim in the final report cites a passing test file or a committed fixture, never a relayed assumption.

---

## Grounding facts (already in the repo — read these first, do not re-derive)

- `packages/contracts/src/events.ts`: `QuotePricedPayload = { sell:Cents, floors:{contribution,full,target}:Cents, versions:{rate_config_ids:string[≥1]}, basis:JsonObject }` (I5 comment at line 49). `AgentActedPayload` needs `basis[≥1 {kind:event|doc|config,id}]` (REQ-005). Event kinds include `quote.requested/priced`, `approval.requested/decided`, `agent.acted`.
- `packages/contracts/src/money.ts`: `MoneyLine.kind ∈ {freight,fsc,accessorial,cod_collect,credit_purchase}`, `Cents`.
- `packages/ledger/src/redact.ts:12`: `quote.priced` already redacts `["floors","basis","versions"]` for external lenses — the engine just produces them.
- Data model (doc 10): `rate_config(kind[zone_tariff|floors|fsc|accessorials|transit_matrix|class_adapter], version, payload, effective)`; `legs(kind[pickup|linehaul|interline|cartage|delivery|dray], executor→party, split_pct)`; `approvals(object,rule,required_role,requested_event,decided_event,status)`.
- Config-pack contract (doc 13 §02.4): `rating-config/` = tariffs, zone maps, rate groups, accessorial schedules, floors, FSC, margin rules, contract-pricing cases. SEED-1's rating-config must mirror this **shape** (not the tenant's data).
- `workers/api/src/index.ts`: Hono app; routes in `workers/api/src/routes/`; auth via `requireRole`; the DO sequencer append path is the WP-02 event API.
- `tools/seed/generate.ts` + `tools/seed/seed.hash`: SEED-1 generator with hash pinning; `pnpm seed` regenerates, `tools/seed/verify.ts` checks the hash (I extend this).

---

### Task 1: `rate_config` contracts (the config shape, zero hardcodes)

**Files:** Create `packages/contracts/src/rating.ts`, `packages/contracts/test/rating.test.ts`; modify `packages/contracts/src/index.ts` (export).

**Step 1 — failing test:** assert each `rate_config` kind parses and rejects junk. Schemas (all money in integer `Cents`):
```ts
// ZoneTariff: ZIP prefix → zone; rate groups hold weight-break rates ($/cwt in cents) per zone.
export const ZoneTariff = z.object({
  kind: z.literal("zone_tariff"), id: z.string(), version: z.string(),
  zip_to_zone: z.record(z.string().regex(/^\d{3,5}$/), z.string()),   // "800"->"Z4"
  rate_groups: z.array(z.object({
    id: z.string(),
    zones: z.array(z.string()).min(1),
    breaks: z.array(z.object({ min_lb: SafeInt, cwt_cents: Cents }))     // ascending min_lb
      .min(1),
    min_charge_cents: Cents,
  })).min(1),
}).strict();
export const FloorsConfig = z.object({ kind: z.literal("floors"), id, version,
  target_or_bps: Bps, full_cost_bps: Bps, contribution_bps: Bps }).strict(); // of computed cost
export const FscConfig = z.object({ kind: z.literal("fsc"), id, version, pct_bps: Bps }).strict();
export const AccessorialSchedule = z.object({ kind: z.literal("accessorials"), id, version,
  items: z.record(z.string(), Cents) }).strict();                          // "liftgate"->2500
export const ClassAdapter = z.object({ kind: z.literal("class_adapter"), id, version,
  class_to_density_pcf: z.record(z.string(), z.number()) }).strict();      // "70"->8, isolated (REQ-004)
export const RateConfig = z.discriminatedUnion("kind",
  [ZoneTariff, FloorsConfig, FscConfig, AccessorialSchedule, ClassAdapter]);
```
**Step 2 — run** `pnpm --filter @shuddl/contracts test` → fails (no module). **Step 3 — implement.** **Step 4 — pass.** **Step 5 — commit** "contracts: rate_config schemas (zone_tariff/floors/fsc/accessorials/class_adapter), version-pinned — REQ-005/REQ-027".

---

### Task 2: SEED-1 gains a deterministic `rating-config`

**Files:** Modify `tools/seed/generate.ts` (add `rating_config` to the seed object), `tools/seed/seed.hash` (re-pin), `tools/seed/seed.test.ts`.

**Step 1 — failing test:** `generateSeed()` includes a `rating_config` object with one of each kind, each **valid against Task-1 schemas**, deterministic (no `Date.now`/`Math.random`; index-seeded like the existing seed). A modest but real tariff: ~6 zones, a ZIP→zone sample (~40 prefixes), 2 rate groups with ascending weight breaks, a min charge, FSC (e.g. `pct_bps: 2400`), 4 accessorials, floors bps, a class adapter. **Step 2 — run** `pnpm --filter seed test` → fails. **Step 3 — implement** in `generate.ts`. **Step 4 — regen + repin:** `pnpm seed` then `pnpm --filter seed test` + `tools/seed/verify.ts` green (new hash committed). **Step 5 — commit** "seed: SEED-1 rating-config (zone tariff/floors/fsc/accessorials/class adapter) — REQ-155/REQ-165 test vehicle".

---

### Task 3: engine core — freight + UNKNOWN-no-sell

**Files:** Create `packages/rater/src/engine.ts`, `packages/rater/src/types.ts`, `packages/rater/test/freight.test.ts`; modify `packages/rater/src/index.ts`.

**Step 1 — failing tests** against SEED-1's zone tariff:
- missing weight OR dims → `{ status: "UNKNOWN", reason: "missing_physics" }`, **no price** (REQ-004, CLAUDE.md "no price on air").
- a known (origin ZIP, dest ZIP, weight) → correct zone (ZIP-prefix longest-match), correct rate group, correct weight break (`min_lb` floor), `freight_cents = max(round(weight_cwt × cwt_cents), min_charge_cents)`, integer cents (banker's rounding via an integer helper — reuse WP-02's rounding discipline, never floats to cents).
- weight below the first break → `min_charge_cents`.

**Step 2 — run** `pnpm --filter @shuddl/rater test` → fails. **Step 3 — implement** `priceFreight(shipment, zoneTariff)`; zone lookup by longest ZIP-prefix; no hardcoded rates (all from config). **Step 4 — pass.** **Step 5 — commit** "rater: zone+weight-break freight; UNKNOWN on missing physics (no price on air) — REQ-004".

---

### Task 4: FSC + accessorials → money_lines + sell

**Files:** Create `packages/rater/src/compose.ts`, `packages/rater/test/compose.test.ts`.

**Step 1 — failing test:** `compose(freight, shipment.service_flags, fsc, accessorials)` returns ordered `MoneyLine[]` (`freight`, then `fsc = round(freight × pct_bps/10000)`, then one `accessorial` per active flag from the schedule) and `sell = Σ lines` (integer cents). Unknown accessorial flag → error (no silent drop). **Steps 2–4** TDD. **Step 5 — commit** "rater: FSC + accessorials → money_lines, sell = Σ (integer cents) — REQ-027".

---

### Task 5: the three floors on every price + version pinning (I5)

**Files:** Create `packages/rater/src/floors.ts`, `packages/rater/test/floors.test.ts`.

**Step 1 — failing test:** every priced result carries `floors:{contribution,full,target}` derived from the computed cost basis and `FloorsConfig` bps (`full = round(cost×full_cost_bps/10000)`, etc.; `contribution ≤ full ≤ target` asserted), and `versions.rate_config_ids` lists **every** config id used (zone_tariff, floors, fsc, accessorials — min 1, I5). `basis` records the trace (zone, group, break, cost). No result may omit floors (REQ-027). **Steps 2–4** TDD. **Step 5 — commit** "rater: three floors attached to every price + rate_config version pinning — REQ-027/I5".

---

### Task 6: approval matrix + interline executing-share floor

**Files:** Create `packages/rater/src/approval.ts`, `packages/rater/test/approval.test.ts`.

**Step 1 — failing tests:**
- `sell ≥ target` → `{ approval: "none" }`.
- `contribution ≤ sell < target` → `{ approval: "single", rule, required_role }` (below target-OR).
- `sell < contribution` → `{ approval: "dual" }` (LOSS — dual approval, REQ-048).
- **Interline (REQ-040 / CLAUDE.md):** when `legs` contain an `interline`/`cartage` leg with `split_pct`, the floor comparison uses **the executing party's share** (`sell × own_split_pct`), never gross. A test proves a gross-vs-share swap changes the approval outcome (the anti-$222K guard at the matrix level).

**Steps 2–4** TDD. **Step 5 — commit** "rater: approval matrix (below-target single / below-contribution dual) on the executing share not gross — REQ-048/REQ-040".

---

### Task 7: the $222,084 / 35-lb permanent regression (REQ-040)

**Files:** Create `fixtures/anomaly/the-222084-case.json` (in-repo unit fixture — no engagement data), `packages/rater/test/anomaly.test.ts`; modify `fixtures/manifest.json` (`anomaly-222084-35lb` → `status: vendored`, source "generated in-repo", add sha256), `tools/fixtures/verify.ts` if it hashes vendored rows.

**Step 1 — failing test:** encode the case from its description — a 35-lb interline shipment whose **gross** figure explodes to $222,084 when the floor is (wrongly) compared to gross instead of the executing share / when a class/density input is malformed. Assert the engine **flags it** (`anomaly: "over_per_lb"` and/or forces `approval:"dual"`), and that the executing-share floor keeps the sane path sane. This regression is **permanent** — it must never be deleted (note in the test). **Steps 2–4** TDD. **Step 5 — commit** "rater: permanent $222,084/35-lb anomaly regression, encoded in-repo — REQ-040".

---

### Task 8: monotonic sweep (the 504 invariant, synthesized over SEED-1)

**Files:** Create `packages/rater/perf/sweep.ts` (deterministic grid over SEED-1: weights × zone pairs), `packages/rater/test/sweep.test.ts`.

**Step 1 — failing test (property):** across the grid, `sell` is **monotonic non-decreasing** in weight within a rate group, and non-decreasing with zone distance; every cell carries floors and pins versions; zero cells price on air. This is the in-repo stand-in for the real 504-sweep (which drops into Task 11 when vendored). **Steps 2–4** TDD. **Step 5 — commit** "rater: monotonic price sweep property over SEED-1 (504-invariant stand-in) — REQ-027".

---

### Task 9: class adapter isolation (REQ-004)

**Files:** Create `packages/rater/src/adapters/class.ts`, `packages/rater/test/class-adapter.test.ts`, `tools/checks/rater-purity.ts`; modify root `package.json` verify chain (add `check:rater-purity`).

**Step 1 — failing tests:** (a) `classToDensity("70", adapter)` maps via config only (no SMC3 table baked in); the adapter is the **only** module importing class logic. (b) a static lint (`rater-purity.ts`) fails if `packages/rater/src/engine.ts`/`compose.ts`/`floors.ts` import the class adapter or any `smc3`/`class` module — class is an **edge adapter, never the foundation** — and fails if `packages/rater/src/**` imports any LLM/agent client (mirrors the REQ-024 ledger purity lint). **Steps 2–4** TDD (prove the lint catches a planted violation, then remove it). **Step 5 — commit** "rater: class as isolated edge adapter + purity lint (no SMC3 foundation, no LLM) — REQ-004/REQ-024".

---

### Task 10: `/v1/rate` service — server-side gate, tenant-scoped, events

**Files:** Create `workers/api/src/routes/rate.ts`, `workers/api/test/rate.test.ts`; modify `workers/api/src/index.ts` (register `app.route("/v1/rate", …)` behind `requireRole("ops","admin","finance")`).

**Step 1 — failing tests** (workers-pool harness, per the WP-02 test contract):
- `POST /v1/rate` with a valid shipment → `200` `quote.priced` payload (validates against `QuotePricedPayload`); a `quote.priced` event + an `agent.acted` (agent "rater", basis cites the rate_config ids + the request, REQ-005) are appended via the sequencer.
- missing physics → `200` `{ status:"UNKNOWN" }`, **no `quote.priced` event emitted** (no price on air end-to-end).
- below-floor → additionally emits `approval.requested` + writes an `approvals` row (rule/required_role); the gate is enforced **here on the server** even though the engine also computes it (REQ-030 — a UI cannot bypass it).
- tenant isolation: a request under tenant A never reads tenant B's `rate_config` (REQ-025) — assert with two seeded tenants.

**Steps 2–4** TDD. **Step 5 — commit** "api: POST /v1/rate — server-side floor gate, tenant-scoped, emits quote.priced + agent.acted (+approval.requested below floor) — REQ-030/025/005".

---

### Task 11: pending real-fixture parity harness (REQ-027 / REQ-165) — build, do NOT fake

**Files:** Create `tools/rater/parity.ts` (runner) + `tools/rater/README.md`, `packages/rater/test/parity.harness.test.ts`; modify root `package.json` (`check:rater-parity` in verify).

**Step 1 — failing test:** the runner reads `fixtures/rater/48-tests/*.json` and `fixtures/rater/504-sweep/*` and the tenant-0 regression set when present, feeding each `(shipment, expected_quote)` through the engine and asserting parity; **when the fixtures are absent** (the current reality) it prints the `pending` manifest rows and **exits success as advisory** — never a false green — exactly like `tools/fixtures/verify.ts`. Prove the runner with a tiny **synthetic** `48-tests`-shaped stand-in in `packages/rater/test/` (not under `fixtures/`, so it doesn't masquerade as vendored) so the parity logic itself is tested. **Steps 2–4** TDD. **Step 5 — commit** "rater: parity harness for the 48-tests/504-sweep/tenant-0 set — runs when vendored, loud-skips pending (no false green) — REQ-027/REQ-165".

---

### Task 12: WP-04 exit audit + close-out (REQ-119)

**Files:** Create `docs/wp/WP-04.md`; modify `genesis/09-REQUIREMENTS-REGISTER.csv` only if new scope was discovered (append-only), `fixtures/README.md` if fixture statuses moved.

**Step 1:** run `pnpm verify` — all gates green (typecheck, lint, tests, invariants, traceability, identity, fixtures, seed, design). **Step 2:** REQ-119 adversarial exit-audit swarm over `packages/rater` + `/rate` (the 50-agent pattern): hunt hardcoded rates, float-to-cents drift, gross-vs-share leaks, a gate reachable by API but not enforced, a missing-physics path that still prices, cross-tenant config reads, class logic leaking into the core. Fix every Critical (no open Criticals at close). **Step 3:** write `docs/wp/WP-04.md` — DoD table marking **observed** (engine/floors/approval/anomaly/sweep/service/isolation) vs **[CONFIRM]-pending** (48-tests, tenant-0 parity, 504 real fixture, legacy-export replay), each linked to its test or manifest row. **Step 4 — commit** "WP-04: Rater service — engine + /rate closed against SEED-1; 48-tests/tenant-0 parity harness pending real fixtures — REQ-004/027/040/048/165".

Then **REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch.**

---

## Out of scope (do not build here — register rows own them elsewhere)
- Legacy-export replay ±2% aggregate (WP-02/04/15 gate) — needs M-11/M-12; the harness lands in Task 11, the run is a [CONFIRM] engagement step.
- Transit-standards matrix as honest booking windows → WP-08 (REQ-059). Rate-config carries the shape; the Scheduler consumes it.
- POD→invoice projection / invoice math parity → WP-06 (the Rater's output feeds it).
- Concierge email-in quoting → WP-07. Guided tariff builder / brokerage market+margin cold-start → WP-14 (REQ-151); this WP does the asset-mode "no tariff = UNKNOWN no sell" half only.
- Market layer / dynamic pricing beyond the tariff+floors engine.
