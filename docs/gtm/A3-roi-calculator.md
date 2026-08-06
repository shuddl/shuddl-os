# A-3 — The Detention & Cash-Cycle Calculator (lead magnet spec)
**Status:** SPEC v1 — build-ready for the marketing-site repo (C-2) · **Gates:** [F1-icp.md](F1-icp.md) ✅ · [A1-messaging.md](A1-messaging.md) (claims firewall) · Value model: [research doc 02 §3–4](../research/2026-08-01-coordination-layer/02-coordination-layer-value.md), anchors in [raw/value-anchors-fact-sheet.md](../research/2026-08-01-coordination-layer/raw/value-anchors-fact-sheet.md)

## What it is and why it's the right lead magnet

A single-page calculator: the visitor enters **four numbers they know by heart**, and it returns **what detention, paperwork, and slow cash are costing them per year** — every line traceable to a published industry source, with SHUDDL's recovery claim stated as a *range with its assumption shown*, never a promise.

It qualifies while it persuades: the four inputs ARE the F-1 ICP gate (fleet size, stops/week, days-to-pay, factoring y/n). A visitor who fills it in has self-reported their band, so [F5](F5-crm-substrate.md) can create a pipeline row with `Fleet Band` and `Pain Signal` already populated, and the founder call opens with their own numbers on screen instead of a discovery script.

## Inputs (4 required, 2 optional)

| # | Field | Type | Default | Why |
|---|---|---|---|---|
| 1 | Power units (trucks) | number, 1–500 | 25 | Drives every scaling; sets `Fleet Band` |
| 2 | Stops per truck per week | number, 1–30 | 8 | Detention exposure driver |
| 3 | Average days to get paid | number, 1–120 | 45 | Cash-cycle driver |
| 4 | Do you factor invoices? | yes / no + rate % | yes, 2.8% | Factoring cost line |
| 5 | *(optional)* Office staff count | number | blank | Sharpens the back-office line |
| 6 | *(optional)* Loads per month | number | derived | Sharpens admin-per-load |

Out-of-ICP input (>100 trucks or <5) still calculates, but the result page swaps the CTA for an honest "you're outside who we're built for right now" note. **Never take a deposit from a disqualified fleet** — that's a refund and a bad reference waiting to happen.

## The four output lines (every constant sourced)

Constants live in one `ASSUMPTIONS` object so the page can render its own footnotes and any number can be updated in one place.

| Line | Formula | Constants (source) |
|---|---|---|
| **1. Detention exposure** | `trucks × stops/wk × 52 × DETAINED_SHARE × AVG_DETAIN_HRS × COST_PER_HR` | `DETAINED_SHARE = 0.393` (ATRI 2023 detention study) · `AVG_DETAIN_HRS = 1.4` *(conservative; ATRI reports 117–209 hrs/driver/yr — the page shows this as a range, not a point)* · `COST_PER_HR = $90.89` (ATRI 2024 marginal cost/hr) |
| **2. Unrecovered detention** | `line1 × UNBILLED_SHARE` | `UNBILLED_SHARE = 0.5` — **flagged in-page as SHUDDL's estimate, not a published figure**, anchored to OOIDA 2023: 18% of drivers never receive detention pay, only 29% receive it on all loads |
| **3. Cash-cycle cost** | `annual_revenue × FACTOR_RATE` (if factoring) `+ float_carrying_cost` | `FACTOR_RATE` and days-to-pay come from **the user's own inputs (#3, #4)** — **no default is shipped**. See the sourcing note below |
| **4. Back-office drag** | `loads/yr × ADMIN_PER_LOAD` | `ADMIN_PER_LOAD = $25–60` composite (**labeled as SHUDDL arithmetic** from BLS non-driver staffing ratios + document-handling costs, not a single published figure) |

### Sourcing correction (2026-08-02, tick 12)

Three constants originally drafted here — a ~47-day DSO, a ~$900K receivables float, and a 2.8% factoring default — trace **only to vendor blogs** in the [raw fact sheet](../research/2026-08-01-coordination-layer/raw/value-anchors-fact-sheet.md) (marked ⚠️ there). [A-1's naming rule](A1-messaging.md) says prefer omitting a figure over citing a vendor for it, and a calculator whose footnote points at a competitor's marketing post is worse than one that simply asks.

So the cash-cycle line is built **entirely from the visitor's own numbers**: their days-to-pay and their factoring rate, which they know better than any published average. This is strictly better — it removes a weak citation *and* makes the output personal. Where a range is genuinely useful, cite the factoring **range** to a trade outlet (permitted under the corrected naming rule) rather than presenting a point estimate as fact.

The detention and cost-per-hour constants are unaffected: ATRI and OOIDA are research bodies, and those figures are the strongest in the model.

**Headline number** = sum of lines, displayed as a **range** (conservative → aggressive), never a single false-precision figure. Beneath it: *"SHUDDL is built to recover the evidence half of this — the disputes you lose because nobody can prove what happened. It does not make your customers pay faster by itself."* That sentence is the honesty valve; it goes in the build brief as non-negotiable copy.

## Claims firewall (A-1 hard-don'ts, applied)

- Every constant renders a visible footnote: **source name, year, link**. No number appears without one.
- SHUDDL-derived estimates are **visually distinct** (different weight/color + "our estimate" tag) from published figures. The user must be able to see which numbers are ours.
- No "customers save X" — the page never claims realized savings, only *exposure* and a recovery *range with its assumption stated*.
- Status line, verbatim from A-1: **"built and running on our own infrastructure; entering Founding Carrier pilots."**
- No platform/network/coordination-layer language. No "AI-powered."

## Result page → funnel

Result → *"Want us to run this against your last 90 days of real stops? That's the founder call."* → email capture (email only; no phone wall) → [F5](F5-crm-substrate.md) row created with `Source = Content`, `Fleet Band` from input 1, `ICP Gate` auto-scored, `Pain Signal` set from the largest output line, and the inputs stored in `Notes`. Deposit CTA appears **only after F-3 counsel terms exist** — until then the page's only ask is the call.

## Build notes (for C-2, marketing-site repo)

Static page, client-side arithmetic, no backend needed for v1; email capture posts to the existing waitlist endpoint with a `calculator` source tag. Constants in one exported object with source strings adjacent. URL-encodable inputs so a shareable/reproducible link can be pasted into a follow-up email. Print/PDF stylesheet — carriers forward this to a partner or a banker. Mobile-first: this gets opened in a truck stop, not at a desk.

**Blocked on:** the Cloudflare account split (the marketing repo lives in the other account) — owner-lane item. Spec is complete and buildable the moment that clears.
