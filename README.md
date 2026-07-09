# shuddl-os
Operating system for all freight parties
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
| **10-EVENT-TAXONOMY-DATA-MODEL** | 34 event kinds, 21 tables (≤22 budget), 12 views, invariants I1–I8 — the unambiguous schema foundation |
| **11-REPO-CLAUDE-MD** | Drop-in governing file for the build repo: budgets, rules, fixtures, do-nots, the five acceptance demos |

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

## Build readiness (2026-07-09, second pass)
**F0 (foundations Claude can place) is COMPLETE**: vision → spec → ledger → MCP → model → v1 plan → design system → gap audit → requirements register → schema → repo governance. **F1 (Spencer, blocking the first commit):** [CONFIRM-1] name/trademark pass · [CONFIRM-2] counsel list (recording consent, ToS/privacy, Direct authority+insurance, photo retention, e-sign, escrow) · [CONFIRM-3] pilot terminal + create the empty repo/Cloudflare handles. Then Claude Code starts at WP-01 with `11-REPO-CLAUDE-MD.md` at root.

## Next five actions
1. Build the heartbeat demo on the new spine (weeks 1–5 of doc 05 §5) — it is the pitch, the QA target, and the referral engine in one.
2. Stand up the MCP v1 (quote/track/book, paired posture) — the "book freight from Claude" demo.
3. Register the PLG shell: signup → workspace → Migrator drag-drop → first Concierge quote.
4. Run tenant #0's Overlay Phase 0 (its data-access request is the same critical path already briefed).
5. Naming/trademark pass → lock brand → then this folder gets renamed once, everywhere.
