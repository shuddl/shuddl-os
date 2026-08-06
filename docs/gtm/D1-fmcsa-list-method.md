# D-1 — FMCSA Free-Data List Method
### The zero-cost replacement for the rejected paid-vendor list purchase

**Status: METHOD VERIFIED, EXECUTABLE.** Every URL below was fetched live on **2026-08-02**; every field name was read out of official FMCSA documentation or a live API response; every count was computed by running the filter against the live dataset.
**Gate:** [F1-icp.md](F1-icp.md) (owner-approved 2026-08-02). Every filter row traces to an F-1 dimension.
**Replaces:** [D1-icp-list-plan.md](D1-icp-list-plan.md) §7 recommendation ("do not buy the Vibe bulk list — use FMCSA as the spine"). That doc's core finding was correct: the paid index exposes **no truck-count field**. FMCSA does.
**Spend on this run: $0.00.** No key was purchased, no credit consumed, no paid endpoint touched.

> **Headline:** The ICP's defining attribute — power units — is published free, per carrier, daily, by FMCSA. Running F-1's mechanical gate against it yields **23,623 US interstate for-hire carriers with 10–100 power units, OTR-relevant cargo, and a contact email already on file** — 4.7× the 5,000-account target, at zero cost, with the size band *measured* rather than proxied.

---

## 1. Sources — verified reachable 2026-08-02

Every row was probed this session. Status is what the server actually returned, not what a doc claims.

| # | Source | URL | Probe result |
|---|---|---|---|
| **S1** | **Company Census File** (the spine) | `https://data.transportation.gov/api/views/az4n-8mr2.json` | ✅ **200** — 4,478,177 rows; `X-SODA2-Truth-Last-Modified: Sat, 01 Aug 2026` |
| S1a | — bulk CSV | `https://data.transportation.gov/api/views/az4n-8mr2/rows.csv?accessType=DOWNLOAD` | ✅ **200**, `Content-disposition: attachment; filename=Company_Census_File.csv` |
| S1b | — SODA query API | `https://data.transportation.gov/resource/az4n-8mr2.json` | ✅ **200** — ~45 filtered queries run this session, no 429 |
| S1c | — **official data dictionary** (PDF, 89 pp) | `https://data.transportation.gov/api/views/az4n-8mr2/files/05274d1b-8109-4409-a4ef-237e12f870c9` | ✅ **200** — *"MCMIS Company Census Data Dictionary(Rev08)2026-01-23.pdf"* |
| S1d | — human landing page | `https://catalog.data.gov/dataset/company-census-file` | ✅ **200** — last updated 2026-07-30 |
| **S2** | **SMS Input – Motor Carrier Census** (monthly, independent cross-check) | `https://data.transportation.gov/resource/kjg3-diqy.json` | ✅ **200** — **2,085,534 rows** |
| **S3** | **Carrier – All With History** (legacy L&I operating authority) | `https://data.transportation.gov/resource/6eyk-hxee.json` | ✅ **200** — 1,860,604 rows, tabular, `broker_stat` present |
| S3a | — flat-file twin | `https://data.transportation.gov/api/views/u4i8-4m26.json` | ✅ **200** but **non-tabular blob** (`carrier_allwithhistory.txt`) — SODA queries return *"no row or column access to non-tabular tables"*. Use S3, not this. |
| **S4** | **Motus Carrier – All With History** (post-modernization authority) | `https://data.transportation.gov/resource/inys-ebih.json` | ✅ **200** — 98,331 rows, `op_auth_type` present |
| S4a | — Motus Carrier (**daily delta only**) | `https://data.transportation.gov/resource/nakq-58th.json` | ✅ **200** — **382 rows.** This is a *Daily Difference* file. Do not mistake it for the full population. |
| **S5** | **SAFER Company Snapshot** (per-carrier spot check) | `https://safer.fmcsa.dot.gov/CompanySnapshot.aspx` | ✅ **200** |
| S5a | — direct query form | `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=<DOT>` | ✅ **200** — live snapshot retrieved and parsed (see §2.4) |
| **S6** | **A&I Registration Statistics** (the published statistic) | `https://ai.fmcsa.dot.gov/RegistrationStatistics` | ✅ **200** — MCMIS snapshot date **06/26/2026** |
| **S7** | **L&I public portal** (per-carrier authority/insurance) | `https://li-public.fmcsa.dot.gov/LIVIEW/pkg_menu.prc_menu` | ✅ **200** |
| **S8** | **QCMobile API** developer portal | `https://mobile.fmcsa.dot.gov/QCDevsite/docs/getStarted` | ✅ **200** — base URL `https://mobile.fmcsa.dot.gov/qc/services/` |
| **S9** | FMCSA Open Data Program (the terms + dataset index) | `https://www.fmcsa.dot.gov/registration/fmcsa-data-dissemination-program` | ⚠️ **403 to every automated client** (Akamai edge block; browser UA also refused). Content verified via Wayback snapshot **2026-07-31** — see §6. |

### ⚠️ Dead URL — do not carry a 2023-era runbook forward
`https://ai.fmcsa.dot.gov/SMS/Tools/Downloads.aspx` and `https://ai.fmcsa.dot.gov/SMS/Data/Downloads.aspx` — **both now 302-redirect** to `www.fmcsa.dot.gov/registration/fmcsa-data-dissemination-program#collapse28721`, which then 403s automated clients. These were the canonical bulk-download pages in older guides. **They are no longer download endpoints.** The live path is the DOT Open Data Portal (S1/S2/S3/S4). This is exactly the failure mode the brief warned about, and it is real.

