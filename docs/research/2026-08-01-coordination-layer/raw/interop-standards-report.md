# RAW RESEARCH APPENDIX — Interop / Standards Landscape
**Compiled by background research agent, 2026-08-01. Preserved verbatim as source material for docs 04 and 05. All sources accessed 2026-08-01 unless noted; UNVERIFIED flags preserved.**

---

# The Freight Coordination Layer: Is a Universal Event/State Substrate Buildable?

**Research report — compiled 2026-08-01.** All sources accessed 2026-08-01 unless noted. Claims sourced from search-result summaries rather than full-page fetches are cited to the underlying URL; items not independently confirmed are flagged **UNVERIFIED**.

---

## 1. Legacy Rails: EDI Is Still the Substrate

### 1.1 Dominance in 2026

- X12 EDI (204 load tender, 214 status, 210 invoice, 990 response, 997 ack) remains the canonical shipper↔carrier/broker rail for contracted US truckload and LTL freight. Every major EDI vendor's 2025–26 material still treats 204/210/214 as the core freight workflow ([Cleo EDI codes for logistics](https://www.cleo.com/edi-codes/logistics); [Pro EDI trucking](https://www.proedi.com/logistics)). **No reliable public figure exists for "% of freight transactions on EDI in 2026"** — the honest statement is that EDI is the default for enterprise-shipper freight and nothing has displaced it; API rails have grown *beside* it, not through it. (UNVERIFIED as a precise share.)
- The EDI software market itself is still growing, not shrinking: ~$2.4–2.6B in 2025, projected to roughly double by 2030–2034 ([Mordor Intelligence](https://www.mordorintelligence.com/industry-reports/electronic-data-interchange-software-market); [Straits Research](https://straitsresearch.com/report/electronic-data-interchange-software-market)). Legacy rails are compounding, not sunsetting.

### 1.2 Who runs the VANs

OpenText Trading Grid (absorbed GXS + Liaison), IBM Sterling, SPS Commerce, TrueCommerce, Cleo, Kleinschmidt, plus newer entrants (Orderful, Boomi, DataTrans) ([Mordor Intelligence](https://www.mordorintelligence.com/industry-reports/electronic-data-interchange-software-market)). OpenText's network alone processes hundreds of billions of dollars of commerce annually. This is a tollbooth oligopoly: the VANs monetize *per message*, so they have zero incentive to collapse the message layer into shared state.

### 1.3 Onboarding cost/time — the number that matters

- Per-transaction fees: **$0.25–$2** ([FreightAmigo 2025 guide](https://www.freightamigo.com/en/blog/logistics/edi-fee-in-logistics/)).
- Trading-partner onboarding: **$750–$2,500 setup per partner**, often **$2,000–$5,000/yr per partner** on top; VAN setup $500–$5,000, mailbox $50–$200/mo, migration fees up to $10,000 ([NexusVAN fee guides](https://www.nexusvan.com/post/common-edi-processing-fees-explained-and-how-to-avoid-them), [BOLD VAN checklist](https://www.boldvan.com/blog/value-added-networks-how-to-select-a-van-provider-for-edi)).
- Timeline: mapping + certification testing stretches a single carrier onboarding into **weeks**; SPS quantifies the cost of a 4-week onboarding at ~$50K of earned-but-waiting revenue for a $50K/mo account ([SPS Commerce](https://www.spscommerce.com/community/articles/what-slow-trading-partner-onboarding-actually-costs-your-3pl)).

**Implication:** the incumbent rail's unit economics (weeks + thousands of dollars *per pairwise connection*) are exactly the gap a coordination layer attacks. This is the same "per-connection tax" Plaid and Stedi attacked in their industries.

### 1.4 Modern EDI-as-API players — and the most important negative signal

- **Stedi**: raised a **$50M Series C (March 24, 2026), $142M total** (Addition, Stripe, Ribbit, USV) — but as a **healthcare clearinghouse**, processing 1B+ claims/eligibility transactions/yr across 3,400+ payers ([Stedi Series C announcement](https://www.stedi.com/blog/series-c); [stedi.com](https://www.stedi.com/)). Stedi began (2019–2023) as a *general-purpose* commerce/logistics EDI platform and narrowed to healthcare-only; its current site and Series C make no mention of logistics at all. **The best-funded, most technically admired "modern EDI" company looked at every EDI vertical and concluded freight was not the wedge — healthcare was** (regulated formats, one dominant transaction family, payers legally required to respond). The pivot itself is the data point. (Pivot timing pre-2025: UNVERIFIED in this pass; current healthcare-only scope: verified.)
- **Orderful**: still logistics/retail-focused, "integrate once, connect to the network" API-first X12; positions on fast onboarding economics ([Orderful](https://www.orderful.com/blog/best-ai-edi-platforms-2026); [SelectHub comparison](https://www.selecthub.com/edi-software/orderful-vs-cleo-integration-cloud/)).
- **Cleo**: the "unify EDI + API + file" incumbent-modernizer, strongest in complex multi-partner logistics ([Cleo](https://www.cleo.com/blog/best-edi-software-providers)).
- **Kleinschmidt**: 100+ year-old logistics VAN, reliable but noted even in 2026 reviews as lacking modern features and hard to scale ([SourceForge reviews](https://sourceforge.net/software/product/Kleinschmidt-EDI-Integration/)).

### 1.5 TMS "open" APIs — how open, really

- **McLeod**: has a REST API and an Innovation Hub developer portal, but access runs through *licensed* integrations and an integration dashboard — partner-gated, not self-serve ([McLeod Innovation Hub](https://innovationhub.mcleodsoftware.com/apis); [McLeod integrations](https://www.mcleodsoftware.com/solutions/integrations/)). Third parties document it as requiring licensing and per-integration commercial arrangements ([Zuplo on the McLeod API](https://zuplo.com/learning-center/mcleod-api)).
- **Trimble**: runs a Marketplace of 100+ "pre-built and verified" integrations with partner onboarding — a curated bazaar, not an open platform ([Trimble Marketplace, Nov 2025](https://news.trimble.com/2025-11-10-Trimble-Marketplace-Enhanced-with-New-Trimble-Connect-and-ProjectSight-Integrations); [Trimble Developer Program](https://www.trimble.com/en/developer)).
- **Alvys** (and the modern cohort — Tai, Turvo, etc.): genuinely self-serve public API included free in every subscription, 120+ integrations ([Alvys Public API](https://alvys.com/blog/unlock-new-efficiency-with-the-alvys-public-api)). Tai explicitly markets "no five-figure API access fees" — which tells you the legacy norm *is* five-figure API access ([Tai TMS](https://tai-software.com/); [Freightzy on TMS integration fees](https://www.freightzy.com/blog/tms-integration-fees-explained)).

**Pattern:** openness correlates inversely with install base. The systems holding the most freight state are the most closed, because integration friction *is their moat*.

---

## 2. Standards Bodies & Open Schemas: A Scorecard

| Standard | Status mid-2026 | Verdict |
|---|---|---|
| **SSC** (scheduling API; Convoy/Uber Freight/J.B. Hunt, 2022) | Spec published Oct 2023; e2open shipped it June 2024; **absorbed into NMFTA's DSDC Full Truckload Council, Aug 2025** ([Uber Freight](https://www.uberfreight.com/en-US/blog/ssc-api-standards-published); [NMFTA DSDC](https://dsdc.nmfta.org/ssc-joins-the-dsdc)) | Alive but sub-critical; one founder (Convoy) died; adoption = "early adopter badges," not volume |
| **DCSA eBL** (ocean) | 9 member carriers committed to 100% eBL by 2030; all "technically ready" in 2026; first live cross-platform eBL Jan 12, 2026; but baseline was **2.1% adoption in 2022**, 240+ FIT Alliance declaration signers ([DCSA](https://dcsa.org/100-percent-ebl/); [FIT Alliance](https://www.fit-alliance.org/); [Cleareye 2026 update](https://cleareye.ai/electronic-bill-of-lading-news-2026-adoption-standards/)) | Slow but real — because the 9 carriers ARE the market (oligopoly can self-mandate) |
| **IATA ONE Record** (air) | Jan 1, 2026 implementation milestone; Dec 2025 IATA survey: ~50% "prepared," >70% aware, 200+ companies in pilots ([IATA, Dec 10 2025](https://www.iata.org/en/pressroom/2025-releases/2025-12-10-02/); [ITLN](https://www.itln.in/aviation/nearly-50-indicate-they-are-already-prepared-for-one-record-iata-1357430)) | Deadline hit with half the industry ready; works at all only because IATA can retire the old standard (Cargo-IMP) by fiat |
| **Open Logistics Foundation** (EU, Fraunhofer/Dachser/Rhenus/DB Schenker/duisport, 2021) | ~50 members May 2025; shipped an industry-ready open-source **eCMR** with 28 companies at transport logistic 2025 ([OLF eCMR](https://openlogisticsfoundation.org/open-logistics-foundation-develops-european-ecmr-open-source-standard/); [Dachser](https://www.dachser.com/en/mediaroom/First-industry-ready-eCMR-software-legally-compliant-interoperable-and-freely-available-for-all-28461)) | Quiet success on a narrow artifact (one document, backed by the eCMR Protocol's legal force) |
| **BiTA** (blockchain, 2017) | Lost most members, ceased independent existence; merged into GBBC 2023 ([Ledger Insights](https://www.ledgerinsights.com/blockchain-logistics-bita-gbbc-merger/)) | Effectively dead as a freight standards force; produced standards nobody ran in production |
| **GS1 EPCIS 2.0** (supply-chain events) | Ratified June 2022; JSON-LD + REST; now the substrate for **FSMA 204** food traceability, EUDR, Digital Product Passports ([GS1 US FSMA 204 resources](https://www.food-safety.com/articles/9312-gs1-us-releases-suite-of-fsma-204-traceability-resources-for-industry); [EPCIS guide](https://trackvision.ai/blog/what-is-gs1-epcis-2.0)) | The one *event-schema* standard with real pull — and the pull is 100% regulatory |

### The extracted adoption pattern

Freight standards succeed **only** when at least one of three forcing functions exists:

1. **Regulation or legal recognition** (EPCIS←FSMA 204/EUDR; eCMR←eCMR Protocol; FHIR←Cures Act — see §6). Voluntary schemas without a compliance deadline stall.
2. **An oligopoly that can self-mandate** (DCSA: 9 carriers ≈ the container market; IATA: airlines control the AWB). Fragmented US trucking (~750K carriers) has no such body — the closest is NMFTA, which is why surviving truckload standards (SSC) migrated *to* NMFTA's DSDC.
3. **A narrow, painful, bounded artifact** (one document: eBL, eCMR, appointment; not "all of trade"). TradeLens and BiTA tried to standardize *everything* and standardized nothing.

Corollary: standards that begin as vendor consortiums die with their vendors (Convoy→SSC; Maersk/IBM→TradeLens).

---

## 3. Event/Ledger Approaches: Prior Art and Post-Mortems

### 3.1 TradeLens (2018–2023) — the canonical failure

Maersk/IBM shut TradeLens down effective Q1 2023 after it "failed to reach commercial viability" despite onboarding carriers covering a large share of ocean volume ([Maersk announcement](https://www.maersk.com/news/articles/2022/11/29/maersk-and-ibm-to-discontinue-tradelens); [Supply Chain Dive](https://www.supplychaindive.com/news/Maersk-IBM-shut-down-TradeLens/637580/)). Distilled causes:

1. **Owner = competitor.** "The driving force behind the ledger was Maersk, which makes many wary of joining" — rivals would not feed data into a competitor-owned utility ([Computerworld](https://www.computerworld.com/article/1615596/maersks-tradelens-demise-likely-a-death-knell-for-blockchain-consortiums.html)).
2. **No incentive design for the spokes.** Shippers and forwarders had no ROI story for the work of integrating; "lack of incentives... cost overruns and the governance model" killed it ([PierNext / Port de Barcelona](https://piernext.portdebarcelona.cat/en/technology/the-closure-of-tradelens)).
3. **Full-collaboration precondition.** It needed "full global industry collaboration" *before* delivering value — the cold-start curve was a cliff ([gCaptain](https://gcaptain.com/rip-tradelens-maersk-and-ibm-to-abandon-block-chain-based-shipping-platform/)).
4. Gartner's Litan: consortia "only succeed when all parties are on the same win-win page, and there is clear demonstrable ROI when the application is implemented" ([Computerworld](https://www.computerworld.com/article/1615596/maersks-tradelens-demise-likely-a-death-knell-for-blockchain-consortiums.html)).

Note what did **not** kill it: the append-only event model. The failure was governance + incentives, not the ledger primitive.

### 3.2 What survived

- **GSBN** (Hong Kong, COSCO-orbit consortium) still operates: first cross-platform interoperable eBL March 2025, bank data-sharing products with BOCHK ([Ledger Insights](https://www.ledgerinsights.com/shipping-blockchain-network-gsbn-portbase-ictsi-westport/); [digitalizetrade.org](https://www.digitalizetrade.org/projects/global-shipping-business-network-gsbn-ebl-exchange)). Survives because its members are aligned (largely one geopolitical/commercial bloc) and it narrowed to eBL + cargo release + trade finance.
- **Event sourcing as architecture** (not consortium) is now mainstream in logistics engineering: append-only event stores as authoritative state with reprocessable projections are standard case-study material ([nexocode EDA-in-logistics case study](https://nexocode.com/blog/posts/event-driven-architecture-in-logistics-case-study/); [UNIS glossary](https://www.unisco.com/freight-glossary/supply-chain-event-driven-architecture)). Gartner (March 2026, via Logistics Viewpoints) projects 60% of disruptions resolvable without human intervention by 2031 — the visibility→intervention shift presumes an event log ([Logistics Viewpoints](https://logisticsviewpoints.com/2026/07/22/supply-chain-visibility-is-evolving-from-tracking-to-intervention/)).

### 3.3 What a non-blockchain, per-tenant, co-signed ledger avoids vs. still faces

**Avoids:** consortium governance (no shared chain to govern); competitor-ownership taint (each tenant owns its ledger); the "everyone must join first" cliff (a single-tenant ledger is useful on day one — this is the single biggest structural fix vs. TradeLens); blockchain ops cost and throughput ceilings.

**Still faces:** counterparty co-signature acquisition (a co-signed fact needs the *other* party's key — that's a mini cold-start per relationship); cross-ledger reconciliation when both sides keep their own log ("my ledger vs. your ledger" — needs canonical hashing and an interchange proof format); liability of attested facts; and the same incentive question — why does the counterparty sign?

---

## 4. Agent-Era Protocols

### 4.1 MCP

- Anthropic donated MCP to the **Agentic AI Foundation** (Linux Foundation directed fund, co-founded by Anthropic, Block, OpenAI) in **December 2025** — vendor-neutral governance ([CData](https://www.cdata.com/blog/2026-year-enterprise-ready-mcp-adoption); [toloka](https://toloka.ai/blog/the-future-of-mcp-enterprise-adoption/)).
- Industry trackers report ~97M monthly SDK downloads, 9,400+ public servers, native support from Anthropic/OpenAI/Google/Microsoft, ~28% of Fortune 500 deployed, 41% of surveyed software orgs in limited-or-broad production (Stacklok 2026) ([digitalapplied MCP statistics](https://www.digitalapplied.com/blog/mcp-adoption-statistics-2026-model-context-protocol); [andrew.ooo state of play, July 2026](https://andrew.ooo/answers/mcp-model-context-protocol-enterprise-adoption-july-2026/)). **Precision of these figures UNVERIFIED** (third-party trackers), but the direction — MCP as the de facto agent↔tool standard by mid-2026 — is multiply attested.

### 4.2 A2A

- Announced April 2025, donated to Linux Foundation June 2025; **v1.0 shipped early 2026**; 150+ member orgs; integrated into Azure AI Foundry, AWS Bedrock AgentCore, Google Cloud; LF's one-year release explicitly names **supply chain** as a production vertical ([Linux Foundation, April 2026](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year); [Google OSS blog](https://opensource.googleblog.com/2026/04/a-year-of-open-collaboration-celebrating-the-anniversary-of-a2a.html)). Caveat: LF published no deployment counts; real production density is thinner than the headline ([agentndx analysis](https://agentndx.ai/blog/a2a-protocol-adoption-mid-2026/)).

### 4.3 Logistics-specific agent interop

**No neutral logistics agent-interop standard exists as of mid-2026.** What exists is proprietary agent fleets: project44 launched an AI freight-procurement agent, an "Intelligent TMS" (Aug 2025), acquired LunaPath.ai (April 2026) for voice/messaging agent orchestration, and reports 34% new-ARR growth "fueled by AI Agent momentum" ([project44 press](https://www.project44.com/press-releases/project44-launches-ai-freight-procurement-agent-to-cut-freight-spend-and-accelerate-sourcing/); [FreightWaves on LunaPath](https://www.freightwaves.com/news/project44-acquires-lunapath-ai-to-accelerate-ai-agent-orchestration-across-global-supply-chains)). HappyRobot/Vooma operate as agents *inside* platform ecosystems ([FreightWaves Decision44](https://www.freightwaves.com/news/project44-unveils-fleet-of-ai-agents-at-customer-event-decision44)). Anthropic's own 2026 enterprise-agents material and Gartner's projection (40% of enterprise apps embedding task agents in 2026, logistics leading) confirm demand-side readiness ([Claude blog](https://claude.com/blog/how-enterprises-are-building-ai-agents-in-2026); [ampcome/Gartner summary](https://www.ampcome.com/post/ai-agents-in-logistics-and-supply-chain)).

**Implication:** the agent layer is standardizing *horizontally* (MCP/A2A) faster than freight is standardizing *vertically*. A freight coordination layer that speaks MCP natively inherits a cross-vendor interop rail that no freight consortium ever achieved — and the window where no proprietary player (project44, McLeod+AI partners) has closed it off is short.

---

## 5. The Hard Problems

### 5.1 Identity & trust — the fraud epidemic is the demand signal

- Supply-chain crime losses ≈ **$725M reported in 2025, +60% YoY**; organized theft +1,500% since 2021; estimates of total annual losses run to **$35B** (upper-bound industry estimate — treat as directional); average theft value $273,990 (+36% YoY) ([TruckingInfo digital cover](https://www.truckinginfo.com/digital-cover-features/cargo-thefts-new-playbook-strategic-fraud-double-brokering-and-cybercrime-hit-trucking); [Inbound Logistics](https://www.inboundlogistics.com/articles/risky-business-inside-the-freight-fraud-surge/)).
- Highway's Q3 2025 Fraud Index: fraud attempts **+219% YoY, 48,700+ fake carrier identities flagged in one quarter** ([FreightWaves](https://www.freightwaves.com/news/cargo-theft-dips-in-q1-but-fraud-schemes-surge-report-says)).
- **Highway** is becoming the de facto private identity layer: 1,050+ brokers including **70 of the top 100**, FTV Capital growth round Aug 20, 2025 ([Highway press release](https://highway.com/press-releases/highway-secures-strategic-growth-equity-investment-led-by-ftv-capital)).
- The public root of trust is finally moving: FMCSA requires **identity verification for all new authority applicants since April 1, 2025** (document + facial match, physical address requirement) and is replacing three legacy registration systems with **Motus** (registrant rollout from May 2026), extending ID verification to all existing registrants in phases ([FMCSA URS fact sheet](https://www.fmcsa.dot.gov/sites/fmcsa.dot.gov/files/2025-03/URS_ID-Verification_FactSheet.pdf); [Transport Topics on Motus](https://www.ttnews.com/articles/fmcsa-motus-registration)).

**Reading:** for the first time, freight has (a) a government identity root being hardened (FMCSA/Motus), (b) a commercial verification layer with real network density (Highway), and (c) an epidemic that makes identity a purchase trigger rather than a compliance checkbox. A co-signed ledger's "who signed this" problem can anchor to these rather than inventing an identity system — which was never true for TradeLens or BiTA.

### 5.2 Data ownership & antitrust

- Freight rate/shipment data is contested property: Convoy v. DAT (monopoly claims allowed to proceed, settled 2023 with the dispute centering on exclusivity clauses over brokers' own rate and shipment data) and DAT/OTR (2025, court forced DAT to halt its Outgo unit) show incumbents will litigate over who may aggregate freight data ([FreightWaves](https://www.freightwaves.com/news/judge-allows-convoys-monopoly-complaints-against-dat-to-proceed); [Labworks on DAT/OTR](https://labworksusa.com/blogs/the-implications-of-the-dat-and-otr-dispute-settlement)).
- The rail price-fixing suits (rate-discussion evidence allowed) mark the antitrust boundary for any shared layer that could enable horizontal rate visibility ([Industrial Distribution](https://www.inddist.com/logistics/news/22236524/court-allows-rate-talks-in-rail-pricefixing-suits)).
- **Design consequence:** a coordination layer must be architecturally incapable of horizontal pooling of competitively sensitive data (rates, margins, lane strategies). Per-tenant isolation + explicit counterparty-scoped visibility/redaction is not just a security feature — it's the antitrust defense TradeLens never cleanly had.

### 5.3 Network effects & cold start — why freight networks die

Three distinct failure modes, all evidenced:
- **TradeLens:** value gated on universal adoption; competitor-owned (§3.1).
- **BiTA:** standards with no running software and no forcing function; members drifted; merged away ([Ledger Insights](https://www.ledgerinsights.com/blockchain-logistics-bita-gbbc-merger/)).
- **Convoy (Oct 2023):** subsidized marketplace liquidity; when cheap capital and freight demand vanished simultaneously, the network had no standalone unit economics — "treated logistics like a tech platform problem, not an operational resilience problem"; blitzscaling masked the financials ([CNBC](https://www.cnbc.com/2023/10/19/bezos-backed-freight-firm-convoy-shuts-down-read-ceo-memo-here.html); [FreightWaves](https://www.freightwaves.com/news/convoy-shutdown-trucking-startup); [Logistics Navigators postmortem](https://www.logisticsnavigators.com/casestudies/convoys-shutdown-and-the-limits-of-freighttech-hype)).

Common denominator: **each depended on network scale arriving before single-participant ROI did.** The survivors (Highway, project44, GSBN, OLF eCMR) all deliver standalone value to participant #1.

### 5.4 Who pays for interop

Evidence on incentive flow:
- **Shipper/broker pays; carrier is paid in loads, not cash.** Visibility platforms charge shippers/LSPs ($100–500/user/mo plus setup) and make carrier connection free/one-day, because carrier compliance is contractually forced by the shipper ([Tradlinx cost analysis](https://blogs.tradlinx.com/how-much-does-project44-fourkites-or-vizion-really-cost-what-lsps-need-to-know-before-paying-for-premium-visibility-tools/); [project44 carrier FAQ](https://www.project44.com/carriers/faqs/)).
- **Ariba's cautionary tale:** charging the *supply side* (suppliers) works only under buyer coercion, and ~80% of the time the fee is passed back through pricing anyway — the buyer pays covertly and resents it ([Redress Compliance](https://redresscompliance.com/sap-ariba-negotiations-managing-transaction-fees-volume-tiers-and-network-costs/)).
- **Highway's model:** brokers (the fraud-loss bearers) pay; carriers participate free because it gets them loads faster. Payment follows loss-bearing.

**Rule extracted:** the party who eats the failure cost (fraud loss, detention dispute, invoice dispute, onboarding delay) pays for the layer; every other party must join at zero marginal cost or be paid in speed.

---

## 6. Analogy Scan: Coordination Layers That Won

| Layer | What made it stick | Freight-equivalent move |
|---|---|---|
| **ISO container** (1968) | One physical interface (corner castings, 20/40ft); McLean's patents given to ISO **free**; loading cost fell $5.83→$0.16/ton — 36x; now ~90% of non-bulk trade ([ISO](https://www.iso.org/news/ref2215.html); [Malcom McLean, Wikipedia](https://en.wikipedia.org/wiki/Malcom_McLean)) | Standardize the *smallest* interface (the event/attestation format), give the spec away, monetize operations on top — never the spec |
| **Stripe** | Collapsed weeks of merchant-acquirer onboarding into 7 lines of code; sold to developers, not committees | Collapse the $2,500/partner, multi-week EDI onboarding into an API key + schema; the buyer is the person feeling the pain today, not the industry body |
| **Twilio** | Wrapped a hostile legacy network (SS7/carriers) in a clean API without asking telcos to change | Wrap X12/EDI/VANs as *adapters* at the edge of the ledger; never require the counterparty to migrate first (speak 204/214 out the back while keeping canonical events inside) |
| **Plaid** | Rode user-permissioned access + eventual regulatory air-cover (§1033) — but 2025-26 shows the risk: rule enjoined, CFPB rewriting it, JPMorgan now charging aggregators for data access ([Open Banking Tracker](https://www.openbankingtracker.com/guides/section-1033-status); [fee dispute](https://www.openbankingtracker.com/guides/open-banking-data-access-fees)) | Screen-scraping-equivalent (portal automation, email/PDF parsing) as the bridge while incumbents stall — but expect data-holders to impose tolls once you matter; get the *customer's* contractual right to their own data in writing |
| **FHIR/HL7** | Modern web-dev ergonomics (REST/JSON/OAuth) **plus** the Cures Act/ONC mandate; yet 95% of hospitals still run HL7 v2 underneath — new and old rails coexist for decades ([Rhapsody](https://rhapsody.health/blog/fhir-vs-hl7-explained/); [healthit.gov](https://healthit.gov/interoperability/investments/fhir/)) | Expect 15+ years of EDI coexistence; win by being the system that *translates faithfully*, and watch FMCSA/FSMA-204-style rules as the mandate vector |
| **Ariba/Coupa** | Buyer coercion built the network — but supplier-side fees poisoned goodwill and got priced back in (§5.4) | Never charge the carrier/driver side; monetize the tenant who buys the outcome |

---

## 7. Synthesis (a): Necessary Conditions for a Freight Coordination Layer

Each condition is falsified-by-absence in at least one corpse:

1. **Single-participant ROI on day one.** The layer must be a complete operating system for tenant #1 with zero counterparties connected. *(TradeLens and BiTA died waiting for the network; Highway, OLF eCMR, and visibility platforms survive because participant #1 gets paid immediately.)*
2. **Neutral or self-owned data plane — no competitor as landlord.** Per-tenant ledgers, tenant-owned keys. *(TradeLens: "wary of joining" a Maersk product.)*
3. **Adapters, not migrations, at every boundary.** Speak X12 204/214/210 outward indefinitely; canonical events are internal truth. *(Twilio/FHIR pattern; 95% of hospitals still on HL7 v2; EDI market still growing §1.1-1.2.)*
4. **The loss-bearer pays; everyone else joins free.** *(Ariba's supplier fees priced back through ~80% of engagements; Highway charges brokers, carriers ride free — §5.4.)*
5. **Identity anchored to external roots, not invented.** FMCSA/Motus + commercial verification (Highway) + device/key attestation. *(48,700 fake carriers/quarter makes unanchored self-attestation worthless — §5.1.)*
6. **Narrow, bounded, painful first artifact.** One event family (e.g., POD→invoice, or appointment) — not "digitize trade." *(eCMR and eBL move; "everything platforms" don't — §2.)*
7. **Antitrust-safe by construction.** Structural inability to pool competitively sensitive data across tenants; counterparty visibility explicit and redacted. *(DAT litigation shows data aggregation is a legal battlefield — §5.2.)*
8. **Ride the horizontal agent rails.** MCP (AAIF/Linux Foundation, Dec 2025) and A2A v1.0 are the first genuinely vendor-neutral B2B interop rails freight has ever been offered for free; a coordination layer exposing its gates/events via MCP gets cross-vendor reach without a consortium. *(§4 — and no logistics-specific interop standard exists yet to compete with.)*
9. **Verifiability without blockchain.** Hash-chained, co-signed, append-only per-tenant logs give the audit property TradeLens sold, minus the consortium governance that killed it. *(§3.3; event sourcing is now conventional architecture, not exotica.)*
10. **A capital structure that survives a freight recession.** *(Convoy: the network was real, the unit economics weren't; the 2022-23 downcycle executed it — §5.3.)*

**Bottom-line answer to the framing question:** a *universal* coordination layer (one shared layer everyone speaks to) is **not buildable** on 2026 evidence — every attempt at universality is in the graveyard. A *federated* one — per-tenant ledgers with a shared attestation format, EDI adapters at the edges, MCP at the agent boundary, identity anchored to FMCSA+Highway-class roots — is buildable, because every one of its components now has a live, independently funded existence proof.

## 8. Synthesis (b): Near-Impossible Problems & Observed Mitigations

| Problem | Why near-impossible | Realistic mitigation / pivot (precedent) |
|---|---|---|
| **Legacy TMS vendors opening up** | Integration friction is their moat; API access is licensed/five-figure (§1.5); they will never voluntarily commoditize state they hold | Don't ask. Enter via the counterparty's *own* data rights (Plaid pattern), EDI streams the tenant already receives, and driver/portal capture at the physical edge. Long-game: an FMCSA/FSMA-style data-access rule — but US trucking has no §1033 analog on the horizon (UNVERIFIED — none found), so plan for none |
| **Universal identity for drivers/carriers/shipments** | 750K carriers, identity churn is the *business model* of fraud rings (+219% YoY); no single root | Layered attestation: FMCSA/Motus root + commercial graph (Highway) + cryptographic device/session binding per event. Accept probabilistic identity with an audit trail rather than universal certainty (banking's KYC model, not a national ID) |
| **Liability for co-signed facts** | If a co-signed POD triggers same-second invoicing, a wrong fact is now a *warranted* fact — who's liable? No freight case law exists (UNVERIFIED — none found) | eBL's path: statute first (UK Electronic Trade Documents Act / MLETR analogs gave eBLs legal equivalence before scale-up). Until then: corrections-as-new-events (never rewrite), evidence attached to every money event, and contractual liability caps mirroring how VANs disclaim message content today |
| **Counterparty co-signature cold start** | Every co-signed fact needs the other party's key — a per-relationship mini-network-effect | Degrade gracefully: single-signed + evidence (photo/GPS/hash) is still better than an EDI 214; upgrade to co-signed when the counterparty joins (Highway's free-for-carriers wedge; visibility platforms' one-day carrier connect) |
| **Antitrust exposure once the layer aggregates many tenants** | Success creates exactly the horizontal data pool regulators and DAT-style incumbents attack | Structural isolation (per-tenant DBs, no cross-tenant benchmarking product, ever) and third-party-audited data-flow attestations |
| **Surviving the incumbents' agent land-grab** | project44/McLeod are wiring proprietary agent fleets into their installed bases now (§4.3); the window closes if "agentic freight" becomes their walled garden | Be the *open* MCP surface for freight state before they are; horizontal protocol gravity (MCP/A2A under Linux Foundation) favors whoever exposes clean primitives first, not whoever owns the biggest legacy install base |

---
**Key unverified items (recap):** precise 2026 EDI share of freight transactions; precision of MCP adoption figures (third-party trackers); Stedi pivot timeline details; $35B fraud upper bound (industry estimate); absence of US trucking data-access regulation and of co-signed-fact case law (absence-of-evidence, searched 2026-08-01).
