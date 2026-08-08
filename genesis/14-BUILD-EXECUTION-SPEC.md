# SHUDDL — Build Execution Spec
## Genesis doc 14 · 2026-07-09 (second pass) · environments, conventions, and milestones so Claude Code never has to guess
Everything here is implementation law beneath doc 10's schema and doc 11's budgets. Where doc 05/08 give WP order, this doc gives the operational substrate those WPs run on — the layer every "12 weeks" estimate silently assumed.

---

## (01) MONOREPO LAYOUT (WP-01 scaffold, exact)
```
shuddl/
  apps/command/      # React 19 + Vite (map home, queues, command bar)
  apps/driver/       # PWA, offline-first, service worker + IndexedDB event queue
  apps/portal/       # portal + public status pages (SSR-lite ok)
  workers/api/       # Hono: /v1 REST + /mcp + inbound email + webhooks
  workers/agents/    # queue consumers (one module per agent)
  packages/ledger/   # event append, hash chain, lenses, money-lines — NO LLM imports (REQ-024, lint-enforced)
  packages/rater/    # ported rating engine (manifest.private M-01) + config loaders (48 tests + 504-sweep travel with it)
  packages/contracts/# Zod schemas shared FE/BE — the single type boundary
  packages/design/   # tokens, components, map style (doc 07)
  packages/adapters/ # legacy ingest/project (171-col, Rate Profile CSV, EDI), QuickBooks journal
  fixtures/          # vendored per fixtures/README.md, hash-pinned
```
Package manager: pnpm workspaces. TypeScript strict everywhere; `any` is a lint error.

## (02) ENVIRONMENTS & NAMING
| Env | Purpose | Data rule |
|---|---|---|
| **dev** | local (`wrangler dev`/miniflare) | seed tenant only |
| **staging** | merge-to-main auto-deploy | **synthetic tenants only — no real PII, ever** (REQ-154) |
| **prod** | manual-approval deploy | real tenants; tenant #0 first |
Naming: workers `shuddl-{svc}-{env}` · control-plane D1 `shuddl-control-{env}` · tenant D1 `shuddl-t-{slug}-{env}` (per-tenant isolation is physical) · R2 `shuddl-evidence-{env}`, `shuddl-tiles` (shared, public-read via Worker). One Cloudflare account, three env suffixes; API tokens scoped per env. **Secrets:** `wrangler secret` + GitHub Actions OIDC — never in repo, never in `wrangler.toml`; device-key signing keys rotate per REQ-134. **Seed:** `pnpm seed` creates deterministic tenant SEED-1 (customers, tariff, 20 synthetic shipments in every lifecycle state) for dev/CI/screenshot baselines (REQ-155).

## (03) DOMAINS & EMAIL (REQ-091–094, 157)
`app.` (Command) · `drive.` (Driver PWA) · `portal.` · `status.` · `api.` (REST + `/mcp`) — all on shuddl.io now; final brand rename = DNS + config, zero code ([CONFIRM-1] does not block the build). Tenant mail: `{tenant}.shuddl.io` MX → Email Routing → inbound worker; per-shipment addresses `pro-{n}@{tenant}.shuddl.io`. Outbound: DKIM/SPF/DMARC on a dedicated sending subdomain per tenant; **warmup protocol (REQ-157):** 2 weeks of seed-list ramp before tenant-0 consignee volume, bounce/complaint monitoring wired to Watchtower, suppression list in control plane. Evidence emails are the brand's furthest artifact — deliverability is a launch gate (>98%, WP-06 DoD).

