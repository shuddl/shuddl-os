# CLAUDE.md — SHUDDL OS (drop this file at repo root, verbatim, when the repo is created)
### The governing file for every build session. Read completely before writing code.

## What you are building
SHUDDL: the freight operating system. An append-only, co-signed **event ledger** of physical freight reality; **13 agents** that run the protocol; **3 surfaces** (Command, Driver PWA, Portal) on a live greige/coral map; money as a projection of physics (POD → invoice + evidence email, same second). Full spec: `Shuddl-OS-Genesis/` docs 00–10. The Ten Laws in doc 00 override any instinct you have.

## Source-of-truth order (conflicts resolve upward)
1. `09-REQUIREMENTS-REGISTER.csv` — scope. If it isn't a REQ row, it doesn't get built; if you discover scope, ADD A ROW first (append-only).
2. `10-EVENT-TAXONOMY-DATA-MODEL.md` — schema + invariants I1–I8.
3. `07-DESIGN-SYSTEM.md` — every pixel. The squint-test CI is law.
4. `08-…ROADMAP…` — WP order + DoD. `00/01/02/03` — intent.

## Hard budgets (CI-enforced; exceeding = the PR is wrong)
≤22 tables (21 used; the spare requires a written deletion) · 3 surfaces + command bar + queues · 12 canonical views · 35 event kinds (additions = register amendment) · 5 color tokens · 2 font families · 0 shadows/gradients/radius>4px.

## Stack (decided — do not relitigate)
Cloudflare Workers + Hono · D1 per-tenant (control plane separate) · R2 evidence + tiles · Durable Objects (ledger sequencing, live boards) · Queues (agent triggers) · MapLibre GL + self-hosted Protomaps vectors · React 19 + Vite PWAs · TypeScript strict, no `any` · Zod at every boundary · Stripe (billing) · LLM calls only inside `packages/agents/*` — **never** in `packages/ledger` (REQ-024, statically linted).

## Non-negotiable engineering rules
1. **Every PR references REQ-IDs**; traceability CI blocks orphans (both directions).
2. **Events are append-only**: no UPDATE/DELETE paths on `events`, ever, including migrations. Corrections are new events (I3, I7).
3. **Gates are server-side** (Gatekeeper); UIs merely reflect them. Any flow reachable by API must enforce the same gate (REQ-030).
4. **No price on air**: missing weight/dims → UNKNOWN, no sell. (The 504-quote monotonic sweep and 48 engine tests ship in `fixtures/` and must stay green.)
5. **Interline floors compare TP-share, never gross.** The $222,084/35-lb anomaly regression is permanent (REQ-040).
6. **Fixtures gate merges**: 062226 export replay ±2% aggregate · routes ±10% · QB export reconciles to the penny · airplane-mode soak for driver flows.
7. **Design CI**: color/contrast/font/case/radius/shadow/motion audits + 5 blessed screenshots. `--signal-deep` is tuned by the contrast test, not by eye.
8. **Tenant isolation suite** runs on every merge; a cross-tenant read anywhere is a build failure (REQ-025).
9. **Adversarial audit swarm at every WP exit** (50-agent pattern; it found 42 real defects in a "finished" module). No open Criticals at close (REQ-119).
10. **No silent drops in migration**: any legacy column (171-col export) that doesn't map raises a gap row — never disappears (Migrator rule).

## Do not build (ever, without a register amendment signed by the owner)
Native GL/period close (journal export only) · driver pay v1 · report builder (12 views + copilot) · a fourth surface · a fifth primitive · seat-based pricing · gray text, blue anything, shadows, spring animations · SMC3/class as engine foundation (adapter only) · anything whose REQ row says CONFIRM-GATED while the CONFIRM is open (Direct merchant, voice recording, escrow settle).

## Working agreement
Work WP by WP (doc 08 §03). Start of session: read the WP row + its REQ rows + DoD; end of session: update the WP checklist, note any new REQ rows proposed, leave the build green. Ambiguity = state your assumption in the PR description and proceed (do not stall); wrong assumptions are cheap, silent ones aren't. The five acceptance demos that define "done enough to show": (1) signature at a door → invoice + photos in the client's inbox <5s; (2) a stranger signs up and quotes in <10 min; (3) a real driver completes a gated stop with zero instruction; (4) a booking placed from Claude via MCP; (5) the exception pulse dimming the map while everything else stays quiet.
