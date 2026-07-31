# Surfaces + Remaining Provable Gates Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Put the three browser surfaces on the internet against the live production API, and close every remaining gate that does not require private engagement data.

**Architecture:** The backend is deployed and `preflight --env prod` PASSes; there is no UI. The apps are Vite SPAs with no deploy path and an API base that still defaults to a synthetic `.example` host. This plan builds the deploy path, ships the surfaces, then closes three self-inflicted gaps the last session recorded rather than fixed: the release gate cannot see the preflight's state, a restore has never been reconciled against a real backup, and `provision-prod` creates before it refuses.

**Tech Stack:** Cloudflare Workers (Static Assets), wrangler 4, Vite 8, React 19, TypeScript strict, Vitest, Playwright.

---

## Execution rules

- Work on `main` in `/Users/spencerpro/Desktop/shuddl-os`. Begin EVERY bash call with `cd /Users/spencerpro/Desktop/shuddl-os || exit 1` — the Bash tool's cwd silently reverts between calls.
- Prefix every command with `PATH=/Users/spencerpro/.nvm/versions/node/v22.15.0/bin:$PATH`.
- **Never `export PATH=` with a partial path** — it clobbers the system path and `curl` disappears. Prefix, don't export.
- Cloudflare: account `89618cedec5696ac1ab82362e5500f16` (the PRODUCT account — it holds `shuddl.tech` and the `shuddl-*` resources). The operator supplies `CLOUDFLARE_API_TOKEN`; **never commit it**.
- Machine load spikes hard. `Test Files no tests` + `Failed to start forks worker` is load — check `uptime`, wait, re-run. Never report a load artifact as a failure.
- After each task: its focused tests, then `pnpm check:coverage` (288/288, 0 unaccounted, drift 7), `check:traceability`, `check:citations`, `pnpm lint`, and `git diff --check`.
- **A gate hazard:** a bare `REQ-\d{3}` in any non-excluded file counts as an implementation annotation (`tools/traceability/orphans.ts`). `docs/ops/GO-LIVE-CHECKLIST.md` additionally feeds `scanRecordedHomes()` — removing a REQ id there drops a deferred row's home and fails `check:coverage`. Verify with a before/after set-diff of REQ ids whenever you touch it.

## Verified starting state (2026-07-31, HEAD `fb33fbc`)

| Fact | Value |
|---|---|
| `preflight --env prod --state <file>` | **PASS**, 72 checks |
| Deployed workers | api (`api.shuddl.tech`), mcp, billing routed; agents + translator deliberately routeless |
| `staging-smoke` | **PASS**, 14 assertions, penny parity held on live infra |
| Prod databases | 6, migrated (5 tenant planes @ 19 tables, control @ 5) |
| Prod control tenants | **3, all system**: `_platform`, `_pool_01`, `_pool_02` — no real tenant |
| **Browser surfaces** | **NONE deployed.** `command/portal/driver/track.shuddl.tech` have no DNS |
| App API base | `DEFAULT_API_BASE = "https://api.shuddl.example"` — synthetic, per `apps/command/src/lib/api.ts:17` |
| App scripts | `dev`, `build`, `typecheck`, `test` only — **no deploy** |
| `verify:release` | BLOCKED ×9; 5 need private fixtures, 4 are addressed here |

**TLS constraint, learned the hard way:** Cloudflare universal TLS covers `*.shuddl.tech` but **not** a second label. `api.staging.shuddl.tech` fails the handshake; `api-staging.shuddl.tech` works. Every hostname in this plan is single-level.

---

## Task 1: Let the release gate see the preflight's state

`tools/release/run-gate.ts:74` invokes `preflight` with only `--mode`. `preflight` reads its state file from a `--state` CLI flag and nothing else, so the release profile's `deploy-preflight` is **structurally incapable** of reporting PASS — it reported BLOCKED yesterday while the same tool with `--state` reported PASS. A gate that cannot express the truth is worse than no gate.

**Files:**
- Modify: `tools/deploy/preflight.ts` (the `main()` argv/env read, ~line 539)
- Modify: `tools/deploy/preflight.test.ts`

**Step 1: Write the failing test**