---

## 2. Fields — what each source actually gives you

### 2.1 S1 Company Census File — 147 columns
Field names below are quoted from the live Socrata schema (`/api/views/az4n-8mr2.json` → `columns[].fieldName`); definitions and code values are quoted from **S1c, the MCMIS Company Census File Data Dictionary Rev 8, dated 1/23/2026**.

| Field | Data-dictionary definition (verbatim) | ICP role |
|---|---|---|
| **`power_units`** | *"TOTAL NUMBER OF POWER UNITS"*, `8N` | **The ICP gate.** This is the number the paid index does not have. |
| **`total_drivers`** | *"# DRIVERS / GRAND TOTAL (INTERSTATE AND INTRASTATE)"*, `6N` | Structural tell (staff-per-driver ratio) |
| `driver_inter_total` | *"# DRIVERS / INTERSTATE TOTAL"*, `6N` | OTR confirmation |
| `total_cdl` | *"# DRIVERS / TOTAL WITH COMMERCIAL DRIVERS LICENSE"*, `5N` | — |
| `truck_units` / `bus_units` | *"TOTAL NUMBER OF TRUCKS"* / *"…BUSES"* | Passenger-carrier exclusion |
| `owntract` / `owntruck` / `owntrail` | owned tractors / trucks / trailers | Asset-carrier proof (vs non-asset broker) |
| **`status_code`** | *"A = ACTIVE, I = INACTIVE, P = Pending"*, `1A` | Active filter |
| **`carrier_operation`** | `A` = *"OPERATION / CARRIER / INTERSTATE"* · `B` = *"…INTRASTATE / HAZMAT"* · `C` = *"…INTRASTATE / NON-HAZMAT"* | Interstate/OTR filter |
| **`classdef`** | *"CLASSIFICATION CATEGORY … If multiple then included with semicolon (;) separator"* — values include `AUTHORIZED FOR HIRE`, `EXEMPT FOR HIRE`, `PRIVATE PROPERTY`, `PRIVATE PASSENGER, BUSINESS` | For-hire filter |
| **`crgo_*`** (30 flags) | e.g. `CRGO_GENFREIGHT` = *"CARGO TRANSPORTED A. GENERAL FREIGHT"*, `1A`, value **`X`** | Cargo-class filter |
| `docket1prefix`/`docket1` … `docket3` + `docket*_status_code` | *"DOCKET NUMBER STATUS — A = ACTIVE, I = INACTIVE"* | MC-number / authority presence |
| **`phone`**, `cell_phone`, `fax` | — | Contact (see §5 for the compliance caveat) |
| **`email_address`** | *"EMAIL ADDRESS"*, `80 A/N` | Contact — **populated on 98.3% of gated rows** |
| `legal_name`, `dba_name` | — | Identity |
| `phy_street/city/state/zip/country/cnty` | *"PHYSICAL ADDRESS/STATE CODE"* etc. | Geography |
| `company_officer_1`, `company_officer_2` | — | **A named individual — see §5 and §6.3** |
| `mcs150_date`, `mcs150_mileage`, `mcs150_mileage_year` | biennial-update date + reported annual mileage | Freshness + revenue proxy |
| `safety_rating`, `recordable_crash_rate`, `review_date` | — | Not used for ICP |

**Verified value encodings (live `$group` queries, not assumed):**
- `status_code`: `A` 2,231,939 · `I` 2,245,259 · `P` 979
- `carrier_operation`: `A` 2,457,355 · `C` 1,629,910 · `B` 58,602 · null 332,310
- `classdef`: `AUTHORIZED FOR HIRE` 1,967,302 · `PRIVATE PROPERTY` 1,352,788 · `PRIVATE PROPERTY;AUTHORIZED FOR HIRE` 195,497 · `EXEMPT FOR HIRE` 154,616 · … (semicolon-combined — **you must use `LIKE '%AUTHORIZED FOR HIRE%'`, not `=`**)
- `crgo_genfreight`: **`X`** 895,975, else null. `crgo_coldfood`: `X` 72,330. `crgo_passengers`: `X` 58,642.

### 2.2 S2 SMS Input census — 42 columns, the independent cross-check
`dot_number, legal_name, dba_name, carrier_operation, hm_flag, pc_flag, phy_*, mailing_*, telephone, fax, email_address, mcs150_date, mcs150_mileage, mcs150_mileage_year, add_date, oic_state, `**`nbr_power_unit`**`, `**`driver_total`**`, recent_mileage, recent_mileage_year, vmt_source_id, private_only, `**`authorized_for_hire`**`, exempt_for_hire, private_property, private_passenger_business, private_passenger_nonbusiness, migrant, us_mail, federal_government, state_government, local_government, indian_tribe, op_other`

Dataset description (verbatim): *"contains the FMCSA registration data of all active Interstate and Intrastate Hazmat Motor Carriers… number of power units, number of drivers, mileage… One carrier per row."* Classification flags here are **booleans stored as text** (`'true'`/`'false'`) — `authorized_for_hire='true'` works, `=true` throws a type-mismatch.

### 2.3 S3/S4 Operating authority — the brokerage-arm tell
F-1's primary ICP is *"asset carrier **with (or building) a brokerage arm**"*. The census file shows *that* a carrier has MC dockets but not *what kind* of authority each is. Authority type lives here:

