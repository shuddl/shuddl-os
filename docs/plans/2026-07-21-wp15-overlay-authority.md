# WP-15 — Overlay / authority tooling (zero-cutover) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task (fresh subagent per task, spec-review then code-quality-review between tasks). Written for an engineer with zero SHUDDL context.

**Goal:** The zero-cutover overlay — mirror the incumbent's legacy 171-col export into the ledger as `source:'legacy'` events, prove native-vs-legacy **parity** on a shadow `v_parity` dashboard, flip **authority per module** (legacy→native) only behind green gates, and **auto-fall-back to legacy on drift** — so SHUDDL earns authority module-by-module and can never silently diverge from the freight the incumbent is still running.

**Architecture:** Fully additive — **0 new surface, 0 new canonical view (a slug rename; 2 headroom slots), 0 new event kind (`authority.flipped` is the frozen kind #35), 0 new table (`authority_map` pre-provisioned; the spare stays reserved).** Five wired pieces: (A) a continuous 171-col mirror adapter in `packages/adapters` appending `source:'legacy'` events through the api `SHIPMENT_SEQ` DO; (B) project-back-out adapters with echo detection (no ping-pong); (C) a per-module authority flip = an `authority.flipped` **event** projected into `authority_map`, enforced by a shared server-side `resolveAuthority(module)` seam that fail-closes to `'legacy'`; (D) the `v_parity` shadow dashboard (a Command view split by `events.source`, UNKNOWN-honest); (E) a Watchtower `parity_drift` rule that auto-flips a drifting native module back to legacy.

**Tech Stack:** TypeScript strict (no `any`), Zod at boundaries, Cloudflare Workers + Durable Objects + D1 + cron, React 19 (Command), Vitest, pnpm workspaces.

---

## ⚠️ Two provability tiers — do NOT conflate them

The DoD ("Tenant-0 mirror runs 3 days unattended; parity dashboard live; a forced-drift test triggers auto-fallback") splits in two:

- **In-repo, fixture-provable, buildable NOW (this WP):** the heavy 171-col adapter, the echo-detection soak, the `v_parity` materialization, the `resolveAuthority` seam + the Gatekeeper flip guard, the Watchtower `parity_drift` sweep + auto-fallback, and the **synthetic forced-drift test** — all proven against the full-export replay ±2% fixture (CLAUDE.md rule 6).
- **Out-of-repo, tenant-calendar-governed, NON-compressible:** the *real* tenant-0 3-day unattended run, the 30-day shadow, two consecutive clean closes, the pilot-week <0.5% (REQ-152/153). These are **calendar objects that compress for no one** (`genesis/13:34`) and a merge cannot close them. This plan builds + proves the *machinery*; **quote milestone gates (M-H / M-AUTHORITY), never week numbers** (`genesis/14:64`). The close-out records the calendar gates as tenant-pack/go-live items.

## Non-negotiable invariants (verified in the understand sweep)
1. **Additive.** No 4th surface (dashboard is a Command view), no 13th view (`registry.ts` 10/12 used, 2 free; `v_parity` is a *rename*), no new kind (`authority.flipped` = kind #35, `events.ts:35`; mirror rides existing kinds tagged `source:'legacy'`), no new table (`authority_map` exists; spare stays 21/22). `assertViewBudget()` + `check:invariants` are CI law.
2. **The flip is an EVENT, never a config mutation.** `authority.flipped{module,from,to,reason,...}` is appended (append-only, co-signed, the L8 trail lives in `flipped_events[]`); `authority_map` is its **projection/read-model**. Never mutate `authority_map` without an event (keep-readmodel-consistent-with-ledger).
3. **Authority is a server-side Gatekeeper decision (REQ-030/L8), never a UI toggle.** A forward flip (legacy→native) is BLOCKED until `gates_status` is green; a backward flip (native→legacy, fallback) is ALWAYS allowed. The asymmetry is a hard invariant: **auto-fallback down on a single drift breach; NEVER auto-promote up.** Money authority (invoicing/settlement) flips only after two consecutive clean closes.
4. **Mirror = `source:'legacy'` events, not a shadow table.** The "shadow" is a provenance/confidence tier (`events.source`/`events.confidence` exist, `0001_ledger_core.sql:23-24`); parity compute is one query split by `source`. **Evidenced native outranks legacy** at projection time (REQ-021) — encode it or the shadow lies.
5. **No silent drops, continuously (rule 10 / REQ-035).** Every one of the 171 columns that maps to no canonical field raises an `anomalies` gap row **on every sweep** (not once), values retained inline in `refs`/`external_refs`.
6. **Tenant-0 specifics live OUTSIDE the repo.** The 171 literal column headers, pro-ranges, feed cadence, close dates are engagement-workspace config (`genesis/13`); the repo ships a **generic, config-driven** mapping — no tenant/incumbent name in any file (REQ-167). Never merge incumbent code (REQ-163 — reference, never merge).

---

## Task 0: Confirm scope (no new REQ rows)

WP-15 rows exist (REQ-008/021/022/023/058/152/153). No new rows — `authority.flipped` is already kind #35; the payload change is a schema *refinement*. If you discover genuinely new scope, STOP and append a REQ row first. Read-only; no commit.

---

## Task 1: `authority.flipped` typed payload + its `authority_map` projection (REQ-008/023)

**Files:** Modify `packages/contracts/src/events.ts` (refine the `authority.flipped` payload from the `JsonObject` stub at `:335`/`:446`); wire a projector — extend `packages/ledger/src/projection/` (the no-op stub at `money.ts:296` or a dedicated `projection/authority.ts`); Test the projection + `check:seed`.

**Context:** `authority.flipped` is the frozen kind #35 — refine ITS payload, do NOT add a kind. Payload: `{ module: 'rating'|'invoicing'|'dispatch'|'settlement'|'comms', from: 'native'|'legacy', to: 'native'|'legacy', reason: 'promote'|'drift'|'manual', gate_snapshot?, drift_ref? }`. The projection: on `authority.flipped`, UPDATE `authority_map.authority = to`, append the event id to `flipped_events[]`, snapshot `gates_status` (`authority_map` is the read-model, `0002_domain.sql:94`). **Confirm `check:seed` still verifies** (the payload refinement must keep the canonical byte law — an absent field stays absent).

**Key tests:** an `authority.flipped{rating, legacy→native}` projects `authority_map.rating.authority='native'` + the event id in `flipped_events`; the read-model is a pure function of the event stream (re-project → identical); `check:seed` green. RED first.

**Commit:** `feat(overlay): typed authority.flipped payload + authority_map projection (REQ-008/023)`

---

## Task 2: `resolveAuthority(module)` — the server-side enforcement seam (REQ-030/L8) — the core

**Files:** Create `packages/ledger/src/authority.ts` (`resolveAuthority(db, module): 'native'|'legacy'`, reading `authority_map`, **fail-closed to `'legacy'`** on unknown/missing/error); wire it into EVERY module compute path; Tests + an isolation/coverage test.

**Context — the highest-value + highest-risk gap.** Flipping `authority_map` is cosmetic until every module reads it. Add a shared reader (the `workers/api/src/gate-context.ts` "single shared authority" pattern) that the Rater (`/v1/rate`), Biller (`money.ts`), Scheduler, Settler, and Concierge each consult before computing/emitting — a module at `authority='native'` uses SHUDDL's native computation as authoritative; at `'legacy'` the legacy mirror is authoritative and native runs as shadow. **Fail-closed to `'legacy'`** (never trust an unknown authority). This is the Gatekeeper analogue for L8.

**Key tests:** a module at `native` computes native, at `legacy` defers to the legacy mirror, at unknown → `'legacy'` (fail-closed); **a coverage test that every module compute path calls `resolveAuthority`** (a single un-instrumented path is a silent authority bypass — assert the set); tenant-scoped (REQ-025). RED first.

**Commit:** `feat(overlay): resolveAuthority server-side seam — fail-closed per-module authority (REQ-030/008)`

---

## Task 3: The Gatekeeper flip guard — co-signed, blocked-until-green (REQ-023/030)

**Files:** Create `workers/api/src/routes/authority.ts` (the flip decision route) + the tenant-level co-signed append path (a control `authority.flipped` on `t:root`, not shipment-scoped, `0001_ledger_core.sql:6,28`); Tests.

**Context:** A flip is a server-side Gatekeeper decision. `POST /v1/authority/:module/flip` (admin, co-signed): a **forward** flip (legacy→native) is BLOCKED unless `authority_map.gates_status` for the module is green (the 30-day shadow / two-clean-closes / pilot gates — the gate objects come from the tenant calendar); a **backward** flip (native→legacy) is always allowed (fallback). Appends `authority.flipped` through the sequencer on `t:root` (a tenant-level control event). Money modules (invoicing/settlement) are absolute-blocked forward until two consecutive clean closes.

**Key tests:** a forward flip with RED gates → 403 blocked, no event; with GREEN gates → 201 + `authority.flipped`; a backward/fallback flip always allowed; a money-module forward flip without two clean closes → blocked; the flip is co-signed + append-only (never a direct `authority_map` write). RED first.

**Commit:** `feat(overlay): Gatekeeper flip guard — forward blocked until gates green, fallback always (REQ-023/030)`

---

## Task 4: The continuous 171-col mirror ingest adapter (REQ-021/022/035)

**Files:** Create `packages/adapters/src/legacy-mirror.ts` (the heavy continuous mapper, extends the WP-14 `migrator.ts` core) + `workers/agents/src/mirror-sweep.ts` (the per-tenant cron, the `recon-sweep`/translator-cron shape) appending `source:'legacy'` events through the api `SHIPMENT_SEQ` DO; Tests + a generic (REQ-167-clean) 171-col fixture.

**Context:** The HEAVY continuous overlay explicitly scoped into WP-15 (`migrator.ts:16-17`). Reuse the WP-14 `CONFIDENCE_FLOOR=0.8`, the gap-row no-silent-drop law, and the header→canonical mapping (scaled to 171 generic columns, config-driven — no vendor names). **Differs from WP-14:** it mirrors into the REAL ledger as `source:'legacy'` events (via the sequencer DO — the `workers/translator/src/inbound.ts` idempotent-append template), not a one-shot projection write. Continuous cadence: a per-tenant cron reading the feed, diffing against a **watermark** (O(changed rows)), appending new/changed rows. **Echo detection (REQ-022, highest continuous risk):** an event embeds its originating id; a re-ingested legacy row carrying an embedded SHUDDL event id is an ECHO and is NOT re-appended (build it INTO the append, mirror `inbound.ts` convergence-by-ref). Feed watermark/cursor rides `integrations.config` (do NOT amend the CHECK or spend the spare table).

**Key tests:** a 171-col export mirrors to `source:'legacy'` events; **every unmapped column raises exactly one `anomalies` gap row on every sweep** (continuous no-silent-drop; values retained); a re-ingested echo (embedded event id) is NOT re-appended (idempotent, no oscillation); the sweep is watermark-diffed (O(changed)); tenant-scoped (REQ-025). RED first.

**Commit:** `feat(overlay): continuous 171-col mirror → source:legacy events, echo-safe, gap-row law (REQ-021/022/035)`

---

## Task 5: Project-back-out adapters + the bidirectional echo soak (REQ-022)

**Files:** Create `packages/adapters/src/project-out.ts` (CSV/XML/EDI/PDF ledger→incumbent, embedding event ids); Test a bidirectional soak.

**Context:** The overlay writes the ledger back OUT so the incumbent stays internally consistent while authority migrates (`genesis/02:23-25`). Each projected-out row embeds its originating SHUDDL event id; the mirror-in (Task 4) recognizes it as an echo. **The soak proves NO ping-pong:** mirror-in → project-out → re-ingest converges, no oscillation, over a multi-cycle run.

**Key tests:** a projected-out row carries its event id; the bidirectional soak (in→out→in over N cycles) appends no duplicate/oscillating events (the DoD "no ping-pong in bidirectional soak"). RED first.

**Commit:** `feat(overlay): project-back-out adapters + bidirectional echo soak (REQ-022)`

---

## Task 6: The `v_parity` shadow dashboard compute (REQ-023/152/153)

**Files:** Rename the OR-drill slug in `apps/command/src/views/registry.ts` (`v_parity`→`v_operating_ratio` at `:20,:55`, per Decision #1) to reclaim `v_parity` for the overlay (genesis/10:40); create `workers/api/src/kpis/parity.ts` (the parity compute, the KPI-compute pattern); Tests.

**Context:** The parity compute is a pure durable read split by `events.source` (native vs legacy), NOT a lens extension. Per module: rating (`quote.priced` native vs legacy → ±10% routes), invoicing (`money_lines→events` split by source → ±2% aggregate + QB penny), settlement (`settlement.executed` → 2 clean closes). Metric shape `{module, native_value, legacy_value, drift_bps, match_pct, within_gate}`. **Honesty guardrail:** a missing side → `UNKNOWN`, never a fabricated 100% match. Thresholds = the existing fixture gates (CLAUDE.md rule 6).

**Key tests:** parity computes per module from `source`-split events; a missing side → UNKNOWN (no fabricated match); a within-gate vs drift result flags correctly; the OR-drill rename doesn't break its existing tests (`v_operating_ratio` still drills). RED first.

**Commit:** `feat(overlay): v_parity shadow-parity compute + reclaim the canonical slug (REQ-023/152/153)`

---

## Task 7: The Command parity dashboard tile (REQ-152/153)

**Files:** Create the parity view in `apps/command/src/views/` (mirror `KpiDrill.tsx` — per-module rows drilling to native+legacy backing events); Tests + the design audit.

**Context:** Renders on Command (BOARD/QUEUES/MONEY over the map) consuming `v_parity`. **Design CI is BLOCKING (REQ-158)** — it must pass squint/contrast/color-token(5)/case/radius(≤4px)/no-shadow/no-gradient. No 4th surface.

**Key tests:** the tile renders per-module parity rows + an UNKNOWN state honestly; a row drills to native + legacy backing events; `pnpm audit:design` clean (blessed screenshot). RED first.

**Commit:** `feat(overlay): Command parity dashboard tile over v_parity (REQ-152/153)`

---

## Task 8: Watchtower `parity_drift` rule + auto-fallback (REQ-008) — the forced-drift DoD

**Files:** Extend `workers/agents/src/watchtower.ts` (a 5th `parity_drift` rule); reuse/generalize `tools/rater/parity.ts` `runParity` (the anti-false-green divergence engine); Tests (the forced-drift test).

**Context:** The Watchtower is the drift-sweep (per-tenant cron, self-clearing deterministic `anomalies`). On drift > tolerance for a module at `authority='native'`: (a) `raiseAlarm(...,'parity_drift',...,'critical')` keyed `(tenant, module)`; AND (b) append a compensating `authority.flipped{module, native→legacy, reason:'drift', drift_ref}` via the sequencer → the Task-1 projection reverts `authority_map` to `'legacy'`. **The asymmetry (hard invariant):** fallback native→legacy is AUTOMATIC on a single breach; promotion legacy→native is NEVER automatic (the `parity_drift` anomaly self-clears when native re-converges, but the module does NOT auto-re-flip forward — that stays on the Task-3 gated route). LLM-free (pure arithmetic, REQ-024).

**Key tests (the forced-drift DoD):** seed `authority_map{rating, native}`; ingest diverging native+legacy events (>2%); drive the SAME exported `runWatchtowerSweep` the cron calls (non-tautological); assert (a) a CRITICAL `parity_drift` anomaly keyed `(tenant, rating)`; (b) `authority_map.rating='legacy'`; (c) an `authority.flipped{reason:'drift'}` event; (d) its id in `flipped_events[]`; (e) re-run idempotent (no double-flip); (f) **NO auto-re-promotion** when native re-converges (the anomaly clears, the authority stays legacy). RED first.

**Commit:** `feat(overlay): Watchtower parity_drift rule → auto-fallback to legacy (REQ-008)`

---

## Task 9: Mirror + parity tenant isolation (REQ-025)

**Files:** Extend `workers/api/test/isolation.test.ts` (the mirror write path + the parity read path).

**Context:** The mirror is a new tenant-scoped write path and the parity compute a new read path — both scoped by `session.tenant` only. Follow `prove-tenant-isolation-read-paths`.

**Key tests:** a tenant-A mirror ingest never writes tenant-B; a tenant-A parity read never reads tenant-B; the `authority_map`/flip is tenant-scoped. Non-tautological (a control that would FAIL on a leak). RED first.

**Commit:** `test(overlay): mirror + parity + authority tenant-isolation matrix (REQ-025)`

---

## Task 10: Verify + exit audit + close-out + merge

- **`pnpm verify`** green — confirm **21/22 tables, 35 kinds, 12 views** (WP-15 added ZERO; `v_parity` is a rename), **`check:seed` verifies**, `audit:design` clean (blocking). Sweep iCloud `"* 2.*"` dups first.
- **REQ-119 exit-audit swarm** with WP-15 lenses: (a) **echo/ping-pong** — can the bidirectional mirror oscillate over a soak?; (b) **`resolveAuthority` coverage** — is there ANY module compute path that emits without consulting authority (a silent authority bypass)?; (c) **flip is server-side + gated** — can a forward flip happen with red gates, or via a direct `authority_map` write bypassing the event?; (d) **the fallback asymmetry** — can a module auto-re-promote to native (must never); (e) **no-silent-drop continuous** — a column that stops mapping after a feed change must re-raise; (f) **evidenced-outranks-legacy** — does a native evidenced event correctly outrank a legacy mirror row?; (g) **tenant isolation**; (h) additivity (0 surface/view/table/kind; `check:seed`). Fix confirmed findings with proving tests.
- **Activate WP-15** in `tools/traceability/active-wps.json`; confirm traceability (every WP-15 REQ annotated).
- **Close-out** `docs/wp/WP-15.md` + **append to `docs/ops/GO-LIVE-CHECKLIST.md`** the **tenant-calendar / M-AUTHORITY gates** (the real 3-day unattended run, the 30-day shadow, two consecutive clean closes, pilot <0.5% — non-compressible, outside the repo), the **tenant-0 config pack** (the 171-col `adapters.yaml`, `continuity.yaml` pro-ranges REQ-058, `calendar.yaml` flip dates), and the live legacy-feed provisioning — each with REQ + status.
- **Merge to main locally** (the pre-authorized finish): verify green on the merge result, then `git checkout main && git merge wp-15-overlay && git branch -d wp-15-overlay`.

---

## Risk register (each with its discharge)
| Risk | Discharge |
|---|---|
| Echo / ping-pong (highest continuous risk) | Echo recognition built INTO the append (embedded event ids); the bidirectional soak asserts no oscillation (Task 4/5) |
| `resolveAuthority` skipped on a path (silent authority bypass) | A shared fail-closed reader + a coverage test asserting every module compute path consults it (Task 2/10) |
| A flip weakening L8 / money-as-projection | The flip is a co-signed EVENT, server-side Gatekeeper-gated, never a UI toggle or direct write; evidenced outranks legacy (Task 1/3) |
| Auto-re-promotion to native | The asymmetry invariant: auto-fallback down only; forward flips stay on the gated route — a test asserts no auto-re-promote (Task 8) |
| Continuous silent drop | Gap rows on EVERY sweep, values retained (Task 4) |
| Budget breach (surface/view/table/kind) | All additive; `v_parity` is a rename (2 free slots); `check:invariants`/`assertViewBudget`/`check:seed` are CI law (Task 10) |
| Money flipped before it's earned | Invoicing/settlement forward flips absolute-blocked until two consecutive clean closes (Task 3) |
| Tenant/incumbent identity leak | Generic config-driven mapping; the 171 headers/pro-ranges/dates are tenant-pack (outside the repo), REQ-167 (Task 4, close-out) |
| Design CI (blocking) | The `v_parity` tile passes the squint/contrast/token audits (Task 7) |
| Conflating in-repo machinery with the tenant-calendar DoD | Build + fixture-prove the machinery; quote M-H/M-AUTHORITY gates, not weeks; the calendar objects are close-out go-live items (whole plan) |