```ts
it("reads its state file from PREFLIGHT_STATE when no --state flag is given", () => {
  // run-gate invokes `pnpm preflight -- --mode release` and cannot pass a path, so an env var is the
  // only channel. Without it the release profile can never see a satisfied account-side fact.
  const dir = mkdtempSync(join(suiteTempRoot, "state-"));
  const p = join(dir, "state.json");
  writeFileSync(p, JSON.stringify({ tsa: { url: "https://freetsa.org/tsr" } }));
  expect(resolveStatePath([], { PREFLIGHT_STATE: p })).toBe(p);
  // An explicit flag always wins over the env var.
  expect(resolveStatePath(["--state", "/flag/path.json"], { PREFLIGHT_STATE: p })).toBe("/flag/path.json");
  expect(resolveStatePath([], {})).toBeUndefined();
});
```

**Step 2: Run it and watch it fail**

`pnpm exec vitest run --config vitest.tools.config.ts tools/deploy/preflight.test.ts`
Expected: FAIL — `resolveStatePath` is not exported.

**Step 3: Implement**

Extract and export a pure `resolveStatePath(argv: string[], env: NodeJS.ProcessEnv): string | undefined` that prefers `--state`, falls back to `env.PREFLIGHT_STATE`, else `undefined`. Call it from `main()`. Document at the call site WHY the env var exists (run-gate cannot pass a flag).

**Step 4: Verify**

```bash
pnpm exec vitest run --config vitest.tools.config.ts tools/deploy/preflight.test.ts   # PASS
PREFLIGHT_STATE=/tmp/prod-state.json pnpm exec tsx tools/deploy/preflight.ts --env prod  # PASS
```
Build `/tmp/prod-state.json` from the template in `docs/ops/LAUNCH-RUNBOOK.md` Step 3. **Do not commit it.**

**Step 5: Commit**

```bash
git add tools/deploy/preflight.ts tools/deploy/preflight.test.ts
git commit -m "fix(release): the release gate could not see a satisfied preflight

run-gate invokes preflight with --mode only, and preflight read its state file
from a --state flag alone — so deploy-preflight was structurally unable to
report PASS no matter what was true of the account. PREFLIGHT_STATE closes it;
an explicit flag still wins."
```

---

## Task 2: Reconcile a restore against the real backup

`restore-verify` has never run. A backup nobody has restored is a hope, not a backup — and `docs/ops/dr-backups.md` makes that the whole point of the gate.