- **S3 (legacy, 1,860,604 rows):** `docket_number, dot_number, mx_type, `**`common_stat, contract_stat, broker_stat`**`, common_app_pend, contract_app_pend, broker_app_pend, common_rev_pend, contract_rev_pend, broker_rev_pend, property_chk, passenger_chk, hhg_chk, private_auth_chk, enterprise_chk, min_cov_amount, cargo_req, bond_req, bipd_file, cargo_file, bond_file, undeliverable_mail, dba_name, legal_name, bus_*, mail_*`
  Verified: `broker_stat` = `N` 1,743,871 · `I` 91,652 · **`A` 25,081** (25,072 distinct DOT numbers).
- **S4 (Motus, 98,331 rows):** `docket_number, usdot_number, rfc_number, `**`op_auth_type, op_auth_status`**`, min_cov_amount, cargo_req, bond_req, bipd_file, cargo_file, bond_file, …, bus_telno, …`
  Verified `op_auth_type` values: `Motor Carrier of Property (Except Household Goods)` · `Broker of Property (Except Household Goods)` · `Motor Carrier of Household Goods` · `Freight Forwarder of Property…` · `Motor Carrier of Passengers` · `Enterprise Motor Carrier…` · `Mexico Domiciled…`. `op_auth_status`: `Active` / `Inactive` / `Pending` / `Withdrawn`.

### 2.4 S5 SAFER Company Snapshot — per-carrier verification, no bulk
A live snapshot was retrieved this session and its **field labels** parsed (values discarded, no identity recorded). Labels present:

`Entity Type · New Entrant Status · USDOT Status · Out of Service Date · USDOT Number · State Carrier ID Number · Operating Authority Status · AUTHORIZED FOR · Legal Name · DBA Name · Physical Address · Phone · Mailing Address · DUNS Number · `**`Power Units`**` · Non-CMV Units · `**`Drivers`**` · Operation Classification · Carrier Operation · Cargo Carried · Total Inspections · Crashes · Carrier Safety Rating · Rating Date · Review Date`

**Confirmed present:** Power Units ✅, Drivers ✅, Carrier Operation ✅, Cargo Carried ✅, Phone ✅. **Confirmed absent: Email ❌.** SAFER is a *verification* tool (one carrier at a time, HTML), not a list source. The bulk equivalent is S1, which additionally carries email.

### 2.5 What NO FMCSA source provides
- **A named decision-maker with a role.** `company_officer_1/2` is a name with no title, no role, no direct line, and is frequently the registered agent or the owner-operator themselves.
- **A company website / domain.** Nothing in any of the four files.
- **Revenue, employee count, TMS in use, factoring relationship.** `mcs150_mileage` is the only economic signal.
- **Any brokerage volume figure.**
See §5.

---

## 3. Filter recipe — F-1 → FMCSA fields

Every row maps to an F-1 dimension. Nothing is a proxy; the size band is measured.

| F-1 dimension | F-1 definition | FMCSA predicate (S1) | Type |
|---|---|---|---|
| **Size** | 10–100 trucks | `(power_units::number) between 10 and 100` | ✅ **direct measurement** |
| Ops profile | US OTR / interstate | `carrier_operation = 'A'` | ✅ direct |
| Ops profile | for-hire (not private fleet) | `classdef LIKE '%AUTHORIZED FOR HIRE%'` | ✅ direct |
| Active | operating today | `status_code = 'A'` | ✅ direct |
| Geography | US, lower-48 | `phy_country='US' AND phy_state NOT IN ('AK','HI','PR','VI','GU','MP','AS')` | ✅ direct |
| Ops profile | dry van / reefer / flatbed; LTL or partials a plus | `crgo_genfreight='X' OR crgo_coldfood='X' OR crgo_metalsheet='X' OR crgo_bldgmat='X' OR crgo_machlrg='X' OR crgo_beverages='X' OR crgo_paperprod='X' OR crgo_produce='X' OR crgo_drybulk='X' OR crgo_meat='X' OR crgo_construct='X' OR crgo_intermodal='X'` | ✅ direct |
| **DQ:** freight outside OTR | ocean/air/parcel/warehouse; passengers; household goods | `crgo_passengers IS NULL AND crgo_household IS NULL AND crgo_garbage IS NULL AND crgo_drivetow IS NULL AND crgo_usmail IS NULL AND crgo_oilfield IS NULL AND crgo_waterwell IS NULL AND crgo_mobilehome IS NULL` | ✅ direct |
| **DQ:** >100 trucks | enterprise | upper bound of the size predicate | ✅ direct |
| **DQ:** 1–5 truck owner-op | too little back office | lower bound of the size predicate | ✅ direct |
| Reachability | outbound needs an address | `email_address IS NOT NULL` | ✅ direct |
| **Hybrid tell** | *"with (or building) a brokerage arm"* | join S3 on `broker_stat='A'` ∪ S4 on `op_auth_type LIKE '%Broker%' AND op_auth_status='Active'` | ✅ direct (see §4) |
| Freshness | record is maintained | `mcs150_date > '20240801'` (biennial update filed in last 24 mo) | ✅ direct |
| Revenue ~$2M–$25M | — | ⬜ **not directly available.** `mcs150_mileage` is the only proxy; not used in the headline count. |
| Current stack (legacy TMS, paper POD) | — | ⬜ **not available from FMCSA.** Enrichment or discovery-call question. |

