# 06 — North-Star Metric and the Decision Framework (Defined, Then Applied)
**Date:** 2026-08-01 · Part of the [coordination-layer research program](00-goal-and-dods.md) · Inputs: docs [01](01-system-readiness.md)–[05](05-impossible-tasks-and-pivots.md)

**Stated explicitly, per the request (U2):** this framework is not decorative. It is defined in §2, then *applied* in §3 to the candidate strategic paths, and it selects one. [07-path-forward.md](07-path-forward.md) executes the winner. It is also the standing instrument: every phase exit and every kill-criterion trigger in 07 re-runs this scoring.

---

## 1. The north-star metric

> ### VSD — **Verified Settlement Dollars**
> **Dollars of freight revenue invoiced directly and automatically from signed physical events — evidence attached, chain-verified — per month.**

**Formula:**
`VSD = Σ amount(invoice.issued) WHERE projected_from = signed physical event (pod.signed or equivalent) AND evidence attached AND chain verification passes AND no manual re-entry between event and invoice`

**Why this single metric carries the whole thesis.** VSD only rises when every layer of the stack works at once: a real stop happened (physical capture) × someone signed it (trust/identity) × the money projected untouched (automation) × a real business ran its revenue through the ledger (adoption). It cannot be inflated by vanity signups (needs freight), by demo volume (needs signatures), or by services revenue (needs projection, not invoicing labor). It is the operational form of "money as a projection of physics" — and it is precisely the number every persona in [02](02-coordination-layer-value.md) pays for: the carrier's cash cycle, the broker's clean settlement, the shipper's evidence-backed invoice, the AI vendor's trustworthy state.

**Decomposition (the leading indicators to instrument):**
`VSD = (stops captured) × (signature rate) × (auto-projection rate) × (avg invoice value) × (tenants)`

**Guardrail counter-metrics** (a rising VSD is invalid if these degrade):
- **Correction/dispute rate on projected invoices ≤ 2%** — protects against garbage-in-fast-out (the T4/T8 liability containment).
- **Co-signature share of VSD** (target: rising quarter over quarter) — distinguishes the coordination layer from a very good single-party TMS ([02 §6 test 2](02-coordination-layer-value.md)).
- **Tenant DSO delta** — the value must show up in the tenant's cash, or the willingness-to-pay model fails.

**Baseline and horizon targets:**

| Horizon | Target | What it proves |
|---|---|---|
| Today | **$0** (staging proof-of-mechanism only: one penny-exact $558 synthetic invoice) | The mechanism works; the market claim is unproven |
| **H1 — +6 months** | Tenant #0 live; **VSD ≥ $400K/mo** (≈ tenant #0 asset-side revenue flowing through); disputes ≤2% | Participant-#1 ROI (the graveyard's necessary condition #1) |
| **H2 — +18 months** | **VSD ≥ $5M/mo across ≥10 tenants**; co-signature on ≥50% of delivery stops; **≥3 external AI tools reading ledger state via MCP in production** | The wedge repeats; the embrace thesis works; the seat is occupied |
| **H3 — +36 months** | **VSD ≥ $50M/mo across ≥100 tenants**; **≥1 cross-ledger federated attestation exchange live in production (R6/R7)** | The layer is real: sovereign ledgers, federating |

