# fixtures/ — golden data that gates merges (vendor at WP-01)
Every engine/ledger change replays these. CI references fixtures by hash; changing a fixture requires a register note.

| Fixture | Gates | Source of record (vendor from) |
|---|---|---|
| Pricing engine test suite (48 tests) + 504-quote monotonic sweep | Rater (WP-04) | TP RepDesk v1.1 — `TP CLI REMEDIATION/TP-RepDesk/site/index.html` (embedded engine + tests; live at tp-repdesk.pages.dev) |
| Zone tariff v1 + ZIP→zone map (560) + accessorial schedule | Rater config seeds | `TP CLI REMEDIATION/TP-Zone-to-Zone-Tariff-v1.csv` · `CLI Training/TILL rate groups.csv` |
| Customer roster (3,601: code/name/city/zip/rep/discount/floor) | Migrator (WP-14/15) | `CLI Training/Customer List with Rates_TP Freightxlsx.xlsx` |
| Legacy import formats (byte-exact) | Overlay projections (WP-15) | `CLI Training/Rate Profile sample.csv` · `TP Company Pricing.csv` · `FAK Import.csv` · `CLI-Operating-System-0702/CLI-Import-Pack-0702/` |
| Legacy full export replay (±2% aggregate) — 9,314-bill 062226 export + 4,405-bill re-rate fixture | Ledger/Rater parity (WP-02/04/15) | **[CONFIRM path at WP-01]** — referenced throughout PricingOS pack; locate original xlsx and vendor with hash |
| 3,100-bill synthetic blitz + rating harness | Shadow-run tooling (WP-15) | `TP CLI REMEDIATION/Backlog-Blitz/` |
| Anomaly regression: pro 77112506 ($222,084 / 35 lb) | Watchtower (permanent) | PricingOS `06-QA-AND-VALIDATION` — encode as unit fixture |
| QuickBooks journal fixture month | GL export (WP-11) | Build at WP-11 from ledger events; reconcile in QB sandbox |
| Airplane-mode soak script (50 events / 2 devices) | Driver offline (WP-05) | Write at WP-05 per REQ-016 |
