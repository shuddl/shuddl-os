# SHUDDL V1 Remediation and V2 Framework Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close all repository-owned V1 Critical/High debt with executable evidence, record every external hold truthfully, and make the corrected REQ-214–REQ-288 V2 framework authoritative and executable.

**Architecture:** Preserve the immutable ledger and existing 35-kind/22-table laws. Repair authority at append/gate/effect boundaries, replace client fixtures with authenticated server state, and make release promotion consume non-skippable evidence. V2 remains a documented, append-only plan until the V1 R2 gate passes.

**Tech Stack:** TypeScript 5.9, Node 22.15, pnpm 11, Vitest, Cloudflare Workers/D1/R2/KV/Queues/Durable Objects, React PWAs, Playwright, GitHub Actions.

---

## Execution rules

- Work only in `.worktrees/codex-v1-remediation-v2-framework`.
- Use Node through `PATH=/Users/spencerpro/.nvm/versions/node/v22.15.0/bin:$PATH`.
- Follow red → green → refactor for every behavior change.
- Never edit a pinned migration; add a forward-only migration and update the migration lock.
- Never count a skip, pending fixture, advisory result, or missing external resource as PASS.
- Add only files named by the current task to each commit.
- After each task, run its focused tests and `git diff --check`.
- After each work package, run `pnpm verify`.
- Preserve the 35 event kinds, 22-table budget, three surfaces, and deterministic Rater.

## Task 1: Make the V2 register append-only, unique, and authoritative

**Files:**

- Modify: `tools/traceability/register.ts`
- Modify: `tools/traceability/traceability.test.ts`
- Modify: `genesis/09-REQUIREMENTS-REGISTER.csv`
- Modify: `tools/traceability/coverage-manifest.json`
- Create: `docs/ops/V2-EXECUTION-FRAMEWORK.md`
- Test: `tools/traceability/traceability.test.ts`
- Test: `tools/traceability/coverage.test.ts`

**Step 1: Write failing register-integrity tests**

Add tests proving:

```ts
it("rejects duplicate requirement ids", () => {
  expect(() => parseRegister(fixtureWith("REQ-214", "REQ-214"))).toThrow(/duplicate REQ-214/);
});

it("the authoritative register is strictly increasing and ends at REQ-288", () => {
  const ids = parseRegister().map((row) => Number(row.req_id.slice(4)));
  expect(ids).toEqual(Array.from({ length: 288 }, (_, index) => index + 1));
});
```

Use a temporary CSV helper rather than mutating the real register in the first test.

**Step 2: Run the tests and verify RED**

Run:

```bash
pnpm exec vitest run --config vitest.tools.config.ts tools/traceability/traceability.test.ts
```

Expected: FAIL because `parseRegister` currently accepts duplicate IDs and the register ends at REQ-213.

**Step 3: Make the parser reject malformed identity/order**

After parsing, enforce:

```ts
const expected = `REQ-${String(index + 1).padStart(3, "0")}`;
if (row.req_id !== expected) {
  throw new Error(`register row ${index + 2} expected ${expected}, received ${row.req_id}`);
}
```

This makes duplicates, gaps, reordering, and non-padded IDs fail through one deterministic invariant.

**Step 4: Append REQ-214 through REQ-288**

Transcribe the approved 75-row table from:

`docs/plans/2026-07-23-v1-remediation-v2-framework-design.md`

CSV rules:

- exactly eight comma-safe fields;
- semicolons inside prose;
- V2/V2.5/V3 work packages remain `vNEXT`;
- counsel/owner gates use `CONFIRM-GATED`;
- every row cites the approved design as source/spec;
- every DoD is observable and names the relevant AT or cross-cutting proof.

**Step 5: Record every deferred home**

Add REQ-214 through REQ-288 to `coverage-manifest.json` with its stage and disposition. Do not use the manifest for a row after its status becomes built; built rows require implementation annotations.

**Step 6: Write the operational V2 execution framework**

`docs/ops/V2-EXECUTION-FRAMEWORK.md` must contain:

- the P0 → PA → PB/PC/PE → PD → PF graph;
- REQ ranges per phase;
- entry/exit criteria;
- accountable roles;
- external holds;
- AT-1 through AT-6;
- R0 through R5 promotion rules;
- the 30-day non-compressible shadow requirement.