## (04) API CONVENTIONS (REQ-156 — every endpoint, no exceptions)
- Base `/v1`; Hono routers per domain; OpenAPI generated from `packages/contracts` Zod schemas (one schema = validation + types + docs).
- **Error envelope:** `{code, message, req_id, event_ids?}` — codes are stable strings (`GATE_BLOCKED`, `FLOOR_APPROVAL_REQUIRED`, `UNKNOWN_NO_PRICE`…); gate refusals return the gate's evidence requirement so UIs can render the question (L6).
- **Idempotency-Key header required on all mutations** (generalizes REQ-106 beyond MCP); replays return the original result.
- Tenant resolution: subdomain (portal/status) or JWT claim (command/driver/API) — never a client-supplied tenant id. Cursor pagination. All timestamps UTC ISO-8601; rendering per facility timezone.
- Server treats every client as untrusted including our own UIs (REQ-133); Gatekeeper checks run in the API layer, not the frontend.

## (05) AUTH IMPLEMENTATION
- **Humans:** magic-link email → short-lived session JWT + rotating refresh; roles per doc 10 `users`. SSO (OIDC) at Scale tier, later.
- **Drivers:** magic link once → device keypair generated on-device (WebCrypto P-256, non-extractable), public key registered to `users.device_keys[]`; every captured event is signed locally (REQ-011/016/017); lockout per REQ-069.
- **Machine (MCP/API/EDI):** OAuth client-credentials → `pairings` row with scopes + caps {spend, velocity, lanes} enforced server-side (REQ-105).
- **Isolation proof:** the cross-tenant suite (REQ-025) runs on every merge — it attempts reads across tenant D1s and lens boundaries with real tokens; any success fails the build.

## (06) EVENT PIPELINE MECHANICS (doc 02, made executable)
One **Durable Object per shipment** = the sequencer: assigns `seq`, verifies `prev_hash` + signature, appends to tenant D1, fans out to board DOs (live map) and agent queues. `position.updated` bypasses the shipment DO into the partitioned stream but joins the daily Merkle root. Evidence bytes: client hashes first, event carries the hash, presigned R2 PUT uploads when signal allows (REQ-017). Daily Merkle job batches roots → RFC 3161 TSA (REQ-014; TSA endpoint choice is an F1 procurement line). Corrections: reversal events only; the GL export proves I7 on every fixture run.

## (07) TESTING & CI/CD
- **Unit** (Vitest) per package · **fixture replay gates** per `fixtures/README.md`, hash-pinned (±2% aggregate, ±10% routes, $222K regression, monotonic sweep, 48 rater tests) · **contract tests** from shared Zod schemas · **Playwright e2e** scripted to the five acceptance demos · **airplane-mode soak** (REQ-016) in CI via service-worker harness · **adversarial audit swarm** at every WP exit (REQ-119).
- **PR gates:** typecheck strict → lint (incl. LLM-in-ledger ban REQ-024 and 22-table invariant I8) → unit + fixtures → traceability (REQ-IDs present, orphan detector, REQ-118) → isolation suite. ~~**Design CI (REQ-158): advisory (non-blocking, report-only) until WP-10 exits; blocking thereafter.**~~ **BLOCKING as of WP-10 exit — verified 2026-08-05 (audit §259).** `tools/design/design-ci.json` is `{"mode":"blocking"}` carrying its own flip note, `tools/design/audit.ts:296` exits 1 in that mode, and `gatesFor("merge")` lists `design-audit` **non-skippable**, so a pixel violation fails a merge. Proved by mutation, not read: a planted shadow, an over-budget radius and a raw hex each go RED (§252), and a palette drift is caught on every copy because the allowlist is *derived* from the tokens (§257). The perf/browser gates are mode-aware rather than report-only — advisory in a bare local run, FAIL/BLOCKED under `--mode merge|release` (§256). This amends doc 11 rule 7's timing, not its content — pixel law should not stall ledger work, and that reason is why the original sentence is struck rather than deleted.
- **Deploy:** merge→staging automatic; prod = manual approval + green fixture board. Migrations forward-only; ~~any migration touching `events` beyond CREATE/INDEX fails CI (I3)~~ **— amended 2026-08-07 (audit §615). The enforced rule permits ONE further form: a NULLABLE `ALTER TABLE events ADD COLUMN` (owner-approved, WP-05).** genesis/10's I3 reads "no event edit/delete grants exist at DB level", and a nullable ADD COLUMN is SQLite metadata-only — it never rewrites or deletes an existing row (old rows read the new column as NULL), so it is neither an UPDATE nor a DELETE. Permitting only it ALIGNS the lint with Law 2 rather than weakening it. Everything else remains a violation: DROP/RENAME COLUMN, RENAME TABLE, and any ADD COLUMN carrying NOT NULL or DEFAULT (which WOULD write into existing rows). `db/tenant/migrations/0005_events_override.sql` already ships under this permit, so the struck sentence described a repo that would fail its own CI. Struck rather than deleted because its INTENT still governs — the events table is not editable, and only a form that provably edits nothing was carved out.