(H2/H3 magnitudes are set from [02 §5](02-coordination-layer-value.md) sizing: 10 tenants ≈ $60–80M/yr of revenue under management → $5M/mo VSD is that revenue flowing verified; they are targets to steer by, re-based at each phase exit against tenant-#0 actuals.)

---

## 2. The decision framework: **Gates-then-Weights**

### Stage 1 — Hard gates (binary; one failure disqualifies)

| Gate | Source |
|---|---|
| G1 — **No network-before-participant-#1.** The option must not require external adoption before it pays | TradeLens/BiTA/Convoy postmortems ([raw interop §5.3](raw/interop-standards-report.md)) |
| G2 — **No cross-tenant data pooling, ever** (no benchmarking/index products) | Antitrust containment ([05 §T6](05-impossible-tasks-and-pivots.md)) |
| G3 — **No fabricated evidence** — gates blocked on absent real inputs stay blocked or are explicitly waived in the register | The repo's own law (`LAUNCH-RUNBOOK.md:266-271`) |
| G4 — **No development until the user states the pivot**; research recommends, the owner decides | This program's C1 |
| G5 — **Ten Laws / register compliance** — nothing that requires a do-not-build item | `CLAUDE.md`, genesis/00 |

### Stage 2 — Weighted scoring (0–10 per criterion)

| Criterion | Weight | What it measures |
|---|---|---|
| **C1 — Time-to-VSD** | 0.30 | Does this shorten the path to verified dollars? (The metric is the mission) |
| **C2 — Solo+AI executability** | 0.25 | Shippable by one person orchestrating agents on a near-zero-fixed-cost stack, without new capital or headcount? (U3) |
| **C3 — Window capture** | 0.20 | Does it claim the empty seats (MCP surface, attestation spec) before p44/LSP44, DAT, or Triumph close them? ([03 §5](03-competitor-landscape.md), [05 §T7](05-impossible-tasks-and-pivots.md)) |
| **C4 — Reversibility** | 0.15 | Two-way doors score high; one-way doors (exclusivity, sale, public commitments) score low |
| **C5 — Evidence strength** | 0.10 | Is the option's premise verified fact, or hope? (U1) |

---

## 3. The framework applied — four candidate paths

**Path A — "Tenant #0 first, seat-claim in parallel."** Clear the 1–2-week code residual (login, ratecon, signup UI) and config flips; run the genesis/13 onboarding calendar with the real carrier; in parallel (low cost, high option value) publish the attestation spec + take the already-deployed MCP server to GA. Prove VSD, then climb the [04 §5](04-interop-system-design.md) ladder.

**Path B — "Platform first."** Pivot now to selling the layer to AI-tool vendors (Plaid-style developer product: ledger API + MCP as the offering), defer carrier operations.

**Path C — "Fabric land-grab."** Announce the coordination layer publicly, recruit red-ocean design partners and capital, build federation (L4) ahead of tenant proof.

**Path D — "License/partner the tech."** Take the ledger + money-projection stack to an incumbent that owns distribution (Triumph, DAT-class) as a licensed core or acqui-partnership.

### Stage 1 results
- **A:** passes all gates.
- **B:** passes gates (barely G1 — its revenue *is* external adoption, but no multi-party network is required).
- **C:** **FAILS G1** (value gated on network forming) — the TradeLens shape. Disqualified; scored anyway for transparency.
- **D:** passes gates (G4 noted: it's a recommendation only the owner can act on).

### Stage 2 scoring

| Criterion (weight) | A | B | C† | D |
|---|---|---|---|---|
| C1 Time-to-VSD (.30) | **9** — shortest real path; every prerequisite enumerated in [01 §6](01-system-readiness.md) | 3 — an empty ledger has nothing to sell to tool vendors; VSD ≈ 0 indefinitely | 2 | 4 — license revenue isn't VSD; the thesis dies unproven |
| C2 Executability (.25) | **9** — 1–2 wks code + config + a calendar already in motion; zero new capital | 6 — dev-product motion is solo-friendly but demands sales/support breadth | 3 — requires capital + BD SHUDDL doesn't have | 7 — one deal, but long enterprise cycles |
| C3 Window capture (.20) | 6 — spec+MCP GA in parallel hedges the window without betting on it | 8 — most direct seat claim | 9 | 4 — the incumbent captures the seat, not SHUDDL |
| C4 Reversibility (.15) | **8** — everything two-way; can graft B later | 6 — repositioning back to operator-SaaS is awkward but possible | 3 — public announcements are one-way | 2 — exclusivity/IP terms are one-way |
| C5 Evidence strength (.10) | **9** — every premise verified this program (readiness, value anchors, empty seat) | 2 — P5 demand is inferred, and inferred *conditional on live freight state existing* | 1 | 6 — consolidation appetite is documented ([03 F1](03-competitor-landscape.md)) |
| **Weighted total** | **8.25** | **5.10** | 3.70 † | 4.55 |

† disqualified at Stage 1; shown for transparency.

### Decision

> **Path A wins decisively: prove the ledger on tenant #0 while claiming the open seats (published spec + MCP GA) at parallel low cost — grafting Path B's best idea without its fatal premise.** Path D is retained as a *fallback*, not a path: it triggers only if the kill criteria in [07](07-path-forward.md) fire (tenant-#0 economics fail per [02 §6](02-coordination-layer-value.md)). Path C is structurally dead and stays dead.

The full execution plan for Path A — phases, entry/exit criteria, kill criteria, and the re-scoring cadence — is [07-path-forward.md](07-path-forward.md).
