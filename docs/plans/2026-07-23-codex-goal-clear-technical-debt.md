# CODEX GOAL — Clear all technical debt; harden and elevate the codebase

> **Record note (added 2026-08-01, on commit):** the Goal contract as issued 2026-07-23, committed as a dated record — substantially executed by the 2026-07-28 V1 close-out and the sessions after it. Where its REQ references disagree with `genesis/09-REQUIREMENTS-REGISTER.csv` (appended since), the register is authoritative. Citations FROZEN as-of writing; enrolled in the citation ratchet as a dated record.

> Paste **§0** into Codex's *Goal* setting. §1–§6 are the binding contract it references. This is a **rigid**
> goal: every criterion is binary, every fence non-negotiable, and the agent may never weaken a gate to pass it.
> Scope source-of-truth stays `genesis/09` → `10` → `07` → `14` → `08`; governing law is `CLAUDE.md` + `genesis/00`.
>
> **The debt inventory (§4) is verified against live code** by a 12-agent audit sweep (79 candidates → 88 items,
> 20 blocks-prod adversarially confirmed, 3 register-drift items proven already-resolved). File:line and every
> `clearedWhen` grep are from that sweep — but Codex still re-verifies each item before touching it (§3 step 1).

---

## §0 — The Goal statement (paste this into Codex)

**Drive the SHUDDL OS codebase to a state where every item in the technical-debt inventory (§4) is either
CLEARED to its binary criterion or provably HELD fail-closed, while simultaneously raising the engineering
bar (§4 Bucket B) — without ever regressing a budget, an invariant, a passing test, or a line of the
governing law (§2).**

You are done — and only done — when **every checkbox in §1 is true, verified by running the command, not by
assertion.** You work one debt item per branch/PR, test-first, each PR naming its REQ-IDs, leaving the build
green. You never build a Bucket-C item — you verify it is still fail-closed and document it. You never delete,
skip, `.only`/`.skip`, or weaken a test; never loosen a threshold; never downgrade a blocking gate to advisory;
never narrow a lint to make the bar pass — if a gate is red you fix the code, not the gate. Before touching any
item you re-verify it still exists in live code (the inventory may have drifted); if already resolved, record it
and move on. When a work package's items are all green you run the adversarial audit swarm (§3, REQ-119) and do
not close it with any open Critical.

---

## §1 — Definition of Done (binary; each line checkable by command)

Achieved when **all** are simultaneously true:

- [ ] **Every Bucket-A item (§4-A)** meets its `clearedWhen`, verified by the cited grep/command.
- [ ] **Every Bucket-B elevate target (§4-B)** meets its binary target.
- [ ] **Every Bucket-C item (§4-C)** is confirmed *still fail-closed* (cited check passes) and documented; **none is built.**
- [ ] The **one genuine fail-open** is closed: `check:identity` errors (not warns) when `IDENTITY_DENYLIST` is absent, on all runners (§4-A1). No other gate fails open.
- [ ] `pnpm typecheck` — zero errors; tree has **zero** `: any` / `as any` / `@ts-ignore` / `@ts-nocheck` / `@ts-expect-error` outside a test asserting a type error (grep-clean).
- [ ] `pnpm lint` — zero warnings; **no** `eslint-disable` added by this effort; REQ-024 + REQ-163 import-bans intact.
- [ ] The full **green bar (§5)** passes — all 14 blocking gates green; the 4 absent parity/purity gates are wired into `ci.yml` (§4-A6).
- [ ] **No new event kind** (`contracts/src/events.ts` still `=== 35`), **no new table** (≤22, spare intact), 5 tokens / 2 fonts / 0 shadows-gradients-radius>4px — unless a preceding owner-signed `genesis/09` amendment row exists.
- [ ] **Append-only intact:** `check:invariants` green; no `UPDATE`/`DELETE`/`INSERT OR REPLACE` path on `events` or any guarded table anywhere (incl. migrations); the insert-guard covers all four conflict surfaces (§4-B).
- [ ] **REQ-024 intact:** no LLM/external import reachable from `packages/ledger` or `packages/rater` — now enforced by a static check + test incl. dynamic `import()` (§4-B).
- [ ] **Traceability green both directions** (`check:pr` + `check:traceability` + `check:coverage`); **REQ-273 and REQ-270 are registered rows** (they are currently unregistered — append first).
- [ ] **Register tags current** — no row reads `vNEXT`/`*-DISCOVERED`/`F0-SPEC'D` for shipped code (note: `check:coverage` *reports* this drift but does **not** fail on it — fix by hand).
- [ ] **Tenant-isolation suite green** (3 files); every new read path has an `isolation.test.ts` case; R2 key-builders have the tenant-prefix assertion (§4-B).
- [ ] **Fixtures:** `check:fixtures` green **and** the un-vendored parity harnesses either run green (data vendored) or loud-skip with the gap documented — never false-green (⚠ `check:fixtures` green ≠ fixtures proven).
- [ ] **`find . -not -path './node_modules/*' -not -path './.git/*' -name '* [0-9].*'` returns zero files** (iCloud dupes gone).
- [ ] **Docs current:** `PROJECT-STATE.md` re-baselined through WP-16; `GO-LIVE-CHECKLIST.md` re-synthesized WP-13→16; design-CI job no longer named `design-advisory`.
- [ ] **Audit swarm (REQ-119)** run at each touched WP close with **zero open Criticals**.

