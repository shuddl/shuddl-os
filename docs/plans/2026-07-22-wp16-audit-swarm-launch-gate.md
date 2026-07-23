# WP-16 — Audit swarm + launch gate (the final WP) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task (fresh subagent per task, spec-review then code-quality-review between tasks). Written for an engineer with zero SHUDDL context.

**Goal:** Take the build to the launch gate — a full adversarial audit pass over EVERY module (zero open Critical), a machine-checked 100% register-coverage report, pen-test basics (a documented STRIDE-per-surface run + the three known hardenings), and the five doc-00 acceptance-demo spine — so the only work left between "merged" and "live" is the tenant-calendar / CONFIRM / GTM / filmed-video objects a merge inherently cannot close.

**Architecture:** This is an ASSURANCE + LAUNCH-GATE work package, not a feature build. It adds two CI gates (`check:coverage`, the acceptance-spine runner), closes the known-open Highs (identity-leak fail-open, idempotency-4xx, design-CI blind spots, map-bearing, TSA CMS verify, status-page server-geo), authors two assurance artifacts (`docs/security/pen-test-basics.md`, the `docs/audits/` WP-16 report), runs the REQ-119 swarm across ~20 targets, and finalizes the launch-gate ledger. Additive: the hard budgets (≤22 tables · 35 kinds · 12 views · 5 tokens) are UNCHANGED — any new REQ rows come only from audit discovery (append-only register), and no new surface/primitive.

**Tech Stack:** TypeScript strict, Cloudflare Workers + D1 + DO, Vitest (`cloudflare:test` pool-workers) + Playwright (dev-server e2e), the existing `tools/` gate harness, the register CSV + `tools/traceability/*`.

---

## ⚠️ Two-tier DoD — what a merge CAN and CANNOT close (read first)

The WP-16 DoD (`genesis/08:70`) is **"Zero Critical; coverage report 100%; the five doc-00 acceptance tests pass on video."** It splits hard:

- **In-repo, this WP closes:** the audit swarm (run + fix confirmed Criticals/Highs + archive), the `check:coverage` 100% gate, the pen-test-basics doc + the three hardenings, the acceptance-demo spine (the 5 integration tests + a Playwright browser layer for the browser-drivable demos). Provable by `pnpm verify` + the two new artifacts.
- **Out-of-repo, the LAUNCH GATE closes (a merge cannot):** the five **filmed** videos on tenant-0 real freight; the `<5s`/`<10min`/real-driver/real-Claude measurements (the code explicitly refuses to fabricate the latency — `heartbeat.test.ts`); REQ-130 pricing re-base (CONFIRM-gated + tenant-0 telemetry); REQ-161 ICP/first-25 CRM (GTM, post-M-H); CONFIRM-2 legal (ToS/Privacy/DPA/eBOL/trademark); deliverability warmup (REQ-157, ≥2 wks); the WP-15 M-AUTHORITY tenant-calendar gates; DR restore drill (REQ-135); monitors stood up (REQ-114); prod provisioning + real TSA endpoint. These are recorded, not closed.

**"Zero Critical" cannot be ASSERTED until the swarm runs** (the pattern found 42 defects in a "finished" module; the last 60-agent run surfaced a real Critical). So Task 8 (the swarm) may generate fix work; the plan absorbs that RED-first before close.

## Non-negotiable invariants
1. **Additive.** No new table (21/22), no new kind (35), no new view (12), no new surface, no budget change. `check:seed` + `check:invariants` stay green. New REQ rows come ONLY from audit discovery (append-only to `genesis/09`).
2. **Findings become REQ rows or defects, never Slack messages** (REQ-119). Every confirmed audit finding → a fix (RED-first) or an appended register row (`WP16-DISCOVERED` / `F0-DEPLOY-NOTE` / `vNEXT`), + a GO-LIVE-CHECKLIST row.
3. **No WP closes with an open Critical** (CLAUDE.md rule 9). The swarm's skeptic pass is default-refute; only CONFIRMED findings count.
4. **Fail-CLOSED items are not holes** (they refuse, not leak) — do not "fix" a deliberate fail-closed refusal into an open path.

---

## Task 1: `check:coverage` — the machine-checked 100% register-coverage gate (REQ-118/119)

**Files:** Create `tools/traceability/coverage.ts` + a test `tools/traceability/coverage.test.ts`; add `check:coverage` to `package.json` (in the `verify` chain, after `check:traceability`); reuse `tools/traceability/register.ts` (`parseRegister`) + `orphans.ts` (`scanSourceAnnotations`).

