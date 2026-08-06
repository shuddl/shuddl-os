# RAW RESEARCH APPENDIX — SHUDDL OS Distance-to-Running Audit
**Compiled by background audit agent, 2026-08-01. Preserved verbatim as the evidence base for doc 01.**
**Repo HEAD at audit:** ~~`d6eec18`~~ — **CORRECTED 2026-08-02: this SHA was wrong.** Re-measured directly: HEAD was and is `82e04c7` (2026-08-02); `d6eec18` (2026-08-01) is an *ancestor* of HEAD, not HEAD itself. The unpushed count was also understated — the true figure is **92 commits ahead of `origin/main`**, not 30. The substantive finding (main is far ahead, unpushed, no evidence record at HEAD) holds and is larger than reported. · Method: static read + evidence records + live read-only HTTP probes. No test suites, builds, or deploys were run.

## TL;DR

**Production infrastructure is live and answering right now** — all nine prod hostnames verified over the wire. **The product is not.** Prod's control plane holds three system tenants and an empty `users` table; there is no login endpoint; the only session-minting route (`POST /pub/signup`) is dark behind an unbound flag. Today the system serves: a marketing site, four unauthenticated browser shells, and a fail-closed API that 401s everything. **Zero freight, zero users, zero tenants.**

The gap is not "finish the code." Sixteen work packages are closed and the causal chain for every acceptance demo has an in-repo test. The gap is: **(a) nine private engagement fixtures that cannot be synthesized, (b) a tenant-0 config pack that lives outside this repo, (c) ~4 small code items (login, ratecon generation, signup UI, staging-worker parity), (d) ~6 operator config flips.**

## 1. DEPLOYABILITY

Five product workers (`workers/*/wrangler.toml`) + three surface workers (`apps/*/wrangler.toml`) + one marketing worker (separate account, untracked by this repo — `.git/info/exclude:20-21`).

| Worker | prod route | prod bindings |
|---|---|---|
| api | `api.shuddl.tech/*` | 6 D1 + KV + R2 + DO + Queue producer (`workers/api/wrangler.toml:175-226`) |
| agents | deliberately unrouted | 5 D1 + R2 + Queues + DLQ + 2 DO |
| billing | `billing.shuddl.tech/*` | 4 D1 + service binding + cron |
| mcp | `mcp.shuddl.tech/*` | service binding + CONTROL_DB + KV GRANTS + CapsMeter DO + cron |
| translator | deliberately unrouted | 3 D1 + R2 + DO + cron |
| command/driver/portal | `command./driver./portal.+track.shuddl.tech` | assets-only by design |

**Prod bindings are REAL, verified** — live UUIDs, cross-worker consistent (e.g. `TENANT_A_DB = 7fb36070-…` identical in api/agents/billing/translator; `CONTROL_DB = e91b8e7c-…` in all five). In-file comment: "SUPERSEDED 2026-07-30 — provisioned; ids are real" (`workers/api/wrangler.toml:153`). One deliberate placeholder remains: mcp staging GRANTS. **Staging is structurally weaker:** the three surface apps have no `[env.staging]` scope at all; billing/mcp/translator staging declared-but-undeployed (`docs/ops/PROJECT-STATE.md:247-251`).

**Live probes (2026-08-01):** `api.shuddl.tech/v1/health` 200 · `/v1/board` **401 (gate holding)** · mcp 200 · billing/health 200 · command 200 · portal 200 · driver 200 · track 200 · shuddl.tech 200.

Corroborating records: preflight PASS 72 checks 2026-07-31 (`docs/ops/RELEASE-EVIDENCE.md:618-626`); browser-verified surfaces reach api (`:679-696`); staging smoke drove a gated stop through `pod.signed` → penny-exact `invoice.issued` (55,800¢) with a real evidence email from `pod@send.shuddl.tech` (`docs/ops/PROJECT-STATE.md:220-224`); 6 prod D1s migrated (`docs/ops/GO-LIVE-CHECKLIST.md:50-51`).

## 2. GATE STATUS (authoritative: `artifacts/release/<sha>/<env>/*.json`)

