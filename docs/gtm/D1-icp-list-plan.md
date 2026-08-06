# D-1 — ICP Account List Plan (Vibe Prospecting)
**Status: DECISION REQUIRED — no credits spent, no list built.**
**Gate:** [F1-icp.md](F1-icp.md) (owner-approved 2026-08-02). Every filter below traces to an F-1 row.
**Authority:** REQ-289 (Demand Lane). **Board item:** D-1 (list-building only, no outbound).
**Run date:** 2026-08-02 · **Tool:** Vibe Prospecting MCP connector (Explorium index) · **Spend this run: $0.00 / 0 credits.**

> **Headline:** Vibe *can* reach 5,033 matching US trucking accounts, but the sample says that pool is contaminated with freight-tech vendors and non-asset brokers, and Vibe exposes **no truck-count field at all**. Recommendation in §7 is **do not buy the bulk list** — the ICP's own size band comes from FMCSA, which is free.

---

## 1. What Vibe actually exposes (verified, not assumed)

Every field named in this doc was printed by a live tool schema or response. Nothing here is inferred from the vendor's marketing.

**Business filter keys** — from the `fetch-entities` / `fetch-entities-statistics` `inputSchema.properties.filters.properties` (loaded via ToolSearch, 2026-08-02):

`business_id` · `business_intent_topics` · `city_region` · `company_age` · `company_country_code` · `company_region_country_code` · `company_revenue` · `company_size` · `company_tech_stack_category` · `company_tech_stack_tech` · `events` · `has_website` · `is_public_company` · `naics_category` · `linkedin_category` · `number_of_locations` · `website_keywords`

**Fixed enum values** (quoted verbatim from the same schema):
- `company_size`: `1-10`, `11-50`, `51-200`, `201-500`, `501-1000`, `1001-5000`, `5001-10000`, `10001+`
- `company_revenue`: `0-500K`, `500K-1M`, `1M-5M`, `5M-10M`, `10M-25M`, `25M-75M`, … `10T+`
- `company_age`: `0-3`, `3-6`, `6-10`, `10-20`, `20+`
- `number_of_locations`: `0-1`, `2-5`, `6-20`, `21-50`, `51-100`, `101-1000`, `1001+`

**Output columns** (observed in the live `fetch-entities` / `show-sample` `preview_data`): `business_name`, `business_domain`, `business_website`, `business_country_name`, `business_region`, `business_city_name`, `business_number_of_employees_range`, `business_yearly_revenue_range`, `business_business_description`, `business_naics`, `business_naics_description`, `business_sic_code`, `business_sic_code_description`, `business_business_intent_topics`.

### ⚠️ The field that does not exist
**There is no power-unit / truck-count / fleet-size field in the Vibe schema.** The full filter key list above is exhaustive for businesses. F-1 defines the ICP as **10–100 power units**; Vibe cannot filter on that. Everything below uses **employee count as a proxy**, which is the central weakness of this entire plan (see §7).

---

## 2. ICP → Vibe filter translation

| F-1 dimension | F-1 definition | Vibe filter (verified key) | Status |
|---|---|---|---|
| Industry | US OTR trucking carrier | `naics_category: ["484121","484122","484230"]` | ✅ tested |
| Size | 10–100 trucks | `company_size: ["11-50","51-200"]` — **proxy only** (≥1 office staff per ~8 drivers ⇒ a 10–100 truck carrier lands ~12–130 heads) | ⚠️ proxy |
| Revenue | ~$2M–$25M | `company_revenue: ["1M-5M","5M-10M","10M-25M"]` | ✅ tested (non-binding — see §3) |
| Geography | US, lower-48 | `company_country_code: ["US"]` (HQ only) | ✅ tested |
| Disqualifier: enterprise | >100 trucks / enterprise brokers | `is_public_company: false` + revenue cap at `10M-25M` | ✅ tested (partial) |
| Reachability | outbound needs a domain | `has_website: true` | ✅ tested |
| Geography: few-terminal | "single- or few-terminal" | `number_of_locations: ["0-1","2-5"]` | ⬜ proposed, untested |
| Structural tell: established | legacy TMS / paper POD era | `company_age: ["10-20","20+"]` | ⬜ proposed, untested |
| Trigger layer | growth/pain signals | `events: ["increase_in_operations_department","hiring_in_operations_department","new_office","cost_cutting","merger_and_acquisitions"]` (verbatim enum values) | ⬜ proposed, untested |