**Step 7: Run all register gates**

Run:

```bash
pnpm exec vitest run --config vitest.tools.config.ts tools/traceability/traceability.test.ts tools/traceability/coverage.test.ts
pnpm check:traceability
pnpm check:coverage
```

Expected: PASS, 288/288 classified, zero duplicate/gap/order failures.

**Step 8: Commit**

```bash
git add tools/traceability/register.ts tools/traceability/traceability.test.ts \
  genesis/09-REQUIREMENTS-REGISTER.csv tools/traceability/coverage-manifest.json \
  docs/ops/V2-EXECUTION-FRAMEWORK.md
git commit -m "docs(v2): normalize REQ-214 through REQ-288"
```

## Task 2: Pin and prove the runtime contract

**Files:**

- Create: `.node-version`
- Create: `tools/checks/runtime-contract.ts`
- Create: `tools/checks/runtime-contract.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/ops/DEPLOYMENT.md`
- Test: `tools/checks/runtime-contract.test.ts`

**Step 1: Write failing version-contract tests**

Test a pure function:

```ts
expect(checkRuntime({ node: "20.11.1", pnpm: "11.10.0" })).toMatchObject({
  ok: false,
  violations: expect.arrayContaining([expect.stringMatching(/Node 22\.15/)]),
});
expect(checkRuntime({ node: "22.15.0", pnpm: "11.10.0" }).ok).toBe(true);
```

Also assert `.node-version`, `engines.node`, `engines.pnpm`, and `packageManager` describe the same contract.

**Step 2: Verify RED**

Run:

```bash
pnpm exec vitest run --config vitest.tools.config.ts tools/checks/runtime-contract.test.ts
```

Expected: FAIL because `.node-version` is absent and engines allow incompatible Node/pnpm versions.

**Step 3: Implement the contract**

- `.node-version`: `22.15.0`
- `engines.node`: `>=22.15.0 <23`
- `engines.pnpm`: `11.10.0`
- keep `packageManager: pnpm@11.10.0`
- add `check:runtime` as the first command in verification scripts.

The CLI exits non-zero and prints installed/required versions on mismatch.

**Step 4: Update operator setup**

Document the exact Node and pnpm activation commands and the current Node 20 failure mode. Remove language implying Node 20 is supported.

**Step 5: Verify GREEN**

Run:

```bash
pnpm check:runtime
pnpm exec vitest run --config vitest.tools.config.ts tools/checks/runtime-contract.test.ts
```

Expected: PASS under Node 22.15.0; a spawned Node-20-shaped unit input fails deterministically.

**Step 6: Commit**

```bash
git add .node-version package.json README.md docs/ops/DEPLOYMENT.md \
  tools/checks/runtime-contract.ts tools/checks/runtime-contract.test.ts
git commit -m "build: pin the verified Node and pnpm contract"
```

## Task 3: Introduce non-skippable gate results and merge evidence

**Files:**

- Create: `tools/release/evidence.ts`
- Create: `tools/release/evidence.test.ts`
- Create: `tools/release/run-gate.ts`
- Modify: `tools/harness/playwright-guard.ts`
- Modify: `tools/checks/identity-leak.ts`
- Modify: `tools/fixtures/verify.ts`
- Modify: `tools/rater/parity.ts`
- Modify: `tools/rater/invoice-parity.ts`
- Modify: `tools/concierge/parse-parity.ts`
- Modify: `package.json`
- Test: `tools/release/evidence.test.ts`
- Test: `tools/checks/identity-leak.test.ts`
- Test: `tools/fixtures/fixtures.test.ts`

**Step 1: Test the evidence state machine**

Define:

```ts
type GateStatus = "PASS" | "FAIL" | "BLOCKED" | "PENDING" | "NOT_APPLICABLE";
```

Tests must prove:

- PASS requires `executed=true` and `assertions > 0`;
- BLOCKED/PENDING cannot promote;
- commit/environment/fixture/deployment mismatch cannot promote;
- expired evidence cannot promote;
- malformed evidence exits with the dedicated evidence error.

**Step 2: Verify RED**

Run:

```bash
pnpm exec vitest run --config vitest.tools.config.ts tools/release/evidence.test.ts
```

Expected: FAIL because the release evidence module does not exist.

**Step 3: Implement evidence validation and stable exit codes**

