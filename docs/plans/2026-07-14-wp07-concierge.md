# WP-07 Concierge (email-in quoting) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task (this session). Per task: implementer → spec-compliance review → code-quality review → fix loop. Close with the REQ-119 adversarial exit-audit swarm, then superpowers:finishing-a-development-branch (merge to `main`). Keep every `pnpm verify` gate green.

**Goal:** An inbound freight email becomes a priced, floor-clean auto-reply draft (auto-sent only when confident *and* above floor, else queued for a human), with the message resolved to a Party + Shipment and every communication landing on the ledger timeline.

**Architecture:** The Concierge is agent #of-13. Its **pure composition** (`packages/agents/src/concierge/*`) turns a `message.received` event + a parse result into: a resolved Party/Shipment, a `quote.priced` (via the pure Rater), a tenant-voice reply draft, and a send-or-queue decision. The **LLM parse is behind a three-adapter port** (the WP-06 `EvidenceSender` pattern): a deterministic parser for tests, a loud `NotConfigured` default, and a real Claude adapter that is written but config-gated (no LLM calls in CI — keeps the build deterministic and REQ-024-clean). The **queue consumer** (`workers/agents/src/concierge.ts`, sibling to `biller.ts`) drives it, appending events through the existing `SHIPMENT_SEQ` DO and sending the reply through the existing Resend sender. The **live inbound webhook** (Resend receiving → `message.received`) is the deferred, CONFIRM-gated tail — the core parses a `message.received` that is already on the ledger.

**Four load-bearing decisions (assumptions — stated, not silently taken):**
1. **The message is the truth; `messages` is a projection (REQ-100).** Every communication — inbound email, outbound reply, internal note — is a `message.*`/`quote.*` **event** appended to the ledger; the `messages` table becomes a **read-model projected from those events** (a new `packages/ledger/src/projection/messages.ts`, wired into the sequencer DO batch beside the money projection). "No communication exists outside the ledger."
2. **LLM parse is a config-gated port, never called in CI.** Tests use a `DeterministicParser` (fixture/rule-driven); the real `ClaudeParser` (Anthropic adapter) is selected only when an API key is bound — exactly like `ResendSender`. This is the FIRST LLM usage; it lives ONLY in `packages/agents`/`workers/agents` (REQ-024 lint forbids it in `packages/ledger`/`packages/rater`).
3. **Auto-send requires confidence ≥ 0.9 AND floor-clean.** An auto-reply auto-sends only when the parse `confidence ≥ 9000 bps` (REQ-026/093) **and** the priced quote is not below floor (reuse the Rater's approval/floor logic, mirroring the Biller's anomaly hold). Below either ⇒ the reply is **drafted and queued for a human**, never sent. A below-floor quote is NEVER auto-sent (permanent, like REQ-040).
4. **Pre-resolution inbound rides the `q:` stream namespace** (already in the `stream_id` regex `q:[\w-]+`). A `message.received` that hasn't resolved to a shipment lives on `q:<id>`; once resolved (≥0.9), the shipment is created and the quote/reply reference `s:<shipment_id>`. Resolution confidence < 0.9 ⇒ the message stays queued (unresolved), per REQ-093.

**Tech stack:** TypeScript strict, no `any`; Zod at every boundary; the pure Rater (`priceShipment`); integer-cents; Cloudflare Workers + `SHIPMENT_SEQ` DO + Queues; the Anthropic SDK (real parse adapter only, config-gated); Vitest + `@cloudflare/vitest-pool-workers`.

**Reuse (do NOT rebuild):** the `message.received/sent`, `quote.requested/priced/sent/accepted/expired`, `call.transcribed` kinds (all in the 35 — **no new kind**); the `messages` table (`0002_domain.sql:67-71`, columns `resolved_conf/thread/drafted_by_agent/sla_due_ts`); the visibility defaults + narrow-only lens (`ledger/src/visibility.ts`, `lens.ts` — `message.*`=counterparty, `call.transcribed`=internal); the timeline via `readEvents(db, lens)`; the pure Rater (`priceShipment`, `RateRequest = {origin_zip, dest_zip, weight_lb?, dims?, accessorials?}`); the append pattern in `routes/rate.ts` (quote.priced + agent.acted + approval.requested-if-below-floor); the `EvidenceSender` port + the Resend sender; the agent queue + DLQ + the `queue()` ack/retry/poison pattern; the `parties.contacts` recipient resolution; the `fixtures/manifest.json` + `tools/rater/parity.ts` PENDING-advisory harness.

