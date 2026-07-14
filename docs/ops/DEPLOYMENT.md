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

## The sending invariant (why staging is safe)

`shuddl-agents-staging` has **no `RESEND_API_KEY` / `EVIDENCE_FROM`** secret. The Biller's `evidenceSender()` therefore returns `NotConfiguredSender`, which never touches the network — the full POD→invoice pipeline runs and the evidence send is attempted and cleanly no-ops (outcome `send_pending`/`recipient_unresolved`). **Zero emails can leave staging.** The `/_dev/evidence-test-send` probe is also inert (`ALLOW_TEST_SEND` unset → 404). Confirm anytime: `cd workers/agents && npx wrangler secret list --env staging` must show no `RESEND_API_KEY`.

## Deploy from scratch (or re-deploy)

1. Preflight: Workers **Paid** plan active (Queues + DO need it); `pnpm verify` green.
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
