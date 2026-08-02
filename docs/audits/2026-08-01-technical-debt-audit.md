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
| **R4 — Production-ready** | **C3's remainder** (claimed-aware agents resolver + cron enumeration — before any `PROVISIONING_ENABLED` flip), EDI date-stamping before transport flip, `TEST_SEND_TOKEN` secret-visibility, tiles (REQ-075), sender warmup (REQ-157), edge rate-limits (REQ-193/125), 7-year archive (REQ-116) | C3 hardened fail-loud; the resolver build is the named pre-R4 repo work item |
| **R5 — Authority cutover** | Nothing new — the 30-day shadow and fixture-parity DoDs stand as specified | — |

**The stopping point, stated as the loop's exit condition.** Repository-closable debt work stops — and
may only stop — when all four are simultaneously true:

1. **Zero open repository-owned Critical/High rows** across this audit and the checklist failures
   ledger (C1–C3-hardening, D1–D5, U1–U4: closed this session; C3's resolver is phase-gated pre-R4
   repo work, Med while PLG is dark, and is the one named carry-forward).
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