### Release profile @ `2733f39` prod (2026-07-31): **16 PASS · 8 BLOCKED · aggregate BLOCKED — NOT PROMOTABLE**

PASS: runtime, typecheck, lint, unit-tests, invariants, rater-purity, authority-coverage, traceability, coverage, seed, acceptance, design-audit, perf(local), visual(5), a11y(4), e2e(6), deploy-preflight(72).

| Blocked gate | Verbatim reason |
|---|---|
| `identity-leak` | "no denylist (set `IDENTITY_DENYLIST` secret or `.identity-denylist.local`)" |
| `fixtures` | "pending (not vendored): rater-48-tests, rater-504-sweep, zone-tariff-v1, invoice-500-replay, concierge-parse-50, customer-roster, legacy-import-formats, legacy-export-replay, synthetic-blitz-3100" |
| `rater-parity` | "engagement fixtures not vendored (`fixtures/rater/*`, `fixtures/tariff`)" |
| `invoice-parity` | "engagement fixtures not vendored (`fixtures/invoice-replay`, `fixtures/tariff`)" |
| `concierge-parse` | "engagement fixtures not vendored (`fixtures/concierge/parse-50`, `fixtures/tariff`)" |
| `restore-verify` | "no `--source`/`--restored` snapshots supplied" |
| `staging-smoke` | "`SMOKE_API_BASE` is not set" |
| `backup-manifest` | "OIDC/external backup credentials absent in-repo" |

Merge profile @ `0415148` (2026-07-31): 16 PASS · same 5 private-input gates BLOCKED. Roster since 2026-08-01: release = 26 gates (added `surfaces`), merge = 21 (`tools/release/run-gate.ts:41-87`).

### ⚠ Findings not recorded in any in-repo document

1. **Last CI run on origin/main is RED on `strict performance`** (run 30672690027, commit 0415148): map board 1000 entities p95=233.40ms ≈ 4fps vs 55fps budget — **fails on GitHub-hosted CI hardware while passing locally on the same commit.** Genuine FAIL, not BLOCKED; unrecorded in PROJECT-STATE/RELEASE-EVIDENCE/GO-LIVE.
2. **Nightly backup job fails** (run 30694587146, 2026-08-01): `CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID` unbound; job scoped staging-only — **production is never backed up on a schedule** (`.github/workflows/nightly.yml:38-46`).
3. **HEAD is unproven:** local main is **30 commits ahead of origin/main, unpushed**; `artifacts/release/` has no directory for HEAD. Per the evidence contract ("evidence does not transfer across commits", `docs/ops/PROJECT-STATE.md:16`), every green cited belongs to an older tree.

## 3. FUNCTIONAL SCOPE

### 13 agents: **9 real · 2 partial · 1 dark-at-the-seam · 1 deliberately unbuilt**

| Agent | Status | Key fact |
|---|---|---|
| Concierge | REAL | inbound→resolve→price→auto-reply-or-queue; LLM parser CONFIRM-gated, DeterministicParser floor (`packages/agents/src/concierge/parse.ts:235-242`) |
| Rater | REAL but unvalidated | `rater-parity` BLOCKED on fixtures |
| Scheduler | REAL (gate-level) | dock-slot claim gate, capacity, reschedule-must-reference-prior (`transition-gates.ts:410-470`) |
| Dispatcher copilot | NOT BUILT, deliberate | REQ-029 = vNEXT |
| Gatekeeper | REAL — strongest piece | server-side, DO-enforced; live `GATE_BLOCKED` with required_evidence in CI log |
| Biller | REAL | POD→invoice→email through real DO; **prod email dark** (`EVIDENCE_FROM` unbound ⇒ NotConfiguredSender) |
| Collector | REAL, draft-only by design | "DRAFT ONLY — NEVER AUTO-SEND" |
| Settler | PARTIAL | interline split derivation REAL; escrowed instant-settle CONFIRM-GATED/unbuilt (REQ-033) |
| Translator | REAL core, DARK transport | X12 204/990/214/210/997 core built; NotConfiguredTransport fail-closed; live VAN/AS2/SFTP adapter unbuilt |
| Migrator | REAL | fixtures unvendored; live legacy-TMS feed not provisioned (NotConfiguredFeedReader no-ops) |
| Watchtower | REAL | 3 rules → anomalies rows |
| Credit officer | PARTIAL | credit projection + booking hold-gate REAL; no bureau adapter |
| Copilot | REAL | read-only, cite-or-abstain; ClaudeCopilot behind optional key |

