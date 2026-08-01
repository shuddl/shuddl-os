# SHUDDL v2 — Phase-Gated Production Implementation Plan

> **Record note (added 2026-08-01, on commit):** committed as the dated planning record. Its register-row numbering was superseded by later register appends — `genesis/09-REQUIREMENTS-REGISTER.csv` and `docs/ops/V2-EXECUTION-FRAMEWORK.md` are authoritative wherever they disagree with this file. Citations FROZEN as-of writing.

> **For Claude:** REQUIRED SUB-SKILL: when a phase is greenlit, use superpowers:writing-plans to expand that phase into task-by-task TDD steps, then superpowers:executing-plans (or subagent-driven-development) to build it. This document is the **phase spine** — scope, gates, and acceptance per phase — not the task-level decomposition (each phase gets its own on execution).

**Goal:** Take tenant-0 from "a beautiful forms product" to running **all** their freight end-to-end on an AI-native freight OS — quote → confirm → auto-build → schedule → dispatch-propose → driver tracking → POD → invoice + evidence email, with internal optimization and full visibility — at production quality, phase-gated, with prior technical debt paid down.

**Companion docs:** design → `docs/plans/2026-07-23-shuddl-v2-design.md` · debt register → `docs/plans/2026-07-23-v2-technical-debt-register.md` · governing law → `CLAUDE.md`, `genesis/00–15`, `genesis/09-REQUIREMENTS-REGISTER.csv`.

**Tech stack (unchanged):** Cloudflare Workers + D1/KV/R2/DO/Queues · MapLibre GL (self-hosted tiles) · React 19 PWAs · TypeScript strict + Zod · injected-port agent seam in `packages/agents` · Mapbox **data-only** geocode/routing behind a port (never tiles, REQ-075).

---

## The production-quality bar (every phase, non-negotiable)

A phase is **not done** until all of the following are true — this is the exit gate applied uniformly:

1. **All new scope carries appended REQ rows** (append-only) and traceability CI is green both directions (no orphan code, no orphan REQ) — REQ-269.
2. **TDD throughout:** every behavior has a failing test first; the fixture harnesses for that phase are vendored and green (no loud-skip standing in for coverage).
3. **Budgets held:** 0 new event kinds (35-freeze), 0 new tables (spare intact) except the *declared* WP-A additive `shipments` ALTER + `integrations` CHECK-enum; design-CI 5→6 screenshot amendment is the only sanctioned pixel-budget change (REQ-271). The budget gates are only trustworthy after the iCloud `" 2.ext"` dedupe (REQ-273) — **run it first.**
4. **Invariants green:** the relevant `.claude/skills` enforcement passes — server-side gate parity, tenant isolation, no-LLM-in-ledger/rater, canonical-hash byte law, append-only guards, redaction/visibility, snapshot-external-price-inputs.
5. **Adversarial audit at phase exit** (REQ-119 pattern — the 50-agent swarm that found 42 real defects): **zero open Criticals** before the phase closes.
6. **The phase's acceptance test(s)** (AT-1…AT-6 as they land) pass as blessed screenshot + e2e, gating merges.
7. **`no price on air` + `interline floors on executing share` + `model never trusted at a truth boundary`** hold — verified, not assumed.

**Phase gating rule:** no phase's build starts before its predecessor's exit gate is green. WP-A is the tent-pole; **everything blocks on it.**

---

## Phase 0 · Foundation & debt-floor (pre-req for trusting every later gate)

**Scope:** (a) `find . -name "* 2.*"` dedupe (REQ-273) so count/enum budget gates are trustworthy; (b) verify the design-CI strict flip is actually active post-WP-10 (REQ-158/207) — the job is still labeled `design-advisory`; (c) close the one genuine fail-open: make the identity-leak lint fail-closed on all runners, not just canonical CI (REQ-167/211); (d) re-baseline `docs/ops/PROJECT-STATE.md` and advance the lagging register status tags (REQ-120 hygiene); (e) append REQ-214→273 to `genesis/09` and REQ-214 (value-first outreach doctrine — see below).
**Entry gate:** owner approval of this plan + the design.
**Exit gate:** budget gates trustworthy (dedupe done), design-CI blocking confirmed, no fail-open lint on any runner, register current, all v2 REQ rows appended + traceable.
**Debt paid:** E (iCloud dupes), F (fail-open lint, advisory-flip verify), G (stale docs/tags).

