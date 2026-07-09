# SHUDDL — Second-Pass Audit & Build-Readiness Verdict
## Genesis doc 15 · 2026-07-09 (F0.2, corrected same day) · what F0 was missing, what closed it, what the correction pass caught, and what honestly remains
Audited: docs 00–11 + register + fixtures manifest + the tenant-0 replacement brief (engagement workspace) + current public-market state. Method identical to doc 08: every gap gets an ID, a disposition, and a home. Doc 08's twenty gaps all remain closed as dispositioned. **This doc was rewritten the same day it was created:** the first F0.2 cut introduced tenant identity into this repo and imported client-engagement material — SP-19 records that failure and its remediation. The separation law now enforced everywhere: **no tenant names, no people, no customer terms, no incumbent-vendor names, no tenant financials in this repo — config packs live client-side (doc 13 §02).**

---

## (01) SECOND-PASS GAPS (SP-1…SP-19, all dispositioned)

| # | Gap | Severity | Disposition |
|---|---|---|---|
| SP-1 | **No market chapter** — 149 REQs, zero buyer/competitor/GTM sequencing; design system ranked Blocker while ICP didn't exist | Blocker for rollout, not code | **CLOSED — doc 12** (R0–R4 gated by milestones; ICP; first-25 criteria; positioning; tripwires) + REQ-159–162. Public-market competitor names permitted there; tenant identity not |
| SP-2 | **No tenant onboarding interface** — "nothing hardcoded" kept tenants out of the docs, but deployment needs config, roles, seeds, and a calendar *somewhere* | Blocker for tenant-0 | **CLOSED — doc 13**: the Tenant Config Pack contract; packs live in each tenant's private engagement workspace + REQ-152/153/165 |
| SP-3 | **Spine question re-opened in error** — the first F0.2 cut imported a client-side replacement brief and "ruled" between spines. **No conflict existed**: this set had already decided (README; doc 06 logic) that no prior codebase becomes the spine | High (self-inflicted) | **CLOSED — doc 13 §01 correction**: ruling withdrawn as unnecessary; the standing decision restated; prohibition kept and generalized (REQ-163: prior codebases = organ banks, reference never merge). No client document governs this repo |
| SP-4 | **Schedule conflation** — "12 weeks to v1-complete" vs 16–20 weeks to daily-ops authority; both true, never reconciled | High | **CLOSED — doc 14 §08**: quote milestone gates, never weeks; live dates governed by the tenant's calendar objects (shadow, two consecutive closes, pilot, partner EDI certification) |
| SP-5 | **Phone/walk-in intake unspecified** — Concierge covers email; a CSR taking a phone order had no sanctioned path | High | **CLOSED — REQ-150**: question-driven command-bar intake emitting booking events; still no entry module |
| SP-6 | **Rating cold-start for new tenants** — PLG promised "first quote in 5 minutes" but a fresh tenant has no tariff/cost surface | High (R4 blocker) | **CLOSED — REQ-151**: tariff templates + guided builder; brokerage mode prices market+margin; asset mode without tariff = UNKNOWN, no sell (L4 holds) |
| SP-7 | **Live legacy feed was a risk, not a requirement** — Risk #1 in every tenant-0 brief, absent from the register | High | **CLOSED — REQ-152** + fixtures/README row; Phase-0 clock starts at the standing data request |
| SP-8 | **No environments/secrets/deploy spec** | Blocker for WP-01 | **CLOSED — doc 14 §§01–02** + REQ-154/155 |
| SP-9 | **No API/auth conventions** — error shapes, idempotency, tenant resolution, device-key mechanics implied, not specified | Blocker for WP-01 | **CLOSED — doc 14 §§04–06** + REQ-156 |
| SP-10 | **Email warmup unspecified** — WP-06 demanded >98% deliverability with no ramp plan | High | **CLOSED — REQ-157** + doc 14 §03 |
| SP-11 | **Design CI blocking too early** — pixel law gating ledger PRs from week 1 | Med | **CLOSED — REQ-158**: advisory until WP-10 exit, blocking after; both CLAUDE.md files amended |
| SP-12 | **Driver GPS consent** — REQ-140 covered consignee PII; tracking employees' location had no policy or consent flow | High (legal) | **CLOSED — REQ-166**: consent captured as an event before the first stamp; language lives pack-side, counsel-reviewed |
| SP-13 | **Driver install/onboarding path** — "zero training" still requires the app to reach the phone | Med | **CLOSED — REQ-164**: QR + magic link + printed card; tested with a real tenant-0 driver |
| SP-14 | **No GTM/build coupling** — nothing prevented selling before the product existed | Med | **CLOSED — REQ-159** + doc 12 §08 tripwires pause GTM on slipped gates |
| SP-15 | **Case study never instrumented** — the GTM rests on tenant-0's before/after; nobody owned capturing it | High | **CLOSED — REQ-160**: weekly Watchtower snapshots from Phase 1 week 1; baselines live pack-side (doc 13 §06) |
| SP-16 | **No seed/demo tenant** for CI, screenshots, dev | Med | **CLOSED — REQ-155**: SEED-1, synthetic only |
| SP-17 | **Tenant seed-load acceptance implicit** | Med | **CLOSED — REQ-165** incl. the anchor contract-pricing regression |
| SP-18 | **Org facts handling undefined** — tenant org data has known conflicts and lives outside this repo | Med (process) | **CLOSED — doc 13 §03**: seats-not-names, name resolution only inside the tenant's canonical-facts source at deploy; contested seats [CONFIRM]-block assignment, never the build |
| SP-19 | **Tenant-identity contamination (the correction this rewrite records).** The first F0.2 cut wrote the tenant's name, employee names, a customer's name and contract terms, incumbent-vendor names, facility locations, close dates, and tenant financial baselines into docs 12–15, the register, fixtures/README, and both CLAUDE.md files — violating the set's own design rule ("no legacy-platform names anywhere") and importing client-engagement material into the product repo | **Blocker (confidentiality + IP separation)** | **CLOSED, same day:** full-repo identifier sweep → docs 12/14 scrubbed line-by-line · doc 13 deleted and rewritten as the generic onboarding interface · this doc rewritten · register rows amended (log in §05) · fixtures/README genericized with a private-manifest pointer · both CLAUDE.md files reverted to tenant-clean language · the pre-existing WP-01 implementation plan (`docs/plans/`) scrubbed of tenant paths (fixture sources now cite manifest.private refs) · tenant specifics relocated to a **config pack in the engagement workspace** (names still excluded there — seats + facts-file pointers only) · **REQ-167 identity-leak lint** added so CI enforces this permanently. Pre-existing minor leaks in docs 08/11 and fixtures/README (partner/tool/dataset names) cleaned in the same pass. Opaque dataset ids (e.g. the legacy-export date code) are retained as fixture labels — they identify datasets, not parties |

