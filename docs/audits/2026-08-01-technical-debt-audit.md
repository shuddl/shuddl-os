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
2. **Every baseline gate green** at the closing SHA — the merge surface being whatever
   `gatesFor("merge")` returns (`tools/release/run-gate.ts`), **not a number written here** — and
   `verify:merge` BLOCKED **only** on the five named private-input holds.
   *Corrected 2026-08-02 (§57). This clause used to name an "11-gate static set", which §52 updated to 13 and
   §56 would have made 14. **None of those reconcile with the actual list**: the merge surface is 24 gates —
   15 non-skippable plus 9 skippable, of which 4 are the browser gates. The figure was a hand-maintained
   count of a list the build already owns, so it drifted every time a gate was added and was wrong before this
   session touched it. Replaced with the source of truth instead of a fourth number to maintain — the same
   defect this audit keeps finding in prose, in its own phase gate.*
   **`pnpm test` means BOTH surfaces:** `test:tools && pnpm -r test` — the root `tools/` suite and every
   workspace. *(Corrected 2026-08-03, §113: this clause named "the 691-test root suite and all 17 workspaces
   (2,867)". Both figures had decayed — the counts are the suites' to state, not this document's, per §64/§110.
   Read them from a run, never from here.)* §38's headline counted 16 workspaces and 2,648, omitting `packages/agents`
   entirely as well as `tools/`; corrected in §52. The `&&` also means a tools failure short-circuits before
   any workspace runs, so "`pnpm test` is red" does not tell you the workspaces were even reached.
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

---

## §51 — measuring a guard that says "ANY", and finding it means "five of twenty-eight"

§50's lesson was a class, not an incident: **a control whose coverage nobody measured**. The open-redirect guard
existed and was pinned by nothing. So this section went looking for the same shape at the highest-stakes
boundary — redaction, where an unpinned strip is a leak with no net.

### 51.1 The redaction strips are genuinely well pinned

Unlike the OAuth surface, `packages/ledger/src/redact.ts` is covered: 18 tests, per-kind, both directions
(the party/driver lens loses the field, the tenant lens keeps it), plus a depth test that plants an internal
field in an off-contract nested shape and proves the structural strip still reaches it. Mutation-proved:
unregistering `booking.created`/`division` fails the suite with the intended message. **No defect here.**

### 51.2 But the general guard's name overstates it by a factor of five

One test is called *"GENERAL fail-closed guard: NO known-internal key survives the party lens for ANY
counterparty-default kind"*, and `redact.ts` cited it as proof that no internal field survives for **any** kind.
Measured rather than trusted:

- It loops **28** counterparty-default kinds. All 28 build — the claim's headline is true as far as it goes.
- Its assertion only bites on a kind whose fixture payload actually **carries** one of its five known-internal
  keys. That is **5** of the 28: `booking.created`/`division`, `dispatch.assigned`/`driver_user_id`,
  `invoice.issued`/`gl_map`+`division`, plus `payment.received` and `settlement.executed`, which an earlier pass
  seeded on purpose precisely because it had spotted the vacuity risk for those two.
- For the other **23** the assertion is trivially true. And `KNOWN_INTERNAL` is a five-key hand list —
  `floors`, `basis`, `versions` (real quote internals, stripped via `REDACTIONS`) are not in it.

So a loop over 28 kinds does real work on 5. That is the same overstatement §50 kept finding, in the place
hardest to notice it: a test name. The per-kind tests carry the actual protection; this one is a net under the
**registry**, not evidence that every kind was checked.

### 51.3 The silent `continue` — dormant, and one new kind away from mattering

The loop used to swallow a fixture failure with a bare `continue`. Nothing was skipped today, so it cost
nothing. But a future counterparty kind that `eventFixture` cannot express would have dropped out of "ANY"
with **no report at all** — the guard would still pass, the name would still say ANY, and the coverage loss
would be invisible. This is precisely how `check:citations` came to be cited in five documents while wired into
no gate: nothing announces its own absence.

### 51.4 What changed

Three things, all inside REQ-192/REQ-210, none of them new scope:

1. **Skipped kinds now fail the test and are named**, instead of vanishing.
2. **An exercised-count ratchet** (`>= 5`) so a fixture change that hollows out a currently-exercised kind
   fails rather than quietly reducing the guard's reach. Mutation-proved: removing the `division` seed from
   `settlement.executed` drops it to 4 and fails.
3. **The `redact.ts` comment now states what the guard actually verifies**, and says to read it before relying
   on it — including the sentence that matters to whoever extends this next: *adding a kind here means adding
   its per-kind test, because the general guard will not catch what its fixture does not carry.*

**Not done, deliberately:** widening `KNOWN_INTERNAL` to the quote internals, or seeding all 23 vacuous kinds.
Both would be me choosing, in a hurry and alone, what counts as an internal field for two dozen event kinds —
the same judgement call §49 declined to bulk-write for the seventeen boundary modules. The gap is now measured
and stated, which is what makes it reviewable.

**Verification.** `packages/ledger` 607 tests / 34 files green (run in-package; a root-level `vitest run` reports
16 collection failures against the same tree, a config artifact of the workspace layout, not a real failure —
worth knowing before anyone reads a root run as a regression). Both new assertions mutation-proved, and the
guard's core purpose re-proved by unregistering a real strip. 956 citations resolve; ratchet at baseline.

---

## §52 — re-measuring the phase gate, and finding the measurement itself had a hole

§4's last stamp is `fb212fd` (§38). Thirteen sections and several commits later — including §50, which
**changed the gate set itself** — an unre-measured stopping line is exactly the asserted-not-measured claim this
audit exists to catch. Re-measured at `cf97a0f`, condition by condition.

### 52.1 The headline test count was missing a quarter of the tests

§38 reported **"2,648 tests across all 16 workspaces, every one passing"** and enumerated them. Re-run today:
**17 workspaces, 2,867 tests, all passing** (`pnpm -r test`, exit 0). The arithmetic closes exactly:

    2,648  (§38's figure)
    +  217  packages/agents — AN ENTIRE WORKSPACE, absent from §38's list
    +    2  the two open-redirect cases added in §50
    = 2,867

§38's list contains one `agents` entry (106 = `workers/agents`). **`packages/agents` — 217 tests in 9 files —
was never in the count.** It is not a peripheral workspace: it holds the 13 agents, and it is one side of the
REQ-024 boundary that CLAUDE.md declares statically linted (*LLM calls only inside `packages/agents`, never in
`packages/ledger`*).

And a second surface was missing: the **root `tools/` suite — 691 tests in 26 files**, which is where the tests
*of the gates* live (traceability, coverage, the release-gate contract). The measurement that certified the
gates excluded the tests that certify the gates.

**Real total: 3,558 tests** across 18 surfaces. The audit's headline named 2,648 — **908 short, about a
quarter.** The gate itself was never fooled: `verify:merge`'s `unit-tests` gate runs `test`, which is
`test:tools && pnpm -r test`, so both surfaces were always executed. **What was wrong is the record, not the
enforcement** — and a reader auditing coverage from this document would have believed two workspaces' worth of
tests did not exist.

### 52.2 `pnpm test` is RED, and short-circuits before the workspaces

`pnpm test` fails today — and because it is `test:tools && pnpm -r test`, it fails **at the tools stage and
never reaches a single workspace**. Three failing tests, all register parsing:
`traceability.test.ts` (register contiguity past the approved terminal ID) and two in `coverage.test.ts`
(100%-classification, and the pure/total disposition).

Root cause isolated **by experiment, not inference**: stash the uncommitted `REQ-289` row → 23/23 pass and
`check:coverage` goes green; restore it → red again. Every one of the three failures, and the
`check:coverage` failure, is the concurrent GTM workstream's uncommitted register row. **Not this loop's to
commit** (`CLAUDE.md`: a register row is owner-signed scope), so it stays red and stays named.

### 52.3 The four conditions at `cf97a0f`

1. **Zero open repository-owned Critical/High — SATISFIED.** §50 and §51 each closed what they found
   (the unpinned open-redirect guard; the unmeasured guard coverage plus its silent `continue`). Counted by
   hand, per §38's warning that a grep over prose under-reports. The two open Highs are unchanged and
   **External**: driver custody handoff (needs manifest party refs + the deferred REQ-069 seam) and the live
   EDI adapter (needs transport credentials). The one pre-R4 repo carry-forward is still resolve-path
   pool-binding exclusivity (§12), dark behind `PROVISIONING_ENABLED`.
2. **Baseline gates green — SATISFIED but for the one row that is not this loop's.** 2,867 workspace tests
   pass; the 691-test tools surface has the 3 REQ-289 failures above. Static gates: runtime, invariants,
   rater-purity, authority-coverage, traceability, seed, citations (956 resolving, ratchet at frozen
   baseline), **tables** (new, §50), design audit, typecheck, lint — all PASS. `check:coverage` FAILS on
   REQ-289 alone.
   **Condition 2's own wording is now stale and is corrected here:** it says *"the 11-gate static set"*;
   §50 added `citations` and `table-shape` to the merge surface, making it **13**.
   > **SUPERSEDED by §57.** "13" was wrong too, and so was the "11" it corrected. The merge surface is **24**
   > gates (15 non-skippable + 9 skippable, 4 of them browser). I replaced one unreconcilable hand-count with
   > another instead of reading `gatesFor("merge")` — the exact move this audit criticises elsewhere, made
   > while correcting a stale number. Condition 2 now points at the list rather than counting it.
3. **Remaining debt entirely External or CONFIRM-gated — SATISFIED**, unchanged: five private-fixture holds,
   two External Highs, the GTM register row, R2–R5 grades, and the two no-gate holds (on-call rota, 7-year
   archive). Plus one deliberately-deferred record item: threat rows for the 17 boundary modules §48
   enumerated, left for review rather than bulk-written (§49's reasoning still stands).
4. **The record agrees with the world — SATISFIED ONLY AFTER THIS SECTION.** It did not when the section
   opened: §38's test count omitted 908 tests, and §50 found the threat model rendering three residual-risk
   statements as nothing. Both corrected. This is the fourth time this loop that **the record was the defect**
   while the code was fine.

**The stopping line is unchanged and is reached again at `cf97a0f`.** Repo-owned Critical/High is zero; every
gate that can pass does; the one red gate and the three red tests share a single cause that requires an owner
signature. Beyond this line the build consumes accounts, credentials, devices, fixtures and counsel — working
past it from inside the repo produces either scope-straying or gate-relaxing, both forbidden by
`CLAUDE.md`/`genesis/00`.

---

## §53 — REQ-024 was enforced against imports only, and my first attempt to close it rested on a wrong measurement

§52 found that `packages/agents` had been absent from the audit's test count. That raised the obvious follow-up:
if it was invisible to the measurement, was the boundary it sits on ever actually checked? `CLAUDE.md` states
REQ-024 as law — *LLM calls only inside `packages/agents/*` — **never** in `packages/ledger`, statically
linted*. So: verify the "statically linted" part.

### 53.1 The lint is real, and it only sees imports

`eslint.config.mjs` bans a genuine family for `packages/ledger` (`@anthropic-ai/*`, `anthropic*`, `openai*`,
`@openai/*`, `ai`, `@ai-sdk/*`, `@shuddl/agents*`, `*agents*`), `tools/checks/rater-purity.ts` mirrors it for
the rater, and both are tested. **But both are import-based.** A model is reachable with

```ts
await fetch("https://api.anthropic.com/v1/messages", { method: "POST", body })
```

and no import at all. The lint passes that. `rater-purity.ts` is admirably explicit about its regex/import
limitations — but neither file mentioned this route, so the gap was not merely open, it was unrecorded.

### 53.2 My first fix asserted a fact I had not actually measured

I wrote a package-wide `fetch` ban and justified it in the comment with *"this package is network-free today
(measured, not assumed)"*. It is not. `pnpm lint` immediately failed on
`packages/ledger/src/tsa/client.ts:61` — an RFC 3161 trusted-timestamp client, a legitimate, reviewed network
egress that has been there all along.

**Why the measurement missed it, exactly:** I grepped for `fetch(`. The line reads
`private readonly fetchImpl: typeof fetch = fetch,` — the token appears three times and **not once followed by
a parenthesis**. The grep could not have found it. This is the same defect shape as §16's false all-clear (a
crude pattern over source that under-reports) and it failed in the same direction: it told me a hazard was
absent when it was present. **The lint caught my error in the same minute I wrote it**, which is the argument
for the gate rather than against it.

### 53.3 What shipped, corrected to the real shape

A package-wide ban with **one named, tested exemption**:

- **`packages/ledger/**`** — `fetch` banned. The message names the sanctioned alternative rather than just
  refusing.
- **`packages/ledger/src/tsa/**`** — exempt. Safe for a reason worth stating: `HttpTsaClient` takes
  `fetchImpl: typeof fetch = fetch`, so every caller can inject a stub and the default is a convenience; and it
  speaks to a timestamp authority whose response is **verified** (imprint and nonce are checked against what
  was sent), not to a model. Keeping the ban package-wide with a single exception is the point — it makes that
  egress the only one, *visibly*, so a second cannot appear without editing the config and explaining itself.
- **`packages/rater/**`** — `fetch` banned outright; the rater genuinely has no `fetch` token anywhere. Framed
  as REQ-004 first: a price that depends on a network call is not reproducible, which is a determinism problem
  before it is ever an LLM problem.

Three tests added to `lint-guards.test.ts`, covering the ban, the rater, **and the exemption** — an untested
exception is how a rule silently becomes no rule. Mutation-proved: widening the exemption from `src/tsa/**` to
`packages/ledger/**` fails the ledger-core test, which is precisely the edit that would hollow it out.

### 53.4 Scope note

This is enforcement of an existing law, not new scope: REQ-024 and REQ-004 are register rows, `CLAUDE.md`
already asserts REQ-024 is statically linted, and this closes the distance between that claim and the
enforcement. No new capability, no new REQ row required.

**What it does not do:** stop deliberate obfuscation (`globalThis["fet"+"ch"]`). True of every lint in this
repo, and not the threat model — the realistic case is a well-meaning *"just ask the model to classify this
event"*, and that route is now closed.

**Verification.** lint 0, typecheck 0, `check:rater-purity` PASS, tools/checks 246 tests green (7 in
`lint-guards`, 3 of them new), citations 956 resolving, tables OK.

---

## §54 — auditing the hard-budget line: six of seven already enforced, and two of my own "unenforced" calls were wrong

§53's method — take a claim `CLAUDE.md` states as enforced and go verify the enforcement — applies directly to
the **hard budgets**, declared there as *"CI-enforced; exceeding = the PR is wrong"*. Seven checkable claims.

| Budget | Enforcement found | Verdict |
|---|---|---|
| ≤22 tables | `check:invariants` — reports `21/22 tables` on every run | **Enforced** |
| Events append-only | `check:invariants` — 11 migration files walked, lock checked | **Enforced** |
| 35 event kinds | Four separate assertions: `events.test.ts`, `booking.test.ts`, `comms.test.ts`, and `visibility.test.ts` on the defaults map | **Enforced** |
| ≤12 canonical views | `apps/command/src/views/registry.ts` — `assertViewBudget()` is called AT MODULE IMPORT, so any importer trips it, plus `registry.test.ts` (which also tests name-uniqueness, so a duplicate cannot hide an over-budget add) | **Enforced** |
| 5 color tokens | `tools/design/audit.ts` — `NAMED_COLORS` denylist (REQ-145) | **Enforced** |
| 2 font families | `tools/design/audit.ts` font audit | **Enforced** |
| 0 shadows/gradients/radius>4px | `tools/design/audit.ts` shadow/gradient/radius audits | **Enforced** |
| **3 surfaces** | `SURFACES` in `tools/deploy/surface-contract.ts` — a hardcoded three-entry deploy contract, **with no count tripwire** | **Gap — closed here** |

### 54.1 Two absence claims I made from greps were both wrong

Working through the list I twice concluded a budget was unenforced and printed `(none = unenforced)` — for
event kinds and for canonical views. **Both were wrong, and both are enforced.** The greps missed them because
the enforcement does not look like the pattern I searched for: the view budget is a runtime `throw` on
`length > MAX_CANONICAL_VIEWS`, not a `toBe(12)`.

Recorded because it is the *third* time in two sections that a grep-shaped absence claim failed in the
under-reporting direction (§53's `fetch(` miss, then these two). The pattern is now unmistakable: **a grep
proves presence, never absence.** Each time it was caught only by opening the file. Nothing in this session has
made me wrong about absence when I actually read the code — and nothing has made me right about it when I
only grepped.

### 54.2 The one real gap, and why its interesting direction is the reverse one

The 3-surface budget had no tripwire. But the failure worth guarding is **not** a fourth surface — nobody adds
an entire app by accident, and a fourth surface is already a never-build item under owner signature.

The realistic failure is the reverse: **an app directory that exists while `SURFACES` does not list it.** That
app then deploys nowhere, and *every* surface gate stays green — because each one iterates `SURFACES`, so an
unlisted app is not checked, not deployed, and not reported. A silent drop, which the Migrator rule forbids
outright, in the one place where the gate's own data structure defines what gets looked at.

Two tests added to `surface-contract.test.ts`, both mutation-proved:

- Dropping `driver` from the contract fails (and takes 8 sibling tests with it — the existing suite partly
  covered this, but nothing *named* the failure).
- Creating a fourth app directory on disk fails the disk-vs-contract test alone, cleanly.

### 54.3 Verdict

**The hard-budget line in `CLAUDE.md` is honest.** Six of seven budgets were already enforced, several better
than the line implies — the view registry's uniqueness test and the import-time assertion are stronger than a
count check, and the event-kind budget is pinned in four places. This is largely a **clean negative**, which is
worth writing down: an audit that only records what it broke gives no signal about what it examined and found
sound.

**Verification.** `tools/deploy` 24 tests green; both new tests mutation-proved in both directions; lint,
typecheck, citations (956), tables all PASS.

---

## §55 — the I1–I8 invariants, swept: all eight enforced; one operator-facing citation rotted onto the wrong code

§54 audited the hard budgets as an enumerable set. The same method applied to the deeper set: the schema
invariants **I1–I8** in `genesis/10`, which sit at **#2 in the source-of-truth order** — above the design
system, above the build spec.

| Invariant | Enforcement, read (not grepped) | Verdict |
|---|---|---|
| **I1** no money_line without event | `event_id TEXT NOT NULL REFERENCES events(id)` in `0002_domain.sql`, **verified empirically** (below), pinned by `schema-domain.test.ts:55` and again by an `INSERT OR REPLACE` case so REPLACE cannot defeat it | **Enforced** |
| **I2** no invoice without `pod.signed` | The I2 gate runs in the sequencer BEFORE the append, with three documented carve-outs (`_platform` credit-pack sale, `source:'legacy'` mirror record, and the INERT serviceClass exemption) | **Enforced** |
| **I3** no event edit/delete at DB level | Append-only triggers, pinned across `schema-core.test.ts` for UPDATE, DELETE, `INSERT OR REPLACE` on four distinct UNIQUE collisions, and `ON CONFLICT DO UPDATE` | **Enforced** |
| **I4** custody events co-signed | `events.ts` `superRefine`: a device-namespaced event must satisfy `device_id === actor.device` AND carry `sig` — binding the offline dedupe key to the signing key, so no device can squat another's slot | **Enforced** |
| **I5** every quote pins rate_config versions | `z.object({ rate_config_ids: z.array(z.string()).min(1) }).strict()` at the event boundary | **Enforced** |
| **I6** visibility respected by every view | Stamp-time visibility + per-lens redaction; §51 measured the general guard's real reach and ratcheted it | **Enforced** |
| **I7** correction pairs net zero in GL | `lens-adversarial` case 8 plus the `gen-gl-netting` fixture, which pins the round-trip to the penny | **Enforced** |
| **I8** any 22nd table = build failure | `check:invariants`, reporting `21/22` on every run | **Enforced** |

### 55.1 I1 was verified by experiment, and the experiment lied twice first

The FK is written in DDL — but SQLite **ignores foreign keys unless `PRAGMA foreign_keys=ON`**, this repo sets
that pragma nowhere, and it has already been bitten by a D1 pragma default (`recursive_triggers=0`, which is
why the append-only guards need BEFORE INSERT triggers). So "the DDL says REFERENCES" is not an answer.

A throwaway probe answered it: **`PRAGMA foreign_keys = 1`** in D1/miniflare, and an otherwise-valid
money_line whose only defect is a dangling `event_id` fails with
`D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT`. I1 holds at runtime.

**Both earlier attempts returned "rejected: true" for the wrong reason** — first `no such table` (migrations
not applied), then `NOT NULL constraint failed: money_lines.party_id`. Either would have been recorded as
"I1 enforced" by anyone reading only the boolean. A rejection is only evidence when you read *why* it was
rejected; the probe had to be narrowed until the FK was the single remaining defect.

### 55.2 A fourth grep-absence failure, one section after writing the rule down

I concluded "no test pins I1" from `grep money_lines … | grep -i orphan|FK|reject`. The test exists and is
named *"event_id FK rejects **a money_line** for an unknown event"* — **singular**. The grep for `money_lines`
could not match it.

That is the fourth such failure in three sections, and it came immediately after §54 recorded the rule and a
memory was written for it. The rule is not "grep more carefully" — it is that **a null grep result is not
evidence of absence, ever.** What saved it here was not caution but method: running the experiment and then
opening the file. The wrong conclusion was never published.

### 55.3 The one real defect: a checklist row aimed at the wrong code

`GO-LIVE-CHECKLIST.md` carries a correct, well-graded row for the inert POD-gate exemption — fail-**safe**
direction stated, remediation named. Its citation — `sequencer.ts` line 281 — had **drifted ~61 lines onto the
`authority.flipped` stream guard**. An operator following it lands on an unrelated invariant and reasonably
concludes the row is stale or the gap is gone.

`check:citations` cannot catch this: line 281 is *in bounds*, so the citation "resolves". This is exactly the
rot the anchor ratchet exists to discourage — and `sequencer.ts` is one of its ten high-churn targets.
Re-pointed to `workers/api/src/do/sequencer.ts:342@invoice_without_pod_classes`, **with an anchor**, so the
next drift fails the gate instead of silently mis-aiming a reader. The ratchet correctly demanded the
improvement be banked (2 → 1 unanchored for this pair); baseline now 130.

**Two further citations looked identically rotted and were deliberately NOT touched.** Lines 370 and 373 cite
the same stale `sequencer.ts` line-700 range — but they are *historical rows recording that very correction*
("that range is the `booking.created` gate, while the ratecon marker is at `:926-929`"). The stale citation is
their subject. Editing them would have destroyed the record of a fix in the name of tidying it — the same
mistake in the opposite direction, and the reason §5's superseded lists are annotated rather than rewritten.

### 55.4 Verdict

**All eight invariants are enforced**, several in more than one place, and I1/I3 far more thoroughly than the
one-line statements in `genesis/10` imply. This is a **clean negative** on the invariant layer — the second
consecutive section to find the declared laws honestly enforced. The defect found was, once again, in the
**record** rather than the code.

**Verification.** 957 citations resolve (26 content-anchored, up one); ratchet banked at 130 and green;
tables OK.

---

## §56 — the append chokepoint was true by coincidence, and nothing was guarding it

`CLAUDE.md` rule 3: *gates are server-side; any flow reachable by API must enforce the same gate (REQ-030)*.
The sequencer's own comment states the mechanism — the DO is *"the single chokepoint EVERY append (every
route, every internal seam) traverses"*. §54 and §55 both ended in clean negatives, so this section went at
the strongest structural claim in the system rather than another enumerable list.

### 56.1 The claim is true — and held up by nothing

Every writer of the `events` table in non-test source, enumerated:

- `workers/api/src/do/sequencer.ts` — the chokepoint.
- `tools/seed/load.ts` — the developer seed loader, not reachable by API.

That is the whole list. **The property is real. Nothing enforces it.** There is no lint, no test, and no type
that would notice a third writer appearing.

**And the database cannot cover for it.** The append-only triggers (`0003`, `0008`) are collision guards:
they `RAISE(ABORT)` on a duplicate `id`, `(stream_id, seq)`, `hash`, or device slot. A direct insert with a
*fresh* id collides with nothing, so it is accepted — and it skips the POD gate (I2), the booking gates, the
interline floors, the credit-authorization gate, the visibility stamp, and the `prev_hash` chain, writing
whatever chain values it likes. Every gate in the system lives on the path this bypasses.

This is the same shape as §50's open-redirect guard and §53's import-only REQ-024 lint, but on the highest-value
target yet: REQ-024 (no LLM in the ledger) and REQ-004 (rater purity) each already have a source-glob lint,
while the **append path — where every gate actually is** — had none.

### 56.2 `check:chokepoint`

`tools/checks/append-chokepoint.ts`: the `events` table may be written only by an allowlisted module, and the
allowlist carries a *reason* per entry, not just a path. A new writer fails with the specific consequence
("bypassing the sequencer DO — and with it EVERY gate…") and an instruction that adding to the allowlist
requires an owner-signed register note.

Mutation-proved on both realistic shapes: a new route doing `INSERT INTO events`, and an agent using
`INSERT OR IGNORE INTO "events"` — the quoted-identifier, alternate-verb variant that a naive matcher misses.

**It flagged its own documentation on the first run**, along with `invariants.ts`'s explanation of the same
rule — both matches inside comments. That produced the comment-stripper, which is now the most carefully
tested part of the check, because it is where a **false negative** would hide: over-strip and a real bypass
inside a template literal becomes invisible. Four tests pin it, including a `//` inside a string (a URL is not
a comment) and an escaped quote.

Wired into the merge surface and pinned by name in `ci-contract.test.ts` — mutation-proved: unwiring the gate
fails the contract test. Pinning matters more than usual here, because a gate enforcing an **absence**
produces no failing test when it stops running.

### 56.3 What this does not claim

Static, regex over source text — the same guarantee class as `rater-purity.ts`, and its limitation is written
into the file. It does not resolve a table name assembled at runtime, and it is not a substitute for reviewing
anything that builds SQL dynamically. It closes the realistic regression — *a new route or agent that writes
the ledger directly because it is convenient* — not a determined author.

Scope: enforcement of REQ-030, an existing register row and a stated `CLAUDE.md` law. No new capability, no
new REQ row.

**Verification.** `check:chokepoint` OK (2 allowlisted writers); 6 chokepoint tests + 25 CI-contract tests
green; both bypass shapes and the gate-unwiring mutation proved RED; lint, typecheck, citations, tables PASS.

---

## §57 — the /v1 prefix does not imply authentication, and the guard I nearly wrote would have said it did

§56 pinned the append chokepoint. The same question, asked of the other chokepoint: **REQ-025/156 — the tenant
is resolved server-side, never client-supplied, and a cross-tenant read is a build failure.** What stops a new
route from being reachable without a token at all?

### 57.1 What is already right

`workers/api/src/middleware/auth.ts` does better than ignore a client-supplied tenant — it **rejects** the
request outright (`403 TENANT IS RESOLVED SERVER-SIDE, NEVER CLIENT-SUPPLIED`) if `X-Tenant-Id` or `?tenant=`
is present at all. Refusing is the right posture: ignoring would leave a caller believing it had switched
tenant.

And `app.use("/v1/*", auth)` is a genuine wildcard chokepoint — 39 of the 46 mounted paths sit under it and
none of them can forget it. The other seven are accounted for: four `/pub/*` (the stranger-facing funnel plus
two unguessable cap-token reads) and two `/internal/*` (behind the fail-closed `PLATFORM_INTERNAL_SECRET`,
DARK by default). No route is unaccounted for.

### 57.2 The premise I was about to encode was false

I was one step from writing the obvious guard — *every path must start with `/v1/` or be allowlisted* — which
encodes "the `/v1` prefix implies authentication".

**It does not.** Hono runs matching handlers in **registration order**, and `GET /v1/health` is registered
*above* `app.use("/v1/*", auth)`. Probed rather than reasoned about:

```
NO-TOKEN /v1/health -> 200
NO-TOKEN /v1/whoami -> 401
```

`/v1/health` is deliberate and documented (REQ-111/114 probe target, returning `{ok, env}` and nothing else),
so this is not a defect. **The defect would have been the guard**: it would have passed while asserting
something untrue, and gone on passing for the next route someone registers above that line — which is exactly
where an accidental hole would appear, since the line is 96 of a 270-line file and nothing marks it.

That is the §51 failure mode (a test whose name claims more than it checks) caught *before* shipping instead
of after, and the thing that caught it was the same as every other time this loop: **probing instead of
reasoning.** The route table said `/v1/health`; only the request said `200`.

### 57.3 `auth-surface.test.ts`

Six cases asserting the real mechanism:

1. The auth middleware **is registered** — the premise every other case rests on. Without this the rest prove
   nothing about a file that deleted it.
2. **Nothing answers before auth** except an allowlisted probe — computed from registration order, not from
   the path. The `app.use("*")` middleware entries (reqId, cors) are excluded as non-handlers.
3. Every mounted path is `/v1/*` or in a **self-gated namespace**, each carrying its own stated gate.
4. Both allowlists must carry a *reason*, not a bare path.
5. **Behaviour:** `/v1/whoami` 401s without a token while `/v1/health` answers 200 — the wiring claims above,
   re-checked against what the server actually returns.
6. **Behaviour:** a client-supplied `X-Tenant-Id` is rejected 403, not ignored.

Mutation-proved on the two shapes that would really happen: a route registered one line *above* the middleware
(caught, naming the route and telling you to move it below or justify it), and a route on a new top-level
prefix (caught, saying it has no authorization at all).

Scope: enforcement of REQ-025/030/156, all existing rows. No new capability, no new REQ row.

**Verification.** `workers/api` 736 tests / 67 files green (up 6); both mutations proved RED with actionable
messages; source restored byte-identical.

### 57.4 A postscript on §4 condition 2 — I made the same mistake while fixing it

Adding the `append-chokepoint` gate meant condition 2's "13-gate static set" was stale again, having been
stale in §52 too. I updated it to **14** — and then checked, and 14 is wrong. So were 13 and 11.

`gatesFor("merge")` returns **24** gates: 15 non-skippable plus 9 skippable, of which 4 are the browser gates.
No grouping of that list yields 11, 13, or 14. **The figure never reconciled**, including before this session
touched it; each pass incremented the previous wrong number by the gates it had just added, which preserves
the error exactly.

The fix is not a fourth number. Condition 2 now names `gatesFor("merge")` as the surface and counts nothing —
because a hand-maintained count of a list the build already owns will drift every time, and drifted three
times here.

Worth recording as a **process** finding rather than a content one: I was one edit from committing 14, and the
only reason I did not is that I ran the list instead of trusting my own arithmetic. That is the fifth instance
this loop of *"the record was the defect"*, and the second where the defective record was one I had just
written (§50 fused a row while adding one; this incremented a wrong count while correcting it). **Both times
the failure was doing the arithmetic in prose instead of asking the system.**

---

## §59 — "idempotency keys on all mutations" is true, via four mechanisms, only one of which is the middleware

Two claims tested this pass. The first was a **clean negative in one command**: `CLAUDE.md` rule 5 declares
*"the $222,084/35-lb anomaly regression is permanent (REQ-040)"*, and it is — `fixtures/anomaly/the-222084-case.json`
plus `packages/rater/test/anomaly.test.ts`, which pins the exact figures (35 lb, 22,208,400¢), asserts
`over_per_lb` against the safety cap, and separately checks the fixture's own stated expectation. A named
regression declared permanent, and actually permanent.

The second is REQ-106/156: **"Idempotency-Key required on all mutations."**

### 59.1 The middleware is strong, and it is mounted by prefix

`middleware/idempotency.ts` **requires** the key (400, not a shrug), scopes the KV key by hashing
`tenant∥method∥path∥key` with a NUL separator so one tenant can never replay another's response (REQ-025) and
a ~10KB path segment cannot overflow KV's 512-byte limit — a real past bug. And it caches **only 2xx**
(REQ-206): a 4xx precondition failure or a 5xx committed nothing, so it must stay retryable; caching it would
replay a stale failure while `next()` never re-runs, silently losing the write a corrected retry intended.

But it is `app.use("/v1/*", idempotency)` — the same prefix mounting §57 examined. **Six mutating routes sit
outside `/v1/*`** and the middleware never runs for them.

### 59.2 All six are idempotent — by four different designs

Read from source, not assumed:

- `POST /pub/quote` — **appends nothing, by construction.** The module imports no sequencer/DO/append surface
  at all, so a retry merely re-prices.
- `POST /pub/signup` — **structural.** Workspace slug and email are UNIQUE, so a duplicate signup is a 409,
  never a second tenant.
- `POST /internal/platform/credit-append` — **content-derived event id.** A redelivery re-derives the same id
  and the sequencer dedupes it (once-out).
- `POST /internal/platform/credit-settle` — **a no-op once paid**: it flips issued→paid only while a covering
  `payment.received` is committed and the total is uncovered.

So the law holds everywhere. **What was missing is that this is four designs, not one** — a reader who assumes
the middleware covers the whole API is wrong, and a seventh route added to `/pub/*` or `/internal/*` would
inherit no deduplication at all. On `/pub/*` a duplicate is usually harmless; on `/internal/*` it is money.

Four cases added to `auth-surface.test.ts`: the middleware is registered; every mutating route outside `/v1/*`
must appear in a map that **names how it deduplicates**; those reasons must be reasons rather than
restatements; and a behavioural check. Mutation-proved on both shapes — a new `POST /pub/contact` fails
naming the route and telling you to mount it under `/v1/*` or record its mechanism, and removing the
middleware's key requirement fails the behavioural case.

### 59.3 The behavioural case was worthless as first written

I first wrote it as `expect([400, 401]).toContain(res.status)` against an **unauthenticated** request. That
passes on the 401 a token-less request already gets — it would have proved nothing about idempotency, while
appearing to. It is the same shape §51 measured (a test asserting the one branch where the property cannot
fail), authored by me one section after documenting it.

Rewritten to authenticate first and assert `400` **and** that the body names the requirement, so it can only
pass for the intended reason. The mutation confirms it: dropping the key requirement now turns it RED, which
the `[400, 401]` version would have survived.

**Verification.** `auth-surface.test.ts` 10 tests green; both mutations RED; source restored byte-identical.

---

## §60 — `CLAUDE.md` asserted as green two fixtures the manifest marks pending

Rule 4 carried a parenthetical: *"The 504-quote monotonic sweep and 48 engine tests ship in `fixtures/` and
must stay green."* Both halves are checkable, and this is the governing file — the first thing every session
reads.

### 60.1 They do not ship, and the gate says so

`fixtures/manifest.json`:

```
{ "id": "rater-48-tests",  "status": "pending", "sha256": null, "source": "manifest.private M-01 …" }
{ "id": "rater-504-sweep", "status": "pending", "sha256": null, "source": "manifest.private M-01" }
```

Both are engagement-workspace artifacts that have never been vendored. `check:fixtures` reports
`PENDING, executed: false, assertions: 0` and lists them among nine pending rows — and **exits 2 under
`--mode merge`**, which is exactly one of the five known private-fixture holds.

**The system is honest here; the document was not.** The gate blocks, prints its pending rows on every run,
and refuses to record a PASS it did not earn. `CLAUDE.md` told the reader those artifacts were present and
green.

### 60.2 What is actually green, and it is not nothing

`packages/rater/test/sweep.test.ts` is a deliberate **stand-in**, and says so in its own header: a *property*
test rather than a fixture replay, over 7 zones × 72 ascending weights (50…19,930 lb, straddling every break
boundary) — `expect(cells).toHaveLength(504)`, every cell `PRICED`, weight-monotone and distance-monotone.
It proves the same invariant against tariffs this repo controls, which is why deficit-weight guarantees it for
any valid ascending-break tariff.

So "504" in-repo is a **coincidence of grid shape**, not the audited engine's 504 quotes. Both are real; they
are not the same artifact, and the parenthetical conflated them.

### 60.3 This was found once before and only half-recorded

The 2026-07-15 audit already logged it (row **L-10**): *"The Law-4 headline fixtures gate (48 engine tests +
504 sweep, REQ-027/165) is dormant in the `verify` chain — only exercised in-repo, not by the gate."* That
finding is accurate and it is **thirteen months** of sessions old in audit-time. What never happened is the
correction propagating to the sentence that caused the confusion. The finding lived in an audit; the false
claim lived in the file everyone reads first.

