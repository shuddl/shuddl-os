# SHUDDL — Ledger & Consensus Architecture
## Genesis doc 02 · 2026-07-09 · how "every party reads one unalterable truth" actually works, without blockchain theater

## 1. The core object: the Shipment Event Ledger
Per shipment, an **append-only, hash-chained log of events**: `event = {seq, ts, actor(Party+device key), kind, payload, evidence[], prev_hash, sig}`.
- **Append-only**: nothing is ever edited or deleted. Corrections are new events with reversal semantics (`correction_credit/debit`, `pod_superseded`) — the accounting discipline applied to operations.
- **Hash-chained + signed**: each event commits to the previous (tamper-evident); actors sign with device/user keys. Custody transitions are **co-signed** — driver key + receiving party's tap/signature — which is the pragmatic "consensus": the two parties whose reality changed both attested at the moment it changed (L1, L2).
- **Anchored**: Merkle roots of the day's ledgers are externally timestamped (RFC 3161 TSA; public-chain anchoring optional later). Anyone can verify a POD photo existed, unaltered, at 14:32 on delivery day — without us being trusted. This is what makes evidence packets court- and claims-grade.
- **Not a blockchain**: single authoritative writer (the platform) with cryptographic receipts beats distributed consensus here on latency, cost, and honesty — the parties don't run validators; they hold *verifiable receipts*. If a future counterparty demands shared custody of truth, the anchor layer upgrades without touching the product.

## 2. Lenses (how many parties read one record)
A **lens** = role-scoped, live projection of the ledger: ops sees everything; the shipper sees their shipments, prices, docs; the consignee sees arrival, evidence, claims; a cartage partner sees their leg + settlement; a factor/insurer sees what the tenant grants. Portal, status page, driver app, EDI 214s, email digests, Claude answers — **all lenses of the same log**, so there is nothing to reconcile and no version of "call to confirm." Counterparty-visible vs internal is an explicit flag per event kind, tenant-configurable.

## 3. Offline & the physical edge
Drivers work in dead zones: the PWA captures events locally (signed, sequenced per device), syncs opportunistically; conflicts are impossible by design because event streams **merge by (device, seq)** — CRDT-style append, never overwrite. Photos/dims/signatures hash locally at capture (the hash is in the signed event; the bytes upload when there's signal), so evidence integrity survives bad coverage. Geofence stamps come from the device with GPS accuracy recorded — detention math discloses its error bars (physics, honestly).

## 4. Money as projection (L3, mechanically)
`money_lines` attach to events, never float free. The Biller subscribes to `pod.signed` → emits `invoice.issued` (+ renders PDF, sends evidence email) in the same transaction window. Interline/cartage splits are computed from custody legs (`interline_split` lines, D83-style percentages as tenant/partner policy). Settlement events close the loop; the GL **exports** (QuickBooks/Xero journals) — the ledger is the subledger of record, the accounting package remains the book of record. Close = replaying a month of events; a clean close is a property of the architecture, not a heroic act.

## 5. Legacy compatibility & synchronization (L8 — the zero-cutover machinery)
The ledger runs as an **overlay** over any incumbent system:
- **Ingest adapters** turn legacy signals into events *with provenance and confidence*: nightly/streamed exports (e.g., a 171-column legacy extract), EDI in, emails, even OCR'd paper. A legacy-sourced event is labeled `source:legacy, confidence:x` — visible truth, lower trust tier until evidenced (L1 events outrank reconstructions, always).
- **Project adapters** write the ledger *back out* as whatever the legacy world speaks: rate-profile CSVs, shipment-entry payloads/XML writes, EDI out, PDFs, statements. During overlay, the incumbent stays internally consistent while authority migrates.
- **Authority map**: per module (rating, invoicing, dispatch, settlement), a flag says who is authoritative today — with parity gates (aggregate ±2%, per-route ±10%, clean close) required to flip each flag, and automatic fallback if drift exceeds tolerance. "Zero cutover risk" is this map: there is never a day, only measured flag-flips with rollback.
- **Bidirectional sync discipline**: one direction is always authoritative per field; echoes are detected by event ids embedded in projections (no ping-pong).

## 6. Communications unification (the internal/external gap-killer)
Email (tenant domain + per-shipment addresses + inbox connectors), voice (numbers with consent-aware recording → transcription), SMS, and portal messages all become **Message events** resolved to Party + Shipment: deterministic keys first (pro #, quote #, thread), then sender identity, then embedding match with a review queue for <0.9 confidence. Every message lands on the timeline, is instantly visible to anyone with the lens, carries agent-drafted replies where due, and starts SLA timers. Compliance handled as policy: two-party-consent states get announced recording or transcript-only mode.

## 7. Identity & the Freight Passport (L9)
Every Party accrues a portable, evidence-backed record: verified identity (registry pulls), insurance (COI expiry watched), operating authority, on-time and claims behavior, payment behavior. The Passport replaces per-relationship credit applications and carrier packets: presenting it is one click; trusting it is rational because it's computed from co-signed ledger history, not self-reported PDFs. Passports are the network's gravity — and each tenant's private data stays theirs (only behavior *scores* travel, tenant-consented).

## 8. Stack (deliberately boring, edge-native)
Workers/edge compute + per-tenant SQL (D1-class) for primitives, R2-class object store for evidence bytes (lifecycle policies per document kind), Durable-Object-class coordination for live boards and ledger sequencing, queues for agent triggers, vector index for Message resolution and Copilot. LLMs run *in agents at the edges* (parsing, drafting, translating, explaining) — **never in the ledger**: truth is deterministic, intelligence is advisory, and every agent action is itself an event with a cited basis. Multi-tenant from day one; tenant isolation at the database level; one-click full export (L10).

## 9. Failure honesty (what breaks and what happens)
No signal at delivery → events queue signed on-device; invoice fires on sync; the SLA timer notes the gap. Driver skips a photo → the gate physically won't advance; override requires a name and reason and is visible forever. Legacy export goes stale → Watchtower alarms; authority flags freeze. A counterparty disputes anyway → the evidence packet (co-signed events + anchored hashes) is the argument. An agent is wrong → its action event links its basis; correction events fix the record; the error trains the gate. The system is designed so that the *cheapest* path for every actor is the honest, evidenced one.