> **REQ-214 (value-first outreach) reframe** — appended here, enforced in WP-D/v2.5: *every outbound BD/backhaul/network message must carry a researched, recipient-specific reason; researched relevance is the primary gate, with no volume cap on relevant outreach. The mechanical floor (accurate identity, one-click opt-out, bounce/suppression, healthy reputation) is retained because it protects the product's own deliverability — a blocklisted domain also kills the POD evidence emails. This reframes REQ-157 from a fixed 2-week gate into "ramp as fast as reputation health allows, monitored by Watchtower."* (Owner-directed 2026-07-23. Value-interference flags on REQ-130/159/122/104/103 sent separately for owner decision.)

---

## Phase A · Structured lane + geocoding (THE TENT-POLE — build first)

**REQ:** 214–220 (+273 pre-req). **Design:** §5.1.
**Scope:** additive `origin_facility_id`/`dest_facility_id` FK columns on `shipments` (ALTER, not a table); `GeocoderPort` (Det/NotConfigured/live) on the injected **Mapbox data-only** geocoder, self-hosted Nominatim/Pelias a fast-follow behind the identical interface; `facilities.lat_e6/lon_e6` as the geocode cache (hit never re-hits the port; unresolvable → coarse ZIP centroid, never a guess); replace the 5-box `deriveOperatingState` stub with point-in-polygon reverse-geocode against self-hosted Protomaps admin polygons (keep `XX` fail-closed); **seed + geocode tenant-0's facilities** (part of REQ-165).
**Purity guardrail:** geocoded coords are advisory projection data, never ledger truth; only lon/lat leave the tenant to the port, never a counterparty name (REQ-167/218); the rater stays a pure function of frozen ZIP inputs (REQ-024).
**Entry gate:** Phase 0 green.
**Exit gate:** production bar + a real address resolves to a cached facility coordinate; an unresolvable address fails closed; reverse-geocode covers tenant-0's full operating footprint; the free-string ZIP rater path is byte-identical (regression: 504-sweep + ±2% replay green).
**Debt paid:** B (reverse-geocode stub, facility geocoding); unblocks driver geofences (E) and accessorial detection (WP-B).
**Deploy-gate line items tracked here:** self-hosted Protomaps tiles + glyphs on R2 (REQ-075) begins (fast-follow to the data-only geocoder, does not block the phase).

## Phase B · AI-native quote→book loop

**REQ:** 221–228 (incl. 225a/225b, 272). **Design:** §3.1, §3.2 partial, §5.3.
**Scope:** portal-chat Concierge on the *same* parse/resolve/compose core (auto-tie keyed off authenticated sender-domain match REQ-172, confidence only a secondary withhold-not-authorize filter); structured-lane auto-build via `GeocoderPort` (unresolvable → `unknown_address`, never bare-ZIP); **Auditor** accessorial detection (`AccessorialClassifierPort`) proposing residential/liftgate with the **co-sign-is-the-truth-boundary** invariant; **Scheduler** emitting *both* `pickup.scheduled` and `appointment.set`; seamless amendment (new `quote.priced` via `refs`) with the **accept-ordering gate** (no `quote.accepted` while a proposal is open, REQ-225b) and **terminal-quote billing** (invoice resolves the refs chain to its terminal node, REQ-225a); agent booking path enforces identical credit + evidence-recipient gates (REQ-226); model-distrust hardening (REQ-227); **booking reconciliation sweep** (REQ-228); the `agent.acted.payload.subtype` closed enum + per-subtype redaction tests (REQ-272).
**Entry gate:** Phase A green.
**Exit gate:** production bar + **AT-1** (residential caught before the client asks) + **AT-2** (zero-form book <3 min, only Confirm+Book touched); an amended shipment bills the amended total (fixture); a shipment cannot accept with an open proposal; every `agent.acted` subtype has its own redaction/isolation case.
**Debt paid:** closes the "soft middle" between accept and door (design §6 items 3–6); the `messages.channel='portal'` chat reuse avoids a schema amendment.

## Phase C · Conversational pricing setup