**Budget guards (must stay green):** 35 event kinds (**no new kind**); ≤22 tables (`messages` already exists — **no new table**); REQ-024 LLM-only-in-agents (lint); tenant isolation (REQ-025); traceability (every WP-07 REQ annotated at close); the 1,131-test baseline stays green.

**Explicitly DEFERRED to a CONFIRM-gated tail (built as stubs/ports now, wired when the owner authorizes; documented in the close-out — NOT this build):** the live Resend **inbound** webhook (`email.received` → svix verify → `message.received`; needs receiving ENABLED on `send.shuddl.tech` + a deployed endpoint) — REQ-091's inbound half; live `ClaudeParser` calls (config-gated, key not in CI); real auto-send to real customers (milestone-gated); the **50-real-email accuracy DoD** (engagement-workspace fixtures — PENDING-advisory harness, like WP-04/06 parity); voice/`call.transcribed` ingestion.

---

## Task 1: Type the comms/quote event payloads

**Why first:** `message.received/sent`, `quote.requested/sent/accepted` are currently `JsonObject` (name-only). The Concierge needs typed payloads to carry channel/direction/refs/confidence/intent.

**Files:** Modify `packages/contracts/src/events.ts` (+ a new `packages/contracts/src/messages.ts` if cleaner); Test `packages/contracts/test/*`.

**Payloads to add (Zod, `.strict()`):**
- `MessageReceivedPayload = { channel: "email"|"sms"|"voice"|"portal"|"note", from_ref: string (email/phone/handle), thread?: string, body_ref: string (R2/document ref or inline hash), intent?: "quote"|"status"|"claim"|"unknown", parse_confidence?: Bps }` — the inbound fact.
- `MessageSentPayload = { channel, to_ref: string, thread?: string, body_ref: string, drafted_by_agent?: string, in_reply_to?: string }` — the outbound fact.
- `QuoteRequestedPayload = { request: { origin_zip, dest_zip, weight_lb?, dims?, accessorials? }, source_message_event_id?: string }` — the parsed rate request (mirror `RateRequest`; reuse the shape from `@shuddl/contracts` if the rate body schema is shared, else define once).
- `QuoteSentPayload = { quote_event_id: string, to_ref: string, message_event_id: string }`; `QuoteAcceptedPayload = { quote_event_id: string }`.
- Keep `quote.priced` unchanged (already typed). `call.transcribed` may stay `JsonObject` for now (voice is deferred) — note it.

