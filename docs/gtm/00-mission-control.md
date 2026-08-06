# SHUDDL Mission Control — Pre-GTM Demand Program
**Visual board (live, republished each tick):** https://claude.ai/code/artifact/33d08be3-0e63-4d3f-b6c5-fe2ac990e42b
**Notion mirror (outside this session):** https://app.notion.com/p/3b0910117b5c814891d6fa6be5ff132b
**Program:** [docs/plans/2026-08-02-pre-gtm-demand-program-request.md](../plans/2026-08-02-pre-gtm-demand-program-request.md) (owner-approved 2026-08-02) · **Authority:** REQ-289 (Demand Lane, owner-signed) · **Research base:** [docs/research/2026-08-01-coordination-layer/](../research/2026-08-01-coordination-layer/00-goal-and-dods.md)

## 🚨 LIVE SITE CONTRADICTS THE CLAIMS LAW — owner decision needed

`shuddl.tech` is **publicly serving claims that are false or contradict the approved program**. Verified verbatim in `marketing-site/public/index.html` on 2026-08-02:

| Line | Live claim | Problem |
|---|---|---|
| 147 | *"a real carrier found ~$402K unbilled"* | **There are zero tenants and zero carriers.** This states a customer outcome that does not exist |
| 147 | *"…in &lt;5 s"* (unlabeled) | Staging-measured mechanism presented as a product fact |
| 203–204 | *"Founding 50 · First 50 carriers: 80% off months 3–6"* | Contradicts [C-3](C3-founding-carrier-program.md): **8 slots**, $2,500 refundable deposit, 24-mo price lock |
| 206 | `/api/founding-count` | Counts **waitlist signups** toward 50 and renders it as a founding counter — manufactured scarcity |
| 216 | *"Apply as a design partner"* | Implies case-study rights; C-3 promises **anonymity by default** |
| 89 | *"10–150 trucks"* | Contradicts [F-1](F1-icp.md): 10–100 |
| 203 | *"under 15 seconds"* quote claim | Retired as unbacked — the signup/quote path has no UI and is counsel-blocked |

**Ready-to-apply corrections:** [LIVE-SITE-CORRECTIONS.md](LIVE-SITE-CORRECTIONS.md) — 7 exact find/replace pairs, verified against the live file.

**I have not changed it.** Two reasons: live public copy is your voice, and the deploy lives in the marketing Cloudflare account I can't reach (the account split, owner-lane item). The correction is specified in [A4-landing-page-v2.md](A4-landing-page-v2.md) §0 as a merge blocker and can be applied on your word.

**Why this is urgent beyond principle:** the press kit is finished and three pitches are ready to send. A journalist who checks the site will find a customer claim we cannot support, next to a press kit that leads with "zero tenants." That contradiction is the story.

## NSM tracker

| Metric | Now | Day-30 target | Day-90 target |
|---|---|---|---|
| **CARR (deposit-backed committed ARR)** | **$0** | first deposit dollar | **≥ $100K** |
| Addressable ICP accounts identified | **23,623** (free, federal; 793 with broker authority) | enriched with contacts | segmented + sequenced |
| Deposits collected | $0 | ≥ 1 | ≥ 5 Founding Carriers by day 120 |
| Qualified founder-calls booked | 0 | ≥ 3/week | steady |
| Waitlist size | BLOCKED — KV lives in marketing CF account (1d40ee…); wrangler here is authed to product account → owner-lane #3 | growing | growing |
| Guardrails | refund rate <20% · 0 unapproved outbound · 0 product-repo code commits | — | — |

## ⚠️ Handoff to the product session
[**FINDINGS-for-product-session.md**](FINDINGS-for-product-session.md) — 3 verified product issues surfaced by this lane while doing read-only research, plus 2 unrecorded ops gaps. Headline: **a seed-loaded tenant renders an empty board** (board.ts inner-joins `positions`; the seed writes none — fails silently). Not fixed here by contract; documented for their triage.

