# CLAUDE.md — SHUDDL OS (drop this file at repo root, verbatim, when the repo is created)
### The governing file for every build session. Read completely before writing code.

## What you are building
SHUDDL: the freight operating system. An append-only, co-signed **event ledger** of physical freight reality; **13 agents** that run the protocol; **3 surfaces** (Command, Driver PWA, Portal) on a live greige/coral map; money as a projection of physics (POD → invoice + evidence email, same second). Full spec: `Shuddl-OS-Genesis/` docs 00–15. The Ten Laws in doc 00 override any instinct you have. **Tenant #0 = a working regional carrier + brokerage; its config pack lives in its engagement workspace, outside this repo** (doc 13); milestones + execution substrate per doc 14; GTM unlocks per doc 12 (never before M-H).

## Source-of-truth order (conflicts resolve upward)
1. `09-REQUIREMENTS-REGISTER.csv` — scope. If it isn't a REQ row, it doesn't get built; if you discover scope, ADD A ROW first (append-only).
2. `10-EVENT-TAXONOMY-DATA-MODEL.md` — schema + invariants I1–I8.
3. `07-DESIGN-SYSTEM.md` — every pixel. The squint-test CI is law.
4. `14-BUILD-EXECUTION-SPEC.md` — environments, API/auth conventions, CI gates, milestones (M-H first).
5. `08-…ROADMAP…` — WP order + DoD. `13` — tenant onboarding interface + config-pack contract. `00/01/02/03/12` — intent.

## Hard budgets (CI-enforced; exceeding = the PR is wrong)
≤22 tables (21 used; the spare requires a written deletion) · 3 surfaces + command bar + queues · 12 canonical views · 35 event kinds (additions = register amendment) · 5 color tokens · 2 font families · 0 shadows/gradients/radius>4px.

## Stack (decided — do not relitigate)
Cloudflare Workers + Hono · D1 per-tenant (control plane separate) · R2 evidence + tiles · Durable Objects (ledger sequencing, live boards) · Queues (agent triggers) · MapLibre GL + self-hosted Protomaps vectors · React 19 + Vite PWAs · TypeScript strict, no `any` · Zod at every boundary · Stripe (billing) · LLM calls only inside `packages/agents/*` — **never** in `packages/ledger` (REQ-024, statically linted).

## Non-negotiable engineering rules
1. **Every PR references REQ-IDs**; traceability CI blocks orphans (both directions).
2. **Events are append-only**: no UPDATE/DELETE paths on `events`, ever, including migrations. Corrections are new events (I3, I7).
3. **Gates are server-side** (Gatekeeper); UIs merely reflect them. Any flow reachable by API must enforce the same gate (REQ-030).
4. **No price on air**: missing weight/dims → UNKNOWN, no sell. (The 504-quote monotonic sweep and 48 engine tests ship in `fixtures/` and must stay green.)
   > **FACTUAL CORRECTION 2026-08-02 (audit §60/§61) — the law is untouched; only the parenthetical was wrong.**
   > Those two artifacts do **not** ship in `fixtures/`. `fixtures/manifest.json` marks `rater-504-sweep` and
   > `rater-48-tests` `status: "pending"`, `sha256: null`, sourced from the engagement workspace
   > (`manifest.private M-01`); `check:fixtures` reports `PENDING, executed: false, assertions: 0` and exits 2
   > under `--mode merge` — one of the five private-fixture holds. What is green in-repo is
   > `packages/rater/test/sweep.test.ts`, a representative **property** test (7 zones × 72 weights = 504 priced
   > cells) proving the same monotonicity against tariffs this repo controls. The imperative — *no price on
   > air* — stands exactly as written. `CLAUDE.md` carries the same correction.
   >
   > *Why correct BOTH (refined in §62, after actually diffing them): this file is a **template** — "drop
   > this file at repo root, verbatim, when the repo is created" — and the root `CLAUDE.md` is its
   > instantiation with paths resolved (`genesis/09-…`) plus a few clarifying additions. They already diverge
   > intentionally in several places, so they are not kept byte-identical and no regeneration will clobber the
   > root file. The reason to fix the template is simpler: it is the artifact a future repo (or a reader
   > reaching for the canonical wording) starts from, and it should not hand them a claim that is false.*
5. **Interline floors compare the executing share, never gross.** The $222,084/35-lb anomaly regression is permanent (REQ-040).
6. **Fixtures gate merges**: legacy-export replay ±2% aggregate · routes ±10% · QB export reconciles to the penny · airplane-mode soak for driver flows (`fixtures/README.md`).
7. **Design CI**: color/contrast/font/case/radius/shadow/motion audits + 5 blessed screenshots. `--signal-deep` is tuned by the contrast test, not by eye. **Advisory (report-only) until WP-10 exits, blocking thereafter (REQ-158).**
   > **FACTUAL CORRECTION 2026-08-05 (audit §258) — the law is untouched; its CONDITION has resolved.**
   > WP-10 has exited and the flip fired. `tools/design/design-ci.json` is `{"mode":"blocking",
   > "note":"REQ-158: flipped to blocking at WP-10 exit — pixel law now gates merges."}`; `tools/design/
   > audit.ts:296` exits 1 in that mode; and `gatesFor("merge")` carries `design-audit` in the
   > **non-skippable** group, so a pixel violation fails a merge outright. Proved rather than read: §252
   > planted a shadow, an over-budget radius and a raw hex (three REDs) and §257 drifted the palette, which
   > the gate caught on every copy because its allowlist is *derived* from the tokens. The perf/browser
   > gates are mode-aware, not report-only — advisory in a bare local run, FAIL/BLOCKED under
   > `--mode merge|release` (§256). The sentence above is preserved because its REASON still governs any
   > future gate: pixel law must not stall ledger work. A conditional acquires a maintenance obligation the
   > day its condition resolves; this one went unread for the whole interval.
8. **Tenant isolation suite** runs on every merge; a cross-tenant read anywhere is a build failure (REQ-025).
9. **Adversarial audit swarm at every WP exit** (50-agent pattern; it found 42 real defects in a "finished" module). No open Criticals at close (REQ-119).
10. **No silent drops in migration**: any legacy column (171-col export) that doesn't map raises a gap row — never disappears (Migrator rule).

## Do not build (ever, without a register amendment signed by the owner)
Native GL/period close (journal export only) · driver pay v1 · report builder (12 views + copilot) · a fourth surface · a fifth primitive · seat-based pricing · gray text, blue anything, shadows, spring animations · SMC3/class as engine foundation (adapter only) · **any code merge from prior codebases (2023 apps or any pre-genesis TMS build) — organ banks only, reference never merge (REQ-163, doc 13 §01)** · any tenant/person/customer/incumbent-vendor name in any repo artifact (REQ-167) · anything whose REQ row says CONFIRM-GATED while the CONFIRM is open (Direct merchant, voice recording, escrow settle).

## Working agreement
Work WP by WP (doc 08 §03). Start of session: read the WP row + its REQ rows + DoD; end of session: update the WP checklist, note any new REQ rows proposed, leave the build green. Ambiguity = state your assumption in the PR description and proceed (do not stall); wrong assumptions are cheap, silent ones aren't. The five acceptance demos that define "done enough to show": (1) signature at a door → invoice + photos in the client's inbox <5s; (2) a stranger signs up and quotes in <10 min; (3) a real driver completes a gated stop with zero instruction; (4) a booking placed from Claude via MCP; (5) the exception pulse dimming the map while everything else stays quiet.
