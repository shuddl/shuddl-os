# SHUDDL — Product Specification
## Genesis doc 01 · 2026-07-09 · every element cites a Law (L1–L10 from doc 00)

## 1. Primitives (four, budgeted — a fifth requires proof twice)
- **Party** — any economic actor: shipper, consignee, carrier, broker, cartage agent, driver, factor. Carries the Freight Passport (identity, insurance, credit behavior, scorecards) (L9).
- **Shipment** — mass moving A→B, any mode; legs (direct, interline, brokered, cartage, dray, transload) are custody segments of one object.
- **Money** — every economic line (charge, cost, split, correction, settlement) attached to ledger events (L3).
- **Message** — every communication (email, call transcript, SMS, portal chat, EDI transaction) resolved to Party + Shipment (L2).
Everything else is a **view** or an **agent** on these. Schema budget ≤22 tables; UI budget: 3 surfaces + command bar + queues (L6).

## 2. The agent mesh (13 agents; each: trigger → action → confidence gate → human queue)
| Agent | Runs | Gate |
|---|---|---|
| **Concierge** | Inbound email/SMS/voicemail → parsed intent → quote/booking/status/claim routed; auto-replies in tenant's voice with the answer, not an acknowledgment | Confidence <0.9 or money >$X → human review; all sends logged as Messages |
| **Rater** | Prices every request from the cost surface (stops, touches, cube-miles, dwell, density) + market layer; floors always attached | Below target-OR → approval; below contribution → dual approval (proven matrix) |
| **Scheduler** | Books pickup windows/appointments against dock capacity + driver hours; proposes to requester, confirms, calendars all parties | Conflicts or constraint violations → dispatcher |
| **Dispatcher copilot** | Builds route/co-load suggestions from live physics (positions, hours, cube); drafts check-ins; predicts misses hours ahead | Human dispatcher approves the board |
| **Gatekeeper** | Enforces L7 at every transition; assembles evidence packets (photos, geostamps, signatures, dims) | Overrides = named + reasoned + logged |
| **Biller** | POD event → invoice emitted same second → consignee/shipper auto-emailed signature photo + placed-freight photo + invoice/receipt per terms | Anomaly rules (>$/lb, >$ cap, negative) → review before send |
| **Collector** | Aging watch, tone-matched dunning drafts, cash-application suggestions, statement runs | Sends on approval; escalations named |
| **Settler** | Interline/cartage/carrier splits computed from custody events; escrowed instant settle on network moves; carrier-pay matching | Controller approves cycles; disputes carry evidence chains |
| **Translator** | EDI in/out (204/210/214/990/997), any partner guide learned + validated against a test suite; also CSV/PDF/legacy formats | New partner mappings certified via replay harness before live |
| **Migrator** | Eats any legacy export/spreadsheet → primitives with provenance + confidence; powers both onboarding and the L8 overlay | <0.8 field confidence → mapping review |
| **Watchtower** | Anomalies, floor breaches, unbilled=0 alarm, concentration, FSC staleness, margin/service drift | Reads to owners daily; pages on red |
| **Credit officer** | Registry/bureau/reference pulls → terms recommendation in minutes; credit-hold gate at booking | Terms above threshold → owner approval |
| **Copilot** | Answers anything about the tenant's own operations with evidence links; "ask why" on every number (L6) | Read-only; cites ledger events |

## 3. Surfaces (three, plus the API/MCP)
**A. Command (web)** — one screen: command bar (natural language → any action), live board (map + lanes + exceptions heat), and queues (approvals, exceptions, money). No modules, no menus-of-menus, no report catalog — ~12 canonical live views + copilot export for anything else. KPI layer always on: OR, DSO, unbilled (alarm at ≠0), OTD, dwell, lane P&L, per-role scoreboards — all computed from the ledger, provable on click (L3, L6).

