# P-1 — Press Kit + Three Tailored Pitches

**Status:** DRAFT v1 for owner read — **nothing here goes to a journalist until the owner reads it and supplies §7 (founder bio) and the contact block.**
**Gates:** [F1-icp.md](F1-icp.md) ✅ (audience) · [A1-messaging.md](A1-messaging.md) hard-don'ts firewall applied ✅ · [C3-founding-carrier-program.md](C3-founding-carrier-program.md) (the offer) · [D3-content-01-detention.md](D3-content-01-detention.md) (the piece offered as an exclusive)
**Readiness ceiling:** every product claim below is bounded by [docs/research/2026-08-01-coordination-layer/01-system-readiness.md](../research/2026-08-01-coordination-layer/01-system-readiness.md) ("research doc 01"). If it isn't in doc 01 or a gated GTM doc, it isn't in this kit.

---

## 0. Rules of use (read before sending anything)

1. **The only permitted status sentence is:** "built and running on our own infrastructure; entering Founding Carrier pilots." Not "customers are using it." Not "in production with carriers." There are zero tenants (doc 01 §1).
2. **Every demo asset is labeled STAGING** on the frame, not just in the caption.
3. **No names.** No tenant, customer, person, or incumbent-vendor name in any written material (REQ-167). Outlet and reporter names are fine. Cited research bodies (ATRI, the OOIDA Foundation, BLS) are sources, not vendors, and are fine.
4. **The build story is about how it was built, not about the product being "AI."** A1's don't #3 stands: automation is the mechanism, never the value proposition. Do not let a headline become "AI-powered TMS."
5. **No industry-wide framing.** Carrier value only. No platform / network / marketplace language, ever, pre-tenant-0.
6. **Pricing is a hypothesis, not a rate card** (C-3). Do not quote deposit terms in writing until counsel signs them off (F-3 is open).

---

## 1. One-line descriptor

> SHUDDL is a freight operating system for regional trucking carriers that turns every completed stop into tamper-evident proof — and into an invoice with that proof already attached.

## 2. Boilerplate (79 words)

> SHUDDL is a freight operating system for regional trucking carriers, built on physical proof. When a driver completes a stop, the arrival, departure, position, timestamps, photographs and signature are sealed into an append-only, co-signed record that neither party can quietly edit. The invoice and its evidence are generated from that record instead of re-typed from it, so a disputed claim ships with its own proof. It is built and running on its own infrastructure, and entering Founding Carrier pilots.

---

## 3. Fact sheet — defensible claims only

Each row is either quotable as written or usable as background. **Source column is the in-repo artifact that backs it.** Anything not on this list does not get said.

### 3a. What is built

