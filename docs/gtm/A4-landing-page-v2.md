# A-4 — Landing Page v2 (Founding Carrier)

**Status:** SPEC v1 — build-ready for the marketing repo, with three blocks flagged · **Owns:** the copy, the form contract, the gates. It does **not** touch `marketing-site/` — that repo is read-only to this workstream until the owner says otherwise.
**Gates:** [F1-icp.md](F1-icp.md) ✅ (audience) · [A1-messaging.md](A1-messaging.md) (claims law — every line below is audited against its Hard don'ts in §8) · [C3-founding-carrier-program.md](C3-founding-carrier-program.md) (the offer) · [C1-deposit-flow.md](C1-deposit-flow.md) (**hard counsel gate — F-3**) · [F5-crm-substrate.md](F5-crm-substrate.md) (where a submission lands) · [A3-roi-calculator.md](A3-roi-calculator.md) (the page this one hands off to)
**Capability truth source:** [research doc 01 — system readiness](../research/2026-08-01-coordination-layer/01-system-readiness.md). Every capability sentence on the page carries a doc-01 cite in §8b. A sentence without one does not ship.

---

## 0. Scope, route, and what v1 must lose

**Route:** v2 replaces `/` on `shuddl.tech`. `/founding` is an alias to the same document (the Founding Carrier section is the page's spine, not a separate page). The existing demo-spine map, fonts, and Terminal Gallery CSS are **kept**; the copy is replaced.

**v1 claims that must be deleted before v2 ships.** Each is either unbacked by doc 01, contradicts F-1/C-3, or breaks A-1. This list is a merge blocker, not a suggestion.

| v1 line (`marketing-site/public/index.html`) | Why it dies |
|---|---|
| "in your client's inbox in under 5 seconds" (hero sub, l.86) | Unlabeled timing figure. A-1 don't #4 — staging-measured only. v2 keeps the mechanism, labels every number. |
| "a real carrier found ~$402K unbilled" (race table, l.147) | Implies a customer/tenant. A-1 don't #1 and #2. No source in any GTM doc. |
| "email to bookable quote in under 15 seconds" (l.91, l.129, l.148) | No measurement exists in doc 01 for this figure. Unsourced timing claim. |
| "New EDI partner — about a day, certified by replay" (l.132, l.151, l.173) | Doc 01 §4: Translator is **dark at the transport seam** — X12 core only, no live VAN/AS2/SFTP. Claims a capability that cannot be delivered. |
| "Booking from an AI assistant — Native" (l.154) | Doc 01 §5 demo 4: "full DO-backed booking **never exercised e2e**." Also AI-as-value-proposition (A-1 don't #3). |
| "Thirteen agents run the protocol" + the 13-card grid (l.163–178) | Doc 01 §4: 9 substantially real, 2 partial, 1 dark, 1 deliberately vNEXT. "Thirteen run the protocol" is false today. Also leads with automation-as-value. |
| "Dispatcher copilot — route and co-load suggestions… predicts misses hours ahead" (l.168) | vNEXT (REQ-029). Unbuilt. |
| "First 50 carriers: 80% off months 3–6" + "Design partners — 10 seats… case-study rights" (l.204–216) | Contradicts C-3: **8 slots**, $2,500 refundable deposit, 24-month founding price lock, **anonymity by default** (no case study, no logo, no name without separate written consent). |
| "US LTL & final-mile carriers, 10–150 trucks" (l.89, l.215) | Contradicts F-1: **10–100 power units**, regional/interline OTR. |
| "one click exports everything, open formats" (l.136, l.211) | No doc-01 verification of a full-tenant export. Withheld until someone can cite the code path. |
| `/api/founding-count` counter rendering "Founding 50" scarcity from CARRIER **signups** (l.206; `worker/index.js:75-97`) | The offer's scarcity is 8 **deposit-backed** slots. Counting signups as slots is manufactured scarcity. Remove the counter from the page (leave the endpoint dormant or repoint it post-C-1 to cleared deposits). |
| Demo artifacts showing `$412 all-in`, `Priced in 12 seconds`, `BOL-388412`, `Invoice 2041` with no staging lockup (l.46–75) | Unlabeled staging/synthetic figures on screen. A-2 §3: **every frame carries `STAGING · SYNTHETIC DATA · NO CUSTOMER FREIGHT`.** `aria-hidden` does not make a visible number honest. |

---

## 1. Page outline at a glance

| # | Section | A-1 message it serves | F-1 pain / audience it serves | Ask |
|---|---|---|---|---|
| S1 | Hero | The sentence (primary) + variants B/C as test cells | Owner/GM — cash cycle; the fit line pre-filters | Founder call · calculator |
| S2 | The problem, in your own numbers | Messaging hierarchy rows 1–2–4 (owner, ops, bookkeeper) | All three priced pains, cited | Calculator |
| S3 | How it works — 3 steps | The 100-word pitch, unpacked as mechanism | Ops manager (proof) + bookkeeper (no re-entry) | — |
| S4 | The Founding Carrier offer | "Built and running… entering Founding Carrier pilots" | Owner/GM — the decision | Founder call (deposit **only** post-F-3) |
| S5 | What we are **not** claiming | The Hard-don'ts firewall, turned into the differentiator | Owner/GM — the trust objection | — |
| S6 | FAQ | Bounded promises from all four hierarchy rows | Whole buying committee incl. drivers | — |
| S7 | Is this built for you? (ICP self-selection) | Naming/claims discipline applied to *fit* | F-1 disqualifiers, made honest and mechanical | Branch-specific |
| S8 | CTA + form | Primary sentence restated | Owner/GM | Founder call |

Order on the page: S1 · S2 · S3 · S4 · S5 · S7 · S6 · S8. (S7 sits *before* the FAQ so a disqualified reader gets their honest answer before they invest in reading the FAQ.)

---

## 2. Section copy

Copy lines are numbered `[Sx.y]` so the claims audit in §8 can address each one. **All copy is final text, not placeholder.** Case treatment follows the existing Terminal Gallery CSS (display = uppercase condensed; mono body) — see §6 for the mobile legibility carve-out.

### S1 — Hero

*Serves: A-1 the sentence (primary) · F-1 pain 2 (cash-cycle tax), owner/GM.*

- `[S1.1]` **Eyebrow:** SHUDDL — a freight operating system for regional carriers
- `[S1.2]` **H1 (cell A, primary):** Signed. Invoiced. Same second.
- `[S1.3]` **Sub:** Your driver's signature at the door seals the proof and issues the invoice — evidence attached, in your customer's inbox, out of the same event. Nobody re-types anything.
- `[S1.4]` **Mechanism + label (directly under the sub, same visual weight as the sub, never a footnote):** "Same second" is literal: the invoice is issued by the same ledger event as the signature. Every timing figure on this page was measured on our staging environment with synthetic freight. There is no production freight yet.
- `[S1.5]` **Status line (verbatim, A-1 don't #1 / A-3 §claims firewall):** Built and running on our own infrastructure; entering Founding Carrier pilots.
- `[S1.6]` **Fit line:** For US regional carriers, 10–100 power units, with a brokerage arm or building one.
- `[S1.7]` **Primary CTA:** Take the founder call →
- `[S1.8]` **Secondary CTA:** Put your own numbers in first →  *(→ A-3 calculator; falls back to `#call` until A-3 ships)*

**A/B/C test cells** (A-1 §variants; winner promotes to primary — the instrument that decides is F-5's `Pain Signal` field, after ~20 conversations):

| Cell | H1 | Sub | A-1 source | F-1 pain |
|---|---|---|---|---|
| **A** *(default)* | Signed. Invoiced. Same second. | `[S1.3]` | The sentence | 2 — cash cycle |
| **B** | Stop renting your own money. | `[S1.3b]` Your driver's signature at the door becomes the invoice in your customer's inbox — same second, proof attached. So the cash cycle stops being someone else's business model. | Variant B | 2 — factoring |
| **C** | Every claim ships with its own evidence. | `[S1.3c]` Signed, timestamped, photo-backed arrival and departure at every stop. Detention gets billed with proof attached, and a dispute ends with a link instead of an argument. | Variant C | 1 — detention |

> **Channel risk on cell B, for the owner:** F-1 lists factoring-broker referral networks as a watering hole — they know exactly who floats $900K. Cell B's framing ("renting your own money") is A-1-approved copy but is adversarial to a referral channel we want. Recommend cell B be reserved for outbound sequences to factoring-fatigued owners and **not** run as the public default. Owner decides.

### S2 — The problem, in your own numbers

*Serves: A-1 messaging hierarchy rows 1, 2 and 4 · F-1 pains 1, 2, 3.*

- `[S2.1]` **H2:** These are not our numbers. They're yours, and the industry's.
- `[S2.2]` **Lede:** Every figure below carries its source and its year. Where a number is ours rather than a published one, it says so, in a different weight, every time it appears. Put your own four numbers in and the page does the arithmetic with yours instead.

**Card 1 — Detention money left on the dock** *(F-1 pain 1; ops manager)*
- `[S2.3]` 39.3% of stops are detained. *(ATRI, 2023)*
- `[S2.4]` A truck sitting at a dock costs $90.89 an hour to be there. Drivers lose 117 to 209 hours a year to it, depending on sector. *(ATRI 2024 marginal cost; ATRI 2023 detention study)*
- `[S2.5]` 18% of drivers never receive detention pay at all. Only 29% receive it on every load. *(OOIDA Foundation, 2023, n>1,250)*
- `[S2.6]` The claim usually fails for one reason: nobody can prove when the wheels stopped and when they moved.
- `[S2.7]` **`our estimate` tag:** We assume about half of detention exposure goes unbilled. That is our estimate anchored to the OOIDA figures above — not a published number.

**Card 2 — The cash-cycle tax** *(F-1 pain 2; owner/GM)*
- `[S2.8]` Your invoice cannot leave before the POD does.
- `[S2.9]` So the POD rides in the cab, the biller keys it days later, and you either wait out your terms or sell the invoice at 2–3.5% to get your own money sooner. *(factoring range: FreightWaves Checkpoint, 2026)*
- `[S2.10]` Your terms and your factoring rate are numbers you know by heart. Put them in and see the year. →

**Card 3 — The back office that eats the margin** *(F-1 pain 3; bookkeeper)*
- `[S2.11]` More than a third of trucking employees never touch a truck. The industry runs about 8.2 drivers per office manager, down from 11.3. *(BLS data via FreightWaves)*
- `[S2.12]` Truckload operating margin averaged −2.3%. *(ATRI, 2024)*
- `[S2.13]` Most of that back-office labor is re-typing something that already physically happened.
- `[S2.14]` **`our estimate` tag:** We price the admin handling of a load at $25–60. That is our arithmetic from staffing ratios and document-handling costs, not a single published figure.

**The honesty valve** *(A-3 §output, non-negotiable copy):*
- `[S2.15]` SHUDDL is built to recover the evidence half of this — the disputes you lose because nobody can prove what happened. It does not make your customers pay faster by itself.

> **Sourcing note for the implementer (this changes A-3's constants on a public page):** A-3's DSO (~47 days), receivables-float (~$900K per 10 trucks) and 2.8%-factoring constants trace only to **vendor blogs** in the raw fact sheet (flagged ⚠️ there). A-1's naming rule: *"Where a figure's only available source is a vendor's own blog, prefer omitting the figure over citing the vendor."* Therefore: **do not print an industry DSO or a $900K float as a cited fact on this page.** Use the reader's own inputs for both. The factoring *range* may be cited to FreightWaves Checkpoint (a trade outlet, allowed as a citation). Sources with URLs live in [raw/value-anchors-fact-sheet.md](../research/2026-08-01-coordination-layer/raw/value-anchors-fact-sheet.md) rows 10, 12, 16–19, 22, 59; every footnote on the page renders name + year + link.

### S3 — How it works, in three steps

*Serves: A-1 the 100-word pitch · F-1 pains 1 and 3 · ops manager + driver + bookkeeper.*

- `[S3.1]` **H2:** Three steps. And no cutover day.

**Step 1 — The stop cannot advance without proof.**
- `[S3.2]` The driver gets one question and one button per stop: arrive, count, photograph, sign. If the evidence that stop requires isn't there, the stop does not advance — and that rule runs on our server, not inside the app, so there is no way around it from a phone.
- `[S3.3]` It works with no signal. In our offline test, two devices captured 55 signed events with the network off and lost none of them.

**Step 2 — The record seals itself.**
- `[S3.4]` Every event is appended, never edited. It is co-signed by the device that captured it, hash-chained to the event before it, and timestamped against an independent RFC-3161 authority. A correction is a new event, so the original never quietly disappears.

**Step 3 — The money is a projection of the physics.**
- `[S3.5]` The delivery event issues the invoice and sends the evidence with it — the same event, not a nightly batch. The journal export for your books comes out of the same ledger entry, so there is nothing to reconcile between the invoice and the books.
- `[S3.6]` **Staging label (adjacent to the figure, not a footnote):** On staging we ran this end to end — signature, then a penny-exact invoice of 55,800¢, then a real email carrying the evidence. Staging environment, synthetic freight, our own infrastructure. There is no production freight yet.

**And no cutover day.**
- `[S3.7]` Nothing flips on day one. We mirror your existing system, then run 30 days in shadow — our numbers beside yours, aggregate inside ±2%, invoices matching to the penny — and only after two consecutive clean closes does anything with money authority change hands. Start to finish that is 14 to 20 weeks, and it does not compress.
- `[S3.8]` That is the part a vendor usually buries. We lead with it, because a carrier surprised by it in month three is a refund.

### S4 — The Founding Carrier offer

*Serves: A-1 "built and running… entering Founding Carrier pilots" · C-3 in full · F-1 owner/GM.*

- `[S4.1]` **H2:** Eight Founding Carrier slots.
- `[S4.2]` We are taking exactly eight carriers through the first onboarding calendar. Each one runs 14 to 20 weeks, and they run in sequence — so the order carriers join is the order they go live.

**What a Founding Carrier locks** *(C-3 §The offer, 1–5):*
- `[S4.3]` A founding price, locked for 24 months.
- `[S4.4]` Onboarding priority. Founding order is slot order; there is no way to buy ahead of it later.
- `[S4.5]` White-glove migration. The legacy export mapping, the driver roster, the tariffs — we do that work with you. It is not a service we sell you.
- `[S4.6]` A direct line to the founder through the pilot. Your pains order the queue of what gets built next.
- `[S4.7]` Anonymity by default. No logo, no case study, no name anywhere — not on this page, not in a press kit — without your separate written consent.

**Price shape** *(C-3 §Pricing hypothesis):*
- `[S4.8]` Flat, per-operation pricing. Never per seat, ever — a system that charges you for adding a dispatcher is a system that wants you to stay slow.
- `[S4.9]` Founding lock, 24 months: **10–25 trucks $1,950/mo · 26–60 trucks $3,900/mo · 61–100 trucks (or a hybrid with a brokerage arm over $5M gross) $5,900/mo.**

> **Owner decision required before ship — publish or withhold `[S4.9]`.** C-3 calls these hypotheses to be tested in founder calls, and it also publishes a *list* column. **Spec default: publish the founding column only; never publish the list column.** Reason: an unlaunched list price shown next to a founding price is a discount claim we cannot substantiate, and it anchors a number we have never charged. Publishing the founding column is defensible — it is what a deposit buys, and a carrier should know it before spending 30 minutes on a call. If the owner prefers to hold price to the call, replace `[S4.9]` with: *"Founding pricing is a flat monthly figure by fleet band, locked for 24 months. We'll give you your band's number on the call — before you're asked for anything."*

**The deposit block — PRE-COUNSEL state (this is what ships today):**
- `[S4.10]` **H3:** How a slot gets reserved — and why you can't reserve one this minute.
- `[S4.11]` A slot is eventually held with a $2,500 deposit. It is fully refundable on request any time before your onboarding begins, it auto-refunds if we haven't offered you a go-live slot within 12 months, and it credits in full against your first invoice — so for a carrier that proceeds, it costs nothing.
- `[S4.12]` **We are not taking deposits yet.** Our deposit terms are with counsel and are not published. We are not going to take your money against terms you can't read first. When the terms are published, this section will carry the link and the button — and not before.
- `[S4.13]` Today there is exactly one thing to do, and it costs nothing: take the call.
- `[S4.14]` **CTA:** Take the founder call →

**The deposit block — POST-COUNSEL state (rendered only when the gate in §3.4 opens):**
- `[S4.15]` **H3:** Reserve a slot.
- `[S4.16]` $2,500, fully refundable, credited in full against your first invoice. Read the terms first — they are one page and they are linked here, above the button, on purpose.
- `[S4.17]` **CTA:** Read the terms, then reserve a slot — $2,500, refundable →
- `[S4.18]` Refunds are as easy as the deposit: email or say so on a call, and it is returned in full. No form, no window to miss.
- `[S4.19]` Slots reserved: **N of 8.** *(Renders only from cleared Stripe deposits per C-1 §5. If that number cannot be read from the source of truth, the line is omitted entirely — a scarcity counter that isn't measured is a lie.)*

### S5 — What we are not claiming

*Serves: A-1's Hard-don'ts firewall, converted from a constraint into the page's strongest asset · F-1 owner/GM (the "is this vaporware" objection).*

- `[S5.1]` **H2:** What we are not claiming.
- `[S5.2]` Every vendor's site tells you what its software does. This is the part you normally find out in month two.
- `[S5.3]` **No carrier runs on SHUDDL today.** Zero tenants, zero live freight. It is built and running on our own infrastructure; Founding Carriers are the first production tenants.
- `[S5.4]` **Every timing figure here was measured on staging, with synthetic freight.** None of it is a production measurement, because there is no production freight to measure yet.
- `[S5.5]` **Driver sign-in isn't finished.** The driver flow — the gates, the capture, the offline sync — is built and tested. The login and lockout path is on the short list of work in front of the first pilot.
- `[S5.6]` **Public signup is closed.** It stays closed until counsel has signed off on terms, privacy, and a data-processing agreement. It isn't "coming soon" — it is not legally open, and we won't pretend otherwise.
- `[S5.7]` **EDI runs in the lab, not on the wire.** The X12 core is written and tested; no live VAN, AS2 or SFTP connection is stood up yet.
- `[S5.8]` **Booking through an assistant is built and gated, but has never been run end to end in one piece.** The safety shape is real — a model cannot authorize money by itself — and we are not going to call an untested path a feature.
- `[S5.9]` **Some of our own tests can't run yet.** Several of our merge gates are blocked because they need real carrier data we don't have. We would rather tell you they're blocked than feed them invented numbers to make a dashboard green.
- `[S5.10]` **We are not going to tell you that artificial intelligence runs your company.** Software runs the protocol. Your people own the exceptions and the relationships. If a vendor's pitch is the model, ask them what happens when it's wrong about money.
- `[S5.11]` If any line on this page turns out to be less true than it reads, we want to hear about it from you before you hear about it from us.

### S6 — FAQ

*Serves: the bounded promises of all four A-1 hierarchy rows · the whole F-1 buying committee.*

- `[S6.1]` **Q: Are carriers using this today?**
  A: No. Zero tenants, zero live freight. It is built and running on our own infrastructure; entering Founding Carrier pilots. Founding Carriers are the first production tenants, and we'd rather say that plainly than have you discover it.
- `[S6.2]` **Q: What actually happens when my driver gets a signature?**
  A: The stop's gate checks that the required evidence exists — piece count, photos, signature. The event is appended to a ledger that cannot be edited, co-signed by the device, hash-chained, and timestamped against an independent authority. The same event issues the invoice and sends your customer the evidence with it.
- `[S6.3]` **Q: Do I have to leave my TMS?**
  A: Not on day one, and not on any single day. We mirror it, shadow it for 30 days with both sets of numbers side by side, then take authority one function at a time — rating, then invoicing, then dispatch, then settlement — each behind a gate, with fallback. The parity bars are aggregate ±2%, per route ±10%, invoices to the penny, and two consecutive clean closes before anything touching money changes hands.
- `[S6.4]` **Q: How long does that take?**
  A: 14 to 20 weeks. It does not compress, and we won't pretend it does to close you faster. The length is the safety.
- `[S6.5]` **Q: What does it cost?**
  A: A flat monthly figure by fleet band, locked for 24 months for Founding Carriers. Never per seat. *(If `[S4.9]` publishes, add: "The founding numbers are on this page — 10–25 trucks $1,950/mo, 26–60 $3,900/mo, 61–100 $5,900/mo.")*
- `[S6.6]` **Q: What's the deposit, and can I get it back?**
  A: $2,500, fully refundable on request any time before your onboarding begins, auto-refunded if we haven't offered you a go-live slot within 12 months, and credited in full against your first invoice. **And we are not taking it yet** — the terms are with counsel and unpublished. No deposit is charged before counsel-approved terms are published. Today the only ask is a call.
- `[S6.7]` **Q: Will you use my name in your marketing?**
  A: No. Anonymity is the default, in writing: no logo, no case study, no name, anywhere, without your separate written consent. We hold ourselves to that in our own repository — it is a lint rule, not a policy page.
- `[S6.8]` **Q: My drivers hate apps. What are you putting on their phone?**
  A: A web app. No app-store install, no account to create in a parking lot, one question and one button per stop. It captures with the network off and syncs when the phone comes back — in our test, 55 signed events across two devices with no signal, none lost. Note the honest part: driver sign-in is still being finished. See what we are not claiming, above.
- `[S6.9]` **Q: What happens to my data if this doesn't work out?**
  A: Your operating record is append-only and yours; export in open formats is part of the Founding Carrier terms. We are deliberately not describing the export more precisely than counsel has written it — when the terms publish, the exact scope will be in them, and you should read that rather than this sentence.
- `[S6.10]` **Q: Why should I believe any of this?**
  A: Partly because of what we refuse to claim — the section above this one is the shortest honest audit of our own product we could write. Partly because the deposit is refundable and the shadow period is designed so that you see our numbers next to yours for 30 days before anything you care about depends on ours. And partly because you can check every industry figure on this page against its source; the links are right there.

### S7 — Is this built for you?

See §4 for the mechanism. Copy:

- `[S7.1]` **H2:** Is this built for you? Here's the honest answer.
- `[S7.2]` **Column 1 — Yes, now.** A US regional carrier, 10 to 100 power units, running OTR or regional freight — dry van, reefer, flatbed — with a brokerage arm or building one. You have at least one office person per eight or so drivers, you lose detention arguments monthly, or you're chasing PODs yourself. And you're willing to run us in parallel with your current system for 30 days.
  **CTA:** Take the founder call →
- `[S7.3]` **Column 2 — Not yet.** Under 10 trucks. There isn't enough back office there for us to save you real money yet, and we're not going to take a deposit for a benefit you wouldn't feel. The driver side of this is built for you — the smaller-fleet version isn't. Leave an email and we'll tell you when it's real, and not before.
  **CTA:** Tell me when it fits *(email only — no call link, no deposit path)*
- `[S7.4]` **Column 3 — Not us.** Over 100 trucks or an enterprise brokerage: wrong motion, wrong sales cycle, and you'd be buying a first pilot slot at a company with eight of them. Ocean, air, parcel, or warehouse: not what this is. Anyone shopping seat-based pricing: we don't sell it and won't. We'd rather say so in ten seconds than take your quarter.
  **CTA:** none. A plain line: If you think we're wrong about that, write to us — we'd rather be corrected than polite. *(→ contact address; blocked on owner supplying it, see §7)*

### S8 — CTA + form

- `[S8.1]` **H2:** Take the founder call.
- `[S8.2]` Thirty minutes, with the person who built it. Bring your own numbers — trucks, stops a week, days to get paid, what you pay a factor — and we'll walk your operation through it instead of running a demo at you.
- `[S8.3]` If you're not a fit, we'll say so on the call rather than after it. That's not modesty; there are eight slots and a wrong one costs us more than it costs you.
- `[S8.4]` **Button:** Request the call →
- `[S8.5]` **Under the button:** A human replies, usually within one business day. No sequence, no drip, no dialer.
- `[S8.6]` **Under the form:** Built and running on our own infrastructure; entering Founding Carrier pilots.

---

## 3. Form and CTA design

### 3.1 Fields

One form component, rendered at `#call` and referenced by every CTA on the page (hero anchors down to it; there is no second form to keep in sync).

| # | Field | Type | Required | Purpose |
|---|---|---|---|---|
| 1 | Email | email | ✅ | Identity + the KV key (existing behavior: `wl:<email>` is the natural idempotent upsert) |
| 2 | Company | text ≤120 | — | CRM row title. Company-level only. |
| 3 | Power units | select: `1-9` / `10-25` / `26-60` / `61-100` / `100+` | ✅ | F-5 `Fleet Band` → Founding ACV; half the ICP gate |
| 4 | What you run | select: CARRIER / BROKER / SHIPPER / DRIVER / DEVELOPER / OTHER | ✅ | Existing `SEGMENTS` enum (`worker/validate.js:1`) — do not invent new values |
| 5 | Which hurts most today | radio: DETENTION / CASH / BACKOFFICE | ✅ | F-5 `Pain Signal` — the message-market-fit instrument |
| 6 | Could you run us beside your current system for 30 days? | radio: YES / NO / UNSURE | ✅ | F-1 disqualifier #3, made mechanical |
| 7 | Anything you want us to know | textarea ≤500 | — | F-5 `Notes` |
| 8 | `hp_check` | honeypot | — | **Keep exactly as-is** (`validate.js:8-11`) — bots fill it, the worker answers 200 so they learn nothing |
| 9 | `source`, `utm_source`, `utm_medium`, `utm_campaign` | hidden | — | F-5 `Source` attribution — the wiring row F-5 lists as blocked *on this document* |
| 10 | `calc` | hidden, ≤256 | — | A-3 calculator inputs when the visitor arrives from it, so the call opens on their numbers |

No phone field. No "company size" free text. No consent checkbox theater — one plain line under the button instead: `[S8.5]`.

### 3.2 What happens on submit

1. **Client:** validate, disable the button, set the `aria-live` status to "Sending…", `POST` JSON to `/api/waitlist`.
2. **Worker** (existing pipeline in `worker/index.js:10-73`, unchanged in shape): origin check → 4KB body cap → JSON parse → `parseSignup` → honeypot short-circuit (200, store nothing) → merge-upsert into `WAITLIST_KV` preserving the earliest `source` and any previously captured fields.
3. **Worker computes the ICP gate server-side** from `fleet` + `segment` + `parallel` and stores it. The client's branch display is presentation only; the gate that governs outreach is never client-supplied.
4. **200 →** the form is replaced by the branch-specific confirmation from §4 — never a generic "thanks." A disqualified visitor sees their honest answer immediately, not a booking link.
5. **4xx/5xx →** an in-place error naming the fix ("that email address didn't parse", "we couldn't save that — mail us at <address> and we'll do it by hand"). Never a silent failure and never a fake success.
6. **No automated email is sent.** The mission-control guardrail is "0 unapproved outbound"; an auto-acknowledgment needs owner-approved copy first (§7, item 9). Until then `[S8.5]` is the promise and a human keeps it.

### 3.3 Endpoint deltas (marketing repo — not this one)

`parseSignup` already ignores unknown keys, so **a v2 page deployed against the current worker still captures email/segment/fleet/source and merely drops the new fields.** That makes the page shippable before the worker change lands, and makes the worker change safe to deploy first. Add, all optional, all `clampOptional`-style:

| Key | Validation | Maps to |
|---|---|---|
| `company` | string ≤120 | F-5 row title |
| `pain` | enum `DETENTION` \| `CASH` \| `BACKOFFICE` | F-5 `Pain Signal` |
| `parallel` | enum `YES` \| `NO` \| `UNSURE` | ICP gate + `Notes` |
| `note` | string ≤500 | F-5 `Notes` |
| `utm_source`,`utm_medium`,`utm_campaign` | string ≤64 each | F-5 `Source` |
| `calc` | string ≤256 | F-5 `Notes` |
| *(derived, server-side)* `icp_gate` | `Pass` \| `Fail-Size` \| `Fail-Segment` \| `Fail-Parallel` | F-5 `ICP Gate` |

Raise the body cap from 4096 to 8192 bytes to fit `note` + `calc` and keep the two-place check (`content-length` **and** raw length) that `index.js:26-38` already does. Extend `tests/validate.test.mjs` with a rejection case per new field, plus one asserting an **unknown** key is still ignored (that's the forward-compat contract this spec leans on).

### 3.4 The deposit gate — the rule, stated as a build constraint

> **RULE A4-DEPOSIT-GATE.** While F-3 is open, no element that initiates or implies payment may exist **in the built artifact**. Not a Stripe link, not a "Reserve my slot" button, not a price with a button next to it, not a checkout embed, not a disabled button with a tooltip. Not hidden by CSS, not gated by a client-side flag — **absent from the bundle.**

Implementation:
- The deposit partial is included at build time only when `FOUNDING_TERMS_URL` is set to a real, published, counsel-approved terms URL. Unset → S4 renders the pre-counsel block `[S4.10]`–`[S4.14]`.
- A CI check greps the built `public/` output for `stripe`, `buy.stripe.com`, `checkout`, `reserve my slot`, `pay deposit` and fails the build if any appears while `FOUNDING_TERMS_URL` is unset. (Pattern: the repo's own shared-matcher discipline — one matcher, used by both the build check and the test.)
- The gate opens only when **both** C-1 conditions hold: (a) counsel has approved the refundable-deposit terms and the ToS/Privacy/DPA set (REQ-138), **and** (b) the owner has approved the published terms page. Either one missing = the flag stays unset.
- When it opens, the button must: name the amount, say "refundable" in the button text itself, sit **below** the terms link (`[S4.16]`–`[S4.17]`), and have the refund path within one scroll (`[S4.18]`).
- The slot counter `[S4.19]` renders only from cleared deposits per C-1 §5. It never counts signups. If the number can't be read, the line is omitted.
- Stripe live-mode keys never enter any repo (C-1) — the marketing worker's secret store only.

### 3.5 Where a submission lands (F-5 mapping)

| Form field / derived | KV record key | F-5 pipeline field | Rule |
|---|---|---|---|
| email | `email` | *(person-level — CRM only, never git; REQ-289/167)* | The KV key; idempotent upsert |
| company | `company` | Company (row title) | Company-level data is the only kind allowed in `docs/gtm/` |
| power units | `fleet` | **Fleet Band** → Founding ACV | `10-25` → $23,400 · `26-60` → $46,800 · `61-100` → $70,800 (F-5 rule 2). `1-9` and `100+` → ACV $0 |
| segment + fleet + parallel | `icp_gate` (derived) | **ICP Gate** | `Pass` · `Fail-Size` (<10 or >100) · `Fail-Segment` (SHIPPER/DRIVER/DEVELOPER/OTHER) · `Fail-Parallel` (`parallel = NO`). **Must be scored before Stage 2** (F-5 field discipline) — computing it at submit satisfies that structurally |
| pain | `pain` | **Pain Signal** | The A/B/C promotion decision comes from this column |
| utm_source | `utm_source` | **Source** | `waitlist` (direct/organic) · `outbound` · `content` (incl. the A-3 calculator) · `press` · `referral`. Anything unrecognized → `waitlist`, never blank |
| note + calc | `note`, `calc` | Notes | Calculator inputs make the founder call open on the visitor's own numbers (A-3 §result page) |
| *(implicit)* | `created_at` | **Stage 2 Contacted** | F-5: an inbound waitlist signup enters at Stage 2. A `Fail-*` row is created at **X Disqualified** with the reason in Notes and receives no outreach |

**Wiring status:** KV → Notion is **not wired** and is blocked on the Cloudflare account split (F-5 §wiring). Interim: the owner lists KV keys and the loop transcribes rows by hand — correct at this volume, and it keeps the schema honest before automation hardens it. This document closes F-5's fourth wiring row ("UTM attribution → Source — blocked on A-4 landing v2") on the spec side; the code side ships with the page.

---

## 4. ICP self-selection

Two layers, because a visitor with JavaScript off must still get the honest answer.

**Layer 1 — static, always rendered (S7).** The three columns in `[S7.2]`–`[S7.4]` are plain HTML. A reader who never touches the form can self-disqualify in ten seconds. This is the floor and it is not JavaScript-dependent.

**Layer 2 — the form branch.** Selecting power units and segment changes what the visitor gets on submit. The server recomputes the gate; the client only decides what to display.

| Condition | Confirmation shown | CTA offered | F-5 outcome |
|---|---|---|---|
| Fleet `10-25`/`26-60`/`61-100` + CARRIER or BROKER + parallel `YES`/`UNSURE` | "You're who this is built for. The founder replies within one business day — bring your numbers." | Calendar link *(blocked, §7 item 11 — until then, "we'll reply to book it")* | Stage 2, ICP Gate `Pass`, band + ACV set |
| Fleet `1-9` | "Honestly: not yet. Under ten trucks there isn't enough back office for us to save you real money, and we're not taking a deposit for a benefit you wouldn't feel. We've kept your email and we'll write when the smaller-fleet version is real — that's the whole message." | **None.** No call, no deposit path, ever | X Disqualified, `Fail-Size`, ACV $0 |
| Fleet `100+` | "You're past us. Over a hundred trucks is a different motion and a different sales cycle, and you'd be buying a first pilot slot at a company that has eight of them. If you want to talk anyway, write to us directly — but we won't chase you." | Plain email address only | X Disqualified, `Fail-Size`, ACV $0 |
| Segment SHIPPER | "We build for the carrier side. If your carrier runs on SHUDDL you'll get the evidence and the tracking link without doing anything — that's the whole design. Nothing for you to buy here yet." | None | X Disqualified, `Fail-Segment` |
| Segment DRIVER | "The driver side is built for you and it's free to you — but your carrier has to bring you. If you want us in front of them, forward this page. If you want to tell us what every other app got wrong, the box above is the right place." | None | X Disqualified, `Fail-Segment` |
| Segment DEVELOPER / OTHER | "Nothing to sign up for. Public signup is closed until counsel clears the terms — that's stated on the page and it's not a soft close." | None | X Disqualified, `Fail-Segment` |
| `parallel = NO` (any fleet) | "Then we're not a fit, and that's a real answer rather than a soft one. The 30-day parallel run is the only thing that proves our numbers match yours before money moves. Without it we'd be asking you to trust a claim, which is exactly what this page refuses to do. If that changes, come back." | None | X Disqualified, `Fail-Parallel`, reason in Notes |

**Rule:** a `Fail-*` row never sees a deposit path, a calendar link, or an outbound sequence — F-5's field discipline says a `Fail-*` value blocks outreach, and C-1's first risk row says a deposit from an out-of-ICP fleet is "a refund and a bad reference waiting to happen."

---

## 5. SEO and metadata

Written to A-1's naming rule: no company as a **subject** anywhere in the metadata; no platform/network/coordination-layer language; no "AI"; no figure that isn't an offer fact.

```
<title>SHUDDL — Invoice at the signature. Proof attached.</title>              (50 chars)

<meta name="description" content="A freight operating system for US regional
carriers, 10–100 trucks: the signature at the door seals the proof and issues
the invoice. Eight Founding Carrier slots.">                                   (~152 chars)

<link rel="canonical" href="https://shuddl.tech/">
<meta name="robots" content="index,follow">

<meta property="og:type"        content="website">
<meta property="og:url"         content="https://shuddl.tech/">
<meta property="og:title"       content="Signed. Invoiced. Same second.">
<meta property="og:description" content="Built and running on our own
infrastructure; entering Founding Carrier pilots. Eight Founding Carrier slots
for US regional carriers, 10–100 trucks.">
<meta property="og:image"       content="https://shuddl.tech/og.png">   (1200×630)
<meta property="og:image:alt"   content="SHUDDL — signed, invoiced, same second.">
<meta name="twitter:card"       content="summary_large_image">
```

- **OG image:** typographic only — the wordmark and `[S1.2]` on the greige field, one coral rule. **If any product pixel ever appears in it, the `STAGING · SYNTHETIC DATA · NO CUSTOMER FREIGHT` lockup is baked into the image file** (A-2 §3), because a shared card carries no caption.
- **Structured data:** `Organization` (name, url, logo, one contact email) and `FAQPage` mirroring S6 **verbatim** — the visible answer and the schema answer must be the same string. **Nothing else.** Explicitly no `Product`, `Offer`, `AggregateRating`, or `Review`: we have no customers to rate, and emitting an `Offer` while F-3 is open is a payment implication that violates RULE A4-DEPOSIT-GATE.
- `sitemap.xml` + `robots.txt` (allow all; no staging host indexed — staging and preview hosts get `noindex` and a `X-Robots-Tag`).
- `lang="en"`, one `<h1>`, headings in document order (see §6).
- **Identity sweep before publish:** grep the built page for tenant/person/customer/incumbent-vendor names (REQ-167). Note that the automated `identity-leak` gate is currently **unrunnable** — doc 01 §3 records `IDENTITY_DENYLIST` as unbound — so this sweep is manual and must be recorded in the build log. The incumbent-TMS and enterprise-visibility-vendor shorthands used internally in F-1 must never reach the public page — the page says "your legacy TMS" and "an enterprise brokerage", never a brand.

---

## 6. Accessibility and mobile — this gets opened in a truck stop

The reader is standing in daylight, on a phone, with one hand, on a bad connection, possibly at 4:50am. Every requirement below follows from that sentence.

**Performance budget (the real accessibility requirement)**
- Critical path ≤120KB: HTML + inlined critical CSS + two subset woff2 faces (already preloaded, `font-display: swap`). Hero text and the form must render from that payload alone.
- **The Mapbox bundle (~1.4MB) never blocks anything.** Load it only when *all* hold: viewport ≥1024px, `prefers-reduced-motion: no-preference`, `navigator.connection.saveData !== true`, and `effectiveType` is not `2g`/`slow-2g`. On a phone the map is simply absent — it is decoration, and decoration does not get to cost a truck-stop visitor their data plan.
- Targets: LCP ≤2.5s and interactive form on Slow 4G / mid-tier Android. Verify with a throttled trace, not a hunch.

**Touch and layout**
- Every interactive target ≥44×44 CSS px with ≥8px separation. The primary CTA sits in the bottom-third thumb zone on mobile, not stranded at the top.
- Form inputs at **16px minimum** — below that iOS Safari zooms on focus and the layout jumps under the reader's thumb. This overrides the 12px mono body for inputs specifically.
- Single-column below 720px. No horizontal scroll at 320px. The price band table (`[S4.9]`) becomes stacked rows on mobile, not a scrolling table.

**Legibility**
- Uppercase mono is the house style and it stays for labels, kickers and short lines. **Long-form body copy on ≤480px viewports renders at ≥14px with measure capped at ~40 characters**, because uppercase at 12px in daylight is a squint, and the person squinting is the buyer. If the design audit and this requirement collide, raise it to the owner — do not silently deviate from `genesis/07`.
- Contrast: every text/background token pair meets WCAG 2.2 AA (4.5:1 body, 3:1 large). `--signal-deep` is **tuned by the contrast test, not by eye** (CLAUDE.md rule 7). Support `prefers-contrast: more`.
- Never signal state with the coral alone — errors and required fields carry text, not just color.

**Semantics and assistive tech**
- One `<h1>` (`[S1.2]`); `<h2>` per section in order; no level skips. Keep the existing skip link, retargeted to `#call`.
- Every input has a real `<label>`; errors are tied via `aria-describedby`; the submit status stays a `role="status" aria-live="polite"` region (v1 already does this — keep it).
- Full keyboard operability with a visible focus ring that survives the dark-surface inversion. Radio groups in a `<fieldset>` with a `<legend>`.
- `prefers-reduced-motion: reduce` disables reveals, the scroll rail, the ticker and the map entirely — content renders in its final state. **No content may be reachable only through motion or scroll-triggered reveal.**
- JS off: all copy, the three ICP columns, and the form fields render. Best-effort: the worker answers a form-encoded POST with a `303` to `/thanks` so a no-JS submission still lands (nice-to-have; the static S7 columns are the required floor).

**Practical extras**
- Print/PDF stylesheet — carriers forward this to a partner or a banker (same requirement A-3 sets for the calculator).
- `tel:`/`mailto:` links are real links.
- A form submission that fails offline keeps the typed values on retry. Nobody re-types anything is the pitch; the form had better honor it.

**Ship-blocking verification matrix:** 360×640 Android Chrome · 375×667 iPhone SE · 390×844 iOS Safari · 1280 desktop · keyboard-only pass · VoiceOver pass on the form · Slow-4G throttled trace · **one real read on a phone, outdoors, in sunlight, by a human, before ship.** The last one is not a formality; it is the only test that matches the reader.

---

## 7. Build checklist

Ordered so an implementer can start at the top. **B** = blocked, with the owner of the block.

| # | Item | State | Blocked on |
|---|---|---|---|
| 1 | Delete every v1 claim in §0's table | Ready | — (merge blocker for v2) |
| 2 | Add the `STAGING · SYNTHETIC DATA · NO CUSTOMER FREIGHT` lockup to the map/demo chrome, persistently visible | Ready | — (A-2 §3; required by A-1 don't #4) |
| 3 | Remove the "Founding 50" counter and stop calling `/api/founding-count` from the page | Ready | — |
| 4 | Build S1–S8 with the copy in §2 exactly as written | Ready | — |
| 5 | Footnote component: name + year + link per figure; `our estimate` variant in a distinct weight (A-3 §claims firewall) | Ready | — |
| 6 | Form per §3.1 + branch confirmations per §4 | Ready | — |
| 7 | Worker deltas per §3.3 + tests (incl. the unknown-key-ignored compat test) | Ready | — (deploy worker **before** page; page degrades safely against the old worker) |
| 8 | UTM capture → `Source` per §3.5 | Ready | — (closes the F-5 wiring row on the spec side) |
| 9 | Auto-acknowledgment email | **B** | **Owner** — "0 unapproved outbound" guardrail; needs approved copy. Default until then: no auto-email |
| 10 | Founder-call calendar link | **B** | **Owner** — no booking link exists; until then the confirmation says "we'll reply to book it" |
| 11 | Named human + contact address on the page (S7 col 3, S5.11, C-1 terms requirement) | **B** | **Owner** — same item that holds P-1 (bio/contact) |
| 12 | Publish or withhold the founding price table `[S4.9]` | **B** | **Owner decision** — spec default: publish the founding column, never the list column |
| 13 | One owner read of the copy before it goes public | **B** | **Owner** — A-1 is DRAFT v1: "copy ships to public surfaces only after one owner read" |
| 14 | Deposit CTA `[S4.15]`–`[S4.19]` + `FOUNDING_TERMS_URL` + the CI grep | **B** | **F-3 counsel terms, then owner approval of the published terms page.** Both, per C-1's hard gate. The CI grep itself is buildable now |
| 15 | Link `[S1.8]`/`[S2.10]` to the A-3 calculator | **B** | A-3 build, itself blocked on the Cloudflare account split |
| 16 | Deploy to `shuddl.tech` | **B** | **Owner** — F-4c account split; the zone is in the other Cloudflare account |
| 17 | KV → Notion pipeline rows | **B** | **Owner** — same account split (F-5 wiring). Interim: manual transcription |
| 18 | a11y + perf verification matrix (§6), including the outdoor phone read | Ready | — (ship blocker) |
| 19 | Manual identity sweep of the built page (REQ-167) | Ready | — (the automated gate is unrunnable: `IDENTITY_DENYLIST` unbound, doc 01 §3 — record the manual sweep in the build log) |

**Nothing on this list requires a change to `packages/`, `workers/`, `apps/`, `db/`, `tools/`, `fixtures/` or `tests/`.** Items 6–8 land in the marketing repo only.

---

## 8. Claims audit

### 8a. Every copy line vs. A-1's Hard don'ts

Don'ts, numbered as in A-1 §Hard don'ts: **①** no "customers are using"; **②** no tenant/person/customer/incumbent-vendor name, no implied endorsement; **③** no AI-as-lead; **④** no `<5s`/timing as production fact; **⑤** no platform/network/coordination-layer language.

| Lines | ① | ② | ③ | ④ | ⑤ | Note |
|---|---|---|---|---|---|---|
| S1.1–S1.2, S1.6–S1.8 | ✅ | ✅ | ✅ | ✅ | ✅ | "Freight operating system" is A-1's own term; the banned words are platform/network/coordination-layer |
| S1.3, S1.3b, S1.3c | ✅ | ✅ | ✅ | ✅ | ✅ | "your customer" = the carrier's customer. No timing number appears |
| S1.4 | ✅ | ✅ | ✅ | ✅ **(this line is the ④ control)** | ✅ | Labels every timing figure staging-measured, at hero weight |
| S1.5 | ✅ **(verbatim permitted form)** | ✅ | ✅ | ✅ | ✅ | |
| S2.1–S2.2, S2.6, S2.8, S2.13 | ✅ | ✅ | ✅ | ✅ | ✅ | Arguments, no capability or customer claim |
| S2.3–S2.5, S2.9, S2.11–S2.12 | ✅ | ✅ | ✅ | ✅ | ✅ | ② **allowed** — ATRI / OOIDA / BLS / FreightWaves are research bodies and publications cited as **sources**, exactly the corrected naming rule. No vendor blog cited; DSO and float figures deliberately omitted (see §2 sourcing note) |
| S2.7, S2.14 | ✅ | ✅ | ✅ | ✅ | ✅ | Both tagged `our estimate`, per A-3 |
| S2.15 | ✅ | ✅ | ✅ | ✅ | ✅ | A-3's mandated honesty valve |
| S3.1–S3.5, S3.7–S3.8 | ✅ | ✅ | ✅ | ✅ | ✅ | Mechanism described with no timing number; automation described as *how*, never as *what* — the word "agent" and the word "AI" appear nowhere in S1–S4 |
| S3.6 | ✅ | ✅ | ✅ | ✅ **(labeled on the line: "staging… synthetic freight… no production freight yet")** | ✅ | 55,800¢ is the doc-01/A-2 staging figure, carried with its label |
| S4.1–S4.9 | ✅ | ✅ | ✅ | ✅ | ✅ | Offer terms from C-3; no customer implied by "eight slots" |
| S4.10–S4.14 | ✅ | ✅ | ✅ | ✅ | ✅ | States the counsel gate in the copy itself |
| S4.15–S4.19 | ✅ | ✅ | ✅ | ✅ | ✅ | Gated build-time; `[S4.19]` may render only from measured cleared deposits |
| S5.3–S5.11 | ✅ **(S5.3 is the ① statement)** | ✅ | ✅ **(S5.10 is an explicit anti-AI-washing line, matching A-1's "agent-washing fatigue" rationale — it names no vendor)** | ✅ **(S5.4)** | ✅ | The whole section exists to satisfy the firewall |
| S6.1–S6.10 | ✅ | ✅ | ✅ | ✅ | ✅ | S6.1 restates ①; S6.6 restates the deposit gate; S6.9 refuses to over-specify the export |
| S7.1–S7.4 | ✅ | ✅ | ✅ | ✅ | ✅ | S7.4 names *categories* (enterprise brokerage, ocean/air/parcel) — never a company |
| S8.1–S8.6 | ✅ | ✅ | ✅ | ✅ | ✅ | S8.6 repeats the permitted status sentence |
| §5 metadata | ✅ | ✅ | ✅ | ✅ | ✅ | Title/description/OG carry only offer facts (10–100 trucks, 8 slots) |

**Words that appear nowhere in the copy:** platform · coordination layer · ecosystem · AI-powered · "customers are using" · trusted by · our customers · any company name as a subject. ("Network" appears twice — `[S3.3]` and `[S6.8]`, both meaning cellular signal: "with the network off." That is the literal radio, not network-effect framing, and it is the only permitted sense on this page.)

### 8b. Every capability claim vs. research doc 01

| Line | Claim | Doc 01 backing | Verdict |
|---|---|---|---|
| S1.3, S3.5, S6.2 | Delivery event issues the invoice and sends the evidence | §5 demo 1: "**Complete**; proven on live staging (penny-exact 55,800¢, real email sent)" | ✅ built; timing labeled |
| S3.2, S6.2 | Stop cannot advance without required evidence, enforced server-side | §4: Gatekeeper "server-side, Durable-Object-enforced, observably emitting `GATE_BLOCKED` with required-evidence lists in CI" | ✅ built |
| S3.3, S6.8 | Offline capture, 55 signed events, 2 devices, zero loss | §5 demo 3: "Complete incl. offline soak (55 signed events, 2 devices, zero loss)" | ✅ built (test record) |
| S3.4, S6.2 | Append-only, co-signed, hash-chained, RFC-3161 anchored, corrections are new events | §4: "canonical hashing, chain verification, Merkle + RFC-3161 anchoring… 35/35 event kinds" | ✅ built |
| S3.5 | Journal export comes out of the same ledger | §4: "8 projections, GL/IIF export" | ✅ built. **Deliberately not claimed:** "reconciles to the penny against your legacy export" — the parity fixtures are BLOCKED (§3) |
| S3.7, S6.3, S6.4 | Mirror → 30-day shadow ±2% → two clean closes → 14–20 weeks | §6 EXTERNAL: "mirror → 30-day revenue shadow ±2% → two consecutive clean closes → pilot <0.5% exceptions → parallel — 14–20 weeks, non-compressible" | ✅ backed |
| S4.5 | White-glove migration of legacy export, roster, tariffs | §4: Migrator among the 9 substantially-real agents | ✅ built |
| S6.8 | Web app, no app-store install | §4: "Driver PWA 25 + driver-core offline sync", deployed | ✅ built |
| S5.5 | Driver sign-in unfinished | §5 demo 3: "**Code: driver login/lockout (REQ-069) is unbuilt** — a driver cannot sign in" | ✅ disclosed, not claimed |
| S5.6 | Public signup closed pending counsel | §5 demo 2: "counsel: REQ-138 ToS/Privacy/DPA — *public signup legally cannot open*" | ✅ disclosed |
| S5.7 | EDI in the lab, not on the wire | §4: Translator "dark at the transport seam — full X12 core, no live VAN/AS2/SFTP" | ✅ disclosed |
| S5.8 | Assistant booking built, gated, never run end to end | §5 demo 4: "Verbs + confirm + caps tested; full DO-backed booking never exercised e2e"; §4 "the model cannot self-authorize money" | ✅ disclosed |
| S5.9 | Some gates blocked on absent private data | §3: 8 blocked gates, "every one an absent input, not a code defect" | ✅ disclosed |
| S5.3, S6.1 | Zero tenants, zero freight | §1: "Zero users, zero tenants, zero freight" | ✅ disclosed |
| — | *Interline splits from custody* | §4: Settler "interline split real, **escrow settle CONFIRM-gated**" | **Not claimed on the page.** Would need the escrow carve-out; not worth the sentence |
| — | *Quote from email in N seconds* | No measurement in doc 01 | **Not claimed** — v1 line retired |
| — | *EDI partner in a day* | Contradicted by §4 | **Not claimed** — v1 line retired |
| — | *Thirteen agents run the protocol* | §4: 9 real / 2 partial / 1 dark / 1 vNEXT | **Not claimed** — v1 grid retired |
| — | *One-click export of everything* | No doc-01 verification | **Not claimed**; S6.9 explicitly defers to the written terms |

---

## 9. Open questions for the owner

1. **Publish `[S4.9]`'s founding price table, or hold price to the call?** Spec default: publish the founding column, never the list column.
2. **Run hero cell B publicly?** It is A-1-approved copy that is adversarial to the factoring referral channel F-1 names as a watering hole. Recommend outbound-only.
3. **Auto-acknowledgment email** — approve copy, or stay with a human reply inside one business day?
4. **The contact address and the named human** for S7 column 3, S5.11, and (later) the terms page. Same unblock as P-1.
5. **A-1 owner read** — this page is the first public surface that carries A-1's copy; it cannot publish before that read.
