# SHUDDL OS — Genesis Document Set
**2026-07-09 · the founding spec for the freight operating system** (working brand: SHUDDL — see doc 06; no legacy-platform names appear anywhere in this set by design)

## Read in order
| Doc | What it settles |
|---|---|
| **00-MANIFESTO-FIRST-PRINCIPLES** | The physics diagnosis, the Ten Laws (L1–L10), what gets deleted from the industry |
| **01-PRODUCT-SPEC** | Primitives, 13 agents, 3 surfaces, the gates catalog (incl. POD→instant-invoice→evidence-email), brokerage + cartage mesh, comms unification, superiority table |
| **02-LEDGER-ARCHITECTURE** | The append-only co-signed event ledger ("consensus without blockchain theater"), lenses, offline capture, money-as-projection, legacy sync/Overlay machinery |
| **03-CLAUDE-NATIVE-BOOKING** | The MCP surface, three identity postures (paired / credit-line / SHUDDL Direct default), agent-to-agent commerce, safety rails |
| **04-BUSINESS-MODEL-PLG** | $5 Spark tier + credits + network take rates (settle ~1%, Direct spread, cartage mesh), 60-second signup, moat sequence |
| **05-V1-BUILD-ZERO-CUTOVER** | v1 spine (~12 weeks build; verification per Overlay gates), the zero-cutover authority map, tenant #0 posture, anti-regression rules |
| **06-SHUDDL-2023-VERDICT** | The old codebase: retire code, harvest brand + lessons — with evidence |
| **07-DESIGN-SYSTEM** | "Terminal Gallery": the greige/coral directive adopted as law + THE MAP backdrop (party-scoped live shipments/trucks) + six operational amendments (contrast, driver dark ground, print, status grammar, a11y, photography) + CI squint test |
| **08-GAP-AUDIT-ROADMAP-ASSURANCE** | 20-gap audit (all dispositioned), the five-mechanism assurance system (honest version of "nothing missed"), WP-01…16 with DoD |
| **09-REQUIREMENTS-REGISTER.csv** | 149 requirements, machine-readable: id · domain · requirement · source · spec · WP · DoD test · status. THE scope authority — append-only |
| **10-EVENT-TAXONOMY-DATA-MODEL** | 35 event kinds, 21 tables (≤22 budget), 12 views, invariants I1–I8 — the unambiguous schema foundation |
| **11-REPO-CLAUDE-MD** | Drop-in governing file for the build repo: budgets, rules, fixtures, do-nots, the five acceptance demos |
| **12-GTM-ROLLOUT** | The market chapter: rollout phases R0–R4 gated by build milestones, ICP v1, first-25 list criteria, positioning per competitor class, pricing hypotheses, tripwires |
| **13-TENANT-ONBOARDING-OVERLAY** | Tenant onboarding interface: the config-pack contract (all tenant specifics live client-side, never in this repo), seats-not-names org discipline, the generic phase pattern (mirror · shadow · pilot · money · flips), identity-leak lint (REQ-167) |
| **14-BUILD-EXECUTION-SPEC** | The operational substrate: monorepo layout, environments/secrets, domains/email warmup, API conventions, auth implementation, event-pipeline mechanics, testing/CI/CD, milestones M-H…M-AUTHORITY, session protocol, F1 procurement |
| **15-SECOND-PASS-AUDIT** | Gap audit v2 (SP-1…SP-19, all dispositioned incl. the tenant-identity contamination found and scrubbed), register delta REQ-150–167 with amendment log, consolidated F1 gate, build-readiness verdict |

## Decisions embedded in this set
- **This is a product, not a client build**: tenant #0 (a working regional carrier + brokerage) proves it via the Overlay; nothing tenant-specific is hardcoded. Its separate replacement brief (same folder tree, 2026-07-09) plugs into doc 05 §4 unchanged.
- **Fresh spine, harvested organs** — consistent with the fresh-vs-reuse recommendation already made: the audited pricing engine, import machinery, re-rate harness, and evidence patterns port in; no legacy codebase (2023 or otherwise) becomes the spine.
- **GL is never rebuilt** (journal export only). **Driver pay deferred.** **EDI is a lens**, certified per partner by replay harness.
- **The heartbeat demo** (build first, sell with it): driver signs at a door → invoice + signature/pallet photos hit the client's inbox in the same second.

## Open [CONFIRM]s before public anything
1. Final name + trademark/app-store availability pass (set currently writes as SHUDDL).
2. Pricing numbers in doc 04 are launch hypotheses — re-base on tenant #0 telemetry.
3. Call-recording consent policy per operating state (doc 02 §6).
4. SHUDDL Direct merchant/credit posture needs banking + insurance counsel before v1.5.

## Build readiness (2026-07-09, third pass — F0.2)
**F0 COMPLETE** (docs 00–11) · **F0.2 COMPLETE** (docs 12–15 + REQ-150–167): GTM chapter, tenant onboarding interface (config packs live client-side — separation law, REQ-167), build execution substrate, second-pass audit. **The consolidated F1 gate now lives in doc 15 §03** — F1-A (blocks first commit: repo/Cloudflare/DNS/keys — one admin day), F1-B (blocks tenant-0 phases: legacy data feed, finance-owner session, pilot facility, org-facts verify), F1-C (blocks external launch only: name/trademark, counsel list, tenant-0 publishing consent). Claude Code starts at WP-01 on F1-A alone, per `14-BUILD-EXECUTION-SPEC.md` §09.

## Next five actions
1. Build the heartbeat demo on the new spine (weeks 1–5 of doc 05 §5) — it is the pitch, the QA target, and the referral engine in one.
2. Stand up the MCP v1 (quote/track/book, paired posture) — the "book freight from Claude" demo.
3. Register the PLG shell: signup → workspace → Migrator drag-drop → first Concierge quote.
4. Run tenant #0's Overlay Phase 0 (its data-access request is the same critical path already briefed).
5. Naming/trademark pass → lock brand → then this folder gets renamed once, everywhere.