---

## §2 — Operating constraints (the fences — violating any one fails the Goal)

Absolute; they override any local optimization, any "it's simpler," any "the test was in the way."

1. **Events are append-only, forever.** No UPDATE/DELETE/REPLACE on `events` or any guarded table, including migrations. Corrections are new events (I3/I7). Keep BEFORE-INSERT guards (D1 `recursive_triggers=0`) and the DO mutex across every D1 await.
2. **Gates are server-side (Gatekeeper); UIs only reflect them.** Any API-reachable flow enforces the same gate (REQ-030). Never move a gate client-side to "simplify."
3. **No LLM/external in `packages/ledger` or `packages/rater` (REQ-024).** Every port lives in `packages/agents`. The rater is a pure function of frozen, co-signed inputs; any external number in a sold price is snapshotted, never live-called.
4. **No price on air** (missing weight/dims → UNKNOWN, no sell). **Interline floors compare the executing share, never gross** ($222,084/35-lb regression is permanent, REQ-040).
5. **Budgets are hard:** ≤22 tables, 35 event kinds frozen, 12 canonical views, 5 tokens, 2 fonts, 0 shadows/gradients/radius>4px, 3 surfaces. Exceeding = the change is wrong unless an owner-signed register amendment precedes it.
6. **Canonical-hash byte law is frozen** — JSON byte ordering + the NULL→undefined rule in `rowToEvent`; stored events stay verifiable.
7. **Every PR references REQ-IDs.** New scope means **appending a `genesis/09` row first** (append-only), then building. No orphan code, no orphan REQ.
8. **Never merge prior-codebase code** (2023/pre-genesis — REQ-163; lint bans `*lumina*`/`*shuddl-2023*` imports). Reference only.
9. **No tenant/person/customer/vendor name** in any artifact (REQ-167).
10. **CONFIRM-gated code stays dark** while its CONFIRM is open (§4-C3). Never flip it live; never self-author legal text.
11. **Do not relitigate the stack** (CF Workers + D1/KV/R2/DO/Queues, MapLibre + self-hosted Protomaps, React 19 + Vite, TS strict + Zod, Stripe).
12. **TDD is mandatory** (§3). No impl before a failing test. No test weakened/skipped/deleted/`.only`'d to go green.
13. **Never fake green.** No stubbed gate, hardcoded expectation, silenced warning, lowered threshold, or advisory-downgrade. A red bar is fixed at the code.

---

## §3 — Working protocol (how every item is cleared)

1. **Re-verify it exists** in live code at the cited location. If already resolved → add to the "resolved (drift)" note and skip. If it needs a human secret/partner/infra (§4-C1) → do the *code/doc* half, never fake the secret.
2. **Branch** `debt/<slug>` off `main`; one item (or one tightly-coupled cluster) per branch.
3. **Failing test first** — the behavior that proves the debt gone; verify RED for the right reason.
4. **Minimal implementation** to green. Zod at every new boundary. No `any`.
5. **Run the local green bar (§5)** for the touched packages, then the full suite before PR.
6. **PR** naming REQ-IDs, stating any assumption (ambiguity → state it and proceed, per CLAUDE.md), showing the `clearedWhen` satisfied.
7. **At WP close:** run the REQ-119 adversarial audit swarm; zero open Criticals; advance the register tag (REQ-120).

