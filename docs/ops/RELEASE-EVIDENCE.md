# Release evidence — the contract

**Document baseline: 2026-08-05 at `7d0710c`.** Individual rows carry their own `measured at <sha>` stamps, which may predate this and are not stale for doing so — a measurement is true of the commit it names (audit §330). This file previously carried **no currency claim at all**, which is a poor look for the document that defines when evidence stops being true (audit §332).

Every claim a release makes, the gate that proves it, the artifact that survives the claim, and what
makes that artifact stop being true.

This document exists so that "release evidence" is not whatever the last person remembered to run. It
describes the machinery as it is in `tools/release/`, `tools/checks/`, `tools/deploy/`,
`tools/harness/` and `.github/workflows/` — not what would be nice. Where a gate produces only a
stdout verdict and no file, this says so.

Scope: REQ-288 (promotion consumes only complete evidence records), REQ-118/REQ-119 (traceability and
the audit swarm at every exit). The related operational documents are
[`PROJECT-STATE.md`](./PROJECT-STATE.md) for what is proven today,
[`DEPLOYMENT.md`](./DEPLOYMENT.md) for the runbook, [`dr-backups.md`](./dr-backups.md) for backup
policy, and `GO-LIVE-CHECKLIST.md` for the operator line-items.

**Before you edit this file — it is excluded from the annotation scan (added 2026-07-27).** This
document *records state*: nearly every row describes a gate for a requirement that is BLOCKED, unbuilt,
or waiting on an absent input. That is the exact sentence shape that once minted a false annotation out
of `PROJECT-STATE.md` — a sentence meaning "this shipped nothing" standing as the evidence that code
shipped. It is therefore on the `scanSourceAnnotations` exclusion list
(`tools/traceability/orphans.ts:42-46`, `:73`) and pinned there both ways by
`tools/traceability/coverage.test.ts` — delete the exclusion and two assertions go red. Two
consequences for an editor: citing a requirement id here is **safe** (it can never fake an
implementation), and it **buys nothing** — every id this file names must also be annotated in real
source, and at the time of the exclusion each of the thirteen appeared in at least four other
non-excluded files. Nor is this file a *recorded home*: `scanRecordedHomes` reads only
`GO-LIVE-CHECKLIST.md` and the coverage manifest (`tools/traceability/coverage.ts:124-125`, `:134-139`), so a
deferral cited only here is still unaccounted.

---

## The three rules

**1. An artifact proves the exact SHA it was produced from. Evidence does not transfer across commits.**

Every record carries `commit`, `environment`, `fixturesHash` and `deployment`
(`tools/release/evidence.ts:36`). `evaluateEvidence` rejects any record whose four binding fields do
not match the promotion context it is evaluated against — exit 3, `MALFORMED`
(`evidence.ts:98`, `:123`). A record produced at `abc1234` says nothing about `def5678`, even if the
diff between them is a comment. There is no partial credit and no "close enough" — rerun the gate.

**2. A gate that cannot run returns BLOCKED, and BLOCKED is never promoted to PASS.**

`unavailableStatus` (`evidence.ts:148`) is the single disposition rule: a missing external
prerequisite — no browser, no denylist, unvendored private fixtures, no account credentials — is a
developer-convenience `PENDING` (exit 0) under `--mode local`, and a non-negotiable `BLOCKED`
(exit 2) under `--mode merge` or `--mode release`. `evaluateEvidence` treats `BLOCKED` and `PENDING`
identically: neither promotes (`evidence.ts:130`). A `PASS` is additionally required to carry
`executed: true` and `assertions > 0`, so a skip cannot wear a green coat (`evidence.ts:70`).

**3. Generated evidence under `artifacts/release/<sha>/` is never committed.**

The repository holds the contract; the run holds the output. `artifacts/` is gitignored
(`.gitignore:26`), as are the other regenerated artifacts (`seed/SEED-1.json`,
`tools/design/report.json`, `test-results/`, `playwright-report/`, the visual diff/actual PNGs). CI
uploads `artifacts/release/**` as the `merge-evidence` workflow artifact, with `if: always()` so a
failing run still leaves its record (`.github/workflows/ci.yml:53`). Retrieve it from the run; do not
add it to the tree.

---

## The record

`pnpm verify:merge` / `pnpm verify:release` (`tools/release/run-gate.ts`) run the gates, collect one
structured `GateResult` per gate, and write a single file:

```text
artifacts/release/<commit>/<environment>/gate-<profile>-<generatedAt>.json
```

`<environment>` is `merge` for the merge profile, and `RELEASE_ENVIRONMENT` (default `staging`) for
the release profile. `<generatedAt>` is the ISO timestamp with `:` and `.` replaced by `-`. The file
contains `{ record, evaluation }` — the full gate list plus the aggregate verdict (`run-gate.ts:147`).

**Record TTL:** merge records expire 24h after generation, release records 72h (`run-gate.ts:127`).
An expired record is `MALFORMED`, not stale-but-usable (`evidence.ts:119`). The TTL is a ceiling, not
a grant — rule 1 already voids the record at the next commit, long before the clock runs out.

**Exit codes** (stable; promotion tooling depends on them — `evidence.ts:11`):

| Code | Meaning |
|---|---|
| 0 | `OK` — every gate executed with assertions and passed |
| 1 | `ASSERTIONS_FAILED` — an executed assertion set failed |
| 2 | `PREREQ_BLOCKED` — a prerequisite is BLOCKED/PENDING. **Not a green and not a failure** |
| 3 | `MALFORMED` — malformed, stale, or mismatched evidence |

Precedence: malformed/stale/mismatched (3) → executed failure (1) → blocked prerequisite (2) → OK. A
real failure outranks a blocked prerequisite: a broken build is worse than an absent one
(`evidence.ts:107`).

**How a verdict is obtained.** A gate either prints a `##SHUDDL-GATE##` sentinel line carrying its own
structured result — which `run-gate` parses, last one wins — or it does not, in which case `run-gate`
**synthesizes** a result from the exit code alone (`run-gate.ts:84`, `:98`). This matters when reading
a record: a synthesized `PASS` always reads `assertions: 1, detail: "command exited 0"` no matter how
many tests ran. The assertion counts in a record are only meaningful for the sentinel-emitting gates.
The Artifact column below distinguishes the two.

---

## The claims

Profile: **M** runs under `--profile merge`, **R** adds under `--profile release`, **F** is a *field*
claim — it needs credentials or an environment this repository does not contain, and cannot be
satisfied by a checkout alone.

Unless a row names its own file, the artifact is the gate's `GateResult` row inside the record named
above, plus its stdout in the run log. "stdout only" means exactly that: nothing is persisted beyond
the record row and whatever captures the console.