Use:

- `0`: valid PASS;
- `1`: executed assertions failed;
- `2`: prerequisite BLOCKED/PENDING;
- `3`: malformed/stale/mismatched evidence.

Write JSON artifacts under `artifacts/release/<commit>/<environment>/`; add the generated artifact directory to `.gitignore`.

**Step 4: Put current skip-capable tools behind explicit modes**

Each gate accepts `--mode local|merge|release`:

- local may report PENDING and exit zero for developer convenience;
- merge/release emits BLOCKED and exits two;
- only an executed assertion set emits PASS.

Do not parse human prose to decide status; return structured results from exported functions.

**Step 5: Add scripts**

Add:

```json
"verify:dev": "pnpm check:runtime && ...",
"verify:merge": "tsx tools/release/run-gate.ts --profile merge",
"verify:release": "tsx tools/release/run-gate.ts --profile release"
```

`verify` remains an alias to `verify:dev` while the branch is under construction. Promotion consumes only `verify:merge`/`verify:release`.

**Step 6: Verify**

Run:

```bash
pnpm exec vitest run --config vitest.tools.config.ts \
  tools/release/evidence.test.ts \
  tools/checks/identity-leak.test.ts \
  tools/fixtures/fixtures.test.ts
pnpm verify:merge
```

Expected now: focused tests PASS; `verify:merge` exits 2 and identifies the absent denylist/browser/private fixtures as BLOCKED instead of reporting green.

**Step 7: Commit**

```bash
git add .gitignore package.json tools/release tools/harness/playwright-guard.ts \
  tools/checks/identity-leak.ts tools/fixtures/verify.ts tools/rater/parity.ts \
  tools/rater/invoice-parity.ts tools/concierge/parse-parity.ts \
  tools/checks/identity-leak.test.ts tools/fixtures/fixtures.test.ts
git commit -m "build: make release gates non-skippable"
```

## Task 4: Make CI exercise the complete merge surface

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Create: `tools/release/ci-contract.test.ts`
- Test: `tools/release/ci-contract.test.ts`

**Step 1: Write a failing CI contract test**

Parse the workflow text and assert it includes:

- runtime preflight;
- all workspace builds;
- acceptance;
- strict visual, accessibility, and performance;
- Rater/invoice/Concierge parity;
- requirement/authority/identity/invariant gates;
- production dependency audit;
- history-wide gitleaks;
- immutable action SHAs.

Reject `uses: ...@vN`.

**Step 2: Verify RED**

Run:

```bash
pnpm exec vitest run --config vitest.tools.config.ts tools/release/ci-contract.test.ts
```

Expected: FAIL on missing build/acceptance/browser/parity/audit jobs and mutable action tags.

**Step 3: Refactor CI around `verify:merge`**

- install Node from `.node-version`;
- install the Playwright browser/dependencies;
- run `pnpm -r --if-present build`;
- run `pnpm test:acceptance`;
- run strict browser/a11y/performance jobs;
- run production audit;
- upload evidence artifacts even when a gate fails;
- pin each action to a full commit SHA with the release tag in a comment.

**Step 4: Verify locally**

Run:

```bash
pnpm exec vitest run --config vitest.tools.config.ts tools/release/ci-contract.test.ts
pnpm -r --if-present build
pnpm test:acceptance
pnpm audit --prod
```

Expected: contract/build/acceptance/audit PASS. Strict external gates remain BLOCKED until their prerequisites exist.

**Step 5: Commit**

```bash
git add .github/workflows/ci.yml package.json tools/release/ci-contract.test.ts
git commit -m "ci: enforce the complete merge evidence surface"
```

## Task 5: Guard every append-only uniqueness surface

**Files:**

- Create: `db/tenant/migrations/0008_append_only_unique_guards.sql`
- Modify: `db/migrations.lock.json`
- Modify: `tools/checks/invariants.ts`
- Modify: `tools/checks/invariants.test.ts`
- Modify: `packages/ledger/test/schema-core.test.ts`

**Step 1: Write failing schema and lint tests**

Add tests that attempt `INSERT OR REPLACE` collisions on:

- event ID;
- event hash;
- event device tuple;
- money-line correction uniqueness.

After each rejection, assert the original row and hash remain byte-for-byte unchanged.

