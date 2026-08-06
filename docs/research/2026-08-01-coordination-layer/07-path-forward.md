# 07 — The Path Forward: Path A, Phased
**Date:** 2026-08-01 · Part of the [coordination-layer research program](00-goal-and-dods.md) · Selected by the applied framework in [06](06-north-star-and-decision-framework.md) · Prerequisite work enumerated in [01 §6](01-system-readiness.md) · Capability ladder from [04 §5](04-interop-system-design.md)

> **Standing constraint (C1/G4):** this document is a plan, not authorization. No product development occurs until the owner states the pivot to a development plan. Phase 0 is the only active phase.

**The path in one paragraph:** prove the ledger on tenant #0 (the only move that converts the verified-but-unproven build into evidence), while claiming the two empty seats — the published attestation spec and the freight MCP surface — in parallel at near-zero cost. Then repeat the tenant motion, and only then federate. Every phase exit re-runs the [06](06-north-star-and-decision-framework.md) scoring; every kill criterion routes to a pre-named fallback instead of a scramble.

---

## Phase 0 — Decision (ACTIVE NOW)
**Entry:** this research suite complete. **Owner actions (only the owner can do these):**
1. Read the suite ([00](00-goal-and-dods.md) is the index); accept/amend the goal and the Path A recommendation.
2. **State the pivot to development** (or don't) — nothing below starts without it.
3. Begin the external items with long lead times *that require no code*: counsel engagement (REQ-138/140/142/166), tenant-0 data-access grant + config-pack sessions (genesis/13), sender-domain decision (REQ-157's 2-week warmup is calendar), the M-H milestone decision.

**Exit:** an explicit go/no-go from the owner. **Kill:** none — deciding not to proceed is a valid exit.

## Phase 1 — Close the residual (≈ 2–4 weeks once authorized)
The full item list with citations is [01 §6](01-system-readiness.md); the code residual is ~1–2 engineer-weeks, config ~1 week + one 2-week calendar (sender warmup).

**Entry:** owner states the pivot. **Scope:** repo hygiene (push the 30 commits; evidence record at HEAD; record the CI perf failure + backup gap in the ops record) · login path (REQ-069 + human login) · ratecon generation (REQ-184/043) · signup UI · map-perf-on-CI resolution · translator pool port verification · identity denylist · self-hosted tiles (REQ-075) · prod backup schedule + OIDC · edge rate limits · TSA row · sender warmup started.

**Exit criteria (quantified):** evidence record at HEAD with 0 unexplained FAILs (BLOCKED only on the 9 private fixtures) · a driver can authenticate on a real device · a dispatch produces a ratecon document row · prod backup runs green on schedule. **Kill:** none — this phase is all two-way doors.

## Phase 2 — Tenant #0 to verified revenue (14–20 weeks, calendar-locked; overlaps Phase 1)
**Entry:** data-access grant signed; config-pack authoring begun. **Scope:** the genesis/13 five-phase onboarding exactly as written — mirror feed live + 3-day unattended (REQ-152) → fixtures vendored (flips `fixtures`/`rater-parity`/`invoice-parity`/`concierge-parse` green; `zone-tariff-v1` first — it unblocks three WPs) → 30-day revenue shadow ±2% → two consecutive clean closes (REQ-153, absolute) → terminal pilot week → money-authority flip.

**Exit = H1 (from [06 §1](06-north-star-and-decision-framework.md)):** **VSD ≥ $400K/mo · projected-invoice dispute rate ≤ 2% · measured tenant savings vs the [02 §4](02-coordination-layer-value.md) model** (instrument detention recovery, factoring delta, admin hours, dispute outcomes from week 1 — this replaces the estimate table with actuals).

**Kill criteria:**
- **K1:** measured value < $2,500/truck/yr after 6 months live → the value thesis is wrong by >2x; re-run [06](06-north-star-and-decision-framework.md) with Path D (license/partner) live on the table.
- **K2:** co-signature acquisition < 50% of delivery stops during pilot → downgrade the claim: single-party system of record with evidence (still sellable), federation ladder paused; re-score.
- **K4:** onboarding exceeds 2× the calendar floor (> 40 weeks) for *product-intrinsic* reasons → framework re-run.

## Phase 3 — Claim the empty seats (parallel from Phase 1; cheap, high option value)
**Entry:** Phase 1 hygiene done (spec publication needs a clean tree, not a live tenant). **Scope:**
1. **Publish the attestation spec** — event envelope, canonical-hash proof, signature semantics — open license, versioned, with conformance vectors (the ISO-container move; [04 §2 L4](04-interop-system-design.md) design constraint: tiny and narrow).
2. **MCP GA:** bind pairing secrets, provision caps, wire the webhook event source, run the full DO-backed booking smoke on staging; film acceptance demo #4.
3. **Embrace outreach** per the [03 §4](03-competitor-landscape.md) posture matrix: offer 2–3 voice/email-agent vendors (HappyRobot/Vooma/FleetWorks-class) a <1-day integration against tenant-0 (with tenant consent), positioning SHUDDL as their verified freight backend.

**Exit criteria:** spec public + ≥1 external implementation conversation · MCP GA with ≥1 external tool reading production state · demo #4 filmed. **Kill:**
- **K3:** zero external integrations 12 months after MCP GA → the platform posture is wrong; continue as pure vertical SaaS (VSD still carries the business); stop investing in L4.
- **K5:** a competitor ships a co-signed ledger + open agent surface at scale before this phase completes → accelerate spec publication or open the Triumph-class partnership conversation early ([03 §5](03-competitor-landscape.md) threat #3 is also the natural ally).

## Phase 4 — Repeatability (H2 horizon, +18 months)
**Entry:** Phase 2 exit (H1 hit). **Scope:** counsel-gated PLG activation (signup UI live, REQ-138 closed, Stripe on) · productized onboarding (the Phase-2 playbook as software: adapters fleet, mirror tooling — R4) · identity anchoring (FMCSA/Motus + Highway/SCAC-Verified wired into party records — R5) · tenants 2→10 (regional carriers/hybrids in the ~50–60K-target band from [02 §5](02-coordination-layer-value.md)).

**Exit = H2:** **VSD ≥ $5M/mo · ≥10 tenants · co-signature on ≥50% of stops · ≥3 external AI tools in production via MCP.** **Kill:** tenant-2..N acquisition cost or onboarding time not falling vs tenant #0 → the wedge doesn't repeat; re-score with the honest number.

## Phase 5 — Federation (H3 horizon, +36 months)
**Entry:** ≥2 live tenants with overlapping counterparties. **Scope:** federation v1 — two sovereign ledgers exchanging attested events (R6) · "claim your signatures" counterparty free-join at scale (R3 grown into network entry) · first non-SHUDDL spec implementation (R7) · mode expansion **by federation only** (DCSA eBL / ONE Record mapped as adapters — R8; never rebuilt).

**Exit = H3:** **VSD ≥ $50M/mo trajectory · ≥100 tenants · ≥1 cross-ledger attestation exchange live in production.** At this point — and not before — the system is what the research program set out to define: **the coordination layer, arrived at as an emergent property of sovereign ledgers that were each worth running alone.**

---

## The five headline answers (program summary)

1. **How far from running?** Infrastructure live and verified; product at zero users/tenants/freight. Code residual ≈ 1–2 weeks; the real distance is tenant #0's data, counsel, and a 14–20-week calendar ([01](01-system-readiness.md)).
2. **What can it perform, for whom?** Today: nothing, for anyone but engineers — by design (fail-closed). After Phase 2: the [02 §3](02-coordination-layer-value.md) value table, measured: ~$200–620K/yr per 25-truck hybrid, in a sector with negative median margins.
3. **What would make it the ultimate coordination layer?** Not universality — federation. The eight-rung ladder in [04 §5](04-interop-system-design.md), climbed inside-out, after tenant-0 proof.
4. **Impossible tasks?** Two impossible-as-stated (universal layer; voluntary incumbent openness) — both have value-preserving reformulations; two contain-don't-solve (liability statute, universal identity); the rest are hard with named playbooks ([05](05-impossible-tasks-and-pivots.md)).
5. **North star & framework?** VSD — Verified Settlement Dollars — with three-horizon targets and guardrails; Gates-then-Weights framework, applied: **Path A, 8.25/10, decisively** ([06](06-north-star-and-decision-framework.md)).
