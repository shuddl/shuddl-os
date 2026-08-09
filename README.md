# SHUDDL OS
**The operating system for all freight parties.** An append-only, co-signed event ledger of physical freight reality; 13 agents that run the protocol; 3 surfaces (Command, Driver PWA, Client Portal) on a live greige/coral map; money as a projection of physics — POD signed at the door → invoice + signature/pallet photos in the client's inbox, same second.

## Repository layout
| Path | What it is |
|---|---|
| `CLAUDE.md` | **The governing file.** Budgets, laws, fixture gates, do-nots, the five acceptance demos. Every build session reads it first. |
| `genesis/` | The founding spec set (docs 00–15 + README index): manifesto & Ten Laws · product spec · ledger architecture · Claude-native booking · business model · v1 build & zero-cutover · 2023-codebase verdict · design system ("Terminal Gallery") · gap audit + roadmap (WP-01…16 with DoD) · **09-REQUIREMENTS-REGISTER.csv (the scope authority, append-only — `pnpm check:coverage` prints the live row count; a number written here would rot, and did: it read 167 from F0.2 until audit §831)** · event taxonomy & data model (35 kinds, 21 tables) · repo-governance source · GTM rollout (12) · tenant onboarding/Overlay contract (13) · build execution spec (14, milestones M-H first) · second-pass audit & readiness verdict (15) |
| `fixtures/` | Golden fixtures that gate merges — manifest inside; vendored at WP-01 |

## Status
**WP-01 → WP-16 built and merged** — all sixteen work packages are closed (corrected 2026-08-04, audit §172: this line read "WP-01 → WP-06 … Next: WP-07 Concierge" and had been stale by ten work packages). The signature-at-the-door heartbeat runs end-to-end: POD → penny-exact invoice + evidence email, proven in-repo; live email send is CONFIRM-gated (inert until secrets are set). Full picture, and how to resume any parked (CONFIRM-gated) work: **`docs/ops/PROJECT-STATE.md`**.

Production is **provisioned but dark** — nothing is armed or sending (corrected 2026-08-04, audit §172: this line read "Nothing is deployed", which stopped being true on 2026-07-30 when prod was provisioned; preflight recorded PASS on 2026-07-31, see `docs/ops/PROJECT-STATE.md`). Every external capability remains unbound: `PROVISIONING_ENABLED` off, no Resend/Anthropic/Stripe secrets, so no signup, no live send, no LLM, no billing. The product is a green, fully-tested codebase (`pnpm verify`). External launch, tenant-0 phases, and live sending gate on F1-B/C + the M-H milestone (doc 14/15) — never on the build.

### Runtime contract (required before anything)
The suite is verified under **Node 22.15.0 + pnpm 11.10.0 only** (pinned in `.node-version`, `engines`, and `packageManager`). Node 20 mis-resolves the `vitest-pool-workers`/chai chain and changes D1 append-only trigger behaviour, so a green run under Node 20 proves nothing. Activate the pinned runtime before running any gate:

```
nvm install 22.15.0 && nvm use 22.15.0    # or: fnm use (reads .node-version)
corepack use pnpm@11.10.0
pnpm check:runtime                          # fails closed on any mismatch, printing installed vs required
```

`pnpm check:runtime` is the first step of every verification script; it exits non-zero and prints the installed vs required versions if you are on the wrong Node/pnpm.

_History: F0.2 complete + third-party audited 2026-07-09 (register 167 rows; identity-leak law REQ-167 enforced repo-wide)._

## The five demos that define "working"
(1) signature at a door → invoice + photos in the client's inbox <5s · (2) a stranger signs up and quotes in <10 min · (3) a real driver completes a gated stop with zero instruction · (4) a booking placed from Claude via MCP · (5) an exception pulsing while the rest of the map dims.

MIT — see LICENSE.
