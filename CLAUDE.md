# CLAUDE.md — SHUDDL OS
### The governing file for every build session. Read completely before writing code.

## What you are building
SHUDDL: the freight operating system. An append-only, co-signed **event ledger** of physical freight reality; **13 agents** that run the protocol; **3 surfaces** (Command, Driver PWA, Portal) on a live greige/coral map; money as a projection of physics (POD → invoice + evidence email, same second). Full spec: `genesis/` docs 00–15. The Ten Laws in `genesis/00` override any instinct you have. **Tenant #0 = a working regional carrier + brokerage; its config pack lives in its engagement workspace, outside this repo** (`genesis/13`); milestones + execution substrate per `genesis/14`; GTM unlocks per `genesis/12` (never before M-H).

## Source-of-truth order (conflicts resolve upward)
1. `genesis/09-REQUIREMENTS-REGISTER.csv` — scope. If it isn't a REQ row, it doesn't get built; if you discover scope, ADD A ROW first (append-only).
2. `genesis/10-EVENT-TAXONOMY-DATA-MODEL.md` — schema + invariants I1–I8.
3. `genesis/07-DESIGN-SYSTEM.md` — every pixel. The squint-test CI is law.
4. `genesis/14-BUILD-EXECUTION-SPEC.md` — environments, API/auth conventions, CI gates, milestones (M-H first).
5. `genesis/08-GAP-AUDIT-ROADMAP-ASSURANCE.md` — WP order + DoD. `genesis/13` — tenant onboarding interface + config-pack contract. `genesis/00–03, 12` — intent.

## Hard budgets (CI-enforced; exceeding = the PR is wrong)
≤22 tables (21 used; the spare requires a written deletion) · 3 surfaces + command bar + queues · 12 canonical views · 35 event kinds (additions = register amendment) · 5 color tokens · 2 font families · 0 shadows/gradients/radius>4px.

## Stack (decided — do not relitigate)
Cloudflare Workers + Hono · D1 per-tenant (control plane separate) · R2 evidence + tiles · Durable Objects (ledger sequencing, live boards) · Queues (agent triggers) · MapLibre GL + self-hosted Protomaps vectors · React 19 + Vite PWAs · TypeScript strict, no `any` · Zod at every boundary · Stripe (billing) · LLM calls only inside `packages/agents/*` — **never** in `packages/ledger` (REQ-024, statically linted).

## Non-negotiable engineering rules
1. **Every PR references REQ-IDs**; traceability CI blocks orphans (both directions).
2. **Events are append-only**: no UPDATE/DELETE paths on `events`, ever, including migrations. Corrections are new events (I3, I7).
3. **Gates are server-side** (Gatekeeper); UIs merely reflect them. Any flow reachable by API must enforce the same gate (REQ-030).
4. **No price on air**: missing weight/dims → UNKNOWN, no sell. (Corrected 2026-08-02, audit §60 — the previous wording said the 504-quote monotonic sweep and 48 engine tests "ship in `fixtures/` and must stay green". **They do not ship.** `fixtures/manifest.json` marks `rater-504-sweep` and `rater-48-tests` `status: "pending"`, `sha256: null`, sourced from the engagement workspace (`manifest.private M-01`) — so `check:fixtures` reports `PENDING, executed: false, assertions: 0` and **exits 2 on `--mode merge`**, which is one of the five private-fixture holds. What IS green in-repo is `packages/rater/test/sweep.test.ts`: a representative **property** test over 7 zones × 72 weights = 504 priced cells, proving the same weight- and distance-monotonicity against tariffs this repo controls. Keep that green; the audited engine's real sweep arrives with the vendored fixture.)
5. **Interline floors compare the executing share, never gross.** The $222,084/35-lb anomaly regression is permanent (REQ-040).
6. **Fixtures gate merges**: legacy-export replay ±2% aggregate · routes ±10% · QB export reconciles to the penny · airplane-mode soak for driver flows (`fixtures/README.md`).
7. **Design CI**: color/contrast/font/case/radius/shadow/motion audits + 5 blessed screenshots. `--signal-deep` is tuned by the contrast test, not by eye. ~~Advisory (report-only) until WP-10 exits, blocking thereafter (REQ-158)~~ — **BLOCKING as of WP-10 exit; verified 2026-08-05, audit §258.** `tools/design/design-ci.json` is `{"mode":"blocking"}` and `gatesFor("merge")` carries `design-audit` **non-skippable**, so a violation fails the merge (proved by planting a shadow, an over-budget radius and a raw hex — §252 — and by drifting the palette, which the gate catches on every copy because its allowlist is *derived* from the tokens — §257). The perf/browser gates are mode-aware, not report-only: advisory in a bare local run, FAIL/BLOCKED under `--mode merge|release` (§256). The original clause is struck rather than deleted because its *reason* still governs any future gate: pixel law must not stall ledger work.
8. **Tenant isolation suite** runs on every merge; a cross-tenant read anywhere is a build failure (REQ-025).
9. **Adversarial audit swarm at every WP exit** (50-agent pattern; it found 42 real defects in a "finished" module). No open Criticals at close (REQ-119).
10. **No silent drops in migration**: any legacy column (171-col export) that doesn't map raises a gap row — never disappears (Migrator rule).

## Do not build (ever, without a register amendment signed by the owner)
Native GL/period close (journal export only) · driver pay v1 · report builder (12 views + copilot) · a fourth surface · a fifth primitive · seat-based pricing · gray text, blue anything, shadows, spring animations · SMC3/class as engine foundation (adapter only) · **any code merge from prior codebases (2023 apps or any pre-genesis TMS build) — organ banks only, reference never merge (REQ-163, doc 13 §01)** · any tenant/person/customer/incumbent-vendor name in any repo artifact (REQ-167 identity-leak lint) · anything whose REQ row says CONFIRM-GATED while the CONFIRM is open (Direct merchant, voice recording, escrow settle).

## Working agreement
Work WP by WP (`genesis/08` §03). Start of session: read the WP row + its REQ rows + DoD; end of session: update the WP checklist, note any new REQ rows proposed, leave the build green — **and "green" means `pnpm verify:merge`, not `pnpm verify`** (added 2026-08-09, audit §836). `verify` is `verify:dev`, a 16-step `&&` chain with `pnpm test` at step 4; while any test fails it **stops there and the remaining twelve gates never run** — measured, it reaches 4 of 16, so invariants, coverage, traceability, identity, the parity gates and the design audit report nothing at all. `verify:merge` runs all 26 gates independently and aggregates, which is why it is the only complete verdict. Use `verify:dev` for a fast inner loop; never read its failure as a statement about the gates it did not reach. Ambiguity = state your assumption in the PR description and proceed (do not stall); wrong assumptions are cheap, silent ones aren't. The five acceptance demos that define "done enough to show": (1) signature at a door → invoice + photos in the client's inbox <5s; (2) a stranger signs up and quotes in <10 min; (3) a real driver completes a gated stop with zero instruction; (4) a booking placed from Claude via MCP; (5) the exception pulse dimming the map while everything else stays quiet.
