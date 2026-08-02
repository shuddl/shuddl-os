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

> **READ THIS FIRST (added 2026-08-02, §40). Everything in §1 is written in the PRESENT TENSE and describes
> the OPENING state at `0415148`. All three of its findings were closed during this same audit** — the ops
> record was corrected (D1/D2: `PROJECT-STATE.md`, `DEPLOYMENT.md` and `LAUNCH-RUNBOOK.md` now say
> production exists and is live, struck-through in place), and C1/C2/C3 plus the comment rot are all marked
> FIXED in §2. A reader landing here would otherwise conclude that three code defects are open and that the
> ops record still misleads about production. **Neither is true. For the CURRENT state, read §4's
> re-measurement at `fb212fd`.**
>
> Left in the present tense rather than rewritten, because §1 is the historical record of what the audit
> FOUND; rewriting it would erase the finding. Stamping it is the correction — and the need for that stamp
> is itself an instance of the rot mode §35 names: a claim made false later by work that never touched the
> line. Here the invalidating work was this audit's own, in its own most-read section.

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

**STATUS AT `14398fd` (2026-08-02, §21) — measured against those four conditions, one by one.**

1. **Zero open repository-owned Critical/High: SATISFIED.** Every finding from the two adversarial
   reviews of this session's own commits is closed — including the two the reviews found in *my* fixes
   (the `{}` policy fallback that opened three gate knobs, §15→§18; and the missing-row branch four lines
   below it that did the same, §18). All four §18 carry-forwards are closed (§19–§21). The two remaining
   open Highs are unchanged and **External**: a real driver's custody handoff needs manifest party refs +
   the deferred REQ-069 identity seam, and the live EDI adapter needs its transport credentials. The one
   pre-R4 *repo* carry-forward is still **resolve-path pool-binding exclusivity** (§12) — a Med, dark
   behind `PROVISIONING_ENABLED`, whose fix is a control-plane UNIQUE index, not a runtime check.

2. **Baseline gates green: SATISFIED, with one exception that is not this loop's.** typecheck (0), lint
   (0), invariants (21/22 tables), citations (946 resolve, ratchet at its frozen baseline), traceability
   (no orphans), authority-coverage, rater-purity, runtime-contract, seed, design audit — all PASS. Suites:
   api 66 files / 730 **×3 with a now-deterministic file order**, contracts ~~276~~ 280 (§27: 276 was the PRE-change count, copied forward through four sections), ledger 607, billing 56,
   translator 93, agents 105, mcp 175, driver-core 39, rater 154, edi 38, adapters 38, map 84, design 9,
   command 97, driver 54, portal 80. `check:fixtures` and the three parity gates remain PENDING on the five
   named private-input holds — unchanged and by design.

   **THE EXCEPTION:** `check:coverage` **FAILS** on an uncommitted `REQ-289` (GTM — "Pre-GTM Demand Lane",
   `wp=GTM-0`, `status=ACTIVE`) added by the concurrent GTM workstream, which also breaks two
   register-parser tests. Isolated by experiment (with the committed register, `test:tools` is 25 files /
   672 PASS; with the row, exactly 3 fail and all name REQ-289). Adding a register row **is** the
   documented way to introduce scope, so this is that workstream's decision to complete — it needs either
   an active WP or a `coverage-manifest.json` disposition **from its owner**. Left untouched deliberately;
   dispositioning it here would mean inventing intent. **This is the one thing standing between the tree
   and a fully green gate set, and it is not repository-closable by this loop.**

3. **Remaining debt External or CONFIRM-gated: SATISFIED** — every row in the checklist carries owner,
   grade and expiry; the two no-gate holds (on-call rota, 7-year archive) are re-read here and unchanged.

4. **The record agrees with the world: SATISFIED, and re-verified rather than assumed.** Three false
   claims *written by this loop* were found and corrected in-place rather than quietly replaced: an
   absolute "no roster instance remains anywhere" (§12), a comment asserting a parity pin that did not
   exist (§13), and "api, agents, translator and billing all enumerate `allTenantSlugs`" (§15 — the api
   worker has no `scheduled()` handler at all). Each correction names what was wrong and why, because a
   record whose value is being true has to show its own errors.

**So the loop is AT its stopping line for repository-owned work.** What remains is owner input: the five
private-fixture holds, the two External Highs, the GTM workstream's own register row, and the R2→R5 grades
that consume accounts, credentials, devices and counsel. Further iterations inside the repo would produce
either scope-straying or gate-relaxing — both forbidden by `CLAUDE.md` and `genesis/00`.
**RE-MEASURED AT `fb212fd` (2026-08-02, §38).** The §21 measurement above is stamped `14398fd` and is now
ten commits stale — including four adversarial reviews and every fix they produced. A stopping point that
is only *asserted* is the thing this audit exists to catch, so it is measured again, condition by condition.

**A caution about the method first, because it nearly produced a false all-clear.** The row-enumeration
used in §16 (grep for a High/Critical severity + `OPEN`, minus rows matching `resolved|FIXED|CLOSED`)
returned **zero open High/Critical rows** on this tree. That is wrong. The custody-handoff row is open and
High — it was filtered out because its body contains the phrase *"closed at `a3b667a`"*, describing a
**different, already-fixed** defect inside the same row. A crude filter over prose will do this, and the
failure direction is the dangerous one: it reports fewer open items than exist. The counts below were read
by hand.

1. **Zero open repository-owned Critical/High: SATISFIED.** Every finding from all four adversarial
   reviews is closed (§27, §30–§32, §36–§37), including the four HIGHs the reviews found inside fixes this
   loop had just written: the `{}` fallback that opened three gate knobs, the identical defect left four
   lines below it, a schema that both refused `null` and admitted a visibility typo, and an unconditional
   catch that turned a D1 blip into a lost tender. **Two open Highs remain and both are External**, both
   unchanged: a real driver's custody handoff needs manifest party refs plus the deferred REQ-069 identity
   seam, and the live EDI adapter needs its transport credentials. The pre-R4 *repo* carry-forward is
   still the single resolve-path pool-binding exclusivity row (§12), dark behind `PROVISIONING_ENABLED`.

2. **Baseline gates green: SATISFIED but for the one row that is not this loop's.** Suites: **2,648 tests
   across all 16 workspaces, every one passing** — contracts 285 · ledger 607 · rater 154 · driver-core 39
   · edi 38 · adapters 38 · map 84 · design 9 · api 730 · agents 106 · billing 56 · translator 96 · mcp 175
   · command 97 · driver 54 · portal 80. Gates: typecheck (workspace **and** tools) 0, lint 0, runtime,
   invariants (21/22 tables), citations (ratchet at its frozen baseline), traceability, authority-coverage,
   rater-purity, seed, design audit, and **`check:fixtures` — which now PASSES** where it was PENDING.

   `check:coverage` **FAILS**, on exactly one unaccounted row: the concurrent GTM workstream's uncommitted
   `REQ-289` (`wp=GTM-0`, `status=ACTIVE`). Isolated by experiment, not assumed — with the committed
   register `test:tools` is 672 PASS; with the row, exactly 3 fail and all name REQ-289. Adding a register
   row **is** the documented way to introduce scope, so it needs an active WP or a coverage-manifest
   disposition **from its owner**; dispositioning it here would mean inventing intent. **It is the single
   thing between this tree and a fully green gate set, and it is not repository-closable by this loop.**

3. **Remaining debt External or CONFIRM-gated: SATISFIED.** Every row carries owner, grade and expiry. Two
   Lows are dispositioned-open with reasons rather than silently dropped (§32): three control-row reads per
   inbound 204, and the `warn` severity/keying of `edi_tenant_policy_unusable`.

4. **The record agrees with the world: SATISFIED, and re-verified rather than asserted.** This loop wrote
   **six** claims that were false or became false, and each was corrected in place naming what was wrong:
   an absolute "nowhere in the repo" (§12); a comment citing a parity test that did not exist (§13);
   "api … enumerate `allTenantSlugs`" when the api worker has no cron (§15); "three parsers, enumerated
   and verified" when there were four — the omission that *caused* a HIGH (§30); a law claimed satisfied
   when only half of it was (§34); and one made false later by this loop's own C3 work (§35). A record
   whose value is being true has to show its own errors, including the ones it introduced.

**The loop is at its stopping line for repository-owned work**, on the same terms §4 has stated throughout.
What remains needs owner input: the five private-fixture holds, the two External Highs, the GTM register
row, and the R2→R5 grades that consume accounts, credentials, devices and counsel.
Beyond that line the build cannot advance itself: R2→R5 consume accounts, credentials, fixtures,
devices, counsel, and owner decisions. Working past the line from inside the repo produces either
scope-straying (building CONFIRM-gated features) or gate-relaxing (synthesizing private fixtures) —
both forbidden by law (`CLAUDE.md`, `genesis/00`). The loop therefore iterates: re-audit → close
repo-owned rows → re-verify → stop at this line, every iteration, until an owner input moves the line.

## §5 — Session disposition summary

