# RAW RESEARCH APPENDIX — Strategic Questions A–D: Integration Fatigue, Coordination-Layer Whitespace, Market Sizing, MCP in Logistics
**Compiled by background research agent, 2026-08-01. Preserved (condensed, all citations kept) as source material for docs 03/04/06. All sources accessed 2026-08-01.**

## A. INTEGRATION FATIGUE EVIDENCE (2025–2026)

1. **FreightCaviar survey, Apr 3 2025** ([AI Fatigue in Freight](https://www.freightcaviar.com/ai-fatigue-in-freight-what-brokers-actually-want/), fetched): 170+ freight professionals; 76% plan tech investment in 2025 but suffer **"tool fatigue rather than AI opposition"** — "systems that promise efficiency but demand months of onboarding and don't integrate with existing workflows." Practitioner verbatim on AI: "Married, but definitely in a toxic relationship." Priorities: minimal implementation time, integration with current TMS/accounting, admin-time recovery.
2. **FreightWaves, Nov 6 2025** ([shippers consolidating tech stack](https://www.freightwaves.com/news/why-shippers-are-consolidating-their-tech-stack-for-long-term-growth), fetched): OneRail CEO Bill Catania verbatim: **"more solutions mean more data fragmentation and less fluidity in the supply chain"**; "as many as four systems replaced" per consolidation.
3. **FreightWaves, Jul 13 2026** (['AI Agents Without Context Are Just Guessing Faster'](https://www.freightwaves.com/news/ai-agents-without-context-are-just-guessing-faster), fetched): project44 CEO Jett McCandless verbatim: **"AI agents without context are just guessing faster"**; "Shippers have found that there's a lot of work to try to create context so that those agents can actually be effective." — mainstream articulation that the binding constraint on freight AI is a shared context/state layer, not model quality.
4. **FreightWaves, Jul 15 2026** ([AI adoption nears peak hype](https://www.freightwaves.com/news/ai-adoption-supply-chain), fetched): Redwood CIO Eric Rempel: supply chain "about to go into the Trough of Disillusionment"; "There are a lot of AI demos better than anything I've ever seen in my entire life...Everything goes wrong all the time"; "The mistake is trying to shotgun it without giving it context or memory."
5. **Gartner "agent washing," Jun 2026** ([via BizTechReports](https://www.biztechreports.com/news-archive/2026/6/17/gartner-warns-of-agent-washing-risks-in-supply-chain-planning-technology-market)): relabeling conventional automation as agentic increases "risk of misaligned investments and long-term lock-in"; most current "agentic" SC products deliver only query/recommendation, not decision-quality change; end-to-end autonomy claims before 2027 "overstating." Related (secondary): [Gartner Nov 12 2025 — autonomous planning passed Peak of Inflated Expectations](https://www.gartner.com/en/newsroom/press-releases/2025-11-12-gartner-says-autonomous-planning-has-passed-the-peak-of-inflated-expectations-on-supply-chain-planning-technology-hype-cycle); by 2030 half of cross-functional SCM will use intelligent agents vs <5% 2025; **>40% of agentic AI projects expected scrapped by 2027** (secondary-sourced).
6. **Fragmentation cost figure**: logistics fragmentation "costs businesses an estimated **$184 billion annually**" ([FreightWaves on ITF Group, Sep 30 2025](https://www.freightwaves.com/news/itf-groups-new-platform-tackles-logistics-fragmentation), fetched; methodology not shown). Vendor-side: "full-stack vs point solutions" is now a marketing category; fragmented stacks ~$6,000/mo ([Debales.ai](https://debales.ai/blog/freight-broker-ai-comparison-2026-full-stack), vendor marketing; its inner Gartner citation UNVERIFIED). McKinsey 2025 State of AI (secondary): 88% of orgs use AI somewhere, ~6% capture meaningful enterprise value.
7. **UNVERIFIED/gaps:** Reddit thread-level sentiment (fetch blocked); JOC (paywalled); Brittain Ladd; Craig Fuller verbatim on agent-to-agent proliferation.

## B. COORDINATION-LAYER WHITESPACE — WHO IS BUILDING BELOW THE POINT SOLUTIONS

**Short answer: no one is building a neutral, multi-party, append-only, co-signed physical-event ledger with money as a projection.**

| Player | Layer covered | Missing vs co-signed event ledger |
|---|---|---|
| Scheduling Standards Consortium | Appointment API spec only | **Dormant: freightapis/ssc GitHub repo last pushed 2024-10-11 (~22 months stale, checked via API 2026-08-01)**; one verb; founding member Convoy dead |
| project44 / LSP44 | Visibility + agents + TMS (proprietary) | **Split into two entities July 14 2026** (project44 = enterprise shippers; LSP44 = 3PLs/forwarders/brokers; McCandless leads both) ([transportmanagement.org](https://www.transportmanagement.org/project44-splits-into-two-companies-spins-off-lsp44/)). Walled garden; carriers/brokers are endpoints, not tenants; no co-signing, no money-as-projection |
| FourKites | Control tower + digital twins + agents ("Tracy," "Sam," Loft Feb 2026) | Proprietary, shipper-centric; exited documents (Haven sunset) |
| Stedi | EDI pipes | Left freight for healthcare |
| NMFTA DSDC / Digital LTL Council | LTL API standards (eBOL 2022 "rapid adoption"; Preliminary Freight Charges API 2025 ([NMFTA](https://nmfta.org/news/nmfta-digital-ltl-council-launches-preliminary-freight-charges-api-standard-advancing-industry-wide-billing-transparency/))) | LTL-only; specs not infrastructure. NMFTA-cited 2025 research: digital collaboration standards/APIs = #1 investment priority for 37% of transportation CxOs (secondary) |
| DCSA | Ocean documentation standards (10 carriers ≈ 75% of container trade) | Ocean only |
| Open Logistics Foundation | EU open-source components (eCMR etc., 50+ members) | Component library, EU-centric, no US footprint |
| Highway | Identity primitive | 1,050+ brokers incl. 70 of top 100; Q4 2025 Fraud Index: ~2M fraudulent emails, 8.5M spoofed numbers blocked; Q1 2026: 527,940 blocked emails (+49.9% YoY), 97% double-brokering reduction for customers (secondary). **No physical events, no money** |
| TriumphPay | Payments primitive | **$100B cumulative TPV Q1 2025; >50% of US brokered TL freight touches network** ([Triumph](https://triumph.io/blog/broker/triumphpay-reaches-100b-in-total-payment-volume/)); money not tied to co-signed physical record |
| Palantir | Per-enterprise ontology (Foundry) | Not freight-native, not multi-tenant-neutral, not co-signed |

**Takeaways:** (1) The industry's most credible neutral-coordination attempt (SSC) covered one verb and stalled — consortium standards die without an operating company behind them. (2) Highway and TriumphPay prove single-primitive networks win adoption fast in exactly SHUDDL's target population. (3) The slot below the point solutions is genuinely open.

## C. MARKET SIZING ANCHORS

- **$906B** US trucking gross freight revenue 2024 (down from $1.004T 2023); 72.7% of US freight by weight; forecast $1.46T by 2035 ([ATA](https://www.trucking.org/economics-and-industry-data), fetched).
- **~580,000 active US motor carriers** (June 2025); 91.5% ≤10 trucks; 99.3% ≤100 ([ATA], fetched). Finer cut (FMCSA MCMIS Dec 2023 via [Max Dispatch compilation](https://maxdispatchservice.com/how-many-trucking-companies-in-the-us/), secondary): 53.1% one truck; 15.7% two; 21.4% 3–10; **7.2% 11–100 trucks (~42K carriers); 0.64% >100**. For-hire 519,420; private 197,563.
- **28,351 active property brokers** (FMCSA MCMIS snapshot Aug 29 2025, same secondary compilation).
- Brokerage: ~$19.5B net-revenue-style 2025 ([Mordor](https://www.mordorintelligence.com/industry-reports/united-states-freight-brokerage-market)); gross: A&A US 3PL $302.7B gross / $131.2B net 2024, DTM segment down 4.2% 2024; top-10 brokers hold ~$55–60B gross of ~$150B+ DTM → very long tail of ~28K small brokerages ([FreightCaviar/A&A](https://www.freightcaviar.com/a-as-top-10-freight-brokerages-and-the-state-of-the-industry-in-2025/)).
- TMS: **~$16–19B global 2025, ~10–15% CAGR** (defensible band across M&M/GVR/Precedence/Fortune).
- FreightTech VC: 2021 peak **$41.3B/1,203 deals** (PitchBook via [FreightWaves Mar 18 2025](https://www.freightwaves.com/news/freighttech-set-for-ai-revolution)); trough **$25.6B (2021) → $2.9B (2023), ~90% plunge** (McKinsey, high-confidence secondary); recovery AI-led: Q4 2024 SC-tech $9.1B ex-Waymo (+158% YoY). "$15.1B 2025 logistics-tech funding" figure UNVERIFIED.

## D. MCP IN LOGISTICS (mid-2026)

**Verifiably shipping MCP servers:**
1. **Terminal49** — production MCP at mcp.terminal49.com, OAuth 2.1, container tracking tools, setup guides for Claude/ChatGPT/Cursor/Copilot ([docs](https://terminal49.com/docs/mcp/home), fetched). Most mature freight MCP.
2. **Alvys** — MCP in **limited beta, read-only**, "governed, authenticated gateway to the Alvys Public API… scoped to your tenant, and audited"; five guided prompts (load covering, dispatch, onboarding, settlement recon, tracking); docs updated **2026-07-29** ([Alvys MCP docs](https://docs.alvys.com/docs/mcp), fetched). Directly in SHUDDL's segment.
3. Community: freightutils-mcp (19 free tools).

**Verified/likely absent:** project44 (developer portal has no MCP; strategy is proprietary embedded agents — "Mo" analyst, Jul 23 2026; McCandless: "clicks, not code… you don't need prompt engineers" — **betting against open agent access**); Stedi (docs/mcp 404s); DAT (proprietary Copilot; no MCP found, absence UNVERIFIED); Highway/FourKites/TriumphPay (no MCP evidence, absence UNVERIFIED).

**A2A:** 150+ orgs at one-year mark (Apr 2026), in Vertex/Azure/Bedrock; supply chain named among early production verticals ([Linux Foundation](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)); no named freight A2A deployment found.

**MCP spec:** final 2026 specification shipped **July 28, 2026** ([MCP blog](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)). Industry essays converge on MCP-style standardization as the missing layer ([HackerNoon LCP proposal](https://hackernoon.com/how-a-standardized-logistics-context-protocol-lcp-can-unlock-ais-full-potential-in-supply-chain); [Max Freight Forwarders, Jul 29 2026](https://company.maxfreights.com/2026/07/29/model-context-protocol-and-the-future-of-agentic-supply-chains/)) — while naming zero logistics companies that operate MCP servers.

**Strategic read:** The MCP surface in domestic US trucking is nearly empty: one ocean-tracking vendor + one mid-market TMS read-only beta. Enterprise platforms are deliberately building closed embedded agents. A co-signed ledger shipping a first-class MCP server (acceptance demo #4) would be roughly first-to-market in the truckload/brokerage segment; the Alvys beta validates the exact security posture SHUDDL enforces (tenant-scoped, audited, server-side-gated).

**Caveats:** Gartner/McKinsey primary fetches blocked; JOC paywalled; figures carried via secondary coverage as noted.
