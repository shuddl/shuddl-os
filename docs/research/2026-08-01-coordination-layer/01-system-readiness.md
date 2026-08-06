# 01 — How Far Is SHUDDL From a Running System, and What Can It Perform, For Whom?
**Date:** 2026-08-01 · Part of the [coordination-layer research program](00-goal-and-dods.md) · Evidence base: [raw/readiness-audit.md](raw/readiness-audit.md) (live-probed, file-cited audit; VERIFIED vs INFERRED flagged there)

---

## 1. The honest answer, in three sentences

**The infrastructure is running; the product is not.** All nine production hostnames answer over the wire today (verified 2026-08-01: `api`/`mcp`/`billing`/`command`/`driver`/`portal`/`track`.shuddl.tech + apex), backed by real, cross-consistent D1/R2/KV/DO/Queue bindings — but the control plane holds three system tenants and an **empty `users` table**, there is **no login endpoint anywhere in the API**, and the only session-minting route (`POST /pub/signup`) is dark behind an unbound flag. **Zero users, zero tenants, zero freight** — the system currently serves a marketing site, four honest unauthenticated surface shells, and a fail-closed API that 401s everything (which is the gates doing their job).

The distance to "running" is **not primarily engineering**. Sixteen work packages are closed; the code residual is ~1–2 engineer-weeks. The distance is a *tenant*: private data, counsel sign-offs, and a non-compressible 14–20-week onboarding calendar.

## 2. What it can perform today, for whom

| Audience | Today | Why |
|---|---|---|
| Public | Marketing site + waitlist; surface shells that render honest empty states (an em dash, never a fake zero) | Separate marketing account; surfaces deployed |
| Carrier / dispatcher | **Nothing** | No account exists; `/v1/board` 401s (live-verified) |
| Driver | **Nothing** | No login path exists at all — REQ-069 unbuilt |
| Shipper / consignee | **Nothing** | No shipments exist to track |
| Claude via MCP | **Nothing yet** | `mcp.shuddl.tech` answers, but `/token`/`/register` 401 until pairing secrets are bound; an uncapped pairing *cannot* book (fail-closed by design) |
| Engineers | Everything | 258 test files / 3,243 tests; 21-gate merge + 26-gate release profiles; provisioned, migrated, once-restore-drilled prod |

## 3. Gate status (last authoritative records, 2026-07-31)

Release profile: **16 PASS · 8 BLOCKED → aggregate BLOCKED, not promotable.** Merge profile: 16 PASS · 5 BLOCKED. Passing: runtime, typecheck, lint, unit-tests, invariants, rater-purity, authority-coverage, traceability, coverage, seed, acceptance, design-audit, perf(local), visual, a11y, e2e, deploy-preflight(72 checks). Blocked, with verbatim reasons — **every one an absent input, not a code defect** (`PROJECT-STATE.md:210-212`):

| Gate | Blocking input |
|---|---|
| identity-leak | no denylist bound (`IDENTITY_DENYLIST`) |
| fixtures | 9 private engagement fixtures not vendored |
| rater-parity / invoice-parity / concierge-parse | same fixtures (`zone-tariff-v1` is the keystone — blocks three WPs at once) |
| restore-verify | no restore snapshots supplied to reconcile |
| staging-smoke | no `SMOKE_API_BASE` bound in CI |
| backup-manifest | OIDC/backup credentials absent |

**Three problems the repo's own record does NOT yet capture** (surfaced by this audit — new information):

1. **The last CI run on `origin/main` is RED**, and not on a fixture gate: the map `perf` gate fails on GitHub-hosted hardware (p95 233ms ≈ 4fps vs the 55fps budget) while passing locally on the same commit. Unrecorded in PROJECT-STATE/RELEASE-EVIDENCE.
2. **Nightly backups are failing and staging-scoped** — production is never backed up on a schedule (credentials unbound; `.github/workflows/nightly.yml:38-46`).
3. **Local `main` is far ahead of `origin/main`, unpushed, with no evidence record at HEAD** — by the repo's own evidence contract, the current tree is unproven. *(Corrected 2026-08-02: the source audit cited "30 commits ahead" and named `d6eec18` as HEAD. Re-measured directly — HEAD is `82e04c7` (2026-08-02) and `d6eec18` is an **ancestor**, not HEAD; the true count is **92 commits ahead**. The finding stands and is larger than first reported; the SHA and count were wrong.)*

## 4. Functional completeness (the "is the code real?" question)