| # | Claim (as it may be stated) | Source | Verification note |
|---|---|---|---|
| 1 | All 35 of 35 event kinds in the ledger are implemented, with schema envelopes and length-pinned tests. | research doc 01 §4 | VERIFIED in the underlying audit (`raw/readiness-audit.md` §3, "35-kind list") |
| 2 | The ledger is append-only and co-signed: corrections are new records, never edits. Canonical hashing, chain verification, Merkle + RFC-3161 timestamp anchoring, redaction/visibility rules, 8 projections, a journal export. | research doc 01 §4, §7 | VERIFIED (static, file-cited) |
| 3 | Gates are enforced server-side and no interface can talk its way past them. A blocked gate observably emits the list of evidence it still requires. | research doc 01 §4 ("the Gatekeeper is the strongest piece: server-side, Durable-Object-enforced, observably emitting `GATE_BLOCKED` with required-evidence lists in CI"); CLAUDE.md rule #3 | VERIFIED. Keep the infrastructure product term out of written copy; describe the behaviour |
| 4 | All three surfaces are built and deployed: dispatch console, driver PWA (with offline sync), customer portal. Public shipment tracking is a portal route, not a fourth surface. | research doc 01 §4 | VERIFIED |
| 5 | 11 of 12 canonical views are built, inside a registry with a budget tripwire. | research doc 01 §4 | VERIFIED |
| 6 | Of 13 protocol agents: 9 substantially real, 2 partial, 1 built but dark at its external transport, 1 deliberately deferred. | research doc 01 §4 | INFERRED per-agent (audit judged by file size, headers, call-graph greps — not by execution): `raw/readiness-audit.md` confidence notes |
| 7 | The schema is 18 tenant tables + 4 control tables, inside a hard budget of 22. | research doc 01 §4 | VERIFIED |
| 8 | Sixteen work packages are closed; the remaining *code* residual is roughly 1–2 engineer-weeks. | research doc 01 §1, §6 | VERIFIED (closure records); the effort estimate is the audit's own |
| 9 | Nine production hostnames answer over the wire, on real cross-consistent infrastructure bindings; the API fails closed and returns 401 on authenticated routes because no account exists yet. | research doc 01 §1 (live-probed 2026-08-01) | VERIFIED by live read-only probe |
| 10 | A signature at a door produces a penny-exact invoice with its evidence attached, in the same second — complete and demonstrated end-to-end on staging, with a real email sent. | research doc 01 §5 (demo 1) | **STAGING-measured mechanism, never a production fact** (A1 don't #4). The audit marks the staging-smoke record INFERRED from evidence records rather than re-executed. |
| 11 | Field capture survives no signal: an airplane-mode soak recorded 55 signed events across 2 devices with zero loss, and the chain verified. | research doc 01 §5 (demo 3); A1 messaging hierarchy | VERIFIED as a test record — it is a soak result, not a customer result |
| 12 | The live map's exception behaviour runs on a fully hash-verified event chain. | research doc 01 §5 (demo 5) | VERIFIED |
| 13 | Nothing is built that isn't a numbered requirement row first, and the requirements register is append-only. | CLAUDE.md §"Source-of-truth order" #1; §"Non-negotiable engineering rules" #1 | Repo governance artifact |
| 14 | At every work-package exit an adversarial audit swarm re-attacks the module; one such pass found 42 real defects in a module that had been called finished. | CLAUDE.md §"Non-negotiable engineering rules" #9 | Repo-recorded in the governing file; **not independently re-verified by the readiness audit** — offer as build-process background, not as a metric |
| 15 | Engineering verification surface: 258 test files / 3,243 tests; a 21-gate merge profile and a 26-gate release profile. | research doc 01 §2; `raw/readiness-audit.md` §2, §6 | Gate rosters VERIFIED; **test totals INFERRED** (counted statically, suites not executed in the audit) |
| 16 | An MCP server is deployed with a structured confirm gate — a model cannot self-authorize money — plus a TOCTOU-safe caps meter and fail-closed defaults. | research doc 01 §4 | VERIFIED as deployed shape. **Background only** — the end-to-end booking has never been exercised (§5 below) |

### 3b. What is *not* built — say these first, unprompted

| # | Claim | Source |
|---|---|---|
| 17 | Zero tenants, zero users, zero freight. The system today serves a marketing site, honest empty surface shells, and an API that refuses everything. | research doc 01 §1, §2 |
| 18 | A driver cannot yet sign in — the login path is unbuilt. | research doc 01 §5 (demo 3) |
| 19 | Public self-serve signup is closed: the interface is unbuilt and it legally cannot open before counsel delivers the terms/privacy/DPA set. | research doc 01 §5 (demo 2) |
| 20 | The release build is currently aggregate BLOCKED — 16 gates pass, 8 are blocked — and every one of the 8 is an **absent private input, not a code defect**. The repo's own runbook forbids inventing data to turn a gate green. | research doc 01 §3; `raw/readiness-audit.md` §5 |
| 21 | As a software artifact it is roughly 95% of a single-tenant freight OS. As a running business it is at zero, and the remaining distance is one real carrier with real data and a 14–20-week onboarding calendar that cannot be compressed. | research doc 01 §6, §7 |

### 3c. Market facts we may cite (not our data — theirs)

| # | Claim | Source |
|---|---|---|
| 22 | Drivers are detained on 39.3% of all stops; 56.2% on refrigerated freight; 117–209 hours per driver per year; $15.1B industry-wide ($3.6B direct + $11.5B lost productivity). | ATRI 2023, via [D3-content-01-detention.md](D3-content-01-detention.md) source map |
| 23 | Marginal cost of operating a truck: $90.89/hour (2024). Truckload sector operating margin: −2.3% (2024). | ATRI 2024, via D3 source map |
| 24 | 18% of drivers never receive detention pay; only 29% receive it on all loads; 9% of drivers who *always* request it are never paid. | OOIDA Foundation 2023 survey (n>1,250), via D3 source map |
| 25 | More than a third of trucking employees are non-drivers; 8.2 drivers per office manager, down from 11.3 (2009–19). | BLS 2021, via D3 source map |
| 26 | Roughly $10,600–$19,000 of detention exposure per seat per year; $266K–$475K at 25 trucks. | **Our arithmetic on two ATRI figures — must always be labeled as such**, per D3's own disclosure |

### 3d. Program facts

| # | Claim | Source |
|---|---|---|
| 27 | Target: US regional asset carriers running 10–100 power units (an FMCSA band of roughly 42,000 carriers, ~7.2% of carriers), often with a brokerage arm. | [F1-icp.md](F1-icp.md) |
| 28 | 8 Founding Carrier slots; onboarding runs mirror → 30-day revenue shadow → two clean closes → pilot → flip, sequentially, 14–20 weeks each. | [C3-founding-carrier-program.md](C3-founding-carrier-program.md); research doc 01 §6 |
| 29 | Founding Carriers are anonymous by default — no logo, no case study, no name without separate written consent. | C3 |
| 30 | A refundable deposit reserves a slot. **Do not put amounts or terms in writing until counsel signs off (F-3 open).** | C3 |

### 3e. Owner-attested — NOT repo-verifiable, confirm before use

These carry the FreightWaves pitch and **cannot be sourced from the repo**. The owner must confirm each before the pitch is sent; if any is wrong, edit the pitch, don't send it.

- That the build was done **solo**.
- That **AI coding agents** did the implementation work under the written constitution.
- Any **timeline** ("over N months") — no duration claim is sourced anywhere in the repo. The pitches below deliberately contain no duration.

### 3f. Known open items — accurate answers if asked, not volunteered

These are honest answers to a sharp reporter's questions. They are not talking points; do not lead with them.

- The map performance gate fails on hosted CI hardware (p95 233ms against a 55fps budget) while passing locally on the same commit — research doc 01 §3.1.
- Scheduled backups are staging-scoped; there is no production backup schedule (there is also no production data — zero tenants) — research doc 01 §3.2.
- Map tiles currently render from a third-party demo host, which the requirements register itself flags as a violation to close — research doc 01 §5 (demo 3).
- The EDI translator has a full X12 core but no live transport adapter — research doc 01 §4.

---

## 4. Claims we do NOT make

Hard stops. A draft containing any of these does not go out.

1. **No customers, tenants, users, freight, revenue, ARR, or "pilots underway."** There are zero. "Entering Founding Carrier pilots" is the ceiling.
2. **No named tenant, customer, person, or incumbent vendor**, and no implied endorsement by any of them.
3. **No comparison to, or displacement claim against, any named product or company.**
4. **The same-second invoice is never stated as a production fact** — it is a staging-measured mechanism until a real tenant measures it live.
5. **Never "AI-powered" as what the product is.** The ledger, the gates and the evidence are what it is; automation is how.
6. **No platform, network, marketplace, ecosystem, or industry-infrastructure framing.** Carrier value only.
7. **No claim that the build is green, promotable, or fully verified.** It is aggregate BLOCKED, by design, on absent inputs.
8. **No ROI stated as an achieved outcome.** Modeled ranges only, labeled as arithmetic on cited figures, with the halving caveat D3 already applies.
9. **No claim of a working driver login, an open public signup, a live EDI transport, or an exercised end-to-end MCP booking.** All four are unbuilt or unexercised.
10. **No "proven across fleets," "battle-tested," "industry-standard," or "trusted by."** Nothing is proven across fleets and the materials say so.
11. **No funding, valuation, headcount, or team claims** except what the owner supplies in §7.
12. **No pricing presented as final.** It is a hypothesis under test.
13. **No security or compliance certification claims** (no SOC 2, no audit attestation, no "compliant with" anything).

---

## 5. Embargo and availability

**Embargo status: none required.** Nothing in this kit is date-sensitive or under embargo. There is no launch date to hold. The only timing constraint is the reverse of an embargo: **deposit terms cannot be quoted at all until counsel signs them off**, so a story may say a Founding Carrier program is open and slots are limited, but not what it costs.

**Exclusivity we may offer:** first run of the detention piece ([D3](D3-content-01-detention.md), ~1,060 words, fully sourced) to one outlet, for a stated window. Offered to FreightCaviar in §9. If declined, it is offered onward, then self-published.

### Can be shown today — every asset labeled STAGING on the frame

| Demo | What it shows | Ceiling |
|---|---|---|
| Signature → invoice | A gated stop closing, producing a penny-exact invoice with its evidence attached and a real email sent, in the same second | STAGING environment; synthetic load; research doc 01 §5 demo 1 |
| Exception on the map | The live map dimming around a single exception, on a fully hash-verified event chain | research doc 01 §5 demo 5; disclose the CI perf finding if asked |
| A gate refusing | The server-side gate blocking a stop and naming the evidence it requires — the most characteristic thing the system does | research doc 01 §4 |
| Fail-closed production API | A live production hostname returning 401 on an authenticated route because no account exists | research doc 01 §1 — this is the honesty demo, not a bug |
| The three surfaces | Deployed dispatch console, driver PWA and portal rendering honest empty states (an em dash, never a fake zero) | research doc 01 §2 |
| The offline record | The airplane-mode soak record: 55 signed events, 2 devices, zero loss, chain verifies | A test record shown as a record — not a live re-run |
| The red gates | The actual gate output: 16 pass, 8 blocked, with the verbatim blocking reason on each | research doc 01 §3 — offer this unprompted; it is the story |

### Cannot be shown, and must not be described as though it could

- **Any real carrier, load, driver, invoice, or dollar.** Zero tenants (doc 01 §1).
- **A driver signing in.** The login path is unbuilt (doc 01 §5 demo 3).
- **A stranger signing up and quoting.** No signup interface; counsel-blocked (doc 01 §5 demo 2).
- **A booking placed end-to-end through the MCP server.** Verbs, confirm gate and caps are tested; the full booking has never been exercised (doc 01 §5 demo 4).
- **Production evidence email.** The production sender binding is absent and a two-week deliverability warmup has not run (doc 01 §5 demo 1).
- **Rate or invoice parity against a real tariff.** Those gates are blocked on private fixtures that do not exist in the repo (doc 01 §3).
- **A promotable release.** Aggregate BLOCKED (doc 01 §3).

### Assets

- **Demo films: not yet produced.** A-2 is queued in [00-mission-control.md](00-mission-control.md); until they exist, demos are live screen-shares, scheduled, staging-labeled.
- **Screenshots:** surface screenshots are available; no logos, no names, no plausible-looking fake data.
- **Photography / logos of any carrier:** never. Founding Carriers are anonymous by default (C-3).

---

## 6. Press contact

**[OWNER TO SUPPLY]** — name, title, email, phone, and the response-time commitment. Technical stack details are available on request in conversation; they are not written into materials, so that no vendor name enters a repo artifact (REQ-167).

## 7. Founder bio

> **[OWNER TO SUPPLY — one paragraph, 60–90 words.]**
> Suggested shape, for the owner to fill or discard: what you did in freight before this and for how long; the specific operational experience that made the evidence problem obvious to you; what you built and what you are doing now ("built and running on our own infrastructure; entering Founding Carrier pilots"). **Do not include:** any prior employer, customer or carrier name; any headcount, funding or valuation claim; any credential that cannot be checked. If the solo-build framing in §9's pitch is used, this paragraph is where it is substantiated — see §3e.

---

## 8. Pitch — FreightWaves (industry / tech desk)

**Angle:** the build story. A solo founder plus coding agents shipped a gate-enforced freight system on a co-signed ledger — and is publishing the red gates alongside it.
**Before sending:** confirm every item in §3e. **Word count: 198** (subject line through sign-off).

<!-- PITCH-A START -->
**Subject: A freight OS built solo with coding agents — including the parts that are still red**

[REPORTER] —

Pitching a build story, not a launch.

I built SHUDDL, a freight operating system for 10-to-100-truck regional carriers, working solo with AI coding agents under a written constitution: a requirements register where nothing gets built without a row, an append-only ledger where corrections are new records rather than edits, and gates enforced server-side so no interface can talk its way past them. At every module exit an adversarial agent swarm re-attacks the work — one pass surfaced 42 real defects in a module I had called finished.

What exists: 35 of 35 event kinds, three deployed surfaces, chain verification and RFC-3161 anchoring, a 26-gate release profile.

What doesn't: zero customers, zero tenants, zero freight. The release build is BLOCKED on eight gates, every one an absent input I won't fake. A driver still can't log in.

It's built and running on our own infrastructure; we're entering Founding Carrier pilots. I'll walk you through the staging demo and the eight red gates in the same session — the second half is the more interesting story.

[FOUNDER] · SHUDDL · [CONTACT]
<!-- PITCH-A END -->

## 9. Pitch — FreightCaviar (practitioner newsletter)

**Angle:** the detention data piece, offered as an exclusive.
**Word count: 195** (subject line through sign-off).

<!-- PITCH-B START -->
**Subject: Exclusive: the detention numbers, on one page, with the arithmetic shown**

[REPORTER] —

I wrote something your readers will argue about, and I'd rather it ran with you first.

The premise: detention is the most provable loss in trucking and the least collected. ATRI's 2023 study found drivers detained on 39.3% of all stops — 56.2% on reefer — for 117 to 209 hours per driver per year. Against ATRI's $90.89 marginal cost per hour, that's roughly $10,600–$19,000 a seat, or $266K–$475K across 25 trucks. That multiplication is mine and the draft says so, then tells you to halve it. Meanwhile the OOIDA Foundation found 9% of drivers who always request detention pay are never paid it.

Every figure carries source, year and link. Every estimate is marked as an estimate.

My disclosure, which is also in the piece: I'm building a system that captures signed arrival and departure records so a claim carries its own proof. It's built and running on our own infrastructure and entering Founding Carrier pilots. No customers yet — the piece says that in plain words.

~1,060 words, ready now, yours exclusively for [WINDOW]. Want it?

[FOUNDER] · [CONTACT]
<!-- PITCH-B END -->

## 10. Pitch — Overdrive / Land Line (driver-side trade press)

**Angle:** detention pay, and who is holding the proof when the argument starts.
**Word count: 198** (subject line through sign-off).

<!-- PITCH-C START -->
**Subject: 18% never see detention pay. The problem isn't the rate — it's who holds the record.**

[REPORTER] —

Disclosure first: I'm building a freight system. It has no customers, and this isn't a product pitch.

The OOIDA Foundation's 2023 survey of more than 1,250 drivers found 18% never receive detention pay and only 29% receive it on all loads. The headline number is smaller: 9% of drivers who request it every time are never paid. Those drivers did everything the process asks and lost anyway.

They aren't losing on the merits. They're losing because the receiver has a gate log and the driver has a recollection and a time written by hand on a bill of lading. ATRI puts detention at 39.3% of all stops and 117 to 209 hours a driver a year, at $90.89 an hour of truck cost.

The argument I'd like to make in your pages: the person standing at the dock should be the one who signs the arrival and the departure, with time, position and photographs — and nobody should be able to edit that record once the argument starts.

Guest column, or just a source. Either works.

[FOUNDER] · [CONTACT]
<!-- PITCH-C END -->

---

## 11. Falsifier checks applied

- **(a) Every product claim traced.** §3 lists each claim beside its in-repo source; unsourceable claims were removed rather than softened, and the three owner-attested items are quarantined in §3e with an explicit "confirm before use."
- **(b) No customers, tenants, production usage or revenue implied.** The only status framing used anywhere is A1's: "built and running on our own infrastructure; entering Founding Carrier pilots." All three pitches state the absence of customers explicitly.
- **(c) No named person, tenant, customer or incumbent vendor.** Only outlet names (FreightWaves, FreightCaviar, Overdrive, Land Line), cited research bodies (ATRI, OOIDA Foundation, BLS, FMCSA), and bracketed placeholders appear. Swept.
- **(d) "Coordination layer" absent; no platform / network / marketplace / ecosystem framing** in any outward-facing text. Carrier value only.
- **(e) Pitch word counts: A = 198, B = 195, C = 198** — all ≤200, counted mechanically over each `<!-- PITCH-x -->` block, subject line through sign-off, bracketed placeholders counted as words.
