# Founder-Call Script & Qualification Rubric
**Status:** v1 for owner use · **Gates:** [F1-icp.md](F1-icp.md) (the rubric IS the gate) · [C3](C3-founding-carrier-program.md) (offer) · [C1](C1-deposit-flow.md) (deposit mechanics + counsel gate) · [A1](A1-messaging.md) (claims law applies to spoken words too) · [F5](F5-crm-substrate.md) (what gets recorded)

> **The call's job is not to sell.** With zero tenants, a hard close is both dishonest and ineffective — this operator has been pitched by a dozen freight-tech vendors this year and can smell a script. The job is to find out whether *their actual numbers* make the case, and to let them watch you find out. If the numbers don't work, say so and end it; a disqualified carrier who felt respected sends referrals, and a wrong-fit deposit becomes a refund and a bad story.

---

## Before the call (5 minutes)

Pull their FMCSA record: power units, authority age, whether they also hold broker authority, cargo classes, state. Open [the calculator](A3-roi-calculator.md) with their truck count pre-filled. Open their CRM row. **Never open by reciting their DOT data back at them** — it reads as surveillance. Know it; don't perform it.

## Agenda (25 minutes, and end on time)

**0–2 · Frame, honestly.**
> "Twenty-five minutes. I want to spend most of it on your numbers, not my slides. Fair warning up front: we have no customers yet. It's built and running on our own infrastructure, and we're picking the first eight carriers to run it with. So this is as much me qualifying whether your operation is the right one as it is you deciding about us."

**2–12 · Diagnose. This is the call.** Three questions, then listen. Do not pitch inside this block — take notes, follow the pain that's warmest.

1. *"When a driver sits at a dock for three hours, what happens next in your office?"* → who chases it, whether a claim gets filed, what proof exists, how often it gets paid. (Detention pain.)
2. *"Walk me through the day between a POD and an invoice going out."* → who re-types what, how many systems, where it stalls. (Back-office + cash-cycle pain.)
3. *"How much of your money is sitting in someone else's hands right now?"* → days to pay, factoring rate. Use **their** numbers in the calculator, live, on screen. (Cash-cycle pain.)

**12–18 · Show, don't tell.** Their calculator output, then the one demo that maps to their warmest pain — the POD→invoice film for cash-cycle, the signed-arrival evidence for detention. **Say "this is staging" out loud** the first time footage appears. Then the honest boundary:
> "What this does is make the proof automatic. It doesn't make your customer pay faster by itself — it removes their reason to argue."

**18–23 · The offer, and its limits.**
> "Eight founding slots. Founding price locked 24 months — for your size that's $X/month against a $Y list. Onboarding runs 14 to 20 weeks: we mirror your current system first, run a 30-day shadow, and don't touch your money authority until we've closed two months in parallel and matched. That's not caution theatre — it's the only way I'd be willing to do it, and I won't compress it for anyone."

**Pre-counsel** (today), the deposit does not come up as an ask:
> "The reservation carries a refundable deposit — the terms are with counsel this week and I won't take a dollar before they're written down and you've read them. What I'm asking today is whether you want the slot held while that finishes."

**23–25 · Close on a next step, not a feeling.** A date for the terms, a named person on their side to include, or an honest no.

---

## Qualification rubric — score during the call, record after

| Signal | Pass | Partial | Fail |
|---|---|---|---|
| Power units | 10–100 | 5–9 or 101–150 | <5 or >150 |
| US OTR / regional | Yes | Mixed w/ some final-mile | Local-only, or non-OTR mode |
| Structural tell (≥1) | Detention disputes lost · factoring ≥2% · owner chases PODs · ≥1 office head per ~8 drivers | One, weakly | None — already automated |
| Brokerage arm | Has one, or building | Occasional brokering | None (still viable, lower value) |
| Willing to run a 30-day parallel shadow | Yes | Needs internal buy-in | "Just switch us over" |
| Decision authority | Owner/GM on the call | Champion who can convene the owner | Neither |

**Two Fails, or a Fail on units/mode/shadow → disqualify on the call.** Say it plainly: *"Honestly, we're built for regional fleets in the 10-to-100 range that still fight detention on paper. That's not you — you've already solved this. I'd rather tell you now than take your deposit."* Record `X Disqualified` with the reason. That reason is data: three of the same reason means the ICP is wrong, not the carrier.

## Objections — answer with the real answer

**"You have no customers."** — *"Correct, and I'll say it in writing. That's exactly what the founding slot is: you get the founding price and my direct line because you're taking a risk on an unproven vendor. If I had fifty customers, this conversation would cost you triple."*

**"Fourteen to twenty weeks is too long."** — *"It is long. It's also why we won't break your billing. Anyone promising a two-week cutover on your money is telling you they'll run it unproven. The shadow period is where you find out whether we're right — with your invoices, before it matters."*

**"What if you go under?"** — Don't flinch. *"Then you get the deposit back and you've lost the parallel-running time, which is why we run in parallel. Your data exports. And you should ask that of any vendor holding your billing — most just don't answer it."*

**"Why $2,500?"** — *"To make sure only people who mean it hold a slot. It's fully refundable, it credits against your first invoice, so if we go live it costs you nothing."*

**"Just give me a free trial."** — *"The onboarding is hands-on for months, so a free trial isn't a smaller version of this — it's the same work with nobody committed. The deposit is refundable; that's the free trial, with skin in it."*

## After the call (do it immediately — memory decays and CARR depends on the record)

Update the [CRM row](F5-crm-substrate.md): `Stage` → 5 Call held (or `X Disqualified`) · `ICP Gate` from the rubric · `Fleet Band` and `Founding ACV` from the band table · **`Pain Signal`** — which pain actually pulled, the single most valuable field on the call · `Notes` — their numbers verbatim, in their words · `Next Action` with a date.

**A slot is "held" in the CRM, never promised as exclusive.** With eight slots and no cleared deposits, an informal hold is a courtesy — say "held while terms finish," never "reserved for you," and don't hold more than eight.

## The measurement loop
After ~10 calls: which pain led (message-market fit), which objection recurred (offer fix), and the disqualification reasons (ICP fix). After ~20, `Pain Signal` decides which [A-1 variant](A1-messaging.md) becomes primary and which [sequence](D2-sequences.md) gets the volume. **The call is the highest-resolution research instrument this program has** — it is worth more than any list.
