# SHUDDL — Claude-Native Booking & Agentic Distribution
## Genesis doc 03 · 2026-07-09 · freight booked from a sentence, anywhere an AI lives

## 1. The thesis
The next freight interface isn't a portal — it's **whatever assistant the shipper already talks to**. SHUDDL ships as a **remote MCP server** so Claude (and, by the same protocol, any agent platform) can quote, book, track, and settle freight natively. Distribution inverts: instead of dragging shippers to a website, the OS meets them inside the conversation where the "I need 2 pallets in Denver by Friday" sentence was already typed. We are early enough that *"book freight from Claude"* is a category-defining demo.

## 2. The MCP surface (v1 tools)
`quote_freight(origin, dest, pieces, weight, dims?, accessorials?, ship_date)` → priced options with floors honored, honest transit windows
`book_shipment(quote_id, pickup_contact, references?)` → booked + BOL + pickup scheduled (Scheduler agent)
`track(pro_or_ref)` → live custody state + ETA + evidence available
`get_document(shipment, kind)` → BOL/POD/invoice with evidence links
`request_pickup(shipment)` / `reschedule(...)`
`approve(approval_id)` → the human gate, in-chat (below-floor prices, credit exceptions)
`dispute(shipment, reason)` → opens claim with the custody chain attached
Every tool returns provenance (ledger event ids); every mutation is gated (L7) and becomes a signed event attributed to the paired identity. Idempotency keys on all mutations; spend limits and lane allowlists enforced server-side — an AI can *ask* for anything, it can only *do* what the pairing allows.

## 3. Identity: the three booking postures
1. **Paired-company** — a user OAuths Claude to their org's SHUDDL workspace (their company is a tenant or a tenant's customer). Bookings ride their contract pricing, credit terms, and approval matrix. The CFO's guardrails apply to the intern's chatbot.
2. **Credit-line guest** — known-passport counterparty without a workspace: books against a platform-underwritten credit line (Credit Officer agent decides in minutes from the Passport + bureau pulls).
3. **Default: SHUDDL Direct** — anyone else books through **the platform's own central network** (merchant of record): card/ACH upfront, freight executed by network capacity (tenant carriers + brokerage + cartage mesh). This is the crucial default — the funnel where the OS is also the counterparty, every booking seeds a Passport, and retail demand becomes network freight. TP-class carriers are the executing capacity and earn the linehaul; the platform earns the take (doc 04).

## 4. Agent-to-agent commerce (the forward posture)
The same MCP/API is the endpoint for *other companies' agents* — a shipper's ERP copilot, a 3PL's bot, a marketplace — negotiating within published guardrails: quotes carry signed validity windows; bookings require capability tokens; disputes reference ledger events. Freight becomes something software can transact **safely**: not because the AI is trusted, but because the gates, floors, and evidence chain don't care who's asking. When agent-driven procurement arrives at scale, SHUDDL is already the settlement-grade endpoint it lands on.

## 5. In-chat experience details that make it land
Booking confirmation returns a live status-page link (lens) usable by anyone in the org; delivery day, the *requester* gets the signature + placed-freight photos in the same thread; "why is this $412?" answers with the cost/floor explanation (L6 provenance, surfaced conversationally); exceptions arrive as questions ("Consignee dock closes at 3 — deliver tomorrow 8am or authorize liftgate residential tonight +$95?") answerable in one word. The whole lifecycle — quote to POD photo — without leaving the chat.

## 6. Safety & compliance rails
Money movement always confirms with a structured summary before commit; per-pairing spend caps, velocity limits, geo/lane allowlists; hazmat and other regulated flows require explicit workspace enablement; server-side validation treats every client (human UI included) as untrusted; full audit = the ledger itself. Anthropic-side: standard remote-MCP OAuth; nothing exotic required.

## 7. Sequence
v1: read + quote + paired-company booking (tenant #0's customers first — the wow is immediate). v1.5: SHUDDL Direct guest checkout + credit-line posture. v2: agent-to-agent tokens, multi-assistant distribution (the MCP is assistant-agnostic by construction).
