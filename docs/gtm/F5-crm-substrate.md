# F-5 — CRM Substrate (pipeline, stages, CARR accounting)
**Status:** LIVE · Built 2026-08-02, tick 3 · **Database:** [SHUDDL — Founding Carrier Pipeline](https://app.notion.com/p/26e38346958143f28da4f9dcb3d969ad) (Notion) · data source `e703cf77-3a28-4989-9092-24db229a3e62`
**Gates:** [F1-icp.md](F1-icp.md) ✅ (ICP Gate field enforces it) · [C3-founding-carrier-program.md](C3-founding-carrier-program.md) (ACV values, deposit terms)

## Stages (the funnel)

| Stage | Enter when | Exit criteria |
|---|---|---|
| 1 Identified | Company matches the ICP filter and is in the list | ICP Gate scored (never leave `Unscreened`) |
| 2 Contacted | First approved touch sent (or inbound waitlist signup) | Any human reply |
| 3 Engaged | Two-way conversation exists | Call offered |
| 4 Founder call booked | Calendar hold exists | Call held |
| 5 Call held | Owner ran the call; pains + fleet band captured | Fit confirmed, band set, ACV set |
| 6 LOI sent | LOI + deposit link delivered | Deposit clears or explicit no |
| **7 Deposit cleared — CARR** | **Stripe deposit settled** | This is the only stage that counts toward CARR |
| X Disqualified | Fails the F-1 mechanical gate | terminal (record the reason in Notes) |
| X Lost | Fit but declined | terminal (reason in Notes — this is the pricing/offer feedback loop) |

## CARR accounting rules (NSM integrity — the formula enforces rule 1)

1. `CARR = if(Deposit Cleared, Founding ACV, 0)` — **an LOI without a cleared deposit contributes $0.** Pipeline ≠ CARR.
2. Founding ACV is set from the band table, not negotiated ad hoc: **10–25 trucks = $23,400 · 26–60 = $46,800 · 61–100 = $70,800** (C-3 founding lock, 24 months).
3. Refund issued → uncheck `Deposit Cleared` the same day; CARR falls automatically. Refund count feeds the <20% guardrail.
4. Anything that could not convert to a live tenant (wrong ICP, unservable) → move to `X Disqualified`, ACV to 0. This is the CARR→VSD conversion contract.
5. Board totals in [00-mission-control.md](00-mission-control.md) are copied from the sum of this column — the database is the source of truth, the markdown board is the mirror.

## Field discipline
- **ICP Gate** must be scored before stage 2. A `Fail-*` value blocks outreach — this is F-1's mechanical gate made structural.
- **Pain Signal** is the message-market-fit instrument: which of the three priced pains (detention / cash cycle / back office) actually pulls. After ~20 conversations this decides which A-1 variant becomes primary.
- **Source** attributes CARR to waitlist / outbound / content / press / referral — this is how we learn which channel deserves the next hour.
- **No personal contact data is stored in this repo.** Company-level only in `docs/gtm/`; person-level lives in the CRM and the sending tool, never in git (REQ-289/167).

## Wiring still open
| Link | State | Blocked on |
|---|---|---|
| Waitlist (marketing KV) → pipeline rows | not wired | owner-lane: CF account split (KV is in the marketing account) |
| Outbound tool → Stage 2 auto-advance | not wired | Apollo re-auth + warmed domain |
| Stripe deposit → `Deposit Cleared` | not wired | F-3 counsel terms, then C-1 build |
| UTM attribution → `Source` | not wired | A-4 landing v2 |

Until wired, the loop maintains rows manually — which is correct at this volume and keeps the schema honest before automation hardens it.