That is the §45 lesson exactly — a correction recorded somewhere true but not where it is load-bearing — and
the most consequential instance of it found this loop, because of *where* the stale sentence sat.

### 60.4 Corrected

Rule 4's parenthetical now states what is pending, what blocks (`--mode merge` → exit 2), what is green
in-repo, and that the audited engine's sweep arrives with the vendored fixture. **No law, budget, or scope
changed** — the imperative ("no price on air: missing weight/dims → UNKNOWN, no sell") is untouched. Only a
factual claim about repository state was corrected, which needs no register amendment.

**Verification.** `packages/rater` 154 tests green; `check:fixtures` exit 0 local / exit 2 merge (unchanged —
the correction describes the gate, it does not alter it); citations and tables PASS.

---

## §61 — my own §60 fix created a divergence, and rule 6 names a gate that does not exist

Two consequences of §60, one of them self-inflicted.

### 61.1 The correction was applied to the copy, not the source

`CLAUDE.md` is **generated from `genesis/11-REPO-CLAUDE-MD.md`**, and that file carries the identical rule-4
sentence at line 24. So §60 corrected the copy and left the source saying the false thing — meaning the next
regeneration of `CLAUDE.md` would silently reintroduce the claim I had just removed, and the corrected file
would look like the deviant one.

That is the **fix-the-instance-not-the-class** pattern this audit has already recorded twice (§55 found a
correction applied to one of three citation sites; the memory note `enumerate-callers-dont-generalize-the-fix`
exists for it) — and I walked into it while fixing a record defect, which is the second time this loop that
the act of correcting produced a new defect (§50 fused a table row while adding one; §58 incremented a wrong
count while correcting it).

Closed by annotating `genesis/11` with the same dated correction, phrased so the **law text is untouched** and
only the parenthetical is marked wrong. The note says explicitly that `CLAUDE.md` is generated from it, so the
two cannot drift apart again silently.

### 61.2 Rule 6 lists four fixture gates; one of them does not exist

*"Fixtures gate merges: legacy-export replay ±2% aggregate · **routes ±10%** · QB export reconciles to the
penny · airplane-mode soak for driver flows."* Checked one by one:

| Named gate | Reality |
|---|---|
| legacy-export replay ±2% | Real — `legacy-export-replay` in the manifest, `status: pending` (an owner hold, correctly reported) |
| QB export reconciles to the penny | Real and **green** — `qb-journal-month` vendored with a sha256; `qb-journal.fixture.test.ts` 7 tests pass |
| airplane-mode soak | Real and **green** — `airplane-soak`, `status: in-repo-test`; 2 tests pass |
| **routes ±10%** | **Nothing.** No row in `fixtures/manifest.json`. No row in `fixtures/README.md` — *the very file rule 6 cites*. No REQ row. No routing, mileage, or distance capability anywhere in the register |

The phrase traces to `genesis/11:26`, so it is inherited intent rather than a local invention — which makes it
the owner's to resolve, not mine.

**Deliberately NOT built.** `CLAUDE.md` is unambiguous: *if it isn't a REQ row, it doesn't get built; if you
discover scope, ADD A ROW first.* Inventing a route-parity harness because a sentence names one would be
precisely the straying this loop is instructed to avoid — and it would be worse than the gap, because then a
gate WOULD report PASS for a property nobody specified. Recorded on the GO-LIVE checklist with the two
dispositions available to the owner: add a register row if route/mileage parity is real scope, or strike the
clause from `genesis/11` as vestigial.

**Severity is Low and worth saying why:** a named gate that does not exist reports nothing, so there is no
false green anywhere. The cost is a reader believing coverage exists — the same cost as §60, one tier quieter.

**Verification.** `genesis/11` annotated; GO-LIVE row added; `packages/rater` 154, QB fixture 7, airplane soak
2 — all green; tables and citations PASS.

---

## §62 — I diffed the two files and my own §61 reasoning was wrong

§61 justified annotating `genesis/11` by asserting that *"`CLAUDE.md` is generated from this file and would
otherwise reintroduce the claim."* Then I diffed them. **That mechanism does not exist.**

`genesis/11`'s own title says what it is: *"drop this file at repo root, verbatim, when the repo is created."*
It is a **one-time template**, not a source that regenerates anything. And the two files already differ in
several deliberate ways:

- Path resolution throughout — `09-REQUIREMENTS-REGISTER.csv` → `genesis/09-REQUIREMENTS-REGISTER.csv`,
  `Shuddl-OS-Genesis/` → `genesis/`.
- Rule 7 carries an extra clause in the root file: *"pixel law must not stall ledger work."*
- The never-build list says `(REQ-167)` in the template, `(REQ-167 identity-leak lint)` in the root.

So they are **not** kept byte-identical, nothing regenerates the root file, and no drift would clobber my §60
correction. The annotation is still right — a template should not hand a future repo a false claim — but the
*reason I gave for it was invented*, and it was the kind of plausible mechanism that reads as fact.

**This is the fourth self-inflicted record defect this loop**, and it completes an unwelcome pattern:

| § | The defect | What it was doing at the time |
|---|---|---|
| §50 | Fused a threat-model row, deleting a mitigation from the render | Adding a threat-model row |
| §58 | Incremented a gate count that had never reconciled | Correcting a stale gate count |
| §61 | Corrected the copy and left the source | Correcting a false claim in the copy |
| §62 | Asserted a regeneration mechanism that does not exist | Justifying the fix to the source |

**Every one occurred while improving the record**, and three of the four were caught only by *running something*
— the table checker, `gatesFor("merge")`, and now `diff`. The one constant: whenever I reasoned about a
relationship between two artifacts instead of comparing them, I was wrong.

The genesis annotation now states the accurate reason: this file is the artifact a future repo (or a reader
reaching for canonical wording) starts from, so it should not carry a claim that is false. No regeneration
story, because there is no regeneration.

**Verification.** `diff genesis/11 CLAUDE.md` inspected in full (45 lines, every hunk accounted for above);
tables and citations PASS.

---

## §63 — the fixture layer, audited end to end: the hash law is real, and the second copy of the list was the defect

§60 and §61 both traced to the fixture registry, so this section audited that layer directly rather than
another claim about it. Three questions, each answered by running something (§62's rule).

### 63.1 Is the REQ-112 hash law real, or decoration?

**Real, and mutation-proved.** `tools/fixtures/verify.ts` recomputes `hashPath()` over every vendored entry and
compares it to the pinned `sha256`. Flipping a single byte in `fixtures/anomaly/the-222084-case.json`
(`22208400` → `22208401`) produces:

```
FAIL anomaly-222084-35lb: hash mismatch (pinned 7f0d3d07abe7… actual a41abb9a0762…)
##SHUDDL-GATE## {"gate":"fixtures","status":"FAIL","executed":true,"assertions":8}
```

A hash mismatch is **FAIL in every mode**, unlike a pending private fixture (advisory locally, BLOCK on merge).
That is the right asymmetry: an absent fixture is an owner hold, a *changed* one is a law violation.

### 63.2 Is every pinned fixture actually doing work?

A fixture can be hash-pinned and read by nothing — the pin then guards a file no test replays, which is the
§50 shape (a control that cannot fail). Checked per row: **all seven vendored fixtures have consuming tests** —
`anomaly.test.ts`, `qb-journal.fixture.test.ts`, `gl-netting.fixture.test.ts`, `merkle.test.ts`,
`derive-split.test.ts`, `migrator.test.ts`, `legacy-mirror.test.ts`. Nothing is decoratively pinned.

### 63.3 The defect: two lists of the same thing, and only one is authoritative

`fixtures/README.md` presents itself as *"golden data that gates merges"* and carries **10** rows.
`fixtures/manifest.json` carries **17**. The seven absent from the README are not obscure — `gl-netting`
(I7), `merkle-vectors` (REQ-014), `interline-partner-statement` (REQ-019), `migrator-formats`,
`legacy-mirror-export`, plus the `invoice-500-replay` and `concierge-parse-50` private holds. **All of them
gate merges.** A reader working from the README does not know they exist.

The README is defensible as the *WP-01 vendor-in list* — the private datasets to obtain — but its title claims
more than that, and this is exactly how §60 happened: a document describing the fixture set, drifting from the
fixture set.

**Fixed by pointing, not mirroring.** The README now names `manifest.json` as authoritative, states the split
(vendor-in list vs full registry), names the seven, and says why it does not copy them: *a second
hand-maintained copy of a list the build already owns is what drifts* — the §58 lesson applied preventively
rather than after the fact. Mirroring 17 rows here would have created a third artifact to keep in sync and
guaranteed the next drift.

Counts verified by reading both files programmatically before writing them down (10 and 17), not by counting
by eye — §58's failure was exactly an eye-count of a machine-owned list.

**Verification.** Byte-flip mutation FAILs and restores clean (0 mismatches); all 7 vendored fixtures have
consumers; `check:fixtures` exit 0 local / exit 2 merge, unchanged; tables and citations PASS.

---

## §64 — the mechanism behind every record defect this loop: docs may state laws, not observations

Fourteen sections in, the record defects are no longer individually interesting — they are the same defect.
Naming the mechanism is worth more than finding a fifteenth instance.

**Every one was a document restating something the build already computes.**

| § | The restatement | The authority it copied |
|---|---|---|
| §52 | "2,648 tests across all 16 workspaces" | the actual suites (2,867 across 17, plus 691 in `tools/`) |
| §58 | "the 11-gate static set" → 13 → nearly 14 | `gatesFor("merge")` — which returns 24 |
| §60 | "the 504 sweep and 48 engine tests ship in `fixtures/`" | `fixtures/manifest.json` — both `status: pending` |
| §63 | `fixtures/README.md`'s 10-row table | `fixtures/manifest.json`'s 17 rows |

### 64.1 The distinction that predicts which sentences rot

A document sentence is one of two things, and they behave oppositely:

- **A law** — *"≤22 tables"*, *"35 event kinds"*, *"no price on air"*, *"gates are server-side"*. Declarative.
  The code must conform to it, so it **cannot go stale**: if reality diverges, reality is the bug and a gate
  says so. Laws belong in `CLAUDE.md` and `genesis/`, and every budget checked in §54 was one.
- **An observation** — *"21 used"*, *"2,648 tests"*, *"13 gates"*, *"ships in `fixtures/`"*, a `path:line`
  citation. Descriptive. It was true when written and **decays from the moment it is committed**, silently,
  because nothing recomputes it.

Every defect in the table above is an observation written where a law belongs. Every clean negative in §54 and
§55 was a law.

### 64.2 The three dispositions for an observation

1. **Delete it and point at the authority** — §58 (condition 2 now names `gatesFor("merge")` and counts
   nothing) and §63 (the README now names `manifest.json` rather than mirroring it). Best where an authority
   exists.
2. **Anchor it so decay fails a gate** — a `path:line@symbol` citation, which `check:citations` re-resolves.
   §55's rotted GO-LIVE citation had drifted 61 lines *in bounds*, so it passed unanchored; anchored, the same
   drift is RED.
3. **Date and scope it** — where the observation is genuinely the point, as in this audit's own measurements.
   §4's status blocks carry their SHA precisely so a reader knows what they describe and when it stopped being
   true.

### 64.3 Applied here, and the two remaining observations checked

Both surviving observations in `CLAUDE.md` were verified against their authority rather than trusted:
*"21 used"* of ≤22 tables — `check:invariants` reports `21/22`, correct. *"13 agents"* — a product
description, not a state claim: `genesis/05` scopes V1 to **6 of the 13**, and the built ones are distributed
across `packages/agents`, `packages/rater`, the sequencer's gate catalog, and `workers/agents`. Neither is
stale.

**What this does not become:** a checker. A generic "verify every number in prose" gate would have to parse
intent, and would flag laws (which must not change to match reality) alongside observations. The mechanism is
a rule for authors, not a lint — *before writing a number or a state claim into a document, ask whether
something in the build already knows it, and if so, point at that instead.*

**Verification.** No code changed; both `CLAUDE.md` observations re-verified against their authorities; tables
and citations PASS.

---

## §65 — phase gate re-measured at `f026527`

§52 stamped `64fc9b7`. Thirteen sections later — including three new gates, four corrected records, and two
corrections to corrections — an unre-measured stopping line is the asserted-not-measured claim this audit
exists to catch. Measured again, condition by condition.

**1. Zero open repository-owned Critical/High — SATISFIED.**
§53–§64 closed everything they opened: the import-only REQ-024 lint (§53), the untripwired surface budget
(§54), the rotted GO-LIVE citation (§55), the unenforced append chokepoint (§56), the unpinned auth surface
(§57), the hand-counted gate figure (§58), the four-mechanism idempotency surface (§59), and the false rule-4
claim in `CLAUDE.md` **and** its genesis template (§60/§61/§62). Counted by hand per §38's warning that a grep
over prose under-reports — and §55 supplied a fourth demonstration of exactly that.

The two open Highs are unchanged and **External**: a real driver's custody handoff (needs manifest party refs
plus the deferred REQ-069 seam) and the live EDI adapter (needs transport credentials). The one pre-R4 repo
carry-forward is still resolve-path pool-binding exclusivity (§12), dark behind `PROVISIONING_ENABLED`.

**2. Baseline gates green — SATISFIED but for the one row that is not this loop's.**
**17 workspaces, 2,877 tests, exit 0** (2,867 at §52 plus the ten auth-surface cases from §57/§59). Root
`tools/`: **703 tests, 3 failing** — the same three register-parsing failures, isolated by experiment to the
GTM workstream's uncommitted `REQ-289` (stash it and they pass; restore and they fail). `check:coverage` is
red on that row alone: `classified 288/289`.

All twelve static gates PASS: runtime, invariants, rater-purity, **append-chokepoint** (new, §56),
authority-coverage, traceability, seed, citations, **tables** (§50), design-audit, typecheck, lint.
`check:fixtures` behaves as designed — exit 0 local, **exit 2 on merge**, one of the five private-fixture
holds, with its hash law mutation-proved in §63.

**3. Remaining debt entirely External or CONFIRM-gated — SATISFIED**, with one addition this pass: the
`routes ±10%` clause (§61), a merge gate named in `genesis/11` with no REQ row, no fixture entry, and no
routing capability in the register. Deliberately not built; recorded on the GO-LIVE checklist with the owner's
two dispositions. Otherwise unchanged: five private-fixture holds, two External Highs, the GTM register row,
R2–R5 grades, and the two no-gate holds (on-call rota, 7-year archive). Plus the standing record item — threat
rows for the 17 boundary modules §48 enumerated, still left for review rather than bulk-written.

**4. The record agrees with the world — SATISFIED, and this is the condition that did the work this loop.**
It was false when this iteration opened, in the highest-visibility place available: `CLAUDE.md` rule 4 told
every session that two fixtures were present and green when the manifest marked them pending. §64 names the
mechanism behind that and the three like it — **a document restating something the build already computes** —
and the standing rule now recorded: docs may state laws, not observations.

**The stopping line is unchanged and is reached again at `f026527`.** Repo-owned Critical/High is zero; every
gate that can pass does; the one red gate and three red tests share a single cause requiring an owner
signature. Beyond this line the build consumes accounts, credentials, devices, fixtures and counsel — working
past it from inside the repo produces either scope-straying or gate-relaxing, both forbidden by
`CLAUDE.md`/`genesis/00`.

---

## §66 — §64's rule applied as a method: PROJECT-STATE had exactly two unscoped observations

§64 predicts which sentences rot. `docs/ops/PROJECT-STATE.md` is the best available test of that prediction —
it is 465 lines of pure observation, it describes itself as *"where are we / how do I pick back up"*, and it
had already been caught stale once (fixed 2026-07-27).

The prediction held, and so did its converse. Five stated counts; the rule sorted them correctly.

**Three were correctly scoped and were NOT touched.** Each carries a date and a SHA — *"All eighteen ran on
2026-07-28 at HEAD `3fc592b`: 258 files / 3,243 tests, zero failures"*, *"Re-run at the branch tip `79ae54d`
on 2026-07-27"*, *"16 gates PASS, 5 BLOCKED"* at that same tip. These are §64's third disposition working:
a measurement that names when and what it measured cannot go stale, because it never claimed to describe now.
Editing them would have destroyed the evidence trail — the §55 mistake, where two apparently-rotted citations
turned out to be historical rows recording their own correction.

**Two were unscoped and both had decayed:**

- The bucket-1 summary row asserted current repository state with no stamp: *"all 18 test projects run —
  258 files / 3,243 tests PASS"*. Real total today: **3,580** (17 workspaces / 2,877, plus `tools/` 703).
  ~337 short. Re-measured, stamped `3e1f31d`, and annotated with the `&&` short-circuit §52 found, since a
  reader seeing `pnpm test` fail needs to know the workspaces may never have run.
- *"`pnpm verify:merge` aggregates 21 gates: twelve plain ones"* — **the identical drift §58 found in the
  audit's own phase gate**, in a different document, discovered independently. `gatesFor("merge")` returns
  **24** (15 plain + 9 skippable). Notably this sentence was *correct when written*; this loop added three
  gates and the number decayed underneath it. Rewritten to name `gatesFor("merge")` and tell the reader to
  read the list rather than trust a count.

### 66.1 What the resume guide was missing

It never linked `docs/audits/2026-08-01-technical-debt-audit.md` — the primary artifact of the 99 commits
between its header date and today, carrying the phase gate a returning reader most needs. Its header also
still read *"As of 2026-07-31 · 435 commits"* while the body carried inline *"superseded 2026-08-01"* markers
from this very audit: internally inconsistent, and in the direction that matters least (the body was newer
than the header, so a careful reader would have caught it — but only a careful one).

Header re-stamped to `3e1f31d` / 534 commits, with a pointer to the audit naming what changed that a returning
reader needs: the three added gates, the corrected `CLAUDE.md` rule 4, and §64's rule itself.

### 66.2 The rule earning its keep

Two documents, found independently, carrying the same rotted gate count — and in both the fix is the same
one: **stop restating a list the build owns.** That is now applied in three places (the audit's condition 2,
`fixtures/README.md`, and here), and each replacement points at the authority rather than at a fresher number
that would rot on the same schedule.

**Verification.** `check:tables` and `check:citations` PASS; both corrected figures verified against their
authorities (`gatesFor("merge")` executed, workspace + tools suites re-run) before being written down.

---

## §67 — the same sweep across all nine ops documents: a clean negative, and why it must not become a gate

§66 fixed two unscoped observations in `PROJECT-STATE.md`. The obvious next question is whether the other ops
documents carry the same defect, so the same test ran across all nine: find every stated count, then check
whether anything nearby scopes it to a date or a SHA.

**38 candidates. Every one outside `PROJECT-STATE.md` was a false positive.**

- `DEPLOYMENT.md`, `secrets.md`, `slo.md` — no stated counts at all.
- `GO-LIVE-CHECKLIST.md` (13 candidates) — the counts sit in a table whose **header** reads *"Verdict at
  `3fc592b`, 2026-07-28"*. Every row is scoped; the scope is just two lines above the rows.
- `RELEASE-EVIDENCE.md` (8) — same shape, and by design: line 489 reads *"re-executed at `79ae54d`, on this
  machine, in this checkout"*, and the document's own rule 1 is that **evidence does not transfer across
  commits**. It holds itself to it.
- `LAUNCH-RUNBOOK.md` (1), `V2-EXECUTION-FRAMEWORK.md` (1), `dr-backups.md` (9) — scoped by their enclosing
  dated blocks, or describing procedure inputs rather than measurements.
- `PROJECT-STATE.md` (6) — two were the genuine ones fixed in §66; the rest are the dated historical rows
  §66 deliberately left alone. One deserves naming: *"288/288 rows classified"* looks stale against a register
  that has 289 rows today — but the 289th is the GTM workstream's **uncommitted** `REQ-289`. For the
  repository as committed, 288/288 is exactly right.

### 67.1 The heuristic is wrong in the expensive direction, which settles §64's open question

§64 declined to turn the laws-vs-observations rule into a checker, on the grounds that it would have to parse
intent. This sweep shows the failure is worse than that and entirely concrete: **scope usually lives in a
table header or a section heading, not on the line with the number.** A window-based check therefore
over-reports massively — 38 flags, 2 real, a 5% precision — and every false positive points at a document
that is *already doing the right thing*.

A gate like that trains people to ignore it, and the thing it would teach them to ignore is the correctly
scoped table. Confirmed as a rule for authors, not a lint. **§64's decision stands, now with evidence rather
than an argument.**

### 67.2 What the negative is worth

Eight of nine ops documents were already applying §64's third disposition before the rule was written down —
dating and SHA-stamping measurements, in table headers, block prefixes, and one explicit contract rule. The
practice was sound; what was missing was the name for it and two places where it had lapsed. That is a
materially different finding from "the docs are rotten", and worth recording as such: an audit that only
reports what it broke gives no signal about what it examined and found sound (§54).

**Verification.** All nine `docs/ops/*.md` swept; every non-PROJECT-STATE candidate traced to its scoping
header by hand; `check:tables` and `check:citations` PASS.

---

## §68 — the five acceptance demos: the honesty is exemplary, the anti-drift claim was aspiration

`CLAUDE.md` closes with the five demos that "define done enough to show", and `PROJECT-STATE` reports the
spine GREEN. That is the production-readiness headline, so it gets §51's question: **does the thing named for
the property actually assert the property?**

### 68.1 This is the best-built claim audited this loop

`tools/acceptance/demos.ts` declares a **two-tier DoD** and refuses to blur the tiers. Per demo it names the
code path, the in-repo spine test(s) — *the code-provable half* — and, critically, the **filmed delta: what
the spine deliberately will not fabricate.** Demo 1's entry says it outright: the spine proves the causal
chain is complete and code-path-real but "refuses to fabricate a latency number". The `<5s`, the `<10min`, the
real driver on real glass, the real Claude booking, the visual world-dim — each is named as *not* asserted
here.

The runner matches: it invokes each spine file in its own package's vitest config, and notes that vitest exits
non-zero on "no test files found", so **a typo'd filter cannot pass as green** — the silent-no-op failure this
audit found in a browser gate back in C2.

And the browser gap is recorded with a precision worth quoting. `genesis/14` promises "Playwright e2e scripted
to the five acceptance demos"; today `browser` is `null` for all five. The manifest does not hide that — it
names which demos are not browser-drivable *and why* (demo 1 is a real-substrate latency measurement, demo 4 a
cross-worker staging smoke), and for demo 2 it names **the concrete blocker**: the Playwright dev-servers boot
with no flag env, so `PROVISIONING_ENABLED` is off and `/pub/signup` 404s. It even pre-commits the specs to be
**blocking, not advisory**, when built. That is a deferral documented well enough to act on.

### 68.2 The one gap: "can never drift" was a claim about a mechanism that did not exist

`demos.ts` describes itself as *"the single source of truth shared by the runner (`run.ts`) and the manifest
(`docs/wp/acceptance-demos.md`), so the two can never drift."*

Half true. `run.ts` **imports** this module, so the runner genuinely cannot drift. The manifest is
**hand-written markdown** — it cites `demos.ts` but derives nothing from it. Adding a demo, renaming a spine
file, or dropping one would have left the manifest stale with nothing failing. Compared today: the two agree
exactly, all 7 files. **The state was fine; the guarantee was imaginary** — §62's shape again, and again a
claimed relationship between two artifacts that only a comparison could settle.

Five tests now make the claim true, mutation-proved in **both** directions: renaming a spine file in
`demos.ts` fails ("must name demo 1's spine file…"), and dropping one while the manifest still lists it fails
the reverse check. The reverse direction matters more — a spine file lingering in the manifest after leaving
the module reads as coverage that no longer runs, which is the failure that overstates. The tests also pin
that all five demos exist, each with ≥1 spine test and a **non-trivial filmed delta**, because a blank
`filmed` would silently promote "the code path exists" to "the demo is done".

The manifest stays prose. It carries the filmed-half narrative, which is the point of it and is not derivable
— only the *facts* it shares with the module are now checked.

### 68.3 `routes ±10%` is in two genesis docs, not one

§61 traced that unbacked gate name to `genesis/11:41`. It is also in **`genesis/14:52`**, in the fixture-replay
gate list. Two source-of-truth documents, so it is **settled intent rather than a stray phrase** — which makes
the owner decision sharper, not softer: either route/mileage parity is real scope and wants a register row, or
both mentions are vestigial and want striking. The GO-LIVE row now cites both.

**Verification.** `pnpm test:acceptance` — **GREEN, all 7 spine tests pass**; 5 new drift tests, both
directions mutation-proved, source restored byte-identical; tools suite 708 (up 5) with the same three
`REQ-289` failures; tables and citations PASS.

---

## §69 — the append-only guard chain: a clean negative, and the only complete remediation shape in the repo

The `.claude/skills/` are instructions **future sessions follow**, so a stale one misleads an agent rather than
a reader — a strictly worse failure than a stale document. Sixteen exist. `complete-append-only-insert-guards`
is the most mechanically checkable, and it turns out to be the best-defended invariant in the repository.

### 69.1 Every claim verified against the migrations

The skill states that `events` has **four** conflict surfaces and that `positions` has none beyond its PK.
Compared against `db/tenant/migrations/*.sql` rather than trusted:

- `events` — `PRIMARY KEY (stream_id, seq)`, `id TEXT NOT NULL UNIQUE`, `hash TEXT NOT NULL UNIQUE`, and
  `CREATE UNIQUE INDEX ux_events_device ... WHERE device_id IS NOT NULL`. **Four.** Correct.
- `positions` — `PRIMARY KEY (shipment_id, device_id, ts)` and nothing else. Correct, which is what licenses
  its deliberately narrower `hash <>` guard shape (Decision 14's idempotent re-ingest).
- `money_lines` — PK `id`, `UNIQUE (event_id, line_no)`, `ux_ml_corrects`. **Three**, all guarded.

The guards in `0003` + `0008` together enumerate every one.

### 69.2 And a gate enforces it — mutation-proved

`check:invariants` does not merely check that guards exist: it **enumerates every UNIQUE target on a guarded
table** (table-level PK/UNIQUE, column-level, and every `CREATE UNIQUE INDEX ... ON <table>`) and fails if any
lacks a `*_guard_ins` predicate. Adding `CREATE UNIQUE INDEX ux_events_mutation ON events(shipment_id,
recorded_at)` produces:

```
FAIL I3 VIOLATION: append-only guard completeness — the UNIQUE target (shipment_id, recorded_at) on events
has no BEFORE INSERT guard predicate enumerating it; an INSERT OR REPLACE colliding on it would silently
delete a chained row (D1 recursive_triggers=0). Add it to a *_guard_ins WHEN clause.
```

It names the target, the consequence, and the fix.

### 69.3 Why this one is worth writing up as a negative

This invariant went through the **complete** remediation shape, and it is the only place in the repo where all
four steps are present:

1. **The hole was hit** — `0003`'s guard enumerated only `(stream_id, seq)` and `id`, omitting `hash` and the
   device index.
2. **Fixed** — `0008` added the missing predicates.
3. **Written down** — the skill explains *why* (D1 pins `recursive_triggers = 0`, so REPLACE's implicit DELETE
   never fires the BEFORE DELETE guard, making BEFORE INSERT the only backstop), so the next author
   understands the rule rather than copying it.
4. **Gated** — and the gate is generative: it catches a UNIQUE key that does not exist yet.

Most remediation in this loop stopped at 2+3. Step 4 is what makes a fix survive the person who wrote it, and
step 3 is what stops step 4 being cargo-culted. **A defect this thoroughly closed is worth recording precisely
because nothing was found** — it is the template, not the exception.

**Verification.** Skill claims compared against all 11 tenant migrations; guard predicates enumerated by hand;
the completeness gate mutation-proved RED with a synthetic UNIQUE index and restored clean
(`invariants OK — 21/22 tables, 11 migration files`).

---

## §70 — the frozen byte law had one unpinned value type, and it reaches hashed events

§69 verified one skill's rule end to end. Continuing through the sixteen, `preserve-canonical-hash-byte-law`
guards the ledger's integrity foundation: *"any byte drift in the serializer"* invalidates every stored event's
hash and signature. So the question is whether the law is pinned by **golden vectors** or only by behavioural
tests — because behavioural tests and the serializer can drift together and still agree.

### 70.1 Mostly pinned, and pinned the right way

Better than expected. The suite does not merely assert behaviour, it hardcodes **exact output bytes**:
`canonicalize({b:1,a:2})` → `'{"a":2,"b":1}'` pins key ordering; the escape case pins
`'{"s":"\\u0001\\"\\\\"}'` character for character; the nesting case pins array order plus inner key sort; the
`undefined`/`null` case pins omission. Those are golden vectors. And `canonicalBytes` is `TextEncoder` over
`canonicalize` while `sha256Hex` is WebCrypto — thin wrappers over standard primitives — so pinning the string
pins the hash transitively.

### 70.2 The gap: booleans

Of the six members of the `JsonValue` union — string, number, boolean, null, array, object — **five were
pinned by an exact-output assertion and boolean was not.** `canonical.ts:23` emits `v ? "true" : "false"`, and
nothing asserted it.

Not theoretical: **booleans reach hashed events.** `StopArrivedPayload` and `StopDepartedPayload` both carry
`auto: z.boolean()`, and departure additionally carries `out_for_delivery`. A plausible "improvement" to that
line — emitting `1`/`0`, or capitalised — would have silently rewritten the canonical bytes, and therefore the
hash and signature, of **every arrival and departure event ever recorded**, breaking chain verification for
the whole stream.

**Mutation-proved, and the discrimination is the point:** changing booleans to `1`/`0` fails both new vectors
while **all eleven pre-existing byte-law tests still pass.** The gap was real, not hypothetical — the change
was invisible to the entire existing suite.

### 70.3 What was added

- A boolean golden: `canonicalize({t:true,f:false})` → `'{"f":false,"t":true}'`.
- An **end-to-end known-answer over every type at once**. The existing `{}` known-answer pins the pipeline for
  a structure that exercises none of the law; the new vector carries all six types — string, negative number,
  boolean, null, mixed array, nested object needing its own key sort — and freezes both the bytes **and** the
  resulting sha256, so a failure says which half moved. Any drift in serialization, UTF-8 encoding, or digest
  formatting now moves that hash.

Scope: REQ-011/REQ-002, existing rows, tightening a law the repo already declares frozen. No new capability.

**Verification.** `packages/ledger` 609 tests / 34 files green (up 2); the boolean mutation proved RED on both
new vectors and GREEN on all eleven prior ones; `canonical.ts` restored byte-identical.

---

## §71 — I shipped the exact defect the repo has a skill about, in §56, and the skill named it in advance

Continuing through the sixteen skills, `share-lint-matchers-with-parity-tests` states the rule: when one rule
is enforced in two places, hand-tuned copies drift, and *"the copy that got less attention becomes an evasion
vector."* It documents the historical RED precisely — `INSERT OR REPLACE INTO"events"` (abutting quote, no
whitespace) and `INSERT OR REPLACE INTO main.events` (schema-qualified) both walked past a hand-written
matcher that the shared-fragment matcher caught.

