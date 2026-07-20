# WP-14 — PLG + metering (signup → first quote) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task (fresh subagent per task, spec-review then code-quality-review between tasks). Written for an engineer with zero SHUDDL context.

**Goal:** A stranger signs up, gets a provisioned workspace, drag-drops their messy data, and reaches a first quote unassisted in <10 min (acceptance demo #2) — with usage metered to match event counts *exactly* and Spark caps that throttle **conveniences, not truth** — and the whole PLG machinery ships **DARK** (fail-closed, flag-off) until the R4 go-live gate.

**Architecture:** Fully additive — **0 new tables, 0 new event kinds, no 4th surface.** A new `workers/billing` worker (mirrors `workers/mcp`: `workers_dev=false`, `CONTROL_DB` auth-only, `API` service binding, no secrets in toml) hosts Stripe + the metering sweep. Signup is a **pre-auth provisioning route** (peer to `/pub/*`) that claims a **pre-provisioned pool** tenant D1 (preserving the REQ-025 static-allowlist parity invariant). Credits are **money events** (`money_lines.kind='credit_purchase'` — a dormant-but-valid kind) on a reserved **platform tenant**; Stripe settlement rides the shipped `payment.received`→`paid` projection. Metering is a **cross-DB recompute sweep** (reads each tenant's `agent_runs`⋈`events`, OVERWRITES `usage_credits.metered` — never `+=`). Spark caps are a per-tenant `SparkMeter` DO at the **agent-action chokepoint only**. The Migrator drag-drop reuses the WP-10 intake verbs + the gap-row law.

**Tech Stack:** TypeScript strict (no `any`), Zod at boundaries, Cloudflare Workers + service bindings + Durable Objects + D1, Stripe (dark), Vitest (`@cloudflare/vitest-pool-workers`), pnpm workspaces.

---

## ⚠️ The milestone posture — build the machinery, ship it DARK (mandatory)

PLG is GTM-gated: `genesis/12` parks the $5 Spark tier + self-serve signup until **R4** ("R3 stable + counsel items cleared"), far after M-H. CLAUDE.md: "GTM unlocks per genesis/12 (never before M-H)." So **every live-flip below builds now and stays inert until its gate**, exactly like the EDI/MCP `NotConfigured*` precedent:

| Live-flip | Ships as (inert default) | Unlocks at |
|---|---|---|
| Stripe billing client | `NotConfiguredBilling` (rejects loudly; keys operator-injected) | R4 |
| Public self-serve signup / provisioning | a **server-side flag OFF** (fail-closed) | R4 (+ REQ-138 cleared) |
| Spark $5 tier + `credit_purchase` emitter | plan-flag gated on `tenants.plan` (read by no code today) | R4 |
| PROOF-TO-CASH SKU (REQ-162) | plan-flag, founder-led (may provision at M-H/R1) | M-H / R1 |
| Hazmat booking (REQ-060) | per-tenant workspace-enablement flag | per-tenant |

**DO NOT BUILD:** REQ-138 (ToS/Privacy/DPA — CONFIRM-2/counsel; it structurally blocks *opening* public signup — the machinery may exist, the door legally cannot open) and the WP-15 **171-col continuous overlay** (REQ-035 — WP-14 is the *light* self-serve import only). Tier numbers stay `[HYPOTHESIS]` (REQ-130, WP-16).

---

## Non-negotiable invariants (verified in the understand sweep)
1. **0 tables, 0 kinds.** Effective table count is **21/22, spare intact** (`tools/checks/invariants.ts` subtracts `positions` as a partition of `events`). Credits ride the dormant-but-valid `money_lines.kind='credit_purchase'` (`packages/contracts/src/money.ts:23`); a 36th kind or a new table breaks I8 / the FROZEN-35 law.
2. **Money-as-projection.** Credits are `invoice.issued`/`payment.received` **appended through the api sequencer** (via the billing worker's service binding) on the platform tenant, then projected — NEVER a direct `money_lines` write (`genesis/02:18`; the Biller never writes `money_lines`).
3. **Exact metering by recompute, never a counter.** `agent_runs` is the idempotent one-row-per-`agent.acted` meter (`INSERT OR IGNORE` on the event id), so `COUNT(agent_runs) == COUNT(agent.acted)` exactly. The sweep OVERWRITES `usage_credits.metered` from the immutable ledger; the equality test `sum(metered)==COUNT(agent.acted)` is the DoD gate. Any `+=` loses "EXACTLY."
4. **THE SPARK-CAP INVERSION (do not let the audit "harden" this wrong).** Spark caps fail **closed on the convenience seam only** (refuse the *agent AI action* when over allotment). The cap MUST NEVER be consulted on the physical-truth append path: `stop.arrived`/`pod.signed`/`delivery.evidenced`/`custody.transferred` always commit, and **gates + invoicing always run** — "credits throttle conveniences, not truth" (`genesis/04:15`). An exhausted tenant still records freight reality.
5. **Platform-tenant isolation (highest risk).** A reserved revenue tenant is a new cross-tenant read surface — it requires a two-direction REQ-025 isolation case (no customer read reaches it; it never bleeds into customer reads). The billing worker's `CONTROL_DB` is auth-only, never a tenant data path.

---

## Task 0: Confirm scope (no new REQ rows expected)

WP-14 rows already exist (REQ-060/121/122/123/124/125/126/127/151/162, `F0-SPEC'D`/`F0.2`); REQ-138 is `CONFIRM-GATED` (do NOT build). The platform tenant, the metering sweep, the tenant pool, and the SparkMeter inversion are all implementation details of REQ-121/122/123/125 — **no new row**. If you discover genuinely new scope, STOP and append a REQ row first (its own commit beneath the build). Read-only; no commit.

---

## Task 1: The platform tenant + its two-way isolation lock (REQ-123/025) — do FIRST

**Files:** Create `packages/contracts/src/platform-tenant.ts` (the well-known id constant + a Zod guard) + a control-plane bootstrap (seed/migration-replay helper) that INSERTs the reserved `tenants` row; Test `workers/api/test/platform-tenant-isolation.test.ts`.

**Context:** The revenue ledger lives on a reserved platform tenant that **does not exist today** (grep-confirmed). Provision a reserved control-plane `tenants` row with a sentinel id OUTSIDE the customer slug space (e.g. `t:_platform`), a `PLATFORM_TENANT_ID` constant, and its own per-tenant D1 (a pool member reserved at bootstrap). Follow the `prove-tenant-isolation-read-paths` skill.

**Key tests (REQ-025, both directions):** a customer-scoped read (any lens, any route) can NEVER see the platform tenant's rows; a platform-tenant read never reaches a customer tenant; the platform id is rejected as a customer slug by `tenants.ts`'s allowlist parity. RED first.

**Commit:** `feat(plg): reserved platform tenant + two-way isolation lock (REQ-123/025)`

---

## Task 2: Dynamic tenant provisioning via a pre-provisioned pool (REQ-121)

**Files:** Create `workers/api/src/provision.ts` (claim-a-pool-tenant + the control-plane INSERT) + extend the tenant-binding resolution to a pool registry; Test `workers/api/test/provision.test.ts`.

**Context:** `workers/api/src/tenants.ts` is a static hardcoded allowlist (`TENANT_BINDINGS`) that throws FORBIDDEN on any unknown slug — there is NO `createTenant`. Recommended (preserves the REQ-025 static-allowlist subset parity, `tenants.ts:5-8`): a **pool of pre-provisioned, migrated tenant D1s** (created out-of-band by ops) that `provision.ts` **claims** at signup — mark the pool row `claimed`, INSERT the `tenants` row + a `users` row (`role=admin`) + an initial `usage_credits` row, and bind the workspace. Dynamic D1-create via the Cloudflare API is the alternative (a deploy-time registry) — the pool keeps the parity invariant intact, so prefer it for the R4-dark build. All provisioning is behind a **server-side flag OFF** (fail-closed — no self-serve provisioning until R4).

**Key tests:** claiming a pool tenant INSERTs the tenant+admin-user+usage_credits atomically and binds it; the pool exhausted → a clean fail-closed error; the provisioning flag OFF → the whole path refuses; the claimed tenant is fully isolated (REQ-025). RED first.

**Commit:** `feat(plg): pool-based dynamic tenant provisioning, flag-gated dark (REQ-121/025)`

---

## Task 3: The signup route (pre-auth, dark) (REQ-121)

**Files:** Create `workers/api/src/routes/signup.ts` (mounted peer to `/pub/*`, `workers/api/src/routes/public.ts:17`); Test `workers/api/test/signup.test.ts`.

**Context:** Signup is **pre-auth** (a stranger has no JWT) — a public route, NOT a Portal-authenticated one and NOT a 4th surface. `POST /pub/signup` (behind the provisioning flag) validates the input, calls `provision.ts`, and returns the workspace bootstrap (an admin session for the new tenant + the Portal/Command entry). With the flag OFF it 404/403s (dark). The `shuddl-site/` marketing deploy's CTA (today a `mailto:`) becomes the GTM front later — out of this repo's product surfaces; note it, don't build a console.

**Key tests:** with the flag ON (test-only), a signup provisions a tenant + returns an admin session that can reach the Portal quote verbs; with the flag OFF (the default), signup is refused; a signup cannot name/reach another tenant (REQ-025); no secret/internal leak in the response. RED first.

**Commit:** `feat(plg): pre-auth /pub/signup route, dark by default (REQ-121)`

---

## Task 4: Cold-start rating — tariff templates + guided builder (REQ-151) — the demo-#2 enabler

**Files:** Create `packages/rater/src/tariff-templates.ts` (brokerage market+margin template; asset-mode template scaffold) + `workers/api/src/routes/tariff.ts` (a guided-builder write over the existing `rate_config` via `rate-config.ts`); Test `packages/rater/test/tariff-templates.test.ts` + a route test.

**Context — the single highest-leverage functional gap (above Stripe, which ships dark).** A fresh tenant has no cost surface, so "stranger → first quote <10 min" is blocked. Ship: a **brokerage-mode** template (market rate + margin → a rateable sell immediately) and an **asset-mode** scaffold where **no tariff ⇒ UNKNOWN, no sell** (the "no price on air" law holds — never fabricate a price). The guided builder writes into the existing `rate_config` (no new table). Provisioning (Task 2) seeds the brokerage template so a new tenant can quote on day one.

**Key tests:** a newly-provisioned brokerage tenant produces a real sell on `/v1/rate` immediately; an asset tenant with no tariff → UNKNOWN (no fabricated price); the guided builder round-trips a tariff into `rate_config`. RED first.

**Commit:** `feat(plg): cold-start brokerage tariff template + guided builder (REQ-151)`

---

## Task 5: The Migrator drag-drop import (REQ-127) — light self-serve, gap-row law

**Files:** Create `packages/adapters/src/migrator.ts` (pure: spreadsheet rows → `{parties, shipments, rateConfig, gapRows}` + per-field confidence — no I/O, no ledger import, mirrors `@shuddl/edi` purity) + `packages/agents/src/migrator/` (the LLM column-guesser — LLM only in `packages/agents`, REQ-024) + `workers/api/src/routes/import.ts` (R2 upload → the pure map → loop the WP-10 intake verbs → gap rows). Tests + fixtures `fixtures/migrator/` (3 messy real-shaped files).

**Context:** WP-14 owns ONLY the light self-serve import (REQ-127; the heavy 171-col continuous overlay is WP-15/REQ-035 — do NOT build). The import loops the existing idempotent, gate-parity, tenant-scoped `POST /v1/parties` + `POST /v1/shipments` (`intake.ts:86-181`) + `rate-config.ts`. **The no-silent-drop law (CLAUDE.md rule 10 / REQ-035):** every unmapped column → exactly one `anomalies` row (`rule='migrator.unmapped_column'`, `object_kind='import_field'`, `severity='warn'`) surfacing on `v_queue_exceptions`; `<0.8`-confidence mappings route identically; retained-but-unmapped values ride `parties.external_refs`/`shipments.refs` jsonb. The migrator agent run + per-field confidence → `agent_runs`.

**Key tests (DoD):** 3 messy files import to parties/shipments; **every unmapped column raises exactly one anomaly** (no silent drop — count columns vs anomalies); a low-confidence mapping is queued for review, not silently applied; import is tenant-scoped + idempotent (re-import → no dupes). RED first.

**Commit:** `feat(plg): Migrator drag-drop import (intake-verb loop + gap-row law) (REQ-127)`

---

## Task 6: The cross-DB metering sweep (REQ-123) — exact-count reconciliation

**Files:** Create `workers/billing/` (the new worker — scaffold from `workers/mcp`: `workers_dev=false`, `CONTROL_DB`, per-tenant D1 read bindings, `API` service binding, no secrets) + `workers/billing/src/metering.ts` (the sweep) + a cron trigger; Tests.

**Context — the crux (cross-DB boundary):** the events ledger is per-tenant D1; `usage_credits` is control-plane D1 — a *separate database*, so the metering write CANNOT ride the sequencer's single-DB batch. A **scheduled recompute-from-ledger sweep** (cron) reads each tenant D1 and computes per `(agent, period)`: `COUNT(agent_runs ar JOIN events e ON e.id=ar.id WHERE period(e.ts)=P GROUP BY ar.agent)` (the exact JOIN Watchtower uses because `agent_runs` has no `ts` — `watchtower.ts:240-252`), then **OVERWRITES** `usage_credits.metered` (a mutable control-plane read-model — only events/positions/money_lines are append-only-guarded). Never a `+=`.

**Key tests (the DoD gate):** after seeding N `agent.acted` events across agents/periods, the sweep writes `usage_credits.metered` such that **`sum(metered) == COUNT(agent.acted)` exactly**; re-running the sweep is idempotent (overwrite, no drift); the sweep is tenant-scoped (reads only the tenant's D1, writes only that tenant's control row) — REQ-025. RED first.

**Commit:** `feat(plg): cross-DB metering recompute sweep — exact event-count reconciliation (REQ-123)`

---

## Task 7: Stripe + the credits ledger (REQ-123) — dark, idempotent, money-as-events

**Files:** `workers/billing/src/billing.ts` (`NotConfiguredBilling` client) + `workers/billing/src/webhook.ts` (the idempotent Stripe webhook) + `workers/billing/src/credits.ts` (the `credit_purchase` emitter); Tests.

**Context:** All in the billing worker, DARK until keys bound (`NotConfiguredBilling` rejects loudly, mirror `NotConfiguredSender`). A credit-pack sale = **`invoice.issued`** carrying a `money_lines` row `kind='credit_purchase'` **appended through the api sequencer** (the service binding) on the **platform tenant** — verify the existing `invoice.issued` projection forwards `line.kind` verbatim (never a direct `money_lines` write). Stripe settlement = **`payment.received`** → the shipped AR-settlement projection (`money.ts:207-219`, REQ-083) flips the matched OPEN invoice to `paid` unchanged. The webhook MUST be **idempotent** (Stripe redelivers): verify the signature (operator-injected secret, never in toml — REQ-154), dedup by **Stripe event id**, derive the ledger event id **deterministically** from it ("twice in = once out"). `usage_credits.stripe_refs` ties Stripe objects back. Do NOT conflate `credit_purchase` (this) with `credit.checked` (customer creditworthiness).

**Key tests:** with `NotConfiguredBilling` (default), no charge/emit happens (dark); a (test-injected) checkout webhook appends exactly one `credit_purchase` `invoice.issued` on the platform tenant and a redelivered webhook appends nothing more (idempotent); a `payment.received` flips the credit invoice to `paid`; a spoofed/unsigned webhook is rejected. RED first.

**Commit:** `feat(plg): Stripe credits (dark) — idempotent webhook, credit_purchase money-events (REQ-123/154)`

---

## Task 8: Spark caps — the `SparkMeter` DO with the truth-path carve-out (REQ-122/125)

**Files:** Create `workers/agents/src/spark-meter.ts` (the DO, clone `workers/mcp/src/caps-meter.ts`) + wire a cap check into the **agent-action chokepoint** in `workers/agents/src/index.ts` (before the LLM call); Tests.

**Context — encode THE INVERSION explicitly.** A per-tenant `SparkMeter` DO (`idFromName(tenantId)`, mutex-atomic `checkAndReserve`, idempotency-keyed on the `agent.acted` id, UTC-month period, no-caps-default=ZERO, reserve-at-check/fail-closed). The cap gates the **convenience/agent seam ONLY** — refuse the *agent AI action* (concierge/copilot/auto-quote) when over allotment. It MUST NEVER be consulted on the physical-truth append path — `stop.arrived`/`pod.signed`/`delivery.evidenced`/`custody.transferred` always commit; **gates + invoicing always run**. REQ-125 per-workspace velocity + LLM-cost ceilings layer on as a velocity dimension. Plan-flag gated on `tenants.plan` (Spark tier); non-Spark tenants are uncapped.

**Key tests (the inversion is the headline):** an over-cap Spark tenant's agent AI action is refused (fail-closed); **the SAME over-cap tenant STILL records `pod.signed`/`stop.arrived`, still runs its gates, still invoices** (a dedicated assertion — "credits throttle conveniences, not truth"); the cap is keyed off the server tenant, not a client field; concurrent agent actions can't over-reserve (the DO mutex). RED first.

**Commit:** `feat(plg): Spark caps at the agent-action seam — truth path never throttled (REQ-122/125)`

---

## Task 9: Plan/tier + entitlement gating (REQ-060/162)

**Files:** Create `packages/contracts/src/entitlements.ts` (read `tenants.plan`/`tenants.policy` — levers read by no code today) + wire the entitlement checks (server-side, fail-closed); Tests.

**Context:** `tenants.plan`/`tenants.policy` (`0001_control.sql:5-6`) are entitlement levers no code reads yet. Add: the **PROOF-TO-CASH SKU** (REQ-162, the R1 founder-led plan-flag — may provision at M-H) and **hazmat booking** (REQ-060, a per-tenant workspace-enablement flag, excluded from Spark default) as server-side entitlement checks. Numbers stay `[HYPOTHESIS]` (REQ-130).

**Key tests:** a hazmat booking is refused for a non-enabled tenant + allowed for an enabled one (server-side, prompt-independent); the PROOF-TO-CASH plan-flag gates its SKU; entitlements are tenant-scoped. RED first.

**Commit:** `feat(plg): tenants.plan/policy entitlements — PROOF-TO-CASH + hazmat gates (REQ-060/162)`

---

## Task 10: The <10-min demo path (REQ-127/151 DoD, demo #2)

**Files:** `workers/api/test/signup-to-quote.e2e.test.ts` (an integration test, flags ON in-test) + a fixture.

**Context:** Prove the acceptance-demo-#2 chain end-to-end (behind the dark flags, exercised in test): `/pub/signup` → provision (brokerage template seeded) → drag-drop import (3 messy files → parties/shipments + gap rows) → first `/v1/rate` returns a real sell — unassisted. This is the "stranger signs up and quotes in <10 min" gate WP-14 owns.

**Key test:** the full chain completes and yields a priced quote with zero manual steps; the same chain with the flags OFF is refused at signup. RED first.

**Commit:** `test(plg): signup→import→first-quote acceptance-demo-#2 chain (REQ-127/151)`

---

## Task 11: Comprehensive isolation — platform tenant + provisioning + metering (REQ-025)

**Files:** Extend the isolation suite (`workers/api/test/isolation.test.ts` + a billing-worker isolation test).

**Context (highest-risk surface):** prove the platform tenant never bleeds into a customer read and vice-versa (both directions); a provisioned pool tenant is fully isolated; the metering sweep reads only a tenant's own D1 + writes only its own control row; the billing worker's `CONTROL_DB` is auth-only (never a tenant data path). Follow `prove-tenant-isolation-read-paths`.

**Commit:** `test(plg): platform-tenant + provisioning + metering isolation matrix (REQ-025)`

---

## Task 12: Verify + exit audit + close-out + merge

- **`pnpm verify`** green — confirm **21/22 tables, 35 kinds** (WP-14 added ZERO). Sweep iCloud `"* 2.*"` dups first.
- **REQ-119 exit-audit swarm** with lenses tuned to WP-14's traps: (a) **do NOT over-harden the Spark truth path** — assert the auditor confirms physical-truth appends + gates + invoicing still run for an over-cap tenant (a "fail-closed everywhere" recommendation here is WRONG); (b) **platform-tenant isolation** (both directions); (c) **exact-metering** (no `+=`, recompute-overwrite, `sum==COUNT`); (d) **money-as-projection** (credits via the sequencer, never a direct `money_lines` write); (e) **Stripe webhook** idempotency + signature; (f) **dark-by-default** (every live-flip inert without its flag/keys); (g) additivity (0 table/kind/surface). Fix confirmed findings with proving tests.
- **Activate WP-14** in `tools/traceability/active-wps.json`; confirm traceability (every WP-14 REQ annotated).
- **Close-out** `docs/wp/WP-14.md` + **append the R4/CONFIRM live-flips to `docs/ops/GO-LIVE-CHECKLIST.md`** (Stripe keys + webhook secret, the signup/provisioning flag, the Spark tier plan-flag, the pool-tenant provisioning ops runbook, REQ-138 legal as the door-opener, the tenant-D1 pool refill) — each with REQ + status.
- **Merge to main locally** (the pre-authorized finish): verify green on the merge result, then `git checkout main && git merge wp-14-plg && git branch -d wp-14-plg`.

---

## Risk register (each with its discharge)
| Risk | Discharge |
|---|---|
| A signup "console" = a 4th surface (Do-Not-Build) | Signup is a pre-auth route + the marketing page; workspace = existing Portal/Command (Task 3) |
| An accidental new table/kind | Credits ride `credit_purchase`; metering rides `usage_credits`+`agent_runs`; the spare stays reserved — Task 12 asserts 21/22 & 35 |
| Exact-metering drift | Recompute-from-ledger OVERWRITE, never `+=`; `sum(metered)==COUNT(agent.acted)` is the gate (Task 6) |
| Money-as-projection breach | Credits appended via the sequencer (service binding), never a direct `money_lines` write (Task 7) |
| Spark-cap over-hardening | The truth path is NEVER capped — a test asserts an over-cap tenant still records freight reality + invoices (Task 8/12) |
| Platform-tenant leak | Two-way REQ-025 isolation lock, done first + re-proven (Task 1/11) |
| Stripe webhook replay/spoof | Signature-verify + dedup by Stripe event id + deterministic ledger id ("twice in = once out") (Task 7) |
| Opening the door too early | Everything ships DARK behind flags/`NotConfigured`; REQ-138 legal blocks public signup; R4 gate (the posture table) |
| Cold-start demo failure (demo #2) | Brokerage tariff template seeded at provisioning so a stranger quotes day one (Task 4/10) — the highest-leverage gap |
| Building WP-15 overlay by mistake | WP-14 is the light self-serve import only; the 171-col continuous overlay is WP-15 (Task 5) |