Wire each into the `LedgerEvent`/`EventInput` discriminated unions. **`EVENT_KINDS.length` stays 35** (the pin test must still pass — you're typing existing kinds, not adding).

**TDD:** write failing contract tests (each payload parses valid, rejects malformed, round-trips through `LedgerEvent.parse` with a stable hash — reuse the honest assertions from WP-06 Task 1, NOT a re-implemented canonicalizer). Then run **all consumer suites** (`@shuddl/contracts`, `@shuddl/api`, `@shuddl/ledger`, `@shuddl/agents`) — the WP-05 lesson — and fix any fixture building these kinds untyped.

**Commit:** `feat(contracts): type the comms/quote event payloads for the Concierge (REQ-026/093/099)`

---

## Task 2: The `messages` read-model projection

**Files:** Create `packages/ledger/src/projection/messages.ts`; modify `workers/api/src/do/sequencer.ts` (add to the batch beside money/passport/status projections); a migration ONLY if you make `messages` append-only (see decision); Test `packages/ledger/test/*` + an api projection test.

**Decision to encode (Decision 1):** `message.received`/`message.sent` (and `quote.sent`) project to a `messages` row (`INSERT`). Reconcile the doc-10 `sla_due` vs migration `sla_due_ts` naming (the migration column is `sla_due_ts` — use it). Map: `channel`, `direction` (received→"in"/sent→"out"), `party_id` (from the event's resolved party if present), `shipment_id`, `resolved_conf` (from `parse_confidence`/resolution), `thread`, `body_ref`, `drafted_by_agent`. Keep it INSERT-only (the event is immutable truth; a later correction is a new event) — do NOT UPDATE rows (Law 2 spirit). If a deterministic id is needed, derive from the event id.

**TDD:** a `message.received` event → exactly one `messages` row with the right columns; a `message.sent` → an "out" row; a non-message kind → no row. Wire into the DO and prove via the api harness (append a message.received, query `messages`). Confirm `check:invariants` still 21/22 (no new table) and append-only holds.

**Commit:** `feat(ledger): project message.*/quote.sent into the messages read-model (REQ-100)`

---

## Task 3: The parse port (LLM, three-adapter, config-gated)

**Files:** Create `packages/agents/src/concierge/parse.ts` + `test/parse.test.ts`. Export from `src/index.ts`.

**Interface + adapters (mirror `sender.ts` exactly):**
```ts
interface ParseResult {
  intent: "quote" | "status" | "claim" | "unknown";
  request?: { origin_zip: string; dest_zip: string; weight_lb?: number; dims?: {...} | null; accessorials?: string[] };
  party_hint?: { email?: string; name?: string };
  confidence: number; // bps 0..10000
  notes?: string;
}
interface ConciergeParser { parse(email: { from: string; subject: string; body: string }): Promise<ParseResult> }
```
- `DeterministicParser` — rule/fixture-driven (regex/keyword extraction for the synthetic smoke set); deterministic, no network; used by ALL tests. It's a real, if simple, parser (handles the smoke fixtures) — NOT a stub that returns constants.
- `NotConfiguredParser` — the default when no LLM key is bound; `parse()` **rejects loudly** (never a silent low-confidence — a silent no-op is forbidden, per the sender-port law) naming what's missing (the CONFIRM-gated `ANTHROPIC_API_KEY`).
- `ClaudeParser` — the live adapter (`@anthropic-ai/sdk`, injected config `{apiKey, model, fetchImpl?}`, never reads env). A tight prompt → strict JSON → Zod-validate the `ParseResult` (reject/low-confidence on malformed model output; the model NEVER writes ledger truth directly — its output is validated then the deterministic pipeline decides). NEVER exercised against the network in tests (stub `fetchImpl`).

**TDD:** the `ParseResult` Zod schema (valid/invalid); `DeterministicParser` extracts origin/dest/weight from representative synthetic emails; `NotConfiguredParser` rejects with the actionable message; `ClaudeParser` with a stubbed fetch returns a validated result and rejects a malformed model response (no `any`, no network). Add `@anthropic-ai/sdk` to `packages/agents` deps (used only by the live adapter).

**Commit:** `feat(agents): Concierge parse port — Deterministic/NotConfigured/Claude adapters, LLM config-gated (REQ-024/026/098)`

---

## Task 4: Party + Shipment find-or-create (confidence-gated resolution)

**Files:** Create `packages/agents/src/concierge/resolve.ts` (pure over a small DB port) + tests; the consumer (Task 6) supplies the D1-backed port.

**Behavior (REQ-093):** given a `ParseResult` + a stream context, resolve to a Party (match an existing party by `party_hint.email` in `parties.contacts`, else create a new one with the email in `contacts`) and a Shipment (create a new shipment carrying the parsed request's parties, or match an existing thread). Resolution carries a **confidence**; **< 0.9 (9000 bps) ⇒ return `unresolved` (queue for a human), never auto-create/auto-quote.** Respect the FK order (party BEFORE any accruing event — `load.ts:6-7`) and the required shipment columns (`shipper/consignee/bill_to_party_id NOT NULL`, `created_ts`).

**TDD (pure, with a fake DB port):** a high-confidence email with a known party → resolves to the existing party + a new shipment; an unknown party → creates a party; a low-confidence parse → `unresolved`; missing physics (no weight/dims) → the request is UNKNOWN-priced downstream (don't fabricate). No cross-tenant reads (the port is tenant-scoped).

**Commit:** `feat(agents): Concierge resolve — find-or-create Party+Shipment, <0.9 queues (REQ-093)`

---

## Task 5: The Concierge composition (parse → resolve → price → draft → decide)

**Files:** Create `packages/agents/src/concierge/compose.ts` + tests. Reuse `priceShipment` from `@shuddl/rater` and the Rater floor/approval helpers (as the Biller does).

**`composeConcierge(input): ConciergeResult`** where the result is a discriminated union:
- `{ status: "auto_reply"; events: [...]; reply: { to, subject, html/text, body_ref } }` — appended + SENT (confidence ≥ 0.9 AND floor-clean).
- `{ status: "queued"; reason: "low_confidence" | "below_floor" | "unresolved" | "unknown_price"; draft?: {...} }` — drafted, NOT sent.
Steps: run the resolve; if resolved, `priceShipment(request, config)`; if `PRICED` and floor-clean and confidence ≥ 0.9 → compose the tenant-voice reply (REQ-098 — a small deterministic template seeded by tenant config; the LLM may *draft* but the SENT content is validated/bounded) and mark `auto_reply`; if below floor OR conf < 0.9 OR unresolved OR `UNKNOWN` price → `queued` with the reason + a draft. **A below-floor quote can NEVER be `auto_reply`** (assert; the permanent guard, mirroring the Biller's anomaly hold — reuse `assessApproval`/executing-share). Pure: no Date/random/I-O; deterministic.

**TDD (table-driven):** high-conf + floor-clean → auto_reply with a quote.priced + message.sent in `events`; below-floor (even high-conf) → queued(below_floor), NO send; conf 0.89 → queued(low_confidence); unresolved → queued(unresolved); no weight → queued(unknown_price). Determinism.

**Commit:** `feat(agents): composeConcierge — floor-clean + confidence-gated auto-reply, else queue (REQ-026/093/098)`

---

## Task 6: The Concierge queue consumer (wire it live on the ledger)

**Files:** Create `workers/agents/src/concierge.ts`; modify `workers/agents/src/index.ts` (branch `queue()` by message kind — extend the message union with a `MessageReceivedTrigger` beside `PodSignedMessage`); modify the api append path to enqueue a Concierge trigger when a `message.received` commits (mirror the Biller's `waitUntil` enqueue after the batch); Test `workers/api/test/concierge.test.ts` (integration).

**Behavior:** on a `message.received` trigger → load the stream context (the message, tenant config, any thread) → build the D1-backed resolve port + the parser (`NotConfiguredParser` by default; `ClaudeParser` iff `ANTHROPIC_API_KEY` bound — composition-root selection, like `evidenceSender()`) → `composeConcierge` → on `auto_reply`: append the events through `SHIPMENT_SEQ` (quote.priced + quote.sent + message.sent, correct `party_refs`/visibility) and send the reply via the Resend sender; on `queued`: append the drafted `message.sent`? NO — a queued draft is NOT sent; record it as an internal draft (a `message` row with `drafted_by_agent` set, no outbound send) + optionally an `approval.requested`. Idempotent under redelivery (deterministic ids; the DO id-dedupe). Send failure NEVER unwinds the ledger facts (Biller law).

**TDD (integration, deployed-style harness):** drive a `message.received` (synthetic quote email) with a `RecordingSender` + `DeterministicParser` → assert: the resolve created a party+shipment, a `quote.priced` landed penny-consistent with the Rater, a `message.sent` (the reply) landed AND the RecordingSender captured exactly one reply; a below-floor email → queued, NO reply sent, a draft recorded; low-confidence → queued/unresolved, nothing auto-created beyond the message; idempotent replay → one reply.

**Commit:** `feat(agents): Concierge consumer — message.received → parse/resolve/price/reply, floor+confidence gated (REQ-026/093)`

---

## Task 7: Timeline visibility + "no comms outside the ledger" (REQ-094/099/100)

**Files:** mostly tests over the lens (`packages/ledger/test/*`, `workers/api/test/*`); small fixes if `message.*` events don't carry `party_refs`.

**Prove:** every `message.received`/`message.sent`/`quote.*` on a stream surfaces on the shipment timeline via `readEvents(db, partyLens)` with the right `party_refs`; `message.*` defaults to `counterparty` and reaches the counterparty lens; an **internal note** (`channel:"note"` or `call.transcribed`) stays `internal` and is REDACTED from the counterparty lens (REQ-094); a driver lens sees `message.*` per `DRIVER_KINDS` but not internal notes. **REQ-100:** assert there is no code path that sends/records a communication WITHOUT a `message.*` event — the reply send in Task 6 always appends `message.sent` first; add a test that a sent reply has a corresponding ledger event (no orphan sends), and that an internal note is a `message.received{channel:note, visibility:internal}` event (not a side table).

**Commit:** `test(wp07): timeline visibility + no-comms-outside-the-ledger (REQ-094/099/100)`

---

## Task 8: SLA timers on inbound needing reply (REQ-095)

**Files:** the consumer sets `messages.sla_due_ts` on an inbound needing reply; a cron sweep in `workers/agents` (reuse the scheduled handler) flags/records overdue; Test the mechanism.

**Behavior:** when a `message.received` needs a reply (intent=quote/status, not yet answered), set `sla_due_ts` (now + tenant SLA window — the window from tenant config; the "now" is the event's `recorded_at`, not a fresh clock, for determinism where possible; the cron may read wall-clock). A scheduled sweep finds `messages` with `sla_due_ts` past and no answering `message.sent`, and records an overdue signal (a `message` flag or an internal `message.received{channel:note}` "SLA breached" event — NO new event kind; reuse `message.received`/an existing kind). Mirror the REQ-169 reconciliation-sweep pattern (idempotent, aggressive-safe).

**TDD:** a message needing reply gets `sla_due_ts`; the sweep flags an overdue one and NOT an answered one; idempotent.

**Commit:** `feat(agents): SLA timers on unanswered inbound + overdue sweep (REQ-095)`

---

## Task 9: The parse-accuracy harness (PENDING-advisory) + synthetic smoke

**Files:** Create `tools/concierge/parse-parity.ts` (mirror `tools/rater/parity.ts`'s loud-skip); add a `fixtures/manifest.json` row `{id:"concierge-parse-50", status:"pending", sha256:null, source:"manifest.private M-xx (50 real historical quote emails)", gates:"WP-07 DoD (≥90% parsed, 100% floor-clean sends)"}`; add an in-repo synthetic smoke set (5-8 emails, NEVER under `fixtures/`, like WP-06's invoice-parity smoke) run by the harness always; wire `check:concierge-parity` into `pnpm verify` after `check:invoice-parity`.

**Behavior:** the smoke set always runs — each synthetic email → `DeterministicParser` → asserts the extracted `request` matches the expected fields AND the composed decision (auto_reply vs queued) matches (incl. a below-floor email that MUST queue). The 50-real-email set is PENDING (advisory exit 0) until vendored + hash-pinned; it must **never false-green** (hard-fail if present-but-unpinned, like the invoice-parity guard).

**Commit:** `test(wp07): Concierge parse-parity harness (smoke live, 50-email DoD pending-advisory)`

---

## Task 10: WP-07 exit audit (REQ-119) + close-out + finish branch

**Step 1 — adversarial exit-audit swarm (3+ lenses):** attack (a) can a **below-floor** quote EVER auto-send (the permanent floor law)? (b) can the **LLM output** write ledger truth unvalidated / can a crafted email inject a bad request or a prompt-injection that changes the sent content? (c) **confidence bypass** — can a < 0.9 parse auto-send/auto-resolve? (d) **tenant isolation** — cross-tenant party/shipment resolution or timeline leak (REQ-025)? (e) **REQ-100** — any comms path (reply, note, SLA) without a ledger event? (f) **visibility** — an internal note reaching a counterparty lens (REQ-094)? (g) idempotency/redelivery → duplicate replies/quotes? (h) money/penny consistency of the Concierge's `quote.priced` vs the Rater. Verify each finding independently; fix Criticals with proving tests; no open Criticals at close.

**Step 2 — close-out `docs/wp/WP-07.md`** (match `WP-06.md`): DoD split OBSERVED (parse port + deterministic smoke; resolve; floor+confidence-gated auto-reply; the messages projection + timeline; SLA timers; the consumer integration) vs **CONFIRM-gated/deferred** (live Resend inbound webhook + svix — REQ-091 inbound; live ClaudeParser calls; the 50-real-email accuracy DoD; real customer auto-send; voice/call.transcribed) vs later WP; the 4 decisions + assumption log; the REQ-119 audit record.

**Step 3 — traceability:** add `WP-07` to `tools/traceability/active-wps.json`; annotate every WP-07 REQ (026/093/094/095/098/099/100) in source (honest status per REQ — buildable vs deferred-tail). `pnpm check:traceability` green (WP-01..07, no orphans).

**Step 4 — verify + finish:** `pnpm verify` fully green; superpowers:finishing-a-development-branch → merge `wp-07-concierge` to `main` with a `--no-ff` `Merge WP-07:` commit; push; delete the branch. Commit this plan doc as a `plan: WP-07 …` record.

---

## Out of scope (register amendment required to add — do NOT build here)
- Any NEW event kind (the 35 cover it — `message.*`/`quote.*`/`call.transcribed` exist). An SLA-breach kind would be an amendment — reuse an existing kind instead.
- The live inbound webhook / Resend receiving enablement / svix endpoint (the CONFIRM-gated tail — needs the owner to enable receiving + deploy the endpoint).
- Live LLM calls in CI (the `ClaudeParser` is config-gated; CI uses `DeterministicParser`).
- Status/claim intents beyond routing stubs (WP-07's DoD is quoting; status/claim are later depth).
- Voice ingestion (`call.transcribed` payload stays loose; voice is later).