### Four gotchas that will silently produce a wrong list
1. **`power_units` is stored as `text`**, not a number. `power_units >= '10'` sorts lexicographically and is wrong (`'9' > '100'`). You **must** cast: `(power_units::number)`.
2. **Cargo flags are `'X'`, not `'Y'`.** The first pass of this analysis used `='Y'` and returned **0 rows** — a silent, plausible-looking zero.
3. **L&I zero-pads `dot_number` to 8 characters** (`00107080`) while the census file does not (`284984`). A naive join returns **0 matches** — it did here, on the first attempt. Strip leading zeros on both sides before joining. L&I docket numbers are likewise `MC009153` where the census stores `docket1prefix='MC'`, `docket1='181415'`.
4. **`classdef` is semicolon-multi-valued.** `classdef = 'AUTHORIZED FOR HIRE'` drops the 195,497 `PRIVATE PROPERTY;AUTHORIZED FOR HIRE` rows and 68,908 `AUTHORIZED FOR HIRE;EXEMPT FOR HIRE` rows. Use `LIKE`.

---

## 4. How many accounts survive — measured, not estimated

All counts below were produced by running the predicates against the live S1 dataset on **2026-08-02** (S1 truth-modified 2026-08-01; A&I MCMIS snapshot 06/26/2026).

### 4.1 The funnel

| Step | Predicate added | Surviving | Δ |
|---|---|---|---|
| 0 | all rows in S1 | 4,478,177 | — |
| 1 | `status_code='A'` + `power_units ≥ 1` | 1,993,576 | |
| 2 | `power_units` 10–100 (any class, any operation) | **104,047** | −94.8% |
| 3 | + `carrier_operation='A'` + `classdef LIKE '%AUTHORIZED FOR HIRE%'` + `phy_country='US'` | **35,956** | −65.4% |
| 4 | + OTR cargo classes | 29,716 | −17.4% |
| 5 | + disqualifier cargo exclusions | 24,019 | −19.2% |
| 6 | + lower-48 + `email_address IS NOT NULL` | **23,623** | −1.7% |
| 7 | *(optional)* + has an MC docket | 23,133 | −2.1% |

### **→ 23,623 accounts. Target was ≥5,000. Achieved 4.7×, at $0.00.**

> **Independently re-derived by the parent loop, 2026-08-03** — the agent's figures were not taken on trust. Re-queried live against `data.transportation.gov/resource/az4n-8mr2.json`:
>
> | Funnel step | Agent reported | Re-derived | Delta |
> |---|---|---|---|
> | Step 2 — active, 10–100 power units | 104,047 | **104,063** | +16 (2 days of daily updates) |
> | Step 3 — + interstate + authorized-for-hire + US | 35,956 | **35,965** | +9 (same drift) |
> | Email coverage at step 3 | "98.3% of rows" | **98.28%** (35,346 / 35,965) | matches |
>
> **The lexicographic trap is real and material.** Querying `power_units >= '10' AND <= '100'` as text returns **14,308** where the correct numeric cast returns **104,063** — a **7× undercount** that produces a plausible-looking list instead of an error. The doc's warning is not theoretical.
>
> One caveat recorded honestly: steps 4–5 (cargo-class filters) were not re-run, so **23,623 is verified by construction rather than end-to-end** — every step that was re-derived reproduced within daily-update drift, and the two independent cross-checks (step 3 count and email coverage) both landed. *(I also reproduced the silent-failure mode myself while doing this: a double-encoded `%` wildcard returned a confident `0` rather than an error.)*

### 4.2 Tiers within the list

| Tier | Definition | Count | Share |
|---|---|---|---|
| **T1 — hybrid regional (F-1 bullseye)** | list ∩ **active broker authority** (S3 `broker_stat='A'` ∪ S4 Motus active broker) | **793** | 3.4% |
| T2 — multi-docket (weaker hybrid tell) | ICP gate + `docket2 IS NOT NULL` | 2,116 | — |
| T3 — core band | list, `power_units` 10–49 | 20,469 | 86.6% |
| T4 — upper band | list, `power_units` 50–100 | 3,154 | 13.4% |
| Freshness | list, MCS-150 filed since 2024-08-01 | 22,453 | **95.0%** |
| Phone on file | core gate (step 3) with `phone` | 35,766 / 35,956 | 99.5% |
| Email on file | core gate (step 3) with `email_address` | 35,337 / 35,956 | 98.3% |

**T1 is the honest headline for the *primary* ICP.** F-1's bullseye is a carrier *with* a brokerage arm; only **793** of the 23,623 provably hold active broker authority. The other 22,830 satisfy every other F-1 criterion and include the "**or building**" half of F-1's phrasing, which is by definition not yet visible in a registration file. Sequence T1 first.

**Top 10 states** (list, by `phy_state`): IL 2,896 · CA 2,333 · TX 2,139 · OH 1,773 · PA 1,266 · IN 895 · MI 798 · WI 655 · NC 640 · FL 633.

### 4.3 Traceability to a published FMCSA statistic

**Anchor.** A&I Registration Statistics (S6), MCMIS snapshot **06/26/2026**, publishes: **2,085,534 Carriers · 9,343,680 Drivers · 8,467,034 Vehicles**.

**The anchor and the file agree exactly.** S2 (SMS Input – Motor Carrier Census) returned `count(*)` = **2,085,534** — the identical figure. The dataset I am filtering *is* the dataset behind the published statistic.

