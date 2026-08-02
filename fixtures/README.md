# fixtures/ — golden data that gates merges (vendor at WP-01)
Every engine/ledger change replays these. CI references fixtures by hash; changing a fixture requires a register note.

> **`fixtures/manifest.json` is the authoritative registry — this table is not (clarified 2026-08-02, audit §63).**
> The table below is the **WP-01 vendor-in list**: the private, engagement-workspace datasets to obtain and hash.
> The manifest carries those *plus* the fixtures generated in-repo since (`gl-netting`, `merkle-vectors`,
> `interline-partner-statement`, `migrator-formats`, `legacy-mirror-export`) and the two later private holds
> (`invoice-500-replay`, `concierge-parse-50`) — **17 rows against this table's 10**, all of which gate merges.
> Deliberately NOT mirrored here: a second hand-maintained copy of a list the build already owns is what drifts
> (audit §58). `pnpm check:fixtures` reads the manifest, recomputes every vendored `sha256`, and FAILS on a
> mismatch in any mode — mutation-proved in §63.

**Separation law (REQ-167):** this file names datasets by role and size only. Real source paths, filenames, and tenant identifiers live in the tenant's **`fixtures-manifest.private`** in its engagement workspace, outside this repo. At WP-01 vendor-in, bytes are copied here, hashed, and referenced by hash forever after — the private manifest maps hash → origin.

| Fixture | Gates | Vendor-in source |
|---|---|---|
| Rating-engine test suite (48 tests) + 504-quote monotonic sweep | Rater (WP-04) | Ported engine v1.1 (embedded tests; live deployment) — manifest ref M-01 |
| Zone tariff v1 + ZIP→zone map (560) + rate groups + accessorial schedule | Rater config seeds | Manifest refs M-02…M-05 |
| Customer roster (full: code/name/city/zip/rep/discount/floor) | Migrator (WP-14/15) | Manifest ref M-06 |
| Legacy import formats (byte-exact: rate-profile CSV, company pricing, FAK, import-pack profiles) | Overlay projections (WP-15) | Manifest refs M-07…M-10 |
| Legacy full-export replay (±2% aggregate) — 9,314-bill export + 4,405-bill re-rate fixture | Ledger/Rater parity (WP-02/04/15) | **[CONFIRM original path at WP-01]** — manifest refs M-11/M-12; vendor with hash |
| 3,100-bill synthetic blitz + rating harness | Shadow-run tooling (WP-15) | Manifest ref M-13 |
| Anomaly regression: the $222,084 / 35-lb case | Watchtower (permanent) | Manifest ref M-14 — encode as unit fixture |
| QuickBooks journal fixture month | GL export (WP-11) | Build at WP-11 from ledger events; reconcile in QB sandbox |
| Airplane-mode soak script (50 events / 2 devices) | Driver offline (WP-05) | Write at WP-05 per REQ-016 |
| Live legacy-TMS mirror feed (nightly export/API) — NOT a static fixture; the Phase-0 clock | Overlay mirror (WP-15 / doc 13 §04) | **PENDING — the tenant's standing data-access request (REQ-152); history says this is Risk #1** |