**Context:** `orphans.ts` is bidirectional but only gates rows whose `wp` literally includes an ACTIVE WP (WP-01..15) and whose status ∉ {vNEXT, CONFIRM-GATED} — so **34 rows are silently exempt** (the 5 WP-all always-on rows, 13 vNEXT, 12 CONFIRM-GATED, 2 F0-DEPLOY-NOTE, the 2 WP-16 rows, REQ-120 ongoing, REQ-144 F1). The register has **205 rows**. "100% coverage" = every row is EXPLICITLY accounted for, not silently skipped.

**Approach:** `coverage.ts` classifies all 205 rows via a deterministic disposition function keyed on `(status, wp)` into the 8 buckets (BUILT+ANNOTATED · WP-all always-on · vNEXT · CONFIRM-GATED · F0-DEPLOY-NOTE · WP-16 launch-gate · ongoing · F1). For BUILT dispositions (WP-01..15 + WP-all + *-DISCOVERED) it REQUIRES ≥1 source annotation (extends `orphans.ts` Direction A to the WP-all / WP-16 / ongoing / F1 rows the current filter exempts). For NON-built dispositions it REQUIRES a recorded home — a citation in `docs/ops/GO-LIVE-CHECKLIST.md` (or a small `tools/traceability/coverage-manifest.json`) — so a deferral is RECORDED, never silent. Emits a per-bucket report (classified/205) and FAILS on any UNACCOUNTED row (unknown/empty status, a built row with zero annotations, a deferred row with no recorded disposition). Add a **status-drift check** (GO-LIVE-CHECKLIST:232): flag any row still tagged `*-DISCOVERED`/`vNEXT` whose code has shipped (annotations exist in shipped source) — advance those tags in the register as part of this task. Derive buckets from the CSV, never a hardcoded id list (append-only-aware).

**Key tests:** classifies all 205 → 100%, zero unaccounted; a synthetic UNACCOUNTED row (unknown status / built-but-unannotated / deferred-but-unrecorded) FAILS the gate; the status-drift check flags a shipped-but-`*-DISCOVERED` row; `check:coverage` runs in `verify`. RED first.

**Commit:** `feat(launch): check:coverage — 100% register-coverage gate over all 205 rows (REQ-118/119)`

---

## Task 2: Close the identity-leak fail-OPEN — the one genuine fail-open gate (REQ-167)

**Files:** Modify `tools/checks/identity-leak.ts` (~:56-60); the CI secret / `.identity-denylist.local` wiring; a test.

**Context:** `identity-leak.ts` `console.warn`s and `return`s (exit 0) when no `IDENTITY_DENYLIST` is present — a real tenant/person/incumbent name could ship green (REQ-167, the memory + GO-LIVE-CHECKLIST:168 corroborate). This is the SINGLE genuine fail-open gate in the build. Close it: **fail-closed in CI** (when `CI`/`REQUIRE_DENYLIST` is set and no denylist is resolvable → non-zero exit, not a warning); keep a documented local escape (`.identity-denylist.local`, gitignored) so a dev without the secret isn't blocked, but CI (and a WP-exit run) MUST fail-closed. Do NOT change the scanner's matching logic — only its absent-denylist disposition.

**Key tests:** with `REQUIRE_DENYLIST=1` + no denylist → non-zero exit (fail-closed); with a denylist present → scans + passes on a clean tree, fails on a seeded name; local (no `REQUIRE_DENYLIST`) → the documented warn-and-skip is preserved. RED first.

**Commit:** `fix(security): identity-leak lint fails CLOSED in CI (REQ-167) — the last fail-open gate`

---

## Task 3: TSA CMS signature + cert-chain verification (REQ-014, deferred-to-WP-16)

**Files:** Modify `packages/ledger/src/tsa/client.ts` (+ `der.ts`); tests.