**Independent replication of the core gate.** The same gate run on S2's differently-named fields (`nbr_power_unit`, `authorized_for_hire='true'`, `carrier_operation='A'`, `phy_country='US'`) returns **34,419** vs S1's **35,956** — a **4.3% spread**, explained by S2 being a monthly snapshot against S1's daily file, and by S2's single boolean flag vs S1's semicolon-combined `classdef`. Two FMCSA files, two schemas, one answer within 4%.

**Reconciliation with F-1's own market number.** F-1 states *"FMCSA band ≈ 42K carriers ≈ 7.2% of carriers."* Measured against the active interstate for-hire population with at least one power unit:

| Band | Count | Share |
|---|---|---|
| 1–9 power units | 426,512 | 91.5% |
| **10–100 power units** | **35,956** | **7.71%** |
| >100 power units | 3,654 | 0.78% |
| total | 466,122 | 100% |

**7.71% measured vs 7.2% claimed in F-1 — the numbers reconcile.** F-1's "≈42K" is ~17% above the 35,956 measured today, consistent with a slightly wider base (e.g. including `EXEMPT FOR HIRE`, which would add carriers, or a different snapshot). **F-1 does not need correcting; note only that the precise, current, filterable figure is 35,956 before cargo filters and 23,623 after.**

> Do **not** restate 104,047 as the ICP TAM. That figure includes private fleets and intrastate carriers, which F-1 disqualifies.

---

## 5. The enrichment gap — what FMCSA will not give you

FMCSA gives you a **verified account list with a company-level mailbox**. It does not give you a buying committee.

| F-1 buying-committee role | FMCSA coverage | Gap |
|---|---|---|
| Economic buyer — owner/GM | `company_officer_1/2` = a bare name, no title; often the registered agent | **No role, no direct line, no personal email** |
| Champion — ops/dispatch manager | none | **Total gap** |
| Must-not-hate — drivers | `total_drivers` count only | n/a for outreach |
| Influencer — bookkeeper / factoring | none | **Total gap** |
| Company domain / website | **none in any FMCSA file** | Blocks domain-keyed enrichment until derived |

Also absent and needed by F-1's "structural tells": current TMS, factoring relationship, office-staff count, detention exposure. None are federal filings.

### Cheapest legitimate path to close it

**Step A — derive the domain for free, before spending anything.** `email_address` is present on 98.3% of gated rows. The domain is the part after the `@`. Every non-freemail domain is the company's own domain, obtained at zero cost — which converts the FMCSA spine into an **Apollo-ready, domain-keyed account list** without buying a single enrichment. Freemail addresses (gmail/yahoo/aol/outlook) mark small operators; segment them out rather than enriching them.

**Step B — Apollo, once re-authorized. $0 marginal.** Per [D1-icp-list-plan.md](D1-icp-list-plan.md) §7.2, the Apollo account already exists and re-auth is owner-lane #1 (~2 minutes). Bulk-enrich the domain list to resolve titles and buying-committee contacts.
> ⛔ **Blocked this session.** The Apollo.io connector reports **unauthenticated**, and this session is non-interactive (no OAuth flow). Apollo enrichment could not be executed or priced against real data here. **Owner action: authorize the Apollo.io connector in claude.ai connector settings.** Do not assume a credit cost — measure it against 100 accounts first.

**Step C — do not re-buy what FMCSA already gave you.** The rejected purchase was $89.99–$199.99 for an account list whose defining attribute was absent (D-1 §6). That list is now free and *better* — the size band is measured. Any future paid tool must justify itself on the **signal layer only** (intent/hiring/M&A events), never on account discovery.

**Sequence: FMCSA spine (free, done) → domain extraction (free) → Apollo contact resolution ($0 marginal) → paid signal layer (optional, ≤$30, only if it earns it).**

---

## 6. Compliance — keys, limits, and terms

### 6.1 Registration and API keys

| Path | Key required? | Cost |
|---|---|---|
| **S1–S4 bulk CSV download** | **No.** Anonymous HTTP GET returned 200. | **$0** |
| **S1–S4 SODA query API** | **No key required**, but a free Socrata app token is recommended (below). | **$0** |
| S5 SAFER web query | No | $0 |
| S7 L&I portal | No | $0 |
| **S8 QCMobile API** | **Yes** — a WebKey. Per S8: *"Access to FMCSA API resources uses an API webkey for authentication. A webkey must be included as a query parameter in all API calls."* Obtain via **Login.gov account → My WebKeys → Get a new WebKey**, supplying application name, **application type (commercial / non-commercial / academic)**, estimated user count, description, and a self-chosen client secret. | **$0** (no fee stated) |

**No FMCSA path in this method requires payment.** The FMCSA Open Data Program page (S9) states verbatim: *"The Federal Motor Carrier Safety Administration (FMCSA) shares the FMCSA regulated entity census and safety performance information **at no charge to the public**."* Nothing in §1–§4 was paywalled, and nothing was purchased.

### 6.2 Rate limits

