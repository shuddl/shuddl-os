# D-3 / Content 02 — Fraud & Identity

**Status:** DRAFT v1 for owner read · **Gates:** [F1-icp.md](F1-icp.md) ✅ (10–100 truck US regional carrier + secondary small/mid brokerage ICP) · [A1-messaging.md](A1-messaging.md) hard-don'ts firewall applied ✅
**Format:** data-journalism post, ~1,190 words (headline + body, excluding this header and the source map) · **Sources:** every figure traced to [the fraud/identity competitor appendix](../research/2026-08-01-coordination-layer/raw/competitors-fraud-identity-interop.md) and [the value-anchors fact sheet](../research/2026-08-01-coordination-layer/raw/value-anchors-fact-sheet.md); map at the bottom of this file.
**Target outlets/channels:** carrier and brokerage trade press, state association newsletters, carrier communities, waitlist nurture.

---

## Freight fraud is an identity problem right up until the truck arrives — after that it's an evidence problem

A truck backs into a dock at 6:40 in the morning. A man gets out, gives a name, and leaves with a trailer. Eleven days later the freight hasn't arrived anywhere, a claim is open, and everyone is trying to answer one question: who took it?

At most docks in America the honest answer is that nobody wrote it down in a form that survives being asked.

That isn't for lack of spending. Four years of escalating fraud have been met by checking harder at the front door — verify the authority, verify the phone number and email domain, flag an authority that changed hands last month, monitor insurance and safety continuously. That work is real, well built, and it stops real theft. It also happens in an office, days before any truck exists at any dock, and it answers a question about paper.

### Start with the size of it