| Claim | Gate / command | Prof | Artifact | Where it lands | Expiry |
|---|---|---|---|---|---|
| The toolchain is the pinned one (Node 22.15.0, pnpm 11.10.0) | `pnpm check:runtime` | M | Synthesized from exit code; stdout only | Record row `runtime` | Any edit to `.node-version` or `package.json` `packageManager`; running on a host with a different toolchain |
| Every workspace typechecks under `strict` | `pnpm typecheck` | M | Synthesized; stdout only | Record row `typecheck` | Any change to a `.ts` source, a `tsconfig`, or an installed type dependency |
| Lint law holds (incl. REQ-024 no-LLM-in-ledger) | `pnpm lint` | M | Synthesized; stdout only | Record row `lint` | Any source change; any ESLint config or plugin-version change |
| Unit + tools suites pass (the root tools suite plus every workspace project) | `pnpm test` (= `test:tools` + `pnpm -r --if-present run test`) | M | Synthesized; stdout only — **the record shows `assertions: 1`, never the real test count** | Record row `unit-tests` | Any commit. Also void if a project could not execute: six suites run on `vitest-pool-workers` and a wedged `workerd` surfaces as FAIL/timeout, not as silence |
| Append-only guards (I1/I3), table budget ≤22 (I8), forward-only migrations, no stray product `.sql` | `pnpm check:invariants` | M | Synthesized; stdout only. Compares against `db/migrations.lock.json` **as committed in git** | Record row `invariants` | Any migration added or edited; any change to `db/migrations.lock.json`; any `INSERT OR REPLACE` / upsert introduced into a scanned `src` tree |
| The rater is pure — no LLM import, class only in the adapter subtree (REQ-004/024) | `pnpm check:rater-purity` | M | Synthesized; stdout only | Record row `rater-purity` | Any change under `packages/rater/src` |
| Every authority-bearing module consults the gate context | `pnpm check:authority-coverage` | M | Synthesized; stdout only | Record row `authority-coverage` | Any change to the enumerated files (`workers/api/src/routes/rate.ts`, `workers/agents/src/biller.ts`, `.../interline-split.ts`, `workers/api/src/do/sequencer.ts`, …) or to the module list itself |
| No orphan REQs in either direction (REQ-118) | `pnpm check:traceability` | M | Synthesized; stdout only | Record row `traceability` | Any append to `genesis/09-REQUIREMENTS-REGISTER.csv`; any added/removed `REQ-` annotation in scanned source or in `docs/ops`, `docs/security`, `docs/wp` |
| Every register row is classified — 100% coverage, 0 unaccounted (REQ-119) | `pnpm check:coverage` | M | Synthesized; stdout only | Record row `coverage` | Any register append or status/`wp` edit. The register is append-only, so this expires more often than the code does |
| SEED-1 reproduces its pinned dataset hash (REQ-155) | `pnpm check:seed` | M | Synthesized; stdout only. Compares against the committed `tools/seed/seed.hash`; the dataset `seed/SEED-1.json` is regenerated and gitignored | Record row `seed` | Any change to the seed generator or to the pinned hash |
| The five doc-00 acceptance demos' in-repo causal spine passes (REQ-119) | `pnpm test:acceptance` | M | Synthesized; stdout only | Record row `acceptance` | Any commit touching a spine test or the code it exercises. Four of the five spine files live in `workers/api` / `workers/mcp`, so it shares the `workerd` dependency above. Proves the **code-provable** half only — the filmed wall-clock half is `docs/wp/acceptance-demos.md` |
| Pixel law: color tokens, `--signal-deep`/`--field` contrast ≥4.5:1 (REQ-149), font, case, radius, shadow, gradient, motion. `design-ci.json` is `mode: blocking` (REQ-158) | `pnpm audit:design` | M | Synthesized; **also writes `{mode, violations}` JSON** | `tools/design/report.json` (gitignored, overwritten each run) + record row `design-audit` | Any change to `packages/design/tokens.css` or to a scanned surface file; any change to `tools/design/design-ci.json` |
| No tenant/person/customer/vendor name anywhere in the tree (REQ-167) | `pnpm check:identity -- --mode merge` | M | `##SHUDDL-GATE##` sentinel with `assertions` = files scanned | Record row `identity-leak` | **Any new or renamed file**, and any change to the denylist — a term added after a scan is unproven by that scan. Needs `IDENTITY_DENYLIST` (CI secret) or `.identity-denylist.local` (gitignored); absent ⇒ BLOCKED |
| The fixture registry is honest: every `vendored` row exists and hashes to its pin | `pnpm check:fixtures -- --mode merge` | M | Sentinel with `assertions` = entries checked | Record row `fixtures` | Any edit to `fixtures/manifest.json` or to vendored fixture bytes — which also changes the record's `fixturesHash`, voiding rule 1's binding. 9 of 15 entries are `pending` today ⇒ BLOCKED |
| Rater parity: the 48 engine tests + 504-quote monotonic sweep against tenant-0 tariff (REQ-027/165) | `pnpm check:rater-parity -- --mode merge` | M | Sentinel | Record row `rater-parity` | Vendoring or revising `rater-48-tests` / `rater-504-sweep` / `zone-tariff-v1`; any change to `packages/rater`. All three fixtures absent today ⇒ BLOCKED |
| Invoice math matches the Rater to the penny on a 500-case replay (REQ-031, WP-06 DoD) | `pnpm check:invoice-parity -- --mode merge` | M | Sentinel | Record row `invoice-parity` | Vendoring or revising `invoice-500-replay` or `fixtures/tariff`; any change to invoice projection. `invoice-500-replay` absent today ⇒ BLOCKED |
| Concierge parse parity: ≥90% parsed, 100% floor-clean sends (WP-07 DoD) | `pnpm check:concierge-parity -- --mode merge` | M | Sentinel. Gate name in the record is **`concierge-parse`**, not `concierge-parity` | Record row `concierge-parse` | Vendoring or revising `concierge-parse-50` or `fixtures/tariff`; any change to the parser or the in-repo synthetic smoke set. `concierge-parse-50` absent today ⇒ BLOCKED |
| Map performance: 1K-entity interaction and long-task budget | `pnpm perf:map -- --mode merge` | M | Sentinel with real Playwright counters. Playwright's JSON report is written to a **temp dir and deleted** (`playwright-guard.ts:151`, `:178`) — the numbers survive only in the record row and the run log | Record row `perf` | Any change to `packages/map` or the board render path. **Also host-dependent**: a timing verdict from one machine/GPU/Playwright version does not carry to another. Long-run occupancy figures are recorded separately in [`slo.md`](./slo.md). No browser ⇒ BLOCKED |
| Five blessed screens match their baselines, motion disabled | `pnpm test:visual -- --mode merge` | M | Sentinel; diff/actual PNGs on failure | Baselines `tests/visual/blessed/*.png` (**committed**); `*-diff.png` / `*-actual.png` gitignored | Any change to a captured surface, to the pinned payloads, or to a ready-selector. Baselines are re-blessed by review, not by regeneration. No browser ⇒ BLOCKED |
| Zero serious/critical axe findings on core flows (REQ-285) | `pnpm test:a11y -- --mode merge` | M | Sentinel with real counters | Record row `a11y` (`--project a11y` → `tests/e2e/accessibility.spec.ts`) | Any markup/ARIA change on a covered flow; any axe-core version change. No browser ⇒ BLOCKED |
| Driver offline→reconnect durability and portal party isolation, in a real browser | `pnpm test:e2e -- --mode merge` | M | Sentinel with real counters | Record row `e2e` (`--project e2e`) | Any change to driver sync, service worker, or portal scoping. No browser ⇒ BLOCKED |
| Every declared binding, secret, origin, sender, TSA and backup obligation is satisfied for the target env | `pnpm preflight -- --mode release [--env <env>] [--state <f.json>]` | R/F | Sentinel with `assertions` = checks run; one `SEVERITY code resource — detail` line per problem. stdout only, no file | Record row `deploy-preflight` | Any `wrangler.toml` edit, **and any account-side change**: a rotated secret, a provisioned resource, an added route. Without `--state`, account-side facts are UNPROVEN and therefore BLOCKED — a `--state` snapshot is a point-in-time claim about the account and expires independently of the SHA |
| A restore reconciles: same event count, same head hash, intact chain, same invoices and money to the penny, same anchor roots (REQ-117/284) | `pnpm restore:verify -- --mode release --source <a.json> --restored <b.json> [--rows <events.json>]` | R/F | Sentinel; stdout only, no file | Record row `restore-verify` | Bound to **that snapshot pair**, not to the live database: writes after `capturedAt` are not covered. Without `--rows` the two chain dimensions are not checked at all — the run reports 9 of 11 and is **BLOCKED, never PASS** (it previously counted all 11 and said PASS, comparing a snapshot's metadata to itself). No snapshots ⇒ BLOCKED |
| A deployed environment survives the real flow: gated driver stop → `pod.signed` → Queue → penny-exact `invoice.issued` | `pnpm smoke:staging -- --mode release` | R/F | Sentinel **and its own evidence record** (72h TTL, single-gate) | `artifacts/release/<commit>/<env>/smoke-<generatedAt>.json` (gitignored) + record row `staging-smoke` | Bound to the **deployed** `DEPLOYMENT_VERSION`: any redeploy voids it. Needs `SMOKE_API_BASE` and a staging JWT secret (`SMOKE_JWT_SECRET` or `SMOKE_JWT_SECRET_FILE`) — either absent ⇒ BLOCKED. If `DEPLOYMENT_VERSION` cannot be resolved the record self-declares `deployment: "unresolved"` and cannot back a promotion |
| Each deployed browser surface loads a bundle that runs, reaches the prod API, and states its no-session state honestly | `pnpm test:surfaces` (release profile gate `surfaces`, added 2026-08-01; `--mode release` is baked into the script) | R/F | Sentinel with real Playwright counters | Record row `surfaces` | Bound to the DEPLOYED bundles: any surface redeploy voids it. Needs `PROD_SURFACE_BASE` naming the zone; absent ⇒ BLOCKED (never a green skip). Hits the public internet — deliberately NOT in the merge profile |
| Every tenant and control D1 is exported with a SHA-256 manifest, retained for the policy window | `.github/workflows/nightly.yml` `backup` job (scheduled 08:00 UTC) | F | `*.sql` exports + `manifest.json` (`version`, `environment`, `commit`, `takenAt`, `retentionDays`, per-file `sha256`, and a manifest `digest`) | `artifacts/backup/` in the run; uploaded as `d1-backup-<run_id>`, `retention-days: 30` | A manifest proves the databases **at `takenAt`** and nothing after — it ages out daily. The upload is deleted at 30 days. `run-gate --profile release` cannot produce one: it is a declared external hold (`run-gate.ts:84`), BLOCKED unless `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` are bound |

Counts: **25** gates under `--profile merge` (**16** plain + 9 skippable), **30** under `--profile release`
(+5 `releaseInfra`) — re-derived from `tools/release/run-gate.ts` on 2026-08-06. *(24/15/29 until 2026-08-06,
audit §483, when the `bundle-ratchet` gate joined `plain` — which both profiles include. This time the count
did NOT rot: `gate-wiring.test.ts` ("profile sizes match the docs that quote them") failed on the first run
after the gate was added and named this line in its message. That is the difference between a number a
document asserts and a number something checks.)* *This line said "21 (12
plain), 26" and had decayed the same way `PROJECT-STATE.md` records for its own copy: three plain gates were
added and every hand-written count of them rotted. **`PROJECT-STATE.md` §"do not trust a count written here"
owns this number; treat any other copy, including this one, as a snapshot.***
(+ `deploy-preflight`, `restore-verify`, `staging-smoke`, `surfaces` — added 2026-08-01, the
deployed-surface proof previously lived only as a manual runbook step — and `backup-manifest`).

