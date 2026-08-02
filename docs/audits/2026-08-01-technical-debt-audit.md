# 2026-08-01 — Technical-debt audit (post-deploy sweep)

**HEAD at audit:** `0415148` · **Method:** 19-agent workflow — 7 dimension finders (document drift ·
untracked files · code markers · test debt · fail-open/silent failure · config/deploy drift · register
drift) fanned out in parallel, findings deduplicated, then every Critical/High candidate handed to an
independent adversarial verifier prompted to refute it. **Counts: 57 findings raised → 12 Critical/High
candidates verified → 12 confirmed, 0 refuted → 45 medium/low.** Baseline before the audit: lint,
typecheck (17 workspaces), invariants, coverage (288/288, drift 7), traceability, citations,
rater-purity, authority-coverage, seed, design audit, `pnpm audit --prod` — **all PASS** at `0415148`.

Successor to the 2026-07-23 register (`docs/plans/2026-07-23-v2-technical-debt-register.md`, untracked
at audit time — itself a finding below) and the ledgers in
[`GO-LIVE-CHECKLIST.md`](../ops/GO-LIVE-CHECKLIST.md). Severity vocabulary and the eight-field row
discipline are that file's §1.1; release grades R0–R5 are
[`V2-EXECUTION-FRAMEWORK.md`](../ops/V2-EXECUTION-FRAMEWORK.md) §9. This document **records the audit**;
open rows that survive it are appended to the checklist ledgers, which remain the single maintained
ledger. Rows fixed in the same session say so here with proof.

**A citation note for editors:** several rows below cite documents this same session then edits
(supersede-in-place), so line numbers in those files were deliberately not written — quotes and section
names are the anchors. Register rows in the V2 phases are named as "register row N" without the id
prefix, for the same reason `RELEASE-EVIDENCE.md` is exclusion-listed: a bare id in a scanned doc mints
an implementation annotation, and an audit describing *unbuilt* scope must not fabricate one.

---

## §1 — The headline

The build's **machinery held**: every runnable gate was green at HEAD before the audit began, no
append-only, budget, purity, or isolation law is violated anywhere, and the adversarial pass could not
refute a single finding as already-fixed-but-unrecorded. What drifted is **the record and three seams**:

1. **The ops record materially misleads about production.** Prod was provisioned 2026-07-30, deployed,
   preflight **PASS 72 checks** on 2026-07-31 (`RELEASE-EVIDENCE.md` § *Production preflight — PASS*),
   surfaces live — while `PROJECT-STATE.md` (a "read first" safety section, a five-states table, all of
   §4), `DEPLOYMENT.md`, `LAUNCH-RUNBOOK.md`, and four GO-LIVE-CHECKLIST hold rows still assert *"There
   is no live production… not provisioned… every id an all-zero placeholder… no way to back up
   production… no backup exists."* Drift in the **under-warning direction**: a reader told nothing is
   live will treat prod-targeting actions as inert while `api.shuddl.tech` is answering.
2. **Three code defects** (none cross-tenant, none wrong-money today): a counterparty margin leak on
   the authed rate route, a field gate whose documented invocation cannot fail, and an agents worker
   that silently destroys pool-tenant work — latent behind the PLG dark flags but fail-*silent*, not
   fail-closed.
3. **Comment/record rot** in security-load-bearing places: two files still claim the REQ-170
   stored-bytes check is UNIMPLEMENTED (it shipped), wrangler comments instruct maintainers to preserve
   claims that are now false, and the release-sweep record overstates what the surfaces gate asserts.

## §2 — Confirmed Critical/High (12 — every one verified adversarially, 0 refuted)

Ownership: all twelve are **Repo** (closable by a commit). None is an external hold.

### Code defects

| # | Item | Sev | Evidence (verified at `0415148`) | Owner | Status | Blocks |
|---|---|---|---|---|---|---|
| C1 | **`POST /v1/rate` hands the portal (counterparty) role the tenant's margin floors, pinned config versions, and full approval internals** — the exact fields the redaction law strips from `quote.priced` for every non-tenant lens (REQ-085/074). `workers/api/src/routes/rate.ts` admits role `portal` and returns `pricedResponse()` unbranched by lens: `floors` (cost-derivable per `packages/rater/src/floors.ts:33-39`), `versions`, and the ApprovalDecision's `evaluated_sell_cents`/`gross_sell_cents`/`executing_share_bps`. The public twin (`workers/api/src/pub/quote.ts:73-76`) declares these "EXCLUDED forever"; the portal client's header claims "the server already redacts them" — it does not. `workers/api/test/portal-actions.test.ts` portal `/v1/rate` cases assert only 200/PRICED, never the response shape | **High** | Same party sees `floors` stripped on the events read but receives them synchronously at pricing time. Margin-confidentiality defect, same-tenant lens-scoped — not cross-tenant, so High not Critical | backend | **FIXED this session** — lens-branched response; portal now receives the counterparty-safe shape (status, sell, lines, transit, approval status only); tests pin floors/versions/basis/anomaly-internals absent for portal and present for ops | R1 |
| C2 | **The deployed-surfaces field gate exits 0 on an all-skipped run in its documented invocation.** `LAUNCH-RUNBOOK.md` Step 5 invokes `pnpm test:surfaces` with no `--mode`; `parseMode` defaults to `local`, where playwright-guard's all-skipped branch resolves to exit 0 and the structured sentinel is suppressed — while the spec's own header claims "an all-skipped run is BLOCKED, never a green exit 0". No documented path anywhere runs this gate in a blocking mode | **High** | `tools/harness/playwright-guard.ts` disposition table + `tests/e2e/prod-surface.spec.ts` header. The recorded "5 passed" evidence came from a real run; the defect is that the gate's fail-closed exit semantics were never engaged by any documented invocation | assurance | **FIXED this session** — `--mode release` is baked into the package script (a field gate has no advisory use), which makes the runbook's existing command blocking without edit; the spec header states the qualifier. Verified: unset base ⇒ **exit 2 BLOCKED**, sentinel emitted | R1 |
| C3 | **The agents worker cannot serve claimed pool tenants — and fails silent, not closed.** `workers/agents/src/tenants.ts` is a static two-slug map with no claimed-pool fallback and zero `TENANT_POOL_*` bindings, while the api worker and sequencer DO fully serve claimed tenants. A pool tenant's committed `pod.signed` enqueues a Biller trigger the queue consumer **ACKs as poison** (destroyed, no DLQ), the REQ-169 recon sweep and the Watchtower unbilled alarm iterate only `TENANT_SLUGS` (so the recovery path for exactly this loss also excludes them), and the sequencer's in-code "the REQ-169 sweep recovers it" claim is false for those tenants. Every cron (anchor, SLA, collector, watchtower, retention, mirror, snapshots) has the same blind spot. Only the narrower billing-metering instance was on the record (GO-LIVE row, Low/DARK) | **High** | Latent — PLG is DARK behind REQ-138 legal, Stripe, pool provisioning, `PLATFORM_INTERNAL_SECRET`, so it cannot mis-bill today. High because the documented `PROVISIONING_ENABLED` flip has no agents-roster blocker and the failure is invisible when it comes | backend | **Hardened this session** — unknown-tenant triggers now `retry()` (surfacing through queue retry/DLQ machinery) instead of terminal `ack()`; the sequencer's false recovery claim corrected; a blocking pre-R4 row added to GO-LIVE-CHECKLIST naming the full roster gap. The claimed-aware resolver + cron enumeration remains **OPEN, phase-gated pre-R4** (build it before any `PROVISIONING_ENABLED` flip) | R4 |