**Context:** The anchor TSA receipt is stored raw (`.tsr` in R2, verifiable offline forever) but only STRUCTURALLY DER-parsed today — the CMS SignerInfo signature + the cert chain are NOT verified (`tsa/client.ts:9-11`; `threat-model.md:29`; GO-LIVE-CHECKLIST:192 explicitly defers it to WP-16). Add CMS signature verification (the TSA's signature over the TSTInfo) + cert-chain validation to the TSA client, so an anchor proof cryptographically verifies, not just parses. Keep the fail-closed posture (an unverifiable receipt → UNKNOWN/escalate, never a fake pass). LLM-free, pure crypto (REQ-024).

**Key tests:** a valid CMS-signed receipt verifies; a tampered signature / a broken cert chain / an expired signer cert → rejected (fail-closed); the existing anchor tests stay green. RED first.

**Commit:** `feat(security): TSA CMS signature + cert-chain verification (REQ-014)`

---

## Task 4: Status-page server-side geo generalization (REQ-074)

**Files:** Modify the public status path (`workers/api/src/pub/status.ts` + `packages/ledger` geo generalization); tests.

**Context:** `generalizePosition` is CLIENT-consumed today; the true privacy boundary is SERVER-SIDE lens scoping (`threat-model.md:37`, REQ-074, GO-LIVE-CHECKLIST:175) — a public status page must generalize the position SERVER-SIDE before it leaves the worker, so a raw coordinate never reaches an untrusted client. Move/enforce the generalization on the server for the public status surface (the authed lens keeps its own scoping). Fail-closed: an ungeneralizable position → withhold, never leak a raw coordinate.

**Key tests:** a public status read returns only a generalized position (never raw `lat_e6`/`lon_e6`); an authed lens is unaffected; a position that can't be generalized is withheld. RED first.

**Commit:** `fix(security): status-page geo generalization enforced server-side (REQ-074)`

---

## Task 5: Reconcile the code-unremediated 2026-07-15 audit Highs (REQ-119)

**Files:** `workers/api/src/middleware/idempotency.ts` (~:35); `tools/design/audit.ts` (~:248-282); `packages/map/src/MapCanvas.tsx` (~:48,97); append REQ rows to `genesis/09-REQUIREMENTS-REGISTER.csv`; tests.

**Context:** The 2026-07-15 60-agent audit surfaced Highs that were never converted to REQ rows and remain code-unremediated (a REQ-119 process gap — "findings become REQ rows"):
- **H-5 idempotency caches 4xx** (`idempotency.ts:35` `if (res.status < 500)`): a same-key retry after a precondition 422/409 replays the cached 4xx and `next()` never re-runs → **silent evidence/write loss**. Fix: cache only 2xx (the audit's prescribed fix).
- **H-3 basemap invisible to design CI** (`audit.ts` `scannedFiles()` globs no `**/*.json`): `greige-style.json` (runtime paint colors) is unscanned → a raw non-token color could ship. Fix: scan JSON style files.
- **H-4 5-token budget not count-enforced** (`audit.ts:279-282`): no `colorTokens.length !== 5` violation. Fix: emit a budget violation on token-count drift.
- **H-2/L-6 map bearing** (`MapCanvas.tsx:97` no epsilon guard → chevrons snap due-north at rest; `:48` `bearingTo` planar, no `cos(lat)`): fix the epsilon guard + the great-circle bearing (keep-map-instrument-truthful).

Fix each RED-first; append a `WP16-DISCOVERED` (or `F0-SPEC'D`) register row per fix so the register records them (REQ-119). These are real correctness/privacy/evidence-integrity fixes, not cosmetic.

**Key tests:** a 422 is NOT cached (a retry re-runs and can succeed); the design audit scans `greige-style.json` + fails on a 6th token; the map bearing holds steady at rest + uses great-circle math. RED first.

**Commit:** `fix(launch): reconcile 2026-07-15 audit Highs — idempotency-2xx-only, design-CI json+token, map bearing (REQ-119)`

---

## Task 6: The pen-test-basics report (REQ-136)

**Files:** Create `docs/security/pen-test-basics.md`; no code change (an assurance artifact over the existing suites).

**Context:** REQ-136 ("pen-test basics before launch gate; report clean"). The stack rests on an unusually strong existing security corpus — 5 isolation suites (api/mcp/translator/platform/plg), `auth.test.ts` (HS256-pinned, alg:none fixture, role matrix), `lens-adversarial.test.ts` (money-kind forgery → 403, forged party_id ignored, the 35-pair visibility snapshot), device-sig forgery (`sign.test.ts`), chain-fork/seq-race closed, Zod-at-every-boundary, gitleaks. Author `pen-test-basics.md` mapping each `docs/security/threat-model.md` STRIDE-per-surface row (API `/v1`+`/mcp`, Ledger, Driver PWA, Email in/out, CI/supply-chain) → the existing suite/gate that proves it → PASS or a finding. Record the three hardenings from Tasks 2-4 as CLOSED. Cite the out-of-repo preconditions it depends on (edge rate-limit REQ-193, real TSA endpoint, prod secrets, deliverability). "Report clean" = this artifact with every surface PASS or dispositioned.

**Key tests:** none (a doc); the `check:coverage` gate (Task 1) requires REQ-136 to have a recorded home — this doc + its annotation satisfy it.

**Commit:** `docs(security): pen-test-basics report — STRIDE-per-surface mapped to proving suites (REQ-136)`

---

## Task 7: The five-demos acceptance spine + Playwright browser layer (REQ-119 DoD)

**Files:** Create `tests/acceptance/` Playwright specs for the browser-drivable demos + a `test:acceptance` script; the flags-on dev-server wiring (`PROVISIONING_ENABLED` via wrangler `--var`/`.dev.vars`); a manifest `docs/wp/acceptance-demos.md` mapping each demo → its in-repo spine test → what the filmed video adds; flip `tools/harness/playwright-guard.ts` to BLOCKING for the acceptance specs (not advisory).

**Context:** genesis/14:52 promises "Playwright e2e scripted to the five acceptance demos." Today Playwright runs ONLY the 5-screenshot visual diff (advisory, self-skips, exits 0). The five demos' CAUSAL CHAINS are already proven in-repo as vitest pool-workers integration tests (demo 1 `heartbeat.test.ts`; demo 2 `signup-to-quote.e2e.test.ts`; demo 3 `stop-flow.test.ts` + `airplane-soak.test.ts`; demo 4 `quote-book.test.ts`; demo 5 `command-heartbeat.test.ts` + `MapCanvas.test.tsx`). Build:
- A named **acceptance spine**: a `test:acceptance` runner that runs exactly those 5 spine tests as the demo acceptance set, + the manifest doc mapping demo→spine-test→filmed-delta.
- A **Playwright browser layer for the browser-drivable demos (2, 3, 5)** — drive the real app UIs (dev servers already boot in `playwright.config.ts`) with camera/GPS/signature mocked exactly as the unit tests mock them; assert the observable UI behavior (demo 2 signup→quote, demo 3 gated-stop progression, demo 5 map world-dim on exception). Wire the **flags-on dev-server** (`PROVISIONING_ENABLED=true`) so demo 2's browser run reaches the priced quote (the missing wiring the sweep flagged). Make these acceptance specs BLOCKING (the guard's `--strict`, or a real `test:acceptance` in verify).
- **Honestly document the filmed split**: demo 1's `<5s` and demo 4's full-DO-Claude-booking are NOT browser-drivable in-repo (the code refuses to fabricate the latency; the MCP full-DO is a staging smoke) — they stay filmed tenant-0 deliverables. The manifest records exactly what each demo's video must show that the in-repo spine cannot.

Do NOT over-build: the causal-chain proof already exists; the browser layer adds UI traversal for 2/3/5 + the flags-on wiring, and the manifest makes the filmed deliverables explicit.

**Key tests:** the `test:acceptance` runner runs the 5 spine tests green; the Playwright demo-2/3/5 browser specs pass headless in CI (mocked device seams); the flags-on dev-server serves a priced quote for demo 2; the guard is blocking for acceptance specs. RED first where a spec is new.

**Commit:** `feat(launch): five-demo acceptance spine + Playwright browser layer (demos 2/3/5) + flags-on wiring (REQ-119)`

---

## Task 8: The full REQ-119 adversarial audit swarm — every module (REQ-119)

**Files:** Create `docs/audits/2026-07-DD-wp16-launch-audit.md`; append confirmed-finding REQ rows to `genesis/09-REQUIREMENTS-REGISTER.csv` + GO-LIVE-CHECKLIST rows; fix confirmed Critical/High findings RED-first across the cited files.

**Context:** The DoD centerpiece: a full adversarial pass over EVERY module (the ~20 targets — `packages/{ledger,rater,contracts,agents,edi,map,adapters,driver-core,design}`, `workers/{api,agents,mcp,translator,billing}`, `apps/{command,driver,portal}`, the CI gates, the migrations, the WP-15 overlay/authority seam). Structure = **targets × lenses × the Laws** (the 12 deployed `.claude/skills/` ARE the pre-built lenses: gate-parity, append-only-guards, tenant-isolation, readmodel-consistency, visibility/redaction, canonical-hash, agent-model-trust, agent-idempotency, map-truthfulness, external-routing, lint-parity), plus a Ten-Laws/I1-I8 pass, a hard-budget pass (tables/kinds/views/tokens/fonts/chrome), and a fixtures-gate pass. Per the 2026-07-15 template: cartography → adversarial defect hunt → **per-finding skeptic re-verification (re-read the cited file:line, DEFAULT-REFUTE, drop the unconfirmable)** → synthesis. **SEED the swarm with the known-open list** (identity-leak now fail-closed Task 2, idempotency-4xx now Task 5, design-CI blind spots Task 5, map-bearing Task 5, TSA CMS Task 3, status-geo Task 4) so it CONFIRMS closure rather than rediscovering, and confirms the WP-15 crown-jewel invariants hold at the whole-build scale.

**Approach:** run the swarm (parallel adversarial subagents per target×lens, each default-refute); collect CONFIRMED Critical/High/Med/Low with file:line + REQ-IDs + repro; **fix every confirmed Critical AND High RED-first** (a WP cannot close with an open Critical; Highs are reconciled — fixed or given a recorded REQ row + GO-LIVE disposition); archive the report to `docs/audits/`; append the discovered REQ rows (append-only) + GO-LIVE-CHECKLIST rows. Confirm `check:coverage` still 100% after the new rows.

**Key deliverables:** the archived `docs/audits/` report (method → verified defect register grouped Critical/High/Med/Low, each with file:line + REQ + fix); ZERO open Critical; every High fixed-or-recorded; the appended REQ rows; `pnpm verify` green after the fixes.

**Commit(s):** `audit(launch): WP-16 full adversarial swarm — <N> findings, zero open Critical, archived + reconciled (REQ-119)` (+ per-fix commits RED-first).

---

## Task 9: Verify + activate WP-16 + launch-gate close-out + merge

- **`pnpm verify`** green — confirm the budgets unchanged (21/22 tables, 35 kinds, 12 views, 5 tokens), `check:seed`, `check:invariants`, `audit:design` (blocking), `check:coverage` **100%**, `check:traceability`, `check:identity` **fail-closed** (Task 2), the acceptance spine, the isolation suites. Sweep iCloud `"* 2.*"` dups first.
- **Activate WP-16** in `tools/traceability/active-wps.json`; confirm `check:coverage` is 100% with WP-16 active + every WP-16 REQ (119/130/136/161 + any discovered) accounted for.
- **Close-out** `docs/wp/WP-16.md` (the final close-out: the audit result + zero-Critical, the 100% coverage report, the pen-test-basics report, the acceptance spine + the filmed-video deltas, the two-tier DoD) + **finalize `docs/ops/GO-LIVE-CHECKLIST.md`** as the definitive LAUNCH-GATE ledger: the in-repo-closed column vs the launch-gate calendar objects (the 5 filmed videos, REQ-130 CONFIRM+telemetry, REQ-161 GTM, CONFIRM-2 legal, deliverability warmup, WP-15 M-AUTHORITY gates, DR restore drill, monitors, prod provisioning, real TSA endpoint). Advance any stale `*-DISCOVERED`/`vNEXT` register tags the coverage drift-check flagged.
- **Merge to main locally** (the pre-authorized finish): verify green on the merge result, then `git checkout main && git merge --no-ff wp-16-launch && git branch -d wp-16-launch && git push origin main`.

---

## Risk register (each with its discharge)
| Risk | Discharge |
|---|---|
| The swarm surfaces a real Critical (it has before) | Task 8 fixes every confirmed Critical RED-first before close; no WP closes with an open Critical (rule 9) |
| "Coverage 100%" is register-accounting, not test-depth | `check:coverage` proves ACCOUNTING; test-depth is REQ-119's swarm + the fixture gates — the doc states this limitation explicitly |
| Closing identity-leak fail-open breaks local dev (no secret) | Fail-closed only in CI (`REQUIRE_DENYLIST`); a documented gitignored `.identity-denylist.local` local escape (Task 2) |
| A "fix" turns a deliberate fail-closed refusal into an open path | Fail-closed items (ratecon-unbuilt, EDI-unwired) are scope, NOT security holes — do not "open" them (invariant 4) |
| Over-building a speculative Playwright suite | Scope to the browser-drivable demos 2/3/5 + flags-on wiring; the causal chains already proven; demo 1/4 stay filmed (Task 7) |
| Confusing in-repo-closeable with the launch gate | The two-tier DoD is explicit; the close-out records the calendar/CONFIRM/GTM/video objects a merge cannot close (Task 9) |
| New audit REQ rows breach a budget | Rows are register scope, not tables/kinds/views; `check:invariants` + `check:coverage` gate it (Task 8/9) |
| Additive guarantee | 0 new table/kind/view/surface; `check:seed` + `check:invariants` green; new rows are append-only register discovery (whole plan) |