**`verify:release` is not wired into any workflow.** `.github/workflows/ci.yml` runs `verify:merge`
only, and `nightly.yml` runs the orphan audit and the backup job. The release profile is operator-run,
by hand, against a real environment — so a release record exists only if someone produced one and said
where it is. Nothing in the repository will produce one on your behalf, and nothing will notice that
none exists.

---

## Claims CI makes that the record does not carry

These run in `.github/workflows/` and are real gates, but they are **not** in `run-gate`'s gate list,
so they produce no `GateResult` and appear nowhere in the evidence record. A green `verify:merge`
record does not prove them; only the workflow run does.

| Claim | Where | Artifact | Expiry |
|---|---|---|---|
| Every workspace builds (`apps` + `workers` + `packages`) | `ci.yml:33` `pnpm -r --if-present build` | Job log; build output not uploaded | Any commit |
| No known production dependency vulnerabilities | `ci.yml:51` `pnpm audit --prod` | Job log | Advisory-database updates — this expires **without any commit at all** |
| No secret anywhere in history | `ci.yml:74` `secrets` job, gitleaks at `fetch-depth: 0` | Job log | Any push; any gitleaks rule update |
| The PR body names its REQ-IDs (REQ-118) | `ci.yml:26` `pnpm check:pr`, pull requests only | Job log | Per PR |
| Register ↔ code orphan diff, nightly | `nightly.yml:19` `orphan-audit` | Job log | Any register append |
| Every GitHub Action is pinned to a 40-hex commit SHA | `tools/release/ci-contract.test.ts:82` (runs inside `test:tools`) | Assertion inside the `unit-tests` gate | Any workflow edit |

`ci-contract.test.ts` is the guard that keeps this table from silently shrinking: it parses
`ci.yml` and fails if a required job disappears or an action is repinned to a mutable tag.

---

## What a green proves, and what it does not

**It proves:** at that exact commit, on that machine, every gate in the profile executed and passed,
and no gate was skipped into silence.

**It does not prove:**

- **That anything is deployed.** The merge profile's `deployment` is the literal string `"n/a"`.
- **That the account is configured.** Only `deploy-preflight` looks at that, only under the release
  profile, and only with `--state`.
- **That the claims in the second table hold** — build, dependency audit, secret scan are outside the
  record.
- ~~**That the binding fields were independently checked.**~~ **SUPERSEDED 2026-08-02 (audit §16, commit
  `10a95f5`) — THEY NOW ARE.** `run-gate` RE-OBSERVES its `PromotionContext` after the gates run
  (`gitHead()`, `fixturesHash()`, and the two env vars read afresh) instead of copying it from the record it
  just wrote, so all four comparisons are live. They also bite BEFORE any promote step exists: a gate run
  spans minutes, so a commit landing or a fixtures-manifest change mid-run now invalidates the record instead
  of being certified by it. Pinned by a source-reading test in `tools/release/run-gate.test.ts` and
  mutation-proved (restoring the copied form fails 3 of its 4 assertions). The paragraph below is the
  historical description and is retained for the reasoning it carries about a future promote step.
- ~~**That the binding fields were independently checked.** `run-gate` constructs its own
  `PromotionContext` from the record it just wrote (`run-gate.ts:143`), so the commit/environment/
  fixtures/deployment comparison is self-satisfied by construction and can never fire there.~~ Those
  checks bite only when a **separate** consumer evaluates a stored record against a context derived
  independently — from the git SHA it is about to promote, the environment it is promoting into, and
  the deployment it observes. **No such consumer exists in this repository today**: `evaluateEvidence`
  is called from `run-gate.ts` and from `evidence.test.ts`, nowhere else. Until a promote step exists,
  rule 1 is enforced by the reader, not by the machine. Anyone writing that step imports
  `evaluateEvidence` and supplies a real context; it must not rebuild the context from the record.

---

## Reading a record

```bash
pnpm verify:merge                       # writes artifacts/release/<sha>/merge/gate-merge-<ts>.json
RELEASE_ENVIRONMENT=staging DEPLOYMENT_VERSION=<v> pnpm verify:release
```

`run-gate` is continue-through: every gate runs even after one fails, so the record is complete rather
than truncated at the first red. The summary block prints one line per gate, the artifact path, and
the aggregate verdict with its blocking reasons.

When triaging a record, in order:

1. **`evaluation.exitCode`** — 3 means the record itself is not trustworthy; fix that before reading
   the gates.
2. **`record.commit` vs the SHA you care about** — if they differ, the record is about a different
   tree. Stop.
3. **`record.expiresAt`** — past, and the record is `MALFORMED` regardless of its gate rows.
4. **Any gate with `executed: false`** — it did not run. Read its `detail`; it names the absent
   prerequisite.
5. **Any `PASS` with `assertions: 1` and `detail: "command exited 0"`** — synthesized from an exit
   code. It means the command succeeded, not that a specific number of assertions held.

A `BLOCKED` verdict is information, not an obstacle to route around. The five gates BLOCKED today
(`check:identity`, `check:fixtures`, and the three parity gates) are blocked on named private inputs
that never enter this repository (REQ-167) — that is the fail-closed contract working, and the fix is
to supply the input, never to relax the gate. Current per-gate status:
[`PROJECT-STATE.md`](./PROJECT-STATE.md) §1.

---

## Sweep — 2026-07-27, commit `c09d9a5`

> **Read with the correction dated 2026-07-28 applied.** This whole section is evidence about `c09d9a5`,
> and by rule 1 it says nothing about any other SHA — that has not changed. What has changed is the
> environment: the `workerd` wedge that BLOCKED six suites, the acceptance spine and both promotion gates
> here was cleared by a reboot, and every one of them has since been run at HEAD `3fc592b`. Their verdicts,
> the merge-gate artifact path and the five surviving holds are at the foot of this file:
> § *Post-reboot sweep — 2026-07-28*. Nothing below is deleted; the record of what could not be measured is
> itself worth keeping.

The V1 close-out evidence sweep (Task 7). Everything below is the verbatim verdict of a command that
was actually run at this SHA on this machine. **Nothing here was inferred, and no BLOCKED or unrun
gate was relabelled.**

This is a **partial sweep and says so.** Six of the eighteen test suites, both promotion gates and the
acceptance spine could not execute at all — not because they fail, but because the `workerd` runtime on
this host is wedged. That is recorded below as a named hold with its diagnostic and its remedy, and it
is the single largest thing this commit does **not** prove.

**What this SHA proves:** the tree builds, typechecks, lints, and satisfies every static invariant,
traceability and design gate; 1,470 assertions pass across the twelve suites that do not need
`workerd`; and all four browser gates pass in a real browser at their full expected counts.
**What it does not prove:** that any ledger, Worker, or API code executes correctly — the suites that
would show that could not be started; that anything is deployed or configured; or that the Task 1
`anchors/run` fix is green.

### The environment hold — `workerd` is wedged (the cause behind every environment-BLOCKED row)

```text
$ ps -eo stat,command | grep '[w]orkerd' | grep -c '^UE'
127
```

127 of 128 `workerd` processes sit in uninterruptible-exit (`UE`) and survive `kill -9`.
`workerd --version` never returns, and cannot be interrupted even by `SIGALRM` — a process in `UE`
state does not take signals.

**This is not load.** The count was 127 at 15:59 with load average 7.46 and still exactly 127 at 16:27
with load average 3.49. Load halved; nothing unwedged. **Remedy: reboot the machine.** Nothing in this
repository can clear it, and no gate below was worked around because of it.

Everything that routes through `workerd` is therefore BLOCKED, not failed, and not skipped:
`packages/ledger`, `workers/api`, `workers/agents`, `workers/billing`, `workers/mcp`,
`workers/translator`, `pnpm test`, `pnpm test:acceptance`, `pnpm verify:dev`, `pnpm verify:merge`,
`pnpm verify:release`.

> **SUPERSEDED for the six suites above — 2026-08-05 at `c51e0f7` (audit §367).** The wedge was
> machine-local and transient; a reboot cleared it, and audit §297/§298 withdrew the BLOCKED claim after
> running them. All six run green today, and their counts are in the re-measured table below. **Everything
> from here to the end of Step 1 is the record of what happened DURING the wedge, correctly dated —
> read it as history, not as the current state.** `test:acceptance` was likewise re-measured green (§333).

Two things this section got right and are worth keeping: the six absent suites were **named**, and the
sentence *"a green above says nothing about any of them"* was written next to the total. A disclosed
exclusion goes stale visibly. The failure mode it avoided is a total that reads as complete.

### Step 1 — the local repository gate

`pnpm verify:dev` could not be run end-to-end: it spawns `pnpm test` fourth, which needs `workerd`. Its
runnable constituents were each run individually instead, so the sweep still says something precise
about every one of them.

Verdicts are quoted exactly as printed; a `…` marks the only thing ever removed from one, which is
trailing explanatory prose. Nothing is paraphrased inside quotation.