**REQ:** 229–233. **Design:** §3.2.
**Scope:** the **Onboarder** (`PricingInterviewPort`) classifies broker/asset/LTL/shipper and elicits only that archetype's factory params — the LLM interviews, the **pure factory emits every rate** (REQ-024); per-archetype capture templates + new pure `shipperTemplate` (cost-plus reference; LTL class as adapter only); **two-tier validation** — the 3-quote in-conversation replay is a *smoke test* gating only conversational progress, **go-live gated on the Migrator full historical-export ±2% aggregate replay**; `parties.pricing_model` JSON capture (mirrors `credit_status`, no new table); **pricing publication is CONFIRM-GATED and re-based** (REQ-130/233) — no agent self-publishes a live sell tariff.
**Entry gate:** Phase A green (independent of B; can parallelize with B after A).
**Exit gate:** production bar + **AT-5** (onboarding with no settings form → valid config pack, go-live gated on full-export replay); until confirmed, `/v1/rate` returns UNKNOWN `no_tariff`.
**Debt paid:** removes the rate-sheet spreadsheet ritual; makes new-party onboarding self-serve.

## Phase D · Backhaul detection + revenue optimization + dispatch

**REQ:** 234–236, 241–243 (NOT 237–240 — those are v2.5). **Design:** §3.3, §3.6.
**Scope:** `MapboxRoutingPort` (matrix/isochrone/directions, injected trio, deterministic fixture is the CI path); **backhaul-detection sweep** → `agent.acted{backhaul_detected}` + Backhaul Board VIEW; **marginal-cost pricing that HONORS FLOORS** — `computeFloors` fed the marginal basis **snapshotted into the co-signed request** (§5.4), approval matrix + anomaly net + interline executing-share (REQ-040) unchanged; **dispatch-proposal agent** (`agent.acted{dispatch_proposed}` + Command tile; `dispatch.assigned` stays human-gated, auto-commit out of scope); **co-load support**; **delivery-timeline degradation detector** (`anomalies{rule=lane_transit_degraded}`).
**Explicitly NOT in this phase:** no Apollo, no OutreachSender, no suppression, no warmup — detection/pricing/co-load/dispatch have standalone value; outreach ships in v2.5 where its CONFIRM flips anyway.
**Entry gate:** Phase A green (needs geo) + Phase B green (needs the booking loop for co-load/repricing).
**Exit gate:** production bar + **AT-3** (empty backhaul detected + marginal-priced + floor-verdicted, basis snapshotted, empty leg renders hollow) + **AT-6** (dispatch by one tap, human-gated commit); a booked marginal quote re-prices identically from its frozen snapshot with the port stubbed to a different value.
**Debt paid:** REQ-029 dispatcher (as a proposal); the "optimization in between" mandate; ratecon generation (REQ-184) lands here so dispatch stops being fail-closed.

## Phase E · Driver map + POD gate + live tracking

**REQ:** 244–255 (+271 declared screenshot). **Design:** §3.4, §3.5.
**Scope:** driver PWA mounts `MapCanvas` in a **night (A2 ink-ground) variant** (`greigeStyleNight()`, same 5 tokens, declared 6th blessed screenshot REQ-271); service-worker corridor tile prefetch on Start-day (PMTiles range-cache, cache-miss degrades to token-ground never errors); **POD-before-next-address reveal gate** (`GET /v1/manifest` redacts forward-stop precise address/contact until the prior terminal event commits; predicate shared with MCP; new isolation test); **offline lookahead capped at exactly one stop**, released only by a locally-valid capture; **a skip advances the reveal pointer only on server-side dispatcher co-sign** (REQ-249, SoD); stops carry structured centroid + fence_radius so `insideFence()` fires; **`position-loop.ts`** (30s-moving, 5-min stationary suppression, <5%/day, survives airplane mode); **driver-device enrollment** (`POST /v1/devices/enroll`, REQ-252); **route-aware non-blocking consent** (pre-consent routed-corridor states; off-route buffers locally, never a modal blocking a moving driver); honest server-side ETA; **live-board DO fan-out over WebSocket** (replaces the poll).
**Entry gate:** Phase A green (needs facility geocodes for fences).
**Exit gate:** production bar + **AT-4** (address stays locked, and locked against a skip; an API probe pre-POD returns redacted; on POD it resolves zero-tap) + airplane-mode soak green including the consent buffer; <5%/day battery measured on a real device (REQ-070/164 pilot).
**Debt paid:** all of driver-map/GPS-emitter/board-fanout/driver-auth debt (B, parts of G).

## Phase F · UX standard (award-winning = fewer actions)