- **Agents: 9 of 13 substantially real** (Concierge, Rater, Scheduler, Gatekeeper, Biller, Collector, Watchtower, Copilot, Migrator), **2 partial** (Settler — interline split real, escrow settle CONFIRM-gated; Credit officer — projection+gate real, no bureau adapter), **1 dark at the transport seam** (Translator — full X12 core, no live VAN/AS2/SFTP), **1 deliberately vNEXT** (Dispatcher copilot, REQ-029). The Gatekeeper is the strongest piece: server-side, Durable-Object-enforced, observably emitting `GATE_BLOCKED` with required-evidence lists in CI.
- **Ledger: 35/35 event kinds** implemented with Zod envelopes and length-pinned tests; canonical hashing, chain verification, Merkle + RFC-3161 anchoring, redaction/visibility, 8 projections, GL/IIF export. 18 tenant + 4 control tables — inside the ≤22 budget.
- **Surfaces: all three built and deployed** (Command 21 source files, Driver PWA 25 + driver-core offline sync, Portal 18 with `track` as a route, not a fourth surface).
- **Views: 11 of 12 canonical** named in a budget-tripwired registry.
- **MCP server: deployed** with the right security shape — structured confirm gate (the model cannot self-authorize money), a Durable-Object caps meter (TOCTOU-safe), fail-closed defaults.

## 5. The five acceptance demos — what's actually between each and reality

| Demo | Code path | The gap is… |
|---|---|---|
| 1. POD → invoice + evidence email <5s | **Complete**; proven on live staging (penny-exact 55,800¢, real email sent) | Config + calendar: prod sender domain verification + 2-week deliverability warmup (REQ-157) + `EVIDENCE_FROM` binding + a tenant with real PODs |
| 2. Stranger signs up and quotes <10 min | API path complete; **no signup UI exists** | Code (signup surface) + **counsel: REQ-138 ToS/Privacy/DPA — "public signup legally cannot open"** + Stripe keys + flag flip |
| 3. Real driver, gated stop, zero instruction | **Complete** incl. offline soak (55 signed events, 2 devices, zero loss) | **Code: driver login/lockout (REQ-069) is unbuilt — a driver cannot sign in.** Plus consent-text counsel, onboarding kit, self-hosted tiles (currently a third-party demo host, REQ-075 violation), and a real pilot |
| 4. Booking placed from Claude via MCP | Verbs + confirm + caps tested; full DO-backed booking never exercised e2e | Config: pairing secrets + caps provisioning + a tenant sandbox; then one staging smoke |
| 5. Exception pulse dims the map | **Most complete** — full chain hash-verified | The filmed live capture; and the CI-hardware perf failure (§3.1) |

## 6. Distance-to-one-real-tenant (itemized; full 22-row table in [raw/readiness-audit.md](raw/readiness-audit.md) §6)

By class:

- **CODE (~1–2 engineer-weeks total):** login path (REQ-069 + any human login) · ratecon generation (REQ-184/043 — *no dispatch until this lands*) · signup UI · map-perf-on-CI fix · translator tenant-pool port (may already be in the unpushed tree — verify at HEAD).
- **CONFIG (~1 operator-week, plus one 2-week calendar item):** identity denylist · prod sender + warmup (REQ-157, ≥2 weeks) · self-hosted tiles (REQ-075) · backup OIDC + prod backup schedule · edge rate limits · PLG activation flags/Stripe · MCP pairing secrets + caps · TSA integration row.
- **EXTERNAL (the real critical path — months):** tenant-0 config pack (9 artifacts, genesis/13) · counsel sign-offs (REQ-138/140/142/166) · live legacy-TMS mirror feed + 3-day unattended run (REQ-152) · on-call rota · the M-H milestone decision (gates all GTM) · **the onboarding calendar itself: mirror → 30-day revenue shadow ±2% → two consecutive clean closes → pilot <0.5% exceptions → parallel — 14–20 weeks, non-compressible.**
- **DATA:** the nine private fixtures (`zone-tariff-v1` keystone). The repo's own runbook forbids faking them: *"the honest move is to waive the gates explicitly in the register, not to feed them inventions"* (`LAUNCH-RUNBOOK.md:266-271`).

## 7. Readiness verdict (feeds docs [04](04-interop-system-design.md), [06](06-north-star-and-decision-framework.md), [07](07-path-forward.md))

1. **As a software artifact, SHUDDL is ~95% of a single-tenant freight OS** — with unusually strong verification architecture (append-only + co-sign + server gates + evidence-or-refuse defaults) that the entire competitive field lacks ([03](03-competitor-landscape.md) F2/F3).
2. **As a running business system, it is at 0** — and the remaining distance is dominated by exactly one dependency: a real tenant with real data and a real calendar. This matches, precisely, the necessary-condition #1 from the interop research (*single-participant ROI on day one*): the build cannot prove its thesis without participant #1, and no further engineering substitutes for that.
3. **Local hygiene debt exists and is cheap to clear:** push the 92 unpushed commits, produce an evidence record at HEAD (`82e04c7`), record the CI perf failure and the backup gap in the ops record.
4. Immediate hygiene items (#3) are candidates for the next *development* session — **not performed in this research phase** per constraint C1.
