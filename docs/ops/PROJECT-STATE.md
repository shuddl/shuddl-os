# Project state & resume guide

**As of 2026-07-14.** This is the "where are we / how do I pick back up" note. It is a pointer, not a spec — the authorities are `CLAUDE.md`, `genesis/`, `docs/wp/*`, and `genesis/09-REQUIREMENTS-REGISTER.csv`.

## Safety posture (read first)

There is no live production and no outbound email/SMS/money flow is enabled. A **staging** environment is now deployed to Cloudflare (`shuddl-{api,agents}-staging`) — but it carries **synthetic data only** and has **no `RESEND_API_KEY`**, so the Biller uses `NotConfiguredSender` and **zero emails leave staging** (proven: the deploy smoke ran the full POD→invoice chain and Resend shows no send). No committed API key, no real customer/tenant data in the repo. Every feature that *could* touch the outside world (email send, billing) ships **CONFIRM-gated** — inert by default, activated only by an operator setting secrets. `prod` is not stood up (gates on F1-B/C + M-H). The whole product is a rigorously-tested codebase (`pnpm verify` = 1,131 tests, all the invariant/design/traceability gates), advanced one work-package at a time on branches that merge only when green. **Staging runbook + teardown: `docs/ops/DEPLOYMENT.md`.**

## Done (merged to `main`)

| WP | What it delivered | Close-out |
|---|---|---|
| WP-01 | Repo/CI scaffold, the CI gates + hard budgets | `docs/wp/WP-01.md` |
| WP-02 | Ledger core — 21 tables, hash chain, DO sequencer, lenses, money projections, Merkle/TSA anchoring | `docs/wp/WP-02.md` |
| WP-03 | Design system package + the live map shell (greige/coral; opt-in Mapbox tiles) | `docs/wp/WP-03.md` |
| WP-04 | Rater — config-driven integer-cents pricing engine + `/v1/rate` gate (no price on air; the $222K floor law) | `docs/wp/WP-04.md` |
| WP-05 | Driver PWA + Gatekeeper — server-side transition gates, offline signed capture, the POD heartbeat | `docs/wp/WP-05.md` |
| WP-06 | Biller — POD → penny-exact `invoice.issued` + the evidence email; live send CONFIRM-gated | `docs/wp/WP-06.md` |

Confirm the build is green anytime: `pnpm verify` (from the repo root).

## Next on the roadmap

**WP-07 Concierge** (email-in quoting): inbound email → parse → Rater → auto-reply drafts. Its core can be built provider-agnostic (behind an inbound port) with the live Resend webhook deferred — the same pattern WP-06 used for outbound. Roadmap order + DoD: `genesis/08-GAP-AUDIT-ROADMAP-ASSURANCE.md`.

## Parked — resume when convenient (zero risk while parked)

### Evidence-email live send (the CONFIRM-gated tail of WP-06)

The Biller composes and would send the delivery evidence email, but **live sending is off**: with no `RESEND_API_KEY` the Biller uses `NotConfiguredSender`, which never touches the network. Nothing to turn off — it's already dormant.

Two ways to pick it back up (details in `docs/ops/secrets.md` and `docs/wp/WP-06.md`):

- **See the email render in your own inbox (zero DNS setup):** create `workers/agents/.dev.vars` (git-ignored) with `ALLOW_TEST_SEND=1`, a `TEST_SEND_TOKEN`, your `RESEND_API_KEY`, `EVIDENCE_FROM=SHUDDL <onboarding@resend.dev>` (Resend's sandbox sender delivers only to your own account email), and `TEST_SEND_TO=<your Resend account email>`. Then `cd workers/agents && npx wrangler dev` and `curl -X POST localhost:8787/_dev/evidence-test-send -H "Authorization: Bearer <token>"`. The guarded probe route (sink-only, flag+token gated) is in `workers/agents/src/index.ts`.
- **Go live to real consignees (deferred, milestone-gated):** verify `shuddl.tech` in Resend + add DKIM/SPF/DMARC DNS (REQ-092); set `RESEND_API_KEY` + `EVIDENCE_FROM=SHUDDL <pod@shuddl.tech>` as deployed Worker secrets — the Biller's `ResendSender` then activates with no code change. Warm the domain first (REQ-157); real consignee volume waits for heartbeat-on-real-freight / the M-H milestone (REQ-159).

### Other CONFIRM-gated / deferred items (tracked in the register)

- Live SMS fallback — port exists, Twilio wiring deferred (REQ-097).
- Photo/PII retention policy publish — counsel deliverable (REQ-140, CONFIRM-2).
- The evidence photo-URL resolver + the "missing-evidence" send-gate (REQ-170) — lands with the resolver.
- Biller trigger-loss reconciliation sweep (REQ-169) — WP-11 (the agents cron).
- QuickBooks / statement export (WP-11); inbound email parsing (WP-07).
- Engagement-workspace fixtures not yet vendored → the Rater parity + the invoice-500-replay DoD run as **PENDING-advisory** until vendored (never false-green). See `tools/rater/README.md`.

## Environment gotcha

The repo sits on an iCloud-synced Desktop, which periodically spawns `name 2.ext` duplicate files that can corrupt file-count gates (a duplicate migration breaks the invariant check). Before `pnpm verify`, if `find . -name "* 2.*" -not -path "./.git/*"` finds any, verify each is a byte-copy of its original and delete it (`.gitignore` blocks committing them). The durable fix is moving the repo off `~/Desktop` or excluding it from iCloud sync.