**Do first — two unregistered rows block traceability:** append **REQ-273** (iCloud dedupe) and **REQ-270** (synthetic legacy-mirror feed) to `genesis/09` before their work, or the orphan detector fails.
**Sequencing:** gate/fail-safe correctness (A1) → agent/projection correctness (A2) → geo/driver features (A3) → board (A4) → EDI code (A5) → CI wiring (A6) → hygiene/docs (A7–A9); then Bucket B. Within a group, `blocks-prod` before `degrades` before `cosmetic`.

---

## §4 — The debt inventory (verified against live code)

> Every `clearedWhen` is grep/command-checkable. Re-verify before acting.

### BUCKET A — CLEAR (build / wire / dedupe / refactor / doc)

**A1 · Gate & fail-safe correctness (highest priority)**
- **Close the identity-leak fail-open** — `tools/checks/identity-leak.ts:47,58,102`, `…/identity-leak.test.ts:50` — cleared when `resolveIdentityLeakOutcome` returns `level:'fail'` (code 1) for `terms===null` on **all** invocations (warn-and-skip removed or behind an explicit opt-in) and the local-warn test is updated. (REQ-167/211)
- **Wire the REQ-170 missing-evidence send-gate** — `packages/ledger/src/gates/transition-gates.ts:187`, `workers/agents/src/biller.ts:479` — cleared when `sendEvidence` resolves each recorded `photo_hash` to a documents/R2 object and HOLDS/flags the send as MISSING when no bytes exist; UNIMPLEMENTED note removed; a test covers a fabricated-hash/no-upload POD. (REQ-170/168)
- **Fail-closed on unresolved `corrects_event_id` visibility** — `packages/ledger/src/visibility.ts:95`, `workers/api/src/do/sequencer.ts:361,996`, `…/visibility.test.ts:64` — cleared when visibility uses an explicit `correctedEventVisibility === undefined` fail-closed check (never the counterparty default), the sequencer rejects an `invoice.corrected` whose `corrects_event_id` resolves to zero rows, and the test no longer blesses `undefined → counterparty`. (REQ-015/180)
- **Wire the REQ-030 serviceClass POD-gate exemption** — `workers/api/src/do/sequencer.ts:325` — cleared when the `invoice.issued` path calls `assertPodSigned` with `serviceClass` threaded from `shipments.service`, a test exercises `invoice_without_pod_classes`, and the `TODO(REQ-030)` is removed. Do not regress to fail-open. (REQ-030)
- **Write a `ratecon` documents row on booking/dispatch** — `transition-gates.ts:548`, `workers/api/src/routes/evidence.ts:214`, `packages/ledger/src/anchor.ts:200` — cleared when a production path inserts a `documents` row of `kind='ratecon'` so the REQ-043 dispatch gate passes without a manual override. (REQ-184/043)

**A2 · Agent / projection correctness**
- **Resolve accepted quote by acceptance chain, not latest-quote heuristic** — `workers/agents/src/biller.ts:173,350` — cleared when `loadAcceptedQuote` walks `quote.accepted.quote_event_id → quote.priced` (not `ORDER BY seq DESC LIMIT 1`) and the stale "no booking/acceptance flow exists yet" comments are corrected. (REQ-056/028)
- **Accrue partner-passport OTD score** — `packages/ledger/src/projection/passports.ts:30` — cleared when OTD is derived from `pod.signed` ts vs the appointment window and accrued (or documented as KPI-sourced); the "DEFERRED TO WP-08" note removed. (REQ-028)