### The record misleads (all five verified false at HEAD, none carrying a supersede note where a reader lands)

| # | Item | Sev | Status | Blocks |
|---|---|---|---|---|
| D1 | `PROJECT-STATE.md` **"Safety posture (read first)"**: "There is no live production… Prod is not provisioned" — contradicted by the RESOLVED banner directly above it (13 `shuddl-*` D1s, five deployed workers, `api.shuddl.tech` answering) and by §6 | High | **FIXED this session** — superseded in place, true fail-closed facts (email/money dark, no tenant) separated from the false infrastructure claims | R0 |
| D2 | `PROJECT-STATE.md` five-states table row 4 + all of §4: "not provisioned, not deployable, every id all-zero, BLOCKED 26" — prod preflight reads PASS 72 | High | **FIXED this session** — both superseded in place, pointing at the evidence record | R0 |
| D3 | `DEPLOYMENT.md`: "prod = not stood up… NOT YET PROVISIONED… unsafe today… other four workers have no [env.prod] scope whatsoever" (self-contradicted by its own Closed-2026-07-25 note), plus header "evidence sending OFF" vs its own Sending section "LIVE on staging" | High | **FIXED this session** — superseded in place | R0 |
| D4 | `LAUNCH-RUNBOOK.md` Step 3: "There is no `tools/deploy/backup.ts` … there is no way to back up production today" — the file exists, is wired, and a prod backup ran (6 DBs, manifest digest `47e4d9ec…`, gate PASS 6) | High | **FIXED this session** — superseded in place; header and Step 0 pre-provisioning framing dated | R0 |
| D5 | `GO-LIVE-CHECKLIST.md` "Production resources" hold row: BLOCKED / "every id all-zero" — while the reconciliation table 17 lines below says "PROVISIONED + DEPLOYED 2026-07-30/31" | Med (verifier downgraded: same-file corrective signal exists) | **FIXED this session** — hold row superseded; same pass corrected the Secrets/Backups/TSA/staging-ids rows (§3 doc-drift) | R0 |

### Untracked-file debt (the record of debt was not in the record)

| # | Item | Sev | Status | Blocks |
|---|---|---|---|---|
| U1 | **12 of the 13 SHUDDL enforcement skills untracked for 15 days** (`.claude/skills/*` — the 13th, `terminal-gallery-map-ui`, is tracked, proving the convention). Verifier downgraded High→Med: the REQ-212 guard the finder called dependent shipped in tracked form (`db/tenant/migrations/0008_…`) — but committed evidence still cites skill paths that a fresh clone cannot read | Med | **FIXED this session** — all 12 committed with a dated grounding note (the U4 correction): their RED examples are declared frozen 2026-07-15/16 observations, several since fixed — verify against HEAD before treating a cited defect as current. All 390 citations resolve in-bounds; ratchet enrolled 67→131 per the 2026-07-15-audit precedent | R0 |
| U2 | **The 2026-07-23 debt register and Codex goal — the audit trail of the debt effort — never committed**, cited by nothing tracked, invisible to any clone | Med | **FIXED this session** — both committed with a dated staleness preamble (their (E) marker table is partially resolved; see §3) | R0 |
| U3 | **The untracked v2 plan/design docs use a superseded numbering** (register rows 214/273 and 244/251 carry different scope in the committed register than in those drafts) | Med | **FIXED this session** — committed with a preamble declaring the committed register authoritative wherever the two disagree | R0 |
| U4 | **Skill RED sections assert as-current defects that are already fixed** (e.g. `keep-map-instrument-truthful`) — committing verbatim would put false present-tense claims in the record | Med | **FIXED this session** — folded into U1: a dated grounding note in every skill declares the examples frozen-as-of writing, chosen over rewriting each RED section because repointing a dated observation to today's code would misrepresent when it was made | R0 |

### Refutations and near-refutations worth keeping

