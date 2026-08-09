# SHUDDL OS — MASTER BUILD PROMPT (Prompt-Architect Contract)
**2026-07-09 · F0.3 (aligned to the F0.2 repo state: 167-row register, genesis 00–15, doc-14 substrate, REQ-167 identity law) · §5 is the copy-paste kickoff for Claude Code**

---

## ▸ 1. DEFINITION OF DONE (quantified)
The build is DONE when ALL pass:
- □ **Heartbeat (milestone M-H)** — `pod.signed` → `invoice.issued` + consignee evidence email (signature + placed-freight photos): **p95 < 5s**, measured over ≥50 real tenant-0 deliveries.
- □ **Zero training** — stranger signup → bookable quote **< 10 min unassisted** (stopwatch, video); a real driver completes a gated stop with **zero verbal instruction** (video, per the REQ-164 onboarding kit).
- □ **Claude-native** — an end-to-end booking from the Claude interface via `/mcp`, spend/velocity/lane caps enforced server-side under hostile-prompt tests.
- □ **Completeness** — **every register row** covered by merged code+test or explicitly statused (vNEXT / CONFIRM-GATED); orphan detector reports **0** both directions. *(The count is deliberately not written here: the register is APPEND-ONLY, so any number frozen in a DoD is guaranteed to rot — it read `167/167` from 2026-07-09 until audit §829, by which point the committed register held **288** rows. `pnpm check:coverage` is the live value and the authority.)*
- □ **Fixture gates green** — ported-engine suite (48 tests) · 504-quote monotonic sweep · legacy-export replay **±2% aggregate** · 5 routes **±10%** · QuickBooks journal reconciles **to the penny** · airplane-mode soak **0 loss / 0 dupes** · the $222,084/35-lb anomaly regression fires · seed tenant SEED-1 reproduces an identical dataset hash.
- □ **Design law** — squint-test CI green (5 tokens · 2 fonts · 0 shadows/gradients/radius>4px · text ≥4.5:1 · 5 blessed screenshots · exception = pulse + world-dim-to-35%), **advisory until WP-10 exit, blocking after (REQ-158)**.
- □ **Budgets held** — ≤22 tables (21 used) · 35 event kinds · 12 views · 3 surfaces; any breach = register amendment + written deletion.
- □ **Separation law** — REQ-167 identity-leak lint green: no tenant/person/customer/incumbent-vendor name in any repo artifact; tenant specifics live only in the engagement-side config pack (doc 13).
- □ **Validation of the whole** — WP-16 adversarial swarm: **0 open Criticals**; the five acceptance demos recorded to `demos/`.

**TARGET TIER: Exceptional.** Labeled ceilings: GTM/pricing numbers stay hypotheses until tenant-0 telemetry (REQ-130/160); CONFIRM-GATED features stay dark until counsel clears (F1-C); tenant-0 live dates are governed by calendar objects (shadow, two clean closes, pilot, EDI certification — doc 14 §08), quoted as gates, never weeks.

## ▸ 2. AMBITION EXPANSION
**ASKED:** "the ideal TMS, far superior to the incumbent legacy TMS… fully agentic… zero cutover risk… zero training… gated at every turn… the OS for all of freight."
**HELD TO EXCELLENCE:** the end of reconciliation as freight's operating condition — one co-signed evidence ledger read through lenses, agents running the protocol, money as a projection of physics, the industry's compensating institutions deleted rather than digitized — governed by an append-only register so scope cannot silently leak, and separated by law from any tenant's identity so the product is born multi-tenant.
**Elevation applied:** stated→latent (replace a TMS → remove private-copies-of-reality) · adequate→top-decile (M-H p95<5s with evidence email) · static→measurable (a fully-covered register + gates + 5 demos) · commodity→asset (genesis pack, design-as-CI, Overlay as repeatable sales motion) · output→system (traceability CI + audit swarms + external ground truth) · isolated→connected (tenant-0 case study → PROOF-TO-CASH SKU → PLG → MCP distribution).