**A3 · Driver PWA & geo/map (v2-mapped; build)**
- **30s `position.updated` GPS emitter** — `apps/driver/src/flow/captures.ts:11,17` — cleared when a ~30s emitter produces `position.updated` from real device GPS while a stop is active and gate stamps read a live GeoStamp, not `MOCK_GEO`. (REQ-071/070; v2 REQ-251)
- **Mount `@shuddl/map` in the Driver PWA** — `apps/driver/package.json`, `…/captures.ts` — cleared when `apps/driver` renders a `MapCanvas` showing the driver's own live position. (REQ-071/073; v2 REQ-244)
- **Driver login + lockout** — `apps/driver/src/session.ts:68` — cleared when magic-link/PIN + failed-attempt lockout bind to the device key and the REQ-069 DEFERRED mark is gone. (REQ-069)
- **Multi-stop driver flow** — `apps/driver/src/flow/stop-flow.ts:175` — cleared when `buildFlow` models round-trip/stop-off; single-stop note removed. (REQ-053)
- **Point-in-polygon jurisdiction** — `packages/ledger/src/geo/jurisdiction.ts:9,36,53`, `transition-gates.ts:329` — cleared when `deriveOperatingState` resolves via admin-boundary point-in-polygon (not ≤5 boxes) covering all covered USPS jurisdictions, keeping the `XX` fail-closed sentinel; STUB removed. (REQ-166; v2 REQ-220)
- **Facility geocoding pipeline** — `db/tenant/migrations/0002_domain.sql:78` — cleared when a real address→`lat_e6/lon_e6` geocode call site (via a `packages/agents` port) populates `facilities`; cache hit never re-hits the port; unresolvable → coarse ZIP centroid, never a guess. (REQ-052/028; v2 REQ-216)
- **Detention/dwell money engine** — `packages/ledger/src/geo/fence.ts:93,96` — cleared when a detention module emits `money_lines` with disclosed ± bounds from geofence dwell (or a register-amended not-to-build decision); DEFERRED note removed. (REQ-018)