Add an invariant test where a new UNIQUE index lacks a matching guard predicate; expect a completeness violation.

**Step 2: Verify RED**

Run:

```bash
pnpm exec vitest run packages/ledger/test/schema-core.test.ts
pnpm exec vitest run --config vitest.tools.config.ts tools/checks/invariants.test.ts
```

Expected: the uncovered REPLACE collisions or completeness test fails.

**Step 3: Add the forward migration**

Create BEFORE INSERT triggers whose `WHEN EXISTS` predicates enumerate each collision surface and whose bodies contain only `RAISE(ABORT, ...)`.

**Step 4: Extend the invariant scanner**

Compare UNIQUE index/constraint targets on guarded tables against normalized guard predicates. A new unique target without coverage fails the invariant check.

**Step 5: Pin the new migration**

Run:

```bash
pnpm db:lock
pnpm check:invariants
```

**Step 6: Verify GREEN**

Run:

```bash
pnpm exec vitest run packages/ledger/test/schema-core.test.ts
pnpm exec vitest run --config vitest.tools.config.ts tools/checks/invariants.test.ts
pnpm check:invariants
```

Expected: PASS; 21/22 tables remain; the new migration is locked.

**Step 7: Commit**

```bash
git add db/tenant/migrations/0008_append_only_unique_guards.sql db/migrations.lock.json \
  tools/checks/invariants.ts tools/checks/invariants.test.ts \
  packages/ledger/test/schema-core.test.ts
git commit -m "fix(ledger): guard every append-only uniqueness surface"
```

## Task 6: Make credit decisions fail closed

**Files:**

- Modify: `workers/api/src/do/sequencer.ts`
- Modify: `packages/ledger/src/projection/status-cache.ts`
- Modify: `packages/ledger/src/gates/transition-gates.ts`
- Create: `packages/ledger/src/reconcile/credit.ts`
- Modify: `packages/ledger/src/index.ts`
- Create: `workers/agents/src/credit-recon-sweep.ts`
- Modify: `workers/agents/src/index.ts`
- Modify: `workers/api/test/credit-authz.test.ts`
- Modify: `packages/ledger/test/booking-gate.test.ts`
- Modify: `workers/api/test/recon-sweep.test.ts`
- Modify: `workers/agents/test/recon-sweep-cron.test.ts`

**Step 1: Replace the test that blesses the gap**

Write failing cases:

- native `credit.checked` for an absent party rejects and appends zero events;
- an unresolved legacy `credit_projection_gap` for bill-to blocks booking;
- party creation plus reconciliation applies the latest valid decision and resolves the anomaly;
- a later clear supersedes an earlier hold;
- cross-tenant anomalies/events never affect the current tenant.

**Step 2: Verify RED**

Run:

```bash
pnpm --filter @shuddl/api exec vitest run test/credit-authz.test.ts test/booking-gate.test.ts
```

Expected: FAIL because absent-party credit currently appends and null credit can pass booking.

**Step 3: Reject invalid new writes**

In the sequencer, before append:

```ts
const party = await db.prepare("SELECT id FROM parties WHERE id = ?").bind(partyId).first();
if (!party) throw rpcError(422, "credit_party_not_found");
```

Keep projection anomaly handling for historical/imported events.

**Step 4: Block on unresolved projection ambiguity**

The booking gate queries unresolved `credit_projection_gap` anomalies scoped to `bill_to`. Presence yields the same fail-closed credit result as a hold, with a distinct reason. The shared ledger reconciliation function may resolve the gap before the gate re-reads credit; the agents cron invokes the same function proactively.

**Step 5: Implement bounded reconciliation**

Load the latest valid `credit.checked` for the party, update `parties.credit_status`, and mark the specific anomaly resolved in one D1 batch. Re-running is idempotent.

**Step 6: Verify GREEN**

Run the focused command plus:

```bash
pnpm --filter @shuddl/api test -- credit
pnpm --filter @shuddl/ledger test -- booking-gate
```

**Step 7: Commit**