**I read that skill against my own §56 work and found I had reproduced half of it.**

`append-chokepoint.ts` shipped with a hand-written regex requiring `INTO\s+`. Tested empirically rather than
reasoned about:

- `INSERT OR REPLACE INTO main.events` → **caught** (I had included a schema fragment).
- `INSERT INTO"events"` → **MISSED.** The gate that exists to guarantee every append traverses the sequencer
  could be bypassed by deleting one space.

That is not a hypothetical: it is the specific string the `legs` evasion corpus in `invariants.test.ts`
already tests for, in a file whose section header reads *"shared target matchers (share-lint) — ONE builder
both surfaces consume, so the two scanners can never drift."* The infrastructure to do it right was
twenty lines above where I would have looked, and §56's own commit message claimed the check handled "the
quoted-identifier, alternate-verb variant that a naive matcher misses." It handled that one. It missed the
other.

### 71.1 Fixed the way the skill prescribes

`insertIntoRe(tables)` is now **exported** from `invariants.ts`, built from the same `DELIM`/`SCHEMA`/`Q`
fragments as `replaceFamilyRe` and `onConflictUpdateRe`, and `append-chokepoint.ts` consumes it instead of
carrying a copy. All three forms — abutting quote, schema-qualified, bracket — are now caught, verified
against a live file rather than by reading the regex.

And the corpus came with it: seven cases mirroring the `legs` corpus, including `INSERT INTO "main" . "events"`
(quoted schema, spaces around the dot) and a **negative** — `events_archive` must NOT read as `events`, since
a matcher that flags everything is as useless as one that flags nothing.

### 71.2 What this says about §56, and about the loop

