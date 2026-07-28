# Release evidence — the contract

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
| A restore reconciles: same event count, same head hash, intact chain, same invoices and money to the penny, same anchor roots (REQ-117/284) | `pnpm restore:verify -- --mode release --source <a.json> --restored <b.json> [--rows <events.json>]` | R/F | Sentinel; stdout only, no file | Record row `restore-verify` | Bound to **that snapshot pair**, not to the live database: writes after `capturedAt` are not covered. Without `--rows` the hash chain is taken from the snapshot rather than re-walked — a weaker claim, stated in the log. No snapshots ⇒ BLOCKED |
| A deployed environment survives the real flow: gated driver stop → `pod.signed` → Queue → penny-exact `invoice.issued` | `pnpm smoke:staging -- --mode release` | R/F | Sentinel **and its own evidence record** (72h TTL, single-gate) | `artifacts/release/<commit>/<env>/smoke-<generatedAt>.json` (gitignored) + record row `staging-smoke` | Bound to the **deployed** `DEPLOYMENT_VERSION`: any redeploy voids it. Needs `SMOKE_API_BASE` and a staging JWT secret (`SMOKE_JWT_SECRET` or `SMOKE_JWT_SECRET_FILE`) — either absent ⇒ BLOCKED. If `DEPLOYMENT_VERSION` cannot be resolved the record self-declares `deployment: "unresolved"` and cannot back a promotion |
| Every tenant and control D1 is exported with a SHA-256 manifest, retained for the policy window | `.github/workflows/nightly.yml` `backup` job (scheduled 08:00 UTC) | F | `*.sql` exports + `manifest.json` (`version`, `environment`, `commit`, `takenAt`, `retentionDays`, per-file `sha256`, and a manifest `digest`) | `artifacts/backup/` in the run; uploaded as `d1-backup-<run_id>`, `retention-days: 30` | A manifest proves the databases **at `takenAt`** and nothing after — it ages out daily. The upload is deleted at 30 days. `run-gate --profile release` cannot produce one: it is a declared external hold (`run-gate.ts:79`), BLOCKED unless `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` are bound |

Counts: 21 gates under `--profile merge` (12 plain + 9 skippable), 25 under `--profile release`
(+ `deploy-preflight`, `restore-verify`, `staging-smoke`, `backup-manifest`).

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
- **That the binding fields were independently checked.** `run-gate` constructs its own
  `PromotionContext` from the record it just wrote (`run-gate.ts:143`), so the commit/environment/
  fixtures/deployment comparison is self-satisfied by construction and can never fire there. Those
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
| unit + tools suites | `pnpm test` | **not run** — spawns the six `vitest-pool-workers` suites | **BLOCKED — `workerd`** |
| invariants | `pnpm check:invariants` | `invariants OK — 21/22 tables, events append-only (11 migration files, lock: check)` | **PASS** |
| rater purity | `pnpm check:rater-purity` | `rater-purity OK — no class-as-foundation, no LLM/agent imports in packages/rater/src (REQ-004/REQ-024)` | **PASS** |
| authority coverage | `pnpm check:authority-coverage` | `authority-coverage OK — all 9 (module, file) consults across 5 modules (rating/invoicing/settlement/comms/dispatch), 8 distinct files, each call resolveAuthority(db,'<module>') …` | **PASS** |
| traceability | `pnpm check:traceability` | `traceability: no orphans in either direction (active: WP-01 … WP-16)` | **PASS** |
| coverage | `pnpm check:coverage` | `coverage: 100% — all 288 register rows accounted for (0 unaccounted).` + `8 status-drift row(s)` | **PASS** |
| seed | `pnpm check:seed` | `SEED-1 hash verified` | **PASS** |
| acceptance spine | `pnpm test:acceptance` | **not run** — 4 of the 5 spine files live in `workers/api` / `workers/mcp` | **BLOCKED — `workerd`** |
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

#### The twelve suites that did run

`pnpm test` is BLOCKED as a whole, so each runnable suite was run directly. **1,470 assertions across
116 files, zero failures, zero skips.**