```bash
git add workers/api/src/do/sequencer.ts packages/ledger/src/reconcile/credit.ts \
  packages/ledger/src/index.ts workers/agents/src/credit-recon-sweep.ts \
  workers/agents/src/index.ts workers/api/test/credit-authz.test.ts \
  workers/api/test/recon-sweep.test.ts workers/agents/test/recon-sweep-cron.test.ts \
  packages/ledger/src/projection/status-cache.ts \
  packages/ledger/src/gates/transition-gates.ts \
  packages/ledger/test/booking-gate.test.ts
git commit -m "fix(booking): fail closed on unresolved credit authority"
```

## Task 7: Bind billing to the exact accepted booking quote

**Files:**

- Modify: `packages/contracts/src/booking.ts`
- Modify: `workers/api/src/do/sequencer.ts`
- Modify: `workers/agents/src/booking.ts`
- Modify: `workers/agents/src/biller.ts`
- Modify: `workers/api/test/booking.test.ts`
- Modify: `workers/api/test/biller.test.ts`
- Modify: `workers/api/test/booking-gate.test.ts`

**Step 1: Write the authority-chain tests**

Required fixture:

```text
quote A priced → quote A accepted → booking references A
→ quote B priced later → POD → invoice must equal A
```

Also test dangling, wrong-kind, cross-stream, cross-tenant, and unaccepted references. Each invalid booking must append zero events and produce zero invoice/money effects.

**Step 2: Verify RED**

Run:

```bash
pnpm --filter @shuddl/api exec vitest run test/booking.test.ts test/biller.test.ts test/booking-gate.test.ts
```

Expected: the later-quote test bills quote B or invalid references are accepted.

**Step 3: Validate booking authority before append**

Load the referenced `quote.priced` and the selecting `quote.accepted`; verify tenant, stream, order, and exact ID. Use the existing typed booking payload rather than a parallel field.

**Step 4: Load the booking quote in Biller**

Replace latest-pre-POD selection with:

```ts
const booking = await loadSingleBooking(db, shipmentId);
const quote = await loadQuoteByEventId(db, shipmentId, booking.quote_event_id);
```

Any authority inconsistency produces a durable held invoice reason and no money/send effect.

**Step 5: Verify GREEN and commit**

Run the focused tests, then:

```bash
git add packages/contracts/src/booking.ts workers/api/src/do/sequencer.ts \
  workers/agents/src/booking.ts workers/agents/src/biller.ts \
  workers/api/test/booking.test.ts workers/api/test/biller.test.ts \
  workers/api/test/booking-gate.test.ts
git commit -m "fix(billing): invoice the exact accepted booking quote"
```

## Task 8: Fail closed on invoice-correction visibility

**Files:**

- Modify: `packages/ledger/src/visibility.ts`
- Modify: `workers/api/src/do/sequencer.ts`
- Modify: `packages/ledger/test/visibility.test.ts`
- Create: `workers/api/test/invoice-correction.test.ts`

**Step 1: Replace fallback expectations**

Test:

- internal and counterparty originals inherit exactly;
- missing original rejects;
- wrong-kind original rejects;
- cross-stream/cross-tenant original rejects;
- rejection leaves events, invoices, and money-lines unchanged.

**Step 2: Verify RED**

Run:

```bash
pnpm --filter @shuddl/ledger exec vitest run test/visibility.test.ts
pnpm --filter @shuddl/api exec vitest run test/invoice-correction.test.ts
```

**Step 3: Return a typed unresolved result**

Remove default visibility from inherited kinds. Resolve the parent before append in the sequencer; only an exact parent produces a visibility value.

**Step 4: Verify GREEN and commit**

```bash
git add packages/ledger/src/visibility.ts packages/ledger/test/visibility.test.ts \
  workers/api/src/do/sequencer.ts workers/api/test/invoice-correction.test.ts
git commit -m "fix(ledger): reject unresolved correction visibility"
```

## Task 9: Require stored evidence bytes before proof email

**Files:**

- Modify: `workers/agents/src/biller.ts`
- Modify: `workers/agents/src/tenants.ts`
- Modify: `workers/api/src/routes/evidence.ts`
- Modify: `workers/agents/src/recon-sweep.ts`
- Modify: `workers/api/test/biller.test.ts`
- Modify: `workers/api/test/evidence-upload.test.ts`
- Modify: `workers/api/test/idempotency.test.ts`

**Step 1: Write failing evidence-authority tests**

Cover:

