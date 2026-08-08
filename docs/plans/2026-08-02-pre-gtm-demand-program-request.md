# The SHUDDL Pre-GTM Demand Program — the request in its ideal form
**Date:** 2026-08-02 · Companion to [docs/research/2026-08-01-coordination-layer/](../research/2026-08-01-coordination-layer/00-goal-and-dods.md) · Status: awaiting owner fire

*(This file mirrors the rewritten request returned in chat, verbatim, so it can be fired as-is.)*

---

## Premises — stated as verified fact so the request stands on them

- **P1 (provenance):** The 2026-08-01 research program ran against the current in-progress build — local HEAD `d6eec18`, 30 commits ahead of `origin/main`, the same working tree the concurrent Claude Code coding session is advancing — plus live wire probes of all nine production hostnames. Every conclusion binds to that tree.
- **P2 (division of labor):** The coding session owns the product repo (`packages/`, `workers/`, `apps/`, `db/`, `tools/`, `fixtures/`, CI). This program NEVER touches those paths, never runs the test suites, never commits to product code. Its territory: `docs/`, the separate `marketing-site/`/`shuddl-site/` repos, the `.claude/` plugin space, and external systems (Apollo, Resend, Notion/Linear, Stripe, Vibe Prospecting) via connected MCP.
- **P3 (the law conflict, solved up front):** CLAUDE.md locks GTM behind milestone M-H (genesis/12). Therefore workstream F ships a register amendment defining a **pre-GTM Demand Lane** (audience-building, ICP research, waitlist, deposit-backed reservations — explicitly NOT go-live selling) that the owner signs before any outbound. No amendment, no outreach.
- **P4 (pre-product honesty):** No funding round is pursued — pre-product fundraising is dismissed per the Convoy postmortem and the evidence-first law; a data room accrues only as a byproduct. No public "coordination layer" announcements (a one-way door the framework already disqualified). Every demo asset is labeled staging. No tenant, person, or customer name in any artifact (REQ-167 applies to marketing too).

## Goal

> **G: Within 90 days, and without interfering with the product build, stand up a compounding demand system that converts SHUDDL's verified research into deposit-backed launch commitments — first deposit dollar within 30 days, ≥ $100K CARR within 90 — run day-to-day by autonomous loops with the owner doing only the ~5 tasks/week that require a human founder.**

## The single north-star metric

> **CARR — Committed Annual Recurring Revenue: dollars of signed, deposit-backed Founding Carrier commitments (refundable deposit + LOI at the $40–125K/yr willingness-to-pay band established in research doc 02).**
> Ladder: first deposit dollar ≤ day 30 · ≥ $100K CARR ≤ day 90 · ≥ 5 Founding Carriers ≤ day 120. Conversion contract: CARR exists only to convert into **VSD** (the company north star) at go-live; any CARR that cannot convert (wrong ICP, unservable lane) is counted at zero. Guardrails: deposit refund rate < 20%; zero outbound sent without a standing owner approval; zero product-repo commits from this program.

## The sentence (deliverable A-1's seed — sharpen it, test it, but start from this)

> **"SHUDDL gets carriers paid the second the freight is signed for — every delivery becomes tamper-proof evidence and an instant invoice, so a 20-truck fleet runs like it has a Fortune-500 back office, without one."**

## Workstreams, each with DoD, audience, and hard prerequisites

**F — Foundations (precede everything; nothing downstream starts until its F-dependencies close).**
- **F-1 ICP definition** *(precedes ALL marketing/sales items)* — primary: US regional carriers 10–100 trucks with brokerage arms; secondary: small brokerages ≤ $30M gross. DoD: a one-pager with firmographics, JTBD, disqualifiers, and the 3 pains priced in doc 02 (detention recovery, cash cycle, back office) — owner-approved in writing.
- **F-2 Demand-Lane register amendment** (P3). DoD: REQ row appended, owner-signed.
- **F-3 Counsel-reviewed deposit terms** — refundable Founding Carrier deposit via Stripe with plain refund language. DoD: counsel sign-off; no charge before it.
- **F-4 Sender + domain infrastructure** — resolve the shuddl.tech zone/account split, verify the Resend/outbound domain, START THE 2-WEEK WARMUP NOW (it is calendar, not effort). DoD: warmup running, SPF/DKIM/DMARC green.
- **F-5 Pipeline substrate** — CRM stages defined in Notion or Linear (already connected), waitlist→CRM sync, UTM attribution on the marketing site. DoD: a lead flows end-to-end in a test.