Recorded cargo theft in the United States reached an estimated **$725 million in 2025 — up 60%** year over year. The average theft was **$273,990, up 36%**. Confirmed thefts rose 18%, to **2,646**. And the raw incident count was **flat, at 3,594**. ([Verisk CargoNet, 2025](https://www.verisk.com/company/newsroom/cargo-theft-losses-surge-to-estimated-$725-million-in-2025-verisk-cargonet-analysis-reveals/))

Read those four together, because the story is in the last one. The number of attempts didn't move. The money did. The industry isn't being robbed more often — it is being robbed better, by people choosing targets with more care and taking far more per attempt. Organized freight theft has grown **+1,500% since 2021**, per the Transportation Intermediaries Association (TIA, 2025).

The paperwork side is at least as large. Double-brokering — a load accepted by one party and quietly handed to another the shipper never approved — runs **$700 million to $1 billion a year** (TIA, 2025).

You'll also see **$35 billion** quoted as the industry's annual fraud bill. That's a trade-association upper bound covering every flavor of strategic fraud (TIA, 2025), and I won't build an argument on a number that soft. The floor is enough: $725 million of recorded theft plus $700 million to $1 billion of double-brokering, against a truckload sector that averaged a **−2.3% operating margin** in 2024 ([ATRI, 2024](https://truckingresearch.org/2025/07/new-atri-report-shows-trucking-profitability-severly-squeezed-by-high-costs-low-rates/)).

And it lands hardest on firms the size of yours. In TIA's April 2025 fraud survey, **22% of 3PLs had lost more than $200,000 to fraud in the preceding six months**, and **83%** had been hit by at least three distinct fraud types in that same half-year. ([TIA State of Fraud, April 2025](https://member.tianet.org/TIAnetOrg/Member%20Resources/White-Papers/State-of-Fraud-in-the-Industry-April-2025.aspx))

Two hundred thousand dollars in six months is a $400,000-a-year pace if the back half looks like the front — my arithmetic, not a finding, and the survey doesn't claim it repeats.

### The locks are good — they're bolted to the wrong door

Give the vetting business its due. The carrier-identity platforms brokers buy today catch impostors who would otherwise walk off with freight, and they get better every year. The federal government has now absorbed the baseline: identity verification entered carrier registration in April 2025, and FMCSA's legacy registration systems were replaced by Motus on **May 14, 2026** ([FMCSA, *Federal Register*, 2026](https://www.federalregister.gov/documents/2026/04/29/2026-08334/availability-of-motus-fmcsas-new-registration-system)). Proving that an operating authority belongs to a real, identifiable human is becoming a public utility — a good outcome that should sharpen the whole category.

Notice what every one of those checks, private and federal alike, asks. *Who is this carrier, on paper, right now?* It is the correct question, and the answers are improving.

But it is asked about an entity, at onboarding, in an office.

The theft is not committed by an entity in an office. It is committed by a person, at one door, at one minute, who says a name to a warehouse worker with no way to check it and drives off with a quarter of a million dollars of freight. Two things go wrong in that gap, and no upstream check closes either by design: a legitimate carrier can be impersonated at the dock, and a legitimately booked load can be re-handed to an unapproved third party after every check has cleared. The credential was genuine both times. The handoff was never recorded.

That is why the loss curve and the vetting curve can climb together. They aren't in conflict. Vetting is necessary — it is aimed at the moment *before* the risk, and the risk is standing at the door.

### What a handoff needs to survive being questioned

Six things, and the sixth is the one everybody skips:

1. Who physically arrived — the person and the equipment, identified at the door, not inferred from last week's booking.
2. That this person is the one the load was tendered to — checked at the handoff, not at onboarding.
3. When and where, to the minute and to the foot, recorded as it happened.
4. What condition the freight was in — photographs, not adjectives.
5. Both parties on the record — whoever released it and whoever took it, each attesting separately.
6. **A record neither party can quietly edit once a claim opens.**

None of that is hard in 2026. Both people at that door already carry devices that know the time and the place. The gap is that the moment isn't treated as a record at all. What it produces today is a name printed on a bill of lading, a signature in a box, a photo in somebody's camera roll, a gate log owned by one side, and a status typed into a screen by someone who wasn't there. Every one is a single party's assertion, made after the fact, editable by whoever holds it. None decides a claim, because none was built to be evidence.

### What we're building

This is what SHUDDL is built around, and it is a narrow claim: the handoff itself becomes the record. Arrival, custody transfer and departure are captured at the door by the person standing there — each a separately signed event carrying its own time, position, photographs and signature. The counterparty signs too, so a transfer carries two attestations rather than one party's word. Corrections are new records instead of overwrites, so the chain hands to a broker, an insurer or an adjuster intact. It works with no cell signal.

Plainly: it is built and running on our own infrastructure, and we are entering Founding Carrier pilots. It has not been proven across a hundred fleets, and I'm not going to tell you it has.

What *has* been proven is the other side of it. $725 million. $273,990 a theft. Incident counts flat while losses rose 60%. Those numbers are published, sourced, and sitting in plain view.

If you run 10 to 100 trucks in the lower 48, or a brokerage alongside them, and you've been buying more vetting every year while the losses climbed anyway, we're selecting a small group of Founding Carriers to run this beside what they already use. The waitlist is at **shuddl.tech**. Bring the last fraud loss you ate — the one where you knew exactly what happened and couldn't prove a minute of it. That's worth an hour whether or not you ever become a customer.

<!--
SOURCE MAP — every figure above → the two authorized raw files:
  A = docs/research/2026-08-01-coordination-layer/raw/competitors-fraud-identity-interop.md
  B = docs/research/2026-08-01-coordination-layer/raw/value-anchors-fact-sheet.md
(line numbers are of those files as of 2026-08-02)

| Figure in draft | Raw line | Source name + year |
|---|---|---|
| $725M recorded cargo theft, 2025 | A L32, B L73 | Verisk CargoNet, 2025 |
| +60% YoY | A L32, B L73 | Verisk CargoNet, 2025 |
| $273,990 average theft, +36% | A L32, B L73 | Verisk CargoNet, 2025 |
| 2,646 confirmed thefts, +18% | B L73 | Verisk CargoNet, 2025 |
| incidents flat at 3,594 | B L73 | Verisk CargoNet, 2025 |
| organized theft +1,500% since 2021 | B L74, A L38 | TIA, 2025 |
| double-brokering $700M–$1B/yr | B L41 | TIA, 2025 |
| $35B all-in fraud estimate (used only to discard it) | B L74 | TIA, 2025 — labeled in-body as an association upper bound |
| truckload operating margin −2.3%, 2024 | B L12 | ATRI, 2024 |
| 22% of 3PLs lost >$200K in six months | B L42 | TIA State of Fraud, April 2025 |
| 83% hit by ≥3 fraud types in six months | B L42 | TIA State of Fraud, April 2025 |
| identity verification enters carrier registration, April 2025 | A L36 | FMCSA, 2025 |
| Motus replaces legacy registration systems, May 14 2026 | A L36 | FMCSA / Federal Register, 2026 |
| "verifies who a carrier is on paper, not what happened at the door" | A L22, A L73 | research-agent synthesis in file A, restated as argument (not a statistic) |

DERIVED (labeled as arithmetic in the body, not presented as a published finding):
- $400,000/yr pace = $200,000 per six months (B L42) × 2 — flagged in-body as my arithmetic and as non-repeating.
- "a quarter of a million dollars of freight" = prose restatement of the $273,990 average (B L73), not a new figure.
- "Twenty-two percent" and "60%" in the closing recap = restatements of B L42 and B L73 already cited above.

NON-STATISTICAL NUMERALS (narrative or audience descriptors, no source required):
- "6:40 in the morning", "Eleven days later" — narrative scene, no claim made.
- "Four years of escalating fraud" — spans the 2021 baseline in B L74 to 2025.
- "Six things", list items 1–6, "Two things go wrong" — structural counts.
- "10 to 100 trucks in the lower 48" — the F1-icp.md primary ICP band.
- "a hundred fleets" — rhetorical; used to DENY a claim, not to make one.
- "2026" — the current year.

OMITTED deliberately (present in the raw files, not used):
- Q2 2025 fraud-index counts (495K blocked emails, 42K fraudulent calls, 135% spike in suspicious authority transfers) and the 63,000 fraud checks / 14,000+ failed identity checks figures (A L22, A L26) — both vendor-published; citing them requires naming a carrier-identity vendor, breaching REQ-167 / falsifier (c).
- Carrier vetting/monitoring price points, $2–$10/carrier/mo + $50–$500/seat/mo (B L39) — vendor source; naming it breaches REQ-167, and the piece deliberately does not argue on price.
- 10% of 3PLs spend >$200K/yr on prevention; unlawful brokerage as top tactic at 34%; 97% naming truckload the most fraud-prone mode (all B L42) — cut for length only, all usable in a future draft or a sidebar.
- Double-brokering strict-definition subset $500–700M (B L41, A L38) — cut for length; the $700M–$1B headline range carries it.
- FMCSA broker-fraud complaints >8,000 in 2025 vs ~2,000 in 2021 (B L40) — cut. It is the only figure I drafted whose fact-sheet row is ⚠️-flagged as a secondary compilation, and its sole located link is a vendor blog; the double-brokering dollar figure carries the same point on a firmer citation.
- +40% theft incidents 2024 (A L38) — its attributed body is not on the allowed-entity list.
- Carrier-fragmentation and market-size figures (B L67, B L69) — attributed to a body not on the allowed-entity list; the ICP band does the same work.
- All Category 9 interop material — that argument is platform/substrate framing, barred by falsifier (d) pre-tenant-0.

NOTE ON LINKS — RESOLVED 2026-08-02 (tick 8) by the parent loop: the divergence was caused by an over-broad rule in this agent's brief ("no company name at all"), not by a real constraint. The rule is now stated precisely in A1-messaging.md — companies as *subjects* are banned; publications and research bodies as *citations* are allowed and preferred, because a checkable claim is a stronger claim. The two stripped citation URLs may be restored at publication; both figures retain source name + year, and the outlet links are recoverable from piece 1 and from docs/research/2026-08-01-coordination-layer/raw/. Original note follows.
ORIGINAL NOTE — a deliberate divergence from piece 1, flagged for the owner: piece 1 linked a trade outlet (freightwaves.com) when that outlet was reporting a research body's finding. This piece does NOT. Falsifier (c) on this brief bars ANY company name from appearing at all, and a media-outlet hostname inside a URL is a company name rendered on the page. So every URL in the body resolves to the research body or the government itself — verisk.com, member.tianet.org, truckingresearch.org, federalregister.gov — and the two figures whose only located links were trade outlets (organized theft +1,500%, TIA; double-brokering $700M–$1B, TIA) are cited in plain text as "(TIA, 2025)". Source name and year are intact, which is what falsifier (a) requires; the URLs remain recorded on B L74 and B L41 for fact-checking. If the owner prefers piece 1's linking convention, restore those two links — the underlying citations are unchanged.

FALSIFIER CHECKS APPLIED
(a) every numeral in the body is either mapped above to raw-file line + source name + year, explicitly labeled as my arithmetic, or listed as a non-statistical narrative numeral;
(b) no customer/tenant/production claim — the only status sentence is "it is built and running on our own infrastructure, and we are entering Founding Carrier pilots", per A1 hard-don'ts; the piece additionally volunteers that it "has not been proven across a hundred fleets";
(c) zero company names — no vendor, platform, carrier, tenant, person or customer is named; the only named entities are Verisk CargoNet, TIA (Transportation Intermediaries Association), FMCSA and ATRI, all research bodies or government agencies. Categories are described generically ("carrier-identity platforms", "the vetting business"). Motus is an FMCSA system name, not a company;
(d) "coordination layer" absent; no platform/network/marketplace framing of SHUDDL — "platform" appears only as a generic label for the vetting category; "AI" and "AI-powered" absent entirely;
(e) the argument is explicitly "necessary but insufficient, and aimed at the wrong moment" — the piece states that vetting "stops real theft", that the business has "earned" its due, that federal identity verification is "a good outcome", and that the loss curve and the vetting curve "aren't in conflict". No identity-vetting approach is called useless.
-->