| Suite | Files | Tests |
|---|---|---|
| root tools (`pnpm test:tools`) | 18 | 410 |
| `@shuddl/command` | 17 | 95 |
| `@shuddl/driver` | 8 | 41 |
| `@shuddl/portal` | 13 | 80 |
| `@shuddl/adapters` | 3 | 38 |
| `@shuddl/agents` | 10 | 217 |
| `@shuddl/contracts` | 14 | 273 |
| `@shuddl/design` | 2 | 9 |
| `@shuddl/driver-core` | 4 | 37 |
| `@shuddl/edi` | 5 | 33 |
| `@shuddl/map` | 10 | 83 |
| `@shuddl/rater` | 12 | 154 |
| **total** | **116** | **1,470** |

**This total is not `pnpm test`.** The six absent suites — `packages/ledger`, `workers/api`,
`workers/agents`, `workers/billing`, `workers/mcp`, `workers/translator` — are exactly the ones that
exercise the ledger, the sequencer DO, the gates, the queues and the API surface. A green above says
nothing about any of them.

Observation, not a defect: `pnpm test:tools` emits five `fatal: not a git repository` lines on stderr.
They originate in `tools/checks/invariants.test.ts:33`, which spawns the invariants CLI inside
non-git temp directories with stderr piped through to the parent; the checker's `committedLock()`
fallback (`tools/checks/invariants.ts:420-426`) is designed to return `{}` in exactly that case. All
410 assertions pass. Cosmetic noise; recorded here so the next reader does not re-diagnose it.

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
(`PROJECT-STATE.md:19-27`, `:172-179`; hold H9 below). The BLOCKED verdict is right; the sentence
"there is no deployed environment" is the tool's, and it is about this checkout.

`deploy-preflight` is the informative one: it **executed** 71 checks against staging and returned 12
unsatisfied prerequisites — 5 × `placeholder-resource-id` (all-zero D1 UUIDs on `PLATFORM_TENANT_DB`,
both `TENANT_POOL_*`, `shuddl-billing-staging.PLATFORM_TENANT_DB`, and a malformed mcp `GRANTS` KV id),
4 × `missing-secret` (`JWT_SECRET`, `RESEND_API_KEY`, `STRIPE_WEBHOOK_SECRET`,
`PLATFORM_INTERNAL_SECRET`), `no-origins`, `tsa-unconfigured`, `no-backup`. It also prints the
qualifier that governs how to read all of it:

```text
preflight: no --state supplied — account-side facts (secrets, origins, sender, TSA, backups) are UNPROVEN and therefore blocked.
```