> **AS OF ITERATION 1 (`0415148`→ that session's close). Stamped 2026-08-02, §41** — the same treatment §40
> gave the headline, for the same reason. The CARRIED-FORWARD list below is the state after iteration 1 and
> is now materially out of date; §6's title ("the carry-forward list is closed") already supersedes part of
> it, and later sections close more. Verified against the tree today:
>
> - **C3 resolver (pre-R4) — CLOSED.** Not just the agents worker: the claimed-aware resolver and the
>   `allTenantSlugs` fan-out now ship in api, agents, translator AND billing (§11–§13), each with its own
>   mutation-proved source-glob pin.
> - **EDI send-time date stamping (pre-EDI-flip) — CLOSED** at `3899ae6`; the 214 sweep and the 990 ack
>   stamp the real send instant through an injectable clock.
> - **Still open, unchanged and External/phase-gated:** the deployed-surface gate into the release record,
>   preflight-vs-served CORS, `TEST_SEND_TOKEN` visibility, prod-surface retry posture, marketing-site
>   version control, and the five private-input merge holds.
>
> **For the CURRENT state read §4's re-measurement at `fb212fd`, not this list.** Left in place rather than
> edited because it records what iteration 1 actually disposed of; a carry-forward list that is silently
> rewritten stops being evidence of anything.

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

**Verification.** api 66 files / 729 PASS · contracts ~~276~~ 280 (§27: 276 was the PRE-change count, copied forward through four sections) · ledger 607 · billing 56 · translator 91 ·
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

### §15a — sweeping the repo for the same defect class

Finding a fallback that read as fail-closed and was not raises the obvious question: **how many others are
there?** Enumerated every `catch` in `packages/ledger/src`, `packages/contracts/src`, `packages/rater/src`,
`workers/api/src` and `workers/agents/src` that substitutes a value rather than rethrowing — **18 sites** —
and traced each one's consumer for direction rather than reading its comment.

All 18 are genuinely fail-closed, several with the reasoning already written down:

- `geo/polygon-source.ts` → `null` on a hash mismatch or unparseable bytes → `deriveOperatingState` returns
  the `"XX"` sentinel → `transition-gates.ts:360` **throws** `GateError([consent])`. `"XX"` is deliberately
  not a USPS code, so no `ConsentAck.operating_state` can ever equal it — the sentinel cannot be satisfied
  by accident.
- `sequencer.ts` `#deliveryFence` → `undefined` on malformed leg geo → `assertDelivery` **throws**
  `GateValidationError` ("the gate cannot judge a geofence with no fence"). Absent is refused, not waived.
- `sign.ts` → `false` (a verification fault is a failed verification); `routes/devices.ts` → `null` (key
  absent ⇒ signature cannot verify); `routes/driver-manifest.ts` → no coordinate ("never fabricate a
  location"); `rate-config.ts` → omits the transit window rather than inventing one; `routes/import.ts` →
  `{}` LLM overrides, which degrades to the **deterministic** path — the conservative direction for that
  consumer, unlike `{}` for a gate-knob bag.

So the class was **not systemic — the §13 fallback was the single outlier**, and the codebase's own
convention was already the right one. Worth stating plainly, because "I found one, there must be more" is
a reasonable fear and the answer here is no; and because several of these sites document the *direction*
in their comment, which is the habit that would have prevented the defect in the first place.

---

## §16 — Iteration 11 (2026-08-02): the evidence record that certified itself

Verifying §4's stopping condition 1 by **enumerating open High/Critical rows in the ledger rather than
trusting the summary** turned one up that the previous iteration's closing statement had not accounted for:
the release-record binding. Its ledgered severity is Low-today (High the day a separate promote step reads a
record it did not write), so condition 1 still held — but the defect is the *exact* class this session has
been closing, so it was fixed rather than left as a tripwire.

`tools/release/run-gate.ts` built its `PromotionContext` out of the same four variables it had just used to
build the `EvidenceRecord`, so every comparison in `evaluateEvidence` compared a value with itself. The SHA,
environment, fixtures and deployment mismatch checks were **dead code in the only live consumer**.

The detection logic was never the problem — `evidence.ts` is real and `evidence.test.ts` exercises it by
constructing mismatched contexts directly. Only the wiring made it inert, which is precisely why every test
stayed green and why the row could sit OPEN as "latent". **This is the third distinct shape of the same
failure this session**: a fix with no test (§13), a pin that could not fail (§13/§15), and now correct logic
wired so it can never run.

Re-reading the world **after** the gates run makes the checks live, and makes them useful *now* rather than
only once a promote step exists. A gate run spans minutes; if a commit lands, the fixtures manifest changes,
or `RELEASE_ENVIRONMENT`/`DEPLOYMENT_VERSION` move while the gates are running, the record no longer describes
the tree it claims to describe. That is now caught instead of certified. In CI the checkout is fixed, so a
mismatch is always a true positive rather than a flake.

`main()` is not exported and shells out to `git`, so the wiring is not unit-testable from outside. The pin
therefore reads the source and asserts the context comes from the observation functions and the environment —
and specifically that **no field is copied off `record`**, which is what made it self-satisfied.
Mutation-proved: restoring the copied form fails 3 of the 4 new assertions.

### A register row from another workstream is currently red

Not this loop's change, recorded because it fails a merge gate right now. The working tree carries an
**uncommitted `REQ-289`** (GTM — "Pre-GTM Demand Lane", `wp=GTM-0`, `status=ACTIVE`) from the concurrent GTM
workstream. `check:coverage` **FAILS** on it — `GTM-0` names no active WP, so the row routes to
`unclassified` — and it breaks two register-parser tests (the 288-row terminal-ID contiguity check and the
disposition totality check).

Isolated by experiment rather than assumed: with the committed register, `pnpm test:tools` is **25 files /
672 PASS**; with the row present, exactly 3 fail and all three name `REQ-289`. The row was restored intact
afterwards. It is a deliberate scope decision owned by that workstream — adding a row *is* the documented way
to introduce scope (`CLAUDE.md` source-of-truth §1) — so it is **left untouched here rather than
dispositioned on a guess about its intent**. It needs either an active WP or a recorded-deferred disposition
in `tools/traceability/coverage-manifest.json` from its owner. Flagged, not fixed, deliberately.

---

## §17 — Iteration 12 (2026-08-02): which gates can actually fail, and the flake that had a name

§16 found a gate wired so it could never fire. That raised the systematic question: **how many of this
repo's gates have ever been proved capable of saying no?** Mapped every `check:*`/`audit:*` script that
resolves to a `tools/**` source — **16 of them** — to its test coverage by import graph. (Two false starts
worth recording: a filename heuristic was too strict, since `orphans.ts` is covered by
`traceability.test.ts` rather than `orphans.test.ts`; and a first count said "17 gates, 14 covered" because
it swept in `test:tools`, which is a composite vitest invocation and not a gate with a source of its own.
The number below is the recounted one.)

**Thirteen are covered with real negative assertions. Three had none at all** — and they are exactly the
three that are BLOCKED/PENDING on engagement fixtures that have never been vendored:

| gate | source | negative coverage before |
|---|---|---|
| `check:rater-parity` | `tools/rater/parity.ts` | none — nothing imported it |
| `check:invoice-parity` | `tools/rater/invoice-parity.ts` | none |
| `check:concierge-parity` | `tools/concierge/parse-parity.ts` | none |

That combination is the §16 shape waiting to happen. These harnesses have never executed against real
inputs AND nothing proved their comparison logic works. On the day the owner vendors the fixtures, three
gates flip from PENDING to blocking — and if a comparison is inverted, a tolerance backwards, or a field
silently skipped, the gate either blocks a correct release or **certifies a wrong one**, with no evidence
today that would say which.

The private fixtures are not needed to answer that. Both rater harnesses take an **injectable price
function** and `invoice-parity` ships an in-repo SMOKE set, so the detection logic is fully testable;
the concierge harness needed its two pure comparators exported (the rater harnesses already export their
run functions for exactly this reason). `tools/rater/parity-detection.test.ts` — **18 tests** — now pins
that each gate can say no: one cent of sell divergence, a decisive status divergence, each floor compared
individually, a hollow `PRICED` expectation refused, an UNKNOWN reason compared, a thrown comparison
recorded as a mismatch rather than swallowed, accessorials compared as a set, and a queued reason that
differs. Four mutations applied and each caught: `sell_cents` comparison disabled, exception-swallowing,
`compareDecision`'s reason check disabled, `compareRequest`'s accessorials check disabled.

What stays untestable without the fixtures is whether tenant-0's real numbers match — which is the gate's
job, not this file's. **This file proves the gate is capable of refusing; only the fixtures can prove the
tenant is correct.** That distinction is the whole point, and it is why the five private-input holds in §4
are unaffected by this work.

### The flake had a name, and it was the review's F4

§15 recorded, honestly, an unidentified api-suite failure seen once in five runs. Captured properly this
time — full output to a file per run rather than through a pipe — it reproduced on run 3 of 5 with **14
failures across four files at once**: `plg-isolation-matrix`, `provision`, `signup` and `signup-to-quote.e2e`.
Every one traced to a single root cause:

> `ProvisionError: atomic claim failed and rolled back: D1_ERROR: UNIQUE constraint failed: usage_credits.id`

That is **precisely** what the §15 review predicted as a latent consequence of the meter-identity change,
and it was already live rather than hypothetical. The §15 fix purged only the slot's *current occupant*;
`usage_credits` is keyed `<slug>:<period>`, so a row survives any reset that does not know both the slug and
the period that wrote it. All four helpers now purge every non-static meter row — exact rather than broad,
because nothing in `workers/api` writes a meter row for a static tenant (metering lives in the billing
worker).

**The lesson is about the earlier record, not the bug.** §15 wrote "an unidentified 1-in-6 flake … the next
auditor should capture failures to a file rather than a pipe so an identity survives." Following that note
one iteration later turned an anecdote into a named defect with a root cause in a single run. A flake
recorded honestly with the technique to catch it is worth more than a flake dismissed as noise — and
substantially more than one silently retried until green.

---

## §18 — Iteration 13 (2026-08-02): the review of the security fix found the same defect four lines below it

The §15 fix refused a MALFORMED policy. Its own `else` branch handed a MISSING row the identical `{}` — the
ceiling the refusal exists to prevent — under a comment I wrote asserting it was **"genuinely fail-closed:
no tenant means no overrides to lose"**. That claim was false, and the review proved it by probe: with
`visibility.freight.photographed = internal` an append stamps `internal`; DELETE the tenants row and the
identical append stamps **`counterparty`**, permanently, with no log and no refusal. Same event kind, same
widening, same immutability — reached through absence instead of corruption.

It is reachable, not theoretical. A STATIC tenant resolves its D1 on the hot path with **no control-plane
read**, so it appends happily with zero control rows; and **no migration creates a static tenant's row** —
`0001` makes the table, `0002` inserts `_platform`, `0003` the pool sentinels. The row is hand-provisioned
(`tools/deploy/staging-smoke.ts`, `test/helpers.ts`) and therefore hand-deletable, by exactly the operator
whose hand-corruption the sibling branch defends against. The old split was also internally inconsistent: a
missing row is fail-CLOSED for entitlements (`#entitlementRow` yields `plan:""`, so hazmat and SKU grant
nothing) and was fail-OPEN for gates and visibility.

Both branches now refuse, with **one carve-out**: the reserved platform tenant, resolved server-side with no
slug input, whose ledger no customer path can reach and which has no counterparty lens — `{}` there widens
nothing anyone outside the platform can read.

**The guard found a real instance the moment it existed.** The api suite went red on `rate.test.ts`, and the
cause was not the guard: **`tenant-b` — a fully bound static tenant — had no control row at all**. It had
been appending with silently-widened visibility for as long as the fixture has existed, and nothing noticed
because the sequencer fell back to `{}`. `ensureTenantBSchema` now seeds it, so the fixture reflects the
invariant the sequencer enforces. **This is the operational prerequisite the change makes load-bearing: every
bound tenant needs a `tenants` row before it can append.**

### What else the review found, and what it says about this session

Thirteen findings. Beyond the HIGH above, four were **my own tests that could not fail** — the exact class
this session keeps closing, produced while closing it:

- The billing "live round-trip" assertion was wrapped in `if (row)` and the sweep wrote **no** row, so both
  assertions inside were unreachable. It now seeds a run first and asserts unconditionally.
- The provisioning atomicity test pre-seeded a duplicate **email** and expected the batch to roll back — but
  `provision.ts` runs an email PRE-CHECK before the claim loop, so `control.batch(...)` was never executed
  and every "did it roll back?" assertion was vacuous. It now plants the `usage_credits` row the claim will
  write, so the third batch statement violates `UNIQUE(id)` and the rollback is genuinely exercised; the
  error CODE is pinned (previously any `ProvisionError` satisfied it) and the orphaned `users` row checked.
  Mutation-proved with the exact mutation that defeated the old version.
- The roster matcher — **on its fourth cut** — was defeated by a one-line `import {TENANT_SLUGS} from "…";
  export const p = () => TENANT_SLUGS.map(f);` (the whole line was exempt because it *began* with an import)
  and simultaneously produced false positives on a Prettier-wrapped multi-line import and on a `/** block
  comment */` naming the roster. **A line was simply the wrong unit.** It now strips comments and
  import/export STATEMENTS and scans the residue; all four cases verified — both escapes caught, both false
  positives cleared.
- The `#deviceKey` catch is defence-in-depth that is probably **not reachable** through its own query
  (`je.value` comes out of `json_each`, so it parsed once already). Reverting it left the suite green, which
  is true and expected. The comment now says so, and identifies the part that does earn its place: the
  `?? null` collapses a missing `public_jwk` from `undefined` (cached and handed to the verifier, where the
  failure is a crash) to null (an absent key, which is a refusal).

**Deliberately ledgered, not fixed here** — each is real, none is a regression from this session's changes:

1. **The translator retry-storm is reintroduced under a new name.** `handleInbound204` has no catch around
   the append chain, so the new `VALIDATION_FAILED` escapes → 500 → the VAN retries forever, while
   `persistParty`/`persistShipment`/the tender marker (written before the appends, direct to tenant D1)
   accumulate — a projection with no ledger. The same file states the opposite law thirty lines up: *"a
   DETERMINISTIC bad document — quarantine + 200, never a 5xx retry-storm."* A corrupt control row is as
   deterministic as a malformed 204. Fix: classify it as a deterministic refusal → quarantine + 200.
2. **`TenantPolicy` is a bare TS type, not a Zod schema**, against "Zod at every boundary". `{"gates":[1,2]}`
   or a `{"gate":{…}}` typo passes the object check and then produces exactly the `{}` widening. A truncated
   paste rarely parses; a **mis-keyed** one always does — and the mis-keyed one is the likelier ops error.
3. **Watchtower swallows the refusal into a permissive path** (`watchtower.ts` drift fallback catches and
   continues), so under a bad policy a module stays on `native` authority while drifting. Every other
   append caller re-throws; this one needs the cause surfaced into the alarm row.
4. **The api suite's file ORDER is randomized between runs** while 66 files share one control plane
   (`isolatedStorage:false`, `singleWorker:true`), so greenness is partly a function of order. A second flake
   cluster exists beyond §17's — `authority-flip.test.ts` returning 500, which two other files already
   document in-repo as "a pool-workers reload flake". §17's cluster-B fix held over five clean runs; this
   one is separate and untouched. Pinning `sequence.shuffle:false` would make runs reproducible.

**The lesson.** §15 said a fix meant to close a fail-closed defect can open one. §18 is narrower and worse:
**the fix closed the branch it was looking at and left the identical defect in the branch four lines below,
then wrote a comment certifying that branch safe.** The comment is the dangerous artifact — it converts an
unexamined branch into one a future reader will not re-examine. Tracing consumers is not enough if you only
trace them for the code path you happened to be editing.

---

## §19 — Iteration 14 (2026-08-02): closing two of the four §18 carry-forwards

### The retry-storm the refusal reintroduced

§18 ledgered it honestly: the sequencer's new refusal escapes `handleInbound204` as a 500, and a VAN retries
a 500 forever. The condition is deterministic — a corrupt control row cannot be fixed by retrying — and this
handler's own law, stated thirty lines above the append chain, is that *"a DETERMINISTIC bad document —
quarantine + 200, never a 5xx retry-storm."* Worse, the persists and the tender marker run **before** the
appends and write straight to tenant D1, so each retry would accumulate parties, shipments and markers with
no ledger behind them: a projection with no events.

The fix is a **preflight**, placed beside the cert gate where nothing has been written yet, using the **same
predicate the sequencer uses** — hoisted into `@shuddl/contracts` as `parseTenantPolicy`. Two copies of "may
this tenant append?" is the seven-copies-of-one-rule shape §14 closed, and this instance would be worse: the
two sides would disagree about a *security refusal*. An unusable policy now quarantines with
`edi_tenant_policy_unusable` + 200, nothing written, raw bytes preserved. Mutation-proved.

**One test was written wrong and corrected rather than deleted.** A missing control row was expected to
quarantine identically; it returns **401**. EDI auth resolves the tenant *through* the control plane, so a
missing row cannot authenticate at all — fail-closed one layer earlier than the preflight. The test now
asserts that, and says why. The preflight therefore covers the case that *can* authenticate: a row that
exists carrying an unusable policy.

### The mis-keyed policy — Zod at the boundary, and an honest limit

`TenantPolicy` was a bare TS type, so `parsed as TenantPolicy` accepted anything object-shaped. The threat
this session kept describing was "one truncated ops paste" — but **a truncated paste rarely parses, and a
mis-keyed one always does**, which makes the mis-keyed paste both likelier and invisible. `{"gates":[1,2]}`,
`{"gates":"strict"}`, `{"gates":{"dims_required":"true"}}` (the *string* "true"), and
`{"visibility":"internal"}` all pass an object check and then produce exactly the `{}` widening, because
every reader takes the permissive branch on `undefined`.

`parseTenantPolicy` now `safeParse`s a `.passthrough()` shape: the gate-bearing keys are typed when present,
everything tenant-specific (`hazmat_enabled`, `pool_binding`, …) passes through untouched.

**The limit is recorded rather than pretended away**, in its own test: a `{"gate":{…}}` **typo is NOT
caught**. Passthrough is deliberate — a closed schema would refuse every tenant-specific key — so a
misspelled key survives as an unknown one and the real `gates` is simply absent, indistinguishable from a
tenant that set no gates. Catching that needs a closed schema and an enumerated key list, which is a
different (and much larger) decision than this fix.

### Still carried forward

Two of §18's four remain open and are unchanged by this iteration: **Watchtower swallowing the refusal**
into its permissive drift-fallback path (a module stays on `native` authority while drifting, with only a
log), and the **api suite's randomized file order** over a shared control plane, plus the second flake
cluster (`authority-flip`, already documented in-repo by two other files as a pool-workers reload flake).

**Verification.** api 66 files / 730 · contracts ~~276~~ 280 (§27: 276 was the PRE-change count, copied forward through four sections) · ledger 607 · billing 56 · translator 93 · agents 105 ·
mcp 175; typecheck 0, lint 0.

---

## §20 — Iteration 15 (2026-08-02): the last two carry-forwards, one closed and one made reproducible

### Watchtower: containment is not a reason to under-report

The parity-drift rule catches a failed auto-fallback append, logs, and continues. That containment is
**correct** — the alarm is already raised, and a persistent fault must not abort the sweep and skip every
later module's raise/clear. But the alarm is raised *before* the fallback is attempted, so on a failure the
row said only "this module has drifted" and omitted the more urgent half: **it is still on native
authority.**

"Retry next tick" is the right posture for a *transient* fault. Not every fault is transient: a tenant whose
control-plane policy is unusable now has every append REFUSED (§18/§19), so this append fails
deterministically and every later tick fails identically — silently, forever, behind one log line. The alarm
is now re-upserted (`raiseAlarm` is `ON CONFLICT DO UPDATE`, so it is the same row) carrying `fell_back`,
and on failure `still_on_native: true` plus the cause. Mutation-proved: removing the re-upsert fails the
assertion with `expected undefined to be false`.

### Test order: the fix was written, reverted, and the reason is the finding

The review's recommendation was to pin the api suite's file order, since 66 files share one control plane
with no rollback. Two things came out of doing it:

1. **`sequence.shuffle: false` is not sufficient.** Vitest's default sequencer orders files by their
   **cached duration from previous runs**, so the order drifts on its own as timings move — two consecutive
   runs still began with disjoint file lists. Full determinism needs a custom path sequencer.
2. **With the order pinned, the suite fails REPRODUCIBLY** — `lens-adversarial`, 2 tests, `expected 500 to
   be 200`, identically on both runs. The cause is visible in the log: some earlier file seeds `events` rows
   whose `id` and `prev_hash` do not satisfy the `LedgerEvent` schema, and the firehose 500s when
   `rowToEvent` reads them. The file passes **44/44 in isolation**.

So the suite is genuinely **order-dependent**, and the randomization has been hiding it. The pin was
therefore **written and reverted deliberately**: landing it would trade an intermittent red for a permanent
one, and the real fix touches either a test seeder's fidelity or `rowToEvent`'s strictness on the
canonical-hash read path — which is not a change to make in a hurry at the end of an iteration. The config
carries the reproduction inline; this is the next iteration's first task.

**What this is worth.** §15 recorded "an unidentified flake" and the technique to catch it. §17 used that
technique and named cluster B. §20 pins the order and turns the remaining cluster from "intermittent, seen
twice in six runs" into "fails every run, here is the file and the assertion". Each step cost one iteration
and made the next one cheaper — which is the argument for recording a flake honestly rather than retrying
until green.

### The four §18 carry-forwards, closed out

| # | Item | Status |
|---|---|---|
| 1 | Translator retry-storm on the new refusal | **FIXED §19** — preflight quarantines before any write, mutation-proved |
| 2 | `TenantPolicy` unvalidated; a mis-keyed paste widens | **FIXED §19** — Zod passthrough shape; the `{"gate":…}` typo limit recorded in its own test |
| 3 | Watchtower swallows the refusal | **FIXED §20** — the alarm carries `fell_back` + `still_on_native` + cause |
| 4 | Randomized file order over a shared control plane | **DIAGNOSED §20, not fixed** — pinning proved a real order-dependence in `lens-adversarial`; reproduction recorded in `workers/api/vitest.config.ts`, fix is the next iteration's first task |

**Verification.** api 66 files / 730 · contracts ~~276~~ 280 (§27: 276 was the PRE-change count, copied forward through four sections) · ledger 607 · billing 56 · translator 93 · agents 105 ·
mcp 175; typecheck 0, lint 0.

---

## §21 — Iteration 16 (2026-08-02): the order-dependence, found and fixed

§20 pinned the api suite's file order, watched `lens-adversarial` fail reproducibly, and reverted the pin
rather than trade an intermittent red for a permanent one — leaving the reproduction inline and naming this
as the next iteration's first task. It was.

**The culprit: a fixture writing a row the product could never produce.** `driver-manifest.test.ts`'s
`seedTerminalEvent` inserted straight into `events` with `id = "ev-<shipment>-<kind>-<seq>"` (not a UUID),
`prev_hash = "GENESIS"` (not 64-hex), and `payload = "{}"` (no `geo`/`auto` for a `stop.*` kind) — while
stamping `visibility: "counterparty"`, which puts the row squarely in the firehose lens. Those are exactly
the four Zod errors the failure reported. With 66 files on one D1 and no rollback, the rows outlive the file
that wrote them, so `lens-adversarial`'s firehose 500s when `rowToEvent` parses them.

**The file already knew this rule and had written it down** — for a different column. Its `nextHash` comment
says a fixture writing a non-hex `hash` "poisons that day's tree for every OTHER test file sharing this
database." The same reasoning applies to `id`, `prev_hash` and `payload`, and was not applied. A row seeded
directly into `events` must be a row the product could have produced; a fixture that fabricates an
impossible state is not a shortcut, it is a defect that surfaces in someone else's test as an unexplained
500.

**My first fix was itself wrong, and the determinism is what showed it.** I wrote `geo: {…, acc_m: 5}`;
`GeoStamp` is `.strict()` and the field is `accuracy_m`. The failure went from four Zod errors to exactly
one — mine — and pointed at it by name. Under the old randomized order that correction would have taken
another several-run hunt.

**The pin now lands.** `sequence.shuffle: false` is not sufficient (vitest orders by cached duration from
prior runs, so the order drifts on its own); a `BaseSequencer` subclass sorting by path is. Verified: three
consecutive full runs, **730/730 each, byte-identical file order across all three**.

### What the four-iteration arc cost and bought

| iteration | state of this defect |
|---|---|
| §15 | "an unidentified api failure, 1 in 5 runs" + the capture technique to catch it |
| §17 | technique applied → cluster B named (`usage_credits.id`), root-caused, fixed |
| §20 | order pinned → the remaining cluster becomes reproducible; pin reverted, reproduction recorded |
| §21 | fixture fixed, pin landed, 3× 730/730 with deterministic order |

Each step cost one iteration and made the next cheaper. The alternative — retrying until green — would have
left both clusters in place and the suite quietly order-dependent, which is the state it had been in for as
long as it has had 66 files.

**All four §18 carry-forwards are now closed.** Nothing from the last two reviews remains open.

**Verification.** api 66 files / 730 (×3, deterministic order) · contracts ~~276~~ 280 (§27: 276 was the PRE-change count, copied forward through four sections) · ledger 607 · billing 56 ·
translator 93 · agents 105 · mcp 175; typecheck 0, lint 0; invariants, citations, traceability,
authority-coverage, design audit all PASS.

---

## §22 — Iteration 17 (2026-08-02): the same question, asked of the other four workers

§21 fixed the api suite's order-dependence and pinned its file order. That raised the obvious follow-up:
**is the api worker special, or was it just the one where the defect happened to bite?**

Measured rather than assumed. The api worker is the only project running `isolatedStorage: false` (66 files
sharing one D1 with no per-test rollback), so it is the most exposed — but the other four are **not immune**,
because `beforeAll` writes are never rolled back even when `isolatedStorage` is on. And their order is just
as unpinned: two consecutive runs of the agents suite reordered its first three files.

So the fix is applied to all five. The rule lives in **one** module — `tools/testing/path-sequencer.ts` —
imported by every vitest config, rather than copied five times. Five copies of an ordering rule is five
chances for four of them to drift, which is the same reasoning §14 applied to the reserved-plan SQL and §19
to the tenant-policy predicate. The api config, which had grown its own copy plus two stacked comment
blocks from §20 and §21, now imports the shared one and carries a single consolidated note.

**Two things worth recording about the move itself.** First, `sequence.shuffle: false` is a *different knob*
and does not pin anything — vitest orders by cached duration from prior runs, so the order drifts on its own
as timings move. Second, the sequencer's `sort` signature had a latent type error (`Promise<ReturnType<…>>`
double-wraps, since `ReturnType` is already a Promise) that **typechecked fine while it lived inside the
vitest config** — configs are not covered by a tsconfig — and failed the instant the class moved into
`tools/`. That is a small argument for the shared module beyond DRY: code in a config file is code nothing
is checking.

**Verified:** all five suites green *and* order-stable across repeat runs — api 730 ×2 (identical order),
billing 56, translator 93, agents 105, mcp 175, each with byte-identical file order across two runs.
typecheck 0 (workspace **and** tools), lint 0.

**What this buys.** Nothing today; every suite is green. What it removes is the *category*: the next
order-dependent defect anywhere in the test estate fails on every run instead of one in five. This session
paid for that class twice, at several full suite runs each just to identify. A flaky failure you can
reproduce is a bug; one you cannot is a rumour.

---

## §23 — Iteration 18 (2026-08-02): asking the translator's question of the queue consumer

§19 fixed a retry-storm the §18 refusal created in the EDI translator. The obvious follow-up is whether the
refusal creates the same hazard on the **other** path that appends through the sequencer: the agents queue
consumer, which handles `pod.signed`, `message.received` and `quote.accepted`.

**It does not, and the reason is worth recording because it is the opposite conclusion from §19.** The
consumer's catch routes every throw to `message.retry()`, and `workers/agents/wrangler.toml` sets
`max_retries = 5` with a dead-letter queue. So a policy refusal is bounded: five attempts, then the trigger
lands in the DLQ as a **recoverable record** — which is this worker's own documented law ("a deterministic
bug must leave a recoverable record; no invoice AND no trace would be the worst failure"). The translator
case was different on both counts: its 500 went to an external VAN with no DLQ and no bound, and each retry
re-ran the persists and the tender marker, accumulating projection rows with no ledger behind them. That is
why the translator needed a refusal *before any write* and this path does not.

**What was wrong here was the LABEL, not the posture.** A deterministic refusal produced five identical
lines reading *"retriable failure … message will redeliver"* — telling an operator to wait for a transient
condition to clear when nothing will clear until a control row is fixed, and naming no fix. The refusal is
now classified and logged as DETERMINISTIC, naming the tenant and the operator action, while the retry
toward the DLQ is unchanged. Mutation-proved: removing the classification fails the new pin.

**The general point.** Two paths, one upstream change, opposite correct answers — and the difference was not
visible from the change itself. It came from reading each path's *bound*: does something downstream cap the
retry, and does each attempt leave residue? "We fixed this class over there" is a hypothesis about here, not
a conclusion; and the fix that is right in one place can be unnecessary in another that looks identical from
the call site.

**Verification.** agents 17 files / **106** (the new pin included); typecheck 0, lint 0.

---

## §24 — Iteration 19 (2026-08-02): an assumption stated eight times and enforced nowhere

Continuing the "what else does the §18 refusal reach?" sweep past the queue consumer (§23) to the **nine
cron sweeps**. The audit result is mostly a **negative** one, which is worth recording as carefully as a
defect: every one of the nine wraps its per-tenant body in `try/catch`, so one tenant's deterministic
refusal cannot stall anchoring, recon, retention or any other sweep for the rest of the roster. That
containment is real and was verified per-sweep, not inferred from one example.

**What the audit did find is one level up.** `scheduled()` runs the anchor in a `try` and the other eight
sweeps sequentially in its `finally`. Each of those eight carries a comment asserting it "contains its own
per-tenant faults, so the anchor's throw still surfaces after it runs" — the same sentence, eight times.
That is true of the per-tenant loops and was an **assumption about the top of each sweep**, enforced
nowhere. If any sweep throws *outside* its loop, two things follow:

1. **Every later sweep is skipped for every tenant** — including `runReconSweep`, the REQ-169 sweep that
   re-enqueues lost `pod.signed` Biller triggers. A skipped tick there is unbilled freight.
2. **The throw happens inside `finally`, so it replaces the anchor's in-flight error** — precisely the
   masking that block's own comment promises does not happen ("the finally never masks the anchor's error").
   The anchor failure would vanish and the cron would retry against the wrong diagnosis.

A `contain(name, run)` wrapper now makes the eight independent, and makes those eight comments true rather
than assumed.

### The part worth keeping: it ships with no test, deliberately

Every sweep was checked for throwable work before its per-tenant loop and **none has any** — `sequencerFor`
returns a closure without touching `env`, `now()` is injected, and `allTenantSlugs` catches its own
control-plane faults and degrades to the static roster with a loud log. So the branch is currently
**unreachable**, and no test can reach it without contorting the code to make one pass.

The §18 review taught this exact lesson about `#deviceKey`: a guard that cannot be reached should say so,
not imply coverage it does not have. So the source comment states the reachability plainly, and the test I
first wrote — which mocked a binding and was caught by per-tenant containment instead, passing for the
wrong reason — was **deleted rather than adjusted until green**. What the wrapper guards is the *next* edit:
the day a sweep gains a binding lookup or a pre-fan-out read, the assumption those eight comments encode
silently becomes false, and neither failure mode announces itself.

**Verification.** agents 17 files / 106; typecheck 0, lint 0.

---

## §25 — Iteration 20 (2026-08-02): the enumeration closed, and why three parsers of one column is correct

### Every sequencer caller, enumerated and answered

§18 changed what the sequencer does with an unusable tenant policy. §19 and §23 and §24 chased that change
outward one caller at a time; this closes the list. **Six call paths, and the right answer differs on four
of them** — which is the whole point of enumerating rather than generalising:

| caller | what a policy refusal does | verdict |
|---|---|---|
| api routes (×7) | `translateAppendError` → **400** to the client | correct as-is |
| EDI translator inbound-204 | was a 500 the VAN retried forever, with projection rows accumulating per retry | **fixed §19** — preflight quarantines before any write |
| agents queue consumer | retry → `max_retries=5` → DLQ (a recoverable record) | posture correct; **label fixed §23** |
| agents crons (×9) | per-tenant `try/catch` in every one; verified per-sweep | correct — but the eight were not contained from EACH OTHER, **fixed §24** |
| MCP worker | proxies the api's 400 through; `caps.ts` fails closed on any non-ok read | correct as-is |
| api internal platform-credit route | `_platform` is the one carve-out — no customer lens, own D1 | correct by construction |

Four of six needed nothing, or nothing structural. That ratio is the argument for the enumeration: "we fixed
this class over there" was wrong about half the time, in both directions — the translator needed more than
expected, the queue consumer needed less.

### Three parsers of `tenants.policy`, and why unifying them would be a defect

The same sweep surfaced something that looks like debt and is not. `tenants.policy` has **three** readers
with **three different failure behaviours**:

- `parseTenantPolicy` (gates + visibility — the sequencer and the EDI preflight) → **refuses**
- `readEntitlementPolicy` (hazmat) → floors to `{}`
- `resolveSparkPlan` (the AI allotment) → floors to no allotment

That is not sloppiness; it is the §15a direction lens applied correctly. For an **entitlement**, `{}` grants
nothing — the restrictive answer — so flooring is right, and refusing would take a tenant's entire workspace
down over a hazmat flag. For a **gate bag**, `{}` is the permissive end (`dims_required` reads false, the
geofence widens to the 150m default, visibility falls to per-kind defaults), and the visibility half is
stamped irreversibly onto append-only events. Same column, opposite correct defaults.

**The risk is a future "cleanup".** Three parsers of one column is exactly the shape this audit has spent
ten sections consolidating — §14 merged seven copies of the reserved-plan SQL, §19 merged two copies of this
very predicate. A reader who pattern-matches without re-deriving the direction will unify these three and
silently break one: flooring in the sequencer re-opens the §15 disclosure; refusing in the entitlement
readers turns a missing flag into an outage. The asymmetry is now documented **in the code**, at the
definition, with the failure mode of each wrong unification named — because a comment in an audit file does
not reach the person doing the cleanup.

**Verification.** typecheck 0; contracts ~~276~~ 280 (§27: 276 was the PRE-change count, copied forward through four sections), agents 106, api 730, translator 93, billing 56, mcp 175.

---

## §26 — Iteration 21 (2026-08-02): the prose-vs-enforcement lens, run over the money paths

§24 found a defect by asking a narrow question: **which invariants are asserted in prose and enforced
nowhere?** Eight comments claimed each cron sweep contained its own faults; the per-tenant loops did, the
sweep tops did not. That is a cheap, high-yield lens, so it was run over the money and ledger paths — the
places where a false claim is most expensive.

Enumerated every absolute claim (`can never`, `by construction`, `impossible`, `guaranteed`) in the comments
of `packages/ledger/src` and `packages/rater/src`: **36**. The two most checkable and most money-critical
were verified against the code rather than read:

| claim | verdict |
|---|---|
| `gl/export.ts:4` — "the export is balanced BY CONSTRUCTION — and we **assert** Σdebits === Σcredits before returning" | **TRUE.** `export.ts:77-78` genuinely compares and throws `double-entry violated`. The claimed assertion exists. |
| `money/split.ts:49` + `derive-split.ts:15` — the derivation and the money projection "can never round apart" because "both share `largestRemainder`" | **TRUE, and shared for real.** `largestRemainder` has exactly ONE definition (`split.ts:86`). `derive-split` imports `apportion` from `split.js` and derives `share_bps` as `apportion(10_000, weights)`; the projection converts those bps to cents with `allocateCents`. Both exported functions route through that one algorithm, so bps and cents are allocated by identical rounding (REQ-003/040/112). |

**A clean negative result, and it is worth the same care as a defect.** The interline split is the path that
produced this build's permanent regression (the $222,084/35-lb anomaly, REQ-040), so "the two halves cannot
round apart" is exactly the kind of claim that would be expensive to have wrong — and it is backed by a
single shared function rather than by two implementations that happen to agree today.

The remaining 34 claims are architectural in form ("ONE shared seam so X can never drift", "tenant-scoped by
construction because `db` is already the tenant's own D1"). Those are true by the shape of the code rather
than by an assertion, and spot-checks found no counterexample. Recorded as swept, not as individually
re-proved — the two above were selected because they are the ones a defect would cost money.

**Verification.** No code changed in this section; contracts 280, agents 106, api 730, ledger 607 unchanged.

---

## §27 — Iteration 22 (2026-08-02): the review found two tenant outages in my own §19 fix

**First, a correction about process.** I checked the review agent's output file, saw 147 bytes unchanged for
51 minutes, concluded it was dead, and said so. It was not — it was still working and delivered a full
report shortly after. The check was wrong (that file is not written incrementally) and the conclusion was
stated with more confidence than the evidence supported. Recorded because this document's value is being
true about its own process too.

The review found **two HIGH defects, both inside the §19 Zod tightening I had written to make policy
handling safer.** Both are tenant-wide outages. Both were proved with probes against the real sequencer.

### HIGH-1 — a visibility TYPO passed the predicate and 500'd deep inside the sequencer

`visibility: z.record(z.string(), z.string())` pinned the KEY type and left the VALUE as any string, while
`Visibility` is the union `internal | counterparty | public`. So `{"visibility":{"freight.photographed":"publc"}}`
— one transposed character — **passed `parseTenantPolicy`, passed the translator preflight**, and then threw
a raw `ZodError` out of `LedgerEvent.parse` inside the sequencer. A raw ZodError is not an `rpcError`, so the
route mapped it to **500**, not a named refusal.

That is verbatim the harm §19 exists to prevent, reached through the same corrupt-policy vector: the persists
and the tender marker run before the append, so the VAN retries forever and each retry re-accumulates
parties, shipments and markers with no ledger behind them. **The comment four lines above the schema claimed
it pinned "the gate-bearing keys, WHEN PRESENT, have the type the readers assume" — for `visibility` it did
not.** The value is now the shared `Visibility` union, so a new rank can never leave the predicate behind.

### HIGH-2 — `null` meant "unset" to every reader and "refuse every append" to the new predicate

Zod's `.optional()` admits `undefined` and **rejects `null`**. Every knob used it, so `{"gates":null}`,
`{"visibility":null}`, `{"gates":{"dims_required":null}}` were all refused — and a refusal from this
predicate means the sequencer declines **every append for that tenant** and the EDI preflight quarantines
**every tender**. A total outage.

Every consumer already treats these as absent: `policy.gates?.dims_required === true`,
`?? DEFAULT_FENCE_RADIUS_M`, `?? []`, `policy?.[kind] ?? KIND_VISIBILITY_DEFAULTS[kind]`. Null could not
harm any of them. And it is not an exotic input — **it is exactly what a YAML key with no value serialises
to**, and tenant #0's policy is generated from a config pack **outside this repo** (genesis/13). The cruellest
case the review surfaced: a tenant that correctly set `dims_required: true` is taken down because a *sibling*
knob is null. All five knobs are now `.nullish()`.

Both fixes are mutation-proved: reverting `.nullish()` → `.optional()` fails the null pin; reverting the
visibility value to `z.string()` fails the typo pin.

### The pattern, now three-for-three

Every adversarial review this session has found a HIGH inside a fix I had just written and believed correct:
the `{}` fallback that opened three gate knobs (§15→§18), the identical defect left in the branch four lines
below it (§18), and now two outages in the hardening that was supposed to close the class (§27). The common
shape is not carelessness in the fix — it is that **a fix aimed at one failure mode gets reasoned about only
in terms of that failure mode.** §19 was thinking about *malformed* policies and never asked what the new
schema does to *well-formed* ones. The probe the review ran — feed real shapes through and see what the
sequencer actually does — is the step that was missing, and it is cheap.

### Also corrected from the same review

- **A stale count, copied forward four times.** "contracts 276" appears in §20/§21/§22 and three commit
  messages; the commit that reported it had itself added four tests in the same change, so the true count
  was 280 (282 now). Corrected in place with the reason, not silently overwritten.

### Still open from that review (ledgered, not yet fixed)

1. **MEDIUM — the preflight is not before every failure for CLAIMED POOL tenants.** `tenantDbFor` resolves
   36 lines earlier and, for a claimed tenant, reads the same `tenants.policy` and throws `UNKNOWN_TENANT`
   on an unparseable one → uncaught → 500 → the storm. Nothing is written in that case, so the orphan half
   does not apply. My test only exercised the static path. Dark today behind `PROVISIONING_ENABLED`.
2. **MEDIUM — the shared sequencer imports `BaseSequencer` from vitest 4** (root) while all five workers pin
   vitest 3.2.x. It works because `sort()` is fully overridden and v3 calls `shard()` only under `--shard`.
   Needs a root override or a workspace package that pins the workers' version.
3. **MEDIUM — the refusal log now names the wrong cause** ("unparseable, null, an array, or a non-object")
   for what is now also a *shape* rejection. It should log the failing key paths.
4. **LOW — the watchtower re-upsert sits outside the containment try/catch**; a D1 fault there aborts the
   per-tenant loop the containment exists to protect.
5. **LOW — a comment cites a GO-LIVE row that does not exist** (`sequencer.ts`, introduced in §18).
   `check:citations` only validates `path:line` forms, so prose references are unguarded — the same class as
   two defects earlier reviews found.
6. **LOW — `edi_tenant_policy_unusable` is stamped `warn`** and keyed per `(partner, ISA13)`, so a
   tenant-wide outage mints one warn row per tender instead of one alarm saying the tenant is down.
7. **LOW — the TenantPolicy TYPE was not deduplicated** even though the predicate was (three partial copies).

**Verification.** contracts 282, api 730, translator 93, typecheck 0. The agents suite currently reports
17/18 files because the *second* review is mid-run with its own probe files in that worker — not a
regression, and re-verified after it reports.

---

## §28 — Iteration 23 (2026-08-02): two of the seven ledgered findings closed

Working the §27 ledger. Two closed here; the rest remain open and are listed at the end.

### The shared sequencer handed a vitest 4 class to a vitest 3 runner

Measured: the root pins `vitest ^4.1.10`, all five workers pin `3.2.x`. `tools/testing/path-sequencer.ts`
resolves `vitest/node` from the ROOT, so `class PathSequencer extends BaseSequencer` built a **v4 base class
that every v3 runner then instantiated**. It worked — `sort()` is fully overridden and v3 calls `shard()`
only under `--shard`, which CI never passes — but *"happens to work across a major version"* is not a
property to rest on in the harness that decides whether every other test is trustworthy. It is also exactly
the kind of latent coupling that surfaces as an inexplicable failure two upgrades later.

The fix is to remove the coupling rather than paper over it with a version override: **no base class**. The
two methods are implemented directly and the only remaining import is a `type`, which is erased at runtime,
so each project instantiates a plain class of its own vintage. A global `vitest` override in
`pnpm-workspace.yaml` was the other option and was rejected — it would pin the root's own tooling to the
workers' version to satisfy one test-infra file.

`shard()` is **implemented, not stubbed.** A sequencer that returned every file to every shard would make a
sharded run pass while silently re-running the whole suite N times — the precise class of quietly-wrong
harness this module exists to prevent. It shards the path-sorted list, so a file lands in the same shard on
every run. Verified after the change: api 730/730 twice, file order byte-identical, 66 files.

### A comment cited a GO-LIVE row that did not exist

`sequencer.ts` said *"see the GO-LIVE row, which now names it"* about the operational prerequisite the §18
refusal creates. There was no such row — the comment had been asserting one since §18.

**The row was written rather than the reference deleted**, because the prerequisite is real and go-live
genuinely needs it: *every bound tenant needs a `tenants` control row before it can append*. No migration
creates one for a static tenant (`0001` makes the table, `0002` inserts `_platform`, `0003` the pool
sentinels); it is hand-provisioned and therefore hand-deletable — and the guard found a real instance the
day it shipped, `tenant-b` appending with no control row at all. The row also carries the §27 authoring
note: an empty YAML key serialises to `null` and is accepted as *unset*, but a visibility value must be
exactly one of the three ranks.

**The gate gap behind this one is left open deliberately.** `check:citations` validates `path:line` forms
only, so a prose reference like "see the GO-LIVE row" is unguarded — the same class as two defects earlier
reviews found. Extending the checker to prose was **measured and rejected** at `GO-LIVE-CHECKLIST` §375
(411 checked → 25 unresolved → ~19 false, a ~76% false-positive rate), and cry-wolf is how this repo already
lost the trust of one gate. Recorded as a known, reasoned gap rather than re-litigated.

### Still open from the §27 review

| # | Finding | Severity |
|---|---|---|
| 1 | The preflight is **not** before every failure for CLAIMED POOL tenants — `tenantDbFor` resolves 36 lines earlier and throws `UNKNOWN_TENANT` on the same unparseable policy → 500 → the storm. Nothing is written, so the orphan half does not apply. Dark behind `PROVISIONING_ENABLED` | Med |
| 2 | The refusal log names the wrong cause — it says "unparseable, null, an array, or a non-object" for what is now also a *shape* rejection; it should log the failing key paths | Med |
| 3 | The watchtower re-upsert sits **outside** the containment `try/catch`, so a D1 fault there aborts the per-tenant loop the containment protects | Low |
| 4 | `edi_tenant_policy_unusable` is stamped `warn` and keyed per `(partner, ISA13)`, so a tenant-wide outage mints one warn row per tender | Low |
| 5 | The `TenantPolicy` **type** was not deduplicated even though the predicate was (three partial copies) | Low |

**Verification.** typecheck 0, lint 0, api 66 files / 730 (×2, deterministic order), citations OK.

---

## §29–§30 — Iteration 24 (2026-08-02): the second review, and the finding my own enumeration caused

The second review landed while I was mid-fix on the claimed-pool gap. It found that gap **independently**
(its HIGH-1), found two problems in the in-flight fix itself, and — the one that matters most — showed that
the gap existed *because* of a false claim I had written two sections earlier.

### §29 — the claimed-pool resolution gap, and the silent drop in my first fix

§19 placed the policy preflight beside the cert gate, 36 lines below `tenantDbFor`. For a **static** tenant
that is fine (a map lookup that cannot throw). For a **claimed pool tenant** `tenantDbFor` is
`resolveClaimedTenantDb`, which reads **the same `tenants.policy`** with a bare `JSON.parse` and throws
`UNKNOWN_TENANT` — *before* the preflight. Uncaught, that is a **500 to the VAN**: the exact retry-storm §19
claims to close, for the exact corruption §19 names as the threat. The §19 test used `tenant-a`, a static
slug — the one path where the fix works — which is why it passed with the hole open.

Now guarded: resolution failure returns a deterministic **422**, never 5xx.

**My first cut of that guard broke a stated law of the module.** It returned 422 and discarded the tender —
trading a retry-storm for a **lost document**, which is the worse failure and the one `CLAUDE.md` #10 and
this handler's own header explicitly forbid ("NEVER A SILENT DROP"). It cannot quarantine (the anomalies row
needs the tenant D1, which is what failed to resolve) — but the raw bytes never needed it: the R2 key is
`edi/<slug>/…`, keyed by slug alone. The bytes are now preserved at `edi/<slug>/unresolvable/<partner>/<isa>`
before the refusal, best-effort so an R2 fault cannot turn a deterministic 4xx back into a 5xx. The decode
and ISA extraction moved above the guard (both pure) so the key can carry the ISA and a redelivery
overwrites instead of accumulating one object per attempt.

### §30 — the enumeration that caused the gap

§25 documented "three parsers of `tenants.policy`, enumerated and verified". **Both halves were wrong.**

There are **four reader families across twelve call sites**. The one I missed is the pool-binding resolver —
eight bare `JSON.parse(row.policy) as { pool_binding?: string }` sites across agents/translator/billing
`tenants.ts` and api `provision.ts`. It has a **fourth direction, itself split**: on RESOLVE it throws
`UNKNOWN_TENANT`; on ENUMERATE it **silently skips the tenant**, dropping it from every cron sweep. It is
also the most security-relevant read of the column — it decides which physical D1 a slug maps to (REQ-025) —
and it is the mis-keyed-cast shape `parseTenantPolicy`'s Zod schema was added to close, duplicated eight
times.

And the direction I gave for `resolveSparkPlan` was **backwards**: a malformed policy on a `spark` row does
floor to zero, but a **missing row returns `{capped:false}` — uncapped, the fully permissive answer**. That
is deliberate (an unknown tenant is not a confirmed Spark tenant), but §25 asserted the opposite, on exactly
the missing-row case §18 exists for.

**The causal link is the lesson.** §29's HIGH is not an unrelated bug that happened to turn up later. The
translator preflight was placed *after* the pool-binding reader **because my enumeration did not contain
it** — I checked three readers, concluded the picture was coherent, and sited a security guard on that
picture. An enumeration asserted as complete is load-bearing in a way an ordinary comment is not: everything
downstream is reasoned about as if the list were exhaustive. Writing "enumerated and verified" without
having grepped for every reader of the column is how a documentation error becomes a 500 on a money path.

The comment now names four families, twelve sites, both Spark directions, and keeps both corrections visible
rather than quietly restating the conclusion.

### Still open from the second review

| # | Finding | Severity |
|---|---|---|
| 1 | The queue classifier is an **unshared string literal** (`/tenant policy malformed/i`) while the repo has the `GATE_BLOCKED_PREFIX` precedent four lines away in `booking.ts`; the test hardcodes the same literal, so a reword leaves the branch dead AND the test green. (The review's probe with a real cross-script DO confirmed the message *does* survive the RPC boundary, so the branch is live.) | Med |
| 2 | The refusal log names the wrong cause — "unparseable, null, an array, or a non-object" for what is now also a *shape* rejection; it should log the failing key paths | Med |
| 3 | The `policyRow === null` branch in the preflight is **unreachable** (auth joins `pairings → tenants`, so a missing row 401s first — test (h2) asserts exactly that) and its comment claims to cover it | Low |
| 4 | Three reads of one control row per inbound 204 (auth join, `tenantDbFor`, preflight) | Low |
| 5 | `contain` makes a top-level sweep fault invisible to the platform — previously it rejected `scheduled()` and marked the invocation errored; consider an `AggregateError` rethrow after all eight run | Low |
| 6 | The watchtower re-upsert sits outside the containment `try/catch`; `edi_tenant_policy_unusable` is stamped `warn` per `(partner, ISA13)`; the `TenantPolicy` **type** is still triplicated | Low |

**Verification.** contracts 282, translator 94, agents 106, api 730; typecheck 0, lint 0.

---

## §31 — Iteration 25 (2026-08-02): three more from the second review, including the law I broke that was written four lines away

### The classifier was a free-text literal, next to the precedent that forbids it

§23 classified the sequencer's tenant-policy refusal in the agents queue consumer with
`/tenant policy malformed/i` — a regex over an error message produced in a different worker. Four lines from
`booking.ts:89`, which imports `GATE_BLOCKED_PREFIX` from `@shuddl/contracts` for exactly this purpose, under
a comment that states the rule I had just broken:

> *"ONE source of truth for the three modules that otherwise hardcode the literal disjointly … (share-lint
> law: one rule enforced in >1 place shares its matcher)."*

Worse, the §23 test built the thrown message from its **own** copy of the literal. So rewording the
producer's `reason` would have left the consumer branch dead **and the test green** — the "fix that cannot
fail" shape, one level up from the code it guards. The reason is now
`TENANT_POLICY_MALFORMED_REASON` in `errors.ts` beside the prefixes, with an `isTenantPolicyRefusal`
predicate; producer (both throw sites), consumer, and test all derive from it.

Proved by mutation: rewording the constant to `"tenant policy unusable"` keeps all three consistent and the
suite green (12/12). Before, that same reword would have silently killed the branch. *(The review's own probe
— a real cross-script DO whose `append()` throws — confirmed the message survives the RPC hop intact, so the
branch was live; the exposure was drift, not reachability.)*

### The refusal log named a cause that was no longer true

Both refusal sites said *"unparseable, null, an array, or a non-object"*. That was accurate before §19's Zod
shape and misleading after it: the predicate now also rejects **shape** errors, and the likeliest real cause
is a mis-keyed paste on a row that parses perfectly. An operator was being sent to look for a truncated paste
on a row that has none — while a refusal takes the **whole tenant** down.

`describeTenantPolicyRejection` now names the class and, for a shape rejection, **the offending key paths**
(`gates.dims_required`, `visibility.freight.photographed`). Both the sequencer log and the translator's
quarantine reason use it. Key paths only — pinned by a test asserting a policy VALUE never reaches the log,
because a log is not a place for tenant config.

### The unreachable arm now says so

The preflight's `policyRow === null` arm is **not reachable**: `authenticate` joins `pairings → tenants`, so
a tenant with no control row 401s first — and this file's own test (h2) asserts exactly that. Kept as
defence-in-depth (an auth refactor could expose it) but the comment no longer implies coverage it does not
have. Same treatment as `#deviceKey` (§18) and `contain` (§24) — the third time this session that stating
reachability honestly was the right answer instead of deleting or pretending.

### Still open

| # | Finding | Severity |
|---|---|---|
| 1 | Three reads of one control row per inbound 204 (auth join, `tenantDbFor`, preflight) — threading `t.policy` through the auth join removes two subrequests | Low |
| 2 | `contain` makes a top-level sweep fault invisible to the platform; an `AggregateError` rethrow after all eight run would complete the tick AND mark the invocation errored | Low |
| 3 | The watchtower re-upsert sits outside the containment `try/catch` | Low |
| 4 | `edi_tenant_policy_unusable` is stamped `warn` and keyed per `(partner, ISA13)`, so a tenant-wide outage mints one row per tender | Low |
| 5 | The `TenantPolicy` **type** is still triplicated (contracts Zod shape, sequencer TS type, invoice-gate partial) even though the predicate is shared | Low |

**Verification.** contracts 285, translator 94, agents 106, api 730; typecheck 0, lint 0.

---

## §32 — Iteration 26 (2026-08-02): the last Low findings, and one dedup deliberately NOT done

### `contain` completed the tick but told the platform it succeeded

§24 wrapped the eight cron sweeps so one top-level fault could not skip the rest. It shipped as
log-and-continue — which completed the tick and **made the failure invisible**: `scheduled()` resolved, so
the cron invocation was recorded as a success. Before §24, such a throw rejected the handler and the
invocation was marked errored. So the containment had traded one real property for another rather than
adding one.

Both are wanted: every sweep must still run (a failure in the second must not skip the remaining six) **and**
the tick must still be reported as failed. Failures are now collected and rethrown as an `AggregateError`
after all eight have run — placed after the `finally`, so it can never mask an anchor error (an anchor throw
propagates from the `try` and skips this line entirely).

### The watchtower re-upsert was outside the containment it was added inside

Two corrections to how §20 shipped it. The `await raiseAlarm(...)` sat **outside** the `try/catch` that
contains the fallback fault, so a D1 failure there aborted the whole per-tenant loop — the exact outcome the
containment three lines above exists to prevent, reached one step later. *A reporting improvement must not
become the thing that stops the report.* And it was gated on `didFallback || fallbackError`, so a drifting
module **already on `legacy`** got no `fell_back` key at all, leaving "not attempted" and "not reported"
indistinguishable to whoever reads the alarm. It now always writes the key, with `attempted` saying which.

### The TenantPolicy type dedup: tried, reverted, and recorded as a decision

The review's last Low was that §19 shared the *predicate* but left the *type* triplicated. Inferring
`TenantPolicy` from the schema was implemented and then **reverted**: `.nullish()` + `.passthrough()` infers
keys as REQUIRED-with-undefined (`gates: X | undefined`) rather than OPTIONAL (`gates?: X`), which
`exactOptionalPropertyTypes: true` rejects at every consumer. Closing that needs either transform gymnastics
in the schema — which make it harder to read than the duplication removes — or loosening the gate signatures
in `packages/ledger`, which is the wrong direction on the code that decides whether an append is refused.

**So this is duplication kept on purpose, with the reason recorded at the schema.** The drift risk is bounded
in a way the earlier duplications were not: the schema alone decides *acceptance*, and a consumer type that
disagrees with it fails to compile against the parsed value. That is a different situation from seven copies
of a SQL predicate (§14) or two copies of an id function (§13), where each copy independently decided
behaviour — and the distinction is exactly what §30 got wrong by pattern-matching. Worth stating plainly:
**not every duplication is the drift class, and "we consolidated the last three" is not a reason to
consolidate the fourth.**

### Remaining, and why they stay open

| # | Finding | Disposition |
|---|---|---|
| 1 | Three reads of one control row per inbound 204 (auth join, `tenantDbFor`, preflight) | Open — a performance refactor of the auth join on the highest-risk EDI seam, for two subrequests. Not worth the risk in the same session that changed this file four times |
| 2 | `edi_tenant_policy_unusable` is `warn`, keyed per `(partner, ISA13)` — a tenant-wide outage mints one row per tender | Open — the severity vocabulary and the exceptions-queue grouping are a product decision, not a code fix |

**Verification.** contracts 285, ledger 607, api 730, agents 106, translator 94; typecheck 0, lint 0.

---

## §33 — Iteration 27 (2026-08-02): I found the fourth one myself, by asking the reviewer's question

Before the fourth review reported, I worked through the questions I had written *for* it — on the grounds
that if I could only think to ask them of someone else, I could think to ask them of my own code. Two of
them found something.

### The `attempted` field lied exactly when the fallback worked

§32 added `attempted` to the parity-drift alarm so "not attempted" and "not reported" would stop being
indistinguishable. It derived the value like this:

```ts
attempted: seq !== undefined && (await resolveAuthority(db, module)) === "native",
```

That is a **second** call to `resolveAuthority`, made *after* the fallback ran. And a successful fallback
**appends `authority.flipped → legacy`** — so the second call returns `"legacy"` and `attempted` reads
**false precisely when the fallback succeeded.** It was correct only by accident in the failure path, where
authority is still `native` — and the failure path is the one the existing test covered, which is why it
shipped green.

A reporting field that inverts on the outcome it exists to report is worse than no field: the alarm now says
"drifting, and we did not even try" about a module that fell back correctly. The decision is now **captured**
into `attemptedFallback` at the point it is made and reused. Mutation-proved against the success path in
`workers/api/test/watchtower.test.ts`, which drives a real fallback end-to-end.

**The general shape, and it is the third instance this session:** a value re-derived at a later point in the
same function, where something in between changed the world. §13's `usage_credits` identity, §32's
`attempted`, and the §20 `raiseAlarm` placement are all the same mistake — *reading state again instead of
carrying the answer forward.* When the code between the two reads is the code whose effect you are reporting
on, re-deriving is guaranteed to be wrong.

### The AggregateError does not add a retry hazard — verified, not assumed

"A throw here re-runs the whole tick" would be a real hazard (the anchor plus eight sweeps, replayed), so it
was checked. Pre-§24 those sweeps were bare `await`s in the same `finally` **with no catch**, so a top-level
throw already propagated out of `scheduled()`. §24 swallowed it — and in doing so silently downgraded a
failed tick to a successful one. §32 restores the original propagation while adding the guarantee that all
eight run first. The retry posture is therefore exactly what it was before §24, not something new.
`AggregateError` was probed directly in the pool-workers runtime rather than inferred from the spec. Both
facts are recorded in the source.

**Verification.** agents 106, api 730 (incl. the new success-path assertions); typecheck 0, lint 0.

### §33a — the rest of the self-check, including the count I had already got wrong once

Working the remaining questions I had written for the fourth review. §33's `attempted` inversion came out of
this; the rest are negatives, recorded because leaving publicly-posed questions unanswered is its own debt.

**The "four reader families, twelve call sites" count is right this time** — and it was worth re-deriving
rather than trusting, since the previous version of that same sentence said *three* and the error caused a
HIGH. Enumerated every `tenants.policy` read in non-test source (23 raw matches, filtered to consumers):

| family | sites |
|---|---|
| `parseTenantPolicy` (gates + visibility) | 2 — sequencer, translator preflight |
| `readEntitlementPolicy` (hazmat) | 1 |
| `resolveSparkPlan` (AI allotment) | 1 |
| bare `JSON.parse(row.policy) as { pool_binding? }` | 8 — agents/translator/billing ×2 each, api provision ×2 |

**Twelve.** The near-miss worth noting: `provision.ts:294` and `:305` both `SELECT plan, policy` and *look*
like two more, but `proofToCashEnabled` reads **only `row.plan`** — the policy column is over-selected and
never consumed there. Counting them would have made it fourteen and the comment wrong in the other
direction. Checked, not assumed.

**The two parses cannot disagree.** `describeTenantPolicyRejection` re-parses the raw string, so the concern
was that it might describe a different value than the one the refusal decision was made on. Both call sites
pass the *same variable* the decision used — `row.policy` in the sequencer, `policyRow.policy` in the
translator — so they are parsing identical bytes. (The cost is a second `JSON.parse` on an already-refusing
path, which is not the hot path: an accepted append never reaches the describer.)

**The describer emits key paths, never values** — pinned by a test that plants `SECRET-VALUE-XYZ` inside a
policy and asserts it never appears in the output. A refusal log is read by whoever is fixing the row; it
must name the key, and it must not become a place tenant config leaks to.

**`isTenantPolicyRefusal` uses `.includes`, deliberately.** `startsWith(VALIDATION_FAILED_PREFIX)` would be
stricter but breaks the moment the DO RPC hop wraps the message (`Error: VALIDATION_FAILED:{…}`), which is
exactly the boundary this predicate exists to cross. Nothing else in the repo produces that phrase — the
producer is now the single shared constant — so the looseness costs nothing and the strictness would cost
correctness.

**Verification.** No code changed by this section; the `attempted` fix and its pin are §33.

---

## §34 — Iteration 28 (2026-08-02): my own comment claimed a law it only half-satisfied

Continuing the self-check on §29's 422 path. Two questions; one clean, one an overclaim of mine.

**Isolation holds regardless of the ISA content (REQ-025) — verified.** The R2 key is
`edi/<tenantSlug>/unresolvable/<partnerId>/<isaControl>`, and `isaControl` comes off the wire. But
`tenantSlug` and `partnerId` are read from the **control-plane pairing row** (`t.slug`, `p.id`), never from
the client header — the header value is only ever a lookup key, and a miss is a 401. So the object always
lands under an authenticated tenant prefix, and a crafted ISA (even one containing slashes) cannot make it
match another tenant's prefix listing. R2 keys are flat strings, so `..` carries no traversal meaning either.

**The overclaim.** The comment said preserving the bytes satisfied *"NEVER A SILENT DROP (CLAUDE.md #10 / the
Migrator rule, and this module's own stated law)."* It does not, quite. This module's law is what
`quarantine()` does — **an `anomalies` row AND the raw bytes**. The 422 path writes bytes and a log; it
cannot write the anomalies row, because that row lives in the tenant D1 which is exactly what failed to
resolve. So the tender survives but never reaches the exceptions queue: **the data-loss half of the law is
satisfied, the discoverability half is not.**

That is now what the comment says, along with why the partial is acceptable *here specifically*: this branch
means the tenant cannot be resolved at all, so every append is already refused and every tender already
422s — the tenant is comprehensively down and will be noticed for reasons far louder than one missing queue
row. And the condition on that reasoning is written down: **if a future change makes this branch reachable
for a healthy tenant, the justification evaporates and the anomaly needs another home before it does.**

**This is the fourth comment of mine this session to claim more than the code delivered** — after "genuinely
fail-closed" for the missing-row branch (§18), "pinned by the pool parity test" for a test that did not exist
(§13), and "three parsers … enumerated and verified" when there were four (§30). The pattern is narrow and
consistent: **the claim is written while thinking about the half of the problem being solved, and it
silently annexes the half that is not.** I preserved the bytes, was thinking about data loss, and wrote the
name of a law that also covers discoverability. Nothing in the code was wrong — only the sentence describing
it, which is the artifact a future reader trusts instead of re-deriving.

**Verification.** translator 94; typecheck 0, citations OK.

---

## §35 — Iteration 29 (2026-08-02): sweeping my own comments, since the pattern was four-for-four

Four times this session a comment I wrote claimed more than the code delivered (§13, §18, §30, §34). Four
instances of one narrow shape is enough signal to stop fixing them individually and go look for the rest.

Swept every comment line **I added this session** (`git diff 0415148..HEAD` over `*.ts`) for claims of the
form *"can never / always / by construction / satisfies / the law / guarantee"* — **35 lines**, and checked
the strongest ones against the code rather than re-reading them.

**Most held.** `CLAIMED_TENANT_PLAN_SQL` really is built from the frozen array (pinned by test). Reusing the
`Visibility` union really does mean a new rank cannot leave the predicate behind. The platform-tenant
exclusion really does route through the one shared `isPlatformTenant`. The §32 `AggregateError` really does
restore pre-§24 propagation.

**One was stale, and my own later work is what made it stale.** The queue consumer justifies retrying an
unknown-tenant trigger toward the DLQ rather than acking it, and gave this reason:

> *…instead of destroying an invoice trigger the REQ-169 sweep can never rebuild (the crons enumerate only
> the static roster).*

That was true when C3 was hardened. Then §11–§13 made **every cron enumerate `allTenantSlugs`**, so the
sweep *can* now rebuild a lost trigger for a claimed tenant — and the parenthetical became false without
anyone touching that line. The danger is specific: a reader checking whether the retry is still warranted
would find the stated reason no longer holds and conclude *"the sweep covers it now, so we can ack"* — the
opposite of correct. The retry is still right, for two reasons that outlive the original: resolution can
fail for causes no sweep will fix (an unusable policy now refuses **every** append), and a recoverable record
beats destroying a money trigger regardless of who could rebuild it. Corrected in place, both reasons named.

**Two were ported verbatim and named the wrong worker.** The billing and translator resolvers both said "the
platform tenant can never resolve on an **agent** path" — true in substance, wrong in provenance, because
the comment was copied from the agents worker along with the code. Harmless individually; collectively it is
how a reader learns to skim comments instead of trusting them.

**The lesson is narrower than "write better comments."** A claim can rot two ways: it can be wrong when
written (§13/§18/§30/§34 — thinking about one half of a problem and naming a law covering both), or it can be
*made* wrong later by a change somewhere else that never touches it (§35). The second kind is invisible to
review of the changing commit, because the stale line is not in that diff. The only thing that finds it is
periodically re-reading what the old comments assert against what the code now does — which is what this
sweep was.

**Verification.** billing 56, translator 94, agents 106; typecheck 0, lint 0.

---

## §36 — Iteration 30 (2026-08-02): the fourth review, and the HIGH my own §34 comment described but did not see

The fourth review confirmed §33's `attempted` fix and §33a's re-derived count independently, then found a
HIGH in §29 that I had walked right past.

### HIGH — the 422 catch was unconditional, so a blip on a HEALTHY tenant lost a tender

`catch (err)` around `tenantDbFor` trapped **every** throw. But that call is not only a deterministic
classifier: for a claimed-pool tenant it does a **live control-plane D1 read**. A transient fault there — a
connection blip, a D1 overload — landed in the same catch and produced **422**, which a VAN does not retry,
on a perfectly healthy tenant. The tender then existed only as an R2 object under a prefix nothing in
non-test source enumerates: no anomalies row, no alarm, no queue entry. **A lost freight tender from a
network hiccup — the exact "worse of the two failures" the guard was written to prevent.**

Two things make this worse than an ordinary miss. First, **§34's comment states the escape condition** —
*"if a future change makes this branch reachable for a HEALTHY tenant, that reasoning evaporates"* — and I
failed to notice no future change was required; it was already reachable. Second, it was **internally
inconsistent with the same session**: §31 added `isTenantPolicyRefusal` precisely so a consumer could tell
deterministic from retriable **by inspecting the error**, and this guard classified by *position in the code*.
I applied the right discipline in one worker and the wrong one in another, days apart in the same sitting.

Now: `isUnknownTenant` (shared from contracts, beside the §31 predicate) gates the 422; anything else
**rethrows** → 5xx → the VAN retries, which is correct for the one condition a retry can fix. Pinned by a
test injecting a `D1_ERROR: Network connection lost` and asserting it stays retriable. The §29 test could not
have caught this: it injected an `UNKNOWN_TENANT` rejection, so it would have passed identically if the
resolver had thrown a D1 error — **it certified the wrong property.**

### MEDIUM — the R2 key could delete the only copy it was preserving

`isaControl` is verbatim ISA13 off the wire: unbounded, partner-chosen. Over ~1 KB it blows R2's key limit,
`put` throws, the inner catch swallows it, and the tender is **gone** — no bytes, no row. (`quarantine()`
survives this because it writes its anomalies row *before* the put; this path had nothing before it.) And
ISA13 is an interchange counter, not a document identity: two distinct unresolvable tenders sharing one
silently overwrote. Now truncated to 64 chars with a body-hash suffix — redelivery still overwrites (same
bytes, same key), a different document cannot.

### MEDIUM — the cron AggregateError did cause a full-tick replay, and my equivalence claim was wrong

Cloudflare **does** retry a throwing `scheduled()` — which is why `ScheduledController.noRetry()` exists in
the workers-types this repo pins. And my note claiming "the retry posture is exactly what it was before §24"
was wrong in a way I should have caught: pre-§24 a throw propagated **immediately**, so sweeps N+1..8 never
ran and the replay re-ran a short prefix; now all eight run and *then* it throws, so the replay re-runs the
anchor plus all eight including the seven that succeeded. **Strictly larger than the baseline I compared it
to.** The condition is deterministic by construction (a binding or pre-fan-out fault), so the retry fails
identically forever — the same "retriable status on a deterministic condition" the translator refused three
commits earlier. `controller.noRetry()` now precedes the throw: one errored invocation, no storm.

### LOW — the leak test asserted the one branch where a leak was impossible

`describeTenantPolicyRejection` emitted key paths, and §33a claimed those "carry no tenant data". False for
`visibility.*`: every key under it is arbitrary tenant-supplied text, so
`{"visibility":{"CUSTOMER-ACME-SECRET-KEY":"bogus"}}` put that string straight into an operator log. **And
the test written to prove no leak planted its sentinel under `gates.dims_required` — a fixed-key branch
where a leak was structurally impossible.** It asserted the safe half and skipped the only unsafe one: the
"fix that cannot fail" shape, inside the test whose entire purpose was to prevent this. The segment is now
collapsed to `visibility.<kind>` with an entry count, and the test covers the branch that actually leaked.

### LOW — the refusal predicate matched free prose

`isTenantPolicyRefusal` used `.includes("tenant policy malformed")`. §33a defended that because nothing in
the repo produces the phrase — true, but the catch it feeds also wraps the **Concierge LLM path and Resend
sends**, whose messages can embed inbound email text and third-party response bodies. A shipper who writes
that phrase in an email would mislabel a retriable failure as deterministic and skip its 429 backoff. Now
matches the structured field `"reason":"…"`, which survives RPC wrapping and cannot come from prose.

**Verification.** contracts 285, translator 95, agents 106, api 730, billing 56; typecheck 0, lint 0.

### §37 — the last review finding, and the older gap it exposed

The review's final Low: the new `edi/<t>/unresolvable/…` key was an inline template literal with no builder
and no isolation case, while `isolation.test.ts` pins `tenderKey`/`tenderPrefix`/`sent214Key` as exported
builders precisely so a dropped `${tenant}` cannot slip through. The repo's own
`prove-tenant-isolation-read-paths` discipline requires both.

**Fixing it surfaced that `edi/<t>/quarantine/…` had the same gap since WP-12** — also inline, also
unpinned, and much older than anything this session introduced. The review flagged the new one; the old one
had been sitting behind the same blind spot the whole time. Both are now builders (`quarantineKey`,
`unresolvableKey`) beside the existing three, and both are covered by isolation case (7).

The case pins the property that actually matters rather than just the string shape: the discriminator is
**partner-influenced** — an ISA13 read verbatim off the wire — so the test feeds it
`"../../tenant-b/quarantine/p9/steal"` and asserts the object still lands under `edi/tenant-a/`. R2 keys are
flat strings, so `..` is literal rather than traversal, but the guarantee worth pinning is structural: the
discriminator is appended **after** the tenant segment and never interpolated before it, so no content in it
can move an object out of its own tenant's prefix (REQ-025). Mutation-proved — dropping `${tenant}` from
`unresolvableKey` fails the case.

**Every finding from all four adversarial reviews is now closed.**

**Verification.** translator 96 (incl. the new isolation case), contracts 285, agents 106, api 730,
billing 56; typecheck 0, lint 0.

### §39 — the re-derived-state lens, swept properly (a clean negative)

§33 named a pattern behind three separate defects — **a value read twice in one flow, where code in between
changed what the second read returns** (`usage_credits` identity §13, the `attempted` alarm field §32, the
`raiseAlarm` placement §20). The pattern was named but never swept for, so it was.

Scanned every non-test source file in `packages/ledger`, `packages/agents` and all five `workers/*/src` for
the same `await`-ed read appearing more than once inside one function — `resolveAuthority`,
`resolveTenantDb`, `parseTenantPolicy`, `computeModuleParity`, `loadTenantRatingConfig`, `allTenantSlugs`.
**Eight candidates, zero genuine instances:**

- Seven are `mountXRoutes()` resolving `resolveTenantDb` once per route handler. Same function *lexically*,
  separate requests at runtime — not a re-derivation, just how the router is written.
- The eighth is `sequencer.ts #append()` consulting `resolveAuthority(db, "dispatch")` twice, at `:698` and
  `:725`. Those are the **mutually exclusive** `appointment.set` and `dispatch.assigned` branches; exactly
  one runs per append, and neither is followed by a write that changes authority.

So the three known instances were the population, not a sample. Worth recording as a negative for the same
reason §26 was: the next reader should not have to re-run this to find out, and "we found three of these"
invites an assumption that more are hiding.

**The lens is now exhausted** — which, with every review finding closed and §4 re-measured by hand at
`fb212fd`, is the honest end of repository-owned auditing for this loop.

### §40 — the rot mode, found in this document's own headline

§35 named two ways a claim rots: **wrong when written**, or **made wrong later** by a change elsewhere that
never touches the line. That sweep was run over source comments. It was never run over **this document** —
which by now is forty sections deep, with its earliest claims written thirty iterations ago.

**§1, the headline — the first thing any reader lands on — was stale in exactly that way.** It is written in
the present tense and asserts three things: that the ops record materially misleads about production, that
three code defects are open, and that there is comment rot in security-load-bearing places. **All three were
closed during this same audit.** Verified rather than assumed: `PROJECT-STATE.md`, `DEPLOYMENT.md` and
`LAUNCH-RUNBOOK.md` now carry struck-through supersedes saying production exists and is live (D1/D2), and
C1/C2/C3 plus the rot are marked FIXED in §2.

So a reader arriving at the top of the audit would conclude the build has three open code defects and an ops
record that lies about production. Neither is true, and the document's own §4 says so — forty sections later.

**Stamped, not rewritten.** §1 is the historical record of what the audit *found*; rewriting it would erase
the finding. The stamp says what state it describes and points at §4's current measurement.

**The instructive part is who invalidated it.** Not a third party, not a later workstream — **this audit's own
remediation**, in this audit's own most-read section. That is the sharpest available demonstration of why the
"made wrong later" mode is the harder one: nobody edits the headline while closing a finding thirty sections
below it, so nothing about the closing commit surfaces the staleness. The only thing that finds it is
deliberately re-reading the oldest claims against the newest state — which is what this was.

**The general rule this session earns:** a long-lived record needs its early sections stamped with the state
they describe, or it will confidently mislead exactly the reader who trusts it most — the one who starts at
the top.

### §41 — the rest of the early sections, checked rather than assumed unique

§40 found the headline stale. Finding one instance and stopping would repeat the reasoning error §39 exists
to prevent, so the other early sections were checked against the tree.

**§5 (session disposition summary) was stale the same way** — and stamped. Its carry-forward list is the
state after iteration 1; two entries have since closed and were verified today, not assumed: the **C3
resolver** (now shipped in all four workers, §11–§13, each with a mutation-proved pin) and **EDI send-time
date stamping** (`3899ae6`). The remaining six are genuinely still open and unchanged. §6's own title — *"the
carry-forward list is closed"* — already superseded part of §5 thirty-five sections ago, which is the tell:
a document that supersedes a section in a later *title* has no mechanism to tell a reader of the earlier one.

**§2 and §3 are NOT stale, for a structural reason worth noting.** They are tables, and every row carries its
own inline status (`FIXED this session`, `Med→resolved`, `OPEN`). A row that closes gets edited in place, so
the section cannot drift from the tree. **§1 and §5 rotted precisely because they are PROSE summaries** — a
paragraph asserting "three code defects" has nowhere to put a status, so closing the defects leaves the
sentence untouched and wrong.

That is the generalizable finding, and it is about form rather than diligence: **in a long-lived record, a
per-row table stays true for free; a prose summary of the same facts needs an explicit as-of stamp or it
will silently become a lie.** The two sections that misled were the two written as prose, and they were the
two most likely to be read first.

Stamps rather than rewrites throughout — §1 and §5 are the record of what those iterations *found* and
*disposed of*. A carry-forward list that is silently rewritten stops being evidence of anything.

### §42 — the structural hypothesis, tested against the ops record (it held)

§41 claimed a cause rather than an observation: **prose summaries rot because they have nowhere to put a
status; per-row tables stay true because closing a row edits it in place.** A cause is worth more than a
pattern only if it predicts something, so it was tested on the record it did not come from.

**Prediction:** the `docs/ops` ledgers should be *un*-rotted by this session's work, despite covering exactly
the seams that changed — because they are tables.

**Result: held.** Swept `docs/ops/*.md` for behavioural claims about what this session changed — the `{}`
policy fallback, cron enumeration, retry posture, the EDI 500. **Zero un-superseded stale claims.** Every one
is struck through in place with a dated supersede, several chained across multiple corrections in a single
row (the C3 row at `GO-LIVE-CHECKLIST.md:380` carries four). The new sequencer refusal has its own row
(§28). The row form forced each closure to touch the claim.

**The test-count claims are also not stale, for a second reason worth separating:** they are *dated
evidence* ("translator 10 files / 91 PASS (2026-08-02)"), not current-state assertions. A dated measurement
does not rot — it stays a true statement about that moment. Rewriting them to today's numbers would destroy
evidence to gain nothing. **Undated** counts would be a different matter; there are none.

So the two rot modes have two different remedies, and neither is "try harder":

| form | rots? | remedy |
|---|---|---|
| per-row table with inline status | no — closing edits the row | none needed |
| dated evidence claim | no — it is true of its moment | none needed |
| **undated prose summary** | **yes, silently** | an explicit as-of stamp (§40, §41) |

**This is the end of repository-owned auditing for this loop.** Every review finding is closed, §4 is
re-measured by hand at `fb212fd`, the last unswept lens came back a clean negative (§39), and the record's
own two prose summaries are stamped. What remains is owner input: the GTM workstream's `REQ-289`, the two
External Highs, the five private-fixture holds, and the R2→R5 grades that consume accounts, credentials,
devices and counsel.

---

## §43 — the security record still listed a closed defect as an OPEN threat, and it corrects §41's hypothesis

§42 swept `docs/ops` and declared the record clean. **That sweep had a hole I named its scope after: the
maintained record also includes `docs/security`, which the audit cites and never checked.** Closing my own
gap found real debt.

**`threat-model.md` still carried the release-record binding as an OPEN threat row** — *"the comparison is
self-satisfied by construction and can never fire"* — for a defect **closed in §16** (`10a95f5`), twenty-five
sections earlier. Four more instances in `pen-test-basics.md`: a DISPOSITIONED residual row, a Low finding
row, and two prose re-verdicts. **A security reviewer reading the threat model today would find an open
threat that no longer exists**, and would reasonably plan work around it. All five are now superseded in
place with the commit and the evidence.

### This corrects §41, and the correction is the more useful finding

§41 concluded that **per-row tables stay true for free, because closing a row edits it in place.** Four of
these five stale claims are *table rows with status cells*. The form did not save them.

The refinement: **a table row stays true only if whoever closes the finding knows the row exists.** The row
makes the update *possible*; it does not make it *happen*. What actually kept `docs/ops` current was not its
tabular form but that the same person, in the same session, closed the finding and edited its ledger — the
ops record was in my working set, and `docs/security` was not. §16 fixed `tools/release/run-gate.ts` without
either of us knowing that two security documents cited that exact file:line as an open exposure.

**So the real mechanism is the citation link, and this repo has half of it.** `check:citations` verifies that
every `path:line` in the docs resolves to a real file and an in-bounds line — it answers *"does this citation
point somewhere valid?"* It cannot answer the question that would have caught this: *"which documents cite
the file I just changed?"* That reverse index is the missing piece, and it is exactly what a fix-author
needs at commit time.

Naming it and not building it: a reverse-citation check is **new scope**, and `CLAUDE.md` requires a REQ row
signed by the owner before it gets built. Recorded here as the specific, actionable gap it is.

**The honest correction to my own three-section theory:** §41 and §42 attributed to *form* what was really
*proximity*. The ops ledger stayed true because it was the document I had open, not because it had columns.
That is worth more than the original claim, and it is the second time this session that testing a
generalisation against a case it did not come from is what exposed it.

**Verification.** All five supersedes applied; no un-superseded "self-satisfied" claim remains in
`docs/security`; citations OK.

## §44 — running the missing reverse-index by hand, and the two more it found

§43 named the gap: `check:citations` answers *"does this citation resolve?"* but not *"which documents cite
the file I just changed?"* Building that is declined scope — but **running it once, by hand, for this
session is auditing, not building.** So it was run: every source file changed since `0415148`, cross-indexed
against every maintained `.md`.

**39 changed source files are cited in the record.** The reverse index immediately paid for itself:

- **`sequencer.ts` is cited by NINE documents**, including three `docs/wp/*` work-package files I had never
  opened this session. Checked: their "policy" references are retention-policy and consent-policy text, a
  different sense of the word entirely. **Clean — but only knowable by looking.**
- **`run-gate.ts` is cited by five.** §43 fixed two of them. The index pointed at the other three, and **two
  more carried the same dead claim**: `RELEASE-EVIDENCE.md`'s *"It does not prove"* section (the very
  section the security docs cited as the system of record for this exposure) and a `GO-LIVE-CHECKLIST.md`
  Q4 prose answer. Both now superseded.