§56 was mutation-proved. Twice, on two shapes I chose. **Both shapes were ones my own regex handled** — I
tested the check against my model of it, not against the adversary's model, and a mutation test only proves
what its mutations cover. The `legs` corpus existed precisely because someone had already learned this, and
the skill existed to transmit it. Neither reached me, because I never went looking for prior art before
writing a matcher in a directory the skill explicitly names (*"You are reviewing anything under
`tools/checks/`"*).

The correction is not "be more careful with regexes." It is: **before writing a matcher for a rule this repo
already enforces somewhere, find that enforcement and consume it.** The skills are the index for that, and
this loop has now used them twice as an audit lens (§69, §70) and once — here — as a review of its own output.

**Verification.** `check:chokepoint` and `check:invariants` PASS; 13 chokepoint tests (up 7); `tools/checks`
259 tests green; all three evasion forms confirmed caught against a live file; typecheck and lint clean.

---

## §72 — inherited visibility: defended three deep, and the fifth grep that nearly reported a hole

`fail-closed-on-inherited-visibility` states the rule: when an event inherits a security attribute from a
referenced event, a **missing** inherited value is a hard error — never a fall-through to the kind's open
default, because "the widest default is exactly the leak the inherit was added to prevent." Its RED was
`visibility.ts` returning the `invoice.corrected` kind default (`counterparty`) when the parent's visibility
could not be resolved — surfacing a phantom charge in a lens the original never appeared in.

**Closed, and defended at three independent layers.**

1. **The resolver.** `INHERITED_VISIBILITY_KINDS` has no default of its own; `resolveVisibility` returns
   `correctedEventVisibility ?? UNRESOLVED_VISIBILITY`. The sentinel is deliberately **not** a `Visibility` and
   is documented as never stored. Pinned by `visibility.test.ts` — including the exact case
   ("NO resolvable parent visibility returns UNRESOLVED — fail closed, never the default").
2. **The type system.** `let visibility: Visibility = resolvedVisibility` only compiles because the refusal
   above it narrows the union. Deleting the refusal is a **typecheck error**
   (`Type '"unresolved"' is not assignable to type '"internal" | "counterparty" | "public"'`), and `typecheck`
   is on the merge surface. The sentinel's type is load-bearing, not decorative.
3. **Four behavioural tests.** `invoice-correction.test.ts` covers each way a parent can fail to resolve —
   **missing**, **wrong-kind**, **cross-stream**, and **cross-tenant** (REQ-025) — each asserting *rejected,
   zero append*. All four fail when the refusal is removed.

Mutation-proved end to end: deleting the sequencer's `if` breaks typecheck **and** turns those four red.

### 72.1 The methodological note, which is the reason to write this up

I searched for the refusal's reason string, `invoice_correction_unresolved_parent`, across the entire
repository. **It appears only in the source** — no test mentions it. I was one sentence from reporting that
the sequencer's enforcement was unpinned.

It is pinned four times over. The tests assert on `/VALIDATION_FAILED/` — the error *code* — not on the
reason string, which is a perfectly reasonable way to write them.

That is the **fifth** absence claim this loop that a grep would have gotten wrong (after §53's `fetch(`,
§54's two budget counts, and §55's `money_lines` singular/plural). The pattern is now completely stable:
**every single time I have concluded "X is not enforced" from an empty grep, I have been wrong** — and every
time, what corrected me was running something rather than reading harder. Here it was the mutation: I removed
the guard expecting silence and got four failures and a type error.

The rule has earned a stronger form than "grep carefully": **for an absence claim about enforcement, the grep
is not evidence at all — the mutation is the evidence.** Deleting the thing and watching what screams is both
faster and sound, where a search over the vocabulary someone else chose is neither.

**Verification.** `sequencer.ts` restored byte-identical; `workers/api` typecheck clean;
`invoice-correction.test.ts` 6/6 green.

---

## §73 — REQ-025 mutation-tested at the resolver, and the failure mode of mutation testing itself

§72 concluded that for an enforcement claim, **the mutation is the evidence, not the grep.** This section is
that rule applied to the strongest claim in `CLAUDE.md` — *"a cross-tenant read anywhere is a build failure
(REQ-025)"* — and then the rule turning on itself.

### 73.1 The suite catches a resolver-level break, via its POSITIVE controls

Mutating `resolveTenantDb` so `tenant-b` resolves to tenant-a's database — a total isolation break, not a
subtle one — turns **three** tests red:

- *"a valid tenant-b session never sees tenant-a data (symmetry)"*
- *"a tenant-b cap surfaces tenant-b's state, never tenant-a's (identical shipment id in both DBs)"*
- *"tenant-b's own includeShadow drill DOES return its legacy event"*

All three are **positive-direction**: they assert tenant-b sees tenant-**B** data. That is the structural
point, and it is worth stating because it is counter-intuitive: the many *"tenant-a must not see tenant-b"*
cases — the ones that look like the isolation tests — **cannot** catch this break, because under it tenant-a
still correctly reads tenant-a. A suite of negative assertions alone would be hollow against the single most
consequential failure. This one is not, because it keeps positive controls (the file labels one
`describe("positive control")`), and those are what make a resolver-level break detectable.

### 73.2 The mutation lied first, and I nearly published it

My first mutation targeted `const binding = TENANT_BINDINGS[tenantSlug];` by string replace. That string
occurs **twice** — in the synchronous `tenantDb` and in the async `resolveTenantDb` — and `String.replace`
takes the first. I mutated `tenantDb`; `/v1/_probe` and most of the suite use `resolveTenantDb`.

Result: **63 of 64 tests passed**, and the single failure was an unrelated `/pub/quote` case that happens to
use the sync variant. I was drafting the sentence *"the isolation suite is hollow — 63 tests passed while
tenant-b read tenant-a's entire database."* That would have been a serious false finding against a suite that
is, in fact, sound.

What caught it was checking that the mutation had landed where I believed — `grep` showed the edit at line 23,
inside `tenantDb`, while `resolveTenantDb` sat untouched at line 53.

**So §72's rule needs its own guard rail.** "The mutation is the evidence" holds — but a mutation is only
evidence for the code path it actually reached. Before reading a green suite as a hole, confirm the mutation
is live *in the function under test*. The failure mode is exact and mundane: a helper and its async sibling
sharing a line of code, and a string replace that silently picks one. It produces the most dangerous possible
result — a false all-clear about a security suite, arrived at by the very method adopted to avoid false
conclusions.

### 73.3 Verdict

**REQ-025's suite is sound at the resolver.** 64 tests, three of which fail on a resolver-level cross-tenant
break, with the positive controls doing the load-bearing work. No defect.

**Verification.** `tenants.ts` restored byte-identical; `isolation.test.ts` 64/64 green; both mutation sites
confirmed by line number before drawing any conclusion from either.

---

## §74 — the C3 loss path, mutation-tested at all three layers it needs

`park-unroutable-work-never-destroy-it` records the loop's worst defect: `workers/agents` resolved tenants
through a static two-slug map and **ACKed** any trigger naming a tenant it could not resolve — while the api
worker and sequencer DO fully served claimed-pool tenants. A pool tenant's committed `pod.signed` enqueued a
Biller trigger the agents worker destroyed: no invoice, no DLQ record, one log line. Fail-**silent**, not
fail-closed.

The skill's sharpest observation is not the defect but its shape: *"the sweep that would recover it usually
shares the same roster blind spot."* The recovery paths — the REQ-169 recon sweep, the Watchtower unbilled
alarm — iterated the **same** static roster, so they excluded exactly the tenants that had lost work. A
defect and its own remedy, disabled by one shared assumption.

That makes it a three-layer fix, and each layer was mutation-tested separately.

| Layer reverted to its pre-fix form | Tests that fire |
|---|---|
| **Resolver** — `resolveTenantDb` throws instead of falling back to `resolveClaimedTenantDb` | 2 — *"a CLAIMED pool tenant resolves to the pool binding its control row names"*, and *"a claimed tenant's `pod.signed` reaches the handler … WITHOUT the roster log"* |
| **Sweep enumeration** — `allTenantSlugs` returns only the static roster | 2 — *"static roster first, then claimed, deduped"*, and the control-plane-fault case |

The dispatch test is the one that matters most: it pins that the work is **routed**, not merely that a slug
resolves. A fix that made the resolver correct while leaving the consumer parking the trigger would still
destroy the invoice, and only that test would notice.

### 74.1 One design decision worth surfacing

The second enumeration test reads: *"a control-plane fault yields the STATIC roster with a loud log —
anchoring must never be hostage to enumeration."* That is a deliberate **fail-soft**, and it is the right call
in a place where this audit has otherwise insisted on fail-closed: if the control plane is unreachable, the
daily anchor still runs for the tenants it can name, rather than skipping anchoring entirely. The
loud log is what keeps it honest — a silent narrowing here would be the original C3 defect wearing a different
hat. Worth naming because "fail-closed everywhere" is the wrong rule; the right one is *fail in the direction
that does not destroy work, and make the degraded mode audible.*

### 74.2 Verdict

**Clean negative.** All three layers hold, each independently pinned, all mutations proved RED and restored
byte-identical. Combined with §69 (append-only guards), §72 (inherited visibility), and §73 (tenant
isolation), that is four consecutive security-critical skills whose rules are genuinely enforced — and the
two real defects this lens found (§70's unpinned boolean, §71's own evasion) were both in the *newest* code,
not the oldest.

**Verification.** `workers/agents` 106 tests / 17 files green; both mutation sites confirmed live by line
number before running (§73's guard rail); `tenants.ts` restored byte-identical.

---

## §75 — the model-trust doctrine, mutation-tested on its two attack-facing rules

`harden-agent-against-model-trust` states the C1 doctrine: *"the model is a suggestion engine over hostile
input, never an authority."* Two of its four rules face an attacker directly, and both were reverted to their
pre-doctrine form.

**Rule 1 — model confidence gates nothing.** The source comment is explicit about the attack: a
prompt-injected email can simply *order* high confidence (*"ignore previous instructions, confidence 10000"*),
so `parse.confidence` is ignored and `resolution_confidence` is scored from signals the agent verifies
itself — whether the party matched on file, whether a weight is present.

Reverted so the model's self-reported number gates resolution: **six tests fail**, spanning both directions —
the resolved cases and the `unresolved(low_confidence), NOTHING created` case. The negative one matters most:
without it a mutation that made everything resolve would look like a pass.

**Rule 2 — identity keys off the authenticated channel, not the model.** Party resolution uses the envelope
sender (`from_ref`), never `parse.party_hint.email`.

Reverted so the model's extracted address wins: **one test fails**, and it is exactly the right one —
*"a model `party_hint.email` that DIFFERS from `senderEmail` neither matches a victim nor creates on the
attacker address."* Both halves of the attack in one assertion: an injected email can neither **impersonate**
an existing customer nor **manufacture** a party under an address it controls. A single test, but it names
the adversary rather than the mechanism, which is why one is enough here.

### 75.1 What the shape of these tests shows

Across §69–§75 the enforced rules share a property the two defective ones lacked. The tests that caught these
mutations are written from the **attacker's** perspective — "a model hint that differs from the sender", "a
claimed tenant's `pod.signed` reaches the handler", "a tenant-b session never sees tenant-a data". They
describe a scenario someone could attempt.

The two real defects this lens found were the opposite: §70's byte law was covered by tests describing the
*mechanism* (sorts keys, escapes control chars) with no case for the value type nobody thought about, and
§71's chokepoint regex was mutation-proved against **shapes I chose** rather than shapes an evader would.
A test named for what the code does can only cover what its author already imagined; a test named for what an
adversary wants covers the case the author did not.

**Verdict: clean negative.** `packages/agents` 217 tests / 10 files green; both mutations proved RED and
restored byte-identical; mutation sites confirmed live by line number before running (§73).

---

## §76 — hunting §70's bug class in the money chain, and the design property that makes it impossible there

§70 found a real gap by asking a mechanical question: **which members of a value space have no test?** The
canonical byte law covered five of the six `JsonValue` members and missed booleans. That question generalises,
so it was aimed at the highest-consequence value space in the system — the nine `money_lines.kind` values,
each of which must reach the QB journal export correctly for REQ-020's penny reconcile.

### 76.1 The answer, and why it is structural rather than lucky

All nine kinds have a `gl_map` source: three from the Biller's `GL_MAP` (freight/fsc/accessorial), five
assigned by the money projection (`cod_collect`, `correction_credit`, `correction_debit`, `interline_split`,
`settle_fee`), and `credit_purchase` from the platform credit path.

**But the interesting finding is that §70's bug class cannot occur here at all.** `exportJournal` has **no
per-kind branching** — it selects `gl_map` from each row and uses it, carrying `kind` only as a label. The
schema makes `gl_map` `NOT NULL`, so the decision is *stamped at projection time* and merely *read* at export.

That is the difference from `canonicalize`, which **dispatches on type** (`if (typeof v === "boolean") …`).
Wherever code dispatches per member, there is a member you can forget — that is exactly how the boolean gap
existed. Wherever the decision is **carried on the data** instead of re-derived per member, the
forgotten-member class is structurally impossible. Worth stating as a design property, because it tells you
where to go looking next: **audit the dispatch sites, not the data-carrying ones.**

### 76.2 The value is constrained too, and the parity test is bidirectional

`NOT NULL` only guarantees presence — a `gl_map` of `""` would satisfy it and break the journal.
`CANONICAL_GL_ACCOUNTS` closes that: a frozen set whose comment says *"membership IS the parity invariant."*

Mutation-proved. Emitting `"9999-ROGUE-ACCOUNT"` for `cod_collect` turns **two** tests red:

- *"the ledger money projection emits only canonical accounts"* — no unregistered code escapes, and
- *"the canonical set is exactly the union of every emitting surface (no orphan account)"* — the **reverse**
  direction, so a constant that stops being emitted cannot linger in the set either.

The bidirectional half is the one most suites omit. It is what stops the canonical set drifting into a
wish-list of accounts nobody posts to.

### 76.3 A sixth grep near-miss, noted for the count

Checking per-kind coverage, `credit_purchase` showed **zero** files — I had scoped the search to
`packages/ledger/test` and the QB/netting fixtures. It is covered in four files (`platform-credit`,
`plg-isolation-matrix`, `webhook`, `credits`), because it lives on the `_platform` tenant and is exercised by
the billing worker, not the ledger package. Sixth instance this loop, caught before it was written down.

**Verdict: clean negative.** `money.ts` restored byte-identical; GL parity 6/6 green.

---

## §77 — the dispatch sites, swept; and a correction to §76's own framing

§76 concluded *"audit the dispatch sites, not the data-carrying ones."* That was directionally right and
imprecise, and the sweep it prescribed shows why.

### 77.1 The highest-consequence dispatch site is compile-time complete

The sequencer's per-kind gate switch is where a forgotten member would cost the most: a `GATED_KIND` with no
case means its gate silently does not run. It is protected by an exhaustiveness guard, and the source says so
— *"if `GATED_KINDS` gains a kind without a switch case, the call stops COMPILING."*

Mutation-proved: adding `"pod.signed"` to `GATED_KINDS` without a case yields
`TS2345: Argument of type '"pod.signed"' is not assignable to parameter of type 'never'`. And `assertNever`
throws at runtime too, so a Set/switch desync cannot fall through to an ungated append even if the type check
were bypassed. Belt and suspenders, both real.

### 77.2 The other typeof-dispatch sites all fail closed

Five modules use `canonical.ts`'s shape (`typeof x === …` chains): `canonical.ts`, `parity.ts`,
`polygon-source.ts`, `tsa/der.ts`, `projection/money.ts`. `der.ts` is the closest analogue — another
byte-level serializer — and it **throws** on every unsupported input (negative length, negative integer, wrong
digest size, truncated buffer, unsupported length form). No silent fallthrough.

### 77.3 The correction: §70's gap was not an unhandled member

`canonicalize` also throws on unsupported types — floats, `-0`, unsafe integers, lone surrogates, sparse
holes. **Booleans were never unhandled.** They were handled correctly (`v ? "true" : "false"`) and simply had
no test.

So the bug class is narrower and more specific than §76 stated. It is not "dispatch sites" as a category. It
is:

> **a member that IS handled, whose output is consumed silently, and which no test pins.**

All three conditions are required. A member that is unhandled throws. A member whose output is checked
downstream (a GL account against the canonical set, a DER structure the TSA rejects) surfaces on its own. Only
where handled-and-silent-and-untested overlap — a hash, where any bytes are *a* valid answer and nothing
downstream disagrees — does a wrong answer travel undetected. That is precisely the canonical byte law, and it
is why the fix there was a **known-answer vector** rather than another behavioural test.

**§76's "audit the dispatch sites" is superseded by this.** The sharper question, and the one worth carrying:
*where does this code produce bytes that nothing downstream can disagree with?* In this repo that set is
small — canonical JSON, the Merkle vectors, the DER request — and all three now carry known-answer vectors.

**Verification.** `sequencer.ts` restored byte-identical; the exhaustiveness mutation proved RED at the type
level; all five `typeof`-dispatch modules read for silent-fallthrough behaviour; gates PASS.

---

## §78 — phase gate re-measured at `0a8b6da`

§65 stamped `f026527`. Thirteen sections later, measured again.

**1. Zero open repository-owned Critical/High — SATISFIED.** §66–§77 opened two real defects and closed both:
the canonical byte law's unpinned boolean (§70) and this loop's own chokepoint-lint evasion (§71). Everything
else was a clean negative. The two open Highs remain **External** and unchanged (driver custody handoff, live
EDI adapter); the pre-R4 repo carry-forward is still resolve-path pool-binding exclusivity.

**2. Baseline gates green — SATISFIED but for the one row that is not this loop's.** **17 workspaces, 2,879
tests, exit 0** (2,877 at §65 plus §70's two new byte-law vectors). Root `tools/`: **715 tests, 3 failing** —
the same three register-parsing failures, and `check:coverage` reports `classified 288/289, unaccounted: 1`.
Isolated by experiment in §52 to the GTM workstream's uncommitted `REQ-289`. All twelve static gates PASS.

**3. Remaining debt entirely External or CONFIRM-gated — SATISFIED**, unchanged from §65, including the
`routes ±10%` owner decision (§61/§68 — now traced to **two** genesis documents, so it is settled intent
rather than a stray phrase) and the seventeen §48 boundary-module threat rows still deliberately unwritten.

**4. The record agrees with the world — SATISFIED.** §77 corrected §76's own framing within the same
iteration; §73 caught a mis-targeted mutation before it became a false finding about the isolation suite.

### 78.1 What thirteen sections of mutation-testing established

Nine security-critical rules were reverted to their pre-fix form and the suite watched. **Seven held**, several
at two or three independent layers (§72's inherited visibility: resolver sentinel + type system + four
behavioural tests; §74's C3 path: resolver + dispatch + sweep enumeration). **Two had real gaps**, and both
were in recently-written code — §70's boolean vector had been missing since the byte law was written, and §71's
evasion was introduced by this very loop in §56.

The durable finding is about test *naming*, recorded in §75: every rule that held was pinned by a test named
for **what an attacker could attempt**; both gaps were covered only by tests named for **what the code does**.
And §77 narrowed the residual bug class to its precise shape — *a member that is handled, whose output is
consumed silently, and which no test pins* — which in this repo is the small set of byte-producing surfaces
(canonical JSON, Merkle vectors, DER), all three now carrying known-answer vectors.

**The stopping line is unchanged and is reached again at `0a8b6da`.**

---

## §79 — the byte-producing surfaces, enumerated properly: seven, not three, and all seven pinned

§77 closed with a claim I asserted rather than checked: *"in this repo that set is small — canonical JSON, the
Merkle vectors, the DER request — and all three now carry known-answer vectors."* §62's rule applies to my own
sentences, so the enumeration was redone by looking.

**The set is seven.** Every one produces bytes that nothing inside the repo can disagree with — a wrong answer
is still *an* answer, and no downstream consumer objects:

| Surface | Its known-answer vector |
|---|---|
| Canonical JSON | `canonical.test.ts` — four exact-output goldens, the `{}` sha256, and (§70) a boolean golden plus an all-six-types hash |
| Merkle tree | `fixtures/merkle-vectors/` — vendored, sha256-pinned, RFC 6962 known answers |
| DER (TSA request) | `der.test.ts:21` — *"encodes version/imprint/nonce/certReq to the exact expected DER"* |
| **QuickBooks IIF** | `iif.test.ts:95` — *"byte-equals the pinned fixture"*, plus order-insensitivity and a Σ=0 penny check |
| **EDI 214 outbound** | `build-214.test.ts:39` — the expected document assembled from literal segments, compared with `toBe` |
| **EDI 990 outbound** | `build-990.test.ts` — ACCEPT and DECLINE each to exact bytes |
| **Signed `clientView`** | `sign.test.ts:45` — the signed field set frozen as an exact 10-key array |

The last one is worth drawing out: `clientView` pins **which fields are signed**, and §70's byte law pins
**how those fields serialize**. Neither alone fixes the signed bytes; together they do. A frozen field set over
a drifting serializer, or a frozen serializer over a drifting field set, would each leave the signature
verifiable-but-different — and this repo has both halves.

**So §77's "three" was wrong and its conclusion was right.** The bug class it named — *handled, silently
consumed, untested* — is real, and the surfaces where it can bite are more numerous than I said. Every one of
them is nonetheless pinned by a known-answer vector, which is the strongest available evidence that this
codebase already understood the class before this loop named it. §70's boolean was the single member that
slipped, in the oldest and most-tested of the seven.

### 79.1 A seventh grep near-miss

Checking EDI, `grep -cE 'toBe\("|toContain\("ISA'` over `build-214.test.ts` returned **0**, and the test is
named *"serializes … to the exact expected X12 214 bytes"* — a name §51 taught me not to trust. Reading it
showed a genuine vector: `expected` is a `const` assembled from an array of literal segments, so the
assertion is `toBe(expected)` and matches no pattern I searched for.

Seventh instance this loop. The tally is now unambiguous: **seven absence claims, seven wrong**, every one
corrected by reading or running rather than by searching harder.

**Verification.** All seven vectors located and read; no code changed; gates PASS.

---

## §80 — read-model consistency: pinned at four layers, including the business consequence

`keep-readmodel-consistent-with-ledger` records a defect worth restating precisely, because it is the kind
that produces **wrong money with everything green**: `invoice.corrected` with empty `reissue_lines` is a
**void**. The RED emitted the netting credits onto `money_lines` but returned `[]` for the invoices upsert — so
the ledger netted the invoice to zero while the AR read-model still showed it `issued` at its original total.
Two read-models of one event, disagreeing, with no error anywhere.

Reverting that single branch to `[]` turns **four** tests red, and their layering is the point:

1. **The projection** — *"invoice.corrected with empty reissue_lines is a VOID: credits only, no reissue, AND
   the invoices row flips to void/0."*
2. **The invariant** — *"I7: voiding an all-positive invoice nets stream AR to EXACTLY 0."*
3. **Through real D1** — *"after issue→void the invoices AR (status='issued') == money_lines net (both 0)."*
   The two read-models compared against each other, not each against a hard-coded expectation.
4. **The business consequence** — *"computeDsoDays EXCLUDES a voided invoice (no phantom open AR in DSO)."*

The fourth is the one that matters most and the one most suites omit. Layers 1–3 assert the projection is
correct; layer 4 asserts that **the thing the projection exists for** — a DSO figure someone will read — is
correct. A fix that flipped the row to `void` but left the DSO query scoping on something else would satisfy
1–3 and still report phantom open AR. It is §75's rule again: name the scenario, not the mechanism.

Layer 3 deserves a note too. It asserts the two read-models **agree with each other** rather than each
matching a literal. That is the right shape for a consistency invariant — a drift that moved both would be a
real change worth failing on, while a hard-coded pair would go stale the first time the fixture's amounts
changed.

**Verdict: clean negative.** `packages/ledger` 609 tests / 34 files green; mutation proved RED at all four
layers; `money.ts` restored byte-identical; mutation site confirmed live by line number first (§73).

This is the eighth skill mutation-tested (§69–§80). **Six clean, two real gaps**, both already closed.

---

## §81 — a security test that passed for the wrong reason: the positions assignment gate

`enforce-server-side-gate-parity` covers the routes that **bypass the sequencer** — chiefly `POST /v1/positions`,
the high-volume raw-GPS path that skips `seq`/hash-chaining but must not skip the gates. Its RED was a write
with no consent check that bound a client-supplied `shipment_id`/`device_id` unverified.

Three gates now stand there, in order: **driver-assignment**, **device-registration**, **consent**. Each was
reverted separately.

- Remove **device-registration** → 1 test red, and the right one (*"assigned driver but device_id NOT
  registered to them → 403, nothing inserted"*).
- Remove **consent** → 1 test red (*"…NO consent on the stream → 403 GATE_BLOCKED(consent)"*).
- Remove **driver-assignment** → **the entire `workers/api` suite passed. 740/740.**

### 81.1 The test existed, was named correctly, and proved nothing

This is not a missing test. `positions-gate.test.ts:108` reads *"driver posting to a shipment NOT assigned to
them → 403, nothing inserted"* — exactly the right case. It asserted `status === 403` and a zero row count.

**All three gates answer 403.** The fixture posts to `SHP_OTHER`, which the suite's own setup comment says is
assigned to a different driver — and which, by that same setup, has **no consent** (*"Consent (CA) lives ONLY
on SHP_ASSIGNED"*). So with the assignment gate deleted the request fell through to the consent gate, got its
403, inserted nothing, and the test passed. Green, for a reason unrelated to what it was written to check.

A wrong-reason pass is worse than a missing test. A missing test is visible in coverage; this one occupies the
slot, carries the right name, and reports success — and it would have gone on doing so for as long as the gate
was absent.

### 81.2 The asymmetry that pointed at it

`assignmentOf` has exactly two callers: the events route and the positions route — one predicate, deliberately
shared so the paths cannot drift (the skill's own prescription). Mutating the **events** side turns
`lens-adversarial.test.ts` red (*"D2 cannot append to D1's shipment"*). Mutating the **positions** side turned
nothing red.

So the predicate was shared and the *coverage* was not, on the path explicitly documented as the sanctioned
bypass. That is the share-lint family again (§71): two callers of one rule, one of them unguarded.

### 81.3 The fix, and why it is about reasons

Both refusal tests now assert the **distinguishing message** — `DRIVER NOT ASSIGNED`, `DEVICE NOT REGISTERED` —
not merely the status they share with every sibling gate. Mutation-proved: removing the assignment gate now
turns that case red, where before it stayed green.

The general form is worth stating, because this repo's gates all answer 403 by design: **when several guards
share a status code, asserting the status tests none of them.** The assertion has to name the guard that was
supposed to fire.

**Verification.** `positions-gate.test.ts` 4/4 green restored; the assignment mutation now RED (was 740/740
green); `positions.ts` and `events.ts` both restored byte-identical.

---

## §82 — hunting §81's pattern: 82 bare 403 assertions, and why that number is not 82 defects

§81 found a security test passing for a sibling gate's reason. The obvious next question is how widespread
that is, so the mechanical form was measured: **116** assertions of `toBe(403)` across `workers/api/test`, of
which **34** also assert a reason/message/gate and **82** assert the bare status.

**82 is not a defect count, and reporting it as one would be the kind of inflated finding this audit exists to
avoid.** A bare status assertion is only hazardous when *both* conditions hold:

1. the route has **two or more independent guards** that answer the same status, and
2. the test's fixture **trips more than one of them**, so the assertion cannot tell which fired.

§81 met both: `positions.ts` has three 403 guards, and `SHP_OTHER` was simultaneously unassigned *and*
consent-less. On a single-guard route a bare 403 is unambiguous and perfectly sound.

Condition 1 narrows the field to eleven routes (`events.ts` 13 sites, `positions.ts` 6, `board.ts` 5,
`status-link.ts` 5, `portal-actions.ts` 4, `rate.ts` 4, `approvals.ts` 3, `authority.ts` 3,
`internal-platform.ts` 3, `documents.ts` 2, `invoices.ts` 2). Condition 2 can only be settled per guard, by
mutation.

### 82.1 What was actually checked

- **`positions.ts`** — all three guards reverted individually (§81). Two pinned, one not; fixed.
- **`events.ts`** — the shared `assignmentOf` guard reverted; **pinned** (`lens-adversarial.test.ts`,
  *"D2 cannot append to D1's shipment"*).
- **`portal-actions.ts`** — the scope guard (`visibleCount === 0`) reverted; **pinned**, by two well-named
  cases: *"accepting on a shipment it CANNOT see → 403"* and the claim equivalent.

**Not checked: the remaining guards on the other eight routes.** Each needs its own mutation, and each
mutation costs a full suite run. That is a bounded, mechanical follow-up — roughly two dozen mutations — and it
is recorded here as outstanding rather than quietly folded into "swept".

### 82.2 The rule worth keeping

The defect is not "a test asserts a bare status." It is **a test whose fixture satisfies more than one guard
while its assertion distinguishes none of them.** Stated that way it is checkable at authoring time without
any sweep: *when I write this fixture, how many of this route's guards does it trip? If more than one, the
assertion must name the one I mean.*

That is cheaper than auditing 82 call sites, and it is where the rule belongs — with the author, as §64
concluded for record claims.

**Verification.** `portal-actions.ts` restored byte-identical; its two guard tests confirmed RED under
mutation; the 116/34/82 counts produced by script, not by eye.

---

## §83 — clearing §82's open item, and a broken instrument that reported false all-clears

§82 recorded ~24 unmutated guards as outstanding rather than claiming a sweep. This clears most of it, and
corrects §82's own arithmetic on the way.

### 83.1 The field is smaller than §82 said

§82 counted "11 routes with ≥2 403 sites" by grepping for `403` — which counts **comment lines**.
`documents.ts` was listed with 2 and has exactly **one** real guard; its other hit is prose.

Counting only lines that actually construct a 403 (`ApiError`/`envelope`, comments excluded): **6 routes, 18
real guards** — `events.ts` 8, and 2 each in `board.ts`, `portal-actions.ts`, `positions.ts`, `rate.ts`,
`status-link.ts`. Third arithmetic correction to my own count this loop (after §58's gate figure and §79's
"three" byte surfaces), and the same cause each time: counting a pattern instead of the thing.

### 83.2 The harness reported false UNPINNED until it was validated

I wrote a per-guard mutation harness and ran it first against `positions.ts` — whose two guards §81 had
**proved** pinned. It reported both **UNPINNED**.

The bug: the runner piped vitest to `tail`, so `execSync` saw *tail's* exit code (always 0), never threw, and
every guard scored green-under-mutation. Had I aimed it at an unaudited route first, it would have reported a
clean sweep of guards it never actually tested — a false all-clear delivered with a tidy table.

This is §73's rule one level up. There it was *confirm the mutation landed in the function under test*; here it
is **confirm the detector can detect**. The cheapest way to know is to run any new audit instrument against a
case whose answer you already have, before running it on the ones you don't.

### 83.3 Results, with reachability as the deciding property

| Guard | Verdict |
|---|---|
| `positions.ts` × 2 | **PINNED** (§81, after the assignment case was strengthened) |
| `rate.ts` line 138 — portal rating a shipment it cannot see | **PINNED** — by a test *outside* `rate.test.ts`, which is why the per-route pass had to escalate |
| `rate.ts` line 141 — `LENS_UNRESOLVED` | **PINNED** (same escalation) |
| `board.ts` line 78 — `LENS_UNRESOLVED` | **PINNED** — *"a portal…"* case in `board.test.ts` |
| `board.ts` line 185 — driver branch | **Unpinned — and correctly so** |

That last row is the one worth explaining. `requireRole("admin","ops","finance","read","portal")` **excludes
driver**, so the driver branch is unreachable through the route; the source says exactly that (*"unreachable
via requireRole; kept fail-closed as defence-in-depth"*). Mutating it alone leaves 740/740 green because no
request can get there. **An unreachable defence-in-depth branch cannot be pinned by a route test, and its
being unpinned is not a defect** — deleting it would be, which is why it stays.

So "unpinned" is not the finding; **"reachable and unpinned"** is. That is the same shape as §82's "82 bare
assertions are not 82 defects": the raw count is a candidate list, and reachability is the filter.

**Remaining: `events.ts` (8) and `status-link.ts` (2)**, plus `portal-actions.ts`'s second guard. The GO-LIVE
row is updated rather than closed.

**Verification.** All mutated files restored byte-identical (`git status` clean for `workers/api/src`); the
harness validated against known-pinned guards before use; `board.ts` line 185 isolated for its own full-suite run.

---

## §84 — the multi-guard 403 sweep, finished: one real hole, and it was the sole enforcement of gate-override authority

§82 opened this as an item and §83 cleared part of it. All **18** real 403 guards across the **6** multi-guard
routes now have a verdict, each by neutralising the guard and running the **full** `workers/api` suite.

**Thirteen PINNED.** `positions.ts` ×2, `rate.ts` ×2, `board.ts` line 78, `status-link.ts` line 43,
`portal-actions.ts` line 62, and five of the eight on `events.ts` — including the no-bypass rules that matter most:
server-emitted kinds (REQ-030), `approval.decided` must route via `/approval-decision` (REQ-194),
`credit.checked` privileged-decision (REQ-185), the finance-scope rule, and the driver write-scope.

**Five unpinned for good reasons**, each verified rather than assumed:

| Guard | Why unpinned is correct |
|---|---|
| `board.ts` line 185 | `requireRole` excludes `driver`, so the driver branch is unreachable through the route. Documented as defence-in-depth. |
| `events.ts` line 228 (`authority.flipped`) | **Masked downstream.** The route derives `streamId = \`s:${shipmentId}\``, and the DO refuses `authority.flipped` on any stream but `t:root`. Removing the route guard changes no observable behaviour — the append is refused either way. |
| `events.ts` line 68, `status-link.ts` line 40, `portal-actions.ts` line 59 | All three are the same shape: `LENS_UNRESOLVED` → a clean 403 instead of an opaque 500. Defensive translation of an internal failure, not an authorization decision. |

**And one real hole — `events.ts` line 255.**

### 84.1 Gate-override authority had exactly one enforcement, and no test

```ts
if (!ELEVATED.has(session.role)) throw new ApiError("FORBIDDEN", 403, "OVERRIDE REQUIRES AN ELEVATED ROLE");
```

`ELEVATED` is `{ops, admin, finance}`; `requireRole` on this route admits `{admin, ops, driver, finance}`. **The
one role that reaches the check and must fail it is `driver`** — so it is reachable by exactly the principal
with the least authority.

It is also the **sole** enforcement: the sequencer stamps `override` onto the event (author forced to
`session.sub`) but never re-checks the author's *role*. Nothing downstream masks it, unlike `events.ts` line 228.

So deleting that line would let a driver attach `override: {reason}` to a gated append and **waive a
server-side gate** — REQ-049's accountability record would faithfully name them as the waiving author, which is
precisely the audit trail working while the authorization did not. And all **740** api tests stayed green.

The positive case existed — *"a named override (elevated role) releases the hold → 201 + override stamped"* —
and proved that an elevated role **may**. Nothing proved a non-elevated role **may not**. That is §75's rule
once more: the suite tested what the feature does, never what an attacker wants.

Test added and mutation-proved: *"a DRIVER attaching an override is 403 — only an elevated role may waive a
gate (REQ-049)"*, asserting the 403, the `ELEVATED` reason (not the shared status — §81), and **zero appends**.
Removing the guard now turns it red.

### 84.2 The shape of the whole sweep

Eighteen guards, one hole. The hole was not in an obscure branch — it was in the authorization for the single
most powerful client capability in the API, *waiving a server-side gate*. It survived because the coverage
grew around the feature (does the override work? is it stamped? is it on the hashed event?) and never around
the refusal.

**Verification.** All six route files restored byte-identical (`git status` clean for `workers/api/src`);
`booking-gate.test.ts` 23/23 with the new case; the mutation proved RED.

---

## §85 — phase gate re-measured at `1909df4`

§78 stamped `0a8b6da`. Seven sections later, measured again.

**1. Zero open repository-owned Critical/High — SATISFIED.** §79–§84 opened one real defect and closed it:
the gate-override authorization gap (§84), which was the sole enforcement of "only an elevated role may waive
a server-side gate" and had no negative test. Everything else in that span was a clean negative. The two open
Highs remain **External** and unchanged; the pre-R4 repo carry-forward is still resolve-path pool-binding
exclusivity.

**2. Baseline gates green — SATISFIED but for the one row that is not this loop's.** **17 workspaces, 2,880
tests, exit 0** (2,879 at §78 plus §84's override-refusal case). Root `tools/`: **715 tests, 3 failing** — the
same three register-parsing failures; `check:coverage` reports one unclassified row. All **twelve** static
gates PASS.

**3. Remaining debt entirely External or CONFIRM-gated — SATISFIED.** One checklist item **closed** this span
(the multi-guard 403 sweep, §82→§84) rather than carried. The `routes ±10%` owner decision stands.

**4. The record agrees with the world — SATISFIED**, after three self-corrections in this span: §79 corrected
§77's "three byte surfaces" to seven, §83 corrected §82's route count (comment lines inflated it), and §84's
write-up was itself caught by the citation ratchet for introducing bare line numbers into churn-prone files.

### 85.1 What the mutation programme found, in total

Across §69–§84, **thirty-one** guards, invariants and byte surfaces were reverted to their pre-fix form and
the suite watched. **Twenty-eight held.** Three did not:

| Defect | Where |
|---|---|
| Canonical byte law had no boolean vector (§70) | Oldest, most-tested surface in the repo |
| The chokepoint lint carried the evasion its own skill documents (§71) | Code written **by this loop**, in §56 |
| Gate-override authority had one enforcement and no refusal test (§84) | The most powerful client capability in the API |

Every one was a **coverage** defect; not one was a missing or wrong guard. That is the shape of a codebase
whose controls are sound and whose tests grew around what the features *do*. The durable rules extracted —
name tests for the adversary (§75), assert the reason not the shared status (§81), and write the refusal when
you add a capability (§84) — are all corrections to *how coverage is written*, not to how the system behaves.

**The stopping line is unchanged and is reached again at `1909df4`.**

---

## §86 — revocation that did not revoke: a security limitation flagged only in a code comment

§84's rule — *when you add a capability, write the refusal* — pointed at the next capability without one:
device enrollment and **revocation** (REQ-254, *"binds P-256 keys to the authenticated driver with revocation
and lockout"*).

`devices.ts` carried an honest note from its author:

> the sequencer's device-signature accept path (`#deviceKey`) and the positions ownership check
> (`deviceOwnedBy`) do NOT yet exclude a `revoked_ts`-marked entry … **Flagged rather than silently editing
> files this task does not own.**

Verified still true, by reading both queries: each matched on `device_id` alone.

### 86.1 What that meant

Revoking a device removed it from the enrollment surface's active list — and **nothing else**. The two readers
that gate writes still accepted it:

- `deviceOwnedBy` → a revoked device kept posting **positions**;
- the sequencer's `#deviceKey` → a revoked device's **signature still verified**, so it kept appending signed
  events to the ledger.

A stolen or off-boarded driver's phone therefore retained full write access after the operator revoked it.
**The one lever available against a compromised device did nothing to the two paths that matter** — and
REQ-254 names revocation as part of its acceptance, so this was an incomplete row rather than absent scope.

### 86.2 Why it survived: the flag lived only in the code

`revoked_ts` appears in **no document** — not the GO-LIVE checklist, not the threat model, not this audit
before now. The note was accurate, well-written, and invisible to everyone who does not read that file's
header. That is §45's finding exactly (*a correction recorded somewhere true but not where it is
load-bearing*), and here it hid a live security gap rather than an understatement.

The devices suite made it easy to miss: it has *"REVOCATION: a revoked device drops off the active list;
re-enrolling reactivates it"* — coverage of the **surface**, none of the **consequence**. Precisely §84's
shape, one section later, in a different subsystem.

### 86.3 The fix

`json_extract(je.value,'$.revoked_ts') IS NULL` added to both readers — one rule, both call sites, each
carrying a comment naming the other (share-lint, §71). `revoked_ts` is absent on an active entry and
`json_extract` yields NULL for both a missing key and an explicit null, so `IS NULL` is the correct active
test for both shapes.

Two tests, written as part of the fix rather than after it:

- *"a revoked device is refused (403 DEVICE NOT REGISTERED), nothing inserted"* — asserting the
  distinguishing reason (§81), not the shared 403.
- *"the driver's still-ACTIVE device is unaffected — revocation is per-device, not per-driver"* — the
  positive control, so a mutation that refused *everything* could not pass as a fix.

Mutation-proved: reverting `deviceOwnedBy` to its pre-fix query turns the first red. The stale note in
`devices.ts` is struck through and closed in place rather than deleted, so the record shows what was true and
when it stopped being true.

### 86.4 The first draft of the fix broke ten unrelated tests

Worth recording because it is a hazard specific to this suite. The api worker runs with
`isolatedStorage: false`, so **one control-plane row is shared by every test file**. My first version of the
revocation test replaced `u-driver`'s `device_keys` wholesale, substituting a stub `public_jwk: {}` for the
real signing key — and turned **ten Biller reconciliation tests red**, because they verify genuine POD
signatures against that key.

Caught only by running the FULL suite; the per-file run was 6/6 green throughout. Rewritten to read, append,
and write back, so the shared row gains a revoked entry and loses nothing. **In a shared-storage suite a
fixture that writes must add, never replace** — and a per-file green is not evidence that it did.

**Verification.** `devices.test.ts` + `positions-gate.test.ts` 14/14; full `workers/api` suite re-run after
the fixture was made non-destructive.

---

## §87 — the limitations-flagged-only-in-code sweep, after §86 proved the class can hide a live hole

§86's defect lived in an accurate, well-written code comment that **no document carried**, and it hid a real
security gap for the whole life of the file. That makes the class worth sweeping rather than treating as one
incident: *what else is flagged in source and absent from the operating record?*

**Marker sweep** (`TODO`, `FIXME`, "not yet", "does NOT yet", "follow-up") across `workers/*/src` and
`packages/*/src`: **two hits, both known.** The POD-gate `serviceClass` exemption (fail-**safe**, on the
GO-LIVE checklist since §55) and the `revoked_ts` note §86 closed. The conventional-marker channel is clean.

**Phrasing sweep** ("unwired", "dormant", "deferred", "cannot yet", "does not enforce") found the rest, mostly
feature names (`deferred evidence upload`) or deliberate design notes. One was a genuine record gap.

### 87.1 Below-floor interline splits hold forever, by design, and nothing said so

`approvalGranted` is **intentionally unwired** in both the Biller and the interline splitter, symmetrically. A
below-floor share — or one carrying an anomaly — **HOLDS and never appends** until the approvals queue lands.

Direction checked first, because that is what decides severity: this is fail-**closed**. The deferral blocks
money rather than releasing it, which is the correct conservative choice and the opposite of §86, where the
deferral left a revoked device writing.

So the gap is **operational, not behavioural**. An operator watching interline splits sit unresolved had
nothing in the record telling them this is designed rather than broken, and that the release path is the
approvals queue rather than a retry or an escalation. Now a checklist row, with the wiring instruction for
when the queue ships (both callers, deliberately symmetric).

### 87.2 What the sweep says about the class

Two limitations flagged in code across two workers and eleven packages, one of which was a live security hole
(§86) and one an operational blind spot (this). Both were *correctly identified by their authors* — the defect
was never the engineering judgement, it was that **the note stopped at the file it was about.**

The cheap discipline that would have caught both: when you write "this is not yet enforced" in a comment, the
same commit adds the row. A comment records it for whoever opens that file; the checklist records it for
whoever is deciding whether to go live. §86 shows the difference is not cosmetic — it was the whole reason a
revoked device kept its write access.

**Verification.** Both sweeps run across `workers/*/src` and `packages/*/src`; every hit read and classified;
tables and citations PASS.

---

## §88 — phase gate re-measured at `4739965`

§85 stamped `1909df4`. Measured again after §86–§87.

**1. Zero open repository-owned Critical/High — SATISFIED.** §86 found and closed a **live security defect**:
a revoked device retained full write access to positions and the signed-event path (REQ-254). Both readers now
carry `revoked_ts IS NULL`, mutation-proved, with a positive control so a fix that refused everything could
not pass. The two open Highs remain **External** and unchanged.

**2. Baseline gates green — SATISFIED but for the one row that is not this loop's.** **17 workspaces, 2,882
tests, exit 0** (2,880 at §85 plus §86's two revocation cases). Root `tools/`: 715 with the same three
register-parsing failures. All **twelve** static gates PASS.

**3. Remaining debt entirely External or CONFIRM-gated — SATISFIED**, with one row **added** (§87: below-floor
interline splits hold by design, fail-closed, previously unrecorded) and one **closed** last span.

**4. The record agrees with the world — SATISFIED**, and this span is the clearest evidence for why the
condition exists. §86's defect was invisible to every document; it lived in one accurate code comment.

### 88.1 Two process failures of mine this span, both recorded where they happened

- **A test fixture that replaced instead of appending** broke ten unrelated Biller tests. The api worker runs
  with `isolatedStorage: false`, so one control-plane row is shared across every test file. The per-file run stayed
  6/6 green throughout; only the full suite caught it.
- **A commit shipped with a failing typecheck** — a duplicate import vitest's esbuild tolerated and `tsc` did
  not. I ran the gate set *after* committing rather than before, which is the wrong order and is precisely why
  it reached a commit.

Neither changed a conclusion, both are recorded, and the second is the more embarrassing: the discipline this
audit applies to the codebase is the same one it has to apply to itself, and running gates before the commit
is not an optional step.

**The stopping line is unchanged and is reached again at `4739965`.**

---

## §89 — the state-marker class that produced §86, swept to completion

§86's defect had a precise, reusable shape: **a column marks something inactive, and a reader does not filter
on it.** Revocation wrote `revoked_ts`; the two readers that gate writes matched on `device_id` alone. That is
sweepable, so it was swept.

**The state markers in this schema are few.** No `expires_*`, `deleted_ts`, `suppressed_*`, or `disabled`
columns exist. The inactive-marker surface is three things: `pairings.status` (default `'active'`), the
`revoked_ts` field inside `users.device_keys[]` (§86, fixed), and `invoices.status` (§80 verified the
void/DSO exclusion).

**Every reader of `pairings` enumerated — six — and each classified:**

| Reader | Filters `status`? | Verdict |
|---|---|---|
| `principal.ts` (mint) | selects + checks | **Correct** — §50 |
| `webhooks.ts` (subscription) | selects + checks (`status !== "active"` ⇒ null) | **Correct** |
| `inbound.ts` (EDI) | requires `kind='edi'` AND active | **Correct** — §47 |
| `oauth.ts` `pairingSecretRef` | no | **Masked** — its only caller, `authenticateClient`, calls `resolveActiveMcpPairing` first and denies on null. Read separately by design, "to keep that helper's surface to what the principal mint needs" |
| `caps.ts` (cap lookup) | no | **Masked** — keyed on `ctx.pairingId`, which exists only after the principal mint resolved an ACTIVE pairing |
| `webhooks.ts` (originator) | no | **Masked** — a tenant-**parity** comparison reached after the subscription row's own active check; it compares `tenant_id`, and an inactive originator could not have authenticated |

Three filter directly, three are masked by an upstream active check that was verified, not assumed — each by
reading the caller, per §84's rule that a guard's absence only matters where nothing upstream refuses first.

### 89.1 Why §86 was the exception

The three masked readers share a property the device path lacked: **the active check and the use sit on the
same request path**, one calling the other. `deviceOwnedBy` and the sequencer's `#deviceKey` had no such
upstream — they *were* the check, on paths (positions, signature verification) reached directly from a client
request. Nothing else could refuse first, so the missing predicate was the whole gate.

That is the useful generalisation: **an unfiltered read of a state column is only a defect when it is the
first authority on that state.** Where a caller has already resolved the row as active, the second query is
retrieval, not authorization.

**Verdict: clean negative** — the class that produced a live security defect has one instance, now fixed, and
no siblings.

**Verification.** Schema scanned for state-marker columns; all six `pairings` readers read and classified by
their callers; gates PASS.

---

## §90 — the cap token: the best-defended first authority in the audit

§89's rule says a state read matters most where it is the **first authority**. The cap token is the purest
example left: for `/pub/status/:cap` and `/pub/documents/:cap` there is no session, no role, no tenant header —
**the token is the entire authorization decision** for an anonymous caller.

**Its construction is layered, and each layer was read:**

- **Key separation.** The cap is signed with a secret *derived* from `JWT_SECRET`, not `JWT_SECRET` itself, so
  a session token and a cap can never validate against each other's key.
- **Type confinement.** The payload requires `typ: z.literal(CAP_TYP)` — a second, independent barrier to
  cross-token replay even if the keys ever converged.
- **Required expiry.** `exp: z.number()` is required by the schema, not merely usually present (§70's question,
  asked and answered).
- **`.strict()`.** No extra keys, so nothing can be smuggled into a signed payload.
- **Scope in the MAC.** Tenant and shipment are signed claims, so tampering either breaks the signature before
  any database read.

**And the suite is the most adversarially-named in this audit** — seven cases, every one a scenario rather
than a mechanism: a garbage cap; a valid cap for a **missing** shipment returning a 401 *identical in code and
message* to a garbage one (**no existence oracle**); a tampered `s`; a flipped `t`; **a real session JWT used
as `:cap`**; an expired cap; and two disclosure cases pinning the response key allowlist and coarse geo.

That is §75's rule applied without being told: the tests are named for what an attacker would try.

### 90.1 My mutation tested the wrong direction, and what it actually proved

I replaced the derived secret with `JWT_SECRET` to see whether type-confinement alone would hold the line.
It broke the **positive** controls instead — valid caps stopped verifying, because the test mints with the
derived secret and verification now used the raw one. Four tests went red, none of them the replay case.

So it proved something real but different: **the mint/verify key derivation is pinned**, and a change to it
fails loudly rather than silently widening anything. Testing whether `typ` is independently load-bearing would
need both mint and verify moved to the shared secret — a fair follow-up, and not one I should dress up as
having done.

Recorded because a mutation that answers a different question than the one asked is easy to write up as though
it answered the intended one, and this audit has already caught itself doing exactly that (§73, §83).

**Verdict: clean negative**, and the strongest surface examined. `pub-status.test.ts` 11/11; `status-cap.ts`
restored byte-identical.

---

## §91 — finishing §90's follow-up: both cap defences are real, neither was pinned, and my first pin was a wrong-reason pass

§90 left an explicit open question and said it should not be written up as answered: is the cap's `typ`
confinement **independently** load-bearing, or was key separation carrying it? Answering it needed the
mutation §90 got wrong — moving **both** mint and verify to the shared secret.

**Both defences are independently sufficient.** Measured, not reasoned:

| Mutation | Route suite |
|---|---|
| Key separation removed (mint **and** verify on `JWT_SECRET`) | **11/11 green** — `typ` + `.strict()` alone refuse a session JWT |
| `typ` literal + `.strict()` removed, derivation kept | **11/11 green** — key separation alone refuses it |

That is genuine defence-in-depth: either layer holds the line by itself. **And it is exactly why neither was
pinned** — removing one changes nothing observable through the route, because the other refuses. §84's
"masked" situation, symmetric.

Harmless today, and a trap tomorrow: a refactor could delete one layer, see green, and reduce two defences to
one with no signal — after which a change to the survivor opens the hole with nothing to catch it.

Two unit-level cases now pin each layer where the other cannot mask it: a token signed with the **raw**
`JWT_SECRET` but otherwise perfect (only derivation can refuse it), and a token on the **correct** cap key
with no `typ` (only `.strict()` can). Each was mutation-proved to fail for *its own* layer and no other.

### 91.1 My first version of the key-separation test was itself a wrong-reason pass

I hardcoded `typ: "shuddl.status.v1"` — a guess. The real constant is `"status-cap"`. So the token was
rejected for a **type mismatch**, not a key mismatch: the test passed, and went on passing with key separation
fully removed, which is precisely the defect it existed to catch.

**That is §81's wrong-reason pass, written by me one section after §81 documented it** — and caught only
because I ran the mutation against my own new test rather than trusting it green. `CAP_TYP` is now exported
and imported by the test, so the forged payload always carries the real value and the case can only pass for
the reason it names.

The lesson §81 drew was about asserting reasons rather than shared statuses. This adds the author-side half:
**a test that hardcodes a constant it could import is asserting your memory of the value, not the value.**

**Verification.** `pub-status.test.ts` 13/13; each new case proved RED under its own layer's mutation and
green under the other's; `status-cap.ts` restored (plus the deliberate `CAP_TYP` export).

---

## §92 — redundant CALLS versus redundant MECHANISMS: when one pin is enough

§91 found two defences masking each other and concluded both needed pinning. The MCP OAuth flow looked like
the same shape — the source calls its authorize-time pairing check *"belt with `/token`'s re-resolution"*, and
the oauth suite seeds **only** `status: "active"`, so no inactive pairing is exercised there at all. That
looked like §86's defect in a new subsystem: an MCP client whose pairing is revoked, still authorizing.

It is not, and the reason is worth separating from §91.

**Both call sites invoke the same predicate.** `resolveActiveMcpPairing` filters `status !== "active"` in one
place, and `/authorize` and `/token` each call it. Mutating that single filter turns exactly one test red —
`principal.test.ts`'s *"an INACTIVE pairing throws (fail-closed) — nothing is minted"* — which seeds a
`status: "revoked"` pairing, the fixture the oauth suite lacks.

So the predicate is pinned once, and both callers inherit it. **That is correct, and one pin is sufficient**,
because there is only one thing to break: no edit can remove the check from `/authorize` while leaving it at
`/token`, since neither owns it.

### 92.1 The distinction

| Shape | Pinning needed |
|---|---|
| **Redundant calls to one shared predicate** (MCP pairing status) | **One pin, on the predicate.** The redundancy is in the call graph, not the logic — a single edit cannot remove one copy, because there are no copies |
| **Redundant independent mechanisms** (§91's derived key *and* `typ` literal) | **One pin per mechanism.** Each can be deleted on its own, and the survivor masks the loss |

§91's cap defences were two *different ideas* implemented separately. The MCP checks are two *calls* to one
idea. Only the first can silently degrade — and it did nothing but look identical from the route's outside.

The practical test when you see "belt and suspenders": **ask whether one edit can remove one of them.** If the
answer is no because they share an implementation, pin the implementation and stop. If yes, each needs its
own case.

### 92.2 The eighth near-miss

Searching `oauth.test.ts` for an inactive-pairing fixture returned nothing, and I was again a sentence from
"the pairing status check is untested." It is tested — in `principal.test.ts`, the file that owns the
predicate rather than the file that owns the route. Eighth instance this loop, corrected by the mutation
rather than by more searching, exactly as §72 prescribed.

**Verdict: clean negative.** `workers/mcp` 177/177; the status filter mutation-proved RED; `principal.ts` and
`oauth.ts` restored byte-identical.

---

## §93 — §92's rule turned on §86's own fix: the signature half was never pinned

§92 gave a test for "belt and suspenders": **can one edit remove one of them?** Applied to my own §86 fix, the
answer was yes, and I had missed it.

§86 added `revoked_ts IS NULL` to **two** readers — `gate-context.ts deviceOwnedBy` (positions) and the
sequencer's `#deviceKey` (signature verification). Those are **separate queries with the same clause copied**,
not two calls to one predicate. By §92's classification they are redundant *mechanisms*, and each needs its own
pin.

I pinned one. Removing the clause from the sequencer alone left **all 745 api tests green.**

**And the unpinned half is the more serious one.** `deviceOwnedBy` gates the positions partition; `#deviceKey`
gates whether a device's **signature verifies**, which is what lets a signed event into the ledger. A future
edit could have re-opened exactly the §86 defect on the path that matters most, with nothing red.

Test added — *"a REVOKED device cannot sign an append — its key no longer resolves (REQ-254)"* — asserting the
refusal **and** zero events on the stream. Mutation-proved: removing only the sequencer clause now turns it
red, and removing only the positions clause turns §86's case red. Each mechanism pinned by its own case.

### 93.1 This is the fix-the-instance-not-the-class pattern, in my own work, twice removed

§55 recorded a correction applied to one of three citation sites. §61 corrected `CLAUDE.md` and left
`genesis/11`. Now §86 fixed both readers but pinned one. The repo has a memory note named for this
(`enumerate-callers-dont-generalize-the-fix`), and it still happened — because the *fix* enumerated both call
sites correctly while the *coverage* did not follow it.

That is the sharpened form worth keeping: **when a fix touches N call sites, the question is not "did I fix all
N" but "does each of the N fail independently."** The first is easy to satisfy by copy-paste; only the second
survives the next edit. §92's one-edit test is how to tell them apart, and it should be run against one's own
patch, not only against the code one is auditing.

**Verification.** `sequencer.test.ts` 27/27; the sequencer-only mutation proved RED; `sequencer.ts` restored
byte-identical; fixture appends rather than replaces (§86.4's rule), full suite re-run.

---

## §94 — enumerating ALL five `revoked_ts` sites, because §93 proved two was the wrong number

§93 fixed the coverage on the *second* revocation reader after §86 pinned only the first. The obvious next
move, and the one §93's own lesson demands, is to stop guessing how many sites there are and count them.

**There are five, not two.** A repeated-fragment scan across `workers/*/src` and `packages/*/src` found
`revoked_ts` in five places:

| Site | Purpose | Verdict |
|---|---|---|
| `gate-context.ts` `deviceOwnedBy` | positions write gate | **Pinned** (§86) |
| `sequencer.ts` `#deviceKey` | signature verification | **Pinned** (§93) |
| `devices.ts` uniqueness query | a device registered to *another* driver blocks re-claim | **Was unpinned** — fixed here |
| `devices.ts` active-list filter | `GET /v1/devices` | **Pinned** |
| `devices.ts` revoke handler | finds the ACTIVE entry to stamp | **Unpinned, benign** — see below |

Each was tested by removing its clause alone and running the devices suite. That is §93's rule applied
properly: not "did I fix all of them" but **"does each fail independently."**

### 94.1 The third site encoded a real product rule that nothing asserted

The uniqueness query's `revoked_ts IS NULL` is what scopes the 409 to **active** registrations. Without it, a
revoked device is permanently unclaimable — an off-boarded driver's handset could never be issued to the next
driver. Fail-**closed**, so not a security defect, but a real behaviour with a real operational cost, and the
suite had only the positive 409 case.

Test added — *"a REVOKED device CAN be claimed by another driver — the 409 is scoped to ACTIVE
registrations"* — and mutation-proved: removing that clause now turns it red.

### 94.2 The fifth site is unpinned and left that way, deliberately

The revoke handler's `&& e.revoked_ts == null` selects the *active* entry to stamp. Without it, re-revoking an
already-revoked device re-stamps its timestamp instead of 404ing — idempotent, invisible, and harmless. Adding
a test for it would be coverage theatre: it pins no rule anyone relies on.

**Recording the decision rather than silently skipping it.** "Unpinned" has now meant four different things
across this audit — a real hole (§84), an unreachable branch (§83), a downstream-masked guard (§84), and now a
behaviour too trivial to assert. Only the first is debt; conflating them would inflate the finding count and
bury the one that matters.

**Verification.** `devices.test.ts` 9/9; the uniqueness mutation proved RED; all five sites individually
mutated; `devices.ts` restored byte-identical.

---

## §95 — a state marker §89 missed, and a safety property that rested on statement order

§89 concluded the inactive-marker surface was "three things". It was four. Scanning for the *other* repeated
predicate fragment (`status = 'active'`) surfaced **`documents.retention_status`** — an `active`/`expired`
marker with five call sites that §89's enumeration never reached. My own §79 error, repeated: an enumeration
asserted rather than derived.

### 95.1 The unfiltered reader is safe, but not for the reason a guard would give

`routes/documents.ts` resolves a document id to its `r2_key` **without** filtering `retention_status`, so on
its face an expired document could be served. It cannot — because `sweepTenantExpiredDocuments` **deletes the
R2 bytes first and tombstones the row second.** An expired row's bytes never exist, so the resolve path takes
the graceful 404 the source anticipates.

**The safety is in the ordering, not in a guard.** Reverse those two statements and the torn state inverts
from *"row active, bytes gone"* (harmless, self-healing) to *"row expired, bytes present"* — and the resolve
path, which filters nothing, would serve them.

### 95.2 Nothing asserted the order

The existing case — *"an EXPIRED photo → bytes DELETED, row TOMBSTONED"* — asserts the **end state**, which is
identical under either ordering. Eleven retention tests, all thorough (7-year POD class, `UNKNOWN` class
failing safe, tenant-prefix scoping, idempotent re-sweep), and none could distinguish the two.

A case now does: it makes **only** the tombstone `UPDATE` fail, simulating a crash between the steps, and
asserts the sole acceptable torn state — bytes gone, row still `active` — then runs a second sweep against the
real database to prove the self-healing the source claims. Mutation-proved: swapping the two statements turns
**only** this case red; all eleven others stay green, which is exactly why it was needed.

### 95.3 The pattern

This is the third distinct thing this loop has found hiding behind an untested *implicit* property — after
§91's mutually-masking defences and §93's copied-clause coverage. The common thread: **the code was correct,
the reasoning was written down in a comment, and nothing executable held the reasoning to account.** A comment
that says "ordering is crash-safe" is a claim; the test that swaps the lines is the proof.

**Verification.** `packages/ledger/test/retention.test.ts` 12/12; the order-swap mutation proved RED on the
new case alone; `retention.ts` restored byte-identical.

---

## §96 — sweeping §95's class: ordering claims that nothing executes

§95's defect was a comment reasoning correctly about crash-safety with no test behind it. That is a class, so
the marker sweep ran across `workers/*/src` and `packages/*/src` for ordering/atomicity language
("crash-safe", "FIRST, THEN", "before the append", "atomically", "order matters").

Most hits are **atomicity** claims about the DO batch (`interline-split.ts`, `booking.ts`: *"runs atomically
with the event insert (I1)"*) — a property of the sequencer's batch, already pinned by the I1 suite, not
per-caller ordering. `spark-meter.ts`'s mutex and single-`storage.put` commit are likewise structural.

**One is genuinely §95's shape, at three call sites.** `concierge.ts` sets `sla_due_ts` **before** appending
`quote.requested`, and says why:

> If a crash lands between the `quote.requested` append and here, the redelivery guard returns
> `already_handled` — so setting the SLA before the append guarantees an owed inbound always carries its due ts.

Swapping the two statements at all three sites leaves **`workers/agents` 106/106 green.** The 106 tests never
exercise the concierge queue handler; the two files that mention it cover the SLA *sweep* and the spark meter.

**The consequence if the order ever reversed** is the fail-silent family this audit already has a name for
(C3, §74): a crash in that window leaves an owed customer inbound with **no due ts**, so it never surfaces in
the overdue sweep and is simply never answered — no error, no alarm, no queue entry.

### 96.1 Recorded, not fixed in place

Pinning it needs a concierge queue-handler harness that `workers/agents/test` does not have. Building one to
land a single case is a larger change than this section should make unilaterally, and §49's precedent applies:
work that wants a second pair of eyes gets recorded with the exact test to write, not improvised at the end of
a sweep.

The GO-LIVE row states the test (make the append fail, assert `sla_due_ts` is already set, then swap the order
and confirm red), the severity (**Med** — fail-silent, narrow window), and why it is deferred.

### 96.2 Two clean, one open

The class now stands at: **§95 retention ordering — found and pinned**; **atomicity claims — structural,
already covered**; **concierge SLA ordering — found, unpinned, recorded.** A comment that reasons about
ordering is a hypothesis about a crash nobody has staged. Two of the three had someone stage it; the third now
has a written recipe for doing so.

**Verification.** All four swap sites restored (`git status` clean for `workers/agents/src`); `workers/agents`
106/106 on the restored tree; tables and citations PASS.

---

## §97 — closing §96's deferral, which was based on a claim I had not checked

§96 recorded the concierge SLA-ordering gap as deferred, on the stated grounds that pinning it "needs a
concierge queue-handler harness `workers/agents/test` does not have." **That was asserted, not verified, and
it was wrong.**

`handleMessageReceived` is exported and fully dependency-injected (`db`, `seq`, `sender`, `parser`), the source
comments name the test doubles by class (*"RecordingSender in tests"*, *"Deterministic in tests"*), and
`workers/api/test/concierge.test.ts` has been calling it all along with a `depsWith()` factory, an
`appendInbound` seeder, an `inboundRecordedAt` reader, and a `slaRow` helper. Everything the test needed
already existed. I deferred work on the strength of an absence I never checked — the exact failure §72 named,
in the same section that swept for it.

**A second error rode along.** §96 concluded "unpinned" after running only `workers/agents` (106 tests) — but
the coverage for that file lives in `workers/api`. I ran the wrong suite and got the right answer by luck; the
correct suites (`concierge` + `sla-sweep`, 31 tests) also stay green under the swap, so the finding held.
Recorded because a conclusion that happens to be right for the wrong reason is not evidence, and §73 made
exactly this mistake with the isolation suite.

### 97.1 The test, and the branch it had to target

Staged as the crash the comment reasons about: a `seq` whose `append` always throws, then assert the inbound
already carries `sla_due_ts`.

My first draft used a clean quote email — which is **auto-answered** and never reaches the SLA branch, so it
asserted against the wrong path and failed for an unrelated reason. Retargeted at the below-floor anomaly
input, which takes the **queued** branch where the SLA-then-append pair is the first thing that runs.

Mutation-proved: swapping the two statements at all four sites turns **only** this case red — 23 of 24 stay
green, which is why the ordering needed its own case at all.

The GO-LIVE row is closed rather than carried.

**Verification.** `workers/api/test/concierge.test.ts` 24/24; the swap mutation proved RED on the new case
alone; `concierge.ts` restored byte-identical.

---

## §98 — phase gate re-measured at `96a131a`, with a full post-mutation integrity check

§88 stamped `4739965`. Ten sections later, and after roughly **thirty** source mutations applied and reverted
across this span, the first thing to establish is not a finding but **that the tree is what it should be.**

**Integrity of the working tree.** No mutation marker (`MUTATED`, `MUT-A`, `simulated crash`) survives in any
non-test source under `workers/*/src`, `packages/*/src`, or `tools/`. Every mutated file was restored and
diffed byte-identical at the time. The untracked set is the same seven paths present at session start, all
belonging to the concurrent GTM/launch-site workstream — nothing this loop produced leaked into the tree.

**1. Zero open repository-owned Critical/High — SATISFIED.** This span closed one live security defect
(§86, revoked devices retaining write access) and its unpinned sibling (§93), plus four coverage gaps
(§84 override authority, §91 cap layers, §94 re-claim, §95/§97 two ordering claims). The two open Highs remain
**External**.

**2. Baseline gates green — SATISFIED but for the one row that is not this loop's.** **17 workspaces, 2,888
tests, exit 0** (2,882 at §88 plus six added since). Root `tools/`: 715 with the same three register-parsing
failures. **All twelve** static gates PASS. `pnpm test:acceptance`: **GREEN, all 7 spine tests**.

**3. Remaining debt External or CONFIRM-gated — SATISFIED.** Two checklist rows **closed** this span
(§84's 403 sweep, §97's SLA ordering); one **added** (§87's fail-closed interline hold, operational only).

**4. The record agrees with the world — SATISFIED**, after five self-corrections this span alone.

### 98.1 The honest note on this span's error rate

Five of my own errors surfaced in ten sections: a fixture that replaced instead of appending (§86.4, broke ten
tests), a commit shipped with a failing typecheck (§88.1), a wrong-reason test I wrote one section after
documenting the pattern (§91.1), a deferral resting on an unchecked claim plus the wrong suite run (§97), and
a test aimed at the wrong code branch (§97.1).

**Every one was caught by executing something** — the full suite, the gate set, a mutation against my own new
test. None was caught by re-reading. That is the same result the audit reached about the codebase (§72: for an
enforcement claim the mutation is the evidence, not the grep), now demonstrated on the auditor.

It is also a rate worth naming rather than burying: the density of self-inflicted errors rose as the session
got longer, and each was found only because a mechanical check ran. **The value of this loop's verification
discipline is not that it makes the work error-free — it visibly did not — but that no error survived to a
conclusion.**

**The stopping line is unchanged and is reached again at `96a131a`.**

---

## §99 — the one unchecked DoD box in sixteen work packages, and the practice it preserved

A deliberately mechanical lens, chosen because §98 recorded that my error rate rose with session length:
**scan all sixteen WP documents for unchecked DoD boxes.** "All sixteen WPs are closed" is the build's headline
claim; an unchecked box under a closed WP is a contradiction a script can find.

**Exactly one, in WP-01:** *"Adversarial audit at WP-01 exit; findings → REQ rows/defects; no open Criticals at
close."* Every other box in every other WP doc is ticked.

### 99.1 It is not a gap in the work; it is a fossil of a practice that changed

Compared against its siblings rather than assumed:

- **WP-02** — box **checked**, with evidence: *"Adversarial audit at WP-02 exit (50-agent pattern) … no open
  Criticals at close."*
- **WP-03** — box **checked**: *"2 auditors: design-gate + map/lens. Findings: 4 Criticals + 6 Majors."*
- **WP-04 … WP-16** — **no `WP-exit audit swarm` section at all.**

So the per-WP swarm ran for WP-02 and WP-03, was never run under a WP-01 label, and was dropped as a *per-WP*
ritual thereafter. What replaced it is real and documented: three whole-codebase adversarial audits
(`2026-07-15` whole-codebase, `2026-07-22` launch gate, and this one at 99 sections). WP-01's own surface — the
CI chain, traceability gates, isolation suite, fixture hash law — has been audited by them repeatedly, most
recently at §63, §69, §73 and §83–§84.

**The DoD item is satisfied. What was never true is its per-WP framing**, and `CLAUDE.md` rule 9 still says
"at every WP exit."

### 99.2 Why the box was resolved with a paragraph instead of a tick

A bare `[x]` would have closed the contradiction and **hidden** the more interesting fact: that thirteen work
packages closed without the section the first three carried, and nothing recorded the change. That is §64's
class — a document asserting a practice the build stopped following — and the fix for it is never a checkmark.

The box now carries its own history: which swarms ran, which did not, what superseded them, and where WP-01's
surface has actually been audited since. A future reader asking "was rule 9 followed?" gets the real answer —
*not per-WP after WP-03, and here is what happened instead* — rather than sixteen ticks implying sixteen
swarms.

**Left for the owner:** whether `CLAUDE.md` rule 9's "every WP exit" should be amended to describe the periodic
whole-codebase practice, or whether per-WP swarms should resume. That is a change to a stated law, which needs
a signature this loop does not have.

**Verification.** Unchecked DoD boxes across all sixteen WP docs: **0**; WP-02/WP-03 sections read for
comparison; the three superseding audits confirmed present in `docs/audits/`; citations and tables PASS.

---

## §100 — every REQ row a work package proposed reached the register

Second mechanical lens, same family as §99: the WP documents each carry a **"New REQ rows proposed"** section —
scope discovered *during* the work. `CLAUDE.md` is emphatic that discovery must land as a row before it is
built (*"if you discover scope, ADD A ROW first"*), so a proposed row that never reached
`genesis/09` would be scope discovered and lost.

**Eight rows were proposed across the sixteen documents. All eight are in the register:**

| Proposed in | Rows |
|---|---|
| WP-05 | REQ-168 (evidence photos device-signed at capture) |
| WP-06 | REQ-170 (Biller surfaces a POD whose evidence hash has no match) |
| WP-07 | REQ-171 (corroboration must cover EVERY price-affecting field or fail closed) |
| WP-08 | REQ-181 (`booking.created` party-correction projection) |
| WP-09 | REQ-187 / 188 / 189 (status capability, lens-scoped mint, anonymous coarse geo) |
| WP-10 | REQ-194 (`approval.decided` authorized against the matrix `required_role`) |

WP-01, WP-03 and WP-04 record *"none — no scope discovered outside the register"*, which is a positive
statement rather than an omission. WP-11 states its 14 scope rows pre-existed the build.

### 100.1 The same section-drop as §99, and why it is not a second finding

**WP-02 and WP-12…WP-16 have no such section.** That is the identical pattern §99 found for the exit-audit
swarm: a structural section the early WP documents carried and the later ones dropped, with nothing recording
the change.

It matters less here, because the *substantive* guarantee is gated rather than documentary:
`check:traceability` reports **no orphans in either direction** across all sixteen active WPs, so every
register row maps to a WP and every WP's work maps to rows — including the 75 post-REQ-194 rows added under
the approved V1/V2 framework. A missing prose section cannot hide scope while that gate is green; it can only
make the *discovery story* harder to reconstruct.

So this is **one finding, not two**: the WP-document template decayed after the early packages, and §99's
owner item already covers it. Recording it here as a second instance strengthens that item rather than opening
a new one — the distinction §94 drew about not inflating a count.

**Verdict: clean negative** on the substance. Every proposed row exists; traceability has no orphans either
way.

**Verification.** All eight proposed rows grepped against `genesis/09` by id; `check:traceability` green;
post-194 rows counted by WP.

---

## §101 — three mechanical integrity checks, and a grep that failed rather than found nothing

Continuing §99/§100's deliberately mechanical footing. Three checks a script can settle, chosen because each
would silently reduce what the build actually verifies.

**1. Migration numbering — contiguous.** `db/tenant/migrations/` runs `0001`…`0008` and
`db/control/migrations/` runs `0001`…`0003`, with no gaps and no duplicate prefixes. A gap would suggest a
migration removed after others were numbered past it; a duplicate would mean one silently shadowing another
depending on sort order. Neither exists.

**2. No exclusive or disabled tests.** No `it.only`, `describe.only`, `test.only`, `.skip`, `xit` or
`xdescribe` in any test file across `workers`, `packages`, `apps` and `tools`. This is the check worth running
after a session with thirty mutations: a stray `.only` left behind would silently reduce a whole file to one
case **while the suite still reports green**, which is the exact shape of defect this audit spent §84–§97
hunting in the code.

**3. Per-kind map consistency — type-enforced, not checkable by script.** `REDACTIONS` and `INTERNAL_NESTED`
are `Partial<Record<EventKind, …>>`, so an invalid or renamed kind is a compile error rather than a runtime
gap. `typecheck` already owns it; a bespoke script would duplicate the compiler.

### 101.1 The ninth near-miss, and a new variant of it

The `.only` check first ran with `grep --include=*.test.ts`, which **zsh rejected outright** — and I printed
`(none above = no disabled or exclusive tests)` beneath a command that had *errored*, not searched.

That is a new variant of the loop's most persistent mistake. The previous eight were empty results from
searches that ran; this was an empty result from a search that **never ran at all**, dressed in the same
reassuring echo. §72's rule needs the addition: *a null result is only evidence if the command succeeded* —
check the exit status, not just the output.

Re-run correctly, the answer was still clean, and the two apparent hits were a coincidental substring inside
a minified bundle under `apps/portal/dist/` — a build artifact, not a test.

**Verdict: three clean negatives**, and the ninth reminder that the shape of my errors has not changed all
session: every one has been a claim about absence, and every one was caught by running something properly
rather than reading more carefully.

---

## §102 — the agent-idempotency doctrine, and a KNOWN GAP whose safety net is a different sweep than its comment implies

`make-agent-idempotent-and-adapter-ported` states the rule Cloudflare Queues forces: delivery is
**at-least-once**, so "twice in → once out" must be layered — deterministic ids, `INSERT OR IGNORE` on every
read-model row, a committed-terminal-event guard, and sender dedupe by idempotency key. By §92's test these are
**independent mechanisms**, so each needs its own pin.

**Layer 3 — the redelivery fast-path — is pinned four times over.** Disabling it turns four tests red,
including the one that states the doctrine outright: *"IDEMPOTENCY (auto-reply): the same message twice → ONE
shipment, ONE quote.requested, ONE reply"*, plus both send-failure cases (retriable self-heals, permanent
holds with facts standing).

### 102.1 The KNOWN GAP beside it, and where its net actually is

The same guard carries an honest note: if a **fresh** auto-reply dies *after* appending `quote.requested` but
*before* `message.sent`, the redelivery guard also returns `already_handled`, so that reply never completes.
It then claims: *"The sweep detects it structurally (quote.priced present, message.sent absent, no draft row
⇒ an unfinished auto-reply) and re-drives it."*

Chased, because a mitigation named in a comment is exactly §95's class. Two corrections:

1. **It is not the recon sweep.** `recon-sweep.ts` is the *Biller* reconciliation (REQ-169) — committed
   `pod.signed` with no invoice, re-enqueuing the billing trigger. It has no concept of replies. The comment
   invites that reading by saying "same class as REQ-169's Biller commit→enqueue window".
2. **The net is the SLA sweep**, which finds inbounds past their due with **no answering `message.sent`** and
   **appends an internal overdue signal** through the sequencer. Detection is real. But it **signals; it does
   not re-drive** — the comment's "and re-drives it" overstates what happens. A human works the overdue queue.

**And §97 is load-bearing for exactly this.** The SLA sweep can only find that inbound because `sla_due_ts` is
written *before* the append — the ordering §97 pinned two sections ago after §96 found it unpinned. Had that
ordering ever silently reversed, the dead auto-reply would carry no due ts, the SLA sweep would never see it,
and the documented safety net for this known gap would have been quietly disconnected.

That is the most consequential thing this section found: **two documented properties that only work together**,
recorded in different files, with no cross-reference — and until §97, one of them untested.

**Verdict: clean on the code, one wording correction owed.** The comment's "re-drives it" should read
"surfaces it as an overdue signal for a human". Left as a recorded finding rather than an edit to a file this
section did not otherwise touch — the §49 discipline.

**Verification.** Fast-path mutation proved RED on four tests; `concierge.ts` restored byte-identical; all four
sweeps read for the claimed pattern (a first attempt used a glob that matched nothing and errored — §101's
mistake, caught in the same turn and re-run explicitly).

---

## §103 — making the coupling visible, because a comment that names the wrong net is worse than none

§102 found two things and fixed neither, deferring both as "recorded findings". One of them does not deserve
deferral: a comment in `concierge.ts` named the **wrong sweep** as the safety net for a known gap, and the
right one depends on an ordering in a third file that nothing cross-referenced.

Deferring a *wording* correction is reasonable when the wording is merely imprecise. This one actively
misdirects: an engineer reading "the [WP-11 reconciliation] sweep detects it and re-drives it" would go to
`recon-sweep.ts`, find the Biller anti-join, see nothing about replies, and conclude either that the comment
is stale or that the gap is unhandled. Both conclusions are wrong, and the second is the dangerous one — it
invites someone to "fix" a gap that already has a net, or to remove the net's precondition believing nothing
depends on it.

**Both files now carry the coupling.**

`concierge.ts`'s KNOWN GAP states the correction plainly — `recon-sweep.ts` is the Biller reconciliation and
will never see this; the real net is `sla-sweep.ts`, which **surfaces** the stranded reply for a human rather
than re-driving it — and then names the dependency: *that net only works because `setInboundSla` runs BEFORE
the appends*, with the §97 test that pins it.

`sla-sweep.ts` carries the reciprocal: it is the **only** backstop for that gap, and reordering the SLA write
in `concierge.ts` disconnects it **without failing anything obvious**.

### 103.1 Why the reciprocal half matters more than the first

The forward reference helps whoever reads the gap. The reciprocal helps whoever is about to break it — someone
editing `concierge.ts`'s ordering has no reason to open `sla-sweep.ts`, and until §97 no test would have
stopped them. That is the same asymmetry §68 found in the acceptance manifest (the reverse direction is the
one that catches coverage silently disappearing) and §84 found in refusal tests.

A cross-reference is not documentation for its own sake here: it is the only thing standing between a
plausible refactor and a silently unanswered customer email.

**Verification.** `workers/agents` suite green; `workers/api/test/concierge.test.ts` 24/24; typecheck, lint,
citations and tables PASS.

---

## §104 — the same asymmetry §103 fixed, in the coupling §95 found

§103 established that a cross-file coupling needs the **reciprocal** reference more than the forward one:
whoever reads the gap is already thinking about it; whoever is about to break it has no reason to open the
other file. §95's retention finding is the identical shape, and I left it half-referenced.

**The coupling.** `routes/documents.ts` resolves a document id to its `r2_key` **without** filtering
`retention_status`. That is safe only because the retention sweep deletes R2 bytes **before** tombstoning the
row, so an expired row's bytes never exist and the byte fetch takes a graceful 404.

**The asymmetry.** `retention.ts` already carried the forward reference — *"exactly the graceful miss the /pub
bytes proxy already 404s on (routes/documents.ts)"*. `documents.ts` said **nothing** about retention at all.

So the file whose behaviour the design *depends on* was the one with no idea it was load-bearing. An editor
there — adding a cache, changing a missing object from a clean miss to a 500, or "helpfully" serving a stale
copy — would have had no signal that a privacy property rode on it.

`documents.ts` now states it: the omitted filter is deliberate, the ordering is what makes it safe, the torn
state a reversal produces is *"row expired, bytes present — which THIS query would happily serve"*, and the
test that pins it is named. Ending with the instruction that matters: *if you ever make a missing object
anything other than a clean miss here, read that test first.*

### 104.1 Three couplings, one pattern

| Coupling | Forward ref | Reciprocal | Status |
|---|---|---|---|
| concierge SLA ordering ↔ sla-sweep backstop | absent (named the wrong sweep) | absent | **both added, §103** |
| retention delete-order ↔ documents resolve | present | **absent** | **added, §104** |
| `deviceOwnedBy` ↔ sequencer `#deviceKey` | present (each names the other) | present | already correct (§86/§93) |

The device pair was written correctly from the start — each query's comment names its sibling. That is the
standard the other two now meet, and it cost its author one sentence at the time.

**Verification.** `documents.test.ts` 12/12; typecheck, lint, citations and tables PASS.

---

## §105 — the dependency-claim sweep, and the phase gate re-measured at `0a5b3c3`

**The sweep.** §103/§104 fixed three couplings by hand; the mechanical follow-up is to find the rest by their
own words. Scanning `workers/*/src` and `packages/*/src` for asserted dependencies ("only works because",
"relies on", "depends on", "assumes that") returns twelve hits, and the shape of them is reassuring: most are
**negative** claims of independence — *"the required loader never depends on it"*, *"no event's durability
depends on the actor party"*, *"the only package that depends on zod"* — which are the opposite of a hidden
coupling. Two are the ones §103/§104 just wrote.

**One is a real cross-file coupling:** `sequencer.ts` warns that a change to its error text would *"break the
`CODE:json` split Task 14 relies on"* — the DO emits `CODE:{json}` and `translateAppendError` in the events
route parses it back into an envelope. Mutation-tested by changing the separator from `:` to `|`: a test does
turn red (*"a malformed (blank) override is a clean 400 VALIDATION_FAILED, not a silent pass"*), so the format
is pinned — but by **one** case out of 26 in the two files most likely to catch it. Thinly held, and held.

Not raised as a defect: the coupling is documented on the producing side, the consumer is one function, and a
break is loud rather than silent (a mis-split yields a 500, not a wrong answer). Recorded so the thinness is
known.

### 105.1 Phase gate at `0a5b3c3`

§98 stamped `96a131a`. Seven sections later:

1. **Zero open repository-owned Critical/High — SATISFIED.** §99–§104 opened no code defects: one stale DoD
   box resolved with its history, two clean negatives on WP records, three mechanical integrity checks, and
   three cross-file couplings documented (two of which were genuinely one-sided).
2. **Baseline gates green — SATISFIED but for the one row that is not this loop's.** **17 workspaces, 2,888
   tests, exit 0**; `tools/` 715 with the same three `REQ-289` failures; **all twelve** static gates PASS.
3. **Remaining debt External or CONFIRM-gated — SATISFIED**, plus one new owner item (§99: `CLAUDE.md` rule 9
   says "every WP exit" while the practice became periodic whole-codebase audits).
4. **The record agrees with the world — SATISFIED.**

**The stopping line is unchanged and is reached again at `0a5b3c3`.**

---

## §106 — external-routing containment, already enforced by a lint added earlier in this same audit

`gate-external-routing-server-side` states one rule: an external routing estimate is *"operational hint, never
truth"* — it may inform a suggestion, but **it can never become the sold transit window.** That window is
`resolveTransitDays` (REQ-059), a config lookup.

**Enforced at three levels, only one of which is a test:**

1. **By construction.** `packages/rater/src/transit.ts` is pure and deterministic — its header says
   *"no LLM/I/O/Date/random"* — resolving both zips through the freight engine's own `matchZone` and reading
   `days[originZone][destZone]`. There is no seam for an estimate to enter.
2. **By lint.** A routing call means a network call, and `packages/rater` is **network-free by eslint** — the
   `fetch` ban added in **§53** of this audit. The skill's core rule is therefore statically enforced by a
   guard written for a different reason (REQ-024/004, keeping the rater deterministic). Two laws, one
   mechanism; neither author knew about the other.
3. **By test, for the half that can go wrong quietly.** The honest-window law says an unresolvable lane returns
   UNKNOWN and *"must NEVER coerce UNKNOWN to a number"*. Three cases pin it — unlisted lane with no default,
   dest zip resolving to no zone, origin zip resolving to no zone — and the consuming path honours it:
   `compose.ts` returns `queued` on an UNKNOWN price rather than inventing one (REQ-004, "no price on air").

**No routing adapter exists yet.** The `mapbox` hits in the tree are map rendering and type definitions; the
Matrix/Isochrone/Optimization uses the skill anticipates are vNEXT. So most of this skill is forward-looking
guidance, and the part that is live is closed.

### 106.1 The observation worth keeping

§53 added the rater's `fetch` ban to enforce REQ-004/REQ-024 — a deterministic engine must not depend on a
network call, and an LLM must not price. It turns out to also enforce REQ-059's separate law that a routing
estimate cannot become a sold window, because both reduce to *the rater cannot reach the network*.

That is the opposite of the coupling problem §103/§104 spent two sections on. There, two properties depended on
each other with nothing recording it. Here, one mechanism satisfies two independent laws — and that is
**robust** rather than fragile, because the mechanism is a static lint that fails loudly and is itself
mutation-proved (§53). Worth noting that the difference is not "coupling good or bad" but **whether the
dependency is enforced or merely true.**

**Verdict: clean negative.** Ninth skill mutation-tested or verified; the live half of the rule is enforced
three ways.

---

## §107 — the gate-sentinel reconciliation, and the same bug I wrote in §83

`reconcile-gate-sentinels-with-exit-codes` records a defect with the worst possible blast radius: `run-gate.ts`
once preferred the **last `##SHUDDL-GATE##` sentinel** found anywhere in combined output over the child's exit
code. Wrapper gates relay nested output, so a nested child's `PASS` printed before the wrapper failed recorded
**PASS — a false green in the one artifact promotion reads.**

**Closed and well-pinned.** `reconcileSentinel` makes the exit code win, and disabling it turns **three** tests
red — one per disagreement:

- `exit 1 + PASS → FAIL`, with the disagreement named in `detail`;
- `exit 2 + PASS → BLOCKED` (exit 2 is a prerequisite hold, not a failure);
- `null exit + PASS → FAIL` — *"a killed/timed-out child proves nothing"*, the case most harnesses forget.

### 107.1 I wrote the same bug in this audit, in §83

My per-guard mutation harness piped `vitest` to `tail`, so `execSync` saw **tail's** exit code — always 0 —
never threw, and scored every guard "unpinned". Aimed at an unaudited route first it would have produced a
clean sweep of guards it never tested. I caught it only by validating against guards §81 had already proved
pinned.

That is *precisely* this skill's RED: **a PASS recorded for a command that exited non-zero.** The repository
learned the lesson, encoded the fix, and wrote three tests for it. I then made the identical mistake in a
throwaway script — because I treated my own tooling as outside the standard the codebase holds itself to.

The skill's own "When to Use" would have caught it: *"Writing or reviewing anything that parses gate output."*
A ten-line harness that decides whether a security guard is tested is exactly that, and it deserved the same
scrutiny as `run-gate.ts`.

**The generalisable form:** audit tooling is production code for the duration of the audit. Its false
negatives do not fail loudly — they arrive as reassuring green tables, which is the same failure mode this
whole section is about.

**Verdict: clean negative** on the repository; the finding is about how I used it. Tenth skill verified;
`run-gate.ts` restored byte-identical.

---

## §108 — the anonymous quote surface: a positive allowlist, which is the shape C1 lacked

`redact-counterparty-payloads-completely` has three triggers; §51 covered the event-kind and nested-field
halves. The third is unswept: *"a route handler returning one response shape to every role."*

**Three routes do no role or lens handling at all** — `internal-platform.ts`, `public.ts`, `signup.ts`. Each is
correct: the first is the server-to-server credit seam behind `PLATFORM_INTERNAL_SECRET` (§57), and the other
two are **anonymous** surfaces with no session to shape a response for.

That makes `/pub/quote` the sharpest case in the repo: it returns a **price to an unauthenticated caller**, and
C1 — the loop's first Critical — was `POST /v1/rate` handing the *portal* role the tenant's margin floors,
pinned config versions and approval internals.

**It is built the opposite way to C1, and that is the finding.** The guest response is a **positive allowlist**:
a `.strict()` schema of exactly `{status, sell_cents, lines?, transit}`, with the source naming what is
excluded *forever* — floors, basis, versions, approval, anomaly — and each `PriceLine` re-mapped to
`kind/code/amount_cents` so it is margin-free by construction. C1 leaked because a spread carried everything
not explicitly removed; this cannot, because nothing is carried that is not explicitly named.

**And the allowlist is pinned two ways.** `pub-quote.test.ts` asserts every top-level key is in `ALLOWED_KEYS`
(a set membership, not a substring), *and* that each margin key appears **"not as a key, not as a byte anywhere
in the body"** — a serialized-text check that would catch a leak nested inside `lines` or `transit`, which a
key-set assertion alone would miss.

That byte-level assertion is the same instinct as §70's known-answer vectors: when the failure mode is "a value
travels somewhere nobody looks", assert against the bytes, not the shape.

**Verdict: clean negative**, and the redaction skill's third trigger is now covered. Eleventh skill verified;
no code changed.

---

## §109 — two ops documents disagreeing about whether a launch-blocking question was answered

`keep-ops-record-reconciled-with-deploys` exists because of D1–D5: prod was provisioned and deployed while
`PROJECT-STATE.md` still told readers *"there is no live production"*. Its rule — sweep the ops record after
any deploy, and treat **under-warning** as the dangerous direction — was tested against today's tree.

**The under-warning drift is gone.** Every surviving "not provisioned / does not exist / all-zero placeholder"
string is either struck through with a dated supersession, a **genuinely open** hold (the legacy-TMS mirror
feed, per-IP edge rate limits), or prose *about* the failure mode rather than a claim of state.

*(A note on method: my first sweep filtered lines containing `~~`, and flagged the all-zero-placeholder claim
as surviving. It is struck — but the strikethrough **spans several lines**, so a line-based filter cannot see
it. Twelfth near-miss this loop, caught by opening the file.)*

**But the two documents disagree in the other direction.** `LAUNCH-RUNBOOK.md` still read:

> `PROJECT-STATE.md` claims a deployed, live-sending staging environment; that claim now carries a dated
> warning because it could not be confirmed. **Resolve this before Step 1.**

`PROJECT-STATE.md` resolved exactly that on **2026-07-31**: *"RESOLVED — it is confirmed. The first reading was
right — a second account."* So an operator opening the runbook — the document you read when you are about to
launch — was told to stop and resolve a question answered two days earlier.

This is **over**-warning, the safer direction, and still a defect: a runbook that halts on a resolved question
trains its reader to skip its warnings, which is precisely how the under-warning drift of D1–D5 would slip
past next time. The value of a launch gate is that every stop in it is real.

Reconciled in place — strikethrough plus the dated resolution and its evidence (prod provisioned 2026-07-30,
preflight **PASS 72 checks** 2026-07-31) — never deleted, per the skill's own rule.

**One thing preserved deliberately.** The step still says *"resolve the ACCOUNT TARGET before Step 1"*, because
the resolution answers *where the environment is*, not *which account this workstation is pointed at* — and
provisioning the freight ledger into the marketing account remains, in the runbook's words, "the one step in
this runbook that is expensive to undo." Narrowing a warning is not the same as removing it.

**Verification.** Every ops-doc state claim re-read in context; tables and citations PASS.

---

## §110 — a stale count §67's own sweep could not see, because of a hyphen

§109 checked the ops record for *state* drift. This checks it for **count** drift — §64's class — and finds
one, plus a flaw in the sweep that was supposed to have found it.

**First, the internal contradiction the skill named is closed.** `DEPLOYMENT.md`'s header once said "evidence
sending OFF" while its own Sending section said LIVE. The header now reads *"Sending status — LIVE on staging
(2026-07-14)"*. Consistent.

**The stale count.** Its environments line read *"`dev` = the default wrangler config, used by the
**1,131-test suite**"*. The real figure today is ~3,603 (2,888 across 17 workspaces + 715 in `tools/`) — the
claim was short by a factor of three, undated, and presented as current.

Replaced with *"used by the unit/integration suites"* — a **durable description** rather than a fresher
number. §64's first disposition: where an authority exists (the suites themselves), point at the thing rather
than restating a value that decays. A corrected count would have been wrong again within the week; this
sentence never will be.

### 110.1 Why §67 reported a clean negative here

§67 swept all nine ops documents for unscoped counts and recorded `DEPLOYMENT.md — 0`. Its pattern was
`\b(\d{1,4}) (tests|gates|checks|files|…)\b` — a **space** between number and noun. This claim is
`1,131-test suite`: hyphenated, and singular. The sweep could not see it.

Re-run with the hyphenated form included, the ops corpus yields 40 candidates — and every one *except* this is
a false positive of a kind already understood: the fixture id `rater-48-tests`, counts under dated table
headers (§67's finding), or values quoted **inside** a superseded annotation (`PROJECT-STATE`'s "21 gates",
which is §66's own correction explaining what the sentence used to say).

So the corrected tally is: **one real stale count in nine ops documents**, not zero. §67's conclusion was right
in spirit and wrong in fact, and it was wrong for the most ordinary reason available — a regex that encoded
one spelling of a thing that has two.

That is the thirteenth instance this loop of an absence claim failing, and the first where the flawed
instrument was **another section of this same audit**. §67 even argued that the laws-vs-observations rule
should stay a rule for authors rather than becoming a checker, on the grounds that a checker would be noisy.
It would also, as this shows, have been **incomplete** — which is the better argument for the same
conclusion.

**Verification.** `DEPLOYMENT.md` header/section consistency re-read; the replaced sentence carries no count;
all 40 hyphenated-form candidates classified; tables and citations PASS.

---

## §111 — the pixel law, mutation-proved (REQ-158 / CLAUDE.md rule 7)

Rule 7 is one of the ten non-negotiables, and it is the only one whose enforcement **changes over time**:
design CI is *"advisory (report-only) until WP-10 exits, blocking thereafter (REQ-158)"*. All sixteen WPs are
closed, so it must now block. Nothing in the record had ever checked that the flip happened, and nothing had
ever checked the gate could fail.

**The flip is real, on both halves.** `tools/design/design-ci.json` = `{"mode":"blocking"}`, and `design-audit`
sits in the **non-skippable** list in `gatesFor()` — so a violation exits 1 (`audit.ts:296`) and the runner
propagates it. `tools/release/ci-contract.test.ts:74` independently pins the CI job name against ever
regressing to `design-advisory`.

**The gate is substantive — twelve rules, each proved to fail alone.** Baseline clean (exit 0, 346 tracked
files scanned). Injecting one violation at a time into `apps/command/src/App.tsx`, restoring byte-identically
after each:

| probe | verdict | REQ |
|---|---|---|
| `boxShadow` / `box-shadow` / `text-shadow` | RED | 147 |
| `borderRadius: 12px` | RED | 147 |
| linear- and radial-gradient | RED | 145 |
| blue `#1e90ff` · gray `#888888` · 6th token `#ff00ff` | RED | 145 |
| third font family | RED | 146 |
| spring/overshoot cubic-bezier | RED | 148 |

### 111.1 Three of the first eight passed for the WRONG REASON

The shadow and gradient probes initially came back RED reporting *"color #000 outside the five tokens
(REQ-145)"* — the **color** rule firing on the raw hex inside my declaration, not the shadow or gradient rule.
Had I stopped at the exit code, I would have recorded "shadows are enforced" on evidence that showed only that
hex literals are.

Re-probed with **sanctioned `var(--token)` values only**, which the color rule cannot flag. All four then
returned exactly **one** violation naming its own rule. That is §81's discipline (when guards share an
outcome, assert the *reason*) applied to a mutation rather than a test, and §92's (redundant *mechanisms* need
one pin each) — a green exit code is a shared outcome like any status code.

### 111.2 The harness lied first, and it lied the same way as §101

The first run reported **8/8 GREEN — NOT CAUGHT** and I nearly wrote *"the design gate is hollow."* It was the
harness: `ls apps/command/src/*.css` matched nothing (all `apps/**` CSS is build output), zsh aborted, the
target variable was empty, and **no mutation was ever written** — so the audit correctly passed a clean tree
eight times.

Third and fourth instance of §101's shape in this loop, and the second near-miss of §73's exact kind (that one
nearly published *"the isolation suite is hollow — 63 tests passed"*). The rule earns a sharper edge:

> **A mutation that produces no diff proves nothing.** Assert the file changed before believing the verdict —
> a GREEN from an unmutated tree is indistinguishable from a hollow gate, and it is the more likely of the two.

### 111.3 Two clean negatives measured in passing

- **Untracked build output cannot reach the gate.** `scannedFiles()` enumerates via `git ls-files` *and*
  filters `/dist/` — belt and braces. The `apps/*/dist/` CSS is `.gitignore`d at line 2.
- **iCloud duplicates: zero tracked.** The standing hazard (`"name 2.ext"` copies corrupting file-count gates)
  found 5 `.css` duplicates under `apps/*/dist/` — all untracked, all invisible to every gate. `git ls-files`
  matching the ` N.ext` pattern returns **0**.

---

## §112 — the eight status-drift rows, adjudicated

`check:coverage` emits a warning nobody had ever discharged:

> *8 status-drift row(s) — a source citation exists while the register tag reads \*-DISCOVERED/vNEXT. Per row,
> VERIFY whether the citation is an implementation or a deferral marker before advancing anything.*

That is a real question with a real answer per row, and it is the exact failure mode this loop keeps finding:
a citation that *looks* like proof of work but might be a note saying "not done." Six rows already carried
recorded verdicts. Two — REQ-170 and REQ-184 — were absent from the manifest entirely, and one of the six had
decayed.

### 112.1 The two unadjudicated rows land on opposite verdicts

| row | citations are | verdict |
|---|---|---|
| REQ-170 | **implementations** | BUILT, with a named residual |
| REQ-184 | **deferral markers** | correctly UNBUILT, fail-closed |

**REQ-170** — the Biller genuinely refuses to send a proof email without stored POD bytes: an ACTIVE
tenant-scoped evidence document must resolve for the recorded `signature_hash`, or it `HOLDS(evidence_missing)`
with no invoice and no terminal marker; the upload route re-drives it; `recon-sweep.ts` backstops a stranded
hold. Three separate suites pin it. The residual recorded in `transition-gates.ts` (placed-photo hash and
redelivery fast path not byte-verified) is unchanged and keeps the row's tag.

**REQ-184** — every citation says, in terms, that it is *not* built. `do/sequencer.ts` records that nothing
writes a `ratecon` document yet, *"so this gate is FAIL-CLOSED"*, and the two heartbeat suites **seed** a
ratecon precisely because generation is deferred. The deferral carries no exposure: absent generation, the
REQ-043 dispatch gate refuses dispatch without paperwork rather than waving it through. That is the shape a
deferral should have, and it is worth naming as a positive finding — most of this loop's defects were
deferrals that failed *open*.

### 112.2 A recorded verdict decayed within two days

REQ-254's note read *"not built"* — accurate on 2026-08-01, wrong by 2026-08-03, because **§86 and §93 built
part of it**. Its DoD has four clauses; three now ship and are pinned:

- cross-driver enrollment rejects (409, scoped to ACTIVE registrations — `devices.test.ts`)
- a REVOKED key cannot append (§86's `revoked_ts IS NULL` on *both* readers — `positions-gate.test.ts`,
  `sequencer.test.ts`)
- an ACTIVE bound key can

The fourth, **lockout**, is unbuilt — no failed-attempt mechanism exists in any worker (verified negative, and
verified with a *quoted* grep, per §111.2). The row stays `vNEXT` for that remainder.

This is §64's class landing on the audit's own instrument: the manifest exists to stop the register from
stating stale observations, and the manifest stated one. Two days of decay, caused by my own work.

**Register status is untouched throughout.** Adjudicating a citation is recording what is true; advancing a
row is scope, and scope is owner-signed. All eight rows keep their tags.

### 112.3 The zsh glob hazard, now six instances

Locating the manifest, I ran `ls tools/checks/coverage-manifest*` — no match, zsh aborted, the path variable
went empty, and the probe reported **all eight rows unadjudicated**. Six of them had notes. This is the same
failure as §101, §102 and §111.2, and it happened *minutes after* I wrote the rule into memory.

The lesson is no longer "be careful." Six repetitions under active attention is evidence the discipline does
not hold:

> **In an audit probe, never let a shell glob resolve a path.** Use `find`/`git ls-files` and assert the
> result is non-empty before using it. Quote `--include='*.ts'` — unquoted, zsh expands it and kills the
> whole command, so the empty output reads exactly like a clean negative.

---

## §113 — the stopping point, re-measured at `99ae4ca`

Measured against §4's four exit conditions, one by one. Every figure below comes from a run at this commit.

**1. Zero open repository-owned Critical/High — SATISFIED.** Unchanged from §105: C3 closed in all four
workers; the one named pre-R4 carry-forward remains resolve-path pool-binding exclusivity (a Med, dark behind
`PROVISIONING_ENABLED`, fixed by a control-plane UNIQUE index). The two open Highs are still **External**:
driver custody handoff (needs the deferred REQ-069 identity seam) and the live EDI adapter (needs transport
credentials). Neither is closable from inside the repo without straying.

**2. Baseline gates green — SATISFIED for everything this repo owns.**

| surface | result |
|---|---|
| eleven static gates (runtime, invariants, rater-purity, chokepoint, authority-coverage, traceability, seed, citations, table-shape, design-audit) | **PASS** |
| `check:coverage` | **FAIL — REQ-289 only** (see below) |
| workspace suite (`pnpm -r test`) | **17 workspaces · 246 files · 2,888 tests · 0 failures · exit 0** |
| root `tools/` suite | **715 tests, 712 passing** — the 3 failures are REQ-289 |
| design gate | PASS, and **proved able to fail** — 12 rules, each RED alone (§111) |

**3. Remaining debt entirely External or CONFIRM-gated — SATISFIED**, unchanged: five private-fixture holds,
two no-gate holds (on-call rota, 7-year archive), the two External Highs, R2–R5 owner grades.

**4. The record agrees with the world — SATISFIED at this commit.** §109 reconciled the last two ops documents
that disagreed; §110 removed the last stale count from `DEPLOYMENT.md`; §112 gave all eight status-drift rows
a recorded verdict, which was the last standing "somebody should check this" in a gate's own output.

### 113.1 REQ-289 is not one red gate — it hides the entire workspace suite

Worth stating precisely, because the headline "one failing gate" understates it. `pnpm test` is
`test:tools && pnpm -r test`. The uncommitted `REQ-289` row breaks three register-parser tests in `tools/`, so
the `&&` **short-circuits and the workspace suite never runs at all**. Anyone typing `pnpm test` today sees a
red that says nothing whatsoever about the 2,888 workspace tests.

Proved by removing the row and re-running: **23/23 traceability tests pass and `check:coverage` classifies
288/288 with zero unaccounted.** Restored immediately; the row is another workstream's and untouched.

So the honest statement of repo health is: *green on every surface this repo owns, behind one owner-signed
register row that currently masks the largest suite.* §4 clause 2 predicted this mechanism in the abstract —
this is the first time it has actually bitten, and it is the single highest-leverage thing an owner can clear.

### 113.2 What this loop is no longer finding

Thirteen sections since the last defect of substance (§104). §105–§113 produced: two ops-record
reconciliations, one stale count, one instrument correction, eight drift verdicts, and a mutation proof of a
gate that turned out to be sound. The last *behavioural* defects were §86/§93 (revocation that did not revoke)
and §84 (a driver able to waive a server-side gate).

That is the signature of a search whose yield has moved from defects to record accuracy — the audit is now
mostly finding places where the **documentation** of a correct system had drifted. Three of this session's
last four findings were defects in *this audit's own instruments* (§110's sweep, §112's manifest, §4's counts),
which is the clearest available signal that the code surface is quieter than the record surface.

**The stopping point is here, and it is a phase gate, not a finish line.** Repository-closable debt is closed.
What remains needs an owner, not another loop iteration.

> **Corrected 2026-08-03 (§123): the table below is the REPOSITORY-ADJACENT holds, not the whole set.** As
> written it read as a complete enumeration of what stands between this build and production, and it is not.
> `docs/ops/GO-LIVE-CHECKLIST.md` is the authoritative list, and it carries **47 further substantive owner
> items** this table never mentions — API keys and secrets, the device signing root key, self-hosted tiles and
> glyphs, a real RFC-3161 TSA endpoint, public status-page hosting, live OAuth secrets, and the entire legal
> class (ToS/Privacy/DPA, photo/PII retention, eBOL validity per mode, trademark clearance). Read the
> checklist, not this count — the same rule §110 applied to a stale test figure, now applied to my own phase
> gate.

*Rewritten 2026-08-03 (§126) to the standard §125 established: every hold carries a **verification command**
and an **expiry trigger**, because a hold with no trigger cannot signal that its verdict has died. The
previous table had two columns and neither. It also said "five private-fixture holds", conflating **five
blocked gates** with the **nine pending fixtures** behind four of them — the fifth blocks on a secret, not a
fixture. That is §118's class again: a number meaning something other than what it says.*

| # | Hold | Owner action | Verify | Stops being true when |
|---|---|---|---|---|
| 1 | `REQ-289` uncommitted (another workstream's row) | commit or drop it — unblocks `tools/` **and** unmasks the workspace suite | `pnpm check:coverage` → exit 1, "1 unaccounted register row" | the row is committed or removed; the gate returns 289/289 |
| 2 | **four** fixture-backed gates BLOCKED, behind **nine** pending fixtures | vendor from the engagement workspace (`manifest.private M-01`) | `pnpm check:fixtures -- --mode merge` → exit 2, naming all nine | a fixture flips `status:"pending"` to a `sha256`; the gate names one fewer |
| 3 | `identity-leak` BLOCKED on a **secret**, not a fixture | bind `IDENTITY_DENYLIST` (or create `.identity-denylist.local`) | `pnpm check:identity -- --mode merge` → exit 2 BLOCKED | the secret binds — and note the first run must screen commit `6a6c88e`'s blobs, not only HEAD (checklist row 371) |
| 4 | two External Highs | REQ-069 identity seam (custody handoff); EDI transport credentials | `GO-LIVE-CHECKLIST.md` row 386, and the EDI hold beside it | REQ-069 lands with manifest party refs; the credentials bind |
| 5 | `routes ±10%` disposition | one written answer — it names a merge gate with nothing behind it | cited at `genesis/11:41` and `genesis/14:52` | either document records a disposition, or the gate gains an implementation |
| 6 | R2–R5 grades unsigned | owner sign-off per `V2-EXECUTION-FRAMEWORK.md` §9 | that document's §9 grade table | a grade is signed and dated there |

---

## §114 — every hard budget in CLAUDE.md, mutation-proved

`CLAUDE.md` opens with seven budgets declared **"CI-enforced; exceeding = the PR is wrong."** §111 proved
three (colour tokens, font families, chrome). This closes the other four. Each was mutated to a genuine
breach, with the diff asserted non-empty before the verdict was believed (§111.2's rule):

| budget | mechanism | breach | verdict |
|---|---|---|---|
| ≤22 tables | `tools/checks/invariants.ts` `TABLE_BUDGET` | a 23rd `CREATE TABLE` in the tenant migration | **RED** |
| 35 event kinds | `packages/contracts/src/events.ts` + four contracts tests | a 36th kind | **RED** — *expected 36 to be 35* |
| ≤12 canonical views | `apps/command/src/views/registry.ts` `assertViewBudget()` at import | a 13th view | **RED** — *REQ-084: 13 canonical views exceeds the 12-view budget* |
| 3 surfaces | `tools/deploy/surface-contract.test.ts` (§54, bidirectional) | an app directory absent from `SURFACES` | **RED** |

All seven budgets are now proved able to fail. The 3-surface probe is the one worth naming: §54 built it
against the *realistic* risk, which is not a fourth surface (nobody adds an app by accident) but **an app on
disk that `SURFACES` does not list** — it would deploy nowhere while every surface gate stayed green, because
each gate iterates `SURFACES`. That is the Migrator rule's silent drop wearing a deployment costume, and the
probe confirms it is caught.

### 114.1 A GREEN I nearly reported as a defect — again

The first view probe returned **GREEN, NOT CAUGHT**, and I was one step from writing "the 12-view budget is
unenforced." It wasn't. `CANONICAL_VIEWS` holds **11** entries with one slot of deliberate headroom, so my
one-element mutation produced 12 — *exactly at* a `≤12` ceiling, and therefore legal. The gate was right and
the probe was wrong.

Re-run at both boundaries, it behaves precisely as specified: **12 passes, 13 fails.** That is a stronger
result than a bare RED, because it proves the ceiling sits where the register says rather than merely
somewhere.

Second instance in two sections of §111.1's rule — *a mutation's verdict is only as good as the reason behind
it* — and this time in the opposite direction: §111 had a RED that fired for the wrong reason, this had a
GREEN that was correct for a reason I hadn't checked. Both fail the same way if you read only the exit code.

### 114.2 A new variant of the absence-claim failure: right command, wrong scope

Looking for the view mechanism, `grep -rn "assertViewBudget" packages tools` returned empty — **and the
command succeeded.** No glob error, no zsh abort, correct syntax, exit status clean. Every guard I had built
this session passed, and the answer was still wrong: `assertViewBudget` lives in `apps/`, which I had not
searched.

This is the family's seventh instance and its most dangerous shape yet, because none of the existing
countermeasures apply. The rule needs a third clause:

> **A clean empty result also requires that you searched where the thing would be.** Before concluding
> absence, widen to the whole tracked corpus (`git grep`, no path filter). A path-scoped search proves
> absence *within that scope only* — which is rarely the claim being made.

Had I acted on it, §114 would have reported the 12-view budget as having no mechanism at all — a fabricated
Critical against a gate that works.

---

## §115 — the ten non-negotiable engineering rules, proof status

§111 and §114 proved the *budgets*. `CLAUDE.md` also states ten **non-negotiable engineering rules**, which
are the load-bearing ones — they govern behaviour, not counts. Four had never been mutation-proved. All four
now are, each restored byte-identically:

| rule | probe | verdict |
|---|---|---|
| **1** — traceability blocks orphans both directions | a source file citing `REQ-999`, absent from the register | **RED** |
| **4** — no price on air | the weight guard removed → **RED (9 tests)**; the dims guard removed → **RED (3 tests)** | **RED, both halves independently** |
| **5** — interline floors compare the executing share, never gross | `shareCents` swapped for the gross `sell` — the exact REQ-040 defect | **RED (3 tests)** |
| **10** — no silent drops in migration | the `unmapped` gap row suppressed → **RED (2)**; `low_confidence` silently applied → **RED (1)** | **RED, both halves** |

**Full status across the ten.** Eight are mutation-proved (1, 2 §69, 3 §84, 4, 5, 7 §111, 8 §73, 10); rule 6
(fixtures gate merges) is BLOCKED on the five private-fixture holds and cannot be proved in-repo; rule 9
(adversarial swarm at WP exit) is a *process* rule, resolved in §99 — it has no code gate by design.

### 115.1 Rule 1's second direction is being demonstrated right now

I probed only the code→register direction (a citation to a row that does not exist). The register→code
direction — a row with no implementation — needs no probe this session, because **`REQ-289` is failing it
live**: `check:coverage` reports one unaccounted row, which *is* that direction firing. §113 called REQ-289 a
blocker; it is simultaneously the standing proof that half of rule 1 works.

### 115.2 Rule 4 had two identical returns, and `replace` took the first

The weight and dims guards end in a **byte-identical** line:

```ts
return { status: "UNKNOWN", reason: "missing_physics" };
```

A naive `String.replace` mutates the weight guard and leaves dims untouched — precisely §73's trap, which
once nearly produced "the isolation suite is hollow." Anchoring on the *condition* rather than the shared
return proved the dims half separately (3 tests, a different set from the weight half's 9).

This is §93's rule paying off a third time: the question is never "did the guard fail," it is **"does each of
the N fail on its own."** Two guards sharing a return value are as indistinguishable to a mutation as two
guards sharing an HTTP status are to a test (§81) — the same defect, one layer down.

### 115.3 What is left is not provable from inside the repo

With the budgets (§111/§114) and the engineering rules (§115) proved, the mechanical laws of this build are
demonstrated rather than asserted. Every remaining hold in §113's table needs an owner: a register row to
commit, fixtures to vendor from the engagement workspace, credentials for the EDI transport, an identity seam
to specify, and grades to sign. None of them is a coding task, and none can be closed by another loop
iteration without straying from the documented build.

---

## §116 — the same instrument failure, pointing the other way

Verifying the build after §115's mutations, a combined root-level run reported **25 failed tests** against a
tree `git` confirmed was byte-identical to `HEAD`. Re-run per workspace with each project's own config:

```
packages/rater 154 · packages/adapters 38 · packages/agents 217 · packages/contracts 285 · apps/command 97
```

All passing, and matching the full-suite figures in §113 exactly. `npx vitest run <path> <path> …` from the
repo root applies the **root** config to every path — no jsdom for the command app, the wrong pool for the
worker suites — so the failures were the harness's, not the code's.

Every earlier instrument failure this session pointed one way: a broken probe reporting **falsely clean**
(§101, §102, §111.2, §112.3, §114.2). This one points the other way — a broken probe reporting **falsely
red**. The cause is identical: believing a tool's output without checking what the tool actually did.

> The habit that catches both is the same one: **make the probe state what it examined.** A run that prints
> its config, its file count, or its diff is one you can audit. A run that prints only pass/fail is one you
> have to trust.

Recorded because a false alarm is the more corrosive of the two in a loop like this: a false clean ends an
investigation, but a false red starts a wrong one — and it looks exactly like diligence while it does.

**Build state at `de58c80`:** working tree clean but for the other workstream's `REQ-289` row; all five static
gates PASS; every package green under its own config.

---

## §117 — the eight data-model invariants, mutation-proved

`genesis/10` is source-of-truth rank 2, and its invariants I1–I8 are the schema-level laws beneath the
budgets (§111/§114) and the engineering rules (§115). §114 proved I8. This proves the other seven — each by
disabling the **mechanism**, not its description, and restoring byte-identically:

| inv | law | mutation | verdict |
|---|---|---|---|
| **I1** | no money_line without event | the `REFERENCES events(id)` FK dropped from `money_lines` | **RED** — `check:invariants` *and* the ledger suite |
| **I2** | no invoice without `pod.signed` | the gate's `throw GateError` made unreachable | **RED (3)** |
| **I3** | no event edit/delete grants at DB level | a `DELETE FROM events` in a migration → **RED**; `DROP TRIGGER events_no_update` → **RED** | **RED, both paths** |
| **I4** | custody events co-signed or flagged `unwitnessed` | the `!hasDevice && !unwitnessed` predicate forced false | **RED (2)** |
| **I5** | every quote pins rate_config versions | `rate_config_ids` `.min(1)` relaxed and made optional | **RED (1)** |
| **I6** | `events.visibility` respected by every view | `invoice.issued` added to the driver lens allowlist | **RED (2)** |
| **I7** | correction pairs net zero in GL export | the reversal's `-o.amount_cents` un-negated | **RED (6)** |
| **I8** | 22nd table = build failure | §114 | **RED** |

I6's probe is the one to keep: widening a lens allowlist by a single kind — the exact shape of the fail-open
visibility bug this loop's memory already records — is caught by two adversarial tests. I7's is the sharpest,
because un-negating a reversal is a one-character change that would silently break every corrected invoice's
GL reconciliation, and six tests catch it.

### 117.1 Two probes returned GREEN, and both times my probe was the bug

The first I4 attempt edited the `message:` string in the `ctx.addIssue` call. The first I5 attempt edited a
`// I5: …` comment. Both returned GREEN, and both times GREEN was **correct** — neither mutation changed a
single branch. A refinement that still fires with a different message is still a refinement.

That is the third consecutive section where a GREEN was my instrument's fault (§114.1's off-by-one at the
ceiling, §116's wrong vitest config, these two). The shape is specific enough to name:

> **Mutating an annotation is not mutating a mechanism.** Comments, error messages, log lines and type-only
> constructs are read by humans, not by branches. If a mutation changes only text a person would read, a green
> suite is the correct answer — and it tells you nothing about the guard.

The corollary is a probe-design rule: **mutate a condition, a sign, a bound, or a constraint** — something a
runtime actually consults. Every RED in the table above came from exactly that; every GREEN came from failing
to do it.

### 117.2 The I1 probe searched the wrong file

`0001_ledger_core.sql` does not define `money_lines` — `0002_domain.sql` does. The anchor missed, which
reported honestly rather than falsely, only because the harness distinguishes ANCHOR MISS from GREEN. That
distinction is the single most useful thing in these probes: without it, a missed anchor is indistinguishable
from an unenforced law, which is precisely the §111.2 near-miss that nearly published "the design gate is
hollow."

### 117.3 Where this leaves the mechanical record

Three documents state this build's mechanical laws, and all three are now demonstrated rather than asserted:

| source | laws | status |
|---|---|---|
| `CLAUDE.md` hard budgets | 7 | **all mutation-proved** (§111, §114) |
| `CLAUDE.md` engineering rules | 10 | **8 proved**; rule 6 externally blocked, rule 9 a process rule (§115) |
| `genesis/10` invariants | 8 | **all mutation-proved** (§114, §117) |

Twenty-three of twenty-five, with the two exceptions named and neither closable in-repo. Nothing in this
section changed a line of product code — it changed what the record is entitled to claim.

---

## §118 — the five acceptance demos, and a gate that misreported its own size

`CLAUDE.md` names five acceptance demos as the definition of *"done enough to show."* They are the last
declared law this audit had not examined.

**The gate is real, not structural.** `test:acceptance` does not validate a manifest — it invokes each demo's
spine files **in their own package's vitest config**, because the api/mcp pools are `vitest-pool-workers`,
driver is node and map is jsdom, and they cannot share one root config. (That is §116's lesson, already
encoded here before I rediscovered it the hard way.) A run at this commit:

| package | spine files | tests |
|---|---|---|
| `@shuddl/api` | 4 (heartbeat, signup-to-quote e2e, airplane-soak, command-heartbeat) | 6 |
| `@shuddl/driver` | 1 (stop-flow) | 7 |
| `@shuddl/mcp` | 1 (quote-book) | 9 |
| `@shuddl/map` | 1 (MapCanvas) | 14 |
| **total** | **7** | **36** |

**Its no-op defence is real too, and I checked rather than trusted it.** The runner carries the comment
*"vitest exits non-zero on … 'no test files found' (a typo'd filter), so a silent no-op can never pass as
green."* That is an observation stated as a law — §64's exact class, and load-bearing: if false, the five
demos could pass while running nothing. Tested directly against a nonexistent filter:

```
No test files found, exiting with code 1
filter: test/does-not-exist-xyz.test.ts
```

True, and true *for the stated reason*. The comment stands.

### 118.1 The gate has been misreporting its own size

`spineFileCount()` returns `files.length`. The runner printed it as:

> `ACCEPTANCE SPINE: GREEN — all 7 spine tests pass.`

Seven is the count of **files**; those files carry **36 test cases**. Every record that quoted this line
inherited the wrong number — including this session's own working notes, which recorded "acceptance spine
GREEN (7 tests)" straight from the output.

Fixed to say `7 spine FILES`, with the reason inline. It is a one-word change and it matters for one reason:
**this is a gate teaching the record a false fact.** Every other count defect this loop found was a human
writing a number that later decayed (§66, §110, §113). This one is a machine emitting a wrong number
*continuously*, which no amount of care in the prose can survive — the audit's whole answer to decay has been
"point at the authority instead of restating it," and here the authority itself was wrong.

Worth stating as a rule, because it is the failure mode that defeats the fix:

> **When a document defers to a generated figure, the generator inherits the honesty obligation.** "Read it
> from the run, not from here" (§110) only helps if the run says what it means.

### 118.2 The filmed delta is the honest remainder

Each demo declares a `filmed` delta — the part no in-repo test can reach. Two are explicit that the full
causal chain is not browser-drivable here: demo 1's DO-queue + Resend latency, and demo 4's cross-worker
booking. Those are not gaps in coverage; they are correctly-scoped statements that the *integration spine*
proves the causation and a *filmed* run proves the wall-clock. That is the right shape, and it is already
recorded in `docs/wp/acceptance-demos.md`.

**Verification:** `test:acceptance` GREEN (7 files, 36 tests), `typecheck` PASS, `lint` PASS, the manifest
drift suite 5/5.

---

## §119 — do the gates tell the truth about themselves? (and a NUL byte in the audit's own tool)

§118 found a merge gate printing a file count as a test count. That raises a systematic question this audit
had never asked: every gate emits numbers, and the record quotes them. **Are the other numbers true?**

Each numeric claim was verified against an independently-computed value:

| gate | claim | independent check | verdict |
|---|---|---|---|
| `check:tables` | "109 markdown files" | `git ls-files '*.md'` = 109 | ✅ |
| `check:citations` | "970 citations, 27 content-anchored" | `citations.length`; `filter(c => c.symbol !== undefined)` | ✅ |
| `check:citations` | "130 unanchored into 10 high-churn targets" | ratchet config: 10 targets, baseline sums to 130 | ✅ |
| `check:invariants` | "21/22 tables" | 22 raw `CREATE TABLE` − 1 partition (`positions` shares `events`) = 21; `NAMED_TABLES` = 21 | ✅ |
| `check:authority-coverage` | "9 consults, 5 modules, 8 distinct files" | 9 pairs / 8 files because `concierge.ts` registers under *both* rating and comms | ✅ |
| `check:chokepoint` | "2 allowlisted modules" | `ALLOWED` map: `do/sequencer.ts`, `tools/seed/load.ts` | ✅ |
| `check:coverage` | "288/289 classified" | 290 register lines − 1 header = 289 rows | ✅ |
| `check:runtime`, `check:seed`, `check:rater-purity`, `audit:design` | no counts — statements only | — | ✅ |

**§118's defect was isolated, not systemic.** Every other gate says what it means.

Two are worth singling out. `check:invariants`'s "21/22" is the subtlest: a hand count of `CREATE TABLE`
returns **22**, and only the partition rule (a partition shares its parent's budget slot) reconciles it to 21
— accurate, but a reader recomputing it would think the spare slot was spent. And
`check:authority-coverage` is the standard the others should be held to: it states its own **limits** in its
source — *"proves this file consults the registered module's authority SOMEWHERE, NOT that every
authoritative path does."* A gate that publishes what it does **not** prove is the strongest form of the
honesty obligation §118 named.

### 119.1 The shell's `grep` cannot see binary-classified files — and one of ours was

Mid-sweep, `grep -c "markdown" tools/docs/check-table-shape.mjs` returned **exit 1, no output**, on a file
that plainly contains the word. `command grep` found 4. The cause is environmental: the shell's `grep` is a
**ugrep wrapper carrying `-I`** (ignore binary files), so anything `file(1)` classifies as binary is
*silently invisible* — no error, no warning, clean exit.

And `file` did classify it as binary:

```
tools/docs/check-table-shape.mjs: a /usr/bin/env node script executable (binary data)
```

### 119.2 The cause was three NUL bytes in a tool I wrote in §50

```js
const stripped = line.replace(/`[^`]*`/g, (m) => "\0".repeat(m.length)).replace(/\\\|/g, "\0\0");
```

Those look like spaces in every editor and in the `Read` tool. They are **NUL (0x00)** — almost certainly
introduced by shell escaping when §50 created the file. Consequences:

- The file was classified **binary**, so every `grep`-based sweep in this repo silently skipped it — including
  my own audits of my own tooling.
- Functionally it happened to work: the bytes only blank out code spans so pipes inside backticks are not
  counted as delimiters, and NUL is as much "not a pipe" as a space is. **A latent defect, not an active
  one** — which is exactly why it survived four months and eleven audit sections.

Replaced with real spaces. `file` now reports *"text executable, Unicode text, UTF-8 text"*, `grep` finds it,
and the gate's behaviour is unchanged — mutation-proved on all three branches the bytes served:

| case | expected | result |
|---|---|---|
| over-wide row | fail | exit 1 ✅ |
| pipe inside backticks | pass | exit 0 ✅ |
| escaped pipe | pass | exit 0 ✅ |

**Swept the rest of the repo:** 848 tracked text-extension files, **zero** others contain NUL bytes. Isolated.

### 119.3 The pattern this completes

Three consecutive sections have found the defect inside the audit's own instruments — §110's sweep regex,
§112's coverage manifest, §118's acceptance runner, and now §119's table checker. Four of the last six
findings. The tools built to detect drift drift too, and nothing was auditing them.

> **An instrument that has never been pointed at itself is not evidence.** Every gate in this repo now has:
> a proof it can fail (§111/§114/§115/§117), and a check that what it *says* is true (§119).

---

## §120 — two I3 gates disagreed about where a violation could live; four of six cells were blind

§119 ended on the observation that a file can be invisible to a scan without anything reporting an error.
The natural next question is whether the **gates' own file enumeration** has that property — a gate that
scans the wrong set can be bypassed by *placement*, and nothing fails.

Mapping how each gate selects its corpus separated them cleanly:

| enumeration | gates | risk |
|---|---|---|
| `git ls-files` (whole corpus) | `check:citations`, `check:identity`, `audit:design` | none — the corpus *is* the tracked repo |
| `globSync` with path prefixes | `check:invariants`, `check:chokepoint`, `check:rater-purity` | a prefix that does not match the corpus |

`check:rater-purity` scans `packages/rater/src` and that is its whole subject, so it is correct by
definition. The other two guard **I3** (no event edit/delete paths) — and they disagreed with each other
about where such a violation could be written.

**Measured, by planting one violation at a time across trees × extensions:**

| | `check:invariants` (.ts / .tsx) | `check:chokepoint` (.ts / .tsx) |
|---|---|---|
| `workers/` | CAUGHT / **MISSED** | CAUGHT / **MISSED** |
| `packages/` | CAUGHT / **MISSED** | CAUGHT / **MISSED** |
| `apps/` | **MISSED** / **MISSED** | CAUGHT / **MISSED** |

`check:invariants` was blind in **four of six** cells; `check:chokepoint` in three. Both were `.ts`-only.
The chokepoint already scanned `apps/`, so the two gates guarding one invariant held different beliefs about
its blast radius — and the narrower belief was silently winning wherever only that gate looked.

**Severity, stated honestly: LOW today, and the fix is one glob list each.** The three apps are browser PWAs
with no D1 binding — they call the API — so SQL in a `.tsx` is not executable as written. But `.tsx` is an
entirely ordinary place to put a helper, `apps/driver` does carry offline capture logic, and the chokepoint's
own source says a direct insert *"skips every gate — nothing else catches it."* A guard whose reach depends
on a file extension is not a guard; it is a convention.

Both gates now scan `{workers,packages,apps}/*/src/**/*.{ts,tsx}` (chokepoint keeps `tools/**` as well).
Re-probed: **0 of 6 blind cells** for each. `check:invariants` and `check:chokepoint` still PASS on a clean
tree, `tools/checks` suite 259/259, lint and typecheck PASS.

### 120.1 The tell was an inconsistency, not a symptom

Nothing was failing. No test was red, no output was wrong, and §119's sweep had just confirmed every gate
reports truthfully. The gap surfaced only from noticing that **two gates guarding the same law scanned
different sets** — and asking which one was right.

> **When two mechanisms enforce one invariant, their disagreement is the finding.** Neither has to be
> obviously wrong; the delta between them is a claim someone made twice and answered differently, and one of
> the answers is doing less work than the record assumes.

That is a distinct search from everything else in this loop. §111–§117 asked *can this fail?* and §119 asked
*does it say what it means?* This asks a third thing: **does it look everywhere it claims to?** A gate can
pass both earlier tests and still be trivially avoidable.

---

## §121 — validation expressed twice: 19 SQL CHECK enums against their runtime counterparts

§120's heuristic — *when two mechanisms enforce one invariant, their disagreement is the finding* — has a
larger surface than two gates. The biggest instance in this build is **validation written twice**: a SQL
`CHECK (col IN (...))` and a Zod schema or literal set over the same column. If they disagree, one accepts
what the other rejects: a value the code allows and the DB refuses becomes a 500 where a 400 belongs, and a
value the DB allows but the code refuses is a path that can only be reached another way.

Nineteen column-level enum constraints were extracted **per table** (a first pass that merged every `kind`
column into one set was useless — the `kind` on `documents`, `money_lines` and `legs` are three different
laws) and compared against every literal set in the tracked corpus.

**Nine are identical to their runtime counterpart:**

| column | runtime set |
|---|---|
| `users.role` | `Role` (contracts/roles.ts) |
| `events.visibility`, `documents.visibility` | `Visibility` (contracts/events.ts) |
| `parties.kind` | `PARTY_KINDS` (api/intake-core.ts) |
| `shipments.mode` | `SHIPMENT_MODES` (api/intake-core.ts) |
| `messages.channel` | `MessageChannel` (contracts/comms.ts) |
| `facilities.kind` | `FacilityKind` (contracts/facilities.ts) |
| `authority_map.module` | `MIRROR_MODULES` (adapters/legacy-mirror.ts) |
| `authority_map.authority` | `AuthorityLevel` (contracts/authority.ts) |

**The remaining ten have no runtime enumeration — and none of them needs one.** Each was traced from the
CHECK to every non-test writer, then to the origin of the bound value:

| column | writers | what actually reaches it |
|---|---|---|
| `documents.kind` | `routes/evidence.ts`, `anchor.ts` | `documentKindFor()` — a **total function returning `"POD" \| "photo"`** from the recording event's kind, plus a literal `"tsa_receipt"` |
| `money_lines.kind`, `.direction` | `projection/money.ts` only | literals in the projection (`"correction_credit"`, `"ar"`, …) |
| `anomalies.severity` | 6 writers incl. `routes/import.ts`, `translator/inbound.ts` | literal `"warn"` at both external-facing sites; `quarantine.ts` types the field as `severity: "warn"` |
| `legs.kind` | `projection/status-cache.ts` | projected from validated ledger events |
| `rate_config.kind` | `tariff-seed.ts` | seed-template literals |
| `assets`, `integrations`, `pairings` | **zero non-test writers** | nothing reaches them yet |

**No request-supplied value reaches any CHECK-constrained enum column.** The SQL constraints are a genuine
backstop rather than the primary defence, which is the correct arrangement — and it is why the missing Zod
mirrors are not a "Zod at every boundary" violation: these columns are not boundaries.

Worth noting for the record: `documents.kind` declares **ten** values and exactly **three** are ever written.
The other seven are schema headroom — and one of them, `ratecon`, is REQ-184's deferred generation flow,
which §112 adjudicated as a correctly fail-closed deferral. The schema was built for the finished system; the
code has reached part of it. That is not drift.

### 121.1 An automated "best match" produced a false disagreement

The comparison ranked candidate runtime sets by Jaccard overlap. For `events.source`
(`native,legacy,edi,email`) it picked `NATIVE_VISIBLE_SOURCES` (`native,edi,email`) at **0.75**, and dutifully
reported *"SQL-only: legacy"* — which reads exactly like drift.

It is not. The two sets are semantically unrelated: one is the column's domain, the other is the subset
visible on the native side **by design** — excluding `legacy` is the entire point of that constant. A
similarity score paired them because they look alike, and looking alike is all a score can measure.

> **An automated match produces candidates, not verdicts.** Every high-overlap pair still needs a human to
> ask *are these the same law?* — the score cannot distinguish "the same set, drifted" from "a deliberate
> subset of it."

This is the same failure as §114.1's off-by-one at a `≤N` ceiling and §117.1's annotation edits: the
instrument returned a technically-correct measurement of the wrong thing. Three sections running, the
discipline that caught it was identical — **read the reason, never the verdict.**

---

## §122 — the agent mesh: 12 of 13 built, the 13th correctly deferred

`CLAUDE.md` opens by claiming **13 agents that run the protocol**. `genesis/01 §2` lists them in a table;
`genesis/05` scopes V1 to *"6 of the 13"*. Nothing in the repo maps any of those names to code, and the last
document that tried — `docs/audits/2026-07-15-full-audit-and-skill-plan.md` — recorded *"of the 13 agents,
only Concierge and Biller are built,"* which was true then and is badly stale now.

**The table does contain exactly 13 rows** (counted, not eyeballed — see §122.2). Mapped to implementations
and test cases at this commit:

| # | agent | V1 scope | impl files | test cases | status |
|---|---|---|---|---|---|
| 1 | Concierge | V1 | 7 | 45 | built + tested |
| 2 | Rater | V1 | 13 | 154 | built + tested |
| 3 | Scheduler | V1 | 2 | 33 | built + tested |
| 4 | **Dispatcher copilot** | — | **0** | **0** | **NOT BUILT — REQ-029, vNEXT** |
| 5 | Gatekeeper | V1 | 2 | 107 | built + tested |
| 6 | Biller | V1 | 6 | 23 | built + tested |
| 7 | Collector | — | 5 | 36 | built + tested |
| 8 | Settler | — | 1 | 13 | built + tested |
| 9 | Translator | — | 10 | 96 | built + tested |
| 10 | Migrator | V1 | 3 | 47 | built + tested |
| 11 | Watchtower | — | 4 | 31 | built + tested |
| 12 | Credit officer | — | 1 | 33 | built + tested |
| 13 | Copilot | — | 5 | 36 | built + tested |

**All six V1 agents are built and tested — 409 test cases between them.** Six more shipped beyond the V1
minimum, and that is scoped work rather than scope creep: `check:traceability` passes **in both directions**,
so every one of those implementation files maps to a register row and every row maps to code.

**The single gap is `REQ-029` — "Dispatcher copilot suggestion-only v1", status `vNEXT`.** It is the one
agent deliberately not built, its deferral is recorded, and `check:coverage` classifies it (288/289, the sole
unaccounted row being the other workstream's `REQ-289`). Nothing to fix; something to *know*, and the record
did not previously say it anywhere.

### 122.1 What the roster is worth at a phase gate

§113 listed five owner-blocked holds. This adds the shape of the delivered system to that picture: an owner
asking *"is the documented build actually built?"* now has an answer with evidence attached rather than a
count in a preamble. The stale 2026-07-15 line stays where it is — it is a **dated snapshot**, and this audit
does not rewrite history (§109's rule); this section is the current measurement, dated 2026-08-03.

### 122.2 Three instrument errors in one section, all the same shape

Producing this table took three wrong measurements first, and each would have published a false claim:

1. **Rater and Gatekeeper reported "0 tests."** I reused the *implementation* path matcher for tests, and
   `packages/rater/src/` cannot match `packages/rater/test/`. Rater has 154 cases; Gatekeeper 107.
2. **The agent names came out as eleven, not thirteen.** Extracting `**Bolded**` names missed
   *Dispatcher copilot* and *Credit officer* — both contain a space, and my pattern stopped at the first
   word boundary. Counting table **rows** instead gave 13.
3. **"Dispatcher copilot: NOT BUILT"** was believed only after searching the register for what it would be
   called if it existed under another name — which is how `REQ-029` surfaced and turned a suspected gap into
   a recorded deferral.

Every one is the failure this loop keeps meeting: *the instrument measured something adjacent to the
question.* Sections §114.1, §116, §117.1 and §121.1 are the same error in four other costumes. The only
defence that has ever worked is the one applied here — **when a measurement says something is missing, spend
the next probe trying to find it a different way before writing it down.**

---

## §123 — the event taxonomy holds; my own phase gate did not

Two questions this loop had not asked of `genesis/10`'s taxonomy, and one answer that turned back on the
audit itself.

**All 35 event kinds are live.** Every kind in the catalog has a non-test producer and at least one test
case — zero dead entries. (A producer/consumer *split* was attempted and is not reported here: the heuristic
classified any file containing `append`/`emit`/`kind:` as a producer, which made "no consumer" meaningless —
`invoice.corrected` came back consumer-less while §117 had already proved the money projection nets it. A
measurement that cannot distinguish its two categories is not evidence for either.)

**Visibility is exhaustive by construction, not by discipline.** `KIND_VISIBILITY_DEFAULTS` is declared
`Record<EventKind, Visibility>` with exactly 35 entries — none missing, none unknown. Mutation-proved: delete
one entry and `tsc` refuses with *`Property '"call.transcribed"' is missing`*. A 36th kind cannot be added
without a visibility decision. That is a stronger guarantee than a test, because it cannot be skipped.

REQ-180's never-widen floor is likewise sound and better than its register row: the code clamps a **fail-closed
superset of seven** where REQ-180 names six, deliberately adding `split.computed` because it carries
interline/margin internals. The reasoning is recorded at the definition, and the proposed register alignment
is tracked in `GO-LIVE-CHECKLIST.md:218`, `WP-11.md:28/66` and the WP-11 plan. Nothing lost.

### 123.1 §113's hold table read as complete, and it was not

Chasing where that REQ-180 alignment was tracked surfaced a defect in **this audit's own phase gate**. §113
closed with a five-row table under the line *"what remains needs an owner, not another loop iteration."* Read
plainly, that says five owner decisions stand between this build and production.

`GO-LIVE-CHECKLIST.md` — the authoritative enumeration — carries **47 further substantive owner items** that
table never mentions:

| class | examples |
|---|---|
| secrets / keys | `RESEND_API_KEY`, `ANTHROPIC_API_KEY` (copilot *and* Concierge), device signing root key, live OAuth + MCP pairing secrets |
| infrastructure | self-hosted Protomaps vectors + glyph PBFs on R2, public status-page hosting, a real RFC-3161 TSA endpoint |
| legal / commercial | ToS · Privacy · DPA, photo/PII retention + consignee notice, eBOL and e-signature validity per mode, driver location-consent text, SHUDDL trademark clearance |
| milestone | M-H heartbeat unlocks GTM; pricing re-based on tenant-0 telemetry |

None of that is repository-closable, and none of it was wrong to leave out of a *repo* debt audit — the error
was presenting the repo-adjacent subset as the whole. §113's table is now scoped in place and points at the
checklist, applying the rule §110 established for a stale test count to my own phase gate: **where an
authority exists, point at it rather than restating a subset of it.**

### 123.2 The pattern, stated for the last time

Five of the last six sections have found the defect inside the audit's own instruments — §110's sweep regex,
§112's coverage manifest, §118's acceptance runner, §119's table checker, and now §113's hold table. Every one
was an instrument that had never been pointed at itself.

> A gate is audited when it can fail (§111/§114/§115/§117), says what it means (§118/§119), looks everywhere
> it claims to (§120), and **does not present a subset as a whole** (§123).

The fourth is the one that hides longest, because a subset is never *wrong* — every row in §113's table was
true. It was the sentence above the table that overstated, and no test can catch a sentence.

---

## §124 — auditing the authority §123 just pointed at

§123 named `GO-LIVE-CHECKLIST.md` the authoritative owner-hold enumeration and scoped the phase gate to point
at it. That transfers the honesty obligation (§118's rule): a document deferring to an authority is only as
good as the authority. So the checklist itself now needs auditing, and two of its rows contradicted things
this loop had already measured.

### 124.1 A row that overstated live exposure

The checklist carried:

> **REQ-170 missing-evidence send-gate UNIMPLEMENTED** — *"A caller that emits a POD with a fabricated hash +
> no R2 upload still triggers an evidence email framing itself as 'the record' over zero stored bytes."*

**That exposure is closed.** the byte-precondition in `biller.ts` (`handlePodSigned`) requires an ACTIVE tenant-scoped POD document **and** a
present R2 object for the recorded `signature_hash` before the invoice mints; a miss returns
`held(evidence_missing)` — no invoice, no send, no terminal marker. Four cases pin it
(`biller.test.ts:683`): missing document · missing R2 object · retention-tombstoned document · cross-tenant
`r2_key`. The source says so itself at the REQ-170 note in `biller.ts` beside `renderEvidenceEmail`: *"the SIGNATURE hash IS byte-verified upstream."*

The row's 2026-07-27 annotation was **right** that it must stay open — the placed-photo hash genuinely is not
byte-checked, and the redelivery fast path re-drives without re-checking. But it stayed open under a *title
and risk statement that had become false*. An owner reading that page would believe the evidence email can
assert proof over zero bytes. It cannot.

Narrowed in place to the real residual, with what ships stated and cited. The row remains `WP06-DISCOVERED`
and open — only its claim changed, from the whole gate to the deliberately narrow part still missing.

**This is §123's error pointing the other way.** §113 presented a subset as the whole and *understated* what
remained; this row described a superseded whole and *overstated* it. Both are the same defect — a claim that
outlived its measurement — and the overstating direction is the more expensive one, because it spends owner
attention on work already done.

### 124.2 §111 proved half of REQ-158 and read as though it proved all of it

Chasing that row surfaced a checklist line naming `tools/harness/playwright-guard.ts` under **REQ-158** — the
same requirement §111 declared proven. §111 verified `tools/design/audit.ts`: its mode file reads `blocking`,
it sits in the non-skippable gate list, and twelve rules each fail alone. All true.

But `CLAUDE.md` rule 7 is *"color/contrast/font/case/radius/shadow/motion audits **+ 5 blessed
screenshots**"*, and the screenshot/perf half runs through the Playwright harness, which §111 never touched.
§111's sentence — *"the flip is real, on both halves"* — meant mode-file and gate-list **of one mechanism**,
and read as though it covered the requirement.

Proved now, directly against the exported `classifyRun`:

| outcome | `mode=local` | `mode=merge` |
|---|---|---|
| tooling absent | PENDING, exit 0 | **BLOCKED, exit 2** |
| ran, 0 tests discovered | BLOCKED, exit 0 | **BLOCKED, exit 2** |
| ran, every test skipped | BLOCKED, exit 0 | **BLOCKED, exit 2** |
| ran, no machine-readable report | BLOCKED, exit 0 | **BLOCKED, exit 2** |
| ran, a real failure | FAIL, exit 0 | **FAIL, exit 1** |
| ran, genuinely green | PASS, exit 0 | PASS, exit 0 |

**No hollow pass exists under merge.** The guard inspects *stats*, not Playwright's exit code — which is 0
both for "42 passed" and for "0 tests ran", the precise trap that made the a11y gate hollow at T14/T15. A
skip is not a pass, and an unprovable run is not a pass. REQ-158 is now proven across both its mechanisms.

### 124.3 The rule this loop keeps re-deriving

My probe's first attempt invented the stats shape (`passed/failed/skipped`) instead of Playwright's
(`expected/unexpected/flaky/skipped`) and crashed. That is the *good* failure: it stopped rather than
reporting a comfortable green against a fabricated input.

> **A claim is scoped to what was measured, not to what it was about.** §111 measured a mode file and a gate
> list; the requirement it named covers two mechanisms. §113 measured repository holds; the sentence above it
> promised every hold. Neither statement was false — both were **narrower than they read**, and nothing in a
> test suite can detect that.

---

## §125 — sweeping the authority: every repo-owned checklist row, verified

§124 found one stale row in `GO-LIVE-CHECKLIST.md` **by chance** — because §112 had independently measured
REQ-170. Chance is not a method. The systematic version rests on a distinction the checklist itself makes:

> **Only repo-owned rows can go stale.** An external hold (counsel, a secret, an infrastructure decision)
> cannot be invalidated by a commit. A row claiming *repository state* can be, silently, by any merge.

Twenty-five rows carry `Repo` ownership. **Twenty are already superseded in place** — struck through with a
dated fix and the original text preserved, exactly the ops-record discipline §109 named. That is the record
working: whoever maintained this page never rewrote history, and the strikethroughs make the live set
trivially separable from the closed one.

**The five live ones, each re-verified at this commit:**

| line | claim | verdict |
|---|---|---|
| 371 | `check:identity` reports *"no denylist available … Lint SKIPPED"*, failing closed only in CI | **accurate** — the gate prints that string verbatim today |
| 382 | `POST /pub/signup` returns a distinct 409 for a taken admin email (an enumeration oracle) | **accurate** — `signup.ts:94` maps `EMAIL_TAKEN` → 409 *"THAT EMAIL IS ALREADY REGISTERED"*; the cited line still resolves |
| 383 | pool-binding exclusivity enforced on enumeration but not resolution | **accurate** — §12's named pre-R4 carry-forward, already in §113 |
| 386 | a pickup custody handoff cannot record real parties | **accurate** — the External High needing REQ-069 |
| 185 | REQ-170 send-gate | **was stale — corrected in §124** |

One defect in twenty-five, found and fixed. The checklist is sound as the authority §123 named it.

### 125.1 Why row 382 is worth reading even though it is accurate

It is the clearest example on the page of debt recorded *properly*: a **Med**, explicitly *accepted-for-now*,
with the reasoning stated (a taken slug is inherent to the signup UX; a taken email is not), the mitigating
context named (the route is dark behind `PROVISIONING_ENABLED`), an owner assigned, a grade at which it must
be resolved (**R4**, public GA), and three **expiry triggers** — when the error mapping changes, when the
flag flips, or when the REQ-125 edge rule lands.

That is what every hold in this audit should look like. A row with an expiry cannot rot quietly: the trigger
tells a future reader when the verdict stopped being evidence. Compare §110's stale test count and §124's
superseded risk statement — neither carried one, and both outlived their measurement by weeks.

> **A recorded hold without an expiry trigger is a claim with no way to notice it has died.**

### 125.2 The phase gate is unchanged

Nothing in this sweep moves §113 (as scoped by §123). The five owner-blocked repo-adjacent holds stand, the
47 further checklist items stand, and the one correction (§124) *reduced* open exposure rather than adding
any. Static gates all PASS; the sole red remains the other workstream's uncommitted `REQ-289`.

---

## §126 — applying §125's rule to the phase gate that failed it

§125 ended with a rule drawn from the best row in the go-live checklist:

> A recorded hold without an expiry trigger is a claim with no way to notice it has died.

The document that wrote that sentence did not follow it. §113's hold table had **two columns** — *Hold* and
*Owner action* — and neither a verification command nor a trigger. Every one of this loop's record defects
(§110's stale count, §118's mislabelled figure, §124's superseded risk statement) was a claim that outlived
its measurement with nothing to signal the death. §113's own table was five more of them waiting.

### 126.1 And one of the five was already wrong

Hold 2 read **"five private-fixture holds."** Measured:

| gate (under `--mode merge`) | exit | blocks on |
|---|---|---|
| `check:fixtures` | 2 BLOCKED | nine pending fixtures |
| `check:rater-parity` | 2 BLOCKED | fixtures |
| `check:invoice-parity` | 2 BLOCKED | fixtures |
| `check:concierge-parity` | 2 BLOCKED | fixtures |
| `check:identity` | 2 BLOCKED | **a secret** — the denylist, not a fixture |

So the five is a count of **blocked gates**, four fixture-backed and one secret-backed, and the fixtures
behind them number **nine** (`rater-48-tests`, `rater-504-sweep`, `zone-tariff-v1`, `invoice-500-replay`,
`concierge-parse-50`, `customer-roster`, `legacy-import-formats`, `legacy-export-replay`,
`synthetic-blitz-3100` — the manifest and the gate's own detail string agree exactly). "Five
private-fixture holds" was §118's class precisely: a number meaning something other than what it says. A
reader vendoring five fixtures would find four gates still red.

`GO-LIVE-CHECKLIST.md:308` had it right all along — *"9 pending hash-pinned fixtures"*. The audit's summary
of the checklist was wrong where the checklist was not, which is the third time this loop has found the
derived record less accurate than the source it derived from (§110, §123, here).

### 126.2 The table now

Rewritten to six rows, splitting the secret-backed hold from the fixture-backed ones, and carrying two new
columns — **Verify** and **Stops being true when**. Every verification command in it was run before it was
written down:

- `pnpm check:coverage` → exit 1, *"1 unaccounted register row"*
- `pnpm check:fixtures -- --mode merge` → exit 2, naming all nine
- `pnpm check:identity -- --mode merge` → exit 2 BLOCKED

That last discipline matters more than the columns. §124's probe cited a stats shape that did not exist and
crashed; a *table* citing a command that does not print what it claims would not crash — it would simply be
believed. **A verification column is only worth having if every cell in it has been executed.**

### 126.3 What this closes

The phase gate now states, for each hold: what it is, who must act, how to check it, and what event ends it.
That is the same six-element shape §125 identified in the checklist's best row, and it is the first time this
audit's own holds have met the standard the audit set for everyone else's.

Nothing about the *substance* changed: the same work remains blocked on the same owners. What changed is that
a reader six weeks from now can tell, by running three commands, which of these six rows are still true —
and that is the only property that has ever kept a record honest.

---

## §127 — sweeping the audit itself: why it carries 163 counts and no stale ones

§67 and §110 swept the nine ops documents for unscoped counts. **This document was never swept**, and it is
now the largest record in the repo: 6,208 lines, 117 sections, **163 count-phrases**. Given that three of
this loop's findings were count defects (§110 hyphenated, §118 files-as-tests, §126 gates-as-fixtures), a
document with 163 of them is the obvious place for the fourth.

**There isn't one.** Every candidate resolves to one of three legitimate forms:

- a **per-section verification line** (*"`packages/ledger` 609 tests / 34 files green"*) — a measurement of
  that section, at that section's commit;
- a **quoted historical value** inside a correction, where the whole point is to show what a figure *used* to
  say (§64's decay table is nothing but these);
- a **fixture identifier** that merely looks numeric — `rater-48-tests`, `the-222084-case.json`.

The one candidate worth chasing — *"a loop over 28 kinds does real work on 5"* — is internally consistent
(5 + 23 = 28) and scoped to §51's subject, a specific test's registry loop, not the 35-kind catalog.

### 127.1 The structural reason, which is the actual finding

This document is **append-only and chronological**. A count written in §51 is scoped by §51 — it is a record
of what was true when that section was written, and no reader takes it as a present-tense claim. The ops
documents are **living**: `DEPLOYMENT.md` says what the environments *are*, so a count in it reads as current
forever, and §110 found exactly that (a "1,131-test suite" short by a factor of three).

> **The count-decay class lives in living documents, not chronological ones.** A number in an append-only
> record carries its own timestamp — its position. A number in a living document carries none, and outlives
> its measurement silently.

That is a search rule with immediate value: of the four documents measured here, the audit (163 counts) is
structurally immune, while `GO-LIVE-CHECKLIST.md` (90 counts in 736 lines — the densest by far) is the
highest-risk surface remaining. §125 swept its repo-owned *claims*; its **counts** are a separate sweep, and
one worth doing before anyone treats a figure on that page as current.

It also retroactively justifies §109's ops-record rule — *supersede in place, never rewrite history*. That
rule is precisely what converts a living document into a chronological one, and with it, immunity to this
whole class. The twenty struck-through rows §125 found are not clutter; they are the mechanism.

### 127.2 The instrument, twice

The first sweep reported **119 candidates** and was useless: it looked for scope within ±1 line, while this
document's scope markers (a dated `## §N` heading, a `**Verification.**` lead-in, a `STATUS AT <sha>` block)
sit up to forty lines above the count they govern. Widening the scope search to the nearest preceding marker
cut it to 42, and reading those 42 cut it to zero.

Sixth time in this loop that the first version of a probe produced a number I would have published — and, as
in §111.2, §114.1, §117.1, §121.1 and §122.2, the tell was **volume**: 119 defects in a document that had
been reviewed 117 times is not a plausible result. An implausible yield is an instrument error until proven
otherwise.

---

## §128 — the sweep §127 called for, and §127's prediction was wrong

§127 measured count density across four documents and named `GO-LIVE-CHECKLIST.md` the highest-risk
remaining surface: **90 count-phrases in 736 lines**, the densest measured, against an audit document that
proved structurally immune. Doing that sweep is this section, and the prediction did not survive it.

**Six unscoped candidates in the whole file, and none is a defect:**

| candidate | verdict |
|---|---|
| `rater-48-tests` / "48 cases" (×3) | a fixture **specification**, not an observation — the fixture must contain exactly 48; the number is the contract |
| `legacy-export-replay` (9,314-bill / 4,405 re-rate) | same: the fixture's declared size |
| "External holds (10 rows)" | **verified exactly right** — the section has 10 |
| "Repository-owned … 11 rows before this task, **15 after**" | correctly scoped by its own *before/after* phrasing to Task 15 |

The last one is worth a moment. Counted precisely, that ledger now spans **3 tables, 32 data rows — 19 struck
through as closed, 13 live**. Fifteen is neither current nor wrong: it is what the ledger held when Task 15
finished, and the sentence says so. Annotated with today's figures anyway, so a future reader need not count,
per §125's discipline.

### 128.1 Why the prediction failed, which is the useful part

§127 estimated risk from **density** — counts per line — and density is not risk. The same mechanism that
makes the audit immune protects this file too, and the evidence was in §125 all along: **19 of 32 repo-owned
rows are struck through in place.** Whoever maintained this page superseded rather than rewrote, which is
precisely §109's rule, and it converts a living document into a chronological one paragraph by paragraph.

> **Decay risk is set by the editing discipline, not by the number of counts.** A document with a hundred
> figures that supersedes in place is safer than one with three that overwrites.

`DEPLOYMENT.md` — where §110 found the one real stale count — is the counter-example: a short, low-density
file that states what the environments *are*, with no superseded history at all. Low density, high risk. I had
the relationship backwards, and one section later the measurement says so.

### 128.2 Where that leaves the record sweep

Four documents are now swept for this class and all four are clean or corrected: the audit (§127, 163 counts,
zero), the go-live checklist (here, 90 counts, zero), `DEPLOYMENT.md` (§110, one found and fixed),
`LAUNCH-RUNBOOK.md` (§109, one state contradiction found and fixed). The remaining ops documents were swept in
§67 under the pre-§110 pattern that could not see hyphenated counts — a **known-narrow** negative, and the last
outstanding piece of this thread.

Stated plainly rather than left implied: that re-sweep has not been done, and §67's clean negative for the
other five documents should be read as *"clean for space-separated counts"* until it is.

---

## §129 — the re-sweep §128 owed: all nine ops documents, hyphen-aware

§67 swept the ops corpus for unscoped counts and reported a clean negative. §110 then found a stale count it
had missed — *"the 1,131-test suite"* — because the pattern required a **space** between number and noun and
that one is hyphenated. §128 stated plainly that §67's negative should therefore be read as *"clean for
space-separated counts"* until re-run. This is that re-run, across all nine.

| document | lines | unscoped candidates | verdict |
|---|---|---|---|
| `PROJECT-STATE.md` | 480 | 0 | clean |
| `V2-EXECUTION-FRAMEWORK.md` | 580 | 0 | clean |
| `dr-backups.md` | 217 | 0 | clean |
| `secrets.md` | 56 | 0 | clean |
| `slo.md` | 64 | 0 | clean |
| `RELEASE-EVIDENCE.md` | 705 | 9 | all scoped — see below |
| `GO-LIVE-CHECKLIST.md` | 736 | 6 | §128 — none a defect |
| `DEPLOYMENT.md` | — | — | §110 — **one found, fixed** |
| `LAUNCH-RUNBOOK.md` | — | — | §109 — one state contradiction, fixed |

**Zero new defects.** §67's negative was narrow but not wrong: the single count its pattern could not see was
the single count there was, and §110 caught it.

`RELEASE-EVIDENCE.md`'s nine resolve to three familiar shapes — fixture **specifications** (`rater-48-tests`
must hold exactly 48; the number is a contract), **quoted gate output** (*"invariants OK — 21/22 tables"*,
verified accurate in §119), and **dated evidence records**: *"1,470 assertions across 116 files"* and
*"16 gates PASS, 5 BLOCKED"* both belong to a captured run whose SHA (`3fc592b…`) and timestamp
(`2026-07-28`) sit a few lines further down, in the artifact path.

That last point is the instrument note. My scope detector searches **upward** for a date or SHA, because
that is where headings live. An evidence log inverts it: the run is described first and stamped afterwards,
in the artifact filename. Third refinement of this probe in three sections (±1 line → 40 lines up → also
look down), and the same lesson each time — **a scope marker's position is a property of the document's
genre, not a constant.**

### 129.1 The thread is closed

Four threads of record work converge here and all are now complete:

- **counts** — nine ops documents + the 6,208-line audit, one defect found and fixed (§110)
- **claims** — 25 repo-owned checklist rows, one defect found and fixed (§124/§125)
- **state contradictions** — two ops documents disagreeing, reconciled (§109)
- **the audit's own instruments** — five defects found and fixed (§110, §112, §118, §119, §123/§126)

The record now says what it means across every document this repo owns, and the phase gate (§113, as scoped
by §123 and rewritten to carry verification and expiry by §126) states what it covers. Nothing in this thread
remains open.

What remains is what §126's table already names: six holds, none repository-closable, each with a command that
proves whether it is still live.

---

## §130 — queue redelivery: the dedupe chain, and three invalid probes before a valid one

Cloudflare Queues are **at-least-once**. Every consumer must therefore be idempotent, or a redelivery
duplicates its side effect — and in this system the side effects are a **second invoice** and a **second
evidence email to a customer**. That is demo #1's blast radius, and this loop had never tested it.

**The surface is small:** one consumer (`workers/agents/src/index.ts`) and three producers (`do/sequencer.ts`
×3, `routes/evidence.ts`, `recon-sweep.ts`).

**The dedupe chain, verified end to end:**

| link | mechanism |
|---|---|
| trigger → event id | `invoiceEventIdFor(pod.id)` and `conciergeEventId("message-sent", msg.event_id)` — derived from the triggering event, never a clock or a UUID (grep for `Date.now`/`randomUUID`/`Math.random` in both agents: none, with a control confirming the probe could see the files) |
| event id → send key | `evidence-email/${invoiceEventId}` · `concierge-reply/${messageSentEventId}` |
| send key → provider | Zod-validated `idempotency_key`, 1–256 chars, whose own schema message reads *"dedupe is load-bearing under queue redelivery"* |

**Mutation-proved.** Making either id nondeterministic goes RED: the biller id breaks **4 of 47** cases, the
concierge id **5 of 47**, against tests named exactly for the property — *"the same message twice → ONE
invoice event, ONE money projection, ONE email"* and *"a held message redelivered → already_handled, NO
duplicate draft, NO send."* The consumer's comment claiming *"BOTH consumers' append ids + send idempotency
keys are deterministic"* is true.

### 130.1 I nearly published "queue redelivery dedupe is UNPINNED"

Three probes preceded the valid one, and the second produced a clean, plausible, **false HIGH**:

| # | what I ran | reported | actually |
|---|---|---|---|
| 1 | `npx vitest --dir workers/agents` from the repo root | **RED** | root config lacks the `cloudflare:test` pool — 14 files failed to *load*. Red for the wrong reason (§116, repeated) |
| 2 | same, under the package's own config | **GREEN — "dedupe UNPINNED"** | baseline genuinely green (106 passing) — but the dedupe tests live in `workers/api`, not `workers/agents` (§96/§97, repeated) |
| 3 | `workers/api` biller + concierge suites, baseline asserted first | **RED, 4 and 5** | valid |

Probe 2 is the dangerous one. It had a *correct baseline* — 106 tests, exit 0, no environment error — which
is the check §116 taught me to add, and it still produced a false negative. The baseline being green proves
the harness works; it does not prove the harness contains a test that **could** fail.

> **A mutation's GREEN means "no test here caught it," never "no guard exists."** Before believing one, name
> the test you expected to fail and confirm it is in the suite you ran. If you cannot name it, the probe has
> not yet asked a question.

That is the missing half of §111.2's rule. §111.2 said a mutation with no diff proves nothing; this adds that
a mutation with no *relevant test in scope* proves nothing either — and it looks far more convincing, because
the diff is real, the suite is green, and the verdict is a crisp GREEN.

### 130.2 Seventh instance, and the pattern is now fully characterised

Every instrument failure in this loop has been one of exactly three shapes:

1. **The probe never ran** — glob aborted, anchor missed, no diff written (§101, §111.2, §117.2)
2. **The probe ran the wrong thing** — wrong config, wrong suite, wrong file, wrong scope window (§73, §116, §122.2, §129, and probes 1–2 here)
3. **The probe measured something adjacent** — an annotation not a mechanism, a ceiling that was legal, a similarity score not a judgment (§114.1, §117.1, §121.1)

All three are invisible in the output. The only defences that have ever worked are the three this section
used together: **assert the diff**, **assert the baseline**, and **name the test that should fail before
running it**.

---

## §131 — a fire-and-forget trigger whose backstop does not exist

§130 proved queue *redelivery* is safe. This asks the other half: what happens when the enqueue itself
**fails**? Four sites do `AGENT_QUEUE.send(...).catch(log)` — deliberately fire-and-forget, because the event
is already committed and throwing would fail a request over a trigger. Each therefore depends on a sweep to
rebuild what was lost, and each names one in its log line.

**Three name a backstop that exists. One names a backstop that does not.**

| site | trigger | claimed recovery | real |
|---|---|---|---|
| `do/sequencer.ts` (pod.signed) | Biller | "the REQ-169 sweep recovers it" | ✅ `queries/unbilled.ts` anti-join + `recon-sweep.ts` |
| `routes/evidence.ts` (POD re-drive) | Biller | "the REQ-169 recon sweep re-drives the still-unbilled POD" | ✅ same |
| `do/sequencer.ts` (message.received) | Concierge | "the sweep recovers it" | ✅ `sla-sweep.ts` (the coupling §103 documented) |
| `do/sequencer.ts` (**quote.accepted**) | Booking | *"the sweep recovers it for static-roster tenants only"* | ❌ **no sweep reconciles bookings** |

**The finding.** If that send fails transiently, `quote.accepted` is committed to the ledger and **no booking
is ever created**. Nothing rebuilds it: none of the seven crons (sla · recon · credit-recon · collector ·
mirror · watchtower · retention) touches bookings, and no unbooked-quote query exists. The only trace is a
`console.error`; the only recovery is a human noticing and re-driving.

**Verified by control, not by absence.** The working pattern is visible: `pod.signed` and `invoice.issued`
co-occur in `packages/ledger/src/queries/unbilled.ts` **and** `workers/agents/src/recon-sweep.ts` — the
anti-join and the sweep that consumes it. `quote.accepted` and `booking.created` co-occur in fifteen files,
**none of which is a reconciliation** — contracts, projections, the handler, the sequencer, routes. The
mechanism that exists for money has no counterpart for booking.

**Severity: Med–High.** The identical window on the money path was judged serious enough to build REQ-169's
sweep for. A stranded accept is customer-visible — someone accepted a quote and nothing happened — and it is
silent.

### 131.1 What I did, and what I deliberately did not

**Corrected the comment.** It read *"the sweep recovers it for static-roster tenants only"*, which is worse
than saying nothing: a future engineer reading it would believe recovery exists and not look further. It now
states plainly that no sweep recovers this, with the control evidence and a pointer here.

**Recorded it as proposed scope**, in `GO-LIVE-CHECKLIST.md`'s repo-owned ledger, carrying all six elements
§125 identified — severity, posture, reasoning, owner, resolution grade (**R3**, pilot), and an expiry
trigger (*when a booking-reconciliation sweep lands, or when the accept→book path stops being a
fire-and-forget enqueue*).

**Did not build the sweep.** `CLAUDE.md` is unambiguous: *"If it isn't a REQ row, it doesn't get built; if you
discover scope, ADD A ROW first."* The register is append-only and owner-signed, and it currently carries
another workstream's uncommitted `REQ-289` — appending behind that would compound a state I do not own. This
follows REQ-180's precedent exactly (§123): the proposal rides in code and in the checklist, and the owner
signs the row.

### 131.2 The citation gate caught rot I caused, mid-fix

Inserting the eight-line correction shifted `sequencer.ts` down, and three content-anchored citations into it
(anchored on the `ratecon` symbol, previously at line 926) immediately went red — the anchor had moved nine
lines down. *(Deliberately written without the old path:line@symbol form: quoting a rotted citation verbatim
makes it a live citation again, and the gate rejected this section's first draft for precisely that.)* The gate named the new
location in its failure message, and the fix was mechanical.

Worth recording because it is the **first time this loop has seen a gate catch a defect introduced by the
audit itself, in the same commit that introduced it.** Every other instrument finding here was archaeology.
Content-anchored citations — the form §50 built and the ratchet freezes — are the only reason a comment
insertion could not silently rot three references in a document nobody would have re-read.

---

## §132 — generalising §131: do other cross-component claims hold?

§131 found a comment naming a recovery that does not exist. §124 found a checklist row describing a gate as
unimplemented after it shipped. Both are the same shape — **a claim about another component, made in prose,
that nothing verifies** — so the generalisation is worth a pass: how many such claims are there, and do they
hold?

**Test-pin claims: 62 references, zero broken.** Every `.test.ts` filename named from non-test source
resolves to a real file. The single apparent miss (`e2e.test.ts`) was my own regex — `[\w-]+` cannot span the
dot in `signup-to-quote.e2e.test.ts`, which exists and is one of the seven acceptance spine files (§118).

**Sweep-coverage claims: seven sweeps, none overclaiming.** Each states its domain in its header and stays
inside it — `recon-sweep` the Biller commit→enqueue window, `sla-sweep` the Concierge SLA, `credit-recon` the
credit projection gap, `mirror-sweep` the 171-column legacy ingest, `collector` dunning, `watchtower` alarms,
`retention` document lifecycle. Independently confirmed by event-kind extraction: `recon-sweep` names only
`pod.signed`, `sla-sweep` only the message kinds, and **none names `quote.accepted` or `booking.created`**.

That last line matters for §131's standing: the booking gap is a genuine **absence**, not a domain another
sweep silently dropped. The only false claim was the sequencer's log line, and it is fixed.

### 132.1 One half of the probe was not evidence, and is reported as such

The sweep also tried to verify **quoted test-case names** in comments — the form *"pinned by `<test name>`"* —
by checking each quoted string against every test body. It returned 67 candidates and ~all were false: error
message strings, code fragments, and prose that happened to sit on a line containing "pin", "prove" or
"assert". Examples it flagged: `"no tests were discovered — a suite that found nothing proves nothing"` (the
Playwright guard's own detail string) and `", status, executed: false, assertions: 0, detail: "` (a fragment
of a sentinel literal).

A measurement that cannot separate its signal from its noise is not a weak result — it is **not a result**,
and reporting it as "67 unverified claims" would have manufactured a finding. §123 made the same call about a
producer/consumer split that could not distinguish its two categories. Recording the refusal, because the
temptation to publish a large number is exactly what makes it worth naming.

### 132.2 Yield, stated honestly

Two sweeps, one real defect between them, and it was §131's — found by asking a *specific* question ("does
this named sweep exist?") rather than a general one ("are comments accurate?"). The general version produced
62 clean references and 67 pieces of noise.

That is a usable rule for what remains of this audit: **cross-component claims are worth checking one at a
time, by reading, when the claim is load-bearing.** Mechanised sweeps over prose find broken *filenames* and
nothing else, because prose is where the interesting claims live and prose is what a regex cannot parse.

---

## §133 — a 4-hour SLA policed by a 24-hour detector

§132 concluded that load-bearing cross-component claims are worth checking **one at a time, by reading**.
This is one such question, in exactly §131's shape: *a backstop that exists in code but never runs is not a
backstop* — so does each sweep's **cadence** match what it polices?

**The agents worker has one cron: `crons = ["0 1 * * *"]` — daily, at 01:00.** All seven sweeps ride that
single tick (sla · collector · recon · credit-recon · retention · mirror · watchtower, plus the daily anchor).

For six of them a daily cadence is defensible — retention, mirror ingest, dunning and reconciliation are all
day-scale concerns. **The SLA sweep is not.** `SLA_REPLY_WINDOW_MS` is **four hours**, so an inbound arriving
at 02:00 is due at 06:00 and is not surfaced until 01:00 the following day: **~19 hours late, a detector six
times coarser than the thing it measures.**

**Nothing else detects it.** `sla_due_ts` is referenced in exactly three places — the projection that writes
it NULL, `setInboundSla` which sets it, and the sweep that reads it. No live query in the api worker, the
Command queues, or the ledger computes overdue on read. The daily tick is the only detector there is.

**Two facts settle whether this is a quibble.** First, `REQ-095`'s DoD is *"Timer events fire"* — no latency
bound, so a daily tick **satisfies the register as written**; this is a gap between the requirement and the
intent, not a violation. Second, `workers/billing` in this same repo already runs an **hourly** cron
(recorded at `GO-LIVE-CHECKLIST.md:272`), so sub-daily cadence is available here and simply was not chosen.

**Severity: Med, with an honest mitigation.** The primary path is the auto-reply, which completes in seconds.
The SLA sweep exists to catch replies that died mid-append (the REQ-174 backstop §103 documented), so the
affected population is small. What is at stake is *how long an unanswered customer email stays invisible*,
not whether it is answered at all.

### 133.1 Recorded, not changed

Moving the cron to hourly would re-cadence **all seven sweeps**, including retention deletes and the legacy
mirror ingest — a behaviour and cost change well beyond a latency fix, and one no REQ row authorises.
`CLAUDE.md` is explicit that scope precedes build, so this follows §131's pattern exactly: a checklist row
carrying all six elements §125 identified, with an **R3** grade and three expiry triggers (a sub-daily cron
expression, a live overdue read in the Command queues, or a latency bound added to REQ-095).

That is now the third finding this loop has recorded as **proposed scope rather than built** — REQ-180's
register alignment (§123), the booking sweep (§131), and this. All three share a shape worth naming: the code
is not wrong, the register is not wrong, and the gap is only visible when you hold them against each other
and ask what the requirement *meant*.

> **A DoD that states an event ("timer events fire") rather than a bound ("within N") cannot be violated by
> being slow.** Requirements written as existence claims are satisfied by any implementation that exists —
> which is exactly how a four-hour promise ends up with a daily detector and every gate stays green.

---

## §134 — auditing the register as a specification: 49 weak DoDs, and why only one was a gap

§133 found a four-hour SLA with a daily detector, green because `REQ-095`'s DoD reads *"Timer events fire"* —
an **existence claim**, which slowness cannot violate. That is a property of the *specification*, not the
code, so the register itself deserves the sweep: how many DoDs are written that way, and how many hide a
real gap behind them?

**Forty-nine of 289 rows** are time-sensitive (timers, sweeps, alerts, backups, exports, retention) with a
DoD naming an event rather than a bound. Rather than report 49 as a finding, the three strongest were read:

| row | DoD as written | is there a bound anywhere? |
|---|---|---|
| **REQ-114** — uptime/SLO targets per surface | *"Status monitors live"* | **Yes** — `docs/ops/slo.md` carries **31 numeric targets**: 99.9%/mo api, p95 300ms reads / 800ms mutations, POD→email p95 <5s, plus alert thresholds with severity and owner |
| **REQ-113** — per-agent cost + latency budgets | *"Budget breach alarm test"* | **Yes** — `DEFAULT_AGENT_BUDGET = { maxAvgLatencyMs: 5_000, maxAvgCostCents: 50 }` in `watchtower.ts`, with a tenant override seam |
| **REQ-135** — DR backups | *"Restore drill"* | **Yes** — the bound is in the requirement text itself: *"RPO 24h RTO 4h v1"* |
| **REQ-095** — SLA timers (§133) | *"Timer events fire"* | **No** — nowhere in the register, the ops docs, or the code |

**So a weak DoD is usually not a gap.** The specification in this build is *distributed*: the bound lives in
the requirement's own prose, or in an ops document, or as a named constant in code. The register is an
**index of scope**, not a complete acceptance spec, and reading it as the latter would produce 49 false
findings.

### 134.1 What this actually costs

The distribution is not itself a defect — but it means **nothing tells you which weak DoD is the one where no
bound exists anywhere.** REQ-095 and REQ-114 look identical in the CSV; one is fully specified in a document
three directories away and the other is specified nowhere. Only reading each candidate to exhaustion
distinguishes them, which is why §133 took a targeted read and this sweep took four.

That is the honest limit of a register audit: it can produce the *candidate list* (49 rows, mechanically) but
never the verdict. The verdict costs one careful read per row, and the yield so far is **one in four**.

### 134.2 Not proposed as a register change

Rewriting 49 DoDs to carry bounds would be a large, owner-signed amendment to an append-only register, and it
would be mostly wrong: three of the four read here are already bounded elsewhere, and restating a bound in
two places is precisely the duplication §110 and §126 spent sections undoing. The right treatment is the one
§133 already applied — when a *specific* row turns out to be unbounded everywhere, record that row.

**Phase gate, unchanged.** §126's six holds stand, and three findings now sit beside them as **proposed
scope awaiting an owner's REQ row**: REQ-180's register alignment (§123), the missing booking backstop
(§131), and the SLA cadence (§133). None is repository-closable without a row, and all three are recorded
with severity, owner, verification and expiry.

---

## §135 — the only agent with variable cost is the one that is not metered

> **Corrected 2026-08-04 (§136): "not metered" is imprecise and this section overstates it.** The
> Concierge's *convenience count* IS metered — by the per-tenant SparkMeter DO (REQ-122/125), which enforces
> a monthly AI-action allotment. What SparkMeter records is a **count only**: it carries no cost and no
> latency (verified — neither word appears in its source). So the accurate claim is narrower and still a
> gap: **the Concierge's cost-in-cents and latency-in-ms are unmetered**, which are precisely the two
> quantities REQ-113's drift alarm averages. Read the section below with that substitution.

§134 said the register audit produces a candidate list mechanically and the verdict costs a read. Continuing
those reads, `watchtower.ts` flagged itself in a comment: *"Honest: averages only REPORTED metrics."* That is
a load-bearing admission — an alarm over unreported metrics cannot fire — so it is worth asking **who
reports**.

**The metering chain.** `agent_runs` is projected from `agent.acted` only. The projection is scrupulous:
`cost` is `{cents:N}` when reported, `{}` when not (*"unknown — NOT fabricated as 0"*), and `latency_ms` is
the reported integer or NULL, *"absence, never invented"*. The Watchtower averages those rows against
`DEFAULT_AGENT_BUDGET = { maxAvgLatencyMs: 5_000, maxAvgCostCents: 50 }`.

**Who reports:**

| agent | emits `agent.acted`? |
|---|---|
| Rater (`routes/rate.ts`) | ✅ `cost_cents: 0` (an honest deterministic zero) + real wall-clock `latency_ms` |
| Translator (`translator/inbound.ts`) | ✅ same shape |
| Migrator (`routes/import.ts`) | ✅ direct `agent_runs` insert, cost deliberately absent, real latency |
| **Concierge** | ❌ **none** — verified with a control against two files that demonstrably do |

**The Concierge is the only agent that calls an LLM**, and therefore the only one whose cost is *variable at
all*. The three that report are deterministic and honestly report zero. So REQ-113's budget-drift alarm is
wired to exactly the agents whose cost cannot drift, and blind to the one whose cost can.

Nothing is *wrong* here — the projection's honesty means the metric reads UNKNOWN rather than a fabricated
zero, so no false green is produced. The alarm simply has nothing to average.

### 135.1 The gap is dormant, and its expiry trigger is the event that wakes it

`ClaudeParser` is selected only when **both** `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` are bound; anything
less yields `NotConfiguredParser`, which rejects loudly. Both are external holds
(`GO-LIVE-CHECKLIST.md:40`). **No LLM cost is incurred anywhere today**, so the gap is real but latent.

That makes its expiry trigger unusually clean: *when `ANTHROPIC_API_KEY` binds*. The single event that turns
the Concierge from deterministic to cost-bearing is the same event that makes an unmetered Concierge matter —
so the hold is recorded at **R2** (staging), ahead of the grade at which the key is expected to bind.

### 135.2 What found it

Two facts were already known and separately recorded: the `ANTHROPIC_API_KEY` external hold, and REQ-113's
drift alarm delivered in WP-11. Neither is a defect. The gap exists only in the **space between them**, and
became visible only by asking which agents feed the alarm.

That is §120's heuristic in a fourth costume — *two mechanisms, one law, and the delta between them is the
finding* — now applied not to two gates but to **a known hold and a shipped feature**. Worth naming, because
this loop's remaining yield is almost entirely in that space:

> **A hold and a feature that never mention each other can still contradict.** When an external hold
> describes a capability arriving later, ask what already-shipped mechanism assumes that capability is
> absent — and what it will do on the day it arrives.

Fourth finding recorded as proposed scope rather than built (§123, §131, §133, this).

---

## §136 — applying §135's heuristic to the second LLM surface, and correcting §135

§135's rule — *when an external hold describes a capability arriving later, ask what already-shipped
mechanism assumes it is absent* — points at a second target immediately: the same `ANTHROPIC_API_KEY` hold
also gates the **Command copilot**. Two results, one of which corrects §135 itself.

### 136.1 The Copilot's silence is correct by specification

`routes/copilot.ts` emits no `agent.acted` either — but that is **mandated, not overlooked**. `REQ-038`
specifies *"Copilot: answers cite ledger events; read-only"*, and the source states it plainly: *"It NEVER
writes (no sequencer, no append, no domain-table INSERT)."* Emitting a metering event is an append.

So REQ-113's mechanism — `agent_runs` projected from `agent.acted` — **structurally cannot cover a read-only
agent.** That is a tension between two requirements, neither wrong: REQ-038 forbids the write that REQ-113's
meter requires. The Copilot is also outside the SparkMeter path, whose own source says the cap is consulted
*"ONLY at the agent-convenience chokepoint (spark-caps.ts → concierge.ts)"*.

Recorded here rather than as a checklist row, because there is nothing to *do* without choosing between two
requirements — and that choice is the owner's, not an implementation detail.

### 136.2 §135 overstated, and is corrected in place

Reaching for the Copilot surfaced a metering path §135 had missed: the **SparkMeter DO** (REQ-122/125), a
per-tenant monthly AI-action allotment whose own header names *"the Concierge auto-quote"* as exactly what it
meters. §135 said the Concierge is "not metered." That is wrong.

What SparkMeter records is a **count** — verified directly: neither `cost` nor `latency` appears anywhere in
its source, and its purpose is quota enforcement (*"credits throttle conveniences, not truth"*), a commercial
control rather than an operational budget.

So the accurate finding is narrower and survives: **the Concierge's cost-in-cents and latency-in-ms are
unmetered** — precisely the two quantities REQ-113's drift alarm averages. Its *usage* is observed; its
*cost* is not. §135 now carries that correction at its head, and the checklist row is narrowed to match.

### 136.3 The failure mode, named

§135's error was not a bad measurement. The control was sound, the greps were scoped, the absence was real:
the Concierge genuinely emits no `agent.acted`. The mistake was in the **word chosen for the conclusion** —
"unmetered" is a claim about *all* observation, and I had checked exactly one mechanism.

> **When a probe establishes that mechanism X does not cover Y, the finding is "X does not cover Y" — not "Y
> is uncovered."** The second is a claim about every mechanism, and nothing in the probe supports it.

This is the same shape as §123 (a subset presented as a whole) and §124 (a claim scoped to what was measured,
not what it was about), now in its third appearance — and the first where I made the error *while writing a
section about that exact error*. The defence remains reading the conclusion back and asking which words the
evidence actually earns.

---

## §137 — the external-hold sweep: two clean, one narrow finding

Continuing §135's heuristic across the remaining external holds — *what already-shipped mechanism assumes
this capability is absent, and what will it do when it arrives?*

**TSA (RFC-3161) — clean.** A `tsa.timestamp()` failure records `TSA_UNAVAILABLE` and the day simply does not
anchor; the receipt document "exists IFF fully anchored", so no anchor ever claims a timestamp it did not
receive. On the day a TSA binds, the backfill is **bounded**: `MAX_DAYS_PER_RUN = 30`, oldest-first, plus a
window-independent collector for any day stranded beyond it. Fail-closed with a bounded catch-up — exactly
what the pattern asks for.

**Resend / evidence email — today's path is sound.** `NotConfiguredSender` *"validates, then rejects
LOUDLY — a silent no-op is forbidden"*, and its error is **retriable** (*"binding a provider and redelivering
succeeds"*). So with no key bound, the Biller throws, the queue redelivers, and the message parks in the DLQ:
a recoverable record, not a lost one. The invoice append is idempotent, so a DLQ replay after the key binds
re-drives without duplicating.

### 137.1 The narrow finding: the branch that is not today's path

`issued_send_pending` is returned only for a **non-retriable** send failure — a live provider issuing a
permanent rejection. On that branch:

- the invoice is issued and stands (correctly — *"money is a projection of physics"*, the send can never
  unmake the record);
- the queue consumer `console.log`s the outcome and acks;
- **nothing records it**, and `recon-sweep` cannot catch it — its anti-join finds a committed POD with **no
  invoice**, and here the invoice exists.

The Concierge's identical case is specified *and built*: `REQ-176` requires a permanently-held reply to
surface and not count as answered, and `concierge.ts` records a permanent-hold note through the DO append
surface. **The Biller has neither the REQ nor the mechanism** — a register search for a Biller equivalent
returns only REQ-170 (missing evidence *bytes*, a different case).

So demo #1's payload — *signature at a door → invoice + photos in the client's inbox* — can fail permanently
with no trace outside a log line. Dormant today, live the moment a provider binds. Recorded at **R2** with
that binding as its expiry trigger.

### 137.2 §136's lesson applied three times in one section

Each of these started as a larger claim and was narrowed by one more read:

| first draft | after reading |
|---|---|
| "the anchor may claim a timestamp it never got" | it fails closed; the receipt exists IFF anchored |
| "a lost evidence email is unsurfaced" | today it DLQs; only the non-retriable branch is unsurfaced |
| "the Biller's send failures are unrecorded" | only *permanent* failures, from a *live* provider |

That is §136's rule — *"X does not cover Y" is not "Y is uncovered"* — working as intended rather than being
learned again. The yield is smaller and the claims are true, which is the trade this loop has been converging
on since §123.

**Fifth finding recorded as proposed scope rather than built** (§123, §131, §133, §135, this).

---

## §138 — the activation map: what wakes when each hold clears

§137 observed that four of five proposed-scope findings activate on a **specific known event**. That is not a
coincidence — it is what §135's heuristic selects for. But the record stores debt by *domain* and by *owner*,
and never by **trigger**, so no document answers the question an owner actually asks before flipping a switch:
*what wakes up when I do this?*

This is that view. Every row below is already recorded elsewhere; the grouping is the new part.

| trigger event | what activates | severity · grade |
|---|---|---|
| **`PROVISIONING_ENABLED` = true** | the `/pub/signup` email-existence oracle (a distinct 409 for a taken admin email, whose only fence is the unbuilt REQ-125 edge rule) — **and** pool-binding exclusivity enforced on enumeration but not resolution (§12's pre-R4 carry-forward, fixed by a control-plane UNIQUE index) | Med · **R4** · Med · **pre-R4** |
| **`ANTHROPIC_API_KEY` binds** | the Concierge becomes cost-bearing, and its cost-in-cents / latency-in-ms are the two quantities REQ-113's drift alarm averages and cannot see (§135/§136) | Med · **R2** |
| **`RESEND_API_KEY` + `EVIDENCE_FROM` bind** | the non-retriable send branch becomes reachable: a permanently-failed evidence email surfaces nowhere, and `recon-sweep` cannot catch it because the invoice exists (§137) | Med · **R2** |
| **`REQ-289` committed or dropped** | `tools/` goes green **and** the workspace suite becomes reachable — `pnpm test` currently short-circuits before running 2,888 tests (§113) | blocking · now |
| **the nine private fixtures vendored** | four gates unblock; `identity-leak` needs its denylist secret separately (§126) | blocking · now |

**Two of these compound.** `PROVISIONING_ENABLED` is the only trigger that wakes **two** independent Med rows
at once, and neither row mentions the other or names the flag as a shared trigger — each was recorded on its
own merits, months apart. An owner reading either row alone would not learn that the flip also activates the
other.

### 138.1 Why this grouping is the useful one

Debt registers are organised for the person *recording* an item — by domain, severity, owner. That is the
wrong axis for the person *clearing* one. Every hold in this build has a moment when it stops being
theoretical, and for most of them that moment is a single deliberate act: binding a secret, flipping a flag,
vendoring a file.

> **Group debt by its activation event, not only by its domain.** The question "what is broken?" is answered
> by the ledger; the question "what will be broken *the moment I do this*?" has no answer unless someone
> builds this view.

It also explains why the §135–§137 arc found four findings in three sections after a long clean stretch:
asking *what assumes this capability is absent* is a search over the **dormant** surface, and the dormant
surface is exactly where a green build hides its debt. Nothing in it fails today, so nothing tests it, and no
gate can go red.

### 138.2 What this does not change

No new debt is recorded here and no severity moves. The five proposed-scope findings (§123, §131, §133, §135,
§137) still need owner-signed REQ rows, and §126's six holds still stand with their verification commands.
This section adds an index, not an item — and the honest note is that an index only helps if it is
maintained, so it carries the same expiry discipline as everything else: **it is accurate as of this commit,
and every row in it points at the ledger entry that owns the truth.**

---

## §139 — the billing dormant surface: clean, and clean for an instructive reason

§138's map named five activation triggers. The one it did not cover is **Stripe binding**, and it carries the
sharpest possible failure: metering accumulates per-month rows while billing is dark, so if anything invoiced
*from* that accumulation, flipping Stripe would produce a retroactive bill for months of usage — a
customer-facing failure with no undo.

**It cannot happen, and the reason is architectural.** Billing here is **purchase-driven**, not
usage-invoiced: a Stripe `checkout.session.completed` webhook becomes an `invoice.issued` carrying a
`credit_purchase` money line on the reserved `_platform` tenant, and `invoice.paid` becomes a
`payment.received`. Charges originate from **purchase events**, never from a meter reading. Searched
directly: no path anywhere creates a charge, invoice, or Stripe usage record *from* `usage_credits.metered`.

`metered` is a **read-model**: an hourly recompute-from-ledger that OVERWRITES each `(tenant, period)` blob —
never `+=`, so it is drift-free by construction. It is consumed as a **quota** (a Spark tenant's monthly
convenience allotment), not as a bill. The two writers are disjoint by design: the sweep overwrites only
`metered`, the Stripe path merges only `stripe_refs`, so their arrival order never matters.

### 139.1 The one real activation risk here was already found — by this same loop

`metering.ts` carries the concern in its own source:

> *"Claimed-aware (2026-08-01 §12): an unmetered claimed tenant is UNBILLED usage the day PLG flips."*

A metering sweep iterating only the static roster would silently miss every **claimed pool tenant**, so their
consumption would be zero on the day provisioning opened. §12 closed it — the sweep now enumerates
`allTenantSlugs(env)`.

That is §138's heuristic applied *before* §138 named it, by an earlier iteration of this audit. Worth
recording plainly: the activation-map idea was not new when §138 formalised it; it was **already in use ad
hoc**, and the one time it was applied here it caught a real gap. Formalising it is what makes it repeatable
rather than lucky.

### 139.2 The cadence comparison that indicts §133

The two workers sit side by side:

| worker | cron | polices |
|---|---|---|
| `workers/billing` | `0 * * * *` — **hourly** | a monthly usage quota |
| `workers/agents` | `0 1 * * *` — **daily** | among other things, a **four-hour** reply SLA |

The hourly sweep watches the slower-moving quantity. Nothing is wrong with the billing cadence — an hourly
recompute of a monthly figure is cheap and drift-free. But it settles the question §133 left open about
whether sub-daily scheduling was available: **it is, it is already in use, and it is in use on the concern
that needs it least.** That is not a new finding; it is the evidence that makes §133's a decision rather than
a constraint.

**Verdict: clean negative.** No new debt. The billing surface is the first dormant one swept that required no
row at all.

---

## §140 — finishing the hold sweep, and correcting "complete"

§139 closed with a table headed *"dormant-surface sweep, complete"* listing six surfaces. **That was the
§136 error in my own summary**: six is what I had swept, not what exists. The checklist carries more holds,
and calling a subset complete is exactly the failure §123 and §136 spent sections naming. Finishing it here.

**`ALLOW_TEST_SEND` / `TEST_SEND_TOKEN` — the inverse dormant surface, and exemplary.** This is a capability
that is dark and must *stay* dark: a live evidence-send probe. Its guards, read in full:

- the route 404s unless `ALLOW_TEST_SEND === "1"` — an exact match, so any other value stays inert
- bearer-token gated, and **fail-closed**: the flag set without `TEST_SEND_TOKEN` returns **500 misconfigured**, never open
- the flag is commented out in `wrangler.toml`; the token is a `wrangler secret`, never in the file
- **the recipient cannot be client-supplied** — a body carrying `to`/`recipient` is refused with an explanatory 400, defaulting to `TEST_SEND_TO` or a `delivered@resend.dev` sink
- it is the worker's *only* HTTP surface; every other path 404s, and it never touches `queue()` or `scheduled()`

The safety property is stated at the guard: *"it must be impossible for this route to email a body-supplied
address."* A dangerous capability with its own invariant written next to it, failing closed on every axis.
Clean.

**Self-hosted tiles — recorded, with a dimension its row did not name.** The Command surface uses
`DEMO_TILE_URL = "https://tiles.openfreemap.org/planet"`, and `CLAUDE.md`'s stack mandates *self-hosted
Protomaps vectors*. The hold exists and names the URLs — but frames the work purely as a deploy task ("host
tiles on R2; swap placeholders").

What it did not say is **why it matters beyond tidiness**: while the demo source is live, every map viewport
tells a third party which geographic area a dispatcher is looking at. No shipment data, PII or party identity
leaves the system — the exposure is coarse viewport bounds correlated by IP and time — but that is a
data-exposure property, not merely an un-self-hosted dependency.

**Added as a rationale on the existing row, not as a new one.** The fix already recorded (self-host) closes it
automatically, and §134 warned specifically against manufacturing findings where a bound already exists
elsewhere. A ledger inflated with rows that a single recorded action closes is harder to act on, not easier.

**The remainder have no code seam.** Device signing root key, the backups bucket, glyph PBFs, the optional
Mapbox token, per-pairing caps provisioning, the weekly telemetry series — each is an operational or
account-level act with nothing in the repo that assumes its absence. §135's heuristic returns nothing on them
because there is nothing to return: no shipped mechanism changes behaviour on the day they land.

### 140.1 The honest tally

| surface | verdict |
|---|---|
| `ANTHROPIC_API_KEY` (Concierge) | **finding** — cost/latency unmetered (§135/§136) |
| `ANTHROPIC_API_KEY` (Copilot) | spec-mandated silence — REQ-038 read-only (§136) |
| TSA RFC-3161 | clean — fail-closed, bounded 30-day backfill (§137) |
| `RESEND_API_KEY` | **finding** — non-retriable send branch unsurfaced (§137) |
| `PROVISIONING_ENABLED` | two live rows wake together (§138) |
| Stripe / billing | clean — purchase-driven, no usage invoicing (§139) |
| `ALLOW_TEST_SEND` | clean — inert, token-gated, fail-closed, sink-only (§140) |
| self-hosted tiles | recorded hold; rationale added (§140) |
| root key · backups · glyphs · Mapbox token · caps · telemetry | no code seam — operational acts only |

**Nine surfaces plus six seamless ones. Two findings, both recorded as proposed scope.** That is the sweep,
and this time the word "complete" is earned rather than assumed.

---

## §141 — the phase gate, re-measured at `78499e9`

§113 measured the stopping point at `99ae4ca`. **Twenty-eight commits have landed since**, five of them
touching source: `tools/acceptance/run.ts` (§118's files-vs-tests fix), `tools/checks/append-chokepoint.ts`
and `tools/checks/invariants.ts` (§120's widened scan globs), `tools/docs/check-table-shape.mjs` (§119's NUL
bytes), and `workers/api/src/do/sequencer.ts` (§131's corrected backstop claim). None of those had been
re-verified against the full suite. Doing that here.

| surface | result |
|---|---|
| ten static gates (runtime · invariants · rater-purity · chokepoint · authority-coverage · traceability · seed · citations · tables · design) | **all PASS** |
| `typecheck` · `lint` | **PASS** |
| workspace suite (`pnpm -r test`) | **17 workspaces · 2,888 tests · 0 failures · exit 0** |
| root `tools/` suite | 715 tests, 712 passing — **the 3 failures are `REQ-289`** |
| acceptance spine | **GREEN** — 7 files / 36 tests across 4 packages |
| `check:coverage` | **FAIL — `REQ-289` only** (1 unaccounted of 289) |

**2,888 and 0 failures is identical to §113's figure.** The two widened gate globs, the byte fix, the runner
correction and the sequencer comment changed no behaviour the suite can see — which is the right outcome for
four record fixes and one scan-coverage fix, and is the first evidence that §120's widening (six new glob
patterns across two gates) did not accidentally catch anything pre-existing.

### 141.1 The four §126 hold-table commands, re-run

Every verification cell in §126's table was executed again at this commit rather than assumed:

- `pnpm check:coverage` → exit 1, *"1 unaccounted register row"* ✅ as documented
- `pnpm check:fixtures -- --mode merge` → exit 2 BLOCKED, naming all nine ✅
- `pnpm check:identity -- --mode merge` → exit 2 BLOCKED ✅

That is the property §126 built the table for: a reader six weeks out can establish which rows are still live
by running three commands. Three commands, three matching verdicts.

### 141.2 What the loop has produced

| | |
|---|---|
| commits | **75** |
| audit sections | **131** |
| source-file touches | 26 |
| findings recorded as **proposed scope** (owner REQ row required) | **5** — §123 REQ-180 alignment · §131 booking backstop · §133 SLA cadence · §135 Concierge cost metering · §137 unsurfaced send failure |
| repository-closable debt remaining | **none identified** |

**The stopping point is unchanged and re-earned.** §126's six holds stand with verified commands; §123's
scoping (the repo-adjacent subset, with `GO-LIVE-CHECKLIST.md` as the authoritative enumeration) stands;
§138's activation map indexes what wakes on each trigger. Every remaining item needs an owner: a register row
to commit, fixtures to vendor, secrets to bind, a flag to flip, or five REQ rows to sign.

Nothing in this section is new work. It is the measurement that lets the previous forty sections be trusted
at a specific commit — which is the only form a phase gate can honestly take.

---

## §142 — the MCP surface: REQ-030 parity is structural, and the chokepoint's order is pinned

The MCP worker is demo #4's subject, externally reachable (Claude connects to it), and had never been audited
in this loop. The governing question is `CLAUDE.md` rule 3 / REQ-030: **any flow reachable by API must
enforce the same gate.** MCP reaches the same ledger through a different door.

**Parity is structural, not maintained.** Every MCP write tool delegates to `mutatingCallApi` — the tools are
clients of `/v1` over HTTP. None binds the sequencer DO, none opens D1, none issues raw SQL. So every gate the
api enforces applies automatically, and there is no second gate implementation that could drift. That is the
strongest possible answer to REQ-030: not "we keep them in sync" but "there is only one."

**MCP's own gate layer complements rather than duplicates.** `beforeMutation` enforces **caps + confirm over
the OAuth principal** — policy the MCP layer owns, which the api has no principal to evaluate. Its header is
explicit that this is additive: *"the api still runs its own gates on the callApi round-trip (there is no
bypass)."*

### 142.1 The chain's design rationale, and its proof

`DEFAULT_MUTATION_CHECKS` is an explicit array, and the source states why it is not a registration list:

> *a module-global `registerMutationCheck` at import time … fails OPEN (a forgotten import, or a bundler
> treating a "side-effect-free" check module as dead code, silently leaves caps+confirm unenforced while
> everything still compiles and passes).*

That is a fail-open failure mode identified and designed out. Two tests pin it — `toBe(DEFAULT_MUTATION_CHECKS)`
(the live chokepoint **is** that array by identity) and `toEqual(["confirm", "caps"])` (exact contents **and
order**). Mutation-proved against a valid baseline of 177:

| mutation | verdict |
|---|---|
| remove `confirmCheck` | **RED — 10 failed** |
| remove `capsCheck` | **RED — 17 failed** |
| **swap the order** (caps before confirm) | **RED — 3 failed** |

The reorder result is the one worth keeping. Order here is load-bearing for a stated reason: *"a
missing/mismatched confirm must refuse BEFORE caps reserves a slot, else a confirm-failed booking would
permanently consume the pairing's own budget (a self-DoS)."* A chain that pins membership but not sequence
would let that regression through silently. This one pins both.

### 142.2 One duplication found, and deliberately not recorded

`MUTATING_METHODS` in the MCP registry carries the comment *"Mirrors the api middleware's own set"* — a
constant duplicated across two workers, which is exactly §120's shape. Compared: both are
`["POST","PUT","PATCH","DELETE"]`, identical.

**Not recorded as debt.** The set is HTTP's mutating verbs — closed and stable for decades — so the
divergence risk is theoretical rather than real, and §134 and §140 both established that a ledger inflated
with rows nobody will ever act on is harder to use, not safer. Noting the judgement here so a future reader
sees the duplication was found and *dismissed on the evidence*, rather than missed.

### 142.3 My first probe was garbage, and is discarded

The initial mutation split the chain array on commas — but the array body is mostly **comments**, which
contain commas. It produced eight "entries" like `IN`, `else`, `so` and `//`, mutated comment text, and
reported four confident **GREEN — check UNPINNED** results.

Every one was an artifact. That is §117.1's rule (*mutating an annotation is not mutating a mechanism*)
combined with a parser that never verified its own output was plausible — eight entries in a two-entry array
should have stopped me before the first run, exactly as §127's implausible yield did.

Discarded rather than reported, and the correct probe anchored on the bare identifier lines instead.