**NAICS codes** returned by `autocomplete(field: "naics_category")` and selected against F-1:
- `484121` General Freight Trucking, Long-Distance, Truckload — **core ICP**
- `484122` General Freight Trucking, Long-Distance, LTL — F-1: "LTL or partials a plus"
- `484230` Specialized Freight Trucking, Long-Distance — reefer/flatbed carriers
- *Excluded:* `484110`/`484220` (Local — F-1 is regional/OTR), `484` (parent — see §3), `488510` Freight Transportation Arrangement (pure brokerage = **secondary** ICP, kept separate).

`linkedin_category` was tried first per the skill's category-specificity rule and **rejected** — see §3.

---

## 3. Pool sizing — four free `fetch-entities-statistics` runs

All counts are `counts.records_matching_filters` from live responses. No credits consumed.

| # | Filter set | Matches | Verdict |
|---|---|---|---|
| 1 | `linkedin_category: ["truck transportation"]` + US + size + revenue | **26,439** | Huge but **0/5 sample fit** — rejected |
| 2 | `naics_category: ["484121","484122","484230"]` + US + size + revenue | **2,207** | Precise, **below the 5K target** |
| 3 | `naics: ["484"]` + US + size + revenue + 6 website keywords + `has_website` | **2,269** | Still short |
| 4 | `naics: ["484"]` + US + size + revenue + **16** website keywords + `has_website` | **5,033** | ✅ clears 5K — but **0/5 sample fit** |

**Three findings worth more than the counts:**

1. **`linkedin_category: "truck transportation"` is unusable.** Its 5-row sample returned two industry trade associations, a warehouse-robotics manufacturer, and a tunnelling/infrastructure company — all carrying `business_naics: "484"`. The skill's own specificity test ("would a large share of this category be something other than what was asked?") is answered **yes, empirically**, which is why the plan falls back to 6-digit NAICS.
2. **The revenue filter is non-binding.** Runs 3 and 4 returned *identical* counts with and without `company_revenue` — every company in the NAICS-484 pool already sits inside $1M–25M. Meanwhile run 2's breakdown put only **19 of 2,178** `484121` companies in the `1M-5M` band, which is not credible for a population of 10–100-truck carriers. **Treat `company_revenue` as a modeled, low-trust field.**
3. **Reaching 5,033 costs precision, it doesn't buy it.** The only way to clear the 5K target was to widen back to the noisy `484` parent and rescue it with 16 OR'd website keywords. That pool's sample (§4b) is freight-*tech* and brokers, because vendors write keyword-rich websites and 30-truck carriers do not. **The 5K target and the ICP are in direct tension in this index.**

---

## 4. Free sample (company-level only — no personal contact data)

Retrieved with `fetch-entities` (`mode: "sample"`, masked preview) then `show-sample` for unmasked firmographics. `entity_type: "businesses"` throughout, so **no person, email, or phone was ever requested or returned**.

### 4a. Best available filter — the precise NAICS pool (2,207 matches)

`naics_category: ["484121","484122","484230"]` + `company_country_code: ["US"]` + `company_size: ["11-50","51-200"]` + `company_revenue: ["1M-5M","5M-10M","10M-25M"]` + `is_public_company: false`