**Seven instances of one dead claim, across four documents.** My §42 sweep of `docs/ops` missed two of them
for a reason worth naming: **I grepped for the vocabulary of the defects I remembered** — "falls back",
"gate-knob", "static roster", "retry-storm" — and the §16 defect's word was *self-satisfied*, which was not
on my list. A keyword sweep finds what you already thought of. The reverse index doesn't need you to
remember anything; it starts from the diff.

### What this settles

Three sections in a row generalised about *why* records rot — form (§41), then confirmed by prediction
(§42), then corrected to proximity (§43). §44 is the one that actually matters operationally, and it is
duller than all three: **the mechanism is a reverse lookup, and this repo has the forward half only.** A
fix-author cannot be expected to remember which of nine documents cites the file they are editing; that is
what an index is for.

The gap is now named with its exact shape (§43), demonstrated to find real debt when run manually (§44,
three documents it caught that keyword sweeps missed), and left unbuilt because a new gate needs an
owner-signed REQ row. That is the most useful state I can leave it in without straying.

**Verification.** All seven instances superseded; zero un-superseded `self-satisfied` claims remain in the
maintained record; citations OK.

## §45 — the reverse index, continued: a security boundary that shipped with no record entry

§44 ran the reverse index and then stopped after following up **2 of the 39** cited files. Continuing with
the security-relevant ones found a different kind of gap — and one that drifts in the *opposite* direction
from everything else this session.

