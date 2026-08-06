# C-3 — The Founding Carrier Program (the first-dollar instrument)
**Status:** SPEC v1 — ready for counsel (F-3) and owner read; no charge until counsel terms exist · **Gate:** [F1-icp.md](F1-icp.md) ✅ · Absorbs A-5 (pricing hypothesis).

## The offer

**8 Founding Carrier slots.** A founding carrier reserves a place in the tenant onboarding calendar (genesis/13 sequence: mirror → 30-day shadow → pilot → flip) with a **fully refundable $2,500 deposit**, and in exchange locks:

1. **Founding price for 24 months** (table below — roughly half the modeled willingness-to-pay band).
2. **Onboarding priority** — calendar slots are sequential and scarce by design (each runs 14–20 weeks); founding order = slot order.
3. **White-glove migration** — the Migrator work (legacy export mapping, roster, tariffs) done with them, not sold to them.
4. **Direct founder line** during pilot; their pains steer the queue-ordering of post-launch work.
5. **Anonymity by default** — no logo use, no case study, no name anywhere without separate written consent (REQ-167 discipline as a customer promise).

**Refund terms (for counsel):** deposit refundable in full, on request, any time before their onboarding mirror phase begins; auto-refunded if SHUDDL does not offer them a go-live slot within 12 months. Deposit applies as a credit against the first invoice at go-live. No deposit is charged before counsel-approved terms are published.

## Pricing hypothesis (A-5) — founding vs list

Basis: value model in research [doc 02 §4](../research/2026-08-01-coordination-layer/02-coordination-layer-value.md) — $200–620K/yr value for a 25-truck hybrid → $40–125K/yr WTP band at 3–5x value capture.

| Fleet band | List hypothesis | **Founding lock (24 mo)** | Implied founding ACV |
|---|---|---|---|
| 10–25 trucks | $3,300/mo | **$1,950/mo** | ~$23K |
| 26–60 trucks | $6,500/mo | **$3,900/mo** | ~$47K |
| 61–100 trucks (or hybrid w/ brokerage arm >$5M gross) | $10,000/mo | **$5,900/mo** | ~$71K |

Flat per-operation pricing; **never seat-based** (register do-not-build). Brokerage-arm usage included in-band. Numbers are hypotheses to be tested in founder calls — the deposit + LOI is the test.

## CARR accounting (NSM integrity)

- **CARR = signed LOI ACV, counted only when the deposit has cleared.** LOI without deposit = pipeline, not CARR.
- Refund issued → CARR reduced same day. Unservable/mis-ICP commitment → counted at $0 (conversion contract to VSD).
- Day-90 target ($100K CARR) ≈ 2–3 mid-band founders — deliberately modest; the constraint is calls, not math.

## Funnel

Waitlist / content / press → ROI-calculator or demo-film page → **founder call** (owner takes; qualification = F-1 mechanical gate) → LOI + Stripe deposit link (post-F-3) → Mission Control CARR tracker.

## LOI skeleton (one page, for counsel)
Parties (blind until countersigned) · fleet band + founding price lock · go-live conditions (SHUDDL offers a mirror-phase start ≤12 months; carrier commits data-access grant + shadow participation) · deposit terms as above · either-party walkaway before mirror phase · no exclusivity, no auto-renewal beyond the 24-month price lock.

## Honesty rails on the sales page
"Built and running on our infrastructure today; Founding Carriers are the first production tenants" — never "customers already run on it." Staging labels on all demo media. The onboarding calendar's length is a *feature* (we don't flip your money authority until two clean parallel closes) — sell the discipline, don't hide it.