**A — Assets (require F-1).** A-1 the sentence + 100-word pitch + messaging hierarchy · A-2 staging-labeled demo films of acceptance demos #1 and #5 (POD→invoice<5s; exception pulse) · A-3 public ROI calculator built from doc 02's value model (lead magnet) · A-4 landing page v2 with the Founding Carrier offer + deposit CTA · A-5 pricing hypothesis one-pager ($3.3–10K/mo band). DoD each: published or owner-approved; zero identity leaks; zero over-claims.

**D — Demand engine (requires F-1..F-5; the autonomous core).** Apollo + Vibe Prospecting build and enrich a ≥5,000-account ICP list, scored; owner approves each sequence ONCE, then it runs standing; Resend/Apollo sequences with CAN-SPAM compliance and opt-out hygiene; waitlist nurture; weekly data-journalism content from the research corpus (the $15.1B detention number, the fraud epidemic, the co-signed-proof answer). DoD: pipeline dashboard live; ≥ 3 qualified founder-calls booked/week on the owner's calendar by day 30.

**P — Press & excitement (requires A-1/A-2; funding excluded per P4).** The story is not "platform launches" — it is (a) the data POV pieces above and (b) the build itself: *a solo founder and AI agents built a gate-enforced freight OS with a co-signed ledger* — pitched to FreightWaves, FreightCaviar, Overdrive/Land Line (driver-pay angle), with the staging films as the hook. DoD: press kit + 3 tailored pitches sent by day 21; any coverage links to the waitlist. Non-dilutive perks (cloud credits) allowed; investor conversations only AFTER first deposits exist, and only owner-led.

**C — Concurrent builds for fastest first dollar (all outside the product repo).** C-1 Stripe deposit flow + Founding Carrier terms page (marketing-site repo) · C-2 the ROI calculator (A-3) · C-3 the Founding Carrier Program itself: 5–10 slots, refundable deposit, pricing lock, onboarding priority — **this is the first-dollar instrument** · C-4 the data room folder that accrues as a byproduct.

**M — Mission Control (the plugin ask, made concrete).** Invoke `/superpowers-developing-for-claude-code:developing-claude-code-plugins` and build a **`shuddl-mission-control`** plugin for all non-coding operations. DoD for the plugin itself: (1) file-backed task registry under `docs/gtm/` where every deliverable carries {DoD, audience, prerequisites} and marketing tasks are mechanically blocked until F-1 is marked done; (2) `/mc:status` renders a shared visual board — published as a private Artifact and mirrored to Notion/Linear — showing what Claude/agents are doing, what the owner's open tasks are, and the CARR tracker; (3) `/mc:next` returns the owner's highest-leverage tasks; (4) owner task completions are detected (checkbox or reply) and unblock dependents; (5) a loop-heartbeat log so both Claude sessions can see each other's lane and never collide; (6) a weekly kaizen entry — every loop cycle ends by recording one improvement to its own process, so the system is constitutionally self-improving.

**L — The autonomous loop (start immediately after this request is accepted).** Run `/swarm-goal-relay` on goal G measured by CARR, self-paced for the next six hours and renewing daily thereafter, with this standing mandate per tick: advance the highest-leverage unblocked task from M's registry (F first, then A/C, then D/P) → update the board and CARR → surface new owner tasks → log the kaizen note → schedule the next tick. Hard rails: never touch product-repo code paths, tests, CI, or DBs; never send outbound without its standing approval; never publish anything the identity-leak or over-claim rules forbid; pause any item that collides with the coding session's active lane and flag it on the board instead.

## Owner lane (the only human-required tasks; everything else is Claude's)
1. Sign F-2 (Demand-Lane amendment) and approve F-1 (ICP). 2. Engage counsel (F-3 + the REQ-138 set already in Phase 0). 3. Fix the shuddl.tech zone/account split (F-4 requires account access only you have). 4. Approve the first outbound sequence and the Founding Carrier terms. 5. Take the booked founder calls. 6. Decide M-H when the product side earns it.

## Kill / re-plan criteria
- Day 30 with zero deposits AND < 10 qualified conversations → re-run the doc-06 framework on the offer (price, deposit size, ICP) before spending day 31.
- Deposit refund rate ≥ 20% → the promise is outrunning the product; tighten claims, slow outbound.
- Any evidence this program slowed the product build → the product build wins; cut scope here first.

**Fire this request and begin with F-1, F-4, and the M plugin scaffold in the same first session — F-4 because it is calendar-locked, F-1 because everything else is blocked on it, M because visibility is what lets both of us trust the loop.**
