# WP-11 — Collector + QuickBooks Export + Watchtower Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Each task is TDD. The penny-reconcile (QB), the R2 delete sweep, the recon-sweep hold-marker, and the 4 ledger hardenings are the risk centers — full two-stage review + an adversarial pass.

**Goal:** Close the money loop over the append-only ledger: a **Collector** that watches AR aging and drafts tone-matched dunning (human-sent, never auto), a **QuickBooks journal export** that reconciles a fixture month to the penny (journal-only — native GL forbidden), a **Watchtower** that raises anomaly / floor-breach / unbilled=0 alarms + agent cost/latency drift + weekly tenant-0 telemetry, a statement/pay-affordance surface, R2 lifecycle retention, the REQ-169 reconciliation sweep, and four ledger hardenings (REQ-176/178/180/183).

**Architecture:** WP-11 is agents + ledger-read work, almost entirely additive over existing seams. The GL double-entry builder (`packages/ledger/src/gl/export.ts` `exportJournal`, balance-asserted) EXISTS — WP-11 wraps it in a QB serializer + a route + a hash-pinned month fixture. The Collector/Watchtower/recon are new **crons** in the existing `scheduled()` handler (`workers/agents/src/index.ts:277`), modelled on `runSlaSweep` (deterministic ids, self-clearing, tenant-bound, injected clock). **No new table** (alarms → the existing `anomalies` table; snapshots → R2; aging/statement → views) and **no new event kind** (dunning send → `message.sent`; draft → a `messages` row; internal signals → `message.received{channel:"note",visibility:"internal"}`). The only LLM surface (dunning drafts) lives in `packages/agents` (REQ-024). Pay EXECUTION is CONFIRM-gated OUT — WP-11 ships the affordance, not the settle.

**Tech Stack:** Cloudflare Workers + Hono · D1 per-tenant · R2 (snapshots + doc retention) · Queues/Cron (the agents `scheduled()` handler) · Resend (dunning send, existing port) · React 19 (the portal statement tab) · TypeScript strict, no `any` · Zod `.strict()` · integer-cents law · LLM only in `packages/agents`.

---

## Source-of-truth grounding
- **DoD (genesis/08 §03, WP-11):** "Aging/dunning drafts; cash-app suggestions; journal export; anomaly/budget/unbilled alarms. **Export reconciles a fixture month to the penny in QB sandbox; unbilled alarm fires on seeded $0-revenue bill.**"
- **REQ rows:** REQ-010 (one-click full tenant export, open formats) · REQ-019 (interline/cartage splits from custody legs) · REQ-020 (GL journal export QB/Xero; **native GL forbidden**) · REQ-032 (Collector: aging + tone-matched dunning drafts; **sends on approval**) · REQ-036 (Watchtower: anomaly + floor-breach + unbilled=0 alarms) · REQ-090 (statement/pay surface) · REQ-113 (per-agent cost+latency budgets; drift alarms) · REQ-116 (R2 lifecycle per doc kind; 7yr POD; storage cost line) · REQ-160 (tenant-0 weekly Watchtower snapshots) · REQ-169 (Biller reconciliation sweep) · REQ-176 (held reply must surface + not count answered) · REQ-178 (Concierge fast-path from-name pin) · REQ-180 (inherently-internal kinds never widen) · REQ-183 (credit_status projection no-op if party absent). **REQ-179 (invoice.issued gl_map/division redaction) is ALREADY DONE in WP-09 — do NOT rebuild.**
- **Ground-truth map:** `scratchpad/wp11-map.md` (7-reader sweep). Read it before Phase A.
- **Hard budgets:** 22 tables (21 used + 1 spare — DO NOT spend it), 35 event kinds (frozen), 12 views, native-GL-forbidden (journal export only), LLM only in `packages/agents`, design CI now BLOCKING.