**REQ:** 256–260. **Design:** §7.
**Scope:** the **zero-form intake** standard (the form is the correction worksheet); the **unified agent-Proposal primitive** across every agent incl. dispatch (a design-CI check asserts no bespoke agent chrome, REQ-257); the **command-bar intent path** (⌘K NL → proposed blessed verb, deterministic filter stays the floor, confidence never auto-executes); **exception resolve-by-proposal** (one-tap fixes, not navigation); the **AT-1…AT-6 acceptance suite** as blessed screenshots + e2e gating merges.
**Entry gate:** the agents whose proposals it renders exist (B, D, E) — this phase can be developed incrementally alongside them and *closes* v2.
**Exit gate:** production bar + all six ATs green as blessed screenshots + e2e; design-CI asserts one Proposal grammar (no per-agent chrome).
**Debt paid:** turns the interface from "software the operator drives" into "a workforce the operator approves."

## Cross-cutting (runs alongside; gates the authority flips, not a phase)

- **REQ-270** — wire a live (even synthetic-but-representative) legacy-mirror feed so `authoritativeSource` gets `legacyValueAvailable=true` and per-module parity converges *before* any authority flip. Lights the DARK WP-15 overlay machinery.
- **REQ-268/269** — `CONFIRM-GATED` as a first-class register status (CI blocks a CONFIRM-gated code path going live while the CONFIRM is open); the v2 milestone map references every REQ-214→273 row.
- **Deploy-gate line items** (from the debt register §D) each surface's exit checks: self-hosted tiles on R2 (REQ-075), sending-domain warmup + prod sender verification (REQ-157), CF edge rate-limit/Turnstile on `/pub/*` + `/pub/signup` (REQ-193/125), pen-test clean (REQ-136), prod secrets/provisioning, real TSA endpoint (REQ-014), CORS allowlist. **None are silently skipped; each is a named gate.**
- **EDI go-live** (debt register §A) — the live transport adapter + inbound HMAC secret store + B2A convergence are a CONFIRM-gated go-live item; not a v2 build blocker (fail-closed today) but tracked so it doesn't silently rot.

---

## What v2 explicitly does NOT build (deferred, documented — do not relitigate)

- **v2.5** (after tenant-0 live + domain warm): the entire cold-outreach engine (`ApolloProspectPort` with jurisdiction-at-collection, `OutreachSender` with domain-scoped suppression + graduated volume governor, synthetic-fixture DoD, REQ-237–240); the **entire public "SHUDDL Rep" solo product** (REQ-261–266 — `MarketRatePort`, per-seat evidence identity, portable SELF passport, free Reputation Scorecard, referral attribution); auto-invite tenant-0's clients onto the shared ledger; Apollo cold-sourcing of missing client emails.
- **v3:** rep team/desk lens + manager rollup (REQ-267); learned accessorial detection; multi-party negotiated pricing; true multi-leg VRP; real-time corridor router; the zero-trust HKDF offline address chain; deeper cross-tenant capacity matching.
- **v4** (each needs an owner-signed register amendment): anything on the permanent "Do not build" list — native GL, driver-pay v1, report builder, a 4th surface, seat pricing, Direct-merchant/escrow-settle, voice recording beyond `call.transcribed`, SMC3/class beyond an adapter.

---

## Open questions carried from the design (owner decisions)

1. Confirm backhaul **outreach** (Apollo + sender + warmup) defers wholesale to v2.5; only **detection/pricing/co-load/dispatch** ship in v2.
2. Confirm the **entire solo-rep product** (incl. `MarketRatePort`) moves to v2.5 with no v2 seed (tenant-0 never exercises it).
3. Counsel sign-off scope for REQ-240 + which positive-US signals suffice to *cache* a prospect at all (REQ-237 ingestion-boundary predicate).
4. The `tenants.policy` marginal-cost inputs (fuel $/mi, handling) that gate backhaul pricing.
5. Confirm the declared design-CI 5→6 blessed-screenshot amendment (REQ-271) vs folding night-mode into an existing shot.
6. Confirm **dispatcher-co-signed skip** (REQ-249) as the reveal-pointer advance authority for AT-4.
7. The value-interference flags (REQ-130 publish pricing / REQ-159 sell pre-M-H / REQ-122 unpark a free tier / REQ-104/103 unlock client self-book) — which to action now vs hold.

---

## Execution handoff

Each phase, when greenlit, is expanded via **superpowers:writing-plans** into task-by-task TDD steps (write failing test → verify red → minimal impl → verify green → commit), built via **superpowers:executing-plans** / **subagent-driven-development**, and closed with the **REQ-119 adversarial audit swarm** (zero open Criticals). Recommended first build: **Phase 0 → Phase A** (the tent-pole), since everything blocks on structured geography.