- **Socrata / DOT Open Data Portal (S1–S4).** Per Socrata's own developer documentation (`https://dev.socrata.com/docs/app-tokens.html`, fetched 2026-08-02): requests without an app token *"come from a shared pool via IP address"* with *"a much lower throttling limit for all requests originating from your IP address"*; with a token, *"we do not throttle API requests that are using an application token, unless those requests are determined to be abusive or malicious."* Throttling returns HTTP **429**. **No numeric limit is published.** Empirically: ~45 filtered queries plus two full-list paginations (23,623 + 25,072 + 2,825 rows) ran unauthenticated this session with **zero 429s**. Register a free app token before any recurring job.
- **QCMobile API (S8).** **No rate limit, quota, or throttling policy is published.** The `getStarted` and `apiAccess` pages were both read in full (live and via a 2026-04-22 archive) and neither states a limit. **Treat this as unknown, not as unlimited.** If QCMobile is used at volume, ask FMCSA directly.
- **SAFER / L&I HTML (S5, S7).** No published limit; these are interactive web apps. Use for spot verification only, never for bulk. Scraping them at volume is both fragile and impolite when S1 exists.

### 6.3 Terms of use — the honest answer

**What FMCSA actually says.** The only terms text FMCSA attaches to these datasets is a **disclaimer of warranty and liability**, quoted verbatim from S9 (Wayback snapshot 2026-07-31):

> *"Each of the datasets identified in this document is provided as a public service by the Federal Motor Carrier Safety Administration (FMCSA) to enhance public access to information. This information is constantly changing. The datasets are only a snapshot of the data at the time the datasets were generated. All information provided by FMCSA is for informational purposes only and does not constitute a legal contract between the FMCSA and any person or entity unless otherwise specified. The information provided by FMCSA is not intended as, nor offered as, legal advice. In no event shall the FMCSA, nor any of its employees, be responsible or liable, directly or indirectly, for any damage or loss caused, or alleged to be caused, by or in connection with the use of or reliance on any such content, goods, or services available in the datasets identified in this document."*

**Findings:**

1. **No use restriction is stated.** The disclaimer limits FMCSA's *liability*; it does not limit the licensee's *use*. There is no non-commercial clause, no redistribution clause, no attribution requirement, and no acceptable-use policy attached to S1–S4.
2. **License field: "unknown".** The Socrata metadata for S1 and S3 records `"License": "https://project-open-data.cio.gov/unknown-license/"` and `"Public Access Level": "public"`. Under Project Open Data, "unknown-license" on a federal dataset reflects that **US Government works are not subject to domestic copyright (17 U.S.C. §105)** — there is nothing to license. It is *not* a restriction, but it is also not an affirmative grant, and the absence of an explicit open license is worth an owner-level note.
3. **FMCSA knows its data is used for solicitation and has not prohibited it.** FMCSA's own applicant-warning page states: *"These businesses obtain your company's information when you submit an application or update your information with FMCSA, because your basic carrier information is publicly available."* The page's objections are to **fraud and misrepresentation** — impersonating FMCSA, charging for free forms, robo-calls — not to contacting carriers. ⚠️ **Freshness caveat:** the live page 403s to automated clients; this quote is from a **2021-10-26 Wayback snapshot**. The substance is corroborated by the 2026 Open Data Program text, but **the exact current wording is unverified.**
4. **Federal marketing law binds you regardless of FMCSA's silence.**
   - **CAN-SPAM applies with no B2B carve-out.** Per the FTC's own compliance guide (fetched live 2026-08-02): *"The law makes no exception for business-to-business email. That means all email … must comply with the law."* *"Each separate email in violation of the CAN-SPAM Act is subject to penalties of up to $53,088."* Required: truthful headers, truthful subject line, **clear ad disclosure**, **valid physical postal address**, **working opt-out honored promptly**, and responsibility for anyone you hire. CAN-SPAM does **not** require prior consent — cold email to these addresses is lawful *if the seven requirements are met*. Bake the postal address and one-click opt-out into the template before the first send.
   - **Telemarketing: mostly exempt, with a trap.** Per the FTC's TSR guide (fetched live 2026-08-02): *"Most phone calls between a telemarketer and a business are exempt from the TSR."* SHUDDL is durable software, so the nondurable-office-supplies carve-out does not apply. **But** the same guide warns that *"telemarketing calls that solicit consumers at their work — that is, calls to business lines that solicit individual employees to buy products or services for their own use … are not business-to-business solicitations and are not exempt."* The B2B exemption also does not displace the **TCPA**'s separate restrictions on autodialed or prerecorded calls to **wireless numbers** — and S1 ships a distinct `cell_phone` column. **Do not autodial `cell_phone`.**
   - **Sole proprietors blur B2B/B2C.** A meaningful share of small USDOT registrants are individuals; `business_org_id = 1` means *"Individual"*. Their "business" phone and address can be a personal cell and a home. The 10-truck floor mitigates this but does not eliminate it.

### 6.4 What is an owner/counsel question — flagged explicitly

The brief requires this to be stated rather than assumed. **I could not determine the following from any authoritative source, and they are not mine to decide:**