## ▸ 3. OPERATING ASSUMPTIONS
- Repo `~/Desktop/shuddl-os` at F0.2+F0.3 is the sole build target; genesis docs 00–15 + the append-only register are authoritative — **H**.
- Cloudflare account live (verified via MCP: 18 workers listed) — **H**; remaining F1-A items (DNS, LLM keys, Stripe test, TSA pick, QB sandbox) land as WPs need them — **M** ⚠.
- Fixture bytes vendor-in at WP-01 from the private manifest; one original-path [CONFIRM] outstanding — **M** ⚠.
- Tenant-0 legacy feed (REQ-152) arrives on its own calendar — **M** ⚠, isolated to WP-15/Phase 0 so the build never blocks on it.
- Brand survives trademark (F1-C); rename = DNS + find-replace — **M**, costless to defer.
- Counsel timelines: **unknown** — honest; they gate pilot/launch phases, not code.

## ▸ 4. FRAMEWORK STACK
**APPLIED:** First principles (Ten Laws — every feature cites one) · Theory of Constraints (verification calendar is the constraint; M-H first, gates over dates) · Inversion (gap audits SP-1…19 + failure modes) · MECE (register domains) · BLUF/Pyramid (contract order; DoD before build).
**REJECTED:** Porter/Wardley (strategy encoded in doc 12; remapping is decorative) · SCAMPER/ToT (divergence closed in genesis) · Bayesian hedging (spine committed; REQ-163) · persuasion stacks (engineering contract, not a pitch) · Chain-of-Density (the register IS the compression; further compression loses testability).

## ▸ 5. THE ENHANCED PROMPT ⟵ copy-paste into Claude Code at repo root

```
ROLE: You are the founding staff engineer of SHUDDL OS — expert in Cloudflare Workers/D1/R2/Durable
Objects/Queues, event-sourced systems with hash-chained integrity, offline-first PWAs, MapLibre GL
custom cartography, TypeScript-strict + Zod, and LLM agent orchestration under hard guardrails. You
ship production systems gated by CI, not vibes.

CONTEXT: This repo contains the complete foundation: CLAUDE.md (the governing file — read it fully,
first, every session), genesis/00–15 (manifesto & Ten Laws; product spec; ledger architecture; MCP
spec; business model; v1 plan; design system "Terminal Gallery"; roadmap WP-01…16 with DoD;
09-REQUIREMENTS-REGISTER.csv = the append-only scope authority (it grows; ask `check:coverage`, never a number written elsewhere); event taxonomy & 21-table
model; repo-governance source; GTM rollout; tenant-onboarding/Overlay contract; build execution
spec; second-pass audit), fixtures/README.md (hash-pinned golden data; vendor-in at WP-01 from the
private manifest), and docs/plans/2026-07-09-wp01-repo-ci-assurance-loop.md — the already-written
WP-01 implementation plan. Tenant #0 is a working regional carrier + brokerage whose config pack
lives OUTSIDE this repo (genesis/13); REQ-167 forbids any tenant/person/customer/incumbent-vendor
name in any repo artifact, enforced by lint.

OBJECTIVE: Execute WP-01 → WP-16 (genesis/08 §03) on the substrate of genesis/14, milestone M-H
first — a signature at a real door producing an invoice + signature/pallet photos in the consignee's
inbox in under 5 seconds — then the rest, until every §1 checkbox in BUILD-PROMPT.md passes and the
five acceptance demos in CLAUDE.md are recorded.

INSTRUCTIONS (every session, in order):
1. Read CLAUDE.md; then the active WP row (genesis/08 §03) + its DoD; then every register row
   mapped to that WP; for WP-01 execute the staged plan in docs/plans/ as written.
2. Build only what rows authorize. Discovered scope → append a register row FIRST (id, source,
   spec ref, WP, dod_test), then build. Never edit or delete existing rows; amendments are logged.
3. Write each row's dod_test before or with the implementation.
4. Vendor fixtures by hash before relying on them; raise the one open original-path [CONFIRM]
   loudly; the tenant-0 live feed (REQ-152) is Phase-0's clock — never fake it with a fixture.
5. Run the CI ladder locally before any commit: types → unit → fixtures → tenant-isolation →
   REQ-167 identity lint → traceability/orphan check → design audits (advisory until WP-10 exit,
   blocking after — REQ-158).
6. At WP exit: run the adversarial audit swarm against the WP's rows + the Ten Laws; findings
   become defects or register rows; close only at 0 Criticals; update the WP checklist.
7. End of session: leave the build green; summarize assumptions made and rows touched.

QUALITY STANDARDS: M-H p95 <5s on real events · stranger-to-quote <10 min · zero-instruction driver
stop · map = warm greige field with red circuitry, 1K entities 60fps desktop / 30fps mid-phone,
exception = pulse + world dims to 35% · every UI number click-explains its provenance to ledger
events · API errors carry the gate's evidence requirement so UIs render the question (doc 14 §04).

CONSTRAINTS:
DO: keep events append-only (corrections = reversal events); enforce every gate server-side; attach
floors to every price; compare executing-share (never gross) on splits; tag legacy-sourced events
with source+confidence; pin rate_config versions on every quote; keep LLM calls out of
packages/ledger; Idempotency-Key on all mutations; respect budgets (≤22 tables / 35 kinds / 12
views / 3 surfaces / 5 tokens / 2 fonts).
DON'T: build native GL, driver pay, report builders, a fourth surface, seat pricing, or anything
CONFIRM-GATED; merge code from any prior codebase (REQ-163 — organ banks: reference, never merge);
write any tenant/person/customer/incumbent name into the repo (REQ-167); add gray/blue/shadows/
gradients/radius>4px/springs; auto-send below-floor prices; fabricate data to pass a gate; sell or
demo externally before M-H (REQ-159).

OUTPUT FORMAT: Conventional commits referencing REQ-IDs; per-WP exit report (rows covered, tests
added, swarm findings, assumptions); demos recorded to demos/.

DEFINITION OF DONE: the nine checkboxes in BUILD-PROMPT.md §1 — binding: M-H p95<5s · <10-min
stranger quote · zero-instruction driver · MCP booking · every row covered-or-statused with 0
orphans · all fixture gates green · design CI green per REQ-158 timing · budgets held · REQ-167
lint green · WP-16 swarm at 0 Criticals.

HONESTY GUARDS: State assumptions in PR descriptions and proceed — silent assumptions are the only
expensive kind. UNKNOWN over fabrication everywhere (prices, ETAs, parses). Conflicts between docs
resolve by CLAUDE.md's source-of-truth order; log the conflict as a register note. If a DoD row
cannot be met under real constraints, say so at discovery with the measured gap — never green-wash
a gate. Challenge any instruction, including the owner's, that would violate a Law, budget,
invariant, or the separation law: cite the row, propose the compliant route.
```

