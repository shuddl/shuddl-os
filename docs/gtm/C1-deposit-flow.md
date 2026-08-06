# C-1 — Founding Carrier Deposit Flow (spec only; no charge until F-3)
**Status:** SPEC v1 — **NOT buildable and NOT chargeable until counsel-approved terms exist (F-3).** This document deliberately stops short of implementation. · **Offer:** [C3-founding-carrier-program.md](C3-founding-carrier-program.md) · **Pipeline:** [F5-crm-substrate.md](F5-crm-substrate.md) · **Claims law:** [A1-messaging.md](A1-messaging.md)

> **Hard gate.** No Stripe object is created in live mode, no payment link is published, and no card is charged until (a) counsel has approved the refundable-deposit terms and the ToS/Privacy/DPA set (REQ-138), and (b) the owner has approved the published terms page. Test mode is permitted before that; live mode is not.

## What is being collected and why

A **$2,500 fully refundable deposit** that reserves one of **8 Founding Carrier slots** and locks the 24-month founding price. It is not payment for software — nothing is delivered yet. It is a **reservation with money attached**, and its only job is to convert stated interest into a commitment real enough to count as CARR.

Deposit size rationale: large enough that only a genuinely-intending operator pays it (a $100 deposit measures curiosity, not intent), small enough to sit inside an owner's discretionary spend without a board conversation. It credits in full against the first invoice at go-live, so the true cost to a carrier that proceeds is **zero**.

## The flow

| Step | What happens | System |
|---|---|---|
| 1 | Founder call held; fit confirmed; fleet band set | Owner + [F5](F5-crm-substrate.md) row → Stage 5 |
| 2 | Owner sends LOI + terms page link | Manual (email) at this volume — deliberately not automated |
| 3 | Carrier reads terms, clicks *Reserve my slot* | Terms page (marketing repo) |
| 4 | Stripe Checkout, one-time $2,500, card only | Stripe (live mode — **post-F-3 only**) |
| 5 | Payment succeeds | Webhook → CRM `Deposit Cleared` = true, `Deposit Amount` = 2500, Stage 7, `LOI Signed` date |
| 6 | Receipt + welcome + onboarding-calendar expectations | Resend (`send.shuddl.tech`, already verified) |
| 7 | **CARR increments** by the band's Founding ACV | [F5](F5-crm-substrate.md) formula — automatic, since it keys off `Deposit Cleared` |

**Refund path (must be as easy as the purchase):** carrier emails or asks on a call → owner issues a full Stripe refund → `Deposit Cleared` unchecked same day → CARR decrements automatically → Stage → `X Lost` with the reason recorded. The reason field is the product feedback loop; a refund we don't understand is a wasted lesson.

## Stripe object design (build later, in test mode first)

- One **Product**: "Founding Carrier Reservation." Three **Prices** — one per fleet band — all $2,500, distinguished by metadata so the band travels with the payment and the CRM never has to guess.
- **Metadata on every session:** `fleet_band`, `founding_acv`, `icp_gate`, `crm_row_id`, `source`. Without `crm_row_id` the webhook cannot reconcile, and a deposit that can't be attributed is a CARR figure we can't defend.
- **Payment links, not a custom checkout** — v1 needs zero frontend beyond the terms page. A link can be revoked; a deployed checkout page has to be maintained.
- **Idempotency:** the webhook handler must tolerate redelivery (Stripe retries). Keying on the Stripe `session.id` in the CRM row prevents a double-count of CARR — the exact failure mode that would corrupt the north-star metric.
- **Slot cap enforcement:** 8 slots is a promise, so the link must be deactivated at 8 cleared deposits. Do this by hand at this volume; an automated cap that fails open is worse than a manual one.
- **Live-mode keys never enter this repo** — they belong in the marketing worker's secret store. The repo carries the spec, not the credentials.

## Terms page — required content (counsel to draft/approve)

Refund policy in plain language and above the fold · what the deposit does and does *not* buy (explicitly: it does not buy software today) · the go-live condition and the 12-month auto-refund backstop · credit against first invoice · the 24-month price lock and what happens after · anonymity by default (no logo, no case study, no name without separate written consent) · data-handling summary linking the DPA · a named human to contact.

**Tone requirement:** the page should read like it was written by someone who expects to be held to it. The onboarding calendar's length (14–20 weeks, two clean parallel closes before money authority flips) is a **feature to state plainly**, not fine print to bury — a carrier who is surprised by it later is a refund.

## What could go wrong (and the design answer)

| Risk | Answer |
|---|---|
| Deposit taken from a fleet outside the ICP | The ICP gate is scored at Stage 1 and re-checked on the call; a `Fail-*` row cannot reach Stage 6 |
| Carrier expects working software next week | Terms page states the calendar; the call states it; the receipt email restates it |
| Refund wave signals a broken promise | Guardrail: refund rate ≥20% triggers a re-plan per the program's kill criteria — tighten claims, slow outbound |
| Double-counted CARR from webhook retry | Idempotency on `session.id` |
| Deposit read as revenue | It is **not revenue**; it is a refundable liability until go-live. CARR is a commitment metric, not a P&L line — this distinction goes in the founder-call script |

## Status and dependencies

**Blocked on:** F-3 (counsel terms) — the hard gate. **Then blocked on:** the Cloudflare account split, since the terms page and payment link live in the marketing repo. **Ready now:** Stripe test-mode object modeling and the CRM webhook contract, both of which can be designed and reviewed before a single live key exists.