- **A1.** Whether the absence of a use restriction plus an "unknown-license" tag constitutes affirmative permission to use FMCSA contact data for commercial outreach, or merely the absence of a prohibition. **No FMCSA terms-of-use document governing S1–S4 exists that I could locate.** → **Counsel.**
- **A2.** Whether **state** anti-spam / anti-telemarketing statutes (several are stricter than CAN-SPAM and some create private rights of action) reach this program, given the list spans all lower-48 states. → **Counsel.**
- **A3.** Whether contacting `company_officer_1` by name — a named natural person published by a federal agency — is acceptable practice for this brand, independent of legality. → **Owner.** *(Recommendation: use the company mailbox, not the officer's name, for first touch.)*
- **A4.** The current wording of FMCSA's marketing-solicitation guidance, which could not be fetched live (§6.3 note 3). → **Re-verify in a browser before first send.**

**Compliance posture recommended until A1–A4 clear:** email only, to the company `email_address` (not `cell_phone`, not `company_officer_*`); full CAN-SPAM furniture on every send; suppress on first opt-out; no autodialing; no claim of FMCSA affiliation or endorsement anywhere in the creative.

---

## 7. Runbook — executable by a future agent

Prerequisites: `curl`, `python3`. **No API key, no account, no payment.** Optional: a free Socrata app token from `https://data.transportation.gov/profile/edit/developer_settings` (recommended for recurring runs; unauthenticated worked fine for a one-shot).

### Step 1 — Pull the ICP spine (SODA, ~24k rows, one page)

```bash
OUT=./fmcsa-icp
mkdir -p "$OUT"

GATE="status_code='A' AND carrier_operation='A' AND phy_country='US' \
AND classdef like '%AUTHORIZED FOR HIRE%' \
AND (power_units::number) between 10 and 100 \
AND (crgo_genfreight='X' OR crgo_coldfood='X' OR crgo_metalsheet='X' OR crgo_bldgmat='X' \
     OR crgo_machlrg='X' OR crgo_beverages='X' OR crgo_paperprod='X' OR crgo_produce='X' \
     OR crgo_drybulk='X' OR crgo_meat='X' OR crgo_construct='X' OR crgo_intermodal='X') \
AND crgo_passengers IS NULL AND crgo_household IS NULL AND crgo_garbage IS NULL \
AND crgo_drivetow IS NULL AND crgo_usmail IS NULL AND crgo_oilfield IS NULL \
AND crgo_waterwell IS NULL AND crgo_mobilehome IS NULL \
AND phy_state not in('AK','HI','PR','VI','GU','MP','AS') \
AND email_address IS NOT NULL"

COLS="dot_number,legal_name,dba_name,power_units,total_drivers,driver_inter_total,\
owntract,owntruck,owntrail,phy_city,phy_state,phy_zip,phone,cell_phone,email_address,\
mcs150_date,mcs150_mileage,mcs150_mileage_year,docket1prefix,docket1,docket2,\
crgo_genfreight,crgo_coldfood,crgo_metalsheet,crgo_bldgmat,crgo_intermodal"

curl -sG "https://data.transportation.gov/resource/az4n-8mr2.csv" \
  --data-urlencode "\$select=$COLS" \
  --data-urlencode "\$where=$GATE" \
  --data-urlencode "\$order=dot_number" \
  --data-urlencode "\$limit=50000" \
  -o "$OUT/icp_spine.csv"

wc -l "$OUT/icp_spine.csv"   # expect ~23,624 incl. header (2026-08-02 baseline: 23,623 rows)
```

**Gate:** if the row count is under 5,000 or over 60,000, **stop** — a field encoding changed (see §3 gotchas). Re-verify `crgo_*` values with a `$group` query before proceeding.

### Step 2 — Pull active broker authority and mark the T1 hybrids

```bash
# Legacy L&I
curl -sG "https://data.transportation.gov/resource/6eyk-hxee.csv" \
  --data-urlencode "\$select=dot_number" --data-urlencode "\$where=broker_stat='A'" \
  --data-urlencode "\$group=dot_number" --data-urlencode "\$limit=50000" \
  -o "$OUT/broker_legacy.csv"

# Motus-era
curl -sG "https://data.transportation.gov/resource/inys-ebih.csv" \
  --data-urlencode "\$select=usdot_number" \
  --data-urlencode "\$where=op_auth_status='Active' AND op_auth_type like '%Broker%'" \
  --data-urlencode "\$group=usdot_number" --data-urlencode "\$limit=50000" \
  -o "$OUT/broker_motus.csv"
```

```python
# join.py — NOTE: L&I zero-pads DOT numbers; the census does not. Normalize both sides.
import csv
norm = lambda s: str(s).strip().lstrip("0")
brokers = set()
for f, col in (("broker_legacy.csv", "dot_number"), ("broker_motus.csv", "usdot_number")):
    for r in csv.DictReader(open(f)):
        if r.get(col):
            brokers.add(norm(r[col]))

rows = list(csv.DictReader(open("icp_spine.csv")))
for r in rows:
    r["hybrid_broker"] = "Y" if norm(r["dot_number"]) in brokers else "N"
    r["domain"] = (r.get("email_address") or "").split("@")[-1].lower()
    r["freemail"] = "Y" if r["domain"] in {
        "gmail.com","yahoo.com","aol.com","hotmail.com","outlook.com","msn.com","comcast.net"} else "N"

w = csv.DictWriter(open("icp_enriched.csv","w",newline=""), fieldnames=list(rows[0]))
w.writeheader(); w.writerows(rows)
print("total", len(rows),
      "| T1 hybrid", sum(r["hybrid_broker"]=="Y" for r in rows),   # 2026-08-02 baseline: 793
      "| own domain", sum(r["freemail"]=="N" for r in rows))
```

**Gate:** T1 should land near 793 (±15%). A **zero** here means the leading-zero normalization was dropped — the exact failure this method hit on its first attempt.

### Step 3 — Tier and prioritize
1. **T1** — `hybrid_broker='Y'` (≈793). F-1 bullseye. Sequence first.
2. **T2** — `docket2` non-null (≈2,116 at the pre-cargo gate). Probable multi-authority.
3. **T3** — `power_units` 10–49 and `freemail='N'` (own domain). The volume tier.
4. Deprioritize `mcs150_date` older than 24 months (only ~5% of the list).

### Step 4 — Spot-verify before sending
Pull 10 rows at random and check each against SAFER, which renders the *current* record:
`https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=<DOT>`
Confirm **Power Units**, **Carrier Operation**, **Operating Authority Status**, **Cargo Carried** match the CSV. Any mismatch >1 in 10 ⇒ the snapshot has drifted; re-pull Step 1.

### Step 5 — Enrich (blocked pending owner action)
Feed `domain` (where `freemail='N'`) to Apollo bulk-enrich for titles and buying-committee contacts. **Requires the Apollo.io connector to be authorized — see §5 Step B.** Measure credit cost on 100 accounts before running the full list.

### Step 6 — Refresh cadence
S1 is regenerated daily (`R/P1D`, *"available on the DOT - Data Portal by 12:00 PM EST"*). Re-run Steps 1–2 **monthly**; carriers cross the 10-truck and 100-truck lines constantly, and authority revocations matter. Diff on `dot_number` to catch new entrants into the band.

### Step 7 — Before the first send
Clear §6.4 items A1–A4. Attach CAN-SPAM furniture (postal address, ad disclosure, working opt-out). Suppress `cell_phone` from any dialer. Do not use `company_officer_*` names in creative.

---

## 8. Falsifier check

| Falsifier | Result |
|---|---|
| **(a)** Any URL or dataset cited is not verified reachable in 2026 | ✅ **PASS.** All 17 sources in §1 carry a probe result from **2026-08-02**. Two failures are reported as failures rather than hidden: **S9 403s to every automated client** (content recovered from a 2026-07-31 archive and labelled as such), and **`ai.fmcsa.dot.gov/SMS/{Tools,Data}/Downloads.aspx` — the URL most 2023-era guides cite — is confirmed DEAD** as a download endpoint (302 → 403). No URL is asserted without a status code. |
| **(b)** A field is claimed to exist without being seen | ✅ **PASS.** Every S1 field is quoted from the **MCMIS Company Census File Data Dictionary Rev 8, 1/23/2026** (downloaded, 89 pp, §1 row S1c) *and* confirmed in the live Socrata schema. Every code value (`status_code` A/I/P, `carrier_operation` A/B/C, `classdef` semicolon-joined, `crgo_*`=`X`, `broker_stat` A/I/N, `op_auth_type`/`op_auth_status`) was proved by a live `$group` query with counts, printed in §2. S5's field list was parsed from a **live SAFER response**, and its **absence of email is reported**, not glossed. |
| **(c)** Commercial use asserted without checking terms | ✅ **PASS.** §6.3 quotes FMCSA's **actual and only** attached terms (a liability disclaimer, verbatim) and states plainly that **no use restriction exists in it**. Where the answer is genuinely undetermined, §6.4 says so and routes **A1–A4 to counsel/owner** by name. FTC authority for CAN-SPAM ("no exception for business-to-business email"; $53,088/email) and the TSR B2B exemption was fetched **live from ftc.gov**, not paraphrased from SEO blogs — the first search returned six marketing blogs and they were discarded. |
| **(d)** The estimate is not traceable to a published FMCSA statistic | ✅ **PASS.** A&I (S6) publishes **2,085,534 carriers** at MCMIS snapshot 06/26/2026; the S2 census file returns **exactly 2,085,534 rows** — the filtered file *is* the published population. The core gate replicates across two independent FMCSA files (**35,956** vs **34,419**, 4.3% spread) and reconciles with F-1's own market claim (**7.71% measured vs "≈7.2%" stated**). |
| **(e)** Spend | ✅ **PASS — $0.00.** No key purchased, no credit consumed, no paid endpoint called. Apollo was **not** invoked (connector unauthenticated) and is reported as blocked rather than estimated. |
| **(f)** Identity leak (REQ-167) | ✅ **PASS.** No company name, officer name, DOT number, MC number, domain, email, or address appears anywhere in this document. The SAFER probe printed **field labels only, with values discarded**; §4.2's state table and all other figures are aggregate counts. |
| **(g)** Blast radius | ✅ **PASS.** This agent wrote exactly one path: `docs/gtm/D1-fmcsa-list-method.md`. No sibling output was edited, no git command was run. |

### Known limitations, stated plainly
- **`power_units` is self-reported** on the MCS-150 and updated biennially. 95.0% of the list filed within 24 months; the remaining 5% may be stale. It is nonetheless the *authoritative* federal figure and is a direct measurement, not a proxy.
- **The 10–100 band is a registration fact, not an operating fact.** A carrier can run leased power units beyond its reported count (`avg_drivers_leased_per_month` and the `trp*`/`trm*` trip-leased and term-leased columns exist in S1 and were **not** used in this cut — a refinement available for free).
- **T1 = 793 is a floor, not a ceiling.** It counts only carriers with *already-granted* active broker authority. F-1's "**or building** a brokerage arm" is invisible in a registration file by definition.
- **No revenue filter was applied.** F-1's $2M–$25M band has no FMCSA equivalent; `mcs150_mileage` is available as a proxy and was deliberately left out of the headline count rather than dressed up as a measurement.
- **S9's terms page could not be read live.** The disclaimer quoted in §6.3 is from a 2026-07-31 snapshot — one day before this run — and should be re-read in a browser at first send.