- missing document row;
- missing R2 object;
- tombstoned document;
- cross-tenant R2 key/document;
- recorded hash mismatch;
- upload then re-drive succeeds;
- duplicate re-drive creates one invoice and one send;
- retryable evidence-order 4xx is not cached.

**Step 2: Verify RED**

Run:

```bash
pnpm --filter @shuddl/api exec vitest run test/biller.test.ts test/evidence-upload.test.ts test/idempotency.test.ts
```

**Step 3: Add the Biller evidence precondition**

Before sender invocation:

```ts
const document = await loadActivePodDocument(db, tenant, shipmentId, evidenceHash);
const object = document && await env.EVIDENCE.head(document.r2_key);
if (!document || !object) return hold("evidence_missing");
```

Validate recorded hash/metadata and tenant key prefix before treating `head` as proof.

**Step 4: Re-drive after upload**

After successful R2 put and document transaction, enqueue the original billing trigger deterministically. Existing invoice/send idempotency owns duplicate suppression.

**Step 5: Verify GREEN and commit**

```bash
git add workers/agents/src/biller.ts workers/agents/src/tenants.ts \
  workers/agents/src/recon-sweep.ts workers/api/src/routes/evidence.ts \
  workers/api/test/biller.test.ts workers/api/test/evidence-upload.test.ts \
  workers/api/test/idempotency.test.ts
git commit -m "fix(evidence): verify stored POD bytes before sending"
```

## Task 10: Replace the fictional driver read path

**Files:**

- Create: `packages/contracts/src/driver-manifest.ts`
- Create: `workers/api/src/routes/driver-manifest.ts`
- Modify: `workers/api/src/index.ts`
- Create: `apps/driver/src/api/client.ts`
- Create: `apps/driver/src/auth/session.ts`
- Modify: `apps/driver/src/App.tsx`
- Modify: `apps/driver/src/session.ts`
- Remove production imports from: `apps/driver/src/data/stops.ts`
- Create: `workers/api/test/driver-manifest.test.ts`
- Create: `apps/driver/src/App.test.tsx`

**Step 1: Write API and UI tests**

Prove:

- only authenticated assigned drivers receive stops;
- cross-driver/cross-tenant probes return no manifest;
- precise future-stop fields are not returned outside current V1 policy;
- 401 clears client session/data;
- empty/error states never import fixture stops;
- the production bundle contains no `DAY_SHEET`.

**Step 2: Verify RED**

Run API and driver tests; expected failure is absence of the route/client and continued fixture render.

**Step 3: Add the typed manifest route**

Resolve tenant and driver only from verified auth, query assigned shipments/stops, and return a strict allowlist with server timestamps.

**Step 4: Replace the App data source**

Use explicit `loading | ready | empty | stale | unauthenticated | unavailable` states. Never fall back to demo data.

**Step 5: Verify and commit**

Run focused tests plus the driver build, then commit the named files.

## Task 11: Implement durable driver event/evidence synchronization

**Files:**

- Modify: `packages/driver-core/src/queue.ts`
- Create: `packages/driver-core/src/sync.ts`
- Create: `packages/driver-core/test/sync.test.ts`
- Create: `apps/driver/src/sync/transport.ts`
- Create: `apps/driver/src/sync/useSync.ts`
- Modify: `apps/driver/src/flow/captures.ts`
- Modify: `apps/driver/src/components/GatedFlow.tsx`
- Create: `workers/api/src/routes/devices.ts`
- Modify: `workers/api/src/index.ts`
- Create: `workers/api/test/devices.test.ts`

**Step 1: Write the queue-state tests**

State machine:

```text
captured → event_pending → event_acked → evidence_pending
→ evidence_acked → synced
```

Test reload at every boundary, duplicate delivery, 429/5xx backoff, 401 auth block, 403/422 operator block, and monotonic ACK state.

**Step 2: Verify RED**

Run driver-core tests; expected failure is no transport/state machine.

**Step 3: Implement pure synchronization**

Keep retry classification and state transitions in `driver-core`; inject storage, clock, random/jitter, event transport, and evidence transport.

**Step 4: Enroll authenticated devices**

Bind the P-256 public key to the authenticated driver with uniqueness, revocation, and tenant isolation. Never trust a driver ID from the request body.

**Step 5: Replace mock geolocation**

Use `watchPosition` only while the app is visible, foreground, permitted, and assigned. Emit explicit permission/stale/background states. Do not claim background continuity.

