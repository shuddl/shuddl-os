# Launch Runbook — the ordered path from code-complete to deployed

**As of 2026-07-30 · HEAD `7f5b06a`.** V1 is code-complete: `pnpm test` = 3,249 tests / 18 suites green,
and `pnpm verify:merge` reports 16 gates PASS. Nothing below is a code task. Every remaining item needs an
input that does not exist inside this repository, which is why the build cannot advance itself past this
point.

> **RUN RECORD, 2026-08-01: Steps 0–5 of this runbook were EXECUTED on 2026-07-30/31.** The account
> question resolved (the product account `89618ce…` holds everything — Step 0's warning was the
> two-account confusion it suspected), resources were provisioned, secrets bound, migrations applied,
> `preflight --env prod --state <file>` → **PASS, 72 checks**, the workers and the three surfaces
> deployed, and a prod backup taken (`tools/deploy/backup.ts` — the "no way to back up production" gap
> below was CLOSED before the run; the paragraph is kept as history). The sweep record:
> `RELEASE-EVIDENCE.md` § *Production preflight — PASS* and § *Release sweep — 2026-07-31*. What still
> waits on an owner: tenant onboarding, the `EVIDENCE_FROM` sending flip (REQ-159), the five private
> fixture gates, nightly OIDC credentials, and the ledgered holds in `GO-LIVE-CHECKLIST.md`.

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
  "corsOrigins": ["https://command.shuddl.tech", "https://portal.shuddl.tech", "https://driver.shuddl.tech", "https://track.shuddl.tech"],
  "sender": { "from": "SHUDDL <pod@send.shuddl.tech>", "domainVerified": true },
  "tsa": { "url": "https://freetsa.org/tsr" },
  "backups": { "lastManifestAt": "<ISO timestamp of the run below>", "retentionDays": 30 }
}
```

The values are yours to decide — the origins must be the real prod hostnames (a `.example` placeholder is
rejected), and the TSA must be a reachable RFC 3161 endpoint (staging uses `freetsa.org/tsr`).

~~**The backup needs work before it can run against prod, and this is a real gap.** There is no
`tools/deploy/backup.ts`. The only backup implementation is inline in `.github/workflows/nightly.yml`, and
its export loop **hardcodes the four staging database names**:~~

```text
shuddl-control-staging  shuddl-t-tenant-a-staging  shuddl-t-tenant-b-staging  shuddl-t-platform-staging
```

~~So there is no way to back up production today.~~ **CLOSED before the launch run (audit D4, corrected
2026-08-01): `tools/deploy/backup.ts` exists (`pnpm backup -- --env <env>`), derives the database set from
the wrangler configs rather than a hardcoded list, and a PROD backup ran on 2026-07-31 — 6 databases,
manifest digest `47e4d9ec…`, `backup-manifest` gate PASS assertions=6 (`RELEASE-EVIDENCE.md`).**
`tools/deploy/restore-verify.ts` consumes the SHA-256 manifest it writes, so the manifest format is fixed
and must not change; `lastManifestAt` for prod is honestly fillable from that run — and per
`docs/ops/dr-backups.md` a database with no backup is the one hold that turns a bad day into an
unrecoverable one, which is why the NIGHTLY credentials (still unbound) remain a ledgered hold.

```bash
# once a prod backup exists:
pnpm exec tsx tools/deploy/preflight.ts --env prod --state prod-state.json   # expect PASS
```

**For `verify:release`, export the path instead of passing it.** `run-gate` invokes the preflight as
`pnpm -s preflight -- --mode release` and has no channel for a path argument, so a flag-only reader made
`deploy-preflight` structurally incapable of reporting PASS no matter how completely the account satisfied
it. Use the env var, which the spawn inherits:

```bash
export PREFLIGHT_STATE="$PWD/prod-state.json"        # NEVER commit this file — it names secrets
pnpm exec tsx tools/deploy/preflight.ts --env prod   # same PASS, via the same channel the gate uses
```

Every run now prints which channel supplied the path (`state file … (via PREFLIGHT_STATE)`). Read that
line: the flag parser accepts only the space-separated form, so a typo'd `--state=/path.json` is invisible
to it and the run silently falls back to whatever `PREFLIGHT_STATE` is already exported in your shell —
possibly stale facts, reported as a PASS.

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

### Then the three browser surfaces

One command, because the order inside it is load-bearing:

```bash
pnpm deploy:surfaces   # build (bakes VITE_API_BASE) → check:surfaces --built → wrangler deploy ×3
```

**Do not deploy a surface with a bare `wrangler deploy`.** The API base is read at BUILD time. A bundle
built without `VITE_API_BASE` renders its entire chrome against a host that cannot resolve, so every call
fails as a NETWORK error rather than an auth error — empty panels, no warning, a page that looks perfectly
deployed and can never work. `check:surfaces -- --built` exists to refuse exactly that bundle, and running
`wrangler` directly skips it.

The driver PWA is the one where this is unrecoverable rather than merely wrong: its service worker would
cache the SPA shell under an API path on a driver's phone and keep serving it across redeploys.

Four hostnames come up, on three workers — `track.shuddl.tech` is a route inside the portal bundle, not a
fourth surface. Custom domains mean Cloudflare creates the DNS records and certificates; nothing is
hand-made. Every hostname is single-label because universal TLS covers `*.shuddl.tech` and **not** a
second label (`api.staging.shuddl.tech` failed the handshake; `api-staging.shuddl.tech` did not).

## Step 5 — prove it

```bash
SMOKE_API_BASE=https://<prod-api-host> pnpm exec tsx tools/deploy/staging-smoke.ts --mode release

# The surfaces, in a real browser: each must reach api.shuddl.tech and no other host, and must admit
# it has no session rather than rendering a calm empty board.
PROD_SURFACE_BASE=shuddl.tech pnpm test:surfaces

# The restore drill. restore-verify reconciles two snapshots — capture them first; nothing else writes them.
pnpm snapshot:ledger -- --db <source-db> --tenant <tenant> --out /tmp/source.json
pnpm snapshot:ledger -- --db <restored-db> --tenant <tenant> --out /tmp/restored.json --rows-out /tmp/rows.json
pnpm exec tsx tools/deploy/restore-verify.ts \
  --source /tmp/source.json --restored /tmp/restored.json --rows /tmp/rows.json --mode release

PREFLIGHT_STATE="$PWD/prod-state.json" pnpm verify:release
```

**`--rows` is not optional.** Omit it and the two chain dimensions are not checked at all — the run reports
`9` of 11 and comes back **BLOCKED**, never PASS. Re-walking the chain is the only dimension that
independently re-proves the restored ledger rather than comparing a snapshot's metadata to itself: a
mid-stream `prev_hash` flip leaves row count, head hash and every money figure byte-identical.

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