## (08) MILESTONES (clarifies doc 05 §5 / doc 08 §03 for tenant-0-first; WP numbering unchanged)
| Milestone | Contains | Target | Exit gate |
|---|---|---|---|
| **M-H "Heartbeat"** | WP-01, 02, 03 (map shell), 04, 05, 06 + status-page slice of WP-09 + **Overlay mirror slice of WP-15 (Phase 0)** | wk 6 | **Demo (1) on tenant-0's real freight at the pilot dock:** signature → invoice + evidence email <5s · mirror 3-day unattended · fixture ±2% · **R1 GTM unlocks (REQ-159)** |
| **M-OPS** | WP-07, 08, 10 + pilot facility week (doc 13 §04 Phase 2) | wk 10 | 10-min CSR + zero-instruction driver tests on video; pilot week <0.5% exceptions |
| **M-MONEY** | WP-11, 12 + first clean close | wk 12–14 | QB month to the penny; primary-partner EDI fixtures round-trip; close #1 reconciles |
| **M-PRODUCT** | WP-13, 14 (MCP + PLG shell) | wk 14–16 | Claude booking on tenant-0 sandbox; stranger signup <10 min |
| **M-AUTHORITY** | WP-15 flips + WP-16 audit + second clean close + parallel run | wk 16–20 | Per doc 13 §04 — incumbent off daily ops |
**Honesty note (supersedes "12 weeks to v1-complete" as the quoted schedule):** ~12 weeks is engineering-complete under ideal conditions; **live dates are governed by the tenant's calendar objects** (30-day shadow, two consecutive month-end closes, pilot week, partner EDI certification calendars — dated instances live in the config pack) — 16–20 weeks from feed-live to incumbent-off, floor ~14. Quote the milestone gates, never the week numbers.

## (09) CLAUDE CODE SESSION PROTOCOL
Start: read repo CLAUDE.md → the WP row + its REQ rows + DoD → this doc §§03–07. Work in small PRs (one WP slice each); every PR body = REQ-IDs + assumption block + fixture status. Ambiguity: state the assumption and proceed (wrong is cheap, silent is not); new scope = register row FIRST. End: update the WP checklist, leave the build green. Never: merge code from any prior codebase (REQ-163) · add a table/surface/event kind without a register amendment · put an LLM call in `packages/ledger` · weaken a fixture to pass · write a tenant, person, customer, or incumbent-vendor name into any repo artifact (REQ-167 identity-leak lint).

## (10) F1 PROCUREMENT (owner; blocks the first commit or the phase noted)
| Item | Blocks |
|---|---|
| GitHub repo + Cloudflare account (3 envs) + shuddl.io DNS access | WP-01 |
| Anthropic/OpenAI API keys w/ per-agent budgets (REQ-113) | WP-07+ (agents) |
| Stripe (test mode) | WP-14 |
| TSA endpoint choice (e.g., DigiCert/freeTSA) | WP-02 exit |
| QuickBooks sandbox | WP-11 |
| **Tenant-0 legacy-feed access** (the standing data request, REQ-152) + finance-owner session (config-pack confirm-ledger) | Phase 0 exit |
| Pilot facility + gate owner + driver consent language (REQ-166, counsel) | Phase 2 |
| Name/trademark ([CONFIRM-1]) + counsel list (GA-11) + tenant-0 publishing consent | External launch only — never the build |