**Step 6: Verify and commit**

Run driver-core, driver, device/position API tests and the production build; commit.

## Task 12: Replace portal demo data with a server-scoped board

**Files:**

- Modify: `workers/api/src/routes/board.ts`
- Modify: `workers/api/test/board.test.ts`
- Create: `apps/portal/src/api/board.ts`
- Modify: `apps/portal/src/App.tsx`
- Modify: `apps/portal/src/components/ShipmentList.tsx`
- Modify: `packages/map/src/useFleet.ts`
- Modify: `apps/portal/src/App.test.tsx`

**Step 1: Write adversarial API tests**

Test party A vs B, forged `party_id`, precise/coarse policy, terminal/no-position exclusion, and strict response allowlist.

**Step 2: Write UI tests**

Test loading/empty/stale/unavailable/401 states and prove no `demoFleet` fallback.

**Step 3: Verify RED**

Run board/portal tests; current server/client filtering and demo imports should fail.

**Step 4: Enforce scope before serialization**

Apply party relationship and coordinate-generalization predicates in SQL/server projection before returning JSON.

**Step 5: Poll truthfully**

Use a bounded 15–30 second interval with abort-on-unmount and a visible server-derived freshness timestamp.

**Step 6: Verify and commit**

Run focused tests, portal build, and a two-party browser scenario; commit.

## Task 13: Replace jurisdiction boxes with versioned polygons

**Files:**

- Create: `packages/ledger/src/geo/polygon-source.ts`
- Modify: `packages/ledger/src/geo/jurisdiction.ts`
- Modify: `packages/ledger/test/jurisdiction.test.ts`
- Create: `fixtures/jurisdiction/manifest.json`
- Add licensed polygon artifact through the approved fixture process
- Modify: `docs/ops/GO-LIVE-CHECKLIST.md`

**Step 1: Write border/coast/unknown tests**

Include interior points, shared borders, coastal near-misses, unsupported states, malformed polygons, and fixture-hash mismatch.

**Step 2: Verify RED**

Current five-box logic should misclassify at least one border/coastal case.

**Step 3: Implement deterministic point-in-polygon**

Load only a version/hash-pinned, license-approved artifact. Tie/border policy must be explicit. Any load/parse/coverage failure returns `XX`.

**Step 4: Verify and commit**

Run jurisdiction, consent, position, and invariant suites; commit code, manifest, licensed artifact metadata, and checklist status.

## Task 14: Make browser, accessibility, and performance evidence blocking

**Files:**

- Modify: `playwright.config.ts`
- Modify: `packages/map/playwright.config.ts`
- Modify: `packages/map/perf/perf.spec.ts`
- Create: `tests/e2e/driver-offline-sync.spec.ts`
- Create: `tests/e2e/portal-isolation.spec.ts`
- Create: `tests/e2e/accessibility.spec.ts`
- Modify: `tools/harness/playwright-guard.ts`
- Modify: `.github/workflows/ci.yml`

**Step 1: Write harness negative controls**

Prove merge/release mode fails when the browser is absent, no tests are discovered, or all tests are skipped.

**Step 2: Add end-to-end scenarios**

- driver offline capture → reconnect → server event/evidence observed;
- portal party isolation;
- keyboard/screen-reader semantics for core flows;
- 1,000-entity map interaction on the declared reference machine.

**Step 3: Set measurable budgets**

- at least 55 FPS reference interaction;
- no long task over 100 ms;
- board p95 at most 500 ms under declared load;
- zero serious/critical accessibility findings.

**Step 4: Verify**

Install the pinned browser and run strict visual/a11y/perf/E2E commands. Missing tooling is BLOCKED, not green.

**Step 5: Commit**

Commit configs, specs, harness, and CI job together.

## Task 15: Implement release operations and recovery evidence

**Files:**

- Create: `tools/deploy/preflight.ts`
- Create: `tools/deploy/preflight.test.ts`
- Create: `tools/deploy/restore-verify.ts`
- Create: `tools/deploy/restore-verify.test.ts`
- Modify: `tools/deploy/staging-smoke.ts`
- Modify: `.github/workflows/nightly.yml`
- Modify: `docs/ops/DEPLOYMENT.md`
- Modify: `docs/ops/dr-backups.md`
- Modify: `docs/ops/slo.md`
- Modify: `docs/ops/secrets.md`
- Modify: `docs/ops/GO-LIVE-CHECKLIST.md`

