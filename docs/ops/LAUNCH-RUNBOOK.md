# Launch Runbook — the ordered path from code-complete to deployed

**As of 2026-07-30 · HEAD `7f5b06a`.** V1 is code-complete: `pnpm test` = 3,249 tests / 18 suites green,
and `pnpm verify:merge` reports 16 gates PASS. Nothing below is a code task. Every remaining item needs an
input that does not exist inside this repository, which is why the build cannot advance itself past this
point.

This file exists so that launch is **five owner actions**, each one command, rather than a research project.
Read `docs/ops/DEPLOYMENT.md` for the mechanics of each tool and `docs/ops/GO-LIVE-CHECKLIST.md` for the
full hold ledger; this is the ordered sequence and nothing else.

---

## The gate, decomposed

`pnpm exec tsx tools/deploy/preflight.ts --env prod` → **BLOCKED, 26**. That number is not one problem:

| Count | Code | Cleared by | Step |
|---|---|---|---|
| 19 | `placeholder-resource-id` | provisioning real Cloudflare resources | **1** |
| 4 | `missing-secret` | `wrangler secret put` ×4 | **2** |
| 1 | `no-origins` | a `--state` file naming the prod origins | **3** |
| 1 | `tsa-unconfigured` | a `--state` file naming an RFC 3161 endpoint | **3** |
| 1 | `no-backup` | one backup run, then `--state` | **3** |

Steps 1–3 clear all 26. Step 4 deploys. Step 5 proves it. The nine engagement fixtures (below) are a
*separate* track: they gate `verify:merge`, not the deploy.

---

## Step 0 — decide which Cloudflare account is the product account

**Do this first; getting it wrong is the only irreversible mistake in this runbook.**

**Measured 2026-07-30.** `wrangler whoami` lists **exactly one** reachable account (OAuth). That account
contains the worker `shuddl-tech` (the marketing site) and:

- **no** `shuddl-api-staging`, **no** `shuddl-agents-staging`
- **zero** `shuddl-*` D1 databases, out of 20
- **zero** `shuddl-*` KV namespaces, out of 36

So the product environment is **not reachable from this workstation**. Either it lives in a second
Cloudflare account (multi-account is a known fact here — the `shuddl.tech` zone was previously found in a
different account), or it does not exist. `docs/ops/PROJECT-STATE.md` claims a deployed, live-sending
staging environment; that claim now carries a dated warning because it could not be confirmed.

**Resolve this before Step 1.** Provisioning the freight ledger's production databases into the marketing
account would put customer freight data in the wrong tenancy and point all five worker configs at ids the
deployed workers cannot bind — and it is the one step in this runbook that is expensive to undo.

```bash
pnpm exec wrangler whoami                 # which accounts can you reach?
pnpm exec wrangler login                  # if the product account is not listed, authenticate to it
pnpm exec wrangler d1 list --account-id <ID> | grep shuddl   # the product account HAS shuddl-* databases
```

Pick the account that already holds `shuddl-api-staging`. Note its id — every later command takes it. If no
account holds it, then staging is gone and you are standing up production first, which is a different
decision than this runbook assumes: say so explicitly before proceeding.

## Step 1 — provision the 19 resources (clears 19 BLOCKs)

```bash
# ALWAYS dry-run first. This is the default; it creates nothing.
pnpm provision:prod --account-id <PRODUCT_ACCOUNT_ID>

# When the plan reads correctly:
pnpm provision:prod --account-id <PRODUCT_ACCOUNT_ID> --apply
```

What it does: creates the 6 logical D1 databases, the 2 KV namespaces and the R2 bucket
`shuddl-evidence-prod`, then writes the real ids into the `[env.prod]` scope of all five
`workers/*/wrangler.toml`. It is idempotent (adopts existing resources by name, so a second `--apply` is a
no-op) and refuses to overwrite a non-placeholder id without `--force`.

**It does not merely warn about the wrong account — it stops.** `--account-id` is mandatory, the account's
worker/D1/KV/R2 inventory is printed before anything is created, `--apply` makes you retype the account id,
and an account holding `shuddl-tech` but no `shuddl-api-staging` ABORTS the run at exit 2 (override with
`--override-account-warning` only if you are certain). This is not hypothetical: the first dry-run pointed at
the default-reachable account, and that account is the marketing one.

**Token prerequisite:** the API token needs an R2 scope (Workers R2 Storage: Edit) alongside d1 and
workers_kv. Without it the bucket list cannot be read at all, and the tool refuses to `--apply` rather than
mistake an unreadable store for an empty one and fail on the bucket after the databases exist.

**The property to check in the dry-run output:** a shared binding must show ONE id across every worker that
binds it. `TENANT_A_DB` appears in api, agents, billing and translator — four workers, one id. If those
diverge, `preflight` reports `binding-drift` and the deploy is wrong even though every id is real.

Commit the patched configs. Then:

```bash
pnpm exec tsx tools/deploy/preflight.ts --env prod   # expect 26 -> 7
```

## Step 2 — bind the four secrets (clears 4 BLOCKs)

```bash
pnpm exec wrangler secret put JWT_SECRET               --env prod   # api, mcp
pnpm exec wrangler secret put RESEND_API_KEY           --env prod   # agents (evidence email)
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET    --env prod   # billing
pnpm exec wrangler secret put PLATFORM_INTERNAL_SECRET --env prod   # billing -> api internal surface
```

Run each from the owning worker's directory. Secrets never enter this repository (REQ-154) — the preflight
cannot see them either, which is why they must be declared in the `--state` file at Step 3.