| Gate | Command | Verdict as printed | Result |
|---|---|---|---|
| runtime contract | `pnpm check:runtime` | `runtime contract OK — Node v22.15.0 (>=22.15.0 <23), pnpm 11.10.0` | **PASS** |
| workspace build | `pnpm -r --if-present build` | exit 0; 3 of 3 vite builds `Done` (command, driver, portal) | **PASS** |
| typecheck | `pnpm -r --workspace-concurrency=2 --if-present run typecheck` | exit 0; **17 of 17** workspaces `typecheck: Done` | **PASS** |
| lint | `pnpm lint` | exit 0, no output (`eslint .` clean) | **PASS** |
| unit + tools suites | `pnpm test` | **not run** — spawns the six `vitest-pool-workers` suites | **FAIL — 3 of 3,704** *(re-measured 2026-08-05 at `fee46a3`, audit §333: the `workerd` wedge is ABSENT (§297) — this row claimed BLOCKED for eleven days while the suite ran fine. The 3 failures are the `REQ-289` register trio, not an environment hold)* |
| invariants | `pnpm check:invariants` | `invariants OK — 21/22 tables, events append-only (11 migration files, lock: check)` | **PASS** |
| rater purity | `pnpm check:rater-purity` | `rater-purity OK — no class-as-foundation, no LLM/agent imports in packages/rater/src (REQ-004/REQ-024)` | **PASS** |
| authority coverage | `pnpm check:authority-coverage` | `authority-coverage OK — all 9 (module, file) consults across 5 modules (rating/invoicing/settlement/comms/dispatch), 8 distinct files, each call resolveAuthority(db,'<module>') …` | **PASS** |
| traceability | `pnpm check:traceability` | `traceability: no orphans in either direction (active: WP-01 … WP-16)` | **PASS** |
| coverage | `pnpm check:coverage` | `coverage: 100% — all 288 register rows accounted for (0 unaccounted).` + `8 status-drift row(s)` | **FAIL** *(re-measured 2026-08-05 at `fee46a3`, audit §333 — `check:coverage` fails on the uncommitted `REQ-289` GTM row (§299). This row asserted PASS while the gate was red: the optimistic direction, and the one that matters)* |
| seed | `pnpm check:seed` | `SEED-1 hash verified` | **PASS** |
| acceptance spine | `pnpm test:acceptance` | **not run** — 4 of the 5 spine files live in `workers/api` / `workers/mcp` | **PASS** *(re-measured 2026-08-05 at `fee46a3`, audit §333 — verified green in the live `verify:merge` run of §298; the wedge claim was inherited, never re-checked)* |
| design audit | `pnpm audit:design` | `design audit: clean` | **PASS** |
| identity leak | `pnpm check:identity -- --mode merge` | `{"gate":"identity-leak","status":"BLOCKED","executed":false,"assertions":0,"detail":"no denylist (set IDENTITY_DENYLIST secret or .identity-denylist.local)"}` | **BLOCKED — denylist** |
| fixtures | `pnpm check:fixtures -- --mode merge` | `fixtures: BLOCKED under --mode merge — 9 fixture(s) not vendored; a merge/release gate does not green on absent private fixtures.` | **BLOCKED — 9 fixtures** |
| rater parity | `pnpm check:rater-parity -- --mode merge` | `rater-parity: BLOCKED under --mode merge — the audited … fixtures are not vendored; no promotion on absent private fixtures.` (3 pending) | **BLOCKED — 3 fixtures** |
| invoice parity | `pnpm check:invoice-parity -- --mode merge` | `invoice-parity: BLOCKED under --mode merge — the 500-quote replay set is not vendored; no promotion on absent private fixtures.` (2 pending). The in-repo smoke inside the same harness did run: `invoice parity smoke — 5/5 in-repo synthetic cases: invoice === rater, penny for penny (harness live; NOT the 500-replay DoD)` | **BLOCKED — 2 fixtures** |
| concierge parse | `pnpm check:concierge-parity -- --mode merge` | `concierge-parse: BLOCKED under --mode merge — the 50-email corpus is not vendored; no promotion on absent private fixtures.` (2 pending). In-repo smoke did run: `concierge parse smoke — 7/7 in-repo synthetic cases: parse matched + decision matched (2 auto_reply, 5 queued; 0 false sends) — harness live; NOT the 50-email DoD` | **BLOCKED — 2 fixtures** |
| prod dependency audit | `pnpm audit --prod` | `No known vulnerabilities found` | **PASS** |
| whitespace / conflict markers | `git diff --check` | exit 0, no output | **PASS** |

**The five fixture/denylist BLOCKEDs are the fail-closed contract working, not a regression.** They
wait on named private inputs that never enter this repository (REQ-167): `IDENTITY_DENYLIST`, and the
nine engagement-workspace fixtures listed by `check:fixtures` (`rater-48-tests`, `rater-504-sweep`,
`zone-tariff-v1`, `invoice-500-replay`, `concierge-parse-50`, `customer-roster`,
`legacy-import-formats`, `legacy-export-replay`, `synthetic-blitz-3100`). The fix is to supply the
input, never to relax the gate.

#### The eighteen suites — re-measured 2026-08-05 at `c51e0f7`

**Measurement stamp: `c51e0f7`, 2026-08-05, audit §367. This stamp does NOT track HEAD** — it names the
commit the counts were taken at, so a later reader can tell drift from currency (the §330 rule). On the
wedge day this table held twelve rows totalling 116 files / 1,470, and said so honestly; ten of those
twelve had since drifted and six suites were absent.

Each suite was run directly by **path** filter — `pnpm --filter ./workers/agents`, never
`--filter @shuddl/agents`, which resolves to `packages/agents` instead (one name collision in seventeen
workspaces, and it fails *silently* onto the wrong workspace — audit §324/§325).

**284 test files, 3,713 test cases: 3,710 passing, 3 failing, zero skips.** These are test **cases**,
which is what vitest's `Tests` line counts — the earlier wording said "assertions", a strictly larger and
stronger quantity that was never measured.

**All three failures are the single uncommitted `REQ-289` register row (§299), and nothing else.** Two in
`tools/traceability/coverage.test.ts` (register coverage, register disposition) and one register-contiguity
case. **Proven, not inferred:** restoring the register to HEAD takes `test:tools` from `3 failed | 781
passed` to `784 passed (784)`, and re-adding the row restores the three. This is the same open item
`check:coverage` reports as **FAIL** in the gate table above — one cause, two instruments, no third
problem hiding behind it.

| Suite (by path) | Files | Tests |
|---|---|---|
| root tools (`pnpm test:tools`) | 31 | 784 *(781 pass, 3 fail — REQ-289)* |
| `apps/command` | 17 | 97 |
| `apps/driver` | 10 | 58 |
| `apps/portal` | 13 | 80 |
| `packages/adapters` | 3 | 38 |
| `packages/agents` | 10 | 219 |
| `packages/contracts` | 14 | 285 |
| `packages/design` | 2 | 11 |
| `packages/driver-core` | 4 | 39 |
| `packages/edi` | 6 | 38 |
| `packages/ledger` | 34 | 618 |
| `packages/map` | 10 | 84 |
| `packages/rater` | 12 | 154 |
| `workers/api` | 69 | 757 |
| `workers/mcp` | 12 | 177 |
| `workers/agents` | 19 | 113 |
| `workers/billing` | 6 | 57 |
| `workers/translator` | 12 | 104 |
| **total** | **284** | **3,713** |

**The file total is corroborated, not just summed.** `git ls-files | grep -cE '\.test\.(ts|tsx)$'`
reports **284** tracked test files, and the eighteen suites collect **284**. Two independent mechanisms
agreeing to the unit means no test file is collected twice and none is collected by nobody — the
condition `tools/checks/test-collection.test.ts` enforces, here confirmed against an outside count rather
than against itself.

The six formerly-absent suites — `packages/ledger`, `workers/api`, `workers/agents`, `workers/billing`,
`workers/mcp`, `workers/translator` — are exactly the ones that exercise the ledger, the sequencer DO,
the gates, the queues and the API surface, and they are **1,826 of the 3,713 cases**. The wedge-day total
covered 51% of the tests that exist. That is why the disclosure sentence beside it mattered.

**Reconciled against the other two records of this same figure, so the three cannot drift apart silently:**

| where | measured at | files | cases |
|---|---|---:|---:|
| `docs/ops/PROJECT-STATE.md` "Unit tests" | 2026-07-28, `3fc592b` | 258 | 3,243 |
| the tip-verdict `pnpm test` row below | 2026-08-05, `fee46a3` (§333) | 283 | 3,704 |
| this table | 2026-08-05, `c51e0f7` (§367) | 284 | 3,713 |
| re-measured after the §370–§380 sweep | 2026-08-05, `570ab5d` (§381) | 286 | 3,750 |
| re-measured after the §385–§398 sweep | 2026-08-06, `331813a` (§399) | 286 | 3,758 |
| re-measured after the §404–§406 fixes | 2026-08-06, `39cfa56` (§407) | 286 | 3,760 |
| re-measured after the §408–§411 containment hold | 2026-08-06, `c9fa799` (§412) | 287 | 3,771 |
| **full `verify:merge` RUN** — 24 gates, 17 PASS / 2 FAIL / 5 BLOCKED | 2026-08-06, `5ad61d5` (§422) | 287 | 3,771 |

Each delta is **entirely this audit's own**, and accounted line by line — a delta that cannot be is a
measurement to redo, not a number to write down.