**Step 1: Test a pure environment preflight**

Validate required D1/R2/KV/queue/DO/service bindings, secrets, routes, origins, sender, TSA, backups, and environment identity. Return a structured BLOCKED list.

**Step 2: Test restore reconciliation**

Given source/restored metadata, verify event row counts, head hashes, chain validity, invoices, money totals, and manifest digest. Any mismatch fails.

**Step 3: Replace the nightly stub**

Export every tenant and control D1, write a SHA-256 manifest, retain according to policy, and emit release evidence. Credentials remain OIDC/external; absence is BLOCKED.

**Step 4: Upgrade staging smoke**

Record exact deployment version/SHA, environment, assertion count, invoice/evidence outcome, and artifact references.

**Step 5: Update runbooks**

Document:

- production resource inventory;
- deploy/migration order;
- rollback/forward-repair;
- DLQ inspection/re-drive;
- alert thresholds and owner;
- RPO ≤24h/RTO ≤4h;
- restore and smoke commands;
- external HOLD owners.

**Step 6: Verify and commit**

Run focused tool tests, a dry-run preflight, and a fixture restore verification. Commit code/workflow/docs.

## Task 16: Reconcile technical debt and project state

**Files:**

- Modify: `docs/ops/GO-LIVE-CHECKLIST.md`
- Modify: `docs/ops/PROJECT-STATE.md`
- Create: `docs/ops/RELEASE-EVIDENCE.md`
- Modify: `docs/security/threat-model.md`
- Modify: `docs/security/pen-test-basics.md`
- Modify: `genesis/09-REQUIREMENTS-REGISTER.csv`
- Modify: `tools/traceability/coverage-manifest.json`

**Step 1: Re-audit every existing debt row**

For each row record:

- current severity;
- repository-owned vs external;
- exact proof;
- owner;
- status: OPEN/FIXED/BLOCKED/NOT_APPLICABLE;
- release grade blocked;
- evidence expiry.

Never delete history; strike through or supersede resolved rows.

**Step 2: Advance only proven requirement statuses**

Move V1 rows out of `vNEXT`/`*-DISCOVERED` only when an implementation annotation and passing test exist. Remove manifest dispositions only after the row becomes built.

**Step 3: Re-baseline PROJECT-STATE**

Replace stale WP-06 language with WP-01–WP-16 reality and the current exact test/gate counts. Separate:

- repository green;
- staging certified;
- pilot holds;
- production holds;
- V2 planned.

**Step 4: Verify**

Run:

```bash
pnpm check:traceability
pnpm check:coverage
pnpm verify:dev
pnpm verify:merge
```

Expected: dev gate PASS; merge/release either PASS or return explicit BLOCKED records for genuinely external prerequisites. No skips masquerade as green.

**Step 5: Commit**

Commit the reconciled register, coverage dispositions, and operational/security documents.

## Task 17: Final V1 evidence sweep

**Files:**

- Modify only files identified by the sweep
- Create: `artifacts/release/<sha>/...` at runtime; do not commit generated evidence

**Step 1: Run the complete local repository gate**

```bash
pnpm verify:dev
pnpm -r --if-present build
pnpm test:acceptance
pnpm audit --prod
git diff --check
```

**Step 2: Run the promotion gate**

```bash
pnpm verify:merge
pnpm verify:release
```

Any BLOCKED result becomes a named external hold; do not relabel it PASS.

**Step 3: Run field/infrastructure evidence**

When credentials/resources are available:

- staging migration dry-run;
- deployed smoke;
- strict browser/device acceptance;
- backup restore;
- rollback/forward-repair;
- tenant isolation probe;
- production configuration preflight.

**Step 4: Audit the objective requirement by requirement**

Confirm:

- all V1 Critical/High code debt closed;
- no demo/mock success path in production clients;
- financial/evidence authority proven;
- release checks non-skippable;
- all technical debt documented;
- V2 design, 75 requirements, DAG, owners, estimates, acceptance, and evidence contract authoritative.

**Step 5: Commit final evidence/document reconciliation**

Commit only source/runbook/register changes. Tag or promote only after the exact SHA owns complete evidence.