**`packages/ledger/src/redact.ts` is cited by six documents, including both security records.** Its payload
claims (party geo coarsened to ~11 km, margin/GL internals stripped) are still exactly true. But this session
added **envelope redaction** — the law binds the whole event, not just the payload — and **neither security
document mentions it. Zero hits.**

What was leaking: `override` (REQ-049 — an internal ops **user id** plus the **free-text reason** a
server-side gate was waived) reached party AND driver lenses through the `{ ...event }` spread, so a party
reading an overridden `invoice.issued` learned it was force-billed over the POD gate, by whom, and why —
the same leak class as the C1 margin defect. And `actor.user` reached party lenses, defeating the
REQ-192/REQ-167 rationale that strips `payload.driver_user_id` by letting the same id ride the envelope.

**The fix shipped 2026-08-01. The record entry did not.** Now added: a surface row in `pen-test-basics.md`
beside the other `redact.ts` rows, and a dated `threat-model.md` log entry.

### Why an *understated* record is still debt

Every other stale claim this session drifted in the dangerous direction — the record asserting a protection
or an openness that was not real. This one is the opposite: **the record understated the protection.** That
is safe for a reader making decisions today, and it is still debt, for two reasons that only matter later:

1. **A pen-tester works from this document.** A boundary absent from the surface table does not get probed —
   so the one artifact whose job is to enumerate what must be attacked would have skipped it.
