# SHUDDL OS
**The operating system for all freight parties.** An append-only, co-signed event ledger of physical freight reality; 13 agents that run the protocol; 3 surfaces (Command, Driver PWA, Client Portal) on a live greige/coral map; money as a projection of physics — POD signed at the door → invoice + signature/pallet photos in the client's inbox, same second.

## Repository layout
| Path | What it is |
|---|---|
| `CLAUDE.md` | **The governing file.** Budgets, laws, fixture gates, do-nots, the five acceptance demos. Every build session reads it first. |
| `genesis/` | The founding spec set (docs 00–15 + README index): manifesto & Ten Laws · product spec · ledger architecture · Claude-native booking · business model · v1 build & zero-cutover · 2023-codebase verdict · design system ("Terminal Gallery") · gap audit + roadmap (WP-01…16 with DoD) · **09-REQUIREMENTS-REGISTER.csv (167 rows — the scope authority, append-only)** · event taxonomy & data model (35 kinds, 21 tables) · repo-governance source · GTM rollout (12) · tenant onboarding/Overlay contract (13) · build execution spec (14, milestones M-H first) · second-pass audit & readiness verdict (15) |
| `fixtures/` | Golden fixtures that gate merges — manifest inside; vendored at WP-01 |

## Status
F0.2 complete + third-party audited 2026-07-09 (register: 167 rows, cross-refs resolve; identity-leak law REQ-167 enforced repo-wide). Build starts at **WP-01** — plan already staged in `docs/plans/` — the day **F1-A** (doc 15 §03) completes: repo ✓ · Cloudflare ✓ · DNS · LLM keys · Stripe test · TSA pick · QuickBooks sandbox. F1-B/C gate tenant-0 phases and external launch only, never the build.

## The five demos that define "working"
(1) signature at a door → invoice + photos in the client's inbox <5s · (2) a stranger signs up and quotes in <10 min · (3) a real driver completes a gated stop with zero instruction · (4) a booking placed from Claude via MCP · (5) an exception pulsing while the rest of the map dims.

MIT — see LICENSE.