## The locked decisions
- **D-a — QB serializer + penny reconcile.** Wrap the existing `exportJournal` (balanced Σdebit===Σcredit) in a deterministic **QuickBooks IIF journal** serializer (the canonical QB journal-import text format). The in-repo proof is code-provable: `exportJournal` balances + the `qb-journal-month` fixture reconciles to the penny (the `gl-netting.fixture.test.ts` shape); the live "QB sandbox" round-trip is a documented external CONFIRM step. **Resolve the chart-of-accounts discrepancy (C2):** the Biller compose codes (`4000-FREIGHT-AR`/`4100-FSC-AR`/`4200-ACCESSORIAL-AR`, `gl-map.ts:7-9`) are CANONICAL; the `qb-journal-month` fixture is generated consistent with them (update `gen-gl-netting.ts`'s bare codes OR generate via the compose path). One canonical account set, one parity test.
- **D-b — No new table, no new event kind.** Alarms → the existing `anomalies` table (`0002_domain.sql:99-102`, mutable, ON CONFLICT upsert like `anchor.ts`). Dunning DRAFT → a `messages` row (`recordDraft` shape, `drafted_by_agent='collector'`), NO event. Dunning SEND → `message.sent`. Hold/surface signals → `message.received{channel:"note",visibility:"internal"}` (the `sla-sweep.ts` idiom). Snapshots → R2 (NOT a table). Aging/statement → views over `invoices`/`money_lines`.
- **D-c — Dunning is DRAFT-ONLY + human-send (REQ-032 verbatim: "no auto-send").** The Collector emits drafts; an operator reviews them in a Collector queue and clicks send (a route appends `message.sent` + calls `EvidenceSender`). Do NOT generalize the WP-10 dual-control approvals for dunning. Widen the sender so a party/invoice-scoped dunning email needs no `shipment_id` (make it optional on `EvidenceMessage`).
- **D-d — Pay is AFFORDANCE-ONLY.** REQ-090 ships the statement + aging + a remit/pay affordance + honest paid-vs-open state from the ledger. Pay EXECUTION (escrow/settle, REQ-033/143/108) is CONFIRM-gated OUT; Stripe is unwired. State the assumption in the PR; build NO settle.
- **D-e — Watchtower snapshots → R2, weekly via a day-of-week gate.** Persist snapshot manifests to R2 (`env.EVIDENCE`, the anchor-cron precedent) — no table spent. The 3 existing KPI computes (unbilled/DSO/OR, in `workers/api/src/kpis/compute.ts`) move to a SHARED compute module both `workers/api` and `workers/agents` import; build the 4 missing (POD→invoice latency, rating latency, disputes, close duration). External PUBLISHING is CONFIRM-gated — build the telemetry, gate the publish.
- **D-f — REQ-169 recon sweep gets a self-clearing HOLD MARKER.** A permanent Biller HOLD appends nothing today, so a held POD would re-enqueue unbounded. The Biller emits a durable internal note on a permanent hold; the recon anti-join (`pod.signed` without `invoice.issued`) EXCLUDES streams carrying that marker — bounding the re-drive.
- **D-g — The 4 hardenings.** REQ-180 (never-widen internal floor): clamp the 7 code-default-internal kinds (`visibility.ts:39-45`, incl. `split.computed`) — the fail-closed superset; NOTE the register names only 6 and propose updating it. REQ-183: assert `CREDIT_SQL` rows-affected ≠ 0 → a loud Watchtower gap note (do NOT fabricate a party row). REQ-176: surface the held reply as a durable note + exclude held-but-unsent from the answered-check WITHOUT breaking the REQ-174 backstop (distinguish sent from held). REQ-178: pin `from_name` into `message.sent` (an additive optional field on `MessageSentPayload`) + read it back on the fast-path re-render — canonical-hash-safe (existing events lack the field, so their bytes are unchanged; regenerate the seed hash only if the seed carries a from-named message.sent — it does not).

## Reuse (do NOT rebuild)
- **GL:** `exportJournal(db, range, filter?)` (`packages/ledger/src/gl/export.ts`) — balanced double-entry over `money_lines`; the `gl_map` (`money_lines.gl_map`), the split apportionment (`packages/ledger/src/money/split.ts`, Hamilton/BigInt), the penny fixture (`gl-netting.fixture.test.ts` + `tools/fixtures/gen-gl-netting.ts`).
- **Agents:** the cron (`scheduled()` `index.ts:277`, `runAllTenants` `:47`, `runSlaSweep` `:60`), the idempotent append-then-send consumer (`biller.ts`/`concierge.ts` — deterministic ids, fast-path, retriable-throws/permanent-holds), the email port (`biller/sender.ts` `EvidenceSender`/`ResendSender`/`RecordingSender`), `resolveRecipient` (`biller.ts:146`), the tone-matched template idiom (`concierge/quote-reply.tsx`), the draft-without-send precedent (`concierge.ts` `recordDraft`), the internal-note idiom (`sla-sweep.ts`).
- **Watchtower store:** the `anomalies` table + the `anchor.ts` ON-CONFLICT-upsert write pattern.
- **KPI computes:** `computeUnbilled`/`computeDsoDays`/`computeCostRatioBps` (`workers/api/src/kpis/compute.ts`) — port to a shared module.
- **Statement:** the portal (`apps/portal/src/App.tsx` tabbed board + `views/InvoicesView.tsx`) over `GET /v1/invoices`; the `ageOpenAr` bucket fn (`apps/command/src/views/MoneyQueue.tsx:39`).
- **Skills:** `make-agent-idempotent-and-adapter-ported`, `harden-agent-against-model-trust`, `keep-readmodel-consistent-with-ledger`, `prove-tenant-isolation-read-paths`, `preserve-canonical-hash-byte-law`, `redact-counterparty-payloads-completely`, `share-lint-matchers-with-parity-tests`, `complete-append-only-insert-guards`.

## Do NOT build (defer — recorded)
Native GL / period close (journal export ONLY) · pay/escrow/settle EXECUTION (CONFIRM-gated; Stripe unwired) · external snapshot PUBLISHING (CONFIRM-gated — build telemetry only) · a new table / a 13th view / a 36th event kind · a report builder · seat pricing · voice · Direct merchant · any M-H-gated GTM unlock (M-H gates GTM, not building).

---

## Tasks

### Phase A — GL / QuickBooks export + one-click export

**Task 1: Reconcile the canonical chart-of-accounts (REQ-020).** Make the Biller compose codes (`-AR`-suffixed) the ONE canonical account set; a shared `CANONICAL_GL_ACCOUNTS` (or reuse `gl-map.ts`); align `gen-gl-netting.ts`'s bare codes to match (or route the fixture through the compose path); a parity test that the fixture's `gl_map` codes ⊆ the canonical set (share-lint-matchers). Keep `gl-netting.fixture.test.ts` green. **Files:** `packages/agents/src/biller/gl-map.ts` (canonical), `tools/fixtures/gen-gl-netting.ts`, a parity test.

**Task 2: The QB IIF journal serializer + export route (REQ-020).** `serializeJournalIIF(lines): string` (deterministic, integer-cents, QB IIF format) wrapping `exportJournal`; `GET /v1/export/journal?from&to&division?` (roles admin/ops/finance, tenant-lens) returning the IIF (or JSON `JournalLine[]`). Tenant-safe + an isolation case. **Files:** `packages/ledger/src/gl/iif.ts` (or `workers/api/src/routes/export-journal.ts`), `index.ts`, tests.

**Task 3: The `qb-journal-month` fixture + penny-reconcile (REQ-020, the DoD centerpiece).** A deterministic month of invoices/payments/splits → `exportJournal` → assert Σdebit===Σcredit AND the AR/AP grand totals reconcile to the penny; hash-pin the fixture (`tools/fixtures/verify.ts`), flip `fixtures/manifest.json` `qb-journal-month` `planned`→`vendored`. Document the live QB-sandbox round-trip as an external CONFIRM. **Files:** `fixtures/qb/`, `tools/fixtures/gen-qb-journal-month.ts`, `packages/ledger/test/qb-journal.fixture.test.ts`.

**Task 4: Interline split DERIVED from custody legs (REQ-019).** A producer computing `split.computed` from `custody.transferred` legs (the executing-share apportionment via `money/split.ts`); a partner-statement split fixture (REQ-019 DoD "matches partner statement"). Gate-parity (the split still flows through the sequencer). **Files:** the split producer (agents or a route), the fixture + test.

**Task 5: One-click full tenant export (REQ-010).** `GET /v1/export` (roles admin, tenant-lens) — an archive assembler unioning the tenant's events + the journal + document refs + the merkle anchor, in OPEN formats (JSON/CSV). Tenant-safe + isolation. **Files:** `workers/api/src/routes/export.ts`, `index.ts`, tests.

### Phase B — Collector

**Task 6: The Collector agent + dunning drafts (REQ-032).** `packages/agents/src/collector/` (pure aging-bucket + template selection) + `workers/agents/src/collector.ts` (the cron pass reading open-AR aging, drafting a tone-matched dunning per overdue bucket into a `messages` row, `drafted_by_agent='collector'`, NO auto-send); escalating fixed templates (reminder→firm→final) modelled on `quote-reply.tsx` (tenant voice config-seeded, NOT model output); widen `EvidenceMessage.shipment_id` to optional. Wire into `scheduled()`. Idempotent (deterministic draft id per (party, bucket, period)). **Files:** the collector dir + cron + templates, tests.

**Task 7: The Collector draft queue + approve-and-send (REQ-032).** `GET /v1/dunning?status=draft` (the draft queue read) + `POST /v1/dunning/:id/send` (human-initiated: append `message.sent` + call `EvidenceSender`, idempotent, retriable-throw/permanent-hold); a command-surface draft queue view (design-clean, BLOCKING). Tenant-safe + isolation. **Files:** `workers/api/src/routes/dunning.ts`, `apps/command/src/views/DunningQueue.tsx`, tests.

### Phase C — Watchtower

**Task 8: Watchtower alarms (REQ-036).** A `workers/agents/src/watchtower.ts` cron pass raising: **unbilled=0** (the anti-join → an `anomalies` row when >0, cleared at 0 — the DoD "unbilled alarm fires on a seeded $0-revenue bill"), **pricing-anomaly** (scan `quote.priced.payload.basis.anomaly != null` → alarm), **floor-breach** (open below-floor `approval.requested` → alarm). Reuse `anomalies` (ON CONFLICT upsert). Wire into `scheduled()`. The alarms surface via `GET /v1/exceptions`/a Watchtower read. **Files:** `watchtower.ts`, the shared anti-join compute, tests (incl. the $0-revenue-bill alarm).

**Task 9: Agent cost/latency metering + drift alarm (REQ-113).** Populate the dead `agent_runs` table from `agent.acted.cost_cents/latency_ms` (the rater/Biller emit them); a Watchtower aggregate + a drift alarm (an `anomalies` row when an agent's cost/latency exceeds its budget). **Files:** the `agent.acted` emit (rate.ts/biller.ts), `agent_runs` projection, the Watchtower drift pass, tests.

**Task 10: Tenant-0 weekly Watchtower snapshots (REQ-160).** Move `computeUnbilled`/`computeDsoDays`/`computeCostRatioBps` to a shared `packages/ledger` (or shared) compute module (both `workers/api` + `workers/agents` import); build the 4 missing metrics (POD→invoice latency, rating latency, disputes, close duration); a weekly snapshot (day-of-week gate in the daily cron) persisted to R2 (manifest); publishing gated (CONFIRM). **Files:** the shared compute, the snapshot cron, tests.

### Phase D — Statement/pay, R2 lifecycle, recon, hardenings

**Task 11: Statement/pay-affordance surface (REQ-090).** A portal statement/aging tab (rollup over `invoices` — aging buckets, open vs paid, remit/pay affordance; settle OUT) + isolation; design-clean (BLOCKING). **Files:** `apps/portal/src/views/StatementView.tsx`, `App.tsx`/`router.ts`, tests.

**Task 12: R2 lifecycle retention + storage-cost metric (REQ-116).** A doc-kind→retention-class map (POD 7yr, others shorter); a retention SWEEP (cron) deleting expired non-POD bytes, reconciling the "documents row iff bytes" invariant (tombstone the row, never orphan); a storage-cost Watchtower metric (`EVIDENCE.list`-based, NOT a money_line). Tenant-safe (the R2 key builder + the delete). **Files:** the retention map + sweep + the cost metric, tests + isolation.

**Task 13: The Biller reconciliation sweep + hold marker (REQ-169).** `workers/agents/src/recon-sweep.ts` — a cron re-enqueuing any stream with a committed `pod.signed` but no `invoice.issued` AND no hold-marker note, older than N minutes; the Biller emits a durable internal hold-marker note on a permanent hold (self-clearing bound). Idempotent (the Biller re-drive is safe). **Files:** `recon-sweep.ts`, the Biller hold-marker emit, tests (a held POD does NOT re-enqueue unbounded; an unbilled POD re-drives once).

**Task 14: The cheap ledger hardenings — REQ-180 + REQ-183.** REQ-180: an `INTERNAL_FLOOR` set clamping the 7 code-default-internal kinds after `visibility.ts:68` (never widen); a test that a policy naming `credit.checked` counterparty still resolves internal; note the 6-vs-7 register discrepancy + propose the register update. REQ-183: assert `CREDIT_SQL` rows-affected ≠ 0 → a loud gap (a Watchtower note), never a fabricated party row. **Files:** `visibility.ts`, `status-cache.ts`, tests.

**Task 15: The careful ledger hardenings — REQ-176 + REQ-178.** REQ-176: surface a permanently-held Concierge reply as a durable internal note + exclude held-but-unsent from the SLA-sweep answered-check WITHOUT breaking the REQ-174 backstop (a successful send's `message.sent` still clears the overdue flag — distinguish sent from held). REQ-178: add an optional `from_name` to `MessageSentPayload` (`comms.ts`), pin it on write + read it back on the fast-path re-render (canonical-hash-safe — regenerate the seed hash only if it moves, which it should not). **Files:** `comms.ts`, `concierge.ts`, `sla-sweep.ts`, tests + `check:seed`.

### Phase E — Exit

**Task 16: DoD acceptance + isolation sweep + full verify.** Confirm the QB penny-reconcile fixture is green + vendored, the unbilled-alarm-fires test passes, every new read/write route (export-journal, export, dunning, watchtower, statement, R2 sweep) has an isolation case; full `pnpm verify` (design blocking, all fixtures green). Then the REQ-119 exit-audit swarm.

---

## Assumption log (state in PRs)
- Pay is AFFORDANCE-ONLY; settle/escrow (REQ-033/143/108) is CONFIRM-gated OUT; Stripe unwired.
- The QB serializer is IIF; the in-repo penny proof is `exportJournal` balance + the month-fixture totals; the live QB-sandbox round-trip is an external CONFIRM.
- No new table (alarms→`anomalies`, snapshots→R2), no new event kind (send→`message.sent`, draft→`messages` row, signals→internal notes).
- Dunning is draft-only + human-send (REQ-032 verbatim); the sender's `shipment_id` becomes optional for party-scoped dunning.
- Watchtower snapshot PUBLISHING is CONFIRM-gated — WP-11 builds the telemetry + persistence, not the external publish.
- REQ-180 clamps the 7 code-default-internal kinds (fail-closed superset); the register names 6 — a proposed register alignment rides the PR.
- REQ-178's `from_name` is an additive optional field — existing events' canonical bytes are unchanged; `check:seed` must stay green.
- The R2 retention sweep TOMBSTONES the documents row when it deletes expired bytes (preserving row-iff-bytes), never orphaning either side.