**B. Driver (PWA, offline-first)** — the sensor of record (L1). Day sheet → per-stop gated flow: arrive (geofence auto-stamp) → count/scan pieces → **forced photos** (freight, seal, exceptions) → dims capture by camera where fitted → signature on glass → depart. Delivery gate completes only with signature + placed-freight photo → POD event → Biller fires → consignee contact receives the signature + photos by email/SMS within seconds (the moment that sells the product). OS&D captured at the scan with photo → claim draft opens itself. Works with zero instruction: each screen is one question and one button; the gate is the training (L7). COD prompts, round-trip and stop-off flows included.

**C. Client portal (and public status page)** — self-serve quote→book in under a minute, live tracking with the same truth ops sees (lens, not copy), documents (BOL/POD/invoices with evidence), spend analytics and scorecards, claims with the custody chain visible, statement/pay. Guest quoting allowed (email-gated); booking requires account or platform credit (see doc 03). Delivery notifications with photos are on by default — consignees experience the brand at every door (L2, L3).

## 4. The gates catalog (L7 — what's blocked until what's captured)
| Transition | Blocked until | Evidence captured |
|---|---|---|
| Quote → Booked | Credit OK + floor cleared (or approval) + weight/dims present ("no price on air") | Quote snapshot w/ versions |
| Booked → Dispatched | Docs complete + appointment/window set | BOL emitted; calendar events |
| Arrive pickup → Depart | Piece count + photos (+ dims if fitted) + shipper sign | Custody event co-signed |
| Linehaul/interline handoff | Seal/trailer scan + receiving party ack | Interchange event (co-signed) |
| Arrive delivery → **Delivered** | Geofence + signature + **placed-freight photo** (forced) | POD event → **auto-invoice + evidence email, same second** |
| Delivered → Paid | Invoice emitted; disputes must reference an event | Settlement events |
| Any exception | Photo + reason code at capture | Claim draft w/ chain |
| Any below-floor price | Named approval per matrix | Approval event |
| Any correction | Reversal event w/ reason (never edits) | GL export nets |

## 5. Brokerage & the capacity mesh
Brokered = same Shipment with buy-side Money. Desk: live carrier sourcing with Passport vetting, one-tap tender → e-signed rate con, tracking ingestion (ELD/app/API), margin governance (floors as tenant policy), instant escrowed settle replacing quick-pay/factoring. **Cartage agent add-ons** (L9): local carriers install the driver PWA, accept legs under the custody protocol, get scored and settled instantly — a marketplace of final-mile/interline execution that turns every small carrier into extended fleet, white-labelable so a carrier tenant can offer national coverage on Shuddl rails.

## 6. Communications (the gap-killer)
Tenant mail domain + per-shipment address (pro@tenant.shuddl.com), inbox connectors, voice line with consent-aware recording/transcription, SMS. Every Message auto-resolves to Party + Shipment (identifiers, thread history, embeddings), lands on the shipment timeline (internal + counterparty-visible per lens), gets an agent draft where a reply is due, and starts an SLA timer. "Who told the customer what, when" stops being a question anyone asks (L2).

## 7. Modules that ride the same rails (expanders, all optional)
RFP Gate (bid files → floors → decisions), Price-letter engine, Demand traps (SEO/landing micro-sites that feed Concierge), Port-to-Door/transload (devan, storage, reship as custody events), OS&D console, QBR/scorecard packs, Watchtower for owners, EDI self-serve wizard ("EDI in a day"), accounting journal export (QuickBooks/Xero — GL is never rebuilt), payroll/HR/maintenance = integrations, never modules.

## 8. Superiority table (vs. the legacy category, falsifiable)
| Moment | Legacy category | SHUDDL |
|---|---|---|
| Quote request by email | Read → re-key → maybe reply | Concierge replies with bookable price in ≤60s |
| Booking | Keyed twice (order + rating) | One event; rated at creation with floors |
| "Where is it?" | Phone tree | Lens/status page/Claude, all live |
| POD → invoice | Days–weeks (or never: $402K) | Same second, with photo evidence to the client |
| Detention | Argument | Geofence math, pre-agreed |
| New EDI partner | Months | Translator + harness: ~a day |
| New employee | Weeks of training | <10 min to first booking (L6 acceptance test) |
| Month-end unbilled | Discovered by consultants | Alarm at ≠0, daily |
| Leaving the vendor | Hostage negotiation | One-click full export (L10) |
