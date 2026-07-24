# Deployment runbook

**Environments:** `dev` = the default (top-level) wrangler config, used by the 1,131-test suite + local `wrangler dev` (its `database_id`s are `local-*` placeholders — never deployed). `staging` = a real, deployed Cloudflare environment (`[env.staging]` blocks), **synthetic data only, evidence sending OFF**. `prod` = not stood up (gates on F1-B/C + the M-H milestone — genesis/12,14).

## Staging — what's deployed (first stood up 2026-07-14)

| Worker | Name | Notes |
|---|---|---|
| API | `shuddl-api-staging` | HTTPS + the `ShipmentSequencer` DO; deploy **first** |
| Agents (Biller) | `shuddl-agents-staging` | queue consumer + cron; binds the api's DO cross-script; deploy **second** |

**Resources (all `shuddl-*-staging`, isolated from any other account project):**

| Kind | Name / id |
|---|---|
| D1 tenant-a | `shuddl-t-tenant-a-staging` · `1742fef3-f7bf-4d1a-9aaa-bf9366994528` |
| D1 tenant-b | `shuddl-t-tenant-b-staging` · `aa3b23a8-567d-4479-8311-e9f1678a6797` |
| D1 control | `shuddl-control-staging` · `8e238970-2ed3-494d-960f-e4af082c1e8e` |
| KV (idempotency) | `119880a9442c4b8cae8383183a2877e1` |
| R2 (evidence) | `shuddl-evidence-staging` |
| Queue + DLQ | `shuddl-agent-triggers-staging` · `shuddl-agent-dlq-staging` |

API base URL: `https://shuddl-api-staging.<account>.workers.dev` (all routes JWT-authed except `/v1/health`). The agents worker has `workers_dev = false` (no public URL — its triggers are the queue + cron).

## Sending status — LIVE on staging (2026-07-14)

`evidenceSender()` returns `ResendSender` only when BOTH `RESEND_API_KEY` and `EVIDENCE_FROM` are present. Staging now has **both**: `RESEND_API_KEY` (secret — a sending-only Resend key scoped to the verified `send.shuddl.tech`, key `shuddl-agents-staging-v2`, id `e2e34a35-…`) and `EVIDENCE_FROM = "SHUDDL <pod@send.shuddl.tech>"` (var, committed in `wrangler.toml`). So the deployed Biller **sends real evidence email**. Proven end-to-end: the smoke's synthetic POD produced a delivered email (`DELIVERED · SMK-… · PROOF + INVOICE`) from `pod@send.shuddl.tech`.

**What this means for safety:** staging tenants are synthetic, so a real email only goes to whatever recipient a shipment's bill-to party actually carries in `parties.contacts` (most synthetic parties carry none → `recipient_unresolved`, no send). The only real address wired in staging is an owner test inbox seeded on `party-bill-to`. **To turn staging sending back OFF:** unset `EVIDENCE_FROM` in `[env.staging.vars]` and redeploy — the Biller reverts to `NotConfiguredSender`. Prod sending remains milestone-gated (REQ-159).

## Runtime contract (do this first, every session)

The suite is verified under **Node 22.15.0 + pnpm 11.10.0 only**, pinned in `.node-version`, `engines`, and `packageManager`. **Node 20 is not supported** — it mis-resolves the `vitest-pool-workers`/chai chain and changes D1 append-only trigger behaviour, so a green run under Node 20 is not evidence the build is sound (this was a real failure mode). Activate the pinned runtime and prove it before any deploy or gate:

```bash
nvm install 22.15.0 && nvm use 22.15.0   # or `fnm use` — both read .node-version
corepack use pnpm@11.10.0
pnpm check:runtime                         # fails closed, printing installed vs required, on any mismatch
```

`pnpm check:runtime` is the first step of every `verify*` script and of CI; it exits non-zero on the wrong Node/pnpm.

## Deploy from scratch (or re-deploy)

1. Preflight: the runtime contract above is green (`pnpm check:runtime`); Workers **Paid** plan active (Queues + DO need it); `pnpm verify` green.
2. Provision (once): `wrangler d1 create` ×3, `wrangler kv namespace create`, `wrangler r2 bucket create`, `wrangler queues create` ×2 — put the returned ids into the `[env.staging]` blocks of both wrangler.tomls (already done; see the ids above).
3. Migrate each D1 (remote): tenant migrations `0001..0005` → both tenant DBs; control `0001` → control DB — `cd workers/api && npx wrangler d1 execute <db> --remote --yes --file ../../db/tenant/migrations/<f>.sql`.
4. Secret: `printf '%s' "$JWT" | (cd workers/api && npx wrangler secret put JWT_SECRET --env staging)`. **Do NOT set `RESEND_API_KEY`** (keeps sending gated).
5. Deploy in order: `cd workers/api && npx wrangler deploy --env staging`, then `cd workers/agents && npx wrangler deploy --env staging` (api first — the agents DO binding needs the api script to exist).

## Smoke test (proves the deployed pipeline)

```
pnpm exec tsx tools/deploy/staging-smoke.ts
```
Seeds a synthetic shipment, drives the gated driver flow over HTTPS to the live api through `pod.signed`, waits for the real Queue to trigger the Biller, then asserts an `invoice.issued` landed in the real tenant-a D1 penny-exact (invoice total == quote sell == Σ money_lines). Exits non-zero on any failure. (Needs the staging JWT secret in the session scratchpad to mint a token; regenerate + re-set `JWT_SECRET` if the scratchpad is gone.) First green run: shipment `SMK-…`, invoice 55,800¢, zero emails sent.

## Going live with real evidence email (deferred — do deliberately)

1. Verify `send.shuddl.tech` in Resend (add the 3 DNS records → `verify-domain`).
2. `wrangler secret put RESEND_API_KEY --env staging` (a `send.shuddl.tech`-scoped key) + set `EVIDENCE_FROM = "SHUDDL <pod@send.shuddl.tech>"` on the agents worker.
3. The Biller's `ResendSender` activates automatically. Warm the domain first (REQ-157); real consignee volume is milestone-gated (REQ-159, M-H). **Do not do this on the same env you consider "safe/synthetic"** — consider a dedicated env or explicit gating.

## Teardown (staging is disposable)

```
cd workers/agents && npx wrangler delete --env staging
cd ../api        && npx wrangler delete --env staging
npx wrangler queues delete shuddl-agent-triggers-staging && npx wrangler queues delete shuddl-agent-dlq-staging
npx wrangler r2 bucket delete shuddl-evidence-staging
npx wrangler d1 delete shuddl-t-tenant-a-staging && npx wrangler d1 delete shuddl-t-tenant-b-staging && npx wrangler d1 delete shuddl-control-staging
npx wrangler kv namespace delete --namespace-id 119880a9442c4b8cae8383183a2877e1
```
(Delete the workers before their bound resources.)