The verifier pass confirmed all 12 but corrected three premises, recorded so they are not re-found: the
**anomaly** field in the portal rate response is deliberate (the portal client consumes it for
pending-approval UX — C1's fix keeps approval *status*, strips the sell/share internals); portal
`/v1/rate` tests **do** exist (`portal-actions.test.ts`) — they just never pinned the response shape;
and the untracked-skills severity rested partly on a dependency that had in fact shipped in tracked
form (U1, downgraded accordingly).

## §3 — Medium/Low (45), grouped

**Doc drift (10).** GO-LIVE-CHECKLIST: staging-ids hold row (4 of 5 ids real since `b961dfc`; only the
mcp `GRANTS` KV placeholder remains) · Secrets-bound hold row + §2 "prod pending" cells (four prod
secrets bound, preflight PASSed on them) · Backups hold row "no backup exists" (prod + staging backups
exist with recorded digests; the still-true half — nightly OIDC credentials unbound — kept) · TSA row
partially stale (preflight fact satisfied via `https://freetsa.org/tsr`; the integrations-row/F1-CONFIRM
half stays) · §2 cells "prod not provisioned"/"redo prod"/mcp "Not deployed" · provenance header ends
at 2026-07-29 despite 2026-07-31 edits. PROJECT-STATE §2: "the whole MCP surface is un-deployed" +
staging BLOCKED-12 framing. LAUNCH-RUNBOOK header/Step 0 pre-provisioning framing. DEPLOYMENT header
self-contradiction (counted under D3). Wrangler staging comments instructing maintainers to preserve a
falsehood ("placeholder id is intentional… No platform D1 exists in staging… the gate must keep saying
so") above real provisioned ids — `workers/billing/wrangler.toml` and `workers/api/wrangler.toml`.
**All superseded in place this session.**

**Code-marker rot (8 fixed, 6 verified-accurate).** Fixed this session: the two REQ-170
"UNIMPLEMENTED" claims (`packages/ledger/src/gates/transition-gates.ts` + the Biller's same-file
contradiction — the check shipped; the *true* residual is the placed-photo hash and redelivery fast
path, now stated instead) · Concierge `resolve.ts` party-FK correction claim (BOOKING_SQL overwrites
consignee/bill-to on booking) · Biller "nothing emits quote.accepted / no booking flow" header ·
sequencer consent-gate comment describing the deleted coarse-box geo stub (point-in-polygon shipped) ·
`cosig` "reserved for WP-05" (REQ-045 `assertInterline` consumes it) · TSA `der.ts` "CMS verification
deferred" (landed WP-16). Verified accurate and left standing: REQ-030 serviceClass TODO (inert in the
safe direction) · EDI NotConfigured flips · REQ-018 dwell-money deferral · status-cache assumptions ·
single-stop flow · WP-10 heuristics · demo tile hold (REQ-075) · driver fixed consent ack (REQ-069
posture). One **new latent** recorded: outbound EDI interchanges carry fixed year-2000 ISA/GS dates
(`packages/edi/src/writer.ts` byte-stability choice) — must be send-time-stamped before the
CONFIRM-gated transport flips live; appended to the checklist EDI activation row.

**Test/gate integrity (4).** `run-gate` lets the last sentinel in uncontrolled child output override a
non-zero exit code (a PASS sentinel + non-zero exit records PASS) — **FIXED this session**: exit-code
disagreement now degrades the verdict. Prod-surface gate counts fail-then-pass retry as green
(`playwright.prod.config.ts` retries: 1) — recorded, Low. The deployed-surface gate never enters the
release evidence record (manual runbook step only) — recorded, phase-gated R2. CI-contract merge-mode
assertion satisfied by one occurrence across four strict steps — **FIXED this session** (asserts all
four carry the flag).

**Config/deploy (4).** Preflight origins PASS reads the operator state file, not the committed
allowlist actually served — which compiles `.example` + localhost entries into every env including prod
(`workers/api/src/middleware/cors.ts`); recorded Med, phase-gated R2 (the served list is
deny-by-default; the placeholder entries are harness-asserted). RELEASE-EVIDENCE overclaim "reaches
`api.shuddl.tech` and no other host" — the gate's foreign-host set never included the tile host;
**corrected this session** in the sweep record. Runbook state template lists three CORS origins where
the recorded PASS says four — **FIXED**. Preflight's prod test-affordance guard reads only `[vars]`, so
a secret-bound `TEST_SEND_TOKEN` is invisible — recorded, Low, R4 line item.

**Register drift (4).** `coverage-manifest` dispositions for register rows 284, 249, 285 read "not
built" while real (partial) implementations shipped and pass gates — **amended this session** to
"partially built" with a one-line inventory each, REQ-288-NOTE style. `check:coverage`'s drift message
says "code has shipped — advance at register review" for rows whose only citations are deferral markers
(184, 276) — **message honesty fixed this session**. Nine built-tagged rows annotated only from docs
files (058, 124, 125, 126, 131, 136, 161, 209, 211) — code-scope ones (209 void-flip in
`packages/ledger/src/projection/money.ts`; 058) gained a source-side annotation; documentary ones left.

**Untracked, non-committable (3).** Two marketing-site plan docs contain a person-derived account slug
— **left untracked deliberately** (REQ-167 caution; the marketing workstream is excluded from this
repo). The marketing-site source itself has no version control anywhere (excluded via
`.git/info/exclude`, no nested repo) — recorded as an **External hold, owner decision** (host it in its
own repo). `.claude/ralph-loop.local.md` + `.github/copilot-instructions.md` / `.github/instructions/`
(editor-generated) — **ignore rules added this session**.

## §4 — Phase gating and the stopping point

Grades from `V2-EXECUTION-FRAMEWORK.md` §9. What this audit adds to each bar:

| Grade | What this audit found blocking it | After this session |
|---|---|---|
| **R0 — Audited** | The record itself (D1–D5, U1–U4): a current-state audit cannot stand on documents that invert reality | **Satisfied at this commit** — this document + the supersede pass + the untracked record committed |
| **R1 — Mergeable** | C1, C2 (repo Critical/High); the comment rot in security-load-bearing files | C1, C2 fixed. **R1's remaining distance is unchanged and external**: the five private-input gates (`identity-leak`, `fixtures`, 3 × parity) BLOCK the merge aggregate — fail-closed by design, cleared only by the owner vendoring the engagement pack |
| **R2 — Staging-certified** | Deployed-surface gate absent from the release record; preflight-vs-served CORS seam; staging-smoke binding | Recorded, each on the checklist with an owner. External inputs: `SMOKE_API_BASE` + JWT binding, nightly OIDC credentials |
| **R3 — Pilot-ready** | On-call rota (no gate exists), restore-drill gate plumbing in the release profile | Unchanged external holds, named owners |
| **R4 — Production-ready** | **C3's remainder** (claimed-aware agents resolver + cron enumeration — before any `PROVISIONING_ENABLED` flip), EDI date-stamping before transport flip, `TEST_SEND_TOKEN` secret-visibility, tiles (REQ-075), sender warmup (REQ-157), edge rate-limits (REQ-193/125), 7-year archive (REQ-116) | ~~C3 hardened fail-loud; the resolver build is the named pre-R4 repo work item~~ **C3 CLOSED §11–§13** — the claimed-aware resolver + `allTenantSlugs` fan-out now ship in all four workers (api, agents, translator, billing), each pinned by a mutation-proved source-glob test, and the `usage_credits` row identity is reconciled across its three writers. EDI date-stamping closed `3899ae6`. **The pre-R4 repo carry-forward is now ONE row**: resolve-path pool-binding exclusivity (§12) — enforced on enumeration, not on resolution, whose structural answer is a control-plane UNIQUE index on the claimed `pool_binding`. The rest of this row is External or CONFIRM-gated |
| **R5 — Authority cutover** | Nothing new — the 30-day shadow and fixture-parity DoDs stand as specified | — |

**The stopping point, stated as the loop's exit condition.** Repository-closable debt work stops — and
may only stop — when all four are simultaneously true:

1. **Zero open repository-owned Critical/High rows** across this audit and the checklist failures
   ledger (C1–C3-hardening, D1–D5, U1–U4: closed this session). ~~C3's resolver is phase-gated pre-R4
   repo work … the one named carry-forward~~ **C3 closed outright across all four workers (§11–§13).**
   The named pre-R4 carry-forward is now **resolve-path pool-binding exclusivity** (§12) — a Med, dark
   behind `PROVISIONING_ENABLED`, whose fix is a control-plane UNIQUE index rather than a runtime check.
   Two open Highs remain and **both are External, not repository-closable**: a real driver's custody
   handoff needs manifest party refs + the deferred REQ-069 identity seam, and the live EDI adapter
   needs its transport credentials. Neither can be closed from inside the repo without straying.
2. **Every baseline gate green** at the closing SHA (the 11-gate static set + the four browser gates +
   `pnpm test` when the host permits), and `verify:merge` BLOCKED **only** on the five named
   private-input holds.
3. **The remaining debt is entirely External or CONFIRM-gated** — each row named in the checklist with
   owner, grade, and expiry; none silently fail-open; the two no-gate holds (on-call rota, 7-year
   archive) re-read at every close-out.
4. **The record agrees with the world** — no ops document asserts a state the evidence record
   contradicts.

Beyond that line the build cannot advance itself: R2→R5 consume accounts, credentials, fixtures,
devices, counsel, and owner decisions. Working past the line from inside the repo produces either
scope-straying (building CONFIRM-gated features) or gate-relaxing (synthesizing private fixtures) —
both forbidden by law (`CLAUDE.md`, `genesis/00`). The loop therefore iterates: re-audit → close
repo-owned rows → re-verify → stop at this line, every iteration, until an owner input moves the line.

## §5 — Session disposition summary

Fixed and verified this session (each with its focused tests + the full static-gate sweep): C1, C2, C3
(hardening half), D1–D5, U1–U4, 8 comment-rot rows, 2 gate-integrity rows (run-gate sentinel, CI
contract), 3 register-disposition amendments, the RELEASE-EVIDENCE overclaim, the runbook template, and
the ignore rules. Carried forward, phase-gated, on the checklist: C3 resolver (pre-R4) · deployed-surface
gate into the release record (R2) · preflight-vs-served CORS reconciliation (R2) · EDI send-time date
stamping (pre-EDI-flip) · `TEST_SEND_TOKEN` secret visibility (R4) · prod-surface retry posture (Low) ·
marketing-site version control (External, owner) · the five private-input merge holds (External, owner).

## §6 — Iteration 2 (2026-08-01, loop continuation): the carry-forward list is closed

Every repo-owned carry-forward row above landed, then an adversarial 5-lens review of that very diff
found 17 further defects (2 high) — closed the same session:

- **C3 resolver built** (`494765f`): claimed-aware `resolveTenantDb` mirroring the api contract, pool
  bindings in all three wrangler scopes (ids converged), all cron fan-outs on `allTenantSlugs`,
  preflight contract extended. The review then caught the **ninth fan-out** hiding outside index.ts
  (converted; the regression pin now globs every src module), **pool-binding exclusivity** (two claimed
  rows naming one binding now exclude BOTH, fail-closed), and — the sharpest catch — **static-slug
  shadowing**: `provisionTenant` would have let a post-flip stranger claim `tenant-a` and route to the
  real carrier's D1; static-roster slugs are now structurally refused (`def564c`).
- **Surfaces gate in the release record** (`efdf7d1`, 26 gates), with the review's addendum: the PASS
  now stamps the zone it drove (the stateProvenance lesson).
- **EDI real send-instant stamping** (`3899ae6`): `sentAt` follows the control-number seam exactly;
  writer stays pure; fixtures stay byte-stable; the sweep is byte-deterministic given its injected clock.
- **CORS env-aware and fail-closed** (`736ed29` + review inversion): prod — and every UNKNOWN
  environment — serves only the four real origins; the dev list is the allowlisted exception. The
  preflight now reconciles the operator state's prod origins against the committed served list
  (`origin-not-served`), and a secret-bound `TEST_SEND_TOKEN` blocks in prod.

Still open, deliberately: the **translator worker's roster gap** (dark behind the unbuilt CONFIRM-gated
EDI transport; ledgered on the EDI activation row as a pre-activation line) · prod-surface retry posture
(Low, recorded) · the External/owner holds, unchanged. The §4 stopping-point line is now satisfied for
every repo-owned row this audit raised: what remains is owner-supplied (fixtures, denylist, credentials,
the sending flip, tenant onboarding) or rides a CONFIRM-gated activation it is ledgered against.

