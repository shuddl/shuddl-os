# RAW RESEARCH APPENDIX — Competitors: Fraud/Identity (Cat. 8) + Integration/Interop (Cat. 9)
**Compiled by background research agent, 2026-08-01. Preserved verbatim as source material for doc 03/04. All sources accessed 2026-08-01.**

## CATEGORY 8 — Fraud/Identity in Freight

### Summary table

| Company | What it is | Who pays | Pricing (public?) | Funding/Status (latest) | Integration posture |
|---|---|---|---|---|---|
| Highway | Carrier Identity platform for brokers | Freight brokers | Not public | Undisclosed growth equity led by FTV Capital, Aug 20 2025. No disclosed "Series C" | Deep: TMS/load-board/VoIP integrations, Identity Engine embedded in partner products |
| Carrier411 | Legacy carrier monitoring + FreightGuard incident reports | Brokers | Not published (per-seat) | Private, bootstrapped incumbent; no 2024-26 events found | Weak/closed; proprietary FreightGuard database, limited API story |
| FreightValidate | Broker+carrier identity vetting, "FreightValidated" status | Carriers/owner-ops AND brokers | ~$99/mo owner-ops (Sept 2024) | Small private co (Dale Prax); active | Standalone; recommends pairing with MyCarrierPortal; no public API |
| Truckstop RMIS | Carrier onboarding + compliance monitoring | Brokers | ~$340 Lite tier (third-party source) | Part of Truckstop (ICE/Bregal-backed) | Strong: TMS integrations, ID verification in onboarding flow |
| Descartes MyCarrierPortal | Carrier onboarding + risk monitoring | Brokers/3PLs, shippers | Rates not disclosed | Acquired by Descartes Sept 18 2024, $24M + $6M earnout | Strong: TMS-integrated; paired with MacroPoint FraudGuard |
| Verified Carrier | End-to-end identity chain incl. driver-level Verified Pickup | Brokers, shippers, carriers | Not public | Private (Vancouver, WA); funding UNVERIFIED | Physical-world posture: on-site camera/plate capture, QR driver check; API depth unclear |
| CarrierOK | Carrier data/vetting platform + 300-field REST API | Brokers, factoring, fuel cards, insurers, shippers | Fully public: $149-$499/mo; API pay-as-you-go per DOT + $50 activation; data feeds $199-$999/mo | Private; active | Most API-first of the vetting group; self-serve API |
| CargoNet (Verisk) | Cargo theft prevention/recovery network + data | Insurers, carriers/logistics, retail (LE free) | Membership; not public | Verisk (NASDAQ: VRSK) business unit | RouteScore API launched; otherwise network/analyst-service posture |
| NMFTA | Nonprofit: SCAC registry + cybersecurity program | Carriers (SCAC fees, members) | SCAC fees; reports free | Nonprofit; SCAC Verified live 2025-26 | Standards-layer: identity-verified SCAC; not a SaaS |

### Key per-company facts