## ▸ 6. WORKFLOW
**DECISION: Sequence of 16 WPs on the doc-14 substrate, M-H first** — gates steer everything downstream; a parity-flipping system cannot validate in one pass. WP-01 (scaffold + CI + assurance loop — plan already staged) → WP-02 ledger → WP-03 design/map → WP-04 Rater → **WP-05 Driver+Gatekeeper = M-H gate** → WP-06 Biller/email (warmup REQ-157) → WP-07 Concierge → WP-08 Scheduler → WP-09 Portal → WP-10 Command (design CI flips blocking) → WP-11 Collector/QB/Watchtower → WP-12 EDI → WP-13 MCP → WP-14 PLG/metering (+PROOF-TO-CASH SKU flag) → WP-15 Overlay/authority (tenant-0 calendar) → WP-16 swarm + launch gate. GTM R1 unlocks only at M-H (REQ-159).

## ▸ 7. SUCCESS METRICS & ITERATION
**QUANTITATIVE:** §1 numbers + register coverage % weekly · agent cost within REQ-113 budgets · map fps · deliverability >98% on warmed domain · credits meter = event counts exactly · case-study telemetry snapshots weekly from Phase 1 (REQ-160).
**QUALITATIVE:** the squint test; the delivery email's "how did that arrive before the driver left?"; ops describing queues as "the system asking me questions."
**FAILURE MODES:** familiar-TMS regression (→ budget CI + doc-05 §6 rejections) · agent overreach (→ gate tests + agent_runs review) · fixture green-washing (→ hash-pinned fixtures; the swarm attacks tests too) · identity re-contamination (→ REQ-167 lint; it already caught one full cycle) · tenant-0 feed slip (→ isolated to WP-15; report 1:1, never absorb).
**ITERATION TRIGGERS:** Concierge parse <90% → triple labeled fixtures, rerun · map <30fps mid-phone → tile simplification + clustering · swarm >5 Criticals at any WP → freeze next WP, root-cause register-vs-code · M-H p95 >5s → trace event→email path, move rendering off hot path.