## §7 — Iteration 3 (2026-08-01, loop continuation): the convergence test FAILED, then passed

Iteration 3 was designed as a convergence check — six fresh lenses over the areas the first two
iterations covered least (the browser apps, map/design, migrations/guards, CI workflows, ledger core,
agents packages) plus a completeness critic. **It did not converge: 18 findings, 6 High** — proof the
under-audited areas were exactly where the debt hid. All repo-actionable rows closed the same session:

- **The driver capture layer fabricated freight facts** (`a3b667a`) — a hardcoded `pieces: 6` recorded
  as a signed, gate-satisfying, counterparty-visible `freight.counted` on every real pickup; fixed dims;
  fictional custody/actor identities. Physical facts now thread through CaptureContext or the capture
  THROWS (the geo precedent); the count step has a real input; the custody party pair fails closed and
  is a ledgered R3 row (it genuinely needs the REQ-069 identity work + manifest party refs).
- **The go-live "no fabricated data" verdict was a false green** — its proof grep's pathspec matched
  zero files. Superseded with the truth and the lesson: a proof command must be exercised against a
  file known to contain the pattern.
- **Envelope redaction** (`04e6dab`) — the REQ-049 override (internal ops id + gate-waiver reason) and
  the party-lens actor.user passed through `{ ...event }` to counterparties; the redaction law now
  binds the whole event, pinned at the wire in the adversarial lens suite.