**Files:**
- Modify: `docs/ops/dr-backups.md` (add the drill's recorded result; **preserve its line count** — five `dr-backups.md:N` citations in `GO-LIVE-CHECKLIST.md` point into it)

**Step 1: Read the tool's contract first**

```bash
sed -n '1,60p' tools/deploy/restore-verify.ts
grep -n "source\|restored\|rows" tools/deploy/restore-verify.ts | grep flag
```
It takes `--source` and `--restored` snapshots and an optional `--rows`. Understand what a snapshot is before producing one.

**Step 2: Take a fresh prod backup**

```bash
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
  pnpm backup -- --env prod --out /tmp/restore-drill --mode release
```

**Step 3: Restore into a scratch database and reconcile**

Create a throwaway D1 (`shuddl-restore-drill`), apply the exported SQL to it, produce the two snapshots the tool wants, and run:

```bash
pnpm exec tsx tools/deploy/restore-verify.ts --source <src> --restored <restored> --mode release
```
Expected: PASS with a `##SHUDDL-GATE##` line. **Delete the scratch database afterwards** — `wrangler d1 delete shuddl-restore-drill`.

**Step 4: Record and commit**

Record the drill (date, digest, verdict) in `dr-backups.md` without changing its line count. Commit.

**If the reconciliation FAILS, stop and report.** A failing restore on a real backup is a Critical finding, not a task to push through — the databases are currently schema-only, so a failure here is about the tooling, and it is far cheaper to learn it now than after there is freight in them.

---

## Task 3: Close the provision-prod orphan window

Recorded OPEN in `docs/ops/GO-LIVE-CHECKLIST.md`: `--apply` resolves ids only in a pre-create pass that sees nothing in an empty account, so all 9 resources are created before the post-create clobber check aborts. A wrong `--account-id` that clears the marketing heuristic leaves 9 orphans.

**Files:**
- Modify: `tools/deploy/provision-prod.ts`
- Modify: `tools/deploy/provision-prod.test.ts`

**Step 1: Write the failing test**

Against the synthetic fixture already in that suite: given configs carrying REAL ids and an account containing none of them, `--apply` must **create nothing** and abort. Assert the io seam recorded zero creates.

**Step 2: Run it and watch it fail** — expect 9 creates today.

**Step 3: Implement** — run the clobber check against the *planned* resources before the create loop, not only after. Keep the existing post-create check as a belt-and-braces guard.

**Step 4: Verify + mutation-prove** — remove the pre-create check, confirm the new test goes RED, restore.

**Step 5: Commit**, and flip that ledger row to FIXED with the evidence (do not remove any REQ id from the file).

---

## Task 4: A deploy path for the browser surfaces

There is none. Three Vite SPAs with `build` and nothing else.

**Files:**
- Create: `apps/command/wrangler.toml`, `apps/portal/wrangler.toml`, `apps/driver/wrangler.toml`
- Modify: `apps/*/package.json` (add `deploy`)
- Modify: `package.json` (a root `deploy:surfaces`)

**Step 1: Establish the precedent before inventing one**

```bash
pnpm exec wrangler --version
```
The `shuddl-tech` worker already serves a static site from this account — **inspect how** (`wrangler deployments`, and look for an `assets` binding) and follow it. Do not invent a second pattern for the same job. If it uses Workers Static Assets (`[assets] directory = …`), use that; if Pages, use that.

**Step 2: Write the config for ONE app first (`command`)**

Name `shuddl-command-prod`, single-level route `command.shuddl.tech/*`, `zone_name = "shuddl.tech"`, assets from `dist`. SPA routing must serve `index.html` for unknown paths or a deep link 404s.

**Step 3: Build and deploy just that one**

```bash
VITE_API_BASE=https://api.shuddl.tech pnpm --filter @shuddl/command exec vite build
cd apps/command && pnpm exec wrangler deploy
```
Then create the proxied `AAAA 100::` DNS record for `command` (the zone's existing pattern) and verify:

```bash
/usr/bin/curl -s -o /dev/null -w "%{http_code}\n" https://command.shuddl.tech/
```
Expected 200. **Confirm the API base actually baked in** — grep the built bundle for `api.shuddl.tech` and confirm `api.shuddl.example` is absent. A surface silently pointing at the synthetic host would look fine and do nothing.

**Step 4: Commit, then repeat for portal and driver** — one commit each, verifying each before moving on.

---

## Task 5: Prove a surface talks to the live API in a real browser

A deployed page that 200s proves it was uploaded, nothing more.

**Files:**
- Create: `tests/e2e/prod-surface.spec.ts`

**Step 1: Write the test** — load `https://command.shuddl.tech/`, assert the board chrome renders, and assert a request goes to `https://api.shuddl.tech` (not `.example`, not localhost). It will be **401/empty** without a session, and that is the expected, correct result: assert the surface handles it honestly rather than showing fabricated data.

**Step 2: Run it** against the deployed surface, headed once so you SEE it.

**Step 3: Decide its gate home** — this hits the public internet, so it does NOT belong in the merge profile. Put it behind an env guard (`PROD_SURFACE_BASE`) so it self-skips locally, mirroring `staging-smoke`'s posture.

**Step 4: Commit.**

---

## Task 6: Reconcile the record

**Files:** `docs/ops/PROJECT-STATE.md`, `docs/ops/RELEASE-EVIDENCE.md`, `docs/ops/GO-LIVE-CHECKLIST.md`, `docs/ops/LAUNCH-RUNBOOK.md`

Record: the surfaces are deployed and at what hostnames; the restore drill's verdict; the two ledger rows that flip to FIXED; and the four `verify:release` gates that changed. Re-run `verify:release` and record the real new count.

**State plainly what is still NOT true**, because it will be tempting to imply otherwise once there is a UI:
- **No real tenant is onboarded.** Prod control holds only `_platform`, `_pool_01`, `_pool_02` — all system rows from migration seeds. Nobody can log in.
- Five gates still BLOCK on private engagement fixtures and the identity denylist.
- Outbound email is **dark** in prod (`EVIDENCE_FROM` absent → `NotConfiguredSender`).
- The production tile source is still a public demo host (REQ-075).

---

## Out of scope (do not do here)

- **Onboarding a real tenant.** That needs the tenant-0 config pack from the engagement workspace (`genesis/13`) and is a business decision, not a deploy step.
- **Vendoring the nine fixtures or the identity denylist.** They are real tenant data; synthesising them would make five gates lie about the only thing they check.
- **Enabling outbound email in prod.** Binding `EVIDENCE_FROM` is a separate, deliberate decision with its own blast radius.
- **Self-hosting Protomaps tiles** (REQ-075) — a documented hold.