**A deliberate omission to preserve:** `[env.prod]` for agents binds **no** `EVIDENCE_FROM`, so
`evidenceSender()` stays a `NotConfiguredSender` and production cannot send a single evidence email until
someone consciously turns it on. Same for the translator's `EDI_TRANSPORT_URL`/`_TOKEN`, which stay dark
because that transport is CONFIRM-gated (REQ-154). Both absences are test-locked. Do not "complete" them
while provisioning; enabling outbound sending is its own decision with its own blast radius.

## Step 3 — supply the account-side facts (clears the last 3 BLOCKs)

The preflight cannot read your account, so it treats unproven as blocked. Give it a state file:

```jsonc
// prod-state.json — NOT committed; it names secrets and origins
{
  "secrets": {
    "JWT_SECRET": "bound",
    "RESEND_API_KEY": "bound",
    "STRIPE_WEBHOOK_SECRET": "bound",
    "PLATFORM_INTERNAL_SECRET": "bound"
  },
  "corsOrigins": ["https://command.shuddl.tech", "https://portal.shuddl.tech", "https://driver.shuddl.tech"],
  "sender": { "from": "SHUDDL <pod@send.shuddl.tech>", "domainVerified": true },
  "tsa": { "url": "https://freetsa.org/tsr" },
  "backups": { "lastManifestAt": "<ISO timestamp of the run below>", "retentionDays": 30 }
}
```

The values are yours to decide — the origins must be the real prod hostnames (a `.example` placeholder is
rejected), and the TSA must be a reachable RFC 3161 endpoint (staging uses `freetsa.org/tsr`).

**The backup needs work before it can run against prod, and this is a real gap.** There is no
`tools/deploy/backup.ts`. The only backup implementation is inline in `.github/workflows/nightly.yml`, and
its export loop **hardcodes the four staging database names**:

```
shuddl-control-staging  shuddl-t-tenant-a-staging  shuddl-t-tenant-b-staging  shuddl-t-platform-staging
```

So there is no way to back up production today. Either parameterise that loop by environment or extract it
into a script; `tools/deploy/restore-verify.ts` already consumes the SHA-256 manifest it writes, so the
manifest format is fixed and must not change. Until that is done, `lastManifestAt` for prod cannot honestly
be filled — and per `docs/ops/dr-backups.md` a database with no backup is the one hold that turns a bad day
into an unrecoverable one.

```bash
# once a prod backup exists:
pnpm exec tsx tools/deploy/preflight.ts --env prod --state prod-state.json   # expect PASS
```

## Step 4 — deploy, api first

The api worker owns the `ShipmentSequencer` Durable Object that agents, billing, translator and mcp bind
across scripts. Deploy it first or those bindings resolve to nothing:

```bash
cd workers/api        && pnpm exec wrangler deploy --env prod
cd ../agents          && pnpm exec wrangler deploy --env prod
cd ../billing         && pnpm exec wrangler deploy --env prod
cd ../mcp             && pnpm exec wrangler deploy --env prod
cd ../translator      && pnpm exec wrangler deploy --env prod
```

Then apply migrations to each provisioned D1 (`db/tenant/migrations/`, `db/control/migrations/`) per
`docs/ops/DEPLOYMENT.md`. **Migrate before smoking** — a deployed worker against an unmigrated database
fails on its first append.

## Step 5 — prove it

```bash
SMOKE_API_BASE=https://<prod-api-host> pnpm exec tsx tools/deploy/staging-smoke.ts --mode release
pnpm exec tsx tools/deploy/restore-verify.ts --mode release   # after a real backup exists
pnpm verify:release
```

`staging-smoke` drives a gated stop through to a penny-exact `invoice.issued` over real HTTPS. Until it has
run against prod, no document should describe production as certified.

---

## The separate track: nine engagement fixtures

These gate `verify:merge` — **not** the deploy. Production can be provisioned, deployed and smoked with
them still absent; what stays unproven is that the pricing and migration engines match the real legacy
system.

```
rater-48-tests · rater-504-sweep · zone-tariff-v1 · invoice-500-replay · concierge-parse-50
customer-roster · legacy-import-formats · legacy-export-replay · synthetic-blitz-3100
```

Every one carries `source: manifest.private M-xx` in `fixtures/manifest.json` — they are references into the
tenant-0 engagement workspace, deliberately outside this repo (REQ-167, genesis/13). Vendoring them clears
five gates: `fixtures`, `rater-parity`, `invoice-parity`, `concierge-parse`, and (with the denylist)
`identity-leak`.

**They cannot be synthesised.** The in-repo synthetic smoke sets already exist and already run — `fixtures/`
is where the *real* data proves what synthetic data cannot: penny-exact agreement with the legacy system and
±2% aggregate on a 9,314-bill export replay. Generating plausible fixtures to turn those gates green would
make the gates lie about the one thing they exist to check. If the real data is unavailable, the honest move
is to waive the gates explicitly in the register, not to feed them inventions.

`identity-leak` additionally needs the `IDENTITY_DENYLIST` secret (or `.identity-denylist.local`) — the list
of tenant/person/vendor names that must never appear in a repo artifact. Without it that gate is BLOCKED in
CI and reports `Lint SKIPPED` locally, so REQ-167 is unverified on every local run.

---

## What is NOT on this list, and why

- **On-call rota** and the **7-year archive tier** are two open holds with no executable gate at any profile.
  No command can observe them; they need a named human and an implementation decision respectively.
- **Self-hosted Protomaps tiles and glyphs** (REQ-075) remain a documented hold. All three surfaces still
  point at a public demo tile host. The blessed screenshots block it from the visual capture, so CI is
  insulated, but production cartography is not self-hosted.
- **`verify:release`** is in no CI workflow; it is operator-run. Nothing will notice if a release record is
  never produced.
