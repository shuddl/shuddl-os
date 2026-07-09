# SHUDDL — Tenant Onboarding & Overlay Interface
## Genesis doc 13 · 2026-07-09 (F0.2, corrected) · how ANY tenant lands, with zero tenant identity in this repo
**Separation law (restated and enforced):** this repo contains the product. No tenant names, no people, no customer terms, no incumbent-vendor names, no tenant financials — ever (the set's own design rule, doc README). Everything tenant-specific lives in a **Tenant Config Pack** held in that tenant's private engagement workspace, outside this repo, loaded at onboarding. Tenant #0 is the working regional carrier + brokerage already described abstractly in doc 05 §4; its pack lives in its engagement workspace.

---

## (01) CORRECTION — the spine question was never open
An earlier draft of this doc imported a client-side replacement brief and "ruled" on a spine choice between this set and a prior TMS codebase. **Withdrawn.** This set had already decided (README, doc 06 logic): **the fresh spine defined by docs 02/10 is the only spine; no prior codebase — 2023 apps or any later build — becomes it or merges into it.** Prior builds are organ banks: requirements archaeology and pattern reference only (REQ-163). The audited rating engine, import machinery, re-rate harness, and evidence patterns port in as doc 05 §2 always stated — as ported, tested packages, not merged trees. No client document governs this repo; conflicts resolve by this set's source-of-truth order alone.

## (02) THE TENANT CONFIG PACK (the contract; one pack per tenant, private)
A pack is a versioned folder in the tenant's engagement workspace containing:
1. **identity.yaml** — legal entity, divisions/companies, terminals/facilities, operating region, brand assets for lenses/emails.
2. **org-roles.yaml** — seat→role mapping (admin/ops/finance/read/driver/portal) **by seat title only**; person-name resolution happens inside the tenant's own canonical-facts source, referenced by pointer, never copied. Contested seats carry `[CONFIRM]` and block *assignment*, never the build.
3. **approval-matrix.yaml** — who approves below-target, below-contribution, credit exceptions (seats, not names).
4. **rating-config/** — tariffs, zone maps, rate groups, accessorial schedules, floors, FSC, margin rules, contract-pricing cases (versioned per REQ-005/`rate_config`).
5. **continuity.yaml** — pro-number ranges, reference formats, transit standards, bill-terms defaults.
6. **adapters.yaml** — which ingest/project adapters the incumbent system needs, feed cadence, and the standing data-access request status (the Phase-0 clock, REQ-152).
7. **calendar.yaml** — the tenant's dated instances of the generic gates in §04 (close dates, pilot window, partner-EDI certification windows).
8. **confirm-ledger.md** — every open `[CONFIRM]` with owner and what it blocks.
9. **fixtures-manifest.private** — real paths + hashes of the tenant's golden fixtures; the repo's `fixtures/README.md` refers here and never embeds tenant paths.
The Migrator consumes the pack at Phase 0; the pack never enters version control here. CI includes an **identity-leak lint**: a denylist (tenant names, person names, incumbent vendor names, customer names — maintained client-side) greps every PR; any hit fails.

## (03) ROLES & ORG DISCIPLINE (why names never appear)
The product needs *roles*, not people. Seats map to the six roles; the pack's org-roles file points at the tenant's canonical-facts source for name resolution at deploy time. Rules: no name in any repo artifact, commit message, fixture, or seed; ownership/governance seats get read lenses and are never assigned operational tasks; unresolved org conflicts stay `[CONFIRM]`-flagged in the pack's confirm-ledger and block only the affected role assignment. This is both a confidentiality boundary (client data stays client-side) and an IP boundary (the product is provably tenant-clean).

## (04) THE ONBOARDING PHASE PATTERN (generic; dates live in the pack's calendar.yaml)
| Phase | Object | Generic exit gate |
|---|---|---|
| **0 — Mirror** | Feed live; pack loaded; seeds reproduce the tenant's known-good quotes | Mirror unattended 3 days; full-export replay ±2% aggregate (REQ-165) |
| **1 — Revenue shadow** | Agents compute in parallel on the mirror | **30-day shadow** ±2% aggregate + sampled routes ±10%; invoices match incumbent to the penny; **first clean month-end close** via journal export |
| **2 — Terminal pilot** | One facility runs gated driver flows live, incumbent backstop on | Full day zero-loss → full week <0.5% exceptions; zero-instruction driver test passes (L6) |
| **3 — Money completion** | Interline/partner settlement one full cycle; statements/dunning; partner EDI certified per their calendar | Settlement matches partner statement; **second consecutive clean close** |
| **4 — Parallel → flips** | Company-wide dual-run; authority flips per module (rating → invoicing → dispatch → settlement), auto-fallback armed | 4 weeks parallel <0.5% exceptions → incumbent off daily ops, archived read-only |
Two consecutive clean closes before any money-authority flip is absolute (REQ-153). These are **calendar objects** — shadow windows, close dates, pilot weeks, partner certification queues — and they compress for no one: expect **16–20 weeks from feed-live to incumbent-off, floor ~14**, regardless of build velocity. Quote gates, never weeks (doc 14 §08).

## (05) PILOT FACILITY PATTERN
One facility, chosen in the pack: driver onboarding kit per REQ-164 (QR install → magic link → printed card; the gate is the training) · first-run **location-tracking consent** captured as an event before the first GPS stamp (REQ-166; consent language is pack-side, counsel-reviewed per operating jurisdictions) · a named gate owner seat at the facility · incumbent backstop live for the entire pilot · overrides = name + reason, visible forever (REQ-049).

## (06) WHAT TENANT #0 PROVES (feeds doc 12 §06)
The case-study telemetry (REQ-160) reads entirely from the ledger: unbilled variance from zero · DSO · POD→invoice latency · rating latency · dispute/short-pay rate · close duration · OR. Before-baselines and their sources live in the pack; publication requires the tenant's written consent (pack confirm-ledger item). The five acceptance demos (doc 00) are filmed on tenant-0's real freight — with identity handled per the consent gate, not by default.

## (07) STANDING [CONFIRM] PATTERN (lives in each pack, never here)
Every pack maintains: data-access request status · finance-owner session items (entity structure, code semantics, data flags, baselines, approval matrix) · pilot facility + gate owner · org-facts verification · incumbent contract terms (notice, data ownership, archive rights) · publishing consent. The weekly register ritual (REQ-120) reviews the active pack's confirm-ledger alongside the repo register.
