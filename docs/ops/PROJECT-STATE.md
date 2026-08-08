# Project state & resume guide

**As of 2026-08-08** · branch `main` · **1,143 commits at `d8f1dd7`** — a further technical-debt audit phase
(§605–§653), whose stopping point is audit **§648**. The merge gate at HEAD, **measured end to end** with a
clean tree (§647): **21 PASS · 0 FAIL · 5 BLOCKED**, aggregate BLOCKED, evidence artifact written. The five
BLOCKED are the owner-held inputs (denylist secret + four private-fixture gates); there are **no failing
gates and no failing tests** at HEAD. *(Was: 2026-08-05, 803 commits at `887b7f0`; before that 2026-08-02, 534 commits at
`3e1f31d`; before that, 2026-07-31 at 435.) **This header is the DOCUMENT baseline; individual rows below carry their own `measured at <sha>` stamps, which may predate it and are not stale for doing so — a measurement is true of the commit it names (audit §330).** Supersedes the 2026-07-27 baseline at `7c1a0b4` (itself re-baselined
from the 2026-07-14 note that stopped at WP-06). All sixteen WPs are closed, T14/T15 landed after them, and a
2026-07-28 reboot cleared the `workerd` wedge.

> **Read [`docs/audits/2026-08-01-technical-debt-audit.md`](../audits/2026-08-01-technical-debt-audit.md)
> before trusting anything on this page.** It is the primary artifact of those commits — **292 sections
> numbered through §301 as of 2026-08-05**, its own phase gate (**§4, whose CURRENT MEASUREMENT is §298 + §310: the merge
> gate RUN — 24 gates, 17 PASS, 5 BLOCKED, 2 FAIL (as MEASURED; the merge profile is **25** as of
> 2026-08-06, audit §483 — a dated observation keeps the number it observed, so this row is NOT restated) — and **18 governing invariants mutation-proven — CLAUDE.md's ten laws + genesis/10's eight schema invariants, 30 REDs, zero residual**), and the corrections that this note's inline "superseded" markers
> came from. §299 specifies the single blocker behind both FAILs (the uncommitted `REQ-289` GTM row) and
> §300 verifies every ledger item against its source. *(Routing corrected 2026-08-05 — this block said "65
> sections, re-measured §65" and would have landed a returning reader 236 sections behind; audit §302.)* What it changed that a returning reader most needs to know: three gates were added
> (`check:tables` §50, `check:chokepoint` §56, plus the auth/idempotency surface pins §57/§59);
> **`CLAUDE.md` rule 4 was factually wrong** and is corrected (§60) along with its `genesis/11` template
> (§61/§62); and §64 states the rule that produced most of these findings — *documents may state laws, not
> observations.* This header is itself an observation: it is dated and SHA-stamped for exactly that reason.

This is the "where are we / how do I pick back up" note. It is a pointer, not a spec — the authorities are
`CLAUDE.md`, `genesis/`, `docs/wp/WP-01…WP-16.md`, and `genesis/09-REQUIREMENTS-REGISTER.csv`. The
operator/deploy line-items and the technical-debt ledger live in
[`docs/ops/GO-LIVE-CHECKLIST.md`](./GO-LIVE-CHECKLIST.md); this file does not duplicate them — it sorts the
state into the five buckets below so that "the build is green" is never mistaken for "the product can go
live." **What each gate proves, what artifact survives it, and what makes that artifact stop being true is
[`docs/ops/RELEASE-EVIDENCE.md`](./RELEASE-EVIDENCE.md)** — the evidence contract, the V1 sweep with every
verdict quoted, the named holds H1–H10, and the tip-verdict table. Read it before trusting any green on
this page: its rule 1 is that evidence does not transfer across commits.

## Safety posture (read first)

> ### ~~⚠ 2026-07-30 — the staging claim below could NOT be confirmed~~ RESOLVED 2026-07-31: it is confirmed. The first reading was right — a second account. Everything below is superseded; see §6
>
> Queried the only Cloudflare account reachable from this workstation (`wrangler whoami` lists exactly one;
> OAuth-authenticated). It contains the worker `shuddl-tech` (the marketing site) and:
> **no `shuddl-api-staging`, no `shuddl-agents-staging`, zero `shuddl-*` D1 databases (of 20), zero
> `shuddl-*` KV namespaces (of 36).**
>
> Two readings fit, and this repository cannot distinguish them: the staging environment lives in a
> **second Cloudflare account** not reachable from here (multi-account is a known fact — the `shuddl.tech`
> zone was previously found to sit in a different account), **or it was torn down** and the paragraph below
> outlived it.
>
> ~~Until an operator confirms which, treat every claim in the next paragraph as **unverified**~~ —
> **confirmed 2026-07-31 against account `89618ce…`, which holds the `shuddl.tech` zone AND every resource:**
> 13 `shuddl-*` D1 databases (staging and prod), five deployed workers, `api.shuddl.tech` routed and
> answering. The workstation had been querying a different account. The safety consequence that cut both
> ways is settled the live way: staging IS real and `shuddl-t-tenant-a-staging` holds 40 events / 5 invoices
> / 279,000¢, so seeding or replaying there sends real mail. See §6 and `LAUNCH-RUNBOOK.md` Step 0.

~~There is no live production and~~ **Superseded 2026-08-01 (audit D1) — production EXISTS and is live:**
provisioned 2026-07-30 (`provision:prod --apply` — 6 D1, 2 KV, 1 R2), five workers deployed,
`api.shuddl.tech` routed and answering 401 without a token, preflight **PASS 72 checks** on 2026-07-31
(`RELEASE-EVIDENCE.md` § *Production preflight — PASS*), and the three browser surfaces serving (§6). What
**remains true and is the actual safety line**: no prod outbound email/SMS/money flow is enabled
(`EVIDENCE_FROM` absent ⇒ `NotConfiguredSender`), and **no real tenant exists** — prod control holds only
three system rows, so nobody can log in. Treat prod as a LIVE environment: do not seed, replay, or test
against it on the belief that nothing can leave the box. A **staging** environment
is deployed to Cloudflare (`shuddl-api-staging`, `shuddl-agents-staging`) with **synthetic data only**.
Staging evidence sending is **LIVE**: `send.shuddl.tech` is verified and both `RESEND_API_KEY`
(sending-only, scoped) and `EVIDENCE_FROM` are set, so the deployed Biller sends real evidence email. Proven
end-to-end — a synthetic POD produced a delivered `DELIVERED · SMK-… · PROOF + INVOICE` email from
`pod@send.shuddl.tech` (acceptance demo #1's chain, on live infra). Because staging tenants are synthetic,
mail only reaches whatever address a shipment's party actually carries; one owner test inbox is the only
real one wired. To disable: unset `EVIDENCE_FROM` in `[env.staging.vars]` and redeploy — the Biller reverts
to `NotConfiguredSender`. ~~**Prod is not provisioned and**~~ **its sending stays milestone-gated (REQ-159)**
*(struck 2026-08-01: prod IS provisioned and deployed — see the supersession at the head of this section;
the sending gate is the half that stands)*.

No committed API key, no real customer/tenant data in the repo. Every feature that could touch the outside
world (email send, billing, EDI transport, MCP pairing, PLG provisioning) ships **fail-closed and
CONFIRM-gated** — inert by default, activated only by an operator binding a secret or flipping a flag.
Runbook and teardown: `docs/ops/DEPLOYMENT.md`.

## The five states — do not collapse them

Only the first is a statement about this repository; the rest are statements about the world outside it,
and none of those is satisfied. They are independent, and a returning engineer who reads one as the others
will be wrong about what is safe to do next.

| # | State | Today |
|---|---|---|
| 1 | Repository green | Yes, and measured — **re-measured 2026-08-05 at `1a89389`**: 17 workspaces / **252 files / 2,920 tests** (`pnpm -r test`, exit 0, zero failure summaries) plus the root `tools/` suite / **31 files / 784 tests**, so **283 files / 3,704 tests, 3,701 passing** (re-measured 2026-08-05). `pnpm verify:merge` was RUN end to end (audit §298): **24 gates — 17 PASS, 5 BLOCKED, 2 FAIL**; the five BLOCKED are named private inputs and the two FAIL are `REQ-289` alone, so the aggregate is **NOT PROMOTABLE**. *(Was 2026-08-02 at `3e1f31d`: 2,877 + 703 = 3,580.)* *The previous figure ("18 test projects, 258 files / 3,243 tests") is left visible because it shows the decay: it was ~337 short of the tree it described. Note `pnpm test` is `test:tools && pnpm -r test` — the `&&` short-circuits, so a tools failure means the workspaces never ran at all (audit §52). Today three tools tests fail, on the GTM workstream's uncommitted `REQ-289` alone.* |
| 2 | Staging certified | Partly — two of five workers deployed; the POD→invoice→email chain proven on live infra |
| 3 | Pilot holds | Blocked — no tenant-0 config pack, no vendored fixtures, no counsel sign-off, no field runs |
| 4 | Production holds | ~~**Declared, not provisioned, not deployable** — every `[env.prod]` id is an all-zero placeholder~~ **Superseded 2026-08-01 (audit D2): provisioned 2026-07-30, five workers + three surfaces deployed, preflight PASS 72 checks (2026-07-31).** The REAL prod holds now: no tenant onboarded · outbound email dark (`EVIDENCE_FROM` unbound, REQ-159) · five private-fixture gates BLOCKED · demo tile host (REQ-075) · nightly backup credentials unbound |
| 5 | V2 planned | Approved and specified; **not built** |

---

### 1. Repository green

All sixteen WPs are merged to `main` and closed (`docs/wp/WP-01.md` … `WP-16.md`; the WP-16 launch-gate
audit swarm is `docs/audits/2026-07-22-wp16-launch-gate-audit.md`, zero open Criticals).
`pnpm check:traceability` reports no orphans in either direction across the sixteen active WPs.

**Gates run on 2026-07-27 at HEAD `7c1a0b4`.** Each verdict below is a command that was executed, not an
estimate.

| Gate | Command | Verdict |
|---|---|---|
| Runtime contract | `pnpm check:runtime` | PASS (Node 22.15.0 / pnpm 11 pinned) |
| Typecheck | `pnpm -r --workspace-concurrency=2 --if-present run typecheck` | PASS |
| Lint | `pnpm lint` | PASS |
| Schema invariants | `pnpm check:invariants` | PASS |
| Rater purity (REQ-024) | `pnpm check:rater-purity` | PASS |
| Authority coverage | `pnpm check:authority-coverage` | PASS |
| Traceability (REQ orphans) | `pnpm check:traceability` | PASS — no orphans, 16 active WPs |
| Register coverage | `pnpm check:coverage` | PASS — 288/288 rows classified, 0 unaccounted |
| Seed | `pnpm check:seed` | PASS |
| Design audit | `pnpm audit:design` | PASS — "design audit: clean" |
| Dependency audit | `pnpm audit --prod` | No known vulnerabilities |

**Re-run at the branch tip `79ae54d` on 2026-07-27, verdicts identical** — every row above except
`pnpm audit --prod`, plus `pnpm test:tools` (18 files / 410 tests), all four browser gates (4 / 6 / 5 / 1)
and both preflights (staging 12, prod 26). The commands and their printed verdicts are in
[`RELEASE-EVIDENCE.md`](./RELEASE-EVIDENCE.md) § *Tip verdict*. ~~The six `workerd` suites remain unrunnable
there too, so nothing below about the ledger or the Workers gained evidence.~~

**Superseded 2026-07-28 at HEAD `3fc592b` — the six `workerd` suites are runnable and were run.** A reboot
cleared the wedge, and `pnpm verify:merge` was executed end-to-end for the first time on this branch. It
aggregates all of the above plus `unit-tests` and `acceptance`, and its record is the authority now:
**16 gates PASS, 5 BLOCKED, aggregate BLOCKED (exit 2) — NOT PROMOTABLE.** PASS: runtime, typecheck, lint,
`unit-tests`, invariants, rater-purity, authority-coverage, traceability, coverage, seed, `acceptance`,
design-audit, perf (1), visual (5), a11y (4), e2e (6). BLOCKED: the same five private-input gates tabled
below. The record is written to `artifacts/release/<sha>/merge/` and is **gitignored by design** — the
repository holds the contract, the run holds the output ([`RELEASE-EVIDENCE.md`](./RELEASE-EVIDENCE.md)
rule 3), so retrieve it from the run, never from the tree. The full post-reboot sweep, with the artifact
path and every verdict, is [`RELEASE-EVIDENCE.md`](./RELEASE-EVIDENCE.md) § *Post-reboot sweep*.

**Register:** 288 rows, 100% classified, 0 unaccounted. ~~Eight rows remain status-drifted — code shipped but
the register tag still reads `*-DISCOVERED`/`vNEXT`: REQ-045, 170, 184, 249, 276, 284, 285, 288. Seven of
the eight cannot be advanced by a status edit alone~~ **Corrected 2026-07-28 (`pnpm check:coverage`, run at
HEAD `3fc592b`): seven rows remain status-drifted — REQ-170, 184, 249, 276, 284, 285, 288.** REQ-045 was
the eighth and was fixed at commit `13161e9`. Six of the seven cannot be advanced by a status edit alone:
their `wp` column names no active WP, so advancing
them routes the row to `unclassified` and fails `check:coverage`. They need a `wp` reassignment in the same
amendment. REQ-170 is the exception and is different: a genuine unbuilt residual, deliberately left open.

#### Unit tests

`pnpm test` runs 18 workspace projects. **All eighteen ran on 2026-07-28 at HEAD `3fc592b`: 258 files /
3,243 tests, zero failures.** The two that carry the ledger and the API were also run on their own, and
`workers/api` three consecutive times — the disposition the `anchors/run` fix required, since the defect it
closed failed roughly four runs in five.

| Suite | Command | Files | Tests | Verdict |
|---|---|---:|---:|---|
| every workspace + tools | `pnpm test` | 258 | 3,243 | **PASS** |
| `packages/ledger` | `pnpm -F @shuddl/ledger test` | 34 | 598 | **PASS** |
| `workers/api` | `pnpm -F @shuddl/api test` | 65 | 719 | **PASS — three consecutive runs** |

`pnpm test:acceptance` — the five acceptance demos' in-repo causal-chain spine — is **GREEN: all 7 spine
tests pass.** Four of the five spine files live in `workers/api` / `workers/mcp`, which is why it shared the
`workerd` hold and is why it is worth stating separately now that it does not.

~~**Twelve were measured on 2026-07-27; six could not run.** Measured: 1,470 tests across 116 files.~~
**Superseded 2026-07-28.** The 2026-07-27 per-project counts are kept below as history — they are a strict
subset of the 258 / 3,243 above and **must not be quoted as a total**. Quoting them as one is the exact
failure this file was re-baselined to fix.

| Project (measured 2026-07-27, history) | Files | Tests |
|---|---:|---:|
| tools (`pnpm test:tools`) | 18 | 410 |
| `packages/contracts` | 14 | 273 |
| `packages/agents` | 10 | 217 |
| `packages/rater` | 12 | 154 |
| `apps/command` | 17 | 95 |
| `packages/map` | 10 | 83 |
| `apps/portal` | 13 | 80 |
| `apps/driver` | 8 | 41 |
| `packages/adapters` | 3 | 38 |
| `packages/driver-core` | 4 | 37 |
| `packages/edi` | 5 | 33 |
| `packages/design` | 2 | 9 |
| **2026-07-27 subtotal (history — NOT the total)** | **116** | **1,470** |

~~**Not measured on 2026-07-27:** `packages/ledger`, `workers/api`, `workers/agents`, `workers/billing`,
`workers/mcp`, `workers/translator`. All six run on `vitest-pool-workers`, and the local `workerd` runtime
was wedged for the whole session — `workerd --version` itself never returned, and the count of `workerd`
processes orphaned in uninterruptible-exit (`UE`, parent PID 1) went from 118 to 124 as each new attempt
added one. This is a machine condition, not a suite failure and not load: it reproduced at load average 4,
and no other process on the machine was in a stuck state. **Re-run `pnpm test` on a clean boot and replace
this paragraph with the real totals** — do not carry a figure forward from an earlier session, which is
exactly how the previous baseline came to cite a three-week-old count.~~

**Measured 2026-07-28 at HEAD `3fc592b` — the instruction above was followed and this paragraph is its
replacement.** The machine was rebooted; `workerd --version` returns `workerd 2025-10-11` immediately and
`ps -eo stat,command | grep '[w]orkerd' | grep -c '^UE'` returns 0. All six `vitest-pool-workers` suites —
`packages/ledger`, `workers/api`, `workers/agents`, `workers/billing`, `workers/mcp`, `workers/translator`
— now run, and the totals in the table above are the real ones. The wedge itself was a machine condition,
not a suite failure and not load; it **recurs**, so its diagnostic is kept under *Environment gotchas*.

Two consequences of the same condition, both now discharged:

- ~~`pnpm test:acceptance` (the five acceptance demos' in-repo causal-chain spine) could not run either — it
  executes each spine test in its own package's config, and four of the five live in `workers/api` and
  `workers/mcp`.~~ **Ran 2026-07-28: GREEN, all 7 spine tests pass.**
- The intermittent `POST /v1/anchors/run` backfill failure that `docs/ops/GO-LIVE-CHECKLIST.md` records as
  a repository-owned failure was addressed on this branch (commits `1aa0db5`…`6e33e89`: a per-day
  exception is now contained to that day and recorded durably instead of sinking the whole backfill).
  ~~That fix is **not re-verified here**, because `workers/api` is one of the six suites that did not run.~~
  **Re-verified 2026-07-28: `packages/ledger` 598/598 and `workers/api` 719/719, the latter three
  consecutive times against a defect that used to fail roughly four runs in five.** The checklist row is
  now plain `FIXED`; its dagger — the marker for "not verified in this environment" — is gone, and no row
  in that file carries one.

#### Gates that BLOCK, and why that is correct

`pnpm verify:merge` aggregates whatever `gatesFor("merge")` returns (`tools/release/run-gate.ts`) — **read the
list, do not trust a count written here.** As of 2026-08-02 it is **24**: fifteen plain (most of the table
above, plus `unit-tests` and `test:acceptance` — note `pnpm audit --prod` is not among them) and nine
"skippable" ones that receive `--mode merge` so they BLOCK rather than skip. *This sentence said "21 gates:
twelve plain" and was correct when written; the audit loop added three (`citations`, `table-shape`,
`append-chokepoint`) and the figure decayed silently. Audit §58 hit the identical drift in the audit's own
phase gate and §64 gives the rule — a hand-maintained count of a list the build owns will always rot.* Four of those nine are the browser gates, and they pass.
The other five cannot, and should not: each returns `BLOCKED` (exit 2 — not a pass and not a failure)
because a named private input is absent. Under the plain local script they loud-skip to exit 0. Both
behaviours were verified individually on 2026-07-27; ~~the aggregate `verify:merge` itself was not run,
because its `unit-tests` gate needs the wedged `workerd`.~~ **and the aggregate was run on 2026-07-28 at
HEAD `3fc592b`: `unit-tests` and `acceptance` both PASS, and these five are the only non-PASS rows in the
record — 16 PASS, 5 BLOCKED, exit 2, NOT PROMOTABLE.** Vendoring the nine fixtures and binding the denylist
is therefore the whole remaining distance between this build and a promotable merge record; nothing else in
the merge profile is red.

| Gate | `--mode merge` verdict | Blocked on |
|---|---|---|
| `check:identity` | BLOCKED | No `IDENTITY_DENYLIST` secret / `.identity-denylist.local`. Fails closed in CI via `REQUIRE_DENYLIST`; the skip is local-dev only (REQ-167) |
| `check:fixtures` | BLOCKED | 9 of 15 manifest fixtures not vendored |
| `check:rater-parity` | BLOCKED | `rater-48-tests`, `rater-504-sweep`, `zone-tariff-v1` absent |
| `check:invoice-parity` | BLOCKED | `invoice-500-replay` absent |
| `check:concierge-parity` | BLOCKED | `concierge-parse-50` absent |

In every case the BLOCKED verdict is an absent input, not a code defect — the fixtures are
engagement-workspace artifacts that never enter this repo (REQ-167). It is still a real hold: under the
merge profile a BLOCKED gate makes the candidate NOT PROMOTABLE, and each one additionally blocks its
**WP DoD claim**. `zone-tariff-v1` is the keystone — it gates WP-04, WP-06 and WP-07 simultaneously.
Vendoring the nine fixtures clears the last four rows; `check:identity` is independent and needs the
denylist secret.

#### Browser and performance gates

All four run and pass under `--mode merge`, measured 2026-07-27:

| Gate | Command | Verdict |
|---|---|---|
| Accessibility | `pnpm test:a11y -- --mode merge` | PASS — 4 assertions |
| End-to-end | `pnpm test:e2e -- --mode merge` | PASS — 6 assertions |
| Visual (blessed screens) | `pnpm test:visual -- --mode merge` | PASS — 5 assertions |
| Map performance | `pnpm perf:map -- --mode merge` | PASS — 1 assertion |

These were installed and made blocking during the T14/T15 remediation. Before that the harness self-skipped
to exit 0, so a visual suite that could never pass reported green — three ready-selectors had rotted and
`command.png` had been capturing five NETWORK REQUEST FAILED panels, because its ready selector waited for
a `canvas` that the failure state also has. The five blessed screenshots were each opened and reviewed.
Map board main-thread occupancy was measured 58.6% → 20.3% (CDP `Performance.getMetrics` `TaskDuration`,
5s steady-state window, 1,000 entities, 3 repeats; recorded in `docs/ops/slo.md`).

---

### 2. Staging — what is certified, and what is only declared

**Deployed and proven** (`docs/ops/DEPLOYMENT.md`):

- `shuddl-api-staging` (HTTPS + the `ShipmentSequencer` DO) and `shuddl-agents-staging` (queue consumer +
  cron). D1 ×3 with real ids (tenant-a, tenant-b, control), KV idempotency, R2 evidence, Queue + DLQ.
- The staging smoke (`pnpm smoke:staging`) seeds a synthetic shipment, drives the gated driver flow over
  HTTPS through `pod.signed`, waits for the real Queue to trigger the Biller, and asserts an
  `invoice.issued` landed in the real tenant-a D1 penny-exact. First green run: invoice 55,800¢.
- Evidence email genuinely sends (see the safety posture above).

**Declared but not proven:**

- ~~**Three of the five workers are not deployed.** `billing`, `mcp` and `translator` declare `[env.staging]`
  scopes; no staging deploy of them is recorded. The whole MCP surface (acceptance demo #4) is therefore
  un-deployed.~~ **Superseded 2026-08-01 (audit): in PRODUCTION all five workers are deployed —
  `mcp.shuddl.tech` and `billing.shuddl.tech` answer 200 (`RELEASE-EVIDENCE.md` § *Production preflight*),
  so the MCP surface exists in prod.** The *staging* scopes of billing/mcp/translator remain undeployed as
  written — the struck sentence was wrong only in reading a staging fact as the whole world.
- `pnpm preflight -- --env staging` returns **BLOCKED — 8 unsatisfied prerequisites** (was 12 when measured
  2026-07-27 at `79ae54d`; **note 2026-08-01:** staging was then provisioned and routed on 2026-07-31
  (commit `b961dfc`) — the three staging D1 placeholder ids below became real; only the mcp `GRANTS` KV
  placeholder remains. **Re-run 2026-08-05 at `2a8a107`** — the trigger this row carried, finally pulled:
  **BLOCKED — 8 unsatisfied**, and the delta from 12 is exactly the four provisioned D1 ids): now
  **1** `placeholder-resource-id`, 4 `missing-secret`, 1 `no-origins`, 1 `tsa-unconfigured`, 1 `no-backup`.
  **7 of those 8 are account-side facts the run cannot see** without `--state`; exactly **1 is
  repo-visible**. The drop was mutation-checked rather than believed — planting an all-zero staging D1 id
  takes the count to 2 and restoring returns it to 1, so the detector did not go blind (audit §291).
  **New trigger:** this dies when `shuddl-mcp-staging.GRANTS` is provisioned, or any staging id changes. ~~(`PLATFORM_TENANT_DB`, `TENANT_POOL_01_DB`, `TENANT_POOL_02_DB`
  are all-zero UUIDs; the mcp `GRANTS` KV id is not 32-hex)~~ **Corrected 2026-07-27 — that listed four
  of the five.** All five, verbatim from the gate: `shuddl-api-staging.PLATFORM_TENANT_DB`,
  `shuddl-api-staging.TENANT_POOL_01_DB`, `shuddl-api-staging.TENANT_POOL_02_DB` and
  **`shuddl-billing-staging.PLATFORM_TENANT_DB`** are all-zero UUIDs; `shuddl-mcp-staging.GRANTS` is not
  a 32-hex KV id. Billing's binding addresses the *same logical* database as the api's
  (`shuddl-t-platform-staging`), so one provisioned id fills both — but it must be pasted into both
  `wrangler.toml`s, and a provisioner working from the old four-item list leaves a worker pointed at a
  database that does not exist.
- Read that carefully: **without `--state`, account-side facts are UNPROVEN, and unproven is BLOCKED.**
  `JWT_SECRET` and `RESEND_API_KEY` *are* bound on staging — that is how sending works — but the checker
  cannot see them from the repo and correctly refuses to assume. The five placeholder ids, by contrast, are
  real repo-visible defects. Supply `--state` to separate the two.
- ~~No backup of staging exists. The nightly snapshot workflow is a stub, `CLOUDFLARE_API_TOKEN` /
  `CLOUDFLARE_ACCOUNT_ID` are unbound, and the restore drill has never been run.~~ **Superseded
  2026-07-31 — see §6 below.** A real staging backup was taken and a full restore drill run and
  reconciled. The nightly workflow's credentials remain unbound; that half stands.

In V2 release-grade terms (`docs/ops/V2-EXECUTION-FRAMEWORK.md` §9), staging has **not** reached R2.

---

### 3. Pilot holds — what blocks a first real tenant

- **Tenant-0 config pack** — the 171 legacy column headers and field mapping, pro-number ranges and
  continuity (REQ-058), and the flip/close calendar dates (REQ-153) live in the engagement workspace,
  outside this repo, and are unbuilt. The in-repo side is generic and config-driven.
- **Nine of fifteen fixtures unvendored**, including `zone-tariff-v1` (above), `legacy-export-replay`
  (whose original export path is itself an open `[CONFIRM]`), and `concierge-parse-50`.
- **Live legacy-TMS mirror feed** not provisioned — `NotConfiguredFeedReader` no-ops, so the whole overlay
  mirror is dark. Phase-0 exit needs a 3-day unattended run (REQ-152).
- **Counsel deliverables**, all CONFIRM-gated: ToS/Privacy/DPA for PLG signup (REQ-138), photo/PII
  retention policy and consignee notice (REQ-140, CONFIRM-2), e-signature validity per mode and the driver
  location-consent text (REQ-142/166).
- **Driver login and lockout are unbuilt** (REQ-069) — a per-device P-256 key exists, but there is no
  magic-link/PIN login and no lockout counter.
- **Ratecon generation is unbuilt** (REQ-184/043) — nothing writes a `documents` row of kind `ratecon`, so
  the dispatch gate cannot pass without a REQ-049 override. Correctly fail-closed, but there is no real
  dispatch until it is built.
- **Field evidence not collected** — a real driver completing a gated stop unassisted on real hardware
  (REQ-164/006), outdoor readability, and the battery/data budget are all pilot measurements.
- **On-call rota has no named human**, so none of the `docs/ops/slo.md` alerts has a recipient. The restore
  drill log is empty.
- **The five acceptance demos are two-tier** (`docs/wp/acceptance-demos.md`). The in-repo causal-chain
  spine is built for all five; the filmed tenant-0 half — wall-clock latency, a real stranger, a real
  driver, a real Claude-via-MCP booking, the live visual world-dim — are launch-gate calendar objects on
  real freight. **A merge cannot close them.**
- **M-H heartbeat** gates all GTM (REQ-159). It is a milestone decision, never a code flag.

---

### 4. Production holds — ~~declared, not provisioned, not deployable~~ PROVISIONED + DEPLOYED (superseded 2026-08-01)

> **SUPERSEDED 2026-08-01 (audit D2). Everything measured below was true on 2026-07-27 and is kept as
> history; none of it describes HEAD.** On 2026-07-30 `provision:prod --apply` created the resources
> (6 D1, 2 KV, 1 R2 — 19 real ids across the five configs), the four secrets were bound, and on
> 2026-07-31 `preflight --env prod --state <operator file>` returned **PASS, 72 checks**; all five
> workers and the three browser surfaces are deployed and answering
> (`RELEASE-EVIDENCE.md` § *Production preflight — PASS, 2026-07-31*). The bullets under "Also unproven
> for prod" below remain the REAL open prod holds (sender warmup, OIDC/nightly credentials, edge rate
> limits, PLG dark, pen-test's deploy-dependent rows), joined by: no tenant onboarded, outbound email
> dark (REQ-159), the demo tile host (REQ-075), and the five private-fixture merge holds.

All five workers now declare a **structurally complete** `[env.prod]` scope, and merge-time parity
(`tools/deploy/wrangler-scope-parity.test.ts`) keeps them that way. ~~That is a shape guarantee and nothing
more: **every id in `[env.prod]` is an all-zero placeholder.** None of the resources exist.
`wrangler deploy --env prod` would ship workers that crash on the first request that dereferences a
binding.~~ *(struck 2026-08-01 — the ids are real and the workers are deployed; see the banner above)*

`pnpm preflight -- --env prod` returns ~~**BLOCKED — 26 unsatisfied prerequisites**~~ *(historical)*, measured 2026-07-27:

| Code | Count | Detail |
|---|---:|---|
| `placeholder-resource-id` | 19 | ~~Every prod D1 `database_id` is an all-zero UUID; the mcp `GRANTS` KV id is not 32-hex~~ **Corrected 2026-07-27 (re-measured at `79ae54d`): the 19 are 17 D1 + 2 KV.** The 17 D1 are every prod `database_id` — api ×6 (`TENANT_A`, `TENANT_B`, `CONTROL`, `PLATFORM_TENANT`, `TENANT_POOL_01`, `TENANT_POOL_02`), agents ×3, billing ×4, mcp ×1, translator ×3 — all all-zero UUIDs. The 2 KV are `shuddl-mcp-prod.GRANTS` **and `shuddl-api-prod.IDEMPOTENCY`**, neither a 32-hex id. The api `IDEMPOTENCY` namespace appeared in no document before this correction: a provisioner working the old wording creates every D1 and one KV, and ships an api worker whose idempotency store does not exist |
| `missing-secret` | 4 | `JWT_SECRET`, `RESEND_API_KEY`, `STRIPE_WEBHOOK_SECRET`, `PLATFORM_INTERNAL_SECRET` |
| `no-origins` | 1 | No CORS allowlist; `portal.example` / `status.example` placeholders remain in `cors.ts` |
| `tsa-unconfigured` | 1 | No RFC-3161 timestamp authority — a day is left UNANCHORED, never faked |
| `no-backup` | 1 | No backup manifest exists for the environment |

Also unproven for prod, beyond the preflight:

- **Sender identity** — the prod sending domain is not verified, the apex-vs-subdomain divergence
  (`shuddl.tech` vs `send.shuddl.tech`) is unresolved, and the two-week deliverability warmup (REQ-157) has
  not been run.
- **Cloudflare OIDC (F1-A)** is not configured, so there is no CI deploy path and no nightly snapshot.
- **Per-IP edge rate limits** on `/pub/*` (REQ-193) and `/pub/signup` (REQ-125) are not provisioned. These
  are deliberately edge rules, not in-Worker gates.
- **PLG is DARK end to end** — `PROVISIONING_ENABLED` off (`/pub/signup` 404s), Stripe keys unbound,
  `PLATFORM_INTERNAL_SECRET` unbound (credit route 503s).
- **Pen-test** (`docs/security/pen-test-basics.md`) reports clean for the **in-repo perimeter only**; its
  deploy-dependent items are exactly the rows above.

**Do not describe this build as "ready to launch."** ~~It is ready to be provisioned. Provisioning is an
external hold with a named owner in `docs/ops/GO-LIVE-CHECKLIST.md`.~~ *(2026-08-01: provisioning
happened — the sentence that stands is the first one. Launch still waits on a tenant, the sending flip,
the fixtures, and the ledgered holds.)*

> A note for whoever provisions these: fill the ids with real values or leave them all-zero. Never fill
> them with something that merely *looks* real. The preflight's placeholder check is shape-based, so a
> plausible UUID reads as provisioned and the gate goes quiet about a resource that does not exist. KV
> placeholders are deliberately non-hex for this reason.

---

### 5. V2 — planned, not built

The V2 framework is approved and specified in [`docs/ops/V2-EXECUTION-FRAMEWORK.md`](./V2-EXECUTION-FRAMEWORK.md),
with authority in register rows **REQ-214 through REQ-288**. It covers tenant-0 internal operations:
structured facilities and authoritative geocoding, AI-assisted quote-to-book, conversational pricing
configuration, backhaul detection and marginal pricing, co-load and dispatch proposals, real driver
synchronisation, live server-scoped views, and a durable proposal/approval lifecycle.

**No REQ-214…288 behaviour is built.** The framework document says so itself, and the phase gates enforce
it: P0 cannot open until V1 has an R2 (staging-certified) PASS record for an exact SHA, and no V2 feature
receives read or write authority before that. The R5 shadow period is at least 30 consecutive calendar days
and is noncompressible.

---

## Environment gotchas

- **iCloud duplicates.** The repo sits on an iCloud-synced Desktop, which periodically spawns `name 2.ext`
  copies that can corrupt file-count gates (a duplicate migration breaks the invariant check). Before
  `pnpm verify`, run `find . -name "* 2.*" -not -path "*/node_modules/*" -not -path "./.git/*"`; verify each
  hit is a byte-copy of its original and delete it (`.gitignore` blocks committing them). Note the nested
  `node_modules` exclusion — copies also accumulate in the per-package vite caches, where they are harmless
  to the gates but will confuse a plain `find`. The durable fix is moving the repo off `~/Desktop`.
- **Wedged `workerd`.** The `vitest-pool-workers` suites can leave `workerd` processes orphaned in
  uninterruptible-exit (`UE`, parent PID 1) — typically after a run is interrupted. Once enough accumulate,
  *every* new `workerd` wedges too, including a bare `workerd --version`, and all six workerd-pool suites
  hang at "Starting isolated runtimes" indefinitely. Diagnose with
  `ps -eo stat,command | grep '[w]orkerd' | grep -c '^UE'`; a non-trivial count with no live `workerd` is
  the signature. On 2026-07-27 they could not be killed (`kill -9` does not apply to `UE`) and did not
  clear over roughly two hours of observation — the count only grew. ~~A reboot is the expected remedy; that
  was not tested.~~ **A reboot is the remedy, and on 2026-07-28 it was tested and it worked**: after the
  reboot `workerd --version` returned `workerd 2025-10-11` instantly, the `UE` count was **0**, and all six
  suites, `pnpm test`, `pnpm test:acceptance` and `pnpm verify:merge` ran. **Keep this entry — the condition
  recurs**, it costs a whole session when it is misread, and nothing in this repository can clear it.
  **Do not mistake this for a suite failure, and never report a suite that did not run as
  one that passed.**
- **Machine load.** Separately from the above, at load average >12 vitest fork workers time out and a suite
  reports `Test Files no tests` with `Failed to start forks worker`. Check `uptime`, wait for load under
  ~8, re-run. Wait — do not reinstall and do not "fix" anything.
- **Node is pinned.** Node 22.15.0 + pnpm 11 only (`.node-version`, `engines`, `packageManager`). Node 20
  mis-resolves the `vitest-pool-workers`/chai chain and changes D1 append-only trigger behaviour, so a
  green run under Node 20 is not evidence the build is sound. `pnpm check:runtime` fails closed on
  mismatch.

---

## 6. 2026-07-31 — the surfaces went live, and the DR gate was made able to run

This section supersedes anything above it that it contradicts. It is dated because the two facts most
likely to be misread later are *what changed* and *what still has not*.

### What is now true

- **All three browser surfaces are deployed and serving.** `command`, `portal` and `driver.shuddl.tech`,
  plus `track.shuddl.tech` on the portal worker — assets-only Workers on Cloudflare custom domains,
  following the account's existing static-site pattern rather than a second one. Before this, the backend
  had been live for days with no UI at all: no DNS, no wrangler config, no deploy script.
  `track` is **not** a fourth surface — it is a route inside the portal bundle, which is what keeps the
  surface count at three.
- **The prod API base is baked in and gated.** `pnpm check:surfaces -- --built` refuses a bundle that
  lacks it, ahead of `wrangler` in `deploy:surfaces`. Proven both directions before the deploy, then
  re-verified against the live bundles over the wire.
- **`tests/e2e/prod-surface.spec.ts` watches the deployed pages** — a FIELD gate, self-skipping unless
  `PROD_SURFACE_BASE` is set, and routed through `playwright-guard` like every other browser gate, so an
  all-skipped run reports BLOCKED rather than a green exit 0. Five tests, green, and each begins by proving
  the BUNDLE RAN — command, portal, track and driver all assert on their real rendered unauthenticated
  screen, so an `index.html` whose script tag dangles fails all five. On top of that: command proves it
  reached `api.shuddl.tech` and got a 401, track proves it reached `/pub/`, and the driver — which with no
  token issues no request at all, so no traffic can carry the signal — has its API base read out of the
  module bytes the edge is serving (`api.shuddl.tech` present, the synthetic `.example` default absent).
  Portal makes no unauthenticated call, so it is held only to what it renders.
- **The DR restore gate can execute at all.** `tools/deploy/snapshot-ledger.ts` writes the `LedgerSnapshot`
  pair that `restore-verify` reads. Nothing had ever written one, so the gate was not failing — it was
  structurally unable to run, on any environment, in any account. A real drill then ran on staging
  tenant-a: PASS, 11 checks. Two defects it surfaced are fixed (`verifyChainOfRows` walked all streams as
  one chain; `provision-prod` created nine resources before it refused).
- **`deploy-preflight` can report PASS.** `run-gate` invokes the preflight with `--mode` only, and the
  preflight read its state file from `--state` alone, so the release profile could never see a satisfied
  account fact. `PREFLIGHT_STATE` closes it.

### What is still NOT true — read this before claiming the product works

- **Nobody can sign in.** Prod's control plane holds exactly three tenants — `_platform`, `_pool_01`,
  `_pool_02` — all system rows from migration seeds. The `users` table is **empty**. The only endpoint that
  mints a session is `POST /pub/signup`, and it is dark (`PROVISIONING_ENABLED` is bound nowhere, so the
  route 404s). There is no magic-link endpoint. Every surface therefore renders its unauthenticated state,
  which is correct behaviour and is exactly what the field gate asserts — but a deployed surface is not an
  onboarded tenant, and the gap between those two is the whole remaining product.
- **No real tenant is onboarded.** That needs the tenant-0 config pack from the engagement workspace.
- **Outbound email is dark in prod** (`EVIDENCE_FROM` unbound ⇒ `NotConfiguredSender`).
- **The production tile source is still a public third-party demo host** (REQ-075).
- **Five release gates still BLOCK on absent private fixtures** and the identity denylist.
- **The nightly backup workflow's credentials are still unbound.** The drill was run by hand.
- **`run-gate` still passes `restore:verify` no snapshots**, so that gate stays BLOCKED in the release
  profile even though the drill it represents has now genuinely been run.