**A4 · Command board (live map — acceptance demo #5)**
- **Board realtime fan-out** — `workers/api/src/routes/board.ts:58`, `apps/command/src/App.tsx:54` — cleared when the board receives pushed updates (DO fan-out / SSE / websocket) so post-load ledger changes appear without a manual reload. (REQ-073/080; v2 REQ-255)
- **At-risk tier projection** — `workers/api/src/routes/board.ts:36,37` — cleared when a risk projection emits `status:'at-risk'` from ledger-derived risk so `toMapStatus` returns all three tiers on real data. (REQ-073/080)

**A5 · EDI (pure code — no human secret)**
- **B2A 04/05 revision convergence** — `packages/edi/src/parse-204.ts:117`, `…/types.ts:82`, `workers/translator/src/core/map-204.ts:70`, `…/inbound.ts:279` — cleared when `parse-204` extracts purpose codes 04/05 (enum widened beyond `['00','01']`) and inbound converges a PO-only re-tender onto its prior shipment instead of minting a duplicate. (REQ-205/196/191)
- **Partner-qualify 214/990 idempotency key** — `workers/translator/src/sweep-214.ts:182`, `…/inbound.ts:551` — cleared when the key passed to `send214`/`send990` contains `partnerId` (or the live adapter's dedup is documented to key by `(partnerId, idempotencyKey)`). (REQ-200/025)

**A6 · CI wiring**
- **Wire the 4 parity/purity DoD gates into `ci.yml`** — `.github/workflows/ci.yml:20-47`, `package.json:19,26-28,34` — cleared when `grep -E "rater-parity|invoice-parity|concierge-parity|rater-purity" .github/workflows/ci.yml` returns all four. (REQ-027/031/026/165/024)
- **Rename the stale `design-advisory` CI job** — `.github/workflows/ci.yml:48,56` — cleared when the job id/step no longer say "advisory" (the audit is already blocking via `design-ci.json`). (REQ-158)

**A7 · Dedupe / repo hygiene**
- **Delete iCloud `* N.*` duplicates** — `packages/map/src/bearing 2.ts`, `packages/ledger/src/tsa/cms 2.ts`, `tools/traceability/coverage 2.ts`, et al. — cleared when `find . -not -path './node_modules/*' -not -path './.git/*' -name '* [0-9].*'` returns zero. (durable relocation is human — C1). (REQ-273)
- **Register REQ-273 (unregistered scope)** — `genesis/09-REQUIREMENTS-REGISTER.csv` — cleared when `grep REQ-273 genesis/09-REQUIREMENTS-REGISTER.csv` returns a row (append-only). (REQ-273)

**A8 · Stale docs & register hygiene (doc-only)**
- **WP-05 box-count drift** — `docs/wp/WP-05.md:54` — state the actual box count (5), not "~45". (REQ-166)
- **PROJECT-STATE.md stale** — `docs/ops/PROJECT-STATE.md:3,15-20` — Done table lists through WP-16 with an "As of" date ≥ WP-16, or reduced to a pointer.
- **GO-LIVE-CHECKLIST currency** — `docs/ops/GO-LIVE-CHECKLIST.md:3` — "Last synthesized" ≥ WP-16 with a recorded WP-13→16 re-synthesis. (REQ-120)
- **Register status tags lag** — `genesis/09` (REQ-045/169/176/178/179/180/183/190/191/010) — each status reads a shipped/closed tag. *(check:coverage reports but does not fail on this.)* (REQ-120)
- **airplane-soak manifest count drift** — `fixtures/manifest.json:15`, `workers/api/test/airplane-soak.test.ts:216-274` — manifest event count matches the test total (55, not 50). (REQ-016)
- **EDI 210-out / inbound-queue / Command EDI console** — `workers/translator/src/index.ts:64` — amend a REQ row in for each, then build+fixture-prove. **Do not build before the amendment** (Command EDI console is design-CI-blocking). (REQ-200)

**A9 · Runbooks / recovery decisions (doc-only)**
- **Migration reversibility decision + rollback runbook** — `db/tenant/migrations/0006_booking.sql`, `db/control/migrations/0001_control.sql`, `db/migrations.lock.json` — a written decision records forward-only-by-design AND a concrete rollback runbook for the non-event (control + domain) migrations. (`events` stays forward-only.)
- **DLQ drain / poison-message runbook** — `docs/ops/GO-LIVE-CHECKLIST.md:116` — a written DLQ drain/replay runbook naming the on-call watcher and replay procedure (on-call name is human). (REQ-114)

### BUCKET B — ELEVATE (hardening; each with a binary target)

- **Bound the full-stream replay hot path** — `workers/api/src/do/sequencer.ts:614`, `…/gate-context.ts:58` — target: gate-context load is a windowed/indexed query (or maintained per-stream projection), not `SELECT * … ORDER BY seq` with no LIMIT, on **both** sequencer and positions paths (removes the O(n²)-under-mutex scan). (REQ-030/166/071)
- **Complete the events insert-guard** — `db/tenant/migrations/0003_insert_guards.sql:9`, `0001_ledger_core.sql:20,33`, `…/schema-core.test.ts:112,122` — target: a forward-only migration recreates the guard with a WHEN OR-ing `(stream_id,seq)`, `id`, `hash`, and `(stream_id,device_id,device_seq)`, AND a test asserts an `INSERT OR REPLACE` colliding on the device index `RAISE(ABORT)`s. (REQ-119)
- **Ledger no-LLM ban → static check + test (match the rater)** — `eslint.config.mjs:27`, mirror `tools/checks/rater-purity.ts` — target: a static check scans `packages/ledger/src` for LLM/agent specifiers **incl. dynamic `import()`**, runs under `pnpm test`, with a test asserting a planted forbidden import is flagged. (REQ-024)
- **Enable Workers observability** — `workers/{api,agents,mcp,translator,billing}/wrangler.toml` — target: every deployed worker declares `[observability]` (or a tail-consumer/Logpush), grep-verifiable. (REQ-114)
- **Structured request-correlation logging + exception sink** — `workers/agents/src/index.ts`, `sequencer.ts`, `biller.ts` — target: a structured logger emits request-id + tenant + stream on Worker/DO/queue paths AND a bound exception-aggregation sink, verified in code + wrangler.
- **R2 key-builder tenant-prefix assertion** — `workers/api/src/routes/evidence.ts:81`, `packages/ledger/src/anchor.ts:58,61` — target: a unit test asserts `evidenceKey`/`anchorManifestKey`/`anchorReceiptKey` embed the tenant slug and `builder('tenant-a',…) !== builder('tenant-b',…)`. (REQ-025/119)
- **Accessibility gate + audit** — `tools/design/audit.ts`, `eslint.config.mjs`, `apps/driver/src/components/CameraScreen.tsx` — target: `eslint-plugin-jsx-a11y` (or equivalent) wired into lint/CI AND a keyboard+ARIA+focus audit passes on Command, Driver, Portal. (REQ-158)
- **Blessed screenshots + measured map frame budget** — `tests/visual/blessed/`, `tests/visual/screens.spec.ts`, `packages/map/perf/perf.spec.ts` — target: baseline PNGs exist AND a browser-capable CI job runs `pnpm test:visual` + `pnpm perf:map` to completion (non-skip). (REQ-158/079)
- **MCP live-booking cross-worker smoke** — `workers/mcp/test/quote-book.test.ts:11-19` — target: a cross-worker staging smoke exercising MCP→api-DO booking runs green in CI or a documented staging gate. (REQ-101)
- **Airplane-soak load-independence** — `workers/api/test/airplane-soak.test.ts:398-402` — target: passes green across consecutive CI runs without further timeout tuning, or converted to a load-independent assertion. (REQ-016)

### BUCKET C — HOLD (do NOT build; VERIFY fail-closed + DOCUMENT)

**C1 · Live-adapter / provisioning seams — blocked on a human secret, partner, or infra.** Do not stand up live adapters; verify the NotConfigured/fail-closed posture holds and document it.
- **Self-hosted map tiles + glyphs** — `packages/map/src/style.ts:10`, `demo.ts:119,123`, `apps/command/src/App.tsx:209`, `apps/portal/src/App.tsx:80`, `status.tsx:78` — check: demo/openfreemap hosts remain the only tile source; no third-party host silently promoted. (REQ-075)
- **NotConfigured composition roots — no live branch** (EDI AS2/SFTP/VAN, inbound HMAC, legacy feed, MCP OAuth/webhooks) — check: each factory still returns `NotConfigured*` and rejects loudly (`workers/translator/src/index.ts:27,36`; `inbound.ts:58`; `transport.ts:50`; `workers/mcp/src/webhooks.ts:222,256,360`; `workers/agents/src/index.ts:174`, `mirror-sweep.ts:54`). (REQ-034/154/200/201/109/152)
- **NotConfigured roots WITH a live branch — DARK until secret bound** (Resend/Claude/Stripe/PlatformLedger) — check: each throws NotConfigured with no secret (`sender.ts:183`, `parse.ts:242`, `billing.ts:63`, `platform-ledger.ts:40`, `workers/agents/src/index.ts:208`); `billing.test.ts:19`/`test-send.test.ts:137` still assert DARK. (REQ-092/157/024/123/154)
- **EDI per-partner LIVE activation + real-format fixtures** — check: `certifyPartner` (`partners.ts:85`) referenced only from tests; committed fixtures stay synthetic (SCAC `SYNC`, `.example`). (REQ-203/204/034/167)
- **990 ack deferred with transport** — check: `send990` still throws NotConfigured, caught at `inbound.ts:557` so the 204 still records. (REQ-201)
- **CORS `.example` placeholders** — check: `workers/api/src/middleware/cors.ts:16` still returns `null` (no ACAO/wildcard) for unlisted origins. *(Codex MAY replace placeholders with real env-driven origins + a rejection test if the prod origins are known; otherwise HOLD.)* (REQ-025/189/167)
- **CF edge rate-limit / Turnstile on `/pub/*`** — check: `public.ts:12`/`signup.ts` remain limiter-free by design; the edge rule lives in the CF account. (REQ-193/125)
- **Sender-domain warmup + apex/subdomain divergence** — check: `docs/ops/{DEPLOYMENT.md:48,secrets.md:24,GO-LIVE-CHECKLIST.md:45}` still flag the GAP. (REQ-157/092/159)
- **Real TSA (RFC-3161) endpoint** — check: `packages/ledger/src/tsa/cms.ts:16` still returns `verified:false 'chain-not-configured'` with no trust anchors (never a fake pass). (REQ-014)
- **Prod secret enumeration + binding** — check: `docs/ops/secrets.md` lacks prod rows for STATUS/DOC/Stripe/Twilio; `billing.ts:174` DARK, `sender.ts:268` throws for sms. *(Codex MAY enumerate missing `secrets.md` rows as docs; MUST NOT set secrets.)* (REQ-154/134/123/097)
- **Prod CF resources + GitHub-CF OIDC** — check: `GO-LIVE-CHECKLIST.md:33`/`DEPLOYMENT.md:33` show staging-only; `nightly.yml` is a stub. (REQ-117)
- **PROVISIONING_ENABLED / PLATFORM_INTERNAL_SECRET off** — check: `provision.ts:75` defaults `false` so `signup.ts` 404s; `platform-ledger.ts:76` 503s. (REQ-121/123)
- **Tenant-0 seed + engagement fixtures un-vendored** — check: the 9 `fixtures/manifest.json:4-12` rows stay `status:'pending' sha256:null`; `parity.ts:335` prints PENDING exit 0 (never false-green). (REQ-112/027/165/031/026)
- **M-AUTHORITY tenant-0 flip calendar** — check: `authority.ts:62` `cleanCloseCount` returns 0 (<2) so the money-module flip stays blocked. (REQ-153/023/008)
- **WP-15 overlay machinery inert** — check: `feedReaderFor` still returns `NotConfiguredFeedReader` (`workers/agents/src/index.ts:169-177`); authority ships unflipped. A synthetic feed requires appending **REQ-270** first — do not build without the row. (REQ-152/153/023/008/035/270)
- **Nightly snapshots / DR drill / SLO monitors** — check: `docs/ops/{dr-backups.md,slo.md,GO-LIVE-CHECKLIST.md:110-113}` show stub/empty/not-stood-up. (REQ-117/135/114)
- **IDENTITY_DENYLIST GitHub secret unarmed** — check: with `REQUIRE_DENYLIST=1` an unbound secret fails **closed**; cleared only when the secret is present and `check:identity` scans green. (REQ-167)
- **Durable iCloud relocation** — check: after A7 deletes the `* N.*` files, they stop regenerating only once the repo is off `~/Desktop` iCloud (human). (REQ-273)

**C2 · Parked postures — verify the safe default holds; document; do not build.**
- **shipper==requester / executor=bill_to placeholder** — `status-cache.ts:20-24` — check: `shipper_party_id` stays out of the booking SET; `executor_party_id` is the documented provisional. (REQ-181)
- **Exception RESOLVED heuristic** — `exceptions.ts:26` — check: no `exception.resolved` kind in the frozen 35; resolution stays inferred from terminal state. (REQ-119)
- **Approval flat-role equality** — `approvals.ts:26` — check: `roleSatisfies` enforces equality + admin server-side; no hierarchy fabricated. (REQ-049/030)
- **`custody.transferred.cosig` reserved-unused** — `events.ts:130` — check: field stays optional, no producer populates it; the 3 auth gates remain enforced. (REQ-018)
- **Optional Mapbox tile path (REQ-075 tension)** — `style.ts:55,98`, `App.tsx:42` — check: shipped default stays self-hosted/keyless; Mapbox path opt-in only under `VITE_MAPBOX_TOKEN`. (REQ-075)

**C3 · CONFIRM-GATED / structural do-not-build (never build absent an owner-signed amendment).**
- **Legal/counsel deliverables** (ToS/Privacy/DPA, retention+consignee notice, eBOL/e-sig, trademark) — `genesis/09:139` — check: REQ-138/140/141/142 still CONFIRM-GATED; no self-authored legal text.
- **Direct default merchant + credit-line guest** — check: no `direct-merchant`/`merchant-of-record` code; REQ-104/103 CONFIRM-GATED (blocked on REQ-139).
- **Settler escrowed instant settle** — check: no escrow/instant-settle code; REQ-033 CONFIRM-2 (blocked on REQ-143).
- **Voice numbers + consent-aware recording** — check: `call.transcribed` stays redaction-only; no number-provisioning/recording code; REQ-096 CONFIRM-2 (blocked on REQ-137).
- **PLG pricing re-base** — check: tier numbers stay `[HYPOTHESIS]`; REQ-130 CONFIRM-GATED.
- **Structural do-not-build** (native GL/period-close, report builder/13th view, driver-pay v1, 4th surface, seat pricing, SMC3-as-engine) — check: journal export is the only GL surface (`gl/export.ts`, debit==credit), view registry blocks a 13th view (`registry.ts:5`), `authority.ts` returns 0 rather than fabricate a close.
- **No prior-codebase merge** — check: no commit introduces 2023/pre-genesis code (lint REQ-163 `no-restricted-imports`). (REQ-163)

### Already resolved (register drift — do NOT re-touch)
- **`resolve.ts` party-correction** — booking's projection already corrects `consignee_party_id`+`bill_to_party_id` (`status-cache.ts` BOOKING_SQL `ON CONFLICT DO UPDATE`). *(residual: `resolve.ts:167` comment cosmetically stale — leave it.)* (REQ-181)
- **`der.ts` "CMS verification deferred"** — `cms.ts` implements real RFC-3161 CMS SignerInfo + X.509 chain verification (WP-16). *(residual: `der.ts:323` comment stale — leave it.)* (REQ-014)
- **Design/squint blocking-flip** — `tools/design/design-ci.json` = `{"mode":"blocking"}`, `audit.ts:296` exits 1 on any violation (report.json `[]`). Flip is live; only the job **name** lags (fix in A6). (REQ-158/207)

---

## §5 — The green bar (keep green after every change)

**BLOCKING (`ci.yml` `gates`/`design-advisory`/`secrets` steps — a red one fails the merge):**
1. `pnpm typecheck` — TS strict, no `any`, every workspace.
2. `pnpm lint` — eslint; enforces REQ-024 (no LLM imports in `packages/ledger`) + REQ-163 (no prior-codebase imports).
3. `pnpm test` — full unit suite (tools + `pnpm -r test`; incl. isolation, invariants, rater-purity, authority-coverage, identity-leak, traceability, coverage companion tests).
4. `pnpm check:fixtures` — REQ-112 hash registry. ⚠ **green ≠ proven**: pending/un-vendored rows only warn; fails only on missing/hash-mismatch/half-vendored.
5. `pnpm check:seed` — REQ-155 seed determinism.
6. `pnpm check:invariants` — I3/I8: bans UPDATE/DELETE/REPLACE/upsert on append-only tables, requires BEFORE-INSERT/DELETE guards, ≤22-table budget.
7. `pnpm check:pr` — REQ-118 PR body cites a real REQ-ID (pull_request only).
8. `pnpm check:traceability` — REQ-118 zero orphans both directions (also nightly).
9. `pnpm check:coverage` — REQ-118/119 100% register coverage. ⚠ status-drift rows are **reported, not failed**.
10. `pnpm check:authority-coverage` — REQ-030/L8 every overlay file consults `resolveAuthority`.
11. `pnpm check:identity` — REQ-167 leak scan. ⚠ **fail-OPEN on any runner without `IDENTITY_DENYLIST`+`REQUIRE_DENYLIST=1`** (the one genuine fail-open — A1 fixes it).
12. `pnpm --filter @shuddl/api test -- isolation` — REQ-025 tenant isolation (3 files).
13. `pnpm audit:design` — REQ-158 squint/contrast; blocking via `design-ci.json` (report.json `[]` → green).
14. `gitleaks` — secret scan over full history.

**ADVISORY / NOT wired into any workflow (an agent trusting only CI never runs these — A6 wires #1–4 in):**
- `pnpm check:rater-purity` · `check:rater-parity` · `check:invoice-parity` · `check:concierge-parity` — absent from `ci.yml`; loud-skip exit-0 while engagement fixtures are un-vendored, so a half-vendored/unpinned set would pass CI undetected.
- `pnpm verify` — local umbrella; not run in CI; omits `check:pr`, `test:acceptance`, `perf:map`, `test:visual`.
- `pnpm test:acceptance` (5 demos) · `pnpm perf:map` · `pnpm test:visual` — manual; self-skip without a browser-capable runner.

**Rule for Codex:** never add a green-bar command that *builds* a Bucket-C item; `check:coverage` must keep C items "recorded-deferred," not built. Whether the advisory jobs are required status checks is a GitHub branch-protection setting, not in-repo — verify before relying on them.

---

### Provenance
Inventory verified 2026-07-23 by a 12-agent audit sweep against live code (7 blind multi-modal finders + green-bar
mapper → 2 completeness critics → adversarial verify of all 20 blocks-prod items → synthesis). The critics added the
`corrects_event_id` visibility fail-open, the insert-guard device-key gap, the biller latest-quote heuristic, the
O(n²) replay path, Workers-observability-off, and the 4 unwired parity gates — none of which were in the source
register. Re-run: `Workflow({scriptPath: '…/shuddl-debt-inventory-wf_246eb328-dd1.js', resumeFromRunId: 'wf_246eb328-dd1'})`.