2. **The table is the regression net.** A future refactor could drop the envelope strip and nothing in the
   security record would flag it, because the record never claimed it existed. A protection nobody has
   written down is a protection nobody will notice losing.

**The reverse index found this and a keyword sweep never could have** — there was no stale phrase to grep
for. The absence of a claim has no vocabulary. That is the strongest argument yet for the reverse-citation
index named in §43: it starts from *what changed*, so it surfaces both the claims that went false and the
claims that were never written.

**Verification.** Both security documents updated; citations OK.

## §46 — a threat row marked CLOSED, resting on a mitigation whose failure mode was unrecorded

Continuing the §44 reverse index into the rest of the security-relevant changes. This one is the most
significant record gap of the session, and it is not a stale claim — it is a **true claim with an unstated
dependency.**

`threat-model.md` carries **"Lens / geo leakage … CLOSED"**, and names its mitigation as *"server-side lens
filtering + **per-event visibility** + redaction."* Every word of that is true. But §18's vector runs
underneath it:

**Visibility is resolved from `tenants.policy` and stamped onto the event AT APPEND TIME, and events are
immutable (I3/I7).** A policy row that was unreadable, absent, `null`-valued, or carrying a one-character
`visibility` typo fell through to `{}` / per-kind defaults — dropping every narrowing override. A tenant that
had set `document.attached: internal` would have had those events stamped `counterparty` and exposed through
the portal lens **permanently**, and the lens would have behaved *exactly as designed the whole time*.