**Highway** — 1,050+ brokers incl. 70 of top 100; growth equity led by FTV Capital + Lead Edge, announced Aug 20 2025, amount undisclosed (NOT a "Series C") ([Highway PR](https://highway.com/press-releases/highway-secures-strategic-growth-equity-investment-led-by-ftv-capital); [FreightWaves](https://www.freightwaves.com/news/carrier-identity-platform)). Q2 2025 Fraud Index: 495K+ blocked fraudulent emails, 42K+ fraudulent inbound calls (+37% QoQ), 135% June 2025 spike in suspicious MC ownership changes ([GlobeNewswire 2025-07-29](https://www.globenewswire.com/news-release/2025/07/29/3123318/0/en/Highway-Releases-Q2-2025-Freight-Fraud-Index-Identity-Based-Fraud-Attempts-Escalate-with-495K-Blocked-Emails-and-42K-Fraudulent-Calls.html)). Launched "Trusted Freight Exchange" with Triumph (identity + compliance + pricing + payments); Identity Engine embedded in Chain, FleetWorks. Gap: verifies *who*, not *what happened at the door*.

**Descartes MyCarrierPortal** — acquired by **Descartes** (not Truckstop), Sept 18 2024, $24M + $6M earnout ([Descartes](https://www.descartes.com/resources/news/descartes-acquires-mycarrierportal); [SEC exhibit](https://www.sec.gov/Archives/edgar/data/1050140/000092963824003162/exhibit99-1.htm)); 250,000 carriers onboarded; paired with MacroPoint FraudGuard.

**Truckstop RMIS** — 2025 Freight Fraud Report: 63,000 fraud checks analyzed; 14,000+ failed identity checks during onboarding ([Truckstop blog](https://truckstop.com/blog/2025-freight-fraud-report/)).

**Verified Carrier** — closest competitor thinking to "physical reality verification at the door": Verified Pickup (2025) does driver gov-ID + facial recognition enrollment; at pickup, plate/image capture matched to fleet records + encrypted driver QR scanned by shipper ([Yahoo PR](https://finance.yahoo.com/news/verified-carrier-launches-verified-pickup-140000003.html)) — but a bolt-on vetting layer, not a ledger.

**CarrierOK** — most transparent pricing: Pro $149/user/mo; Team $349/mo; Enterprise $499/mo; API pay-as-you-go per unique DOT/month + $50 activation ([pricing](https://www.carrier-ok.com/pricing?product=data)).

**CargoNet (Verisk)** — $725M reported theft losses 2025 (+60%); avg theft $273,990 (+36%); RouteScore lane-risk API ([Verisk newsroom](https://www.verisk.com/company/newsroom/cargo-theft-losses-surge-to-estimated-$725-million-in-2025-verisk-cargonet-analysis-reveals/)).

**NMFTA** — SCAC ID Verification + "SCAC Verified" live 2025-26 ([NMFTA](https://nmfta.org/news/scac-id-verification-and-scac-verified-now-live-what-it-means-for-carriers-and-the-future-of-freight-fraud-prevention/)); 2026 Cybersecurity Trends Report flags API security & machine-identity sprawl from AI agents as top 2026 risk ([report](https://nmfta.org/wp-content/media/2025/12/2026-NMFTA-Transportation-Industry-Cybersecurity-Trends-Report.pdf)).

**FMCSA overhaul** — identity verification via IDEMIA partnership (April 2025) + Login.gov; Motus Phase 1 limited access Dec 2025; legacy URS systems replaced **May 14, 2026** ([Federal Register 2026-04-29](https://www.federalregister.gov/documents/2026/04/29/2026-08334/availability-of-motus-fmcsas-new-registration-system); [FleetOwner](https://www.fleetowner.com/operations/article/55290826/how-fmcsas-new-registrant-identity-verification-works)). Implication: government absorbs baseline "is this MC real," pressuring registration-vetting vendors; raises value of *behavioral/physical* verification.

Fraud context: $35B annual loss claims circulate (directional); double brokering $500-700M/yr (TIA April 2025); theft +40% incidents 2024, organized theft +1,500% since 2021 ([NICB](https://www.nicb.org/news/news-releases/nicb-warns-increased-cargo-theft-2025); [TIA State of Fraud](https://member.tianet.org/TIAnetOrg/Member%20Resources/White-Papers/State-of-Fraud-in-the-Industry-April-2025.aspx)).

## CATEGORY 9 — Integration/Interop Plays

### Summary table

| Company | Layer | Who pays | Funding/Status (latest) | What they do NOT solve |
|---|---|---|---|---|
| Stedi | EDI-as-API → now healthcare clearinghouse ONLY | Health-tech/RCM cos | $50M Series C (Addition), Mar 24 2026; $142M total | Exited logistics as marketed business. No freight semantics, identity, or state sync |
| Orderful | EDI network w/ canonical API + AI mapping (Mosaic) | Retailers, brands, 3PLs, carriers | $35M Series C, Koch Disruptive Tech, Jun 29 2026; $85M total | Message translation only — no physical-event truth, identity, or money projection |
| Chain.io | Logistics-specific iPaaS (forwarder-centric) | Forwarders/LSPs, shippers, SaaS vendors | $11M Series A (Jun 2022); no later round found | Point-to-point plumbing; no shared ledger |
| Terminal49 | Ocean container tracking API/dashboard | Forwarders, BCOs, drayage, software cos | Private; funding UNVERIFIED | Ocean-only; visibility, not execution or co-signed state |
| Cleo | Horizontal B2B integration (EDI+API) | Mid-market/enterprise logistics, mfg | H.I.G.-backed (2021); 4,000+ customers | Tooling, not semantics; customers still own maps |
| Youredi/Coneksion | Logistics iPaaS (managed service, Finland) | Carriers, forwarders, ports | Active 2025; rebrand UNVERIFIED | Managed-service; no productized canonical model |
| Vizion | Ocean container tracking API + TradeView | BCOs, forwarders, 3PLs | $14M Series A (2022); Bigfoot Q1 2025 (weak source) | Ocean only |
| CargoWise (WiseTech) | Forwarder OS; completed $2.1B E2open acquisition Aug 3 2025 | Forwarders | ASX-listed | Walled garden — interop *within* the WiseTech estate |
| Terminal (withterminal.com) | "Plaid for telematics" — unified fleet-data API over 325+ providers | Insurers, fleet software, financial services | **$20M Series A led by Battery Ventures, Jul 29 2026**; $26M total | Telematics reads only — no transactions, ledger, or money |
| Baton | Acquired by Ryder Aug 31 2022 → tech lab | n/a | Absorbed | Off the board as independent play |
| Frayt | NOT interop — last-mile marketplace w/ API | Shippers/3PLs | Private, active | It's a carrier network, not middleware |
| Axle (axle.network) | — | — | Domain does not resolve 2026-08-01; presumed dead (UNVERIFIED) | — |

### Key per-company facts

**Stedi** — today markets exclusively as "the only programmable **healthcare** clearinghouse" ([stedi.com](https://www.stedi.com/)); $50M Series C (Addition, 2026-03-24, $142M total) is entirely a healthcare story; even `/edi-platform` is healthcare-branded. **The "EDI-as-API for freight" seat is vacant.** No formal logistics sunset notice found (UNVERIFIED whether legacy non-healthcare customers were migrated).

**Orderful** — canonical API translated to 50,000+ trading-partner requirement sets; Mosaic AI-native EDI (Dec 2025) compresses onboarding from months to hours/days; $35M Series C (Koch Disruptive Technologies + NewRoad, 2026-06-29), $85M total, 6B+ transactions over nine years ([Pulse2](https://pulse2.com/orderful-raises-35-million-series-c-to-grow-ai-native-edi-infrastructure/); [FreightWaves](https://www.freightwaves.com/news/orderful-35m-series-c-edi)).

**Chain.io** — pre-built adapters between forwarder systems (notably CargoWise), TMS, ERPs; 10 of world's 15 largest forwarders; last round $11M Series A June 2022; partnered with Highway for identity-checked carrier matching ([chain.io](https://chain.io/supply-chain-integration-platform/); [Highway PR](https://highway.com/press-releases/chain-and-highway-partner-to-enhance-carrier-matching-and-fraud-prevention-for-freight-brokers)).

**WiseTech/CargoWise** — completed E2open acquisition Aug 3 2025: $3.30/share cash, $2.1B EV, fully debt-funded; extends CargoWise from forwarders into shippers/manufacturers ([e2open PR](https://www.e2open.com/news/press-releases/wisetech-global-completes-strategic-acquisition-of-e2open/)). The anti-thesis of an open substrate.

**Terminal** — Toronto, YC 2023; unified API over 325+ telematics providers; $20M Series A led by Battery Ventures with Intact + Penske, announced Jul 29 2026, $26M total ([PR Newswire](https://www.prnewswire.com/news-releases/terminal-raises-20-million-to-scale-market-leading-telematics-integration-technology-for-fortune-500-companies-across-insurance-fleet-management-and-logistics-302837250.html)).

### Strategic read (agent's synthesis, preserved)

**Category 8**: Identity has consolidated around Highway + platform-owned vetting (Descartes MCP, Truckstop RMIS), while FMCSA's Motus/IDEMIA overhaul (fully live May 2026) will commoditize baseline registration identity. The unclaimed ground is **verification of physical execution** — no one has it as a native property of the system of record. SHUDDL's co-signed event ledger makes fraud-resistance a *side effect* of how facts are recorded; every vendor above charges brokers a second bill to establish what a co-signed ledger proves for free.

**Category 9**: The interop layer is fragmenting by modality, and the two best horizontal builders left the field (Stedi → healthcare; Baton → Ryder). Every surviving player translates messages or reads sensors; **none maintains shared, verifiable *state* between counterparties** — the actual problem EDI was a 40-year workaround for. The "state sync + semantics + identity in one substrate" position — SHUDDL's ledger thesis — is genuinely uncontested as of 2026-08-01, with the main structural threat being WiseTech's walled-garden expansion pulling large-enterprise interop inside one vendor's estate.

**Residual gaps (UNVERIFIED)**: Frayt funding; Terminal49 funding; Verified Carrier funding; dedicated sweep for new 2025-26 freight-iPaaS entrants; MyCarrierPortal and Highway exact price points.