| # | Company | State | Size signal (employees / revenue) | NAICS | Fit notes |
|---|---|---|---|---|---|
| 1 | *(name withheld)* | KS | 51-200 / $10M-25M | 484121 | Non-asset managed-services **broker**; arranges LTL/FTL/intermodal/**ocean/air** |
| 2 | *(name withheld)* | IN | 51-200 / $10M-25M | 484121 | **TMS software vendor** for industrial shippers — miscoded, not a carrier |
| 3 | *(name withheld)* | CO | 51-200 / $10M-25M | 484121 | Est. 1983, **"trucking company and brokerage"**, asset-based 3PL, 3 terminals (CO/NY/TX) |
| 4 | *(name withheld)* | PA | 51-200 / $10M-25M | 484230 | 90-yr **specialized/heavy-haul asset carrier**; stepdeck/lowboy, wind-energy |
| 5 | *(name withheld)* | FL | 51-200 / $10M-25M | 484121 | Est. 1991, **asset-based 3PL**; ground + **air + ocean** |

### 4b. The 5,033-account pool — why it was rejected

Same method, filter set #4. Rows returned, by type (company names withheld — see §identity note): **a tunnelling/infrastructure company**, **a digital freight marketplace**, **a freight-decision software vendor**, **an agent-based brokerage**, **a broker-software vendor**. **0 of 5 are asset carriers.** Two are arguably competitors, not prospects.

### ⚠️ Sampling bias — read before trusting §5
All five rows in §4a came back `51-200` employees / `10M-25M` revenue, i.e. the **top of both bands**. But the same run's statistics show **1,802 of 2,207 (82%) of the pool is `11-50` employees**. The default result ordering favours the largest, most data-complete records, so this sample is drawn from the *least* representative — and least ICP-like — 18% of the pool. The true fit rate on the full 2,207 is **unmeasured**; a randomised sample would be needed, and Vibe exposes no random-order control.

---

## 5. ICP gate check (F-1 §"Mechanical gate": size band ✓, US OTR ✓, structural tell ≥1 ✓, no disqualifier ✓)

| # | Company | Size band | US OTR | Structural tell ≥1 | Disqualifier? | Verdict |
|---|---|---|---|---|---|---|
| 1 | *(withheld — KS)* | ✗ non-asset (0 trucks) | ~ US, but ocean/air | ✓ brokerage | ✗ "freight outside OTR" | **FAIL primary** / pass *secondary* (broker ICP) |
| 2 | *(withheld — IN)* | ✗ n/a | ✗ software | ✗ | ✗ not a freight operator | **HARD FAIL** |
| 3 | *(withheld — CO)* | ✓ plausible (UNVERIFIED trucks) | ✓ nationwide TL | ✓✓ asset carrier **+ brokerage arm**, multi-terminal | none found | **PASS — bullseye** |
| 4 | *(withheld — PA)* | ~ heavy-haul national, plausibly **>100 units** (UNVERIFIED) | ✓ specialized OTR | ✓ asset carrier | ⚠ risks ">100 trucks" | **PARTIAL** |
| 5 | *(withheld — FL)* | ✓ plausible (UNVERIFIED) | ~ ground + air/ocean | ✓ asset-based + 3PL hybrid | ⚠ multimodal beyond OTR | **PARTIAL** |

**Fit estimate on this 5-row sample:**

| Measure | Rate |
|---|---|
| Strict primary ICP (hybrid regional asset carrier + brokerage) | **1/5 = 20%** |
| Asset carrier, OTR-centric (PASS + PARTIAL) | **3/5 = 60%** |
| Any F-1 ICP incl. secondary brokerage | **4/5 = 80%** |
| Hard fail — not a freight operator at all | **1/5 = 20%** |

**Confidence: LOW.** n=5, non-random, drawn from the unrepresentative top of the size band (§4b). Use 20–60% as a *planning range*, not a measured yield. **Not one row's actual truck count was verified — that field does not exist in this dataset.**

---

## 6. Cost to build the full list — owner decision

**Unit rate (verified):** `estimate-cost` on the 5-row table returned `cost: 5`, `"5 fetch = 5 credits"`, `enrichmentCount: 0` ⇒ **1 credit per account row**, fetch only.
**Current balance (verified):** `remaining_user_credits: 195`.
**Plans** (verbatim from `show-pricing-plans`; all are **one-time purchases, credits valid 365 days**):

| Plan | Credits | Price | $/credit |
|---|---|---|---|
| Plus | 900 | $29.90 | $0.0332 |
| Boost | 3,000 | $89.99 | $0.0300 |
| Ultra | 8,000 | $199.99 | $0.0250 |
| Elite | 30,000 | $649.99 | $0.0217 |

| Option | Rows | Credits needed (net of 195 held) | Cheapest purchase | **Cost** |
|---|---|---|---|---|
| **A — the 5,033 "≥5K target" list** | 5,033 | 4,838 | Boost ×2 (6,000) | **$179.98** |
| | | | *or* Ultra ×1 (8,000) | *$199.99* |
| **B — the 2,207 precise-NAICS list** | 2,207 | 2,012 | Boost ×1 (3,000) | **$89.99** |
| **C — pilot: 500 accounts** | 500 | 305 | Plus ×1 (900) | **$29.90** |

**Enrichment / contacts are extra and NOT priced above.** The `estimate-cost` documentation shows `costPerEnrichment: 1` (per row, per enrichment), which would add ~2,207 credits (≈$55–66) to enrich option B once. That per-enrichment rate is **UNVERIFIED** — it comes from the tool's documented example, not from a live enrichment call on our data (running one was avoided to hold spend at $0). Contact-level (prospect) enrichment is unpriced here by design: D-1 is list-building only and personal contact data is out of scope for this document.

**Bottom line: $180 (option A) or $90 (option B) buys a list whose measured strict-ICP fit is 20% and whose defining ICP attribute — truck count — is absent.** Option A costs 2× option B for a pool that sampled *worse*.

---

## 7. Recommendation: **do not buy the Vibe bulk list. Use FMCSA (free) as the spine.**

**1. Vibe cannot see the one number the ICP is built on.** F-1 defines the segment as 10–100 power units and cites the FMCSA band (≈42K carriers ≈7.2%). **FMCSA publishes power-unit counts per carrier for free** (SAFER / Company Census / L&I files), with authoritative DOT#/MC#, operating status, cargo class, and state. That is a *direct measurement* of the ICP gate, not a proxy — and it is $0. Spending $180 on an employee-count proxy when the authoritative source is free is the wrong trade.

**2. Waiting for Apollo re-auth does not solve this either — but it is free.** Apollo re-auth is owner-lane #1, a ~2-minute action, and the account already exists (`$0` marginal). Apollo's firmographic model is the same employee-count paradigm, so it will hit the *same* truck-count wall — but it will not cost $180 to discover that, and it is the stronger contact-enrichment layer once the account spine exists.

**3. Sequence that spends nothing:**
   1. **FMCSA census → the spine.** Filter power units 10–100, US, interstate, active authority. This *is* the F-1 mechanical gate, mechanically applied, with no proxy and no fee.
   2. **Apollo (after re-auth, $0 marginal)** → domain + firmographic + buying-committee resolution on that spine.
   3. **Vibe only where it is genuinely differentiated** — not as a list source. Its real edge is the signal layer no free source has: `business_intent_topics` and the `events` enum (`increase_in_operations_department`, `hiring_in_operations_department`, `new_office`, `cost_cutting`, `merger_and_acquisitions`). Buying **Plus at $29.90** to trigger-score an already-built FMCSA spine is a defensible ~$30 experiment. Buying a $180 bulk list is not.

**4. If the owner wants a Vibe list anyway:** take **option B ($89.99, 2,207 accounts, precise NAICS)** over option A. It is half the price and sampled better. Do **not** take option A — the extra $90 buys 2,826 additional rows drawn from the pool that sampled 0/5 asset carriers.

**5. Do not treat 5,033 as "the ICP TAM."** F-1's own ≈42K-carrier FMCSA band is ~8× larger. The 5,033 is a Vibe-index coverage artifact, not a market size.

---

## 8. Compliance and caveats

**Falsifier check — all four clear:**

| Falsifier | Result |
|---|---|
| (a) Any call spends credits/money | ✅ **PASS — $0.00 / 0 credits.** `show-pricing-plans` and `estimate-cost` were called *before* any data call. Only `export-to-csv` is documented as "**Consumes credits**" and it was **never called**. `fetch-entities` ran in `mode: "sample"` (masked preview); the `show-sample` schema states "Exploration is free". Balance verified unchanged at **195 credits**. |
| (b) Invented field name | ✅ **PASS** — every filter key and enum value in §1–§2 is quoted from a live `inputSchema` or response; §2 marks tested vs. proposed. |
| (c) Personal contact data in doc | ✅ **PASS** — `entity_type: "businesses"` on every call. No prospect/person/email/phone was requested, returned, or recorded. All rows are company-level. |
| (d) Fit % without per-row gate check | ✅ **PASS** — §5 shows the four-part F-1 gate per row before any percentage, and labels confidence LOW with the sampling bias stated. |

**Method deviation (disclosed):** the skill's Claude Code guide prefers the `vpai` CLI, but `vpai whoami` returned `authenticated: false` and this session is non-interactive (no browser OAuth). The authenticated Vibe Prospecting **MCP connector** was used instead. All other skill rules were followed: schemas read before first call, `autocomplete` before `naics_category`/`linkedin_category`, one session (`session_64_strong_ferrets_madly_knitted`), stats before sample, `show-sample` before reporting.

**REQ-167 note — RESOLVED 2026-08-02 (tick 7):** this file originally named ten sampled companies (five in §4a/§5, five in §4b). All are now **withheld**; state and type descriptors carry the analysis. Rationale: no denylist was available locally (`IDENTITY_DENYLIST` unset), the identity-leak lint scans `git ls-files` only so this untracked file was unscanned, and one sampled row was a TMS vendor — the most likely denylist collision. Withholding removes the class of risk rather than betting on a check that could not run. **Standing rule:** company names live in the CRM, never in `docs/`.

**Unverified items** carried forward: exact truck counts for every sampled row · per-enrichment credit rate · true fit rate across the full 2,207 pool · whether `number_of_locations`, `company_age`, `events`, and `business_intent_topics` improve precision (proposed, never run).