**Not a lens defect. A defect in what the lens was asked to enforce.** The row's mitigation is only a
mitigation while the stamp is right, and nothing in the security record said the stamp had a failure mode.
A threat row reads as CLOSED while resting on an assumption nobody wrote down.

Closed at the source across three iterations — §18 (refuse rather than stamp on defaults), §19 (the shared
predicate plus the EDI preflight), §27 (`.nullish()` so `null` means unset, and the `Visibility` union so a
typo is refused at the boundary instead of 500ing mid-append) — each mutation-proved. Now recorded: the
threat row is **qualified** with the dependency and how it is enforced, there is a dated log entry, and
`pen-test-basics.md` gains a surface row for the stamp-time vector with its proofs.

### The forward half caught my own edit while I was writing this

Inserting the log entry shifted `threat-model.md` by three lines, and `check:citations` failed immediately:
a content-anchored citation from `GO-LIVE-CHECKLIST.md:58` pointed at `threat-model.md:62@provenance` and the
anchor had moved to `:58`. Repointed; 954 citations resolve.

That is worth noting beside §43–§45, because it shows the two halves are complementary rather than
redundant. **The forward check is excellent at what it does** — it caught a line shift within seconds of my
making it. What it cannot do is answer *"which documents should I re-read because I changed
`sequencer.ts`?"* Both halves are needed; this repo has one, and the sections above are what the missing
half found when run by hand.

