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
