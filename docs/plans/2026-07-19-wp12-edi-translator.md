# WP-12 — EDI lite (Translator), the purely-additive agentic build

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task (fresh subagent per task, spec-review then quality-review between tasks). This plan is written for an engineer who knows TypeScript/Cloudflare but has zero SHUDDL context.

**Goal:** Ship an agentic EDI Translator — outbound X12 214 (shipment status) generated from committed ledger events, inbound X12 204 (load tender) turned into a gated SHUDDL booking, malformed docs quarantined with evidence, partners certified by a replay harness — as **new files only**, touching **zero** shipped code, kinds, tables, or surfaces.

**Architecture:** A **separate Cloudflare Worker** (`workers/translator/`) hosts the agent (cron sweep for 214-out + a `fetch` handler for 204-in). A **new dependency-free package** (`packages/edi/`) is the pure X12 format layer (envelope tokenizer + 204/214/990 segment structs + a per-partner mapping table). The **agent core** lives at `packages/agents/src/translator/*` and is imported via the existing `@shuddl/agents/*` export wildcard (no barrel edit). The Translator **reads** the ledger (`readEvents`), **reuses** the Concierge-port pattern to create parties/shipments, and **appends** bookings through the **existing** api-worker `ShipmentSequencer` DO (cross-script binding) so every server-side gate runs unchanged. Provenance uses the already-valid `source:"edi"` event field — **no new event kind**. Partner config + cert state ride the pre-provisioned `integrations` table; quarantine rides the `anomalies` table + R2 — **no new table**.

**Tech Stack:** TypeScript strict (no `any`), Zod `.strict()` at boundaries, Cloudflare Workers + Wrangler, D1 (STRICT SQLite), Durable Objects (cross-script), R2, Queues (optional), Vitest (`@cloudflare/vitest-pool-workers` for the worker), pnpm workspaces.

---

## ⚠️ The owner constraint this plan is built around (read first)

The owner authorized the agentic Translator **only if** it "will not interfere or risk the build in any way, and will not require adjusting/modifying any previous code." The understand sweep (7 readers, all facts verified against live code) returned a **CONDITIONAL GO**, and every condition is discharged below. Three facts make this safe rather than optimistic — **the schema was pre-provisioned for EDI**:

| Pre-provisioned seam | Evidence (verified) |
|---|---|
| `source:"edi"` already a valid event field | `packages/contracts/src/events.ts:278` (stored), `:397` (input) — appends need **no schema change** |
| `integrations` table carries `kind='edi_partner'` + `cert_status` + `replay_fixture_ref` | `db/tenant/migrations/0002_domain.sql` (verified) — the exact "partner cert flow" + "replay-certified mappings" columns |
| `anomalies` table is the quarantine sink | `db/tenant/migrations/0002_domain.sql` (verified) |
| `@shuddl/adapters` stub reserves EDI for WP-12 | `packages/adapters/src/index.ts` comment |

### The six conditions (all held by this plan)

- **C1 — Own worker.** Ship as `workers/translator/` with its own `wrangler.toml`. **Never** add the Translator to `workers/agents/src/index.ts` (that would force editing the `AgentTrigger` union + its `assertNever` exhaustiveness guard — a shipped, green file). `pnpm-workspace.yaml` globs `workers/*` and root scripts use `pnpm -r --if-present`, so the new worker is auto-included with **zero** edit to any config or registry (verified: no tool enumerates workers).
- **C2 — No ledger write for transmissions; no 36th kind.** 35 kinds are frozen (pinned by `events.test.ts:5`, `booking.test.ts:40`, `comms.test.ts:45`). Outbound 214/210/990 are **wire artifacts projected from committed events**, made idempotent by a deterministic key (the Biller email precedent, `biller.ts:502` — no `email.sent` kind exists). Inbound 204 rides the existing `quote.requested → booking.created` chain tagged `source:"edi"`.
- **C3 — Never model EDI as a `messages` row / `message.sent channel:"edi"`.** Hard NO-GO: it forces a `packages/contracts/src/comms.ts` enum edit **and** an impossible SQLite table-level `CHECK` alter (`channel IN (...)`).
- **C4 — Inbound 204 uses the Concierge-port pattern, not the HTTP intake verbs.** Do **not** edit `workers/api/src/routes/intake.ts`. Create party/shipment directly (as the Concierge does) and write `parties.addresses` so the 204 N1 address is never silently dropped (Migrator rule 10).
- **C5 — Spend zero tables.** `integrations` + `anomalies` + R2 + `integrations.config` JSON cover everything. Table budget stays 21/22 (`tools/checks/invariants.ts`: `TABLE_BUDGET=22`, `NAMED_TABLES=21`).
- **C6 — Backend-only.** Design CI is blocking post-WP-10. No Command console, no 13th view, no 4th surface. Defer any EDI console to a later register-amended WP.