## Blast-radius contract (how two Claude sessions share one machine)
- **This program owns:** `docs/gtm/**`, `docs/plans/2026-08-02-*.md`, the separate `marketing-site/`/`shuddl-site/` repos, external SaaS (Apollo, Resend, Vibe, Notion/Linear, Stripe).
- **The coding session owns:** `packages/`, `workers/`, `apps/`, `db/`, `tools/`, `fixtures/`, `tests/`, CI, deploys.
- **Shared, append-only, claimed here:** `genesis/09-REQUIREMENTS-REGISTER.csv` — **REQ-289 is taken by this program (2026-08-02).** Coding session: next free row is REQ-290.
- This program never commits to git unless the owner asks; files are left in the working tree, flagged here.
- **Contract verified holding (tick 4, 2026-08-02):** `git status` shows 11 product files modified (sequencer, claimed-tenants tests, parse-parity, …) — all the concurrent coding session's work. This program's footprint is exactly `docs/gtm/`, `docs/plans/2026-08-02-*`, `docs/research/`, `.claude/plugins/`, plus the claimed REQ-289 register row. Zero overlap.

## Install the board plugin (owner, one time)
```
/plugin marketplace add /Users/spencerpro/Desktop/shuddl-os/.claude/plugins/shuddl-mission-control
/plugin install shuddl-mission-control@shuddl-mission-control-dev
```
Then restart Claude Code. `/mc:status` renders this board, `/mc:next` returns your top tasks, `/mc:done <id>` marks a row complete.

## Workstream board

