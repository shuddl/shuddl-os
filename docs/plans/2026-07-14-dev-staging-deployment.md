# SHUDDL dev/staging Cloudflare deployment plan

> **For Claude:** This is an OPS/deployment plan, not a code-TDD plan. Execute it **directly, step by step, in the main session** (NOT via parallel subagents — wrangler commands provision real cloud resources). **STOP and get the owner's explicit go-ahead before every resource-creating or deploy step** (Tasks 1, 5, 6, 7, 8). Each task has exact commands + expected output + a verification gate; do not proceed past a failed gate.

**Goal:** Stand up a real, deployed **staging** environment of SHUDDL on the owner's Cloudflare account (`89618cedec5696ac1ab82362e5500f16`) — the api + agents workers running against real D1/R2/Queues/DO — and prove the POD→invoice→evidence chain runs on live infra, with **synthetic data only** and **real email sending gated OFF**.

**Architecture:** Deploy the `staging` wrangler environment (`shuddl-{svc}-staging`), NOT the default. The default env carries `local-*` placeholder IDs used by the 1,131-test suite + local `wrangler dev`; we leave it **untouched**. All real-resource wiring goes into new `[env.staging]` binding blocks. Deploy order is **api first, then agents** (the agents worker binds the api worker's `ShipmentSequencer` DO cross-script, so the api script must exist first).

**The three safety invariants (the whole point — verify each holds at the end):**
1. **Synthetic data only.** Staging tenants are `shuddl-t-tenant-a/b-staging`, seeded only with SEED-1 / test-created shipments. No real PII, ever (REQ-154; genesis/14 §02 says staging = synthetic).
2. **Real sending stays OFF.** We do **NOT** set `RESEND_API_KEY` or `EVIDENCE_FROM` on the deployed agents worker. Absent them, the Biller uses `NotConfiguredSender`, which never touches the network — the full pipeline runs, the evidence send is attempted and cleanly logs "not configured," and **zero emails leave**. The `/_dev/evidence-test-send` probe stays inert (`ALLOW_TEST_SEND` unset → 404).
3. **Reversible.** Every resource is deletable (Task 11 teardown). Staging is disposable.

**Tech stack:** Cloudflare Workers, D1 (SQLite), R2, Queues, Durable Objects (SQLite-backed), KV; `wrangler` 4.x (authenticated, token has `workers/d1/workers_kv/workers_routes/workers_scripts write`, `zone read`). Resend for the (gated) evidence email; `send.shuddl.tech` domain already created in Resend, pending DNS.

**Preconditions (Task 0 confirms):** Workers **Paid** plan is active (Queues + SQLite DO **require** it — a free account fails the deploy); `pnpm verify` is green on `main`; the owner approves provisioning (a few dollars/month: Queues $5/mo floor, D1/R2/KV within free tiers at staging volume).

---

## Task 0: Preflight — confirm plan, build, and green baseline

**Files:** none (read-only checks).

**Step 1 — confirm Workers Paid** (Queues + DO need it). Run:
```
cd workers/api && npx wrangler queues list
```
Expected: an empty list or existing queues (exit 0). If it errors with a billing/entitlement message → **STOP**: the owner must enable the Workers Paid plan in the Cloudflare dashboard before continuing.

**Step 2 — confirm the account + auth:**
```
npx wrangler whoami
```
Expected: logged in, Account ID `89618cedec5696ac1ab82362e5500f16`, permissions include `workers (write)`, `d1 (write)`.

**Step 3 — green baseline:** from repo root, `pnpm verify` → exit 0 (the deploy must start from a known-green tree). Clean any iCloud `* 2.*` duplicates first (see `docs/ops/PROJECT-STATE.md`).

**Gate:** all three green. Do not provision anything until the owner explicitly approves proceeding.

---

## Task 1: Provision the staging resources (capture the real IDs)

**Files:** none yet (this creates cloud resources; IDs get wired in Tasks 2–3). **STOP for owner go-ahead — this is the first spend.**

Run each and **record the returned ID** (write them into a scratch note — they go into the tomls next):

**Step 1 — D1 databases (3):**
```
npx wrangler d1 create shuddl-t-tenant-a-staging
npx wrangler d1 create shuddl-t-tenant-b-staging
npx wrangler d1 create shuddl-control-staging
```
Each prints a `database_id` (a UUID). Record all three.

**Step 2 — KV namespace:**
```
cd workers/api && npx wrangler kv namespace create IDEMPOTENCY_STAGING
```
Prints an `id`. Record it. (Name is cosmetic; the binding stays `IDEMPOTENCY`.)

**Step 3 — R2 bucket:**
```
npx wrangler r2 bucket create shuddl-evidence-staging
```
Expected: "Created bucket". (R2 is referenced by name — no ID to record.)

**Step 4 — Queues (main + DLQ):**
```
npx wrangler queues create shuddl-agent-triggers-staging
npx wrangler queues create shuddl-agent-dlq-staging
```
Expected: "Created queue" for each. (Referenced by name.)

**Verification:** `npx wrangler d1 list` shows the 3 staging DBs; `npx wrangler queues list` shows both queues; `npx wrangler r2 bucket list` shows the bucket; `npx wrangler kv namespace list` shows the namespace. Record the 3 D1 IDs + the KV ID for the next tasks.

---

## Task 2: Wire `[env.staging]` bindings into `workers/api/wrangler.toml`

**Files:** Modify `workers/api/wrangler.toml` (append a fully-specified `[env.staging]` block; the existing top-level default stays untouched).

**Step 1 — replace the stub `[env.staging]` (currently just `name = "shuddl-api-staging"`)** with the full binding set, substituting the real IDs from Task 1:
```toml
[env.staging]
name = "shuddl-api-staging"
# staging = synthetic tenants only, no real PII, ever (REQ-154)

[env.staging.vars]
ENVIRONMENT = "staging"

[[env.staging.d1_databases]]
binding = "TENANT_A_DB"
database_name = "shuddl-t-tenant-a-staging"
database_id = "<REAL_ID_tenant_a>"

[[env.staging.d1_databases]]
binding = "TENANT_B_DB"
database_name = "shuddl-t-tenant-b-staging"
database_id = "<REAL_ID_tenant_b>"

[[env.staging.d1_databases]]
binding = "CONTROL_DB"
database_name = "shuddl-control-staging"
database_id = "<REAL_ID_control>"

[[env.staging.kv_namespaces]]
binding = "IDEMPOTENCY"
id = "<REAL_KV_ID>"

[[env.staging.r2_buckets]]
binding = "EVIDENCE"
bucket_name = "shuddl-evidence-staging"

[[env.staging.durable_objects.bindings]]
name = "SHIPMENT_SEQ"
class_name = "ShipmentSequencer"

[[env.staging.migrations]]
tag = "v2-sequencer"
new_sqlite_classes = ["ShipmentSequencer"]

[[env.staging.queues.producers]]
binding = "AGENT_QUEUE"
queue = "shuddl-agent-triggers-staging"
```
The `database_id`s are identifiers, not secrets — committing them is correct and expected.

**Step 2 — validate the config parses:**
```
cd workers/api && npx wrangler deploy --env staging --dry-run --outdir /tmp/wp-api-dryrun
```
Expected: a successful dry-run bundle, no "binding not found"/parse errors. (Dry-run does NOT deploy.) Confirm the output lists the 3 D1, KV, R2, DO, and the AGENT_QUEUE producer under the staging env.

**Step 3 — commit:** `git add workers/api/wrangler.toml && git commit -m "deploy(staging): wire api worker [env.staging] bindings to real resources"`

---

## Task 3: Wire `[env.staging]` bindings into `workers/agents/wrangler.toml`

**Files:** Modify `workers/agents/wrangler.toml` (append `[env.staging]`; leave the default untouched).

**Step 1 — add the staging block** (note: cross-script DO `script_name` becomes the **staging** api script; staging-named queue consumer + DLQ; the two tenant D1s use the **same real IDs** as the api worker — both workers must bind the same physical DBs):
```toml
[env.staging]
name = "shuddl-agents-staging"
workers_dev = false

[env.staging.vars]
ENVIRONMENT = "staging"
REFERRAL_BASE = "https://shuddl.tech"
# NOTE: ALLOW_TEST_SEND / RESEND_API_KEY / EVIDENCE_FROM are DELIBERATELY absent — real send + probe stay OFF.

[env.staging.triggers]
crons = ["0 1 * * *"]

[[env.staging.d1_databases]]
binding = "TENANT_A_DB"
database_name = "shuddl-t-tenant-a-staging"
database_id = "<REAL_ID_tenant_a>"   # SAME id as the api worker's TENANT_A_DB

[[env.staging.d1_databases]]
binding = "TENANT_B_DB"
database_name = "shuddl-t-tenant-b-staging"
database_id = "<REAL_ID_tenant_b>"   # SAME id as the api worker's TENANT_B_DB

[[env.staging.r2_buckets]]
binding = "EVIDENCE"
bucket_name = "shuddl-evidence-staging"

[[env.staging.queues.consumers]]
queue = "shuddl-agent-triggers-staging"
max_batch_size = 10
max_retries = 5
dead_letter_queue = "shuddl-agent-dlq-staging"

[[env.staging.durable_objects.bindings]]
name = "SHIPMENT_SEQ"
class_name = "ShipmentSequencer"
script_name = "shuddl-api-staging"
```

**Step 2 — dry-run validate:** `cd workers/agents && npx wrangler deploy --env staging --dry-run --outdir /tmp/wp-agents-dryrun` → success, no parse errors.

**Step 3 — commit:** `git add workers/agents/wrangler.toml && git commit -m "deploy(staging): wire agents worker [env.staging] bindings (cross-script DO → shuddl-api-staging)"`

---

## Task 4: Re-run the full build — the toml edits must not disturb the green baseline

**Step 1:** from repo root, `pnpm verify` → exit 0. The staging blocks are additive; the default (top-level) config the tests + local dev read is unchanged, so all 11 suites (1,131 tests), invariants, traceability, design, seed must still pass. If anything regressed, the edit touched the default env — fix before proceeding.

**Gate:** green. No commit (nothing changed since Task 3).

---

## Task 5: Apply the migrations to each staging D1 (remote)

**Files:** none (runs the committed `.sql` migration files against remote D1). **STOP for go-ahead — this writes schema to real DBs.**

**Step 1 — tenant migrations → both tenant DBs**, in order, for `shuddl-t-tenant-a-staging` AND `shuddl-t-tenant-b-staging`:
```
cd workers/api
for db in shuddl-t-tenant-a-staging shuddl-t-tenant-b-staging; do
  for f in 0001_ledger_core 0002_domain 0003_insert_guards 0004_party_refs_guard 0005_events_override; do
    npx wrangler d1 execute "$db" --remote --yes --file ../../db/tenant/migrations/$f.sql
  done
done
```
Each prints executed-statement counts, exit 0. (If a statement errors, STOP and inspect — the append-only triggers + STRICT tables must all apply cleanly.)

**Step 2 — control migration → control DB:**
```
npx wrangler d1 execute shuddl-control-staging --remote --yes --file ../../db/control/migrations/0001_control.sql
```

**Step 3 — verify schema landed** (spot-check the events table + a trigger exist):
```
npx wrangler d1 execute shuddl-t-tenant-a-staging --remote --command "SELECT name,type FROM sqlite_master WHERE name IN ('events','money_lines','invoices') OR name LIKE '%guard%' ORDER BY name;"
```
Expected: the `events`/`money_lines`/`invoices` tables + the append-only guard triggers listed. Confirm ≤22 tables total (`SELECT count(*) FROM sqlite_master WHERE type='table';`).

**Gate:** both tenant DBs + control DB migrated, tables + guards present.

---

## Task 6: Set the staging secrets (and deliberately NOT the sending ones)

**Files:** none (secrets are set in Cloudflare, never in the repo — REQ-154). **STOP for go-ahead.**

**Step 1 — `JWT_SECRET`** on BOTH workers (staging), the session-signing secret the api worker verifies. Generate a strong random value and pipe it (avoid interactive prompt echoing):
```
cd workers/api    && printf '%s' "$STAGING_JWT_SECRET" | npx wrangler secret put JWT_SECRET --env staging
cd ../agents      && printf '%s' "$STAGING_JWT_SECRET" | npx wrangler secret put JWT_SECRET --env staging
```
(The owner sets `$STAGING_JWT_SECRET` in their shell to a fresh random string — e.g. `openssl rand -base64 48` — so the value never lands in a file or the transcript. Both workers must share the same value if the agents worker also verifies sessions; if only api verifies, agents may not need it — check `workers/agents/src` for a `JWT_SECRET` read and skip if absent.)

**Step 2 — confirm the sending secrets are ABSENT** (invariant #2):
```
cd workers/agents && npx wrangler secret list --env staging
```
Expected: `JWT_SECRET` only (or empty). **`RESEND_API_KEY` MUST NOT appear.** If it does, remove it (`wrangler secret delete RESEND_API_KEY --env staging`) — real sending must stay gated for this deployment.

**Any other secrets** the api worker reads at runtime (grep `env\.` in `workers/api/src` for `process`-style secret reads — e.g. an identity denylist, anchor TSA creds) get set the same way, or the feature no-ops if absent (confirm each is optional for a synthetic smoke).

**Gate:** `JWT_SECRET` set where needed; sending secrets confirmed absent.

---

## Task 7: Deploy the api worker (staging) — FIRST

**Files:** none. **STOP for go-ahead — this publishes a live worker.**

**Step 1:**
```
cd workers/api && npx wrangler deploy --env staging
```
Expected: uploads, applies the `v2-sequencer` DO migration, binds 3×D1 + KV + R2 + DO + queue producer, prints the deployed URL (or "no route" since it's an API worker — that's fine) + a version ID. Note `workers_dev` is not false here, so it gets a `shuddl-api-staging.<subdomain>.workers.dev` URL — record it for the smoke test.

**Step 2 — verify health.** If the api exposes a health route (check `workers/api/src/index.ts` / `routes/health` — WP-01 had `test/health.test.ts`):
```
curl -sS https://shuddl-api-staging.<subdomain>.workers.dev/v1/health   # adjust to the real path
```
Expected: a 200 health payload. Also `npx wrangler deployments list --name shuddl-api-staging` now lists a deployment (no longer "does not exist").

**Gate:** api worker live, health 200, DO class registered.

---

## Task 8: Deploy the agents worker (staging) — SECOND

**Files:** none. **STOP for go-ahead.**

**Step 1:**
```
cd workers/agents && npx wrangler deploy --env staging
```
Expected: uploads, binds 2×D1 + R2 + the queue **consumer** + DLQ + the cross-script DO (`script_name = shuddl-api-staging` — resolves now that the api script exists) + registers the cron. `workers_dev=false` so no public URL — correct (its triggers are the queue + cron).

**Step 2 — verify the consumer + cron registered:**
```
npx wrangler deployments list --name shuddl-agents-staging   # a deployment exists
npx wrangler queues consumers list shuddl-agent-triggers-staging   # shows shuddl-agents-staging as consumer
```
Expected: the agents worker is the registered consumer of the trigger queue; the cron shows in the deploy output.

**Gate:** both workers deployed; the queue is wired producer(api)→consumer(agents).

---

## Task 9: Smoke test — prove the heartbeat runs on live infra with NO email sent

**Files:** create `tools/deploy/staging-smoke.ts` (a Node script that drives the LIVE staging api like the integration tests do, but over HTTPS).

**Step 1 — mint a staging session token.** Reuse the test helper's token-minting (`workers/api/test/helpers.ts` mints a JWT signed with `JWT_SECRET`) against `$STAGING_JWT_SECRET`, for a synthetic tenant-a ops/driver user. (Extract the mint into a tiny reusable fn if needed.)

**Step 2 — drive one synthetic shipment end-to-end over HTTPS** against `https://shuddl-api-staging.../`: `POST /v1/rate` (get an itemized quote) → register a synthetic device → drive the gated driver flow (consent → arrive → count → freight photo → dims → depart → arrive delivery → placed photo → `pod.signed`) exactly as `workers/api/test/pod.test.ts`/`heartbeat.test.ts` do, but as real HTTPS calls with the minted token. Use REQ-167-clean synthetic names.

**Step 3 — assert the chain landed in real D1** (give the queue a few seconds to deliver, then query remote):
```
npx wrangler d1 execute shuddl-t-tenant-a-staging --remote --command "SELECT kind,seq FROM events WHERE stream_id='s:<smoke-shipment>' ORDER BY seq;"
npx wrangler d1 execute shuddl-t-tenant-a-staging --remote --command "SELECT id,total_cents,status FROM invoices;"
npx wrangler d1 execute shuddl-t-tenant-a-staging --remote --command "SELECT direction,kind,amount_cents FROM money_lines;"
```
Expected: the event chain incl. `pod.signed` AND — from the queue-triggered Biller — an `invoice.issued`, with `invoices.total_cents` == the quote's sell and the `money_lines` summing to it (penny-exact, on REAL infra). This proves the producer→queue→consumer→DO→projection path works deployed.

**Step 4 — assert ZERO emails sent (invariant #2).** The Biller's evidence send hit `NotConfiguredSender`. Confirm two ways: (a) `npx wrangler tail shuddl-agents-staging` during the run shows the "not configured" log, NOT a send; (b) via the Resend MCP, `list-emails` shows no new send from the run. **If any email was sent, that is a STOP-the-world failure** — investigate immediately (it would mean RESEND_API_KEY leaked into the env).

**Gate:** invoice.issued penny-exact in real D1; zero emails; the DLQ (`shuddl-agent-dlq-staging`) is empty (no poison).

**Step 5 — commit** the smoke script: `git add tools/deploy/staging-smoke.ts && git commit -m "deploy(staging): end-to-end smoke — POD→invoice on live infra, zero send (gated)"`

---

## Task 10: (Independent) Verify `send.shuddl.tech` + optional SEED-1 demo data

These are decoupled from the deploy and can happen anytime.

**Step 1 — domain verify (once the owner has added the 3 DNS records from the earlier step):** via the Resend MCP, `verify-domain` on `send.shuddl.tech` (id `89b5378f-a04b-4b3b-9182-0fdceecf257b`), then `get-domain` until status `verified`. This readies the domain but changes nothing about sending (RESEND_API_KEY stays unset → still no send).

**Step 2 — optional SEED-1 into staging tenant-a** (a populated demo dataset): adapt `tools/seed/load.cli.ts` to target the remote staging D1 (or export SEED-1 to SQL and `wrangler d1 execute --remote --file`). Synthetic by construction (REQ-155). Skip if the smoke shipment is enough.

---

## Task 11: Runbook + teardown (reversibility)

**Files:** create `docs/ops/DEPLOYMENT.md`; update `docs/ops/PROJECT-STATE.md`.

**Step 1 — write `docs/ops/DEPLOYMENT.md`:** the exact deploy order (api→agents), the resource inventory (the 3 D1 IDs, KV, R2, queues), the "sending stays gated" invariant + how to later flip it on (set `RESEND_API_KEY` + `EVIDENCE_FROM` on `shuddl-agents-staging`, verify `send.shuddl.tech`, warm per REQ-157), and the smoke command.

**Step 2 — teardown (reversibility, document + keep ready):**
```
cd workers/agents && npx wrangler delete --env staging
cd ../api        && npx wrangler delete --env staging
npx wrangler queues delete shuddl-agent-triggers-staging
npx wrangler queues delete shuddl-agent-dlq-staging
npx wrangler r2 bucket delete shuddl-evidence-staging
npx wrangler d1 delete shuddl-t-tenant-a-staging   # + tenant-b + control
npx wrangler kv namespace delete --namespace-id <REAL_KV_ID>
```
(Delete workers before their resources; deleting a D1/queue with a bound live worker can error.)

**Step 3 — update `docs/ops/PROJECT-STATE.md`:** staging is deployed (synthetic, send-gated); note the smoke passed and the teardown command.

**Step 4 — commit:** `git add docs/ops/DEPLOYMENT.md docs/ops/PROJECT-STATE.md && git commit -m "docs(ops): staging deployment runbook + teardown; state updated"`

---

## Out of scope (do NOT do here — separate, deliberate decisions)
- **`env.prod`** — production carries real tenants/PII/sending and gates on F1-B/C + the M-H milestone (genesis/12,14). Not this plan.
- **Turning on real evidence sending** — RESEND_API_KEY stays unset. Flipping it is a one-liner later (documented in the runbook) but is itself CONFIRM/warmup-gated (REQ-092/157/159).
- **A CI deploy pipeline** (GitHub Actions OIDC per genesis/14) — a follow-on once the manual deploy is proven.
- **App/custom-domain routing, Protomaps tile hosting, Stripe/QuickBooks/TSA** — later F1-A checklist items, not needed for the heartbeat smoke.