### The only things this plan writes to existing tracked files — all append-only governance, none of them "previous code"

1. **Append REQ-200..REQ-204** to `genesis/09-REQUIREMENTS-REGISTER.csv` (append-only; the traceability CI *requires* a REQ row per build — this is how every WP starts).
2. **Flip `active-wps.json`** to activate WP-12 (governance state the traceability CI reads to scope orphan checks).

Neither changes any shipped logic, schema, test, or behavior. If the owner wants literally zero touches even to governance files, WP-12 cannot be traceability-legal — but that is the build's own universal rule, not an EDI risk. **No shipped source file is edited by any task below.** A final guard (Task 12) asserts `git diff` touches zero pre-WP-12 source file.

---

## Scope decisions (from the sweep, §4)

- **Certify to DoD:** 214-out + 204-in (genesis/08 WP-12 row; genesis/05:33).
- **Scaffold:** 990-out (needed to *respond* to a 204).
- **Additive stretch (same agent, optional):** 210-out (invoice → X12 210, mirrors 214-out from `invoice.issued`). Build only if Tasks 1-11 land green with budget to spare.
- **Out of the lite slice:** 997 functional ack (not among REQ-034's four); the full partner-by-partner matrix (explicitly deferred, genesis/05:34).
- **Fixtures are the spec.** A real partner's exact 204 layout lives in the tenant config pack (outside this repo; naming it violates REQ-167). Build a standards-compliant X12 **004010** 204/214/990 parser+serializer plus a **per-partner mapping override** layer, tested against **synthetic** primary-partner fixtures with synthetic ids. When a real partner spec arrives, a `integrations` mapping row is **replay-certified** against new fixtures — no code change. That is what "replay-certified mappings" (REQ-034) means.

---

## Task 0: Register scope (REQ rows + activation) — do this FIRST

> Rationale: the source-of-truth rule ("if it isn't a REQ row it doesn't get built; ADD A ROW first") + the git-hazard lesson (register rows in their own commit *beneath* the build so an amend never folds them into the wrong commit).

**Files:**
- Modify (append-only): `genesis/09-REQUIREMENTS-REGISTER.csv`
- Modify: `active-wps.json` (flip WP-12 active)

**Step 1: Append these five rows** verbatim to the end of the CSV (columns: `req_id,domain,requirement,source,spec,wp,dod_test,status`). Keep each row on ONE line; the values below are the human intent (compress to single-line CSV, escaping commas by quoting the `requirement` cell):

- **REQ-200 / AGENTS** — Translator 214-outbound: a cron sweep reads committed status events (stop.arrived/stop.departed/pod.signed/delivery.evidenced) via readEvents (kind-filtered lens), serializes an X12 214 through @shuddl/edi, sends via the transport port, idempotent on a deterministic edi214/<statusEventId> key (Biller precedent), optional wire bytes to R2 edi/<tenant>/214/; NO ledger write and NO new event kind (214 is a projection of committed events). *dod:* a known status chain produces a byte-stable 214 and a re-run sends no duplicate. *spec:* 01§2. *status:* F0-SPEC'D.
- **REQ-201 / BOOKING** — Translator 204-inbound: a partner load tender (X12 204) authenticated by pairings.secret_ref parses through @shuddl/edi, find-or-creates the party via the shared partyIdForEmail matcher (REQ-196), writes parties.addresses jsonb (N1 not dropped, Migrator rule 10), INSERT OR IGNOREs the shipments row, appends quote.requested (source:"edi") + downstream through the api SHIPMENT_SEQ DO so the SAME server-side booking gates (REQ-030/191) run with no bypass; 990 tender-response scaffolded. *dod:* a primary-partner 204 round-trips to a gated quote-stage booking; a redelivered 204 (same ISA13) yields exactly one shipment. *spec:* 01§3C. *status:* F0-SPEC'D.
- **REQ-202 / LEDGER** — malformed inbound EDI quarantines with evidence: a doc failing envelope/segment validation is NOT processed; one anomalies row (rule='edi_malformed', deterministic id per tenant+partner+ISA13, detail JSON {parse_error,r2_key,doc_type}) + raw bytes to R2 edi-quarantine/<tenant>/; idempotent on redelivery; no booking, no kind, no table. *dod:* a malformed 204 creates exactly one anomalies row + retained R2 bytes and no shipment; redelivery adds nothing. *spec:* 02§I3. *status:* F0-SPEC'D.
- **REQ-203 / AGENTS** — partner-cert flow: a partner is an integrations row (kind='edi_partner'); cert_status flips to 'certified' only after that partner's fixtures/edi replay round-trips clean; replay_fixture_ref names the fixture; outbound interchange control numbers live in integrations.config; per-partner LIVE activation is a tenant-config-pack calendar object (genesis/13), outside this repo. *dod:* an uncertified partner's outbound is withheld until its replay passes and cert_status='certified'. *spec:* 13§01. *status:* F0-SPEC'D.
- **REQ-204 / BUILD** — the Translator ships as its OWN Worker (workers/translator) + a dependency-free @shuddl/edi format package, touching ZERO shipped code: no new event kind (35-freeze intact), no new table (spare intact), reusing integrations/anomalies/R2 + the api SHIPMENT_SEQ DO cross-script; EDI is a boundary adapter only, never the pricing engine/ledger core (REQ-035 adapter law); every EDI R2 key + D1 read is tenant-scoped with an isolation.test case (REQ-025); no Command surface (design-CI-blocking); WP-12 is backend-only. *dod:* check:invariants/traceability/identity/isolation all green with the Translator added and zero diff to any pre-WP-12 source file. *spec:* 14§06. *status:* F0-SPEC'D.

(REQ-034 remains the umbrella anchor — its dod "Primary-partner-format fixtures round-trip" is satisfied by REQ-200/201/Task 10.)

**Step 2: Flip WP-12 active** in `active-wps.json` (match the shape used for WP-11).

**Step 3: Verify traceability accepts the new rows**

Run: `export PATH="/Users/spencerpro/.nvm/versions/node/v22.15.0/bin:$PATH" && pnpm check:traceability`
Expected: PASS (no orphans; the new REQ rows are registered even though code lands later — traceability is bidirectional but a registered-not-yet-built REQ is allowed for the active WP; if it flags, that confirms the row parsed).

**Step 4: Commit** (rows in their own commit, beneath the build)
```bash
git add genesis/09-REQUIREMENTS-REGISTER.csv active-wps.json
git commit -m "plan(req): register REQ-200..204 — agentic EDI Translator, purely additive (WP-12)"
```

---

## Task 1: `packages/edi` scaffold + X12 envelope tokenizer

**Files:**
- Create: `packages/edi/package.json`, `packages/edi/tsconfig.json`
- Create: `packages/edi/src/envelope.ts` (ISA/GS/ST … SE/GE/IEA tokenizer)
- Create: `packages/edi/src/types.ts` (segment/element types)
- Test: `packages/edi/test/envelope.test.ts`

**Context:** X12 is delimiter-framed: an **ISA** (interchange header, fixed-width, defines the element separator, segment terminator, and sub-element separator), **GS** (functional group), **ST**/**SE** (transaction set), **GE**/**IEA** (closers). The tokenizer must read the delimiters *from the ISA itself* (positions 4/105/106) and split into `{ segments: Array<{ tag: string, elements: string[] }>, isaControl: string, gsControl: string }`. It must **reject** (throw a typed `EdiParseError`) on: bad ISA length, missing IEA, or mismatched control numbers.

**Step 1: Write the failing test** — `packages/edi/test/envelope.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { tokenize, EdiParseError } from "../src/envelope";

const SAMPLE = // a minimal valid ISA…IEA with `*` element sep, `~` segment term, `>` sub-sep
  "ISA*00*          *00*          *ZZ*SHUDDL         *ZZ*PARTNER01      *260719*1200*U*00401*000000001*0*P*>~" +
  "GS*SM*SHUDDL*PARTNER01*20260719*1200*1*X*004010~ST*214*0001~SE*2*0001~GE*1*1~IEA*1*000000001~";

describe("REQ-204: X12 envelope tokenizer", () => {
  it("reads delimiters from the ISA and splits segments", () => {
    const t = tokenize(SAMPLE);
    expect(t.isaControl).toBe("000000001");
    expect(t.segments[0].tag).toBe("ISA");
    expect(t.segments.find(s => s.tag === "ST")?.elements[0]).toBe("214");
  });
  it("throws EdiParseError on a truncated interchange (no IEA)", () => {
    expect(() => tokenize("ISA*00*...~GS*SM*~")).toThrow(EdiParseError);
  });
});
```

**Step 2: Run — expect FAIL** (`Cannot find module '../src/envelope'`):
`export PATH="/Users/spencerpro/.nvm/versions/node/v22.15.0/bin:$PATH" && pnpm --filter @shuddl/edi test`

**Step 3: Implement** `package.json` (mirror `packages/adapters/package.json` + an exports map so the worker/agent can import subpaths):
```json
{
  "name": "@shuddl/edi",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./*": "./src/*.ts" },
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": { "@shuddl/contracts": "workspace:*", "zod": "^3.23.0" },
  "devDependencies": { "vitest": "^4.1.10", "typescript": "^5.9.0" }
}
```
Then `envelope.ts` — a pure tokenizer with `EdiParseError extends Error`. No I/O, no ledger import (adapter-only law, REQ-035).

**Step 4: Run — expect PASS.**

**Step 5: Commit** `feat(edi): X12 envelope tokenizer + @shuddl/edi package (REQ-204)`

---

## Task 2: X12 204 parse → a normalized `TenderDoc`

**Files:** Create `packages/edi/src/parse-204.ts`; Test `packages/edi/test/parse-204.test.ts`.

**Context:** A 204 (motor carrier load tender) carries: **B2** (shipment id/SCAC), **L11** (reference numbers), **G62** (dates/appointments), **N1/N3/N4** (name/street/geo per party — shipper, consignee, bill-to), **OID/LAD** (order/line detail), **AT8/PLD** (weight/pallets). Parse into a strict `TenderDoc` Zod type: `{ partnerScac, purpose ('00' original | '01' cancel), refs, stops: [{ role, name, address, apptWindow }], bill_to, weightLb, dims? }`. Missing weight/dims → leave `undefined` (the "no price on air" law is honored downstream, not invented here).

**Step 1: failing test** — feed a synthetic 204 fixture string, assert the `TenderDoc` fields (shipper N1, consignee N4 city/state, bill-to, weight). Include a case where a required envelope segment is absent → `EdiParseError`.

**Step 2: run — FAIL.** **Step 3: implement** `parse-204.ts` (consumes `tokenize`, maps segments → `TenderDoc`, Zod `.strict()` validates the result). **Step 4: run — PASS.** **Step 5: commit** `feat(edi): X12 204 load-tender parse → TenderDoc (REQ-201)`

---

## Task 3: X12 214 serialize (status projection → wire bytes)

**Files:** Create `packages/edi/src/build-214.ts`; Test `packages/edi/test/build-214.test.ts`.

**Context:** A 214 (shipment status message) carries **B10** (shipment/ref), **L11**, **N1** (parties), **AT7** (status code + reason + date/time) per status event. Input is a normalized `StatusView` (`{ shipmentRef, partnerScac, isaControl, gsControl, stops: [{ statusCode, reasonCode?, ts, city?, state? }] }`); output is deterministic X12 214 bytes with a **stable envelope** given the same control numbers (so the round-trip test is byte-exact). Map SHUDDL status → X12 AT7 status codes (e.g. arrived→`X3`, departed→`CD`/`AF`, delivered/pod→`D1`). Keep the mapping in a small table.

**Step 1: failing test** — build a 214 from a two-stop `StatusView`, assert the exact segment string (`B10*...~...AT7*X3***...~AT7*D1***...~`) and that re-running with identical input yields identical bytes.

**Step 2: FAIL.** **Step 3: implement.** **Step 4: PASS.** **Step 5: commit** `feat(edi): X12 214 status serialize, byte-stable (REQ-200)`

---

## Task 4: X12 990 serialize (tender response scaffold)

**Files:** Create `packages/edi/src/build-990.ts`; Test `packages/edi/test/build-990.test.ts`.

**Context:** A 990 answers a 204 with **B1** (shipment id + reservation action code: `A` accept / `D` decline). Input `{ shipmentRef, partnerScac, isaControl, gsControl, action: 'A'|'D' }` → deterministic bytes. Scaffold-level (accept/decline only).

**Steps:** failing test → FAIL → implement → PASS → commit `feat(edi): X12 990 tender-response scaffold (REQ-201)`

---

## Task 5: Per-partner mapping config loader

**Files:** Create `packages/edi/src/mapping.ts`; Test `packages/edi/test/mapping.test.ts`.

**Context:** A partner's format quirks (element overrides, status-code dialect, ref-number qualifiers) are **data**, not code — loaded from an `integrations.config` JSON blob (the "replay-certified mapping"). `mapping.ts` exposes `resolveMapping(config: unknown): PartnerMapping` (Zod `.strict()`, with a `DEFAULT_004010` baseline) and pure `applyMapping(tender, mapping)` / `dialectStatus(code, mapping)`. No I/O. This is the layer that lets a new partner be certified with a config row, **zero code change** (REQ-034).

**Steps:** failing test (a config override changes a status-code dialect; an unknown field is rejected by `.strict()`) → FAIL → implement → PASS → commit `feat(edi): per-partner mapping config layer — replay-certified (REQ-034/203)`

---

## Task 6: Agent core — `packages/agents/src/translator/*`

**Files:**
- Create: `packages/agents/src/translator/build-214.ts` (reads a `StatusView` from lens rows, dedup key), `packages/agents/src/translator/map-204.ts` (TenderDoc → a party/shipment/append **plan**, pure), `packages/agents/src/translator/quarantine.ts` (malformed → an anomalies-row descriptor, pure)
- Test: `packages/agents/test/translator.test.ts`

**Context:** Imported by the worker as `@shuddl/agents/translator/build-214` etc. via the **existing** `"./*": "./src/*.ts"` export wildcard — **`packages/agents/src/index.ts` is NOT edited** (verified). These are **pure** functions (no D1/R2/network); the worker (Task 7/8) supplies the ports. `build-214` computes the idempotency key `edi214/<statusEventId>` (Biller precedent). `map-204` uses the shared `partyIdForEmail` from `@shuddl/contracts` (REQ-196) and returns a plan `{ party, shipment, appends: [{kind:'quote.requested', source:'edi', ...}] }` — it does **not** itself write. `quarantine` returns `{ anomalyId (deterministic per tenant+partner+isaControl), rule:'edi_malformed', detail }`.

**Step 1: failing test** — (a) `build-214` over a fake status chain yields the expected `StatusView` + stable dedup key; (b) `map-204` on a synthetic `TenderDoc` yields a plan whose party id equals `partyIdForEmail(...)` and whose append is `source:"edi"`; (c) `quarantine` id is deterministic across two calls. **Step 2: FAIL. Step 3: implement. Step 4: PASS.**

**Step 5: commit** `feat(agents): Translator core — 214 projection, 204→booking plan, quarantine (REQ-200/201/202)`

---

## Task 7: `workers/translator` worker + 214-out cron sweep

**Files:**
- Create: `workers/translator/package.json`, `workers/translator/tsconfig.json`, `workers/translator/wrangler.toml`, `workers/translator/vitest.config.ts`
- Create: `workers/translator/src/index.ts` (`scheduled()` = the 214 sweep; `fetch()` stub for Task 8), `workers/translator/src/transport.ts` (the send/receive port + a `NotConfiguredTransport` default, Biller-`NotConfiguredSender` precedent)
- Test: `workers/translator/test/sweep.test.ts`

**Context — the wrangler MUST mirror `workers/agents/wrangler.toml`** (copy its structure): `workers_dev = false`; the **same tenant D1 bindings** (`TENANT_A_DB`/`TENANT_B_DB`, mirror `workers/api/src/tenants.ts` — physical isolation, REQ-025); `EVIDENCE` R2; the **cross-script** `SHIPMENT_SEQ` DO binding to `script_name = "shuddl-api-dev"` (so 204-in appends run the gate in the api DO — never in this worker, C2); a cron trigger for the sweep. **No queue is required** for the lite slice (214-out is cron, 204-in is inline `fetch`); a `shuddl-edi-inbound` queue is an optional additive deploy-time resource if retry decoupling is wanted later. **No secrets in the toml** (REQ-154) — transport creds via `wrangler secret put`; default `NotConfiguredTransport` means **no real EDI is transmitted** until an operator arms it (mirrors the Biller's gated live-send).

The 214 sweep: for each tenant DB, find partner-tendered shipments with fresh status events (a bounded lens read, Watchtower cadence), build a 214 via `@shuddl/agents/translator/build-214` + `@shuddl/edi/build-214`, skip if the `edi214/<statusEventId>` dedup marker exists, send via transport, record the marker + optional wire bytes to R2 `edi/<tenant>/214/<isaControl>`. **Idempotent, append-then-send, no ledger write.**

**Step 1: failing test** (`@cloudflare/vitest-pool-workers`) — seed a tenant D1 with a delivered shipment's status events + an `integrations` `edi_partner` row (cert_status='certified'), run `scheduled()`, assert a fake transport received one byte-stable 214 and a second run sends nothing (dedup). **Step 2: FAIL. Step 3: implement. Step 4: PASS.**

**Step 5: commit** `feat(translator): worker + 214-out cron sweep, idempotent, cross-script append-free (REQ-200)`

---

## Task 8: 204-in `fetch` handler (Concierge-port booking + quarantine)

**Files:** Modify `workers/translator/src/index.ts` (`fetch`); Create `workers/translator/src/inbound.ts` (auth + orchestration); Test `workers/translator/test/inbound.test.ts`.

**Context:** `POST` from a partner (or an SFTP-poll adapter) hits `fetch`. Auth is the partner **`pairings.secret_ref`** shared secret (control-plane `pairings`, kind `edi`) — an HMAC over the raw body, **not** a JWT. On valid auth: `tokenize` + `parse-204`; on parse failure → `quarantine` (anomalies row + raw bytes to R2 `edi-quarantine/<tenant>/<partner>/<isaControl>`, idempotent) and return `200` (ack receipt, never retry-storm the partner). On success → run `map-204`, create/find the party + `parties.addresses` write + `INSERT OR IGNORE` shipment **directly** (Concierge-port pattern — do **not** call `/v1/parties`), then append the plan's `quote.requested (source:"edi")` + booking chain **through the cross-script `SHIPMENT_SEQ` DO** so `#enforceBooking` + credit/evidence gates run unchanged (a broker bill-to with no email → `held`, correct). Emit a 990 accept via transport. Idempotent on `ISA13` (redelivered tender → one shipment).

**Step 1: failing tests** — (a) a valid synthetic 204 → exactly one shipment + a `quote.requested` with `source:"edi"` appended via the DO, gates run; (b) a **redelivered** 204 (same ISA13) → still one shipment; (c) a **malformed** 204 → one `anomalies` row + R2 bytes + `200`, **no** shipment; (d) a bad-secret POST → `401`, nothing written. **Step 2: FAIL. Step 3: implement. Step 4: PASS.**

**Step 5: commit** `feat(translator): 204-in → gated booking via Concierge-port + DO; malformed→quarantine (REQ-201/202)`

---

## Task 9: Partner-cert flow + control-number state

**Files:** Create `workers/translator/src/partners.ts` (read `integrations` edi_partner rows; withhold outbound unless `cert_status='certified'`; allocate/persist outbound `isaControl`/`gsControl` counters in `integrations.config`); Test `workers/translator/test/partners.test.ts`.

**Context:** The sweep (Task 7) must **skip** a partner whose `cert_status` is not `certified`. Control numbers increment per interchange and persist in `integrations.config` JSON (no new table). Per-partner LIVE go-live is a tenant-config-pack calendar object (genesis/13), outside this repo.

**Step 1: failing test** — an uncertified partner's shipment produces no outbound; a certified partner increments ISA control monotonically across two sweeps. **Step 2: FAIL. Step 3: implement. Step 4: PASS.**

**Step 5: commit** `feat(translator): partner cert-gate + interchange control-number state (REQ-203)`

---

## Task 10: Fixtures + replay harness (the DoD gate)

**Files:**
- Create: `fixtures/edi/primary-204.edi` (synthetic, REQ-167-clean), `fixtures/edi/expected-booking.json`, `fixtures/edi/status-chain.json` + `fixtures/edi/expected-214.edi`, `fixtures/edi/malformed-204.edi`
- Create: `tools/fixtures/gen-edi-roundtrip.ts` (generator, mirror `tools/fixtures/gen-gl-netting.ts`)
- Test: `packages/edi/test/roundtrip.fixture.test.ts` (or a worker test for the booking projection)

**Context — this is REQ-034's DoD** ("Primary-partner-format fixtures round-trip clean; malformed docs quarantine with evidence"): (1) parse `primary-204.edi` → assert it maps to `expected-booking.json`; (2) build a 214 from `status-chain.json` → assert byte-equality to `expected-214.edi`; (3) feed `malformed-204.edi` → assert quarantine (anomaly + evidence), no booking. Generate fixtures **in-test** to avoid touching `fixtures/manifest.json` (airplane-soak/derive-split precedent); if a vendored hash-pin is later wanted, an **append** to the manifest is the (append-only, allowed) alternative.

**Step 1: write the three assertions as failing tests.** **Step 2: FAIL. Step 3: author the fixtures + generator until green. Step 4: PASS.** **Step 5: commit** `test(edi): primary-partner round-trip + malformed-quarantine DoD fixtures (REQ-034)`

---

## Task 11: Tenant-isolation proof for EDI paths

**Files:** Create `workers/translator/test/isolation.test.ts` (follow the `prove-tenant-isolation-read-paths` skill).

**Context (REQ-025):** every EDI R2 key embeds `<tenant>/` and every D1 read/write is bound-scoped. Prove a tenant-A partner secret + 204 can **never** create a shipment, anomaly, or R2 object in tenant B, and the 214 sweep for tenant A reads only tenant-A events.

**Step 1: failing test** (cross-tenant attempt asserts zero write in the other tenant). **Step 2: FAIL (or PASS if already isolated — then it's a regression lock). Step 3: ensure scoping. Step 4: PASS.**

**Step 5: commit** `test(translator): tenant-isolation lock on EDI read/write paths (REQ-025)`

---

## Task 12: Full verify + exit audit + close-out + merge

**Step 1: zero-touch guard** — prove no shipped source file changed:
```bash
export PATH="/Users/spencerpro/.nvm/versions/node/v22.15.0/bin:$PATH"
git diff --stat main...wp-12-edi -- ':!docs' ':!fixtures/edi' ':!packages/edi' ':!packages/agents/src/translator' ':!workers/translator' ':!genesis/09-REQUIREMENTS-REGISTER.csv' ':!active-wps.json'
```
Expected: **empty** (only new dirs + the two governance appends changed). If anything else appears, a condition C1–C6 was violated — stop and fix.

**Step 2: full verify** (the whole gate set, per the dep-env memory):
`pnpm verify`
Expected: green. Budgets: `check:invariants` shows tables still **21/22**, kinds still **35**. If eslint crashes → `rm -rf node_modules && pnpm install --frozen-lockfile`. If `airplane-soak` flakes under load → it carries a 30s ceiling already.

**Step 3: REQ-119 adversarial exit-audit swarm** (a Workflow) over the WP-12 diff — attack lenses: (a) can a 204 bypass a booking gate / force a duplicate (REQ-191)?; (b) does any outbound leak an internal field (redaction, REQ-192) or a real partner id (REQ-167)?; (c) cross-tenant reach on any R2 key or D1 read (REQ-025)?; (d) a malformed/hostile EDI doc (billion-laughs, huge segment, bad delimiters) that hangs or crashes the worker rather than quarantining?; (e) is any ledger write / new kind / new table sneaking in (C2/C5)?; (f) idempotency holes (redelivery, replayed ISA13, sweep re-send). Independent refutation (default-refute), verify each survivor against real code, fix Criticals with proving tests (RED-without-fix).

**Step 4: close-out doc** `docs/wp/WP-12.md` (mirror WP-11.md): what shipped, the additive proof, the deferred items (210-out stretch, per-partner LIVE calendar in the config pack, the optional inbound queue, any CF edge rate-limit note for a public 204 endpoint).

**Step 5: finish** — per the standing directive, the pre-authorized finish is **merge to main locally**: verify green on the merge result, then `git checkout main && git merge wp-12-edi && git branch -d wp-12-edi`.

---

## Risk register (each with its additive discharge)

| Trap (sweep §5) | Discharge in this plan |
|---|---|
| In-worker trigger wiring edits the agents worker | **Separate `workers/translator`** (C1, Task 7) — zero edit; verified no worker registry exists |
| `message.sent channel:"edi"` (enum + CHECK alter) | **Never modeled as messages** (C3) — outbound is wire-only, no ledger row |
| 36th event kind | **`source:"edi"` on existing kinds** (C2) — 35-freeze tests stay green (Task 12 asserts) |
| Editing `intake.ts` for the 204 address | **Concierge-port pattern** + `parties.addresses` write (C4, Task 8) |
| New EDI table / `documents.kind` alter | **`integrations`+`anomalies`+R2** (C5) — spare stays 21/22 |
| Command EDI console | **Backend-only** (C6) — no pixel surface, design-CI untouched |
| `fixtures/manifest.json` touch | **Generate fixtures in-test** (Task 10) — append is the fallback, itself append-only |
| Composition-root / worker registration | **`workers/*` glob + `pnpm -r`** auto-include — verified zero registration edit |
| Tenant isolation on new R2/D1 paths | **`<tenant>/`-scoped keys + `isolation.test`** (REQ-025, Task 11) |
| Adapter-only law | `@shuddl/edi` imports **no** ledger/rater core (REQ-035) — pure boundary translator |
| Identity leak | Fixtures use **synthetic** partner ids only (REQ-167); real specs live in the config pack |
| Hostile inbound doc DoS | Quarantine path (Task 8/10) + exit-audit lens (d) — bounded parse, never hangs |

**Bottom line:** the agentic Translator is buildable end-to-end as new files only, and the schema was pre-built for it. Every owner condition is a discharged line item above. Task 12's `git diff --stat` guard is the mechanical proof that no previous code was adjusted.