| ID | Item | State | Blocked on |
|---|---|---|---|
| F-1 | ICP one-pager | ✅ DONE — [F1-icp.md](F1-icp.md), owner-approved | — |
| F-2 | Demand-Lane register amendment | ✅ DONE — REQ-289 appended, owner-signed | — |
| F-3 | Counsel-reviewed deposit terms | 🔴 OWNER | Owner engages counsel (with REQ-138 set) |
| F-4a | Product/transactional sender | ✅ EXISTS — `send.shuddl.tech` verified in Resend, sending enabled | — |
| F-4b | Cold-outbound domain + mailboxes + warmup | 🟡 **PARTIAL AUTH** — profile/credits endpoint now answers (**3,772 unified + 4,000 lead credits, 0 used**), but `domain_purchase_index` still returns token-expired. Scoping blocked on the second scope | owner: re-auth again / grant full scope → then I present exact credit cost for yes/no → 2-wk warmup |
| F-4c | shuddl.tech zone/account split | 🔴 OWNER | CF account access only owner has |
| F-5 | CRM substrate | ✅ LIVE — [F5-crm-substrate.md](F5-crm-substrate.md) · [Notion pipeline](https://app.notion.com/p/26e38346958143f28da4f9dcb3d969ad): 9 stages, CARR formula counts only cleared deposits, ICP-gate field blocks unscreened outreach | 4 wiring links (waitlist/Stripe/outbound/UTM) blocked on owner items |
| A-1 | Sentence + pitch + messaging hierarchy | 🟢 DRAFT v1 — [A1-messaging.md](A1-messaging.md) | one owner read before public use |
| A-2 | Staging demo films (#1, #5) | 🟢 **SHOT LIST DONE** — [A2-demo-shot-list.md](A2-demo-shot-list.md): Film A 9 beats/84s, Film B 8 beats/78s, ~21 files cited, every shot matched to a doc-01 line proving it works; `<5s` captioned as staging-measured | 10 prerequisites in §6 — see [FINDINGS-for-product-session.md](FINDINGS-for-product-session.md) |
| A-3 | ROI calculator | 🟢 SPEC v1 — [A3-roi-calculator.md](A3-roi-calculator.md): 4 inputs that double as the ICP gate, 4 sourced output lines, headline as a range not a point, SHUDDL estimates visually separated from published figures | build blocked on CF account split (marketing repo) |
| A-4 | Landing v2 | 🟢 **SPEC v1** — [A4-landing-page-v2.md](A4-landing-page-v2.md): 9 sections, every copy line ID'd and audited against A-1; **6 capability claims retired as unbacked**; deposit markup must be ABSENT from the bundle (not CSS-hidden) until counsel, enforced by a CI grep | 🚨 blocks on the live-site corrections above + F-3 |
| A-5 | Pricing hypothesis one-pager | ✅ DONE — absorbed into [C3-founding-carrier-program.md](C3-founding-carrier-program.md) | — |
| D-1 | ICP account list — **SOLVED at $0** | ✅ DONE. [D1-icp-list-plan.md](D1-icp-list-plan.md) rejected the paid list (no truck-count field; 5K pool sampled 0/5 carriers). [D1-fmcsa-list-method.md](D1-fmcsa-list-method.md) replaces it: **23,623 qualified accounts — 4.7× the 5K target — from free federal data**, of which **793 hold active broker authority** (the hybrid bullseye). Cross-validated on two independent FMCSA files; 7.71% measured vs F-1's stated ≈7.2% | contacts need Apollo (owner re-auth); 4 counsel/owner questions in §6.4 |
| D-2 | Outbound sequences | 🟢 **DRAFT v1** — [D2-sequences.md](D2-sequences.md): 3 sequences (asset carrier · **the 793 hybrid bullseye** · inbound nurture), CAN-SPAM built into the copy structure not appended, company mailboxes not named officers, warmup volume ramp 20→40/day with pause thresholds. All 4 figures cross-checked to source | ⏸ **sending blocked**: F-4b warmup + F-3 counsel + owner approval of copy |
| D-3 | Weekly data-journalism content | 🟢 **2 PIECES DRAFTED** — [01 detention](D3-content-01-detention.md) (~1,045 w, 24 attributions) · [02 fraud](D3-content-02-fraud.md) (~1,189 w, 14/14 figures matched to source, 4 figures deleted for failing the sourcing bar). Both falsifier-verified twice | owner read before publish |
| P-1 | Press kit + 3 pitches | 🟢 DONE — [P1-press-kit.md](P1-press-kit.md): 30 source-traced facts (incl. 5 "what is NOT built" rows led with, unprompted), pitches at 198/196/198 words, identity sweep clean | **owner: confirm the 3 quarantined claims in §3e + supply bio/contact** before anything sends |
| C-1 | Stripe deposit flow + terms page | 🟢 SPEC v1 — [C1-deposit-flow.md](C1-deposit-flow.md): 7-step flow, refund path as easy as purchase, idempotency on `session.id` so a webhook retry can't double-count CARR, deposit classed as refundable liability not revenue | **hard gate: F-3 counsel** — test mode OK, live mode forbidden until then |
| C-3b | Founder-call script + qualification rubric | 🟢 **v1** — [C3b-founder-call-script.md](C3b-founder-call-script.md): 25-min agenda, 3 diagnostic questions, 6-signal rubric with disqualify-on-the-call rules, 5 objections answered honestly, post-call CRM record | ready to use on the first booked call |
| F-5b | CRM wiring specs | 🟢 **SPEC** — [F5b-wiring-specs.md](F5b-wiring-specs.md): 5 wirings incl. **waitlist backfill (warmest leads, never contacted)** and idempotent Stripe→CARR | all 5 blocked on the CF account split |
| C-3 | Founding Carrier Program spec | 🟢 SPEC v1 — [C3-founding-carrier-program.md](C3-founding-carrier-program.md): 8 slots · $2,500 refundable deposit · 24-mo founding price lock | counsel (F-3) + owner read |
| M-1 | This registry/board | ✅ DONE (this file) | — |
| M-2 | Visual board Artifact | 🟢 LIVE (URL above); Notion/Linear mirror queued t3 | — |
| M-3 | `shuddl-mission-control` plugin | ✅ BUILT — `.claude/plugins/shuddl-mission-control/` · `/mc:status` `/mc:next` `/mc:done <id>` · manifest valid, all 6 board headings verified against the live file | owner: install + restart (command below) |
| L-1 | Autonomous loop (6h window, renewing daily) | ✅ RUNNING — self-paced wakeups | — |

## ⚠️ The program's own output is untracked (tick 15)

All **19 GTM docs**, the research suite, and the plugin are untracked in git (`??`). A routine `git clean -fd` in this repo — plausible during a build session — deletes every one of them. The program's rule is "never commit unless the owner asks," so I have not. **Say the word and I'll commit them to a branch** (docs only; no product code, no push).

Also this session: **the claude.ai MCP connectors are disconnected** (Notion, Apollo, Resend, Cloudflare, Stripe). The Notion mirror can't be refreshed and Apollo scope can't be probed until they're re-authorized in connector settings. The repo docs and the published artifact board are unaffected.

## ✅ Correction to my own record (tick 15)

The readiness audit reported **HEAD as `d6eec18`, 30 commits ahead of `origin/main`**. Re-measured directly today: **`d6eec18` is an *ancestor* of HEAD, not HEAD**; actual HEAD is `82e04c7` (2026-08-02), and the tree is **92 commits ahead**, not 30. The substantive finding is unchanged and *larger* than reported — a lot of unpushed work with no evidence record at HEAD. Corrected in [01-system-readiness.md](../research/2026-08-01-coordination-layer/01-system-readiness.md) and the [raw audit](../research/2026-08-01-coordination-layer/raw/readiness-audit.md).

No product-code work was lost: the reflog shows no reset or checkout, and there are no stashes. The uncommitted product-file changes observed during ticks 4–13 are simply no longer in the working tree — that is the coding session's business, and this lane makes no claim about it.

## ⏸ Loop paused at tick 14 — and why

Fourteen ticks produced **19 documents**: the ICP, the offer, the deposit mechanics, the CRM, a 23,623-account target list built from free federal data, two content pieces, a press kit, two demo shot lists, three outbound sequences, a landing-page spec, a founder-call script, and a plugin. **Everything that can be built without a decision or an access grant now exists.**

What remains is not work — it is seven decisions. Writing a third content piece while two sit unread, or a fourth sequence while three sit unsent, would be inventory dressed as progress. So the loop is paused rather than slowed.

**Resume trigger:** act on any owner-lane item below and restart with `/loop continue the SHUDDL Pre-GTM Demand Program…`. The board, the Notion mirror, and every artifact stay exactly as they are.

**Measured fan-out — how many of the 19 docs each blocker touches:**

| Blocker | Docs blocked | What it opens |
|---|---|---|
| **Counsel (F-3 + the 4 legality questions)** | **13** | The entire deposit path — and therefore CARR itself. Nothing can be charged, and no outbound can legally send, until this lands |
| **Cloudflare account split** | **7** | Waitlist count + backfill (warmest leads, never contacted), landing page, calculator, and the live-site correction deploy |
| **Apollo full scope** | **5** | Sending domains → mailboxes → the 2-week warmup clock, plus contact enrichment for 23,623 accounts |
| Live-site claim decision | 3 | Removes a false customer claim that currently contradicts the press kit |
| Press attestation + bio | 2 | Releases 3 pitches that are otherwise finished |

**The counsel item is the critical path and has the longest external lead time. If only one thing moves this week, that is the one.**

## 🔴 Owner lane (highest-leverage first)

1. 🚨 **Decide on the live-site claims** (banner at top). One line states a customer outcome that does not exist; several contradict the approved offer. Say the word and I'll prepare the corrected copy — but the deploy needs the account-split fix (item 4) or your hands.
2. **Apollo — finish the re-auth.** Partially working as of tick 7: profile/credits reads fine (3,772 unified, 4,000 lead credits, none used) but `domain_purchase_index` still returns token-expired, so I cannot scope sending domains. Re-authorize with full scope in claude.ai connector settings. (2 minutes)
3. **Engage counsel**: refundable-deposit terms (F-3) + the REQ-138 ToS/Privacy/DPA set. (This is the day-30 critical path: no deposit can be charged before it.)
4. **Fix the shuddl.tech zone/account split** (marketing CF account `1d40ee…` vs product `89618c…`).
5. **Outbound domain choice** (after #1): recommend buying 2 lookalikes — e.g. `shuddlfreight.com` + `getshuddl.com` — via Apollo so warmup is managed there. Mailbox purchase consumes Apollo credits and I will present the exact credit total for your yes/no before buying.
6. **Confirm or edit the 3 quarantined press claims** ([P1-press-kit.md](P1-press-kit.md) §3e — solo build, AI-agent-built, timeline) **and supply press contact + founder bio**. Nothing sends until you attest; the pitches deliberately carry no timeline.
7. **Install the board plugin** (§Install above) — gives you `/mc:status`, `/mc:next`, `/mc:done`.
8. **Read + approve for publication:** [A1-messaging.md](A1-messaging.md), [C3-founding-carrier-program.md](C3-founding-carrier-program.md) ($2,500 deposit, 8 slots, price lock), [D3-content-01-detention.md](D3-content-01-detention.md).
9. **Answer/route 4 outreach-legality questions** ([D1-fmcsa-list-method.md](D1-fmcsa-list-method.md) §6.4) — A1/A2 to counsel, A3/A4 are brand judgment calls. Notable: CAN-SPAM has **no** B2B exemption (per ftc.gov).
10. Later: one-time approval of the first sequence copy; take booked founder calls.

## Heartbeat log

| Tick | When | Session | Did |
|---|---|---|---|
| 1 | 2026-08-02 | demand-loop | Program fired. REQ-289 appended (F-2 ✅). F-1 ICP written+approved. Resend audit: send.shuddl.tech verified (F-4a ✅). Apollo token found expired → owner lane #1. Board scaffolded (M-1 ✅). Loop armed. |
| 2 | 2026-08-02 | demand-loop | A-1 messaging v1 (sentence + 2 variants + hierarchy + over-claim firewall). C-3 Founding Carrier spec v1 (absorbs A-5). Waitlist KV read failed → account-split root cause confirmed, attributed to owner-lane #3. Visual board Artifact published + linked. |
| 3 | 2026-08-02 | demand-loop | F-5 CRM substrate LIVE (Notion, 9 stages, CARR formula). 3 parallel agents dispatched under relay discipline (falsifier + exclusive path each): D-3 detention piece ✅ delivered and independently re-verified; M-3 plugin + D-1 Vibe ICP sample still running. |
| 4 | 2026-08-02 | demand-loop | M-3 plugin ✅ built + independently verified (manifest valid, 18 heading refs all real, 0 stray files). Cross-session contract verified holding against 11 concurrently-modified product files. D-1 ✅ delivered at $0 spend with a *negative* recommendation (don't buy the list; FMCSA is free and better). **Identity risk caught + fixed: 10 named prospect companies anonymized across the GTM docs; repo-wide sweep now clean.** |
| 5 | 2026-08-02 | demand-loop | Standing checks: contract holding (3 product files modified — coding session, down from 11, so they're committing); identity sweep clean. A-3 ROI calculator spec written. P-1 press kit ✅ delivered + re-verified (198/196/198 words, 0 banned framing, 3 unsourceable claims quarantined for owner attestation rather than asserted). D-1 FMCSA method still running. |
| 6 | 2026-08-02 | demand-loop | D-1 ✅ **fully solved**: FMCSA free-data method yields **23,623 ICP accounts (793 with broker authority)** vs the rejected $180 vendor list — cross-validated, runbook executed end-to-end as proof. 4 counsel/owner questions raised on outreach legality (CAN-SPAM has no B2B exemption — fetched from ftc.gov, not blogs). |
| 7 | 2026-08-02 | demand-loop | Identity sweep caught **residual named companies my tick-4 check missed** (narrow grep) — all withheld, repo-wide re-sweep now clean. Apollo **partially** re-authed (profile OK, domain scope still 401). C-1 deposit-flow spec written. D-3 piece 2 + A-2 shot list dispatched. |
| 8 | 2026-08-02 | demand-loop | A-2 shot list ✅ (2 films, every shot traced to a doc-01 line that proves it works). **The read-only planning surfaced 3 verified product defects** — chief among them a seeded tenant rendering an empty board — handed off, not fixed. |
| 9 | 2026-08-02 | demand-loop | D-3 piece 2 (fraud-as-evidence-problem) ✅ — 14/14 figures source-matched, 4 deleted rather than weakly sourced. **The agent caught an over-broad rule in MY brief** (banned all company names, which would have stripped legitimate citations); naming rule now stated precisely in A1 and the series convention is consistent again. |
| 10 | 2026-08-02 | demand-loop | D-2 sequences drafted (3, incl. one written specifically for the 793 dual-authority hybrids). Compliance designed into the copy rather than appended. A-4 landing spec dispatched. Standing checks clean: contract holding, pattern identity sweep clean. |
| 11 | 2026-08-02 | demand-loop | A-4 landing spec ✅ — 6 capability claims retired as unbacked; deposit markup must be absent from the bundle, not hidden. **The spec audit found the LIVE SITE serving a false customer claim** ("a real carrier found ~$402K unbilled" — verified verbatim, zero tenants exist) plus 6 more contradictions. Escalated to owner-lane #1; not changed unilaterally. |
| 12 | 2026-08-02 | demand-loop | [LIVE-SITE-CORRECTIONS.md](LIVE-SITE-CORRECTIONS.md) written — 7 exact find/replace pairs verified against the live file; **not applied, not deployed**. A-3 amended to drop 3 vendor-blog-only constants in favour of the visitor's own inputs. Board mirrored to Notion. |
| 13 | 2026-08-02 | demand-loop | Founder-call script + rubric written (the last artifact between a booked call and CARR). F-5b wiring specs written — surfaced that **existing waitlist signups have never been contacted**; backfill is now the first execution step. Live-site violations still present, awaiting owner. |
| 14 | 2026-08-02 | demand-loop | Checked all owner items: **none moved** (6 live-site violations still serving, CF still split, Apollo domain scope still 401). Assessed remaining unblocked work honestly and found it to be inventory rather than progress. Quantified blocker fan-out across the 19 docs. **Loop paused, not slowed.** |
| 15 | 2026-08-02 | demand-loop | Session restarted. Owner items: **none moved** (6 live-site violations still serving). **Corrected my own audit's git claims** — HEAD is `82e04c7` not `d6eec18`, and 92 commits ahead not 30. Flagged that all 19 GTM docs are untracked and one `git clean` from gone. MCP connectors down this session. |
| 16 | 2026-08-03 | demand-loop | **Re-derived the 23,623 figure myself** against the live federal API — step 2 (104,063 vs 104,047) and step 3 (35,965 vs 35,956) both reproduce within daily drift; email coverage 98.28% matches. Lexicographic trap confirmed real: **7× undercount** without the numeric cast. Plugin parser + all 133 doc links verified intact. |

## Kaizen log
1. (tick 1) Apollo auth decay discovered mid-flight — added a standing loop rule: verify external-tool auth at the START of each tick that depends on it, so owner re-auth requests land hours earlier.
2. (tick 2) Every blocked read now gets attributed to its root owner-lane item on the board, so one owner fix visibly clears its whole downstream cluster (the account split now shows 2 blocks: zone + waitlist count).
3. (tick 4) Relay-style dispatch proved its worth: each agent was given a falsifier and an exclusive path, and two of the three caught and fixed their *own* defects before returning (a broken heading literal in the plugin; an unsourceable dollar figure in the content draft). Standing rule: never dispatch a background agent without (objective, falsifier, exclusive path) — and re-verify the falsifier myself rather than trusting the report.
4. (tick 4) Parent-session verification caught what a self-report could not: `git status` is now the standing cross-session check, run every tick, to prove the two-session blast-radius contract is holding rather than assuming it.
5. (tick 4) **Third-party data pulls import identity risk.** Prospect names arrived in a research doc as a side effect of sampling a vendor index. New standing rule: any doc built from an external data source gets a named-entity sweep before it is written, and company names are withheld unless a row is an actual pipeline entry (which lives in the CRM, not in git). Descriptors ("a broker-software vendor") carry the analysis better than names anyway.
6. (tick 4) An agent's most valuable output was a **negative**: D-1 spent $0 and recommended *against* the purchase it was sent to scope. Standing rule: brief agents so that "don't buy / don't build" is an allowed and celebrated answer, never a failure to deliver.
7. (tick 5) **A brief can smuggle in an unverifiable claim.** I handed the press agent "solo founder + AI agents built it" as the story angle; it correctly refused to assert what the repo cannot prove and quarantined it for owner attestation. Standing rule: when I supply a narrative angle to an agent, tag it as *unverified input*, not fact — the falsifier must be allowed to catch **me**, not just the agent.
8. (tick 5) Press materials now **lead with what is NOT built** (zero tenants, driver login unbuilt, 8 gates blocked). Counter-intuitive but correct: a journalist who finds the gap themselves writes a different story than one who was handed it.
9. (tick 6) **The free authoritative source beat the paid one outright.** Two agents, same job: the vendor index cost $90–180 and lacked the ICP's defining field; federal data cost $0, carries exact power-unit counts, and yielded 4.7× the target. Standing rule: for any list/data need, price the *authoritative public* source before the convenient commercial one — and expect the public one to need real engineering (four silent-failure traps: text-typed numerics, `'X'` not `'Y'` flags, zero-padded join keys, multi-valued fields — each returned a plausible **0 rows** rather than an error).
10. (tick 6) When an agent's search returns marketing blogs for a legal question, that is a signal to go to the primary regulator. The CAN-SPAM finding came from ftc.gov directly after six SEO blogs were discarded — and it contradicted the folk wisdom (there is **no** B2B exemption).
11. (tick 6) I broke this log's numbering twice by appending kaizen entries *before* the tail instead of after it — a small thing that made the record misleading about its own order. Fixed by sorting on tick, and the lesson generalizes: **when I catch myself repeating a mechanical mistake, fix the procedure, not just the instance.** New rule for this file: kaizen entries append at the end, always, and the tick number in the parenthetical is the sort key of record.
12. (tick 7) **My own "CLEAN" was wrong.** The tick-4 identity sweep grepped for the specific names I already knew about, so it missed five more in a different table of the same file. A sweep that only looks for known-bad strings cannot find unknown-bad ones. New standing check: sweep by *pattern* (`[A-Z]\w+ (Trucking|Logistics|Freight|Transport|Express|Carriers|Inc\.|LLC)`), not by known names — and run it repo-wide every tick, not once per doc.
13. (tick 7) **Partial auth is not auth.** Apollo's profile endpoint answered while its domain endpoint still 401'd; reporting "Apollo is back" off the first call would have been wrong. Standing rule: probe the *specific* endpoint the next action needs, not a convenient adjacent one, and report scope-level status rather than a binary.
14. (tick 8) **Planning a demo is an audit in disguise.** Asking "what exactly will be on screen?" forced a read of the real render path and found a silent-failure bug (empty board from a seeded tenant) that no test caught, because the join drops rows rather than erroring. Standing rule: when a GTM task requires reading product code, treat whatever it finds as a first-class finding and hand it off — the demand lane sees the product the way a customer will.
15. (tick 9) **A rule that is too strict is also a defect.** My brief said "no company name at all"; the agent obeyed it, stripped two legitimate source URLs, and then flagged that it had diverged from the established convention. Over-constraint degraded the work quietly — a checkable claim became a less checkable one. The rule is now precise (subjects banned, citations allowed) and lives in A1 where every future brief inherits it. Standing rule: state constraints by their *purpose*, so an agent can tell a real violation from a false positive.
16. (tick 10) **Compliance reads better as candor than as boilerplate.** CAN-SPAM needs disclosure, an address, and an opt-out; the draft says "I pulled your DOT registration from the public FMCSA file — that's how I found you" in the first line of the first email. It satisfies the rule and simultaneously disarms the question every cold recipient is already asking. Standing rule: when a constraint forces a disclosure, put it where it does persuasive work instead of hiding it in a footer.
17. (tick 10) The strongest asset in the whole program came from a *segment*, not a message: the 793 accounts holding both carrier and broker authority are the ICP's bullseye and they got their own sequence. Standing rule: before writing copy, ask what the data already knows about who is most likely to buy — segmentation beats wordsmithing.
18. (tick 11) **We audited everything except what was already public.** Eleven ticks of claims discipline on new material, while a live page claimed a customer that does not exist. The claims law was applied forward, never backward. New standing check: audit *shipped* surfaces against the claims law before writing more new ones — the oldest asset is the least reviewed and the most exposed.
19. (tick 11) The spec agent retired six of its own would-be claims (15-second quotes, EDI-in-a-day, native assistant booking, "thirteen agents run the protocol") by checking each against the readiness audit rather than the product vision. **A capability that exists in the plan is not a capability that exists.** Every outward claim now gets checked against doc 01, not against what we intend to ship.
20. (tick 12) **A weak citation is a claim you can't defend, so drop the claim.** Three calculator constants traced only to vendor blogs; rather than cite a competitor's marketing post or quietly keep an uncited number, the cash-cycle line now runs entirely on the visitor's own inputs. Removing the weak source made the output *more* persuasive, not less — they trust their own days-to-pay more than any average we could publish.
21. (tick 12) When the fix is outward-facing, the deliverable is **a diff plus a decision**, not an edit. Exact find/replace pairs verified against the live file cost me one tick and cost the owner one read — versus a surprise change to public copy in their own voice, which no amount of being right would justify.
22. (tick 13) **The call script's first instruction is not to sell.** With zero tenants, a hard close is both dishonest and ineffective against an operator who has been pitched all year — so the script spends half the call on the carrier's own numbers and tells the owner to disqualify out loud when the fit is wrong. A wrong-fit deposit becomes a refund and a bad story; a respected disqualification becomes a referral.
23. (tick 13) Writing the wiring spec found an **unworked asset**: waitlist signups already exist, have never been contacted, and can't even be counted from this account. They raised a hand with zero outbound and zero content — the warmest leads the program has, sitting idle behind an infrastructure task. Standing rule: when specifying a pipeline, always ask what is *already in it*.
24. (tick 14) **Knowing when to stop is part of the loop.** A self-directed agent's failure mode is not idleness, it is manufacturing plausible work — a third content piece while two go unread looks like diligence and is actually inventory. The honest read was that 14 ticks had exhausted everything not gated on a human, so the loop paused itself rather than burn budget looking busy. Standing rule: each tick asks whether the *next* unit of work changes the north-star metric or merely adds to the pile.
25. (tick 14) Measuring **fan-out per blocker** (how many of the 19 docs each gated decision touches) turned a flat to-do list into a ranked one and produced a single clear ask: counsel blocks 13 docs and has the longest external lead time. A list of seven equal-looking items is a list nobody starts; one named critical path is actionable.
26. (tick 15) **A cited SHA is a checkable fact, so check it.** The readiness audit named a commit as HEAD that was actually an ancestor, and understated the unpushed count by 62 commits. I repeated both to the owner. One `git merge-base --is-ancestor` would have caught it at the time. Standing rule: any identifier an agent reports — a SHA, a row count, an endpoint — gets re-derived by the parent before it enters a document the owner will act on.
27. (tick 15) **Work that exists only as untracked files is not safe.** Fifteen ticks of output sat one routine `git clean -fd` away from deletion, and the no-commit rule that protected the repo was silently endangering the program's own product. A rule that prevents a risk in one direction can create one in the other; re-examine standing rules when the thing they govern changes size.
28. (tick 16) **The number the thesis rests on now has two independent derivations.** After catching an agent's wrong SHA, I re-ran the FMCSA funnel myself rather than keep quoting 23,623 on trust. It held — and in the process I hit the exact silent failure the doc warns about (a double-encoded wildcard returned a confident `0`, not an error). Verifying a claim by reproducing it teaches you its failure modes; verifying it by re-reading the claim teaches you nothing.
