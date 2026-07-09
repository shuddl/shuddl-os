# SHUDDL — v1 Build & the Zero-Cutover Doctrine
## Genesis doc 05 · 2026-07-09 · straightforward to execute, impossible to mistake for a legacy TMS

## 1. v1 scope (the spine — everything else rides later)
**Ledger core** (events, evidence, lenses, money-lines, authority map) · **6 of the 13 agents**: Concierge (email-in quoting + auto-reply), Rater (cost-surface floors — engine already exists and is field-deployed), Scheduler, Gatekeeper, Biller (POD→invoice→evidence email), Migrator · **3 surfaces**: Command, Driver PWA (gated, offline-first, forced photos), Client portal + public status page · **Adapters**: email in/out, QuickBooks journal export, EDI 214-out + 204-in (Translator-lite), legacy-TMS overlay (ingest + project — the tenant-#0 requirement) · **MCP v1**: quote/book/track for paired companies.
Explicitly **not** v1: native GL (never), driver pay (defer), full EDI matrix (partner-by-partner), Direct guest checkout (v1.5), cartage marketplace (v2), anchoring beyond TSA timestamps (v2).

## 2. Why v1 is genuinely straightforward (assets in hand, all portable)
The rating/floor engine is built, audited (48 tests + a 42-defect remediation), and live in production use today; the cost model is calibrated on a real carrier's export; the customer/zone/tariff data patterns are proven; rate→invoice-outside-the-TMS ran successfully as an emergency tool; a 3,100-bill re-rate harness exists for shadow validation; legacy import formats are known byte-for-byte; the parity map against the incumbent's full 15-module corpus is written (every function → primitive/agent/lens/integrate/delete). v1 is **assembly on a new spine**, not research. The spine itself (events + lenses + gates) is deliberately boring engineering.

## 3. Zero-cutover, as product (L8) — the Overlay
For any tenant with an incumbent TMS:
1. **Mirror** — Migrator ingests exports/feeds continuously; the ledger shadows every live shipment with `source:legacy` provenance.
2. **Shadow** — agents compute (rates, invoices, alerts) in parallel; deltas dashboarded; nothing external changes. Parity gates: aggregate ±2%, sampled routes ±10%, invoice-match to the penny.
3. **Augment** — evidence starts flowing *forward*: drivers on the PWA, POD photos, comms unification — the legacy system keeps receiving its projections and stays internally consistent (it becomes a *lens* without knowing it).
4. **Authority flips, per module** — rating → invoicing → dispatch → settlement, each behind its gate, each with automatic fallback on drift. Two clean month-end closes before the money flags flip. 
5. **Archive** — incumbent goes read-only; full history preserved; exit report generated.
No cutover day exists in this sequence — which is the entire point. The same Overlay is a **sales motion**: "keep your TMS; we'll just quietly out-prove it," and the parity dashboard is the close.

## 4. Tenant #0 (the carrier that funds the physics with reality)
A working regional LTL carrier + brokerage adopts via Overlay: its live export becomes the mirror; its reps already use the deployed pricing front door (which becomes the Rater's UI); its 6-person billing desk becomes the exception-queue pilot; one terminal pilots the gated driver flow; its interline partners exercise the Settler. Its own replacement timeline (separately briefed: ~16–20 weeks to daily-ops authority, floor 14, gates identical to §3) becomes the platform's first case study — OR, DSO, unbilled-to-zero, before/after, publishable. **This product is not for that carrier; it is proven by it** — the spec never hardcodes its zones, tariffs, or org anywhere outside tenant config.

## 5. Build order (dependency-honest, ~12 weeks to v1-complete; verification per tenant per Overlay gates)
Weeks 1–2: ledger core + primitives + auth/tenancy + Migrator v1 (spreadsheet/CSV/legacy export).
Weeks 3–5: Rater mounted as service (existing engine) + Gatekeeper + Driver PWA gated flow (the POD→invoice→photo-email loop demo-able end-to-end on real freight by week 5 — this is the heartbeat demo).
Weeks 5–8: Concierge (email quoting) + Scheduler + portal/status pages + Command surface + comms unification v1 (email; voice v1.5).
Weeks 8–10: Biller/Collector hardening + QuickBooks export + Watchtower + EDI 214/204 lite.
Weeks 10–12: MCP v1 + Overlay authority-map tooling + PLG signup + Spark tier metering.
Parallel always: the 50-agent adversarial audit pattern per module (it caught 42 defects in the pricing engine; it is now the standing QA doctrine), fixture replay gates, and the acceptance tests from L6 (10-minute CSR, zero-instruction driver).

## 6. What we deliberately keep weird (so v1 doesn't regress to the familiar)
No "shipment entry screen" — there are events and questions. No report builder — there are 12 live views and a copilot. No settings labyrinth — policy is a page of plain-language rules the copilot edits with you. No training mode — the gates teach. No "sync" button — there is one truth. Every PR that adds a fourth surface, a fifth primitive, or a twenty-third table gets rejected with a citation to doc 00. The familiar TMS is the failure condition.