**Verification.** Both security documents updated; the shifted citation repointed; 954 citations resolve;
ratchet at its frozen baseline.

## §47 — the highest-risk external ingress had no threat row at all

The reverse index (§44) listed which documents cite each changed file. `workers/translator/src/inbound.ts`
came back cited by **plans and WP docs only** — nothing in the maintained security record. That is the
strongest signal the index produced, and following it found the largest record gap of the session.

**`POST /edi/204/inbound` had no threat-model row and no pen-test surface row.** The module's own header
calls it *"the highest-risk EDI seam"*. It is an **authenticated external write path**: an outside partner
POSTs over the public internet, and the handler persists parties and shipments to tenant D1, writes R2
objects, and appends through the api sequencer DO. The threat model enumerates email in/out, deploy
configuration, TSA receipts, lens leakage, forged `party_id` — and not this.

**The code is not the problem.** Every control was read from source before being written down, not assumed:
HMAC-SHA256 over the raw body against the pairing's `secret_ref` with a deliberately non-short-circuiting
compare; the pairing must be `kind='edi'` AND `status='active'`; any auth failure is a 401 with nothing
written; the composition root binds `NotConfiguredSecretResolver` so every live 204 401s until the
CONFIRM-gated secret store is wired; a non-`certified` partner is quarantined rather than parsed (REQ-203);
a 1 MiB cap rejects before any read; the tenant slug and partner id come from the pairing JOIN rather than
the client header; every R2 key is built tenant-segment-first and pinned by isolation case (7); and the
append set stops at `quote.accepted` so `booking.created` is unreachable from here (REQ-030).

