# F-5b — CRM wiring specs (ready to execute when the account split clears)
**Status:** SPEC — nothing built. Every item below is blocked on the **Cloudflare account split** (the marketing worker + waitlist KV live in account `1d40ee…`; this session is authed to the product account `89618c…`). **Gates:** [F5-crm-substrate.md](F5-crm-substrate.md) · [A4-landing-page-v2.md](A4-landing-page-v2.md) · [C1-deposit-flow.md](C1-deposit-flow.md)

## W1 — Waitlist → CRM row

**Today:** signups land in `WAITLIST_KV` in the marketing account and go nowhere else. Nobody is following up, and the count can't even be read from here.

**Spec:** on signup, create a [pipeline](F5-crm-substrate.md) row with `Stage = 1 Identified`, `Source = Waitlist`, `ICP Gate = Unscreened`, and the submitted email in Notes. Keep writing to KV as the durable log — the CRM is the working surface, not the system of record for signups.

**Backfill first.** There are existing signups nobody has contacted. Before wiring anything forward, export the current KV keys, create rows, and screen them against the [ICP gate](F1-icp.md). *These are the warmest leads the program has* — they raised a hand unprompted, with no outbound and no content. Treat the backfill as the first real pipeline, not as cleanup.

**Failure rule:** a CRM write that fails must not lose the signup. KV write first, CRM second, retry the CRM asynchronously. Losing a hand-raiser to a webhook error is the worst outcome in this whole document.

## W2 — UTM → `Source`

Capture `utm_source/medium/campaign` on landing, persist through the session, submit with the form, and map to the `Source` select: `outbound→Outbound`, `content→Content`, `press→Press`, `referral→Referral`, none→`Inbound other`. Store the raw string in Notes — the mapping will be wrong sometimes and the raw value is how we notice.

**Why it matters more than it looks:** `Source` is how CARR gets attributed to a channel. Without it, at $100K CARR we'd know we succeeded but not what to do more of.

## W3 — Calculator → CRM

On result-page email capture: row with `Source = Content`, `Fleet Band` from their truck-count input, `ICP Gate` auto-scored from the four inputs, `Pain Signal` from the largest output line, and **all four inputs verbatim in Notes** — so the [founder call](C3b-founder-call-script.md) opens with their own numbers instead of a discovery script.

## W4 — Stripe → `Deposit Cleared` (the CARR trigger)

Per [C1](C1-deposit-flow.md): webhook on `checkout.session.completed` → set `Deposit Cleared`, `Deposit Amount`, `Stage = 7`, `LOI Signed`. **Idempotency on `session.id` is mandatory** — Stripe retries, and a double-write inflates the north-star metric itself. Refund webhook must reverse it the same way. **Blocked on F-3 counsel before any live key exists.**

## W5 — Opt-out → suppression

Any unsubscribe sets `X Lost` + reason `opted out`, and that address is excluded from every future send. CAN-SPAM allows 10 business days; do it immediately. **This one is legally load-bearing** ([D1-fmcsa-list-method.md](D1-fmcsa-list-method.md) §6) — build it before the first send, not after the first complaint.

## Order of execution once unblocked
W1 backfill (warmest leads, zero dependencies) → W1 forward + W2 (needs the landing page) → W3 (needs the calculator) → W5 (before any outbound) → W4 (after counsel).

**Owner action that unblocks all five:** the Cloudflare account split. It currently blocks the waitlist count, the landing page, the calculator, the site corrections, and every wiring item here — it is the single highest-fan-out item on the board.