- `fee46a3` → `c51e0f7`: **+1 file / +9 cases** — `error-envelope.test.ts` (+1 file, +3, §354), two
  `transition-gates` cases (§359), four service-worker guard cases (§367).
- `c51e0f7` → `570ab5d`: **+2 files / +37 cases** — 22 migration-ban identity + parity cases (§378), 3
  device-principal guards (§375), 2 lens-translation guards (§377), 2 certification-strictness cases
  (§370), and two NEW files, `transport-dormancy.test.ts` (+4, §379) and `webhook-dormancy.test.ts`
  (+4, §380).

- `570ab5d` → `331813a`: **+8 cases / +0 files** — 2 consent-override cases (§387), 3 rater physics-contract
  cases (§389), 1 cross-tenant claim case (§395), 2 invoice rollback/settle cases (§396). No new test file:
  every one landed in a suite that already existed, which is what a guarantee-driven sweep looks like as
  opposed to a surface-driven one.

The 3 failures are unchanged throughout: the uncommitted `REQ-289` row, and nothing else.

Observation, not a defect: `pnpm test:tools` emits five `fatal: not a git repository` lines on stderr.
They originate in `tools/checks/invariants.test.ts:33`, which spawns the invariants CLI inside
non-git temp directories with stderr piped through to the parent; the checker's `committedLock()`
fallback (`tools/checks/invariants.ts:515@committedLock`) is designed to return `{}` in exactly that case. All
784 tools cases pass (410 on the wedge day). Cosmetic noise; recorded here so the next reader does not
re-diagnose it.

### Step 2 — the browser gates

All four ran in a real Chromium with GPU and passed at their full expected counts (4 / 6 / 5 / 1). The
four sentinel lines verbatim:

```text
##SHUDDL-GATE## {"gate":"a11y","status":"PASS","executed":true,"assertions":4,"detail":"4 passed"}
##SHUDDL-GATE## {"gate":"e2e","status":"PASS","executed":true,"assertions":6,"detail":"6 passed"}
##SHUDDL-GATE## {"gate":"visual","status":"PASS","executed":true,"assertions":5,"detail":"5 passed"}
##SHUDDL-GATE## {"gate":"perf","status":"PASS","executed":true,"assertions":1,"detail":"1 passed"}
```

| Gate | Command | What it actually asserted | Result |
|---|---|---|---|
| a11y | `pnpm test:a11y -- --mode merge` | `a11y[command]`, `a11y[portal]`, `a11y[driver]` each `0 finding(s), 0 blocking`; plus the driver day sheet reachable and operable by keyboard alone | **PASS (4)** |
| e2e | `pnpm test:e2e -- --mode merge` | driver offline capture survives the page and flushes on reconnect; a 401 clears the session leaving no stale sheet; portal never puts a party scope on the wire; a smuggled `party_id` never reaches the API; a 403 renders a refusal | **PASS (6)** |
| visual | `pnpm test:visual -- --mode merge` | the five blessed screens — `command`, `portal`, `status`, `driver`, `evidence-email` — match their committed baselines with motion disabled | **PASS (5)** |
| perf:map | `pnpm perf:map -- --mode merge` | 1,000 entities: `frames=401 p50=10.00ms p95=10.80ms (~93fps at p95; budget 18.18ms / 55fps)`; `interaction p95=21.10ms over 12 pan/zoom samples (budget 500ms)`; `operating-window long tasks = 0, worst = 0.00ms (budget 100ms)` | **PASS (1)** |

Two caveats that belong with these greens rather than in a footnote:

- **The perf verdict is host-bound and does not transfer.** It was measured on
  `ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max)`, `software=false`, and the gate itself prints
  `enforcing FPS here = false`. A different machine, GPU or Playwright version needs its own run.
- **Cold-boot long tasks are reported, not budgeted:** `cold-boot long tasks (first paint, REPORTED
  not budgeted) = 1, worst = 69.00ms`. Only the operating window is under budget, and that window
  measured 0.

### Step 3 — the promotion gates

| Gate | Command | Result | Cause |
|---|---|---|---|
| merge promotion | `pnpm verify:merge` | **BLOCKED** | its 4th gate is `unit-tests` → `pnpm test` → six `workerd` suites (`run-gate.ts:46`) |
| release promotion | `pnpm verify:release` | **BLOCKED** | same `unit-tests` gate, plus `acceptance` (`run-gate.ts:53`), plus the four release-infra gates below |

Neither was run — a wedged `workerd` does not fail fast, it hangs, and a hung gate teaches nothing.
Note that `run-gate` is continue-through, so had it been started it would have produced a record whose
`unit-tests` and `acceptance` rows read BLOCKED/FAIL rather than absent; the aggregate would be
`PREREQ_BLOCKED` (exit 2) at best. **Exit 2 is not a green.**

**What `verify:release` would additionally block on** — the three release-infra gates are real
commands, so each was run directly, which is exactly what `verify:release` would have spawned:

```text
##SHUDDL-GATE## {"gate":"deploy-preflight","status":"BLOCKED","executed":true,"assertions":71,"detail":"12 blocked: placeholder-resource-id, missing-secret, no-origins, tsa-unconfigured, no-backup"}
##SHUDDL-GATE## {"gate":"restore-verify","status":"BLOCKED","executed":false,"assertions":0,"detail":"no --source/--restored snapshots supplied; a restore has not been reconciled"}
##SHUDDL-GATE## {"gate":"staging-smoke","status":"BLOCKED","executed":false,"assertions":0,"detail":"SMOKE_API_BASE is not set — there is no deployed environment to smoke"}
```

**Read the `staging-smoke` sentinel literally (note added 2026-07-27, final cross-task review).** Its
`detail` is the gate's own wording for *"no base URL was supplied to me"* — the gate reads
`SMOKE_API_BASE` and nothing else, so it can only ever report what this checkout binds, never what the
account runs. A staging environment **is** deployed and **does** send real evidence email
(`PROJECT-STATE.md:19-27`, ~~`:172-179`~~ `:218-225` — repointed 2026-07-28; hold H9 below). The BLOCKED verdict is right; the sentence
"there is no deployed environment" is the tool's, and it is about this checkout.

`deploy-preflight` is the informative one. **As measured 2026-07-27 at `79ae54d`** it executed 71 checks
against staging and returned 12 unsatisfied prerequisites — 5 × `placeholder-resource-id` (all-zero D1 UUIDs
on `PLATFORM_TENANT_DB`, both `TENANT_POOL_*`, `shuddl-billing-staging.PLATFORM_TENANT_DB`, and a malformed
mcp `GRANTS` KV id),
4 × `missing-secret` (`JWT_SECRET`, `RESEND_API_KEY`, `STRIPE_WEBHOOK_SECRET`,
`PLATFORM_INTERNAL_SECRET`), `no-origins`, `tsa-unconfigured`, `no-backup`.

**Re-measured 2026-08-05 at `2a8a107`: 85 checks, `BLOCKED — 8 unsatisfied`, and 1 × `placeholder-resource-id`**
(`shuddl-mcp-staging.GRANTS`). The four D1 ids named above were provisioned in `b961dfc`; the other seven
prerequisites are unchanged because a stateless run cannot see any of them. Which is the point of the
qualifier below — **7 of the 8 are the tool declining to guess, and exactly 1 is a defect this repo owns.**

It also prints the qualifier that governs how to read all of it:

```text
preflight: no --state supplied — account-side facts (secrets, origins, sender, TSA, backups) are UNPROVEN and therefore blocked.
```

That is **unproven**, not necessarily **absent** — on staging some of those secrets are in fact bound.
The ~~fourth~~ fifth release-infra gate (`surfaces` joined 2026-08-01), `backup-manifest`, is a statically declared hold (`run-gate.ts:84`): nothing
in a release run can synthesize a backup manifest.

These twelve blocks reconcile 1:1 against the staging column of the hold ↔ gate table in
`GO-LIVE-CHECKLIST.md`, unchanged since it was built at `72b2fc2`.

### Step 4 — the field evidence, and what each waits on

Seven claims cannot be produced from a checkout at any SHA. They are not failures and they are not
oversights; each needs a credential, a deployed environment or a physical device. **This list is the
deploy-day runbook** — in dependency order, since several cannot clear before the one above.