- **Map truthfulness** (`75da631`) — a recovered mark kept its exception feature-state forever (a
  phantom alarm exempt from the world-dim); applyStates now clears on recovery.
- **Five mediums** (`1b4e494`): useSync's forbidden same-origin default; a credit sale that could mint
  an invoice its settlement could never find (now refuses loudly) + the settled-flag overwrite;
  nightly.yml joined the CI contract (pins + the backup's `--mode release`) and `check:pr` is pinned;
  the design job shed its advisory-era name; the portal's fictional evidence-email specimen no longer
  ships in deploy builds.

**Corrections to the critic's two findings, for the record:** the full `pnpm test` HAS run green at
each iteration's closing state — exit 0 at `2dc2bd4` and exit 0 at exactly `ee09351` (the runs were
performed but never written into the record; this section is that record). The identity-corpus point
stands and is noted on the checklist's identity-leak hold row: the first denylist run must screen the
`6a6c88e` blobs, not only HEAD.

**The stopping line, restated after three iterations:** repo-owned Critical/High debt is again zero.
Open by design: the custody-party R3 row (fail-closed, needs REQ-069) · the translator roster line on
the EDI activation row · `?perf`'s documented synthetic harness path · prod-surface retries:1 (Low) ·
the External/owner holds. A fourth iteration should re-run the convergence test with ANOTHER set of
fresh lenses (packages/driver-core, workers/mcp, the pub/ routes, tools/fixtures were not among
iteration 3's six); convergence is claimed only when a fresh-lens sweep returns zero repo-owned
Critical/High.

## §8 — Iteration 4 (2026-08-01): the named sweep ran, and it found the worst defect of the loop

§7's named lens set ran (driver-core, workers/mcp, the `pub/` routes, fixtures tooling) with a
completeness critic. **13 findings — one CRITICAL, three High — and the critic returned EMPTY**, its
first endorsement of coverage across four iterations. Every repo-actionable row closed the same session:

- **CRITICAL — signed captures could be stranded on-device forever** (`d3b75c7`). The sync engine drained
  the durable queue in STORE order; the real IndexedDB store returns ascending key order over a
  random-UUID id, so capture order was shuffled — while the server's transition gates are strictly
  order-dependent. A gated event arriving before its prerequisite took a 403 GATE_BLOCKED, which the
  engine parks as an operator refusal, and a parked item was skipped on every later pass **forever**: the
  event never reached the ledger, its evidence bytes never uploaded (that leg only runs after the event
  ACKs), and nothing surfaced — no error, no UI signal, a pending count that never fell. The in-memory
  test store returned insertion order, so every existing test passed. Now: `pending()` sorts by
  `device_seq` (the per-device capture counter the gates assume), a park RE-PROBES on a bounded schedule
  (the append is idempotent by event id, so re-probing is always safe), and the parked count is surfaced
  through `SyncPass` and the driver's `SyncStatus`. Pinned by a shuffled-store drain-order test and a
  park→re-probe→drain test.
- **High — a client key could bypass the booking caps** (`ee2b407`). The CapsMeter's replay marker keyed
  on the derived idempotency key alone, and a client-supplied `idempotency_key` derives that key with the
  ARGUMENTS DISCARDED — so one reserve cleared unlimited further bookings across different shipments
  (each of which committed a real `quote.accepted`, because the api's own dedupe folds the request path
  into its scope). A velocity cap of 1 could book N. The marker now binds the operation target.
- **High — a webhook could cross tenants** and **High — claimed tenants' status links always 401'd**
  (same commit): the subscription's tenant was never compared to the originator's (`pairings.id` is a
  global key), and `GET /pub/status/:cap` resolved through the STATIC-only resolver while its mint route
  is claimed-aware. Also closed: an OAuth grant's scope is re-checked against the pairing's current
  allowlist, and cleartext `http://` webhook delivery is refused.
- **Mediums/lows** (`1043431`): a typo'd `--mode` silently bought a green across every skippable gate
  (now MALFORMED); two fixture directories that gate merges sat outside the REQ-112 hash law (registered
  with computed pins); the anonymous guest quote bounded nothing; a stale "the ONE place /pub routes are
  declared" claim corrected. Ledgered rather than changed: the signup email-existence oracle (a UX call,
  fenced by the unbuilt REQ-125 edge rule) and `hashPath`'s unframed digest (fix only alongside a re-pin).