**The defect was that none of it was enumerated where a reviewer looks.** An ingress absent from the attack
surface does not get attacked in a review — the threat model *is* the list a pen-tester works from, and this
one was not on it. Now added: a STRIDE row with each control and its proof, plus two probeable surface rows
(forged/replayed 204; a partner reaching another tenant's R2/D1).

### What the index was actually good for

§43–§46 each found a claim that had gone false or was never written. This one is different in kind: **the
index flagged a file whose citations were all in non-maintained documents.** That pattern — *"cited only by
plans"* — is a specific, mechanical signal that a piece of the system exists in the design record and never
made it into the operating record. No keyword sweep produces that; it falls out of the shape of the index.

**And the forward check caught me again, twice.** Both §46's and §47's insertions shifted `threat-model.md`,
rotting a content-anchored citation each time (`:55@provenance` → `:58` → `:60`). Both repointed; 956
citations resolve. Three shifts, three catches, zero escapes — the forward half is doing its job precisely
while the reverse half stays absent.

**Verification.** Threat model + pen-test record updated with source-verified controls; 956 citations
resolve; ratchet at its frozen baseline.

## §48 — the "cited only by plans" signal, run across the whole repo

§47 found the EDI ingress missing from the security record because the reverse index showed it cited by
**plans and WP docs only**. That signal is mechanical, so it was run over every source file rather than only
the ones this session changed: for each `workers/**` and `packages/{ledger,agents}/src` module, is it cited
in the **operating** record (`docs/ops`, `docs/security`) or only in the **design** record (`docs/plans`,
`docs/wp`)?

**69 modules are in the design record and absent from the operating one. Nineteen are boundary-shaped** —
routes, public capability endpoints, webhooks, auth:

```
pub/doc-cap.ts · pub/status-cap.ts · routes/{approvals,devices,documents,driver-manifest,export-journal,
export,import,intake,invoices,kpis,portal-actions,public,status-link,tariff}.ts ·
billing/src/webhook.ts · mcp/src/{caps-meter,oauth}.ts
```

**Path-matching alone would over-claim, so the significant ones were checked by NAME** — the §46 lesson that
a true claim can exist without citing a file. Result: **`/pub` is genuinely covered** (8 references across
the security record) and is *not* a gap. Two are:

1. **The Stripe webhook ingress (`workers/billing/src/webhook.ts`)** — covered only *obliquely*. The security
   record discusses it exactly once, as a **consequence of a different control**: "a worker deploys without
   the secret it cannot run without — billing accepting forged Stripe callbacks." That is a deploy-config
   row. There is no row for the ingress itself: signature verification, replay, or the idempotency of the
   credit stamp it drives. Same shape as §47 — a surface named as a side effect, never enumerated.
2. **MCP OAuth (`workers/mcp/src/oauth.ts`)** — appears once, in the *"stack under test"* preamble
   (`MCP OAuth pairings`). Named as existing; no threat row, no surface row, no proof references.

### Recorded rather than filled, deliberately

Nineteen boundary modules is a **bounded, visible piece of work** — enumerating an attack surface is exactly
the kind of thing that should be reviewed, not appended silently across one iteration by the same person who
found it. §47 was written because the gap was unambiguous (the highest-risk seam, zero coverage, and the
controls were already in code and tested). Extending that to nineteen modules in a single pass would produce
a large volume of security-record prose with no independent check — the failure mode this session has
demonstrated four times over.

**So the deliverable here is the enumeration and its priority order**, with the two verified instances named
and `/pub` explicitly cleared. The next iteration — or a reviewer — can work the list without re-deriving it.

**The broader point about the index:** §43–§46 used it to find claims that were *wrong*. §47 and §48 use it
to find things that were *never said*. The second class is invisible to every technique this session tried
before it — a keyword sweep needs a phrase to search for, and the absence of a claim has none. That is the
argument for the reverse-citation check (§43), now with five sections of evidence behind it and still
correctly unbuilt pending an owner-signed REQ row.

## §49 — filling the two §48 gaps that were VERIFIED, and only those two

§48 enumerated nineteen boundary modules absent from the operating record and deliberately did not fill
them. Two had been checked by name and confirmed as real gaps; those two are now written, and the other
seventeen are still just enumerated.

**The Stripe webhook ingress** had been discussed exactly once in the security record — as a *consequence*
of the missing-secret deploy control ("billing accepting forged Stripe callbacks"), never as an attack
surface of its own. It now has a threat row and a probeable pen-test row, with every control read from
source first: the raw body is read once and never re-serialized before verification; the Stripe scheme is
implemented in-repo with no SDK (`t=<unix>,v1=<hex>`, signed payload `${t}.${rawBody}`), HMAC-SHA256 on the
full `whsec_…` secret, **constant-time against every `v1` candidate** (multiple signatures during key
rotation); a **5-minute timestamp tolerance** closes the replay window with the idempotent emitter as the
second line, since credit events append through the real sequencer and dedupe by event id.

One detail worth surfacing because it is a deliberate design choice rather than an accident: an **unbound
secret returns 503, a forged or stale request returns 400.** Those are kept distinct on purpose — one means
*configure the server*, the other means *this request is not genuine* — and conflating them would hide an
outage as an attack, or an attack as an outage.

### The MCP OAuth row says it has not been verified

`oauth.ts` and `caps-meter.ts` mediate agent access through control-plane pairings with scopes and caps. The
row records the surface and then **states plainly that its controls were not re-read in this pass.** §48
established the surface is missing from the operating record — that is the finding, and it is complete. The
controls are a separate verification that has not happened.

Writing it any other way would have been this session's own signature failure: §13 shipped a comment
claiming a parity pin that did not exist; §30 claimed an enumeration "verified" when it was not. **A threat
row asserting controls nobody checked is worse than one that admits it has not checked them** — the first
gets trusted, the second gets worked. The row names its own next step.

### Why seventeen stay unfilled

Not fatigue, and not scope-avoidance: enumerating an attack surface is a security deliverable, and it should
be reviewed rather than produced in bulk by whoever happened to find the gap. §47 and the Stripe row were
written because their gaps were unambiguous **and** their controls were already implemented and tested — the
writing was transcription, not judgement. The remaining seventeen need someone to decide what each surface's
threats actually are, which is exactly the kind of work that wants a second pair of eyes.

**Verification.** Threat model + pen-test record updated; two content-anchored citations repointed after the
insertion shifted them (four shifts this session, four caught by `check:citations`, zero escapes); 956
citations resolve; ratchet at its frozen baseline.

---

## §50 — verifying the row §49 left unverified, and finding that §49 had damaged the document while writing it

§49 ended by marking the MCP OAuth row **ENUMERATED-NOT-VERIFIED** and naming its own next step: read
`oauth.ts`/`caps-meter.ts` against the row and either fill in the proofs or record what is missing. This
section does that. It found one real code gap, and — while looking — two defects §49 itself introduced.

### 50.1 The controls are real (read from source, not assumed)

`workers/mcp/src/oauth.ts` (367 lines) and `caps.ts`/`caps-meter.ts` hold up. PKCE **S256 required**, no plain
fallback. The authorization code is **deleted up front**, before anything that could throw, so it cannot survive
a failed exchange. Expiry is enforced **logically** on `record.exp`, with the KV `expirationTtl` as a GC belt
rather than as the check. `/register` requires the pairing secret via `timingSafeEqual`, so knowing a `client_id`
does not let a caller overwrite `redirect_uris`; an unknown pairing and an unauthenticated one are
**indistinguishable** (both `401 invalid_client`) — no enumeration oracle. Scope must be ⊆ the server capability
**and** ⊆ the pairing's own allowlist, and is *rejected*, never silently truncated. Tenant and role are
pairing-derived; a client-supplied `tenant`/`role` in either call is ignored. The access token is opaque — the
client never receives the `SessionClaims` JWT. Caps: spend and velocity are a read-modify-write in the
`CapsMeter` DO (mutex-chained, idempotent by `idemKey`, a storage fault fails the booking **closed**); the lane
allowlist lives in `caps.ts` and fails closed when present-but-malformed; an unconfigured cap (`{}`) is **zero**
capacity, never ∞.

### 50.2 The code gap: the open-redirect guard was pinned by nothing

`/authorize` exact-matches `redirect_uri` against the registered set — the guard against the classic OAuth
open-redirect / authorization-code-interception attack. **No test exercised it.** All sixteen existing cases used
the registered URI, so deleting the guard left the entire suite green.

Two cases added, both mutation-proved:

- **Presence** — an unregistered `redirect_uri` must be refused *directly* (400, no `location` header). A 302
  here **is** the vulnerability, whatever the query string says.
- **Ordering** — the guard must run *before* the `fail()` closure that reports errors via redirect. This is the
  case that matters: with the guard merely *moved below* the first `fail()`, the presence test still passes while
  `response_type=token` + an attacker URI yields a live 302 to the attacker carrying `error` + `state`.

Mutation results: removing the guard fails both new cases and **all 16 pre-existing cases still pass** — the
removal was invisible to the suite that existed. Moving it below `fail()` fails only the ordering case. A control
with no test is a control that leaves silently.

### 50.3 The record gaps: §49 damaged the document in the same edit that improved it

Two formatting defects, both invisible in a source diff, both drifting the record toward **claiming more safety
than exists** — the dangerous direction.

1. **A fused row.** §49's insert omitted a trailing newline and welded the pre-existing **CI/supply chain —
   dependencies** row (lockfile pinning, gitleaks, OIDC, the REQ-167 denylist lint) into the MCP row's last cell:
   9 pipes on a 4-column row. Markdown keeps four cells and drops the rest, so an entire mitigation row vanished
   from the rendered threat model — deleted by the edit that added one.
2. **Three over-wide rows.** The table header declares **3** columns; the rows added in §47, §49 and §50 each
   carried a 4th "status" cell. That cell is dropped at render — and it is exactly where the residual risk lives:
   *"the endpoint is DARK in every environment"* (Stripe), *"nothing authenticates a real partner today"* (EDI).
   The rendered document showed controls **without their caveats**. A reader would conclude Stripe webhook
   verification was live. It is not.

Both fixed by merging the overflow into the last column; nothing was deleted to achieve it.

### 50.4 What this says about §49's own verification

§49 closed with "Verification: threat model + pen-test record updated; 956 citations resolve; ratchet at
baseline" — and every word was true while the document was broken. `check:citations` passes on a fused row,
because a fused row has no citations in it. **The verification checked the half that was fine.** That is the
third instance this session of a claim written about the half being solved (§13/§30/§45), and the first where
the claim was mine about work I had done ten minutes earlier.

### 50.5 Two gates, one of which was already ceremony

- **`check:tables`** (new, `tools/docs/check-table-shape.mjs`): a table row must have exactly as many cells as
  its header. Under-wide rows are not flagged — markdown pads them and nothing is lost. Mutation-proved against
  both shapes above (over-wide → caught; fused → caught, reported as 7 cells against a 3-column header).
- **`check:citations`** (existing): found to be **wired into no gate at all** — not `ci.yml`, not `verify:dev`,
  not the release profile. It is discussed in five documents and has caught **seven** citation-rot defects this
  session, every one of them only because a human happened to type the command. It could not have blocked a
  merge. Now on the merge surface.

Both are pinned by name in `tools/release/ci-contract.test.ts`, mutation-proved (removing the citations gate
fails the contract test), because a record gate is the easiest kind to quietly drop: nothing breaks when it goes,
the build stays green, and the damage only surfaces the next time somebody trusts a document.

**Immediately vindicated:** adding those 7 lines to `run-gate.ts` shifted three content-anchored citations, and
the newly-wired check caught all three in the same commit that wired it.

**Verification.** `workers/mcp` 177 tests green (was 175); the two new OAuth cases mutation-proved in both
directions; 36 gate-contract tests green; `check:tables` OK across 109 markdown files; 956 citations resolve;
ratchet at its frozen baseline. Threat-model MCP row moved from **ENUMERATED-NOT-VERIFIED** to **CLOSED —
verified against source, with one coverage gap found and fixed.**