### Surfaces: all 3 built + deployed (Command 21 src files, Driver PWA 25 + driver-core, Portal 18; `track` is a portal route, not a 4th surface). Ledger: **35/35 event kinds** (`packages/contracts/src/events.ts:28-37`, length-pinned test), every kind referenced in ≥4 non-test files; 38 ledger source files (canonical hashing, chain verify, Merkle+RFC-3161 TSA, redaction, visibility, 8 projections, GL/IIF export). Schema: 18 tenant + 4 control tables (≤22 budget). Views: 11 of 12 named + tripwire (`apps/command/src/views/registry.ts`). MCP worker: built + deployed; confirm-gate (model can't self-authorize money), CapsMeter DO (TOCTOU-safe), fail-closed no-caps default; `/token`+`/register` 401 until pairing secrets bound.

## 4. FIVE ACCEPTANCE DEMOS — code paths vs missing prerequisites

| # | Demo | Code path | Missing |
|---|---|---|---|
| 1 | POD→invoice+email <5s | **YES**, proven on live staging (55,800¢, real email) | prod `EVIDENCE_FROM` unbound; sender domain unverified; 2-week deliverability warmup not run (REQ-157); no tenant → no POD |
| 2 | Stranger quotes <10 min | PARTIAL — API path real+tested; **no signup UI exists** | `PROVISIONING_ENABLED` unbound (404s); signup UI unbuilt; **ToS/Privacy/DPA counsel CONFIRM (REQ-138) — "public signup legally cannot open"**; Stripe keys unbound |
| 3 | Driver gated stop, zero instruction | **YES** — airplane-soak: 55 signed events / 2 devices / zero loss, chain verifies | **driver login+lockout UNBUILT (REQ-069) — a driver literally cannot sign in**; onboarding kit (REQ-164) unbuilt; e-signature/location-consent counsel CONFIRM (REQ-142/166); map tiles on public third-party host (REQ-075 violation) |
| 4 | Booking from Claude via MCP | PARTIAL — verbs, no-bypass, confirm gate, caps all tested; full DO booking never exercised e2e | OAuth pairing secrets unbound; caps unprovisioned (fail-closed refuse); no tenant sandbox |
| 5 | Exception pulse dims map | **YES — most complete**; whole chain hash-verified | only the filmed live capture; perf gate fails on CI hardware; third-party tiles |

## 5. TENANT #0 REQUIREMENTS (from genesis/13)

Config pack = 9 artifacts (identity, org-roles, approval-matrix, rating-config, continuity, adapters, calendar, confirm-ledger, fixtures-manifest.private). Nine unvendored fixtures all `"status":"pending","sha256":null` — `zone-tariff-v1` is the keystone (blocks WP-04+06+07 simultaneously); `legacy-export-replay` additionally blocked by an open `[CONFIRM]`. **"Generating plausible fixtures to turn those gates green would make the gates lie… the honest move is to waive the gates explicitly, not to feed them inventions"** (`docs/ops/LAUNCH-RUNBOOK.md:266-271`). Plus the not-a-byte-fixture: live legacy-TMS mirror feed + 3-day unattended run (REQ-152). Onboarding calendar irreducible: Mirror → 30-day revenue shadow ±2% → two consecutive clean closes (REQ-153, absolute) → pilot week <0.5% exceptions → parallel/flips = **16–20 weeks from feed-live to incumbent-off, floor ~14** (`genesis/13:26-34`).

## 6. DISTANCE-TO-RUNNING — the 22-item list

**One-liner:** infrastructure done; product has 0 users, 0 tenants, 0 shipments; control plane = 3 system tenants + empty `users` table; no login endpoint exists.