| # | Field claim | The command that would produce it | Waits on | Owner |
|---|---|---|---|---|
| 1 | **Production configuration preflight** — every binding, secret, origin, sender and TSA satisfied | `pnpm preflight -- --mode release --env prod --state <facts.json>` | Provisioned D1/KV/R2/Queue resources **and** a `--state` snapshot of account-side facts; without `--state` the answer can only ever be UNPROVEN. (**Not measured in this sweep** — only the staging environment was run. `GO-LIVE-CHECKLIST.md` records 26 prod blocks incl. 19 placeholder ids as of `72b2fc2`; no `[env.prod]` block has changed since. **Measured 2026-07-27 at `79ae54d`** and unchanged at 26 — but still without `--state`, so every account-side fact remains UNPROVEN: § *Tip verdict*) | infrastructure |
| 2 | **Staging migration dry-run** — the tenant and control migrations apply cleanly to real remote D1 | `cd workers/api && npx wrangler d1 execute <db> --remote --yes --file ../../db/tenant/migrations/<f>.sql`, per `DEPLOYMENT.md:42` | Real D1 database ids (the staging ids are the 5 all-zero placeholders measured above) + Cloudflare API credentials. Note: `wrangler` is itself a `workerd` host, so this is doubly blocked here. Also worth resolving first: `check:invariants` counts **11** migration files, while `DEPLOYMENT.md:42` enumerates only `0001..0005` + control `0001` — confirm which list is current before applying anything | infrastructure |
| 3 | **Deployed smoke** — gated driver stop → `pod.signed` → Queue → penny-exact `invoice.issued` against a live environment | `pnpm smoke:staging -- --mode release` | `SMOKE_API_BASE` (a deployed, reachable base URL) and `SMOKE_JWT_SECRET` / `SMOKE_JWT_SECRET_FILE`. Bound to the deployed `DEPLOYMENT_VERSION` — any redeploy voids it | infrastructure |
| 4 | **Tenant isolation probe against a deployed environment** — no cross-tenant read on any live path | the in-repo suites `workers/api/test/{isolation,platform-tenant-isolation,plg-isolation-matrix}.test.ts` prove it against the local pool; a *deployed* probe needs two provisioned tenants and two live tokens against `SMOKE_API_BASE` | Downstream of #3. Also blocked locally today: those three suites are `workerd` suites and did not run in this sweep | backend |
| 5 | **Backup + restore reconciliation** — same event count, head hash, chain, invoices and anchor roots | `pnpm restore:verify -- --mode release --source <a.json> --restored <b.json> --rows <events.json>` | A backup artifact must exist first: `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` bound so `.github/workflows/nightly.yml` can run. Strictly downstream of the backup hold — it cannot clear first | on-call |
| 6 | **Rollback / forward-repair drill** — code rolls back and schema repairs forward without data loss | `wrangler rollback` for code; a forward-repair migration for schema (`dr-backups.md`, `DEPLOYMENT.md:152`). No gate exists; the drill is performed and written up | A deployed environment with at least two versions, plus #5 (never drill rollback without a verified restore) | on-call |
| 7 | **Strict browser/device acceptance** — a real driver completes a gated stop on a real phone, and the filmed half of the five doc-00 demos | Not a command. `docs/wp/acceptance-demos.md` is the record; `pnpm test:acceptance` proves only the in-repo code-provable half — and that half is itself BLOCKED here | A physical device, a real driver, a deployed environment (#3), and the M-H milestone decision | founder |

Two further holds in `GO-LIVE-CHECKLIST.md` — the **on-call rota** and **7-year monthly snapshots** —
appear in no table above because **no gate exists for either**. They can be re-read, never re-run. That
asymmetry is itself recorded as deferred work.

### The named holds this commit carries

Every BLOCKED verdict above, with the specific thing it waits on. None of these is a failure; none may
be relabelled.

| # | Hold | Blocks | Waits on | Owner |
|---|---|---|---|---|
| H1 | ~~**`workerd` wedged** — 127 processes in `UE`, `kill -9`-proof~~ **RESOLVED 2026-07-28 by reboot.** `workerd --version` → `workerd 2025-10-11`, instantly; `UE` count → **0**. **The condition recurs** — it is minted by interrupted `vitest-pool-workers` runs — so keep the diagnostic (`PROJECT-STATE.md` § *Environment gotchas*) and re-run it at the start of any session that must produce ledger or Worker evidence | ~~6 suites, `pnpm test`, `test:acceptance`, `verify:dev`, `verify:merge`, `verify:release` — i.e. **the authoritative merge gate cannot be run at all**~~ **nothing — all six suites, `pnpm test`, `test:acceptance` and `verify:merge` ran at `3fc592b`** | ~~a machine reboot~~ **done** | on-call / founder |
| H2 | ~~**Task 1 `anchors/run` fix unverified here** — sound on diff and three review rounds, never observed green~~ **RESOLVED 2026-07-28 at HEAD `3fc592b` — observed green:** `packages/ledger` **34 files / 598 tests PASS**, `workers/api` **65 files / 719 tests PASS across three consecutive runs**, full `pnpm test` **258 files / 3,243 tests PASS**. The defect it closed failed roughly four runs in five, so three consecutive clean runs is the disposition the branch asked for | ~~the `FIXED †` in `GO-LIVE-CHECKLIST.md` stays daggered~~ **nothing — that row now reads plain `FIXED` and no row in that file carries a †** | ~~H1. Re-run `pnpm -F @shuddl/ledger test` and the `workers/api` suite after reboot~~ **done; expires when the anchor route, its ledger module or `workers/api/test/driver-manifest.test.ts` changes** | backend |
| H3 | **`IDENTITY_DENYLIST` unset** | `check:identity` (REQ-167) | the CI secret, or a gitignored `.identity-denylist.local`. Fails **closed** in CI, open locally | founder |
| H4 | **9 engagement fixtures not vendored** | `check:fixtures`, `check:rater-parity`, `check:invoice-parity`, `check:concierge-parity` — and with them the WP-04/06/07 DoDs | the engagement-workspace config pack (outside this repo by REQ-167) | founder |
| H5 | **Staging + prod resources are placeholders** — 5 staging all-zero ids, measured here; 19 prod, carried from `GO-LIVE-CHECKLIST.md` at `72b2fc2` and **not re-measured in this sweep** (re-measured 2026-07-27 at `79ae54d` — still 26 blocks, 19 of them placeholder ids, 17 D1 + 2 KV: § *Tip verdict*) | `deploy-preflight`, and every field row above | provisioning, then pasting the returned ids | infrastructure |
| H6 | **Secrets unproven / unbound** — 4 on staging, measured here. Read as *unproven*: with no `--state`, the gate cannot see a secret that is in fact bound | `deploy-preflight` | binding on prod; a `--state` snapshot to prove staging | infrastructure |
| H7 | **No CORS origins, no TSA endpoint** | `deploy-preflight`; anchors stay UNANCHORED (never faked) | real deploy origins; an `integrations` row `kind='tsa'` + the F1 CONFIRM | backend / infrastructure |
| H8 | **No backup exists** | `backup-manifest`, `restore-verify`, field rows 5 and 6 | `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | infrastructure |
| H9 | ~~**Nothing is deployed**~~ **Superseded 2026-07-27 (final cross-task review) — the correct claim is narrower: THE GATE CANNOT SEE A DEPLOYMENT.** `SMOKE_API_BASE` is unset **in this checkout**, so `staging-smoke` has no base URL to drive and returns BLOCKED. That verdict is correct and stands. It is **not** an observation about the account: `shuddl-api-staging` and `shuddl-agents-staging` **are** deployed, a smoke has driven a gated stop over HTTPS through `pod.signed` to a penny-exact `invoice.issued` (first green run 55,800¢), and the deployed Biller sends **real** evidence email from `pod@send.shuddl.tech` on a live `RESEND_API_KEY` — `PROJECT-STATE.md:19-27`, ~~`:172-179`~~ `:218-225` (repointed 2026-07-28). **Read it as a live environment**: do not seed, replay, or re-enable `EVIDENCE_FROM` on the belief that nothing can leave the box | `staging-smoke`, field rows 3, 4, 7 | `SMOKE_API_BASE` + a staging JWT secret bound **here** (field rows 4 and 7 additionally need the three undeployed workers, two provisioned tenants, and a device) | infrastructure |
| H10 | **Two holds with no gate** — on-call rota, 7-year snapshots | nothing mechanically; they are unmeasurable | a human naming a human; the archive tier being built | founder / infrastructure |

**Bottom line.** ~~Twenty gates PASS at `c09d9a5`~~ **Corrected 2026-07-27 (final cross-task review):
SEVENTEEN gates PASS at `c09d9a5`.** The Step-1 table has twenty data *rows*, of which **13 are PASS and
7 BLOCKED**; Step 2 adds the four browser passes — **13 + 4 = 17**. The original figure counted rows
rather than verdicts, in the one document whose thesis is that nothing here was inferred. Every one of
those seventeen verdicts is quoted above from a command that ran. Two gates are BLOCKED on the local
runtime, five on named private inputs, and four on environment facts this checkout cannot reach — of
which only `staging-smoke` is a *visibility* gap rather than an absence (H9). **No promotion is
available from this commit** — `verify:merge`
cannot be run, and until it can, rule 1 of this document means this SHA has no evidence record at all.
The next person to reboot this machine should re-run `pnpm verify:merge` first; it is the one
outstanding thing that would convert most of this page into a single artifact.

**Done, 2026-07-28.** The machine was rebooted and `pnpm verify:merge` was run at HEAD `3fc592b`,
producing this branch's first evidence record. It does **not** promote — 16 gates PASS, 5 BLOCKED, exit 2 —
but it exists, it is complete, and it names exactly what it waits on. Full verdicts and the artifact path:
§ *Post-reboot sweep — 2026-07-28* below. Everything above remains evidence about `c09d9a5` and is not
restated as a measurement of any other tree.

---

## Tip verdict — 2026-07-27, commit `79ae54d` (+ this record-accuracy commit)

Rule 1 of this document means the sweep above is evidence about `c09d9a5` and nothing else, so by the
branch's own law **nothing vouched for the tip** until these were run. Every runnable gate was therefore
re-executed at `79ae54d`, on this machine, in this checkout. Each line is a command that ran.

| Gate | Command | Verdict as printed | Result |
|---|---|---|---|
| runtime contract | `pnpm check:runtime` | `runtime contract OK — Node v22.15.0 (>=22.15.0 <23), pnpm 11.10.0` | **PASS** |
| invariants | `pnpm check:invariants` | `invariants OK — 21/22 tables, events append-only (11 migration files, lock: check)` | **PASS** |
| rater purity | `pnpm check:rater-purity` | `rater-purity OK — no class-as-foundation, no LLM/agent imports in packages/rater/src …` | **PASS** |
| authority coverage | `pnpm check:authority-coverage` | `authority-coverage OK — all 9 (module, file) consults across 5 modules (rating/invoicing/settlement/comms/dispatch), 8 distinct files …` | **PASS** |
| seed | `pnpm check:seed` | `SEED-1 hash verified` | **PASS** |
| design audit | `pnpm audit:design` | `design audit: clean` | **PASS** |
| lint | `pnpm lint` | exit 0, no output | **PASS** |
| typecheck | `pnpm -r --workspace-concurrency=2 --if-present run typecheck` | exit 0; **17 of 17** workspaces `typecheck: Done` | **PASS** |
| tools suite | `pnpm test:tools` | **18 files, 410 tests passed**, 0 failed, 0 skipped | **PASS** *(re-measured 2026-08-05 at `5e65d6e`, audit §369 — now **31 files, 784 cases, 3 failing**. The three are the uncommitted `REQ-289` row, same cause as the coverage row below; proven by restoring the register → `784 passed (784)`. The 18/410 figure is what ran at `79ae54d`)* |
| traceability | `pnpm check:traceability` | `traceability: no orphans in either direction (active: WP-01 … WP-16)` | **PASS** |
| coverage | `pnpm check:coverage` | `coverage: 100% — all 288 register rows accounted for (0 unaccounted).` + `8 status-drift row(s)` | **FAIL** *(re-measured 2026-08-05 at `5e65d6e`, audit §369 — `classified: 288/289 (unaccounted: 1)`, **exit 1**, on the uncommitted `REQ-289` GTM row (§299). §333 corrected the IDENTICAL row in the Step-1 table and this copy was left asserting PASS — a correction applied to the instance rather than to the claim)* |
| a11y | `pnpm test:a11y -- --mode merge` | `{"gate":"a11y","status":"PASS","executed":true,"assertions":4,"detail":"4 passed"}` | **PASS (4)** |
| e2e | `pnpm test:e2e -- --mode merge` | `{"gate":"e2e","status":"PASS","executed":true,"assertions":6,"detail":"6 passed"}` | **PASS (6)** |
| visual | `pnpm test:visual -- --mode merge` | `{"gate":"visual","status":"PASS","executed":true,"assertions":5,"detail":"5 passed"}` | **PASS (5)** |
| perf:map | `pnpm perf:map -- --mode merge` | `frames=401 p50=10.00ms p95=10.80ms`; `interaction p95=21.80ms over 12 pan/zoom samples`; `operating-window long tasks = 0, worst = 0.00ms` | **PASS (1)** |
| preflight (staging) | `pnpm exec tsx tools/deploy/preflight.ts --env staging` | `preflight: BLOCKED — 8 unsatisfied prerequisites. This is not a green.` — 1 `placeholder-resource-id` / 4 `missing-secret` / 1 `no-origins` / 1 `tsa-unconfigured` / 1 `no-backup` *(re-measured 2026-08-05 at `2a8a107`; was 12/5 at `79ae54d` before `b961dfc` provisioned the four D1 ids)* | **BLOCKED — as recorded**, and 7 of the 8 are account-side facts a stateless run cannot see |
| preflight (prod) | `pnpm exec tsx tools/deploy/preflight.ts --env prod` | `preflight: BLOCKED — 26 unsatisfied prerequisites. This is not a green.` — 19 / 4 / 1 / 1 / 1, same split | **BLOCKED — as recorded** |

**Fifteen gates PASS and both preflights BLOCK at exactly the counts the ledgers claim.** No hold
cleared, none was added, no verdict changed from the `c09d9a5` sweep.

**What this note does NOT re-prove, stated as plainly as the sweep states it:**

- **The six `workerd` suites are still BLOCKED.** H1 is unchanged — nothing was rebooted, so
  `packages/ledger`, the five `workers/*` suites, `pnpm test`, `pnpm test:acceptance`, `pnpm verify:dev`,
  `pnpm verify:merge` and `pnpm verify:release` were not attempted here either. This SHA still proves
  nothing about the ledger, the sequencer, the gates, the queues or the API surface, and still carries
  **no evidence record at all**. *(True of `79ae54d`, and superseded for `3fc592b`: the reboot on
  2026-07-28 cleared H1 and all of those ran — § Post-reboot sweep below. Under rule 1 this bullet stays
  as written, because it is a statement about the tree it measured.)*
- **The eleven non-`workerd` workspace suites were not re-run in this pass.** Only `test:tools` was. The
  1,470-assertion figure remains the Task-7 sweep's, at `c09d9a5` — do not restate it as a tip
  measurement.
- **The five private-input gates were not re-run** (`check:identity`, `check:fixtures`, and the three
  parity gates). Their inputs are unchanged and absent; they BLOCK for the same reasons.

**Which tree this measured.** The gates above ran at `79ae54d`. The commit carrying this note is a
record-accuracy pass over five documents **plus two executable files** — `tools/traceability/orphans.ts`
(this document joins the annotation-scan exclusion list) and `tools/traceability/coverage.test.ts` (the
test that pins it). Every gate those two changes can move was therefore re-run *after* the edits, with
identical verdicts: `check:traceability` clean, `check:coverage` 288/288 with drift 8 and the same eight
ids, `test:tools` 18 files / 410 tests, `lint` exit 0, `typecheck` 17 of 17, `git diff --check` exit 0.
Under rule 1 this is still a claim about two SHAs rather than one, and it is stated here rather than
smoothed over.

---

## Post-reboot sweep — 2026-07-28, commit `3fc592b`

**This section is evidence about `3fc592b` and nothing else.** Rule 1 is this document's own thesis, so it
binds here first: none of the verdicts below transfer to `79ae54d`, to `c09d9a5`, or to any commit that
follows. Every line is a command that ran on this machine at this SHA.

**What changed since the two sweeps above: the environment, and only the environment.** The machine was
rebooted. `workerd --version` returns `workerd 2025-10-11` immediately, and
`ps -eo stat,command | grep '[w]orkerd' | grep -c '^UE'` returns **0**. H1 is RESOLVED, H2 with it, and
everything the previous two sweeps had to record as unmeasurable has now been measured. **No hold that
depends on an account, a credential, a licence or a vendored private artifact moved at all** — a reboot
provisions nothing.

### The suites

**Re-measured 2026-08-05 at `7d0710c` (audit §332).** This table was previously UNDATED and stale on every row,
and its aggregate verdict said **PASS** when three tests fail — the one claim in this document that was not
merely old but wrong. Prior figures preserved inline.

| Suite | Command | Files | Tests | Verdict |
|---|---|---:|---:|---|
| ledger | `pnpm --filter ./packages/ledger test` | 34 | 616 | **PASS** *(was 598)* |
| api | `pnpm --filter ./workers/api test` | 68 | 754 | **PASS** *(was 65 / 719)* |
| everything (`test:tools` + every workspace project) | `pnpm test` | 283 | 3,704 | **3,701 PASS · 3 FAIL** — the `REQ-289` register trio from another workstream's uncommitted row (audit §299). *(was 258 / 3,243 / PASS)* |
| acceptance spine (the five doc-00 demos, in-repo half) | `pnpm test:acceptance` | — | 7 | **GREEN — all 7 spine tests pass** |

`workers/api` was run three consecutive times deliberately. The defect the Task-1 `anchors/run` containment
fix closed failed roughly four runs in five, so a single green would not have discharged it; three would.
That is why H2 is resolved and why the `FIXED †` in `GO-LIVE-CHECKLIST.md` is now a plain `FIXED`.

### The merge gate — and the first evidence record this branch has ever produced

**Run at `3fc592b`** (the same record `GO-LIVE-CHECKLIST.md` attributes to that SHA — 16 PASS + 5 BLOCKED
= the 21-gate profile of the time). The merge profile is **24** today; the size is pinned in
`tools/checks/gate-wiring.test.ts`, so this block is a snapshot and not a current expectation (audit §295).

```text
pnpm verify:merge   →   16 gates PASS, 5 BLOCKED
                        aggregate: BLOCKED, exit 2 — NOT PROMOTABLE
```

```text
artifacts/release/3fc592b0064086850393d01acc6a2a16be19e650/merge/gate-merge-2026-07-28T20-28-28-799Z.json
```

That path is **gitignored and must not be committed** (rule 3): the repository holds the contract, the run
holds the output. Retrieve it from the run.

| | Gates |
|---|---|
| **PASS (16)** | `runtime`, `typecheck`, `lint`, **`unit-tests`**, `invariants`, `rater-purity`, `authority-coverage`, `traceability`, `coverage`, `seed`, **`acceptance`**, `design-audit`, `perf` (1), `visual` (5), `a11y` (4), `e2e` (6) |
| **BLOCKED (5)** | `identity-leak`, `fixtures`, `rater-parity`, `invoice-parity`, `concierge-parse` |

`unit-tests` and `acceptance` are the two that had never executed under the aggregate before. Both PASS.

### The five holds this record carries — every one an absent private input

None is a code defect. None can be closed by a commit. This is the fail-closed contract working exactly as
rule 2 describes: a missing external prerequisite is `BLOCKED` under `--mode merge`, and `BLOCKED` never
promotes.

| Gate | Verdict detail, as recorded | What would clear it |
|---|---|---|
| `identity-leak` | `no denylist (set IDENTITY_DENYLIST secret or .identity-denylist.local)` | the CI secret, or a gitignored `.identity-denylist.local` |
| `fixtures` | `pending (not vendored)`: `rater-48-tests`, `rater-504-sweep`, `zone-tariff-v1`, `invoice-500-replay`, `concierge-parse-50`, `customer-roster`, `legacy-import-formats`, `legacy-export-replay`, `synthetic-blitz-3100` — **9** | vendoring the nine from the engagement workspace (outside this repo by REQ-167) |
| `rater-parity` | `engagement fixtures not vendored (fixtures/rater/*, fixtures/tariff)` | `rater-48-tests`, `rater-504-sweep`, `zone-tariff-v1` |
| `invoice-parity` | `engagement fixtures not vendored (fixtures/invoice-replay, fixtures/tariff)` | `invoice-500-replay`, `zone-tariff-v1` |
| `concierge-parse` | `engagement fixtures not vendored (fixtures/concierge/parse-50, fixtures/tariff)` | `concierge-parse-50`, `zone-tariff-v1` |

**These five are now the entire distance between this build and a promotable merge record.** Nothing else
in the merge profile is anything but PASS. `zone-tariff-v1` is the keystone: it appears in three of the
five rows.

### What this sweep does NOT prove

- **It does not make V1 promotable.** The aggregate is BLOCKED, exit 2. That is not a green and not a
  failure; it is a refusal, and the fix is to supply the input, never to relax the gate.
- **It says nothing about the release profile.** `verify:release` adds `deploy-preflight`,
  `restore-verify`, `staging-smoke` and `backup-manifest`; none of those was run at this SHA, and all four
  were BLOCKED at the last SHA that did run them. Nothing about them changed.
- **It says nothing about any environment.** The merge profile's `deployment` is the literal string
  `"n/a"`. Neither preflight was run at this SHA and no account-side fact was re-measured, so every figure
  for staging and production — 5 and 19 placeholder ids, 4 absent secrets, no origins, no timestamp
  authority, no backup — is **carried forward from the `79ae54d` tip verdict above, not re-observed here**.
  Nothing in this sweep could have changed one of them, and the external holds H3 through H10 stand exactly
  as recorded above.
- **It expires.** Merge records live 24h (`run-gate.ts:127`), and rule 1 voids this one at the next commit
  regardless. Re-run the gate; do not quote this section against a different tree.

**Bottom line.** `3fc592b` is the first commit on this branch that carries a real evidence record. The
record's verdict is **NOT PROMOTABLE**, and the reason is now narrow and nameable: five absent private
inputs, not a runtime that could not start and not a defect in the build. "Ready to launch" remains false,
and nothing in this sweep moves it.

## Production preflight — PASS, 2026-07-31

`pnpm exec tsx tools/deploy/preflight.ts --env prod --state <operator state file>` →
**`PASS — every declared binding, reference, secret, origin, and backup obligation is satisfied.`** (72 checks)

It read **BLOCKED, 26** on the morning of 2026-07-30. What closed it, in order:

| Was | Cleared by |
|---|---|
| 19 × `placeholder-resource-id` | `pnpm provision:prod --apply` — 6 D1, 2 KV, 1 R2 created in the product account, 19 ids written across 5 configs, one id per logical resource |
| 4 × `missing-secret` | `wrangler secret put` ×4. `JWT_SECRET` (api+mcp), `PLATFORM_INTERNAL_SECRET` (api+billing) and `RESEND_API_KEY` (agents+api) each carry ONE value across the pair that reads them; `STRIPE_WEBHOOK_SECRET` is the signing secret of a live Stripe webhook endpoint on `billing.shuddl.tech/webhooks/stripe` |
| `no-origins` | the four real browser origins, declared in `CORS_ALLOWED_ORIGINS` and in the state file |
| `tsa-unconfigured` | `https://freetsa.org/tsr`, the endpoint staging already uses |
| `no-backup` | `pnpm backup -- --env prod` — 6 databases exported, manifest digest `47e4d9ec…`, `##SHUDDL-GATE## backup-manifest PASS assertions=6` |

**Deployed and verified live**, not merely configured: `api.shuddl.tech/v1/board` returns **401** without a
token (the gate is server-side), `billing.shuddl.tech/health` and `mcp.shuddl.tech/` return 200, and the
Stripe webhook refuses both an unsigned and a forged request with **400**.

**What this PASS does NOT mean.** It is the *deploy* preflight: every binding resolves, every secret is
bound, a backup exists. It is not `verify:release`, and it says nothing about the five fixture-gated
proofs (`fixtures`, `rater-parity`, `invoice-parity`, `concierge-parse`, `identity-leak`), which still
BLOCK on private engagement data absent from this repository. It also does not mean the product has served
a real shipment: no tenant is onboarded, ~~the surfaces are not deployed~~ (**they are, later the same day
— see the sweep below**), and **outbound email is deliberately dark** — `EVIDENCE_FROM` is absent from the
agents prod scope, so `evidenceSender()` stays a `NotConfiguredSender`. The state file backing this PASS is
an operator artifact and is not committed; it names secrets.

---

## Release sweep — 2026-07-31, after the surfaces shipped

`RELEASE_ENVIRONMENT=prod PREFLIGHT_STATE=<operator state file> pnpm verify:release` →
**16 PASS, 8 BLOCKED, aggregate BLOCKED (exit 2) — NOT PROMOTABLE.**

Two gates changed state, and neither changed because a test was loosened:

| Gate | Was | Now | Why |
|---|---|---|---|
| `deploy-preflight` | BLOCKED, always | **PASS, 72 checks** | `run-gate` spawns the preflight with `--mode` only, and the preflight read its state file from `--state` alone — so this gate was *structurally incapable* of reporting PASS regardless of the account. `PREFLIGHT_STATE` is the channel the spawn actually carries |
| `perf` · `visual` · `a11y` · `e2e` | BLOCKED (no browser) | **PASS** (1 / 5 / 4 / 6) | the matching Chromium build was installed; nothing about the assertions changed |

**A PASS on this gate now names its own provenance**, because it depends on an untracked operator file:
`72 checks passed for prod (state: PREFLIGHT_STATE sha256:a89a9229dc99)`. The digest covers the facts
asserted — secret NAMES, origins, sender, TSA, backup posture — never a value, since this string lands in
an artifact. A BLOCKED record carries `(state: none)`, which is usually the whole explanation.

**The 8 that remain, and why none of them is a regression:**

- **5 need private engagement data** — `fixtures`, `rater-parity`, `invoice-parity`, `concierge-parse` (nine
  un-vendored fixture sets) and `identity-leak` (no denylist). Synthesising any of them would make the gate
  lie about the only thing it checks.
- **3 need external inputs** — `backup-manifest` (OIDC credentials), `restore-verify` (`run-gate` passes it
  no snapshot pair, so it cannot see that a real drill *was* run and passed — `dr-backups.md`), and
  `staging-smoke` (`SMOKE_API_BASE` unset).

**`staging-smoke` was left BLOCKED deliberately.** It seeds a synthetic shipment and drives it through to a
penny-exact `invoice.issued`. Pointed at production that writes synthetic freight into an **append-only**
ledger where corrections are new events and nothing can be removed (I3, I7). Clearing this gate is an
owner's decision about production data, not a step to take in passing.

### The surfaces, verified in a browser rather than by deploy output

`command` · `portal` · `driver` · `track.shuddl.tech` serve as assets-only Workers on custom domains
(`track` is a route inside the portal bundle, not a fourth surface). `PROD_SURFACE_BASE=shuddl.tech pnpm
test:surfaces` → **5 passed**. What it establishes: each surface loads a bundle that actually runs, reaches
`api.shuddl.tech` ~~and no other host~~ *(corrected 2026-08-01: the spec's foreign-host set is only the
synthetic `.example` host and localhost — it does NOT assert "no other host", and every deployed surface
also contacts the third-party demo tile host, the documented REQ-075 hold)*, and states plainly that it has
no session rather than rendering a calm
empty board — command's unbilled-PODs figure is an em dash, not a zero, because a zero is a claim about
freight made by a surface that never got to look.

That gate is honest about its own limits, having failed to be once: its first driver test asserted only
that no same-origin API call occurred, and an unauthenticated driver makes **no** calls at all, so it was
green for every build — including a bundle that never loaded. It now asserts the rendered screen and reads
the shipped script bytes. Portal's request-shaped assertion is vacuous for the same structural reason; its
rendered-text assertion is what carries it, and command and track are the two that positively prove they
reached the API.