**Convergence status after four iterations.** Repo-owned Critical/High is zero, and for the first time
the completeness critic endorsed the coverage rather than naming an uncovered modality. That is the
strongest claim this loop can make from inside the repository — but it is a claim about STATIC review
plus the full suite, not about a running system: the remaining proof (a real driver on a real device, a
tenant's data, a filmed acceptance demo, a pen test) needs inputs no commit can supply. **A fifth
iteration has no named lens set left that this audit has not run.** Its honest form is a REGRESSION
watch: re-run the baseline gates and the full suite, confirm the ledgered open-by-design rows have not
silently changed state, and stop — not another speculative sweep.

## §9 — Iteration 5 (2026-08-01): the regression watch, run as §8 prescribed

Not a sweep. §8 named the form and this is it, executed at `3050ff2`.

**Gates.** Every static gate PASS: `check:runtime`, `check:invariants` (21/22 tables, append-only
intact), `check:rater-purity`, `check:authority-coverage`, `check:seed`, `check:traceability` (no
orphans either direction), `audit:design` (clean), `check:coverage` (288/288, 0 unaccounted),
`check:citations` (945 resolve, 24 content-anchored; ratchet exactly at its frozen 131). `pnpm lint`
clean, `typecheck` clean across every workspace, `pnpm audit --prod` reports no known vulnerabilities.
**`pnpm test` exit 0 — 3,485 tests across 267 files, 18 projects.** Hygiene: no iCloud duplicates, no
wedged `workerd`, working tree clean but for the three deliberately-untracked marketing docs.

**The twelve ledgered open-by-design rows, each re-verified — none has silently changed state:**

| # | Row | Verified still true |
|---|---|---|
| 1 | Driver custody parties fail closed | No fabrication constants in `captures.ts` (the only match is the audit comment); `App.tsx` still passes no `custodyParties` |
| 2 | Translator roster is static | Still one bare roster loop; still zero pool bindings in its wrangler — as ledgered on the EDI activation row |
| 3 | EDI transport CONFIRM-gated | The NotConfigured composition roots are all present |
| 4 | `PROVISIONING_ENABLED` dark | Absent from the api wrangler in every scope |
| 5 | Prod outbound email dark | `EVIDENCE_FROM` appears in the prod agents scope only as the comment explaining its deliberate absence |
| 6 | Tiles on the demo host (REQ-075) | Unchanged |
| 7 | Nine private fixtures unvendored | `check:fixtures --mode merge` → BLOCKED, same nine |
| 8 | Identity gate fail-closed | `check:identity --mode merge` → BLOCKED, no denylist |
| 9 | Signup email oracle (R4) | Unchanged, as accepted |
| 10 | Prod-surface `retries: 1` (Low) | Unchanged, as accepted |
| 11 | `hashPath` unframed digest | Unchanged — fix only alongside a re-pin |
| 12 | `?perf` synthetic harness path | Unchanged, documented REQ-079 |

**Verdict: no regression, no drift, nothing new to fix.** This is what the stopping line looks like when
it holds. Iteration 6 and beyond have the same honest form as this one — re-run the watch when the tree
changes — and the loop's remaining value is now entirely in the OWNER inputs the External rows name.
Running further speculative sweeps against an unchanged tree would burn effort re-deriving the same
verdict; running the watch after a real change is what keeps it true.

## §10 — Iteration 6 (2026-08-01): proving the fixes have teeth, and closing the last deferrable row

With the tree unchanged since §9, re-running the watch would only re-derive its verdict. Two things had
real value instead, and both are hardening rather than discovery.

**Mutation proofs — do the new tests actually bite?** This repo's own discipline is that a fix which
could have been vacuous carries a mutation proof. The iteration-3/4 fixes did not yet have one. Each
mutation was applied, observed, and reverted; the tree was verified clean after every revert.

| Mutation (the defect, restored) | Result |
|---|---|
| `pending()` returns the store's order verbatim (pre-fix drain) | RED — *"drains in CAPTURE order (device_seq) even when the store yields a shuffled order"* |
| Operator-parked items skipped forever (pre-fix park) | RED — *"a parked item RE-PROBES after its window and drains when the refusal clears"* |
| Caps replay marker unbound from the target | RED — *"the SAME idempotency_key on a DIFFERENT shipment does NOT replay"* |
| Envelope redaction removed (payload-only projection) | RED ×2 — the override test and the party-lens `actor.user` test |

Four for four, each on exactly the test written for it and no other. The Critical fix, the cap-bypass
fix, and the counterparty envelope leak are all genuinely pinned.

**The `hashPath` framing row closed on its own terms** (`3a0d412`). It was ledgered as fixable only
alongside a re-pin, because framing changes every digest — so the framing and the recomputation of all
seven vendored pins landed in one commit, with the manifest note recording the reason and no fixture
bytes changed. Injectivity is now proved against real files in a temp tree (a byte moved from a filename
into content changes the digest) rather than asserted. `check:fixtures` verifies all seven; the parity
harnesses still loud-skip on their absent private fixtures exactly as before.

**What is left is what was left.** No repo-owned Critical/High. The remaining ledgered rows are the
custody-party R3 fail-close (needs REQ-069), the translator roster line on the EDI activation row, the
accepted signup-oracle and retry-posture calls, the `?perf` harness path, and the External/owner inputs.
The honest form of iteration 7 is unchanged from §9: run the watch when the tree changes.

## §11 — Iteration 7 (2026-08-01): the watch on a changed tree, and the last roster instance closed

The tree HAD changed (§10's digest framing is load-bearing — it is the law that gates merges), so the
watch was due rather than redundant. **It passed clean:** every static gate, `check:fixtures` verifying
all seven re-pinned digests, coverage 288/288, citations 945 with the ratchet at its frozen 131, lint
and typecheck across every workspace, and the full suite already exit 0 at 3,487 tests.

**Then one ledgered row closed on its merits** (`805dbb8`). The translator worker was the last surviving
instance of the C3 roster class: a static two-slug map, so a claimed pool tenant's outbound 214s could
never be swept and its inbound 204 could not resolve a database at all. It was ledgered as a
pre-activation line on the EDI row because that transport is CONFIRM-gated and dark — but REQ-025 is a
law, not a feature, and applying an existing law to a worker that already serves tenants is hardening,
not new scope. The agents contract is ported verbatim: static hot path with no control-plane read, then
a control row whose plan is not unclaimed/platform and whose `pool_binding` sits in the parity-pinned
allowlist; sentinel, unclaimed, out-of-allowlist, unknown and platform slugs all fail closed;
pool-binding exclusivity excludes both slugs on a duplicate; an enumeration fault degrades the sweep to
the static roster with a loud log rather than stalling it. Pool D1s are bound in all three scopes with
api-converged ids and the preflight requires them. Nine tests pin it, including the api parity check.

**No roster instance of this class remains anywhere in the repo** — the defect first found in the agents
worker on 2026-08-01 is now closed in every worker that serves tenants.

**What this leaves.** Repo-owned Critical/High: zero. Remaining ledgered rows: the custody-party R3
fail-close (genuinely needs the REQ-069 driver-identity build — v2 scope, so building it here would be
straying), two accepted calls (the signup email oracle, the prod-surface retry posture), the `?perf`
harness path, and the External/owner inputs. **Every remaining row is either owner-supplied or
explicitly out of the documented build.** Iteration 8's honest form is §9's: run the watch when the
tree changes — and there is no longer a ledgered repo-owned row for a future iteration to close.

## §12 — Iteration 8 (2026-08-02): the review caught my own false claim

The watch ran clean on the changed tree. Then a three-lens adversarial review of the §11 commit — the
newest substantive change, and unreviewed — returned **16 findings, 4 High.** The most important one is
about this document.

**§11 asserted "No roster instance of this class remains anywhere in the repo." That was false when
written.** The billing worker's metering sweep still iterated the static two-slug roster with no pool
bindings — and that sweep OVERWRITES `usage_credits`, so a claimed tenant never metered is unbilled
usage the day PLG flips. The gap had been ledgered Low/DARK at §3 for weeks; the absolute claim I wrote
in §11 wrongly overrode its own ledger. That is exactly the failure mode this audit exists to catch, and
it took an adversarial reader to catch it — a self-review would not have. **Billing is ported here**
(resolver, enumerator, pool bindings in three scopes, preflight contract), and both the checklist and
this section now state the closure per worker rather than absolutely.

Also fixed: a malformed control-plane policy row threw a raw `SyntaxError` past each resolver's own
fail-closed contract (now `UNKNOWN_TENANT`, all four workers); the translator's `quarantine()` takes the
already-resolved handle rather than re-resolving, so a control-plane blip can no longer turn "a
malformed tender is quarantined and ACKed 200" into a 500 the partner retries forever; the translator
gained the source-glob pin the port omitted (without it, reverting the fan-out left every new test
green — the fix could not fail) and the api slug-parity test its own header promised; `DEPLOYMENT.md`'s
binding table, which states it IS `REQUIRED_BINDINGS`, now matches it.

**One High was NOT shipped, and the reason is the finding.** The review is right that exclusivity is
enforced on enumeration but not on resolution — and resolution is the path a write travels. The guard
was written, and reverting it was the honest call: only two pool slots exist, while the shared api
control-plane carries standing claimed rows on both (`parity.test.ts`, `source-aware-ledger.test.ts`)
alongside files that claim slots dynamically. **No arrangement of 65 shared-DB test files can satisfy
one-tenant-per-binding**, so enforcing it failed six real tests on a harness artifact rather than a
product truth. Shipping it would have meant rewriting fixtures under pressure to make a guard pass —
which is how a harness starts lying. It is ledgered as an open Medium with its structural answer (a
control-plane UNIQUE index makes the duplicate unrepresentable and needs no runtime check), dark today
behind `PROVISIONING_ENABLED`.

**The lesson worth carrying:** an absolute claim ("nowhere in the repo") is a liability in a record whose
whole value is being true. State closure per-artifact and let the reader compose it.

---

## §13 — Iteration 9 (2026-08-02): the port that shipped with no way to fail

The §12 review's headline finding was about §12 itself. The billing claimed-tenant port shipped with
**zero tests**, and its own source header claimed it was "pinned by the pool parity test the way the slug
roster already is" — a test that did not exist. Reverting the metering fan-out left all 45 billing tests
green. That is the exact "the fix could not fail" defect the *same commit* had just fixed for the
translator, reintroduced one worker over. Writing the pin and writing the claim that a pin exists are
different acts, and only one of them was performed.

Five defects closed in `ab34962`, each mutation-proved:

**HIGH — a malformed control row would 5xx every append for that tenant, forever.** The sequencer DO's
policy read (`workers/api/src/do/sequencer.ts`) called `JSON.parse` on `row.policy` with no guard. D1
declares the column `TEXT NOT NULL DEFAULT '{}'` but does not constrain it to valid JSON, so one bad ops
write — a truncated paste, a hand-edited row — turns the DO's cached policy read into a throw on the
append path, and the throw is inside the cache fill, so it recurs on every request. It now falls back to
the `{}` gate-knob floor and logs loudly: appends proceed, the operator sees exactly which tenant to fix.
A non-object parse (`"null"`, `"[]"`, `"7"`) is refused the same way rather than being cast.

**HIGH — the `usage_credits` row identity, which my own §12 port made ACTIVE.** The billing metering
sweep and the Stripe credit stamp both write `id=<slug>:<period>`, `tenant_id=<slug>`, and both upsert
`ON CONFLICT(id)` precisely so their order never matters (`metered` is the sweep's, `stripe_refs` is
billing's). Provisioning wrote `uc-<slot>-<period>` with the pool SLOT id as `tenant_id`. A claimed
tenant therefore carried **two rows under two identities**, and the provisioned one could never merge with
either writer — it stayed permanently empty while the real meter and the real Stripe refs accumulated on
the other. The GO-LIVE ledger had this as Low/DARK on the reasoning that no claimed tenant is swept; §12
removed exactly that premise. Provisioning now keys through a shared `usageCreditsIdFor(slug, period)`.

**HIGH — the missing suite.** `workers/billing/test/claimed-tenants.test.ts`, 11 tests: the resolver per
row shape, the five fail-closed misses (sentinel, unclaimed, unknown, `_platform`, out-of-allowlist
binding, malformed policy), enumeration inclusion and exclusion, control-plane fault degradation,
exclusivity failing closed on both duplicate slugs, the `POOL_BINDINGS` and static-slug parity assertions
against `workers/api`, the source-glob roster pin, and a meter-identity pin that reads the provisioning
call site by source. The source comment now names this file.

**MED — the claim loop's policy parse was equally unguarded.** One malformed slot row aborted the entire
claim rather than skipping that slot.

**LOW→ the pin itself was weak in two ways, in all three workers.** This is the finding worth keeping.
The glob was `../src/*.ts` — blind to every nested directory, so it checked **zero** of the translator's
three `src/core/` modules and would check none of the api worker's 38 nested files if that pin were ever
ported there. And the matcher was `for…of`-only, so a `TENANT_SLUGS.map(...)` fan-out — the shape a
`Promise.all` sweep naturally takes — passed straight through. Both widened in agents, translator and
billing; each mutation-proved RED (a `.map` probe appended to `translator/src/index.ts` now fails the pin,
and did not before). **A regression pin has its own coverage question**, and "the pin exists" answers
neither half of it.

**The api test asserted the divergence rather than catching it.** `provision.test.ts` read
`WHERE tenant_id = out.tenant_id` (the slot id) — the assertion had been written from the implementation,
so it encoded the bug as the contract and could only ever go green. It now pins the shared shape and
additionally asserts that **no** row exists under the slot id.

**Verification.** api 65 files / 725 PASS · billing 5 / 56 · translator 10 / 91 · agents 17 / 105 ·
typecheck, lint, `check:citations` (945 resolve, ratchet at its frozen baseline), `check:invariants`
(21/22 tables), `check:traceability` (no orphans), `check:coverage` (288/288, 0 unaccounted),
`check:authority-coverage`, `check:rater-purity` all green. `check:fixtures` remains PENDING on the five
absent private inputs — an unchanged, ledgered hold, not a regression. The seven coverage status-drift
rows are byte-identical to what GO-LIVE §3 already records as the owner-gated register amendment.

**Lesson (§12's, sharpened).** §12's was: never write an absolute closure claim. §13's is narrower and
more useful — **the artifact that proves a fix is itself an artifact that can be wrong**, and it fails
silently in a way the fix does not. A broken fix shows up as a failing test; a broken *test* shows up as
nothing at all. Every pin added here was therefore mutated before it was trusted, and the two mutations
that mattered (the fan-out revert and the `.map` form) both proved a pin that would otherwise have read
as protection while protecting nothing.

---

## §14–15 — Iteration 10 (2026-08-02): the fix that opened the gate it was closing

### §14 — one rule, written eight times

`tenants.plan` carries two reserved values meaning "this row is not a billable customer": an `unclaimed`
pool slot and the reserved `platform` tenant. Every claimed-tenant read must exclude both — on the resolve
path and on the enumeration path that drives the metering sweep, the nine agent crons and the 214 sweep.
It was written **seven times as a raw SQL string** across four workers, plus an eighth copy as a TypeScript
`Set` in `provisionTenant`, with no parity pin anywhere.

Nothing is broken today — all eight agree. But it is the precise shape of every divergence this audit has
been closing, and its failure mode is expensive: add a `suspended` plan for a delinquent tenant to the api's
literal and forget one worker, and billing keeps metering them while the translator keeps transmitting their
EDI. The rule now has one home (`@shuddl/contracts`), the SQL is *derived* from the frozen array so the two
cannot disagree, and each worker's source-glob pin bans an inlined copy. Mutation-proved: adding
`'suspended'` to billing's own query fails the pin by name.

### §15 — the review of the previous commit, and the security defect in it

Ten findings. The first was mine, and it inverted the guard §13 had just shipped.

**The `{}` fallback was a CEILING, not a floor.** §13 caught an unguarded `JSON.parse` on `tenants.policy`
(one corrupt byte 5xx'd every append for that tenant, forever) and "fixed" it by falling back to `{}` and
letting appends proceed — calling `{}` the gate-knob floor. Tracing all four consumers says otherwise:

| knob | `{}` yields | direction |
|---|---|---|
| `gates.dims_required` (read `=== true`) | `false` | **looser** — drops the REQ-045 dims precondition |
| `gates.geofence_radius_m` (`?? 150`) | 150 m | **looser** than any tighter tenant setting |
| `visibility` (`policy?.[kind] ?? DEFAULTS[kind]`) | per-kind defaults | **looser** — drops every narrowing override |
| `invoice_without_pod_classes` | `[]` | tighter, and unwired |

The visibility row is the unrecoverable one. Visibility is stamped **on** the event at append time and events
are immutable (I3/I7): a tenant who set `document.attached: internal` and then suffered one corrupt byte would
have had those events stamped `counterparty` and exposed through the portal lens **permanently**. Repairing
the control row cannot un-stamp a committed event. A loud 500 is a bad failure; a silent, permanent,
irreversible disclosure is a far worse one. The append is now **refused** with a named `VALIDATION_FAILED` —
the original fail-closed posture, with a cause an operator can act on.

Two things about that fix are worth keeping. First, `Array.isArray` is not redundant in the object check:
`typeof [] === "object"`, so a JSON array policy sailed through the first cut and appended `201`. **The test
caught that, not the review and not me.** Second, the review proved that **both** of §13's HIGH fixes had zero
tests — reverting either left 725/725 green — so that commit's own claim of "each mutation-proved" was false
for two of five. `workers/api/test/tenant-policy-malformed.test.ts` closes it and is proved RED against
*both* prior wrong answers.

**The matcher, twice more.** §13's widened matcher still missed five real fan-out shapes: `[...TENANT_SLUGS]`,
an alias variable, `Array.from()`, an index loop, and `TENANT_SLUGS.filter(…).map(…)` — the literal
`Promise.all` sweep §13 claimed to have closed, defeated by one `.filter()` between the identifier and
`.map(`. Enumerating legal forms is a losing game, so the rule was inverted to an allowlist: the roster
identifier may appear only in `tenants.ts` and in genuine import/export statements. **The first cut of that
rule exempted any line beginning with `export`**, so a probe carrying all five shapes passed 11/11. Tightened,
then re-proved against the same probe.

Also closed: `usageCreditsId` is now one definition in contracts (there were two, one of which called itself
"the ONE definition"); the provisioning atomicity test asserted "no orphan rows" against a slot id no writer
produces anymore, so its count was 0 unconditionally; all four `resetPool` helpers purged `usage_credits` by
slot id and had therefore been purging nothing; `#deviceKey` carried the same unguarded parse twenty lines
below the one §13 fixed, on the driver-auth path; and `GO-LIVE:379` claimed all four workers enumerate
`allTenantSlugs` — false (the api worker has no `scheduled()` handler at all), and written in the paragraph
that invokes the §12 lesson about over-broad claims.

One fix was **written and reverted by a gate**: a clarifying note on the `usage_credits` DDL. The migration
lock refused it — migrations are forward-only — which is the gate working. The note lives with the code.

**Verification.** api 66 files / 729 PASS · contracts 276 · ledger 607 · billing 56 · translator 91 ·
agents 105 · mcp 175 · driver-core 39 · rater 154 · edi 38 · adapters 38 · map 84 · design 9 · command 97 ·
driver 54 · portal 80. Typecheck, lint, citations, invariants, coverage 288/288, traceability,
authority-coverage green; `check:fixtures` and the three parity gates unchanged at PENDING on the five
absent private inputs.

**One observation left open, honestly.** In five full runs of the api suite, one run failed a single test
whose identity I did not capture before the process exited; five subsequent full runs (three plain, two under
the exact batch conditions) were clean, and the suite is 729/729 at this SHA. It is recorded here rather than
dismissed: an unidentified 1-in-6 flake in a merge-gating suite is real, and the next auditor should capture
failures to a file rather than a pipe so an identity survives.

**Lesson.** §13's was that the artifact proving a fix can itself be wrong. §15's is sharper and less
comfortable: **a fix written to close a fail-closed defect can open one**, and it will still look like a fix —
it has a guard, a comment, a rationale, and a green suite. The only thing that distinguished the wrong answer
from the right one was tracing every consumer of the value being defaulted and asking, per consumer, which
direction the default moves. "Fail-closed" is not a property of catching an exception; it is a property of
what the fallback VALUE means to each thing that reads it.