## (02) READINESS BY DIMENSION (detectable · attributable · convergent)
| Dimension | State | Evidence |
|---|---|---|
| Scope authority | **✓** | Register 167 rows, append-only, both-direction traceability CI spec'd |
| Schema/invariants | **✓** | Doc 10: 35 kinds, 21 tables, I1–I8; spare-table rule intact |
| Build substrate | **✓** | Doc 14: repo, envs, secrets, API/auth, pipeline, CI/CD |
| Build order | **✓** | Doc 05/08 WPs + doc 14 milestones; M-H is the only date that matters first |
| Tenant separation | **✓ (now enforced)** | Doc 13 contract + REQ-167 lint; repo grep-clean of tenant identity |
| Tenant-0 onboarding | **✓ minus pack [CONFIRM]s** | Pack template complete; one finance-owner session clears the field-mapping blockers |
| GTM | **✓ (hypothesis-labeled)** | Doc 12; every number re-bases on tenant-0 telemetry (REQ-130) |
| Fixtures | **◐** | Manifest complete by role; one original-path [CONFIRM] at WP-01 vendor-in |
| Legal | **◐** | GA-11 counsel list + REQ-166 consent language open; blocks pilot/launch phases only |
| Data access | **✗ until the feed lands** | The tenant's standing data request (REQ-152) remains the single highest-leverage act |

## (03) THE F1 GATE, CONSOLIDATED (supersedes the scattered F1 lists in docs 08/README)
- **F1-A — blocks the first commit (one admin day, owner):** GitHub repo · Cloudflare account + 3 envs · DNS access · LLM API keys (per-agent budgets) · Stripe test · TSA endpoint pick · QuickBooks sandbox.
- **F1-B — blocks tenant-0 phases (never the build):** legacy-feed access (Phase 0 exit, REQ-152) · finance-owner session per the pack confirm-ledger (entity structure, code semantics, data flags, baselines, approval matrix) · pilot facility + gate owner (Phase 2) · tenant org-facts verification (role assignments) · driver consent language from counsel (Phase 2, REQ-166) · incumbent contract terms (Phase 4).
- **F1-C — blocks external launch only:** name/trademark ([CONFIRM-1]) · counsel list (GA-11) · tenant-0 publishing consent.

## (04) VERDICT
**READY FOR CLAUDE CODE AT WP-01 the day F1-A completes.** The register is whole (167), the schema is unambiguous, the substrate is specified, tenant onboarding has a contract with identity provably outside the repo, and the market has a chapter. The honest remainders are calendar, not code: the tenant's data feed, and the physics of verification (30-day shadow + two consecutive clean closes + a pilot week ≈ 16–20 weeks from feed-live to incumbent-off). Quote gates, not weeks. Build M-H first; nothing else earns the right to exist until a signature at a door puts an invoice and two photos in a client's inbox in the same breath — on tenant-0's real freight.

## (05) REGISTER AMENDMENT LOG (F0.2, same-day, before any build consumption)
- **Appended:** REQ-150…166 (first cut) · REQ-167 (identity-leak lint, correction pass).
- **Amended same-day for identity scrub (wording only, scope unchanged):** REQ-152, 153, 160 (spec ref), 163, 164, 165, 166 (spec ref).
- **Pre-existing rows amended for the same reason (wording only):** REQ-034 (partner name → primary-partner-format), REQ-041 (tool name → ported rating engine).
- **F0.3 (same day, third-party audit before kickoff):** person-name scrub completed in docs 00/06/08 + REQ-120 (wording only — role replaces name, per REQ-167); root README re-based to 167 rows / F1-A gate; BUILD-PROMPT.md rewritten tenant-clean and aligned to docs 00–15, 167 rows, doc-14 substrate, REQ-158 CI timing, and the standing WP-01 plan in docs/plans/.
- No row was deleted; no scope was dropped; every amendment is visible in this log per the append-only discipline (doc 08 §02.1).
