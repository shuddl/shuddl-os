# D-2 — Outbound Sequences (DRAFTS — nothing may send yet)
**Status:** DRAFT v1. **Sending is blocked** on: F-4b (outbound domain + 2-week warmup), F-3 (counsel), and the four legality questions in [D1-fmcsa-list-method.md](D1-fmcsa-list-method.md) §6.4. This document is copy under review, not a live campaign.
**Gates:** [F1-icp.md](F1-icp.md) · [A1-messaging.md](A1-messaging.md) (claims law + naming rule) · [C3-founding-carrier-program.md](C3-founding-carrier-program.md) (the offer) · [F5-crm-substrate.md](F5-crm-substrate.md) (where replies land)

---

## Compliance, designed into the copy rather than appended to it

CAN-SPAM has **no B2B exemption** ([D1-fmcsa-list-method.md](D1-fmcsa-list-method.md) §6, sourced from ftc.gov). Every mail below therefore carries, as part of its structure and not as boilerplate we hope nobody reads:

1. **Truthful headers and a subject that describes the actual contents.** No fake `Re:`, no manufactured familiarity, no "per our conversation" when there was none.
2. **A physical postal address** in the footer of every message.
3. **A one-click opt-out** in plain words, honored within 10 business days — in practice, immediately, by marking `X Lost / opted out` in the CRM which suppresses the address permanently.
4. **Identification as an outreach email** — the first mail says how we found them (public FMCSA registration data). Saying it plainly is both compliant and disarming; a carrier who wonders "how did you get this" and isn't told, distrusts everything after.
5. **Company mailboxes, not named officers**, on first touch — the recommendation from D-1 §6.4-A3. The FMCSA file publishes officer names; using them reads as surveillance to the recipient even where it's legal.

**Volume discipline during warmup:** 20/day week 1, 40/day week 2, then step to a steady state that the domain's reputation supports. Sequences are paused, not queued, if bounce rate exceeds 3% or spam complaints exceed 0.1%.

---

## Sequence A — Asset carrier, 10–100 trucks (the primary ICP)
**Segment:** F-1 primary; from the FMCSA method, filtered to power units 10–100, active interstate for-hire authority. **Ask:** a 20-minute call. **Not** a deposit — the deposit CTA cannot exist pre-counsel.

**A1 — Day 0 · Subject: "detention on 39% of your stops"**

> I pulled your DOT registration from the FMCSA's public file — that's how I found you, and it's the only thing I know about your operation.
>
> Here's the industry number that made me write: carriers get detained on **39.3% of stops**, and the average driver loses 117–209 hours a year to it (ATRI, 2023). At ATRI's own $90.89/hour operating cost, a 25-truck fleet is looking at roughly a third of a million dollars a year of exposure — and 18% of drivers report never being paid detention at all (OOIDA Foundation, 2023).
>
> Most of that money isn't lost because the claim is wrong. It's lost because nobody can prove what happened at the dock.
>
> We built SHUDDL so the proof creates itself: the driver's arrival, photos, signature and departure are sealed into a tamper-evident record at the moment they happen, and the invoice goes out with the evidence attached. It's built and running on our own infrastructure, and we're entering Founding Carrier pilots now — no customers yet, and I'd rather say that than imply otherwise.
>
> Worth 20 minutes? I'll walk your last 90 days of detention claims with you, and you'll get something out of the call whether or not we ever work together.

**A2 — Day 4 · Subject: "the calculator, not the pitch"** — sends the [ROI calculator](A3-roi-calculator.md); no ask beyond "run your own numbers." Three sentences maximum.

**A3 — Day 9 · Subject: "8 slots, and why the list is short"** — the Founding Carrier structure: 8 slots, sequential onboarding, a 14–20 week calendar we don't compress. Frames scarcity as *operational reality* (each onboarding is long and hands-on), never as manufactured urgency.

**A4 — Day 16 · Subject: "closing the loop"** — a genuine last email. States plainly that no further mail will come unless they reply, and means it. The suppression is automatic.

---

## Sequence B — The hybrid: carrier + brokerage authority (the bullseye)
**Segment:** the **793 accounts** holding both active carrier and broker authority ([D1-fmcsa-list-method.md](D1-fmcsa-list-method.md)). This is the highest-value segment in the entire list and deserves the most specific copy.

**B1 — Day 0 · Subject: "you run both sides — so you feel this twice"**

> You hold both carrier and broker authority, which is why I'm writing to you specifically rather than to a list.
>
> Running both sides means you eat the same failure twice: the detention you can't prove on the asset side, and the settlement you can't reconcile on the brokerage side — usually in two systems that don't agree with each other, which is why somebody on your staff re-types reality every day.
>
> SHUDDL treats the physical event as the single source of both. A signature at a door becomes the customer invoice and the carrier settlement at the same instant, from the same record, with the evidence attached to each.
>
> Built and running on our own infrastructure; entering Founding Carrier pilots. Twenty minutes?

**B2 — Day 4** — the fraud angle from [content piece 2](D3-content-02-fraud.md): vetting verifies who a carrier is on paper, not what happened at the door. Relevant to a broker who has eaten a double-brokering loss.
**B3 — Day 9** — the offer + price lock. **B4 — Day 16** — same clean close as A4.

---

## Sequence C — Inbound nurture (waitlist, calculator, content readers)
Warmer, slower, no cold-outreach framing since they came to us. C1 welcome + what we are and are not today · C2 (day 7) content piece 1 · C3 (day 14) content piece 2 · C4 (day 21) the Founding Carrier offer and a call link. Anyone who runs the calculator enters here with `Source = Content` and their band pre-filled.

---

## What must be true before any of this sends

| Blocker | Owner |
|---|---|
| Outbound domain purchased + 2-week warmup completed (F-4b) | Owner — needs Apollo full scope |
| Counsel: deposit terms + the 4 legality questions (F-3, D-1 §6.4) | Owner + counsel |
| Owner reads and approves this copy once; then sequences run standing | Owner |
| Suppression list wired to the CRM `X Lost / opted out` state | Loop, once the sending tool is chosen |
| Physical postal address confirmed for footers | Owner |

**Measurement:** reply rate and call-booked rate per sequence, tracked in [F5](F5-crm-substrate.md) by `Source = Outbound`. The `Pain Signal` field records which of the three pains actually pulled — after roughly 20 conversations that decides which A-1 variant becomes primary and which sequence gets the volume.

**A note on tone, deliberately.** Every mail above admits something: that we found them in a public file, that we have no customers, that the onboarding is long. That isn't humility as a tactic — it's the only posture available to a product with zero tenants that intends to still be credible on the day it has some. A carrier who has been sold to by twenty freight-tech vendors this year can smell the difference, and the admission is the differentiator.