That is **unproven**, not necessarily **absent** — on staging some of those secrets are in fact bound.
The fourth release gate, `backup-manifest`, is a statically declared hold (`run-gate.ts:79`): nothing
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
| H1 | **`workerd` wedged** — 127 processes in `UE`, `kill -9`-proof | 6 suites, `pnpm test`, `test:acceptance`, `verify:dev`, `verify:merge`, `verify:release` — i.e. **the authoritative merge gate cannot be run at all** | a machine reboot | on-call / founder |
| H2 | **Task 1 `anchors/run` fix unverified here** — sound on diff and three review rounds, never observed green | the `FIXED †` in `GO-LIVE-CHECKLIST.md` stays daggered | H1. Re-run `pnpm -F @shuddl/ledger test` and the `workers/api` suite after reboot | backend |
| H3 | **`IDENTITY_DENYLIST` unset** | `check:identity` (REQ-167) | the CI secret, or a gitignored `.identity-denylist.local`. Fails **closed** in CI, open locally | founder |
| H4 | **9 engagement fixtures not vendored** | `check:fixtures`, `check:rater-parity`, `check:invoice-parity`, `check:concierge-parity` — and with them the WP-04/06/07 DoDs | the engagement-workspace config pack (outside this repo by REQ-167) | founder |
| H5 | **Staging + prod resources are placeholders** — 5 staging all-zero ids, measured here; 19 prod, carried from `GO-LIVE-CHECKLIST.md` at `72b2fc2` and **not re-measured in this sweep** (re-measured 2026-07-27 at `79ae54d` — still 26 blocks, 19 of them placeholder ids, 17 D1 + 2 KV: § *Tip verdict*) | `deploy-preflight`, and every field row above | provisioning, then pasting the returned ids | infrastructure |
| H6 | **Secrets unproven / unbound** — 4 on staging, measured here. Read as *unproven*: with no `--state`, the gate cannot see a secret that is in fact bound | `deploy-preflight` | binding on prod; a `--state` snapshot to prove staging | infrastructure |
| H7 | **No CORS origins, no TSA endpoint** | `deploy-preflight`; anchors stay UNANCHORED (never faked) | real deploy origins; an `integrations` row `kind='tsa'` + the F1 CONFIRM | backend / infrastructure |
| H8 | **No backup exists** | `backup-manifest`, `restore-verify`, field rows 5 and 6 | `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | infrastructure |
| H9 | ~~**Nothing is deployed**~~ **Superseded 2026-07-27 (final cross-task review) — the correct claim is narrower: THE GATE CANNOT SEE A DEPLOYMENT.** `SMOKE_API_BASE` is unset **in this checkout**, so `staging-smoke` has no base URL to drive and returns BLOCKED. That verdict is correct and stands. It is **not** an observation about the account: `shuddl-api-staging` and `shuddl-agents-staging` **are** deployed, a smoke has driven a gated stop over HTTPS through `pod.signed` to a penny-exact `invoice.issued` (first green run 55,800¢), and the deployed Biller sends **real** evidence email from `pod@send.shuddl.tech` on a live `RESEND_API_KEY` — `PROJECT-STATE.md:19-27`, `:172-179`. **Read it as a live environment**: do not seed, replay, or re-enable `EVIDENCE_FROM` on the belief that nothing can leave the box | `staging-smoke`, field rows 3, 4, 7 | `SMOKE_API_BASE` + a staging JWT secret bound **here** (field rows 4 and 7 additionally need the three undeployed workers, two provisioned tenants, and a device) | infrastructure |
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
| tools suite | `pnpm test:tools` | **18 files, 410 tests passed**, 0 failed, 0 skipped | **PASS** |
| traceability | `pnpm check:traceability` | `traceability: no orphans in either direction (active: WP-01 … WP-16)` | **PASS** |
| coverage | `pnpm check:coverage` | `coverage: 100% — all 288 register rows accounted for (0 unaccounted).` + `8 status-drift row(s)` | **PASS** |
| a11y | `pnpm test:a11y -- --mode merge` | `{"gate":"a11y","status":"PASS","executed":true,"assertions":4,"detail":"4 passed"}` | **PASS (4)** |
| e2e | `pnpm test:e2e -- --mode merge` | `{"gate":"e2e","status":"PASS","executed":true,"assertions":6,"detail":"6 passed"}` | **PASS (6)** |
| visual | `pnpm test:visual -- --mode merge` | `{"gate":"visual","status":"PASS","executed":true,"assertions":5,"detail":"5 passed"}` | **PASS (5)** |
| perf:map | `pnpm perf:map -- --mode merge` | `frames=401 p50=10.00ms p95=10.80ms`; `interaction p95=21.80ms over 12 pan/zoom samples`; `operating-window long tasks = 0, worst = 0.00ms` | **PASS (1)** |
| preflight (staging) | `pnpm exec tsx tools/deploy/preflight.ts --env staging` | `preflight: BLOCKED — 12 unsatisfied prerequisites. This is not a green.` — 5 `placeholder-resource-id` / 4 `missing-secret` / 1 `no-origins` / 1 `tsa-unconfigured` / 1 `no-backup` | **BLOCKED — as recorded** |
| preflight (prod) | `pnpm exec tsx tools/deploy/preflight.ts --env prod` | `preflight: BLOCKED — 26 unsatisfied prerequisites. This is not a green.` — 19 / 4 / 1 / 1 / 1, same split | **BLOCKED — as recorded** |

**Fifteen gates PASS and both preflights BLOCK at exactly the counts the ledgers claim.** No hold
cleared, none was added, no verdict changed from the `c09d9a5` sweep.

**What this note does NOT re-prove, stated as plainly as the sweep states it:**

- **The six `workerd` suites are still BLOCKED.** H1 is unchanged — nothing was rebooted, so
  `packages/ledger`, the five `workers/*` suites, `pnpm test`, `pnpm test:acceptance`, `pnpm verify:dev`,
  `pnpm verify:merge` and `pnpm verify:release` were not attempted here either. This SHA still proves
  nothing about the ledger, the sequencer, the gates, the queues or the API surface, and still carries
  **no evidence record at all**.
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