| # | Item | Type | Effort |
|---|---|---|---|
| 1 | Tenant-0 config pack authored (9 artifacts) | EXT+DATA | Weeks |
| 2 | Vendor the 9 fixtures (clears 4 of 5 blocked merge gates) | DATA | Days once granted |
| 3 | Bind `IDENTITY_DENYLIST` (clears 5th) | CONFIG | Hours |
| 4 | **Build a login path** (REQ-069 driver auth + any human login) | CODE | Days–1 wk |
| 5 | **Ratecon generation** (REQ-184/043) — no dispatch until this lands | CODE | Days |
| 6 | Signup UI surface | CODE | Days |
| 7 | Counsel: ToS/Privacy/DPA (REQ-138), photo/PII retention (REQ-140), e-sign/location consent (REQ-142/166) | EXT | Weeks lead |
| 8 | Prod sender domain verify + 2-week warmup + bind EVIDENCE_FROM | CONFIG+EXT | ≥2 wks calendar |
| 9 | Self-host Protomaps tiles + glyphs on R2 (REQ-075) | CONFIG+CODE | Days |
| 10 | Fix map perf gate on CI hardware | CODE | Unknown |
| 11 | OIDC + nightly backup creds + schedule prod backups | CONFIG | Hours–days |
| 12 | Per-IP edge rate limits /pub/* (REQ-193/125) | CONFIG | Hours |
| 13 | PLG activation (PROVISIONING_ENABLED, Stripe, PLATFORM_INTERNAL_SECRET) | CONFIG | Hours (gated on #7) |
| 14 | MCP activation (pairing secrets, caps, webhook source) | CONFIG | Hours–days |
| 15 | Live EDI transport adapter + per-partner cert | CODE+EXT | Weeks |
| 16 | Port claimed-tenant-pool pattern to translator (commit `805dbb8` in unpushed tree — verify) | CODE | Hours |
| 17 | Live legacy-TMS mirror feed + 3-day unattended (REQ-152) | EXT | Weeks |
| 18 | On-call rota + SLO monitor recipients + status page | EXT | Days |
| 19 | Real TSA integration row per prod tenant | CONFIG | Hours |
| 20 | M-H heartbeat milestone decision (gates all GTM) | EXT | A decision |
| 21 | Push 30 unpushed commits + evidence record at HEAD | CODE/process | Hours |
| 22 | The onboarding calendar itself | EXT | **14–20 weeks, non-compressible** |

**Critical-path read:** blocked gates are absent *inputs*, not code defects (`PROJECT-STATE.md:210-212`). Code residual ≈ **1–2 engineer-weeks** (items 4,5,6,10,16). Config residual ≈ **1 week** + item 8's 2-week calendar. **The true blocker is items 1+2+7+22: a tenant relationship, its private data, its counsel, and its calendar — months, and engineering cannot shorten it.**

## What it can perform, for whom, TODAY

| Audience | Today |
|---|---|
| Public | Marketing site + waitlist; four honest unauthenticated surface shells (em dash, not fake zeros) |
| Carrier/dispatcher | **Nothing** — no account exists; /v1/board 401s (verified) |
| Driver | **Nothing** — no login path exists (REQ-069 unbuilt) |
| Shipper/consignee | **Nothing** — no shipments exist |
| Claude via MCP | **Nothing** — /token + /register 401; uncapped pairing cannot book (fail-closed) |
| Engineers | Everything: 258 test files / 3,243 tests, 21-gate merge + 26-gate release profiles, full local dev stack, provisioned+migrated prod, one restore drill |

## Confidence notes
**VERIFIED:** wrangler bindings/UUIDs; both gate JSONs; nine live probes; CI outcomes incl. perf failure log; git ahead/behind + missing HEAD artifact; fixtures manifest; 35-kind list; view registry; surface inventories; absence of any /login route.
**INFERRED:** test totals and pre-HEAD "16 PASS" narratives; staging smoke 55,800¢; restore-drill PASS; preflight 72-check; per-agent real-vs-stub judgments (file size + headers + call-graph greps, not execution).
