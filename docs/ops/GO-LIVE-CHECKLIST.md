The repo layout confirms all cross-reference paths. Here is the synthesized ledger.

---

# SHUDDL — Go-Live Checklist & Technical-Debt Ledger

**Path:** `docs/ops/GO-LIVE-CHECKLIST.md` · **Owner:** register owner · **Last synthesized:** 2026-07-19 (from the 5 WP-12-era audit sweeps)

## 1. Purpose & upkeep

This is the single central ledger of everything that must be **done by a human** before SHUDDL can go live (secrets, Cloudflare/DNS provisioning, engagement-workspace fixtures, per-tenant/per-partner activation, milestone/CONFIRM gates, monitoring/DR) and everything that is **deferred, shortcut, or fails open** in the code. Its job: when every WP reads "done," nothing operational or debt-shaped is silently missing. It **points at** the existing ops docs (`secrets.md`, `DEPLOYMENT.md`, `dr-backups.md`, `slo.md`, `PROJECT-STATE.md`, `fixtures/manifest.json`) rather than re-stating them — see §4. **Keep it current:** every WP close-out and every adversarial-audit swarm (REQ-119) appends new operator/debt rows here as part of DoD; when an item lands, flip its Status/Severity in place (do not delete — struck-through history is traceability). Re-baseline against `genesis/09-REQUIREMENTS-REGISTER.csv` at each WP exit; a register status still reading `*-DISCOVERED`/`vNEXT` while the code shipped is itself a debt row (see §3).

---

## 2. Operator / deploy requirements

Legend — **Blocks:** Yes = cannot go live for that surface/feature without it; No = safe default holds or non-blocking.

### Secrets & auth

| Item | Source WP/REQ | Action to complete | Blocks go-live? | Status |
|---|---|---|---|---|
| `JWT_SECRET` (+ derived `STATUS_SECRET`/`DOC_SECRET`, domain-separated) | WP-01 · REQ-154/134 · `workers/api/wrangler.toml`; `secrets.md:14` | `wrangler secret put JWT_SECRET --env <env>` via OIDC; rotate 90d/on-suspicion | Yes (all authed `/v1` routes) | Set on staging; **prod pending** |
| `IDENTITY_DENYLIST` (REQ-167 leak lint) | WP-01/WP-12 · REQ-167 · `tools/checks/identity-leak.ts:35-61`; `secrets.md:15` | Set GitHub Actions secret (or gitignored `.identity-denylist.local`); rotate on tenant on/offboarding | No (CI-time) — **but lint SKIPS/fails-open without it, so a real name-leak could ship** | **Open — fails open locally & CI** |
| `RESEND_API_KEY` + `EVIDENCE_FROM` (evidence email) | WP-06 · REQ-092 · `workers/agents/wrangler.toml:81-84`; `packages/agents/src/biller/sender.ts:245`; `secrets.md:17,20` | Set per env; `EVIDENCE_FROM` domain must be a verified Resend sender. Unbound ⇒ `NotConfiguredSender` rejects loudly (no send) | Yes (acceptance demo #1 POD→email) | Staging armed (`send.shuddl.tech`); **prod is a CONFIRM-gated flip** |
| Device signing root key | WP-01/WP-05 · REQ-134 · `secrets.md:16`; threat-model.md:8 | Hold in control plane; run key-rotation drill | Yes (evidence attribution) | Placeholder; drill executable only once WP-05 device signing lands |
| `TEST_SEND_TOKEN` + `ALLOW_TEST_SEND` | `secrets.md:18`; `workers/agents/wrangler.toml:17-22` | `wrangler secret` in dev/staging **only** | No — guardrail: **must stay OFF in prod** | Tracked |
| `ANTHROPIC_API_KEY` + `COPILOT_MODEL` (Command copilot) | REQ-038/024 · `workers/api/src/routes/copilot.ts:34-41` | Bind to enable `ClaudeCopilot`; unbound ⇒ `DeterministicCopilot` floor | No (deterministic floor) | CONFIRM-gated, optional |
| `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL` (Concierge `ClaudeParser`) | REQ-024 · `workers/agents/src/index.ts:169`; `packages/agents/src/concierge/parse.ts:242` | Bind to flip from `DeterministicParser`; unbound ⇒ `NotConfiguredParser` rejects loudly; model only steers, never gates | No (deterministic parser is the floor) | CONFIRM-gated flip |
| Stripe billing keys/webhooks | WP-14 · REQ-123 · CLAUDE.md stack; threat-model.md:9 | Provision when PLG billing activates; credits metered as Money events on platform tenant | Gates PLG billing (CONFIRM-gated) | **GAP — no row in `secrets.md`** |
| Twilio (or equiv) SMS credentials | WP-06 · REQ-097 · `packages/agents/src/biller/sender.ts:266` | Provision when SMS evidence fallback activates | No (email-only floor) | **GAP — no secret row** |
| **Prod secret set never enumerated** | inferred from `secrets.md` (staging-focused) | Author a prod checklist: prod `JWT_SECRET`, `RESEND_API_KEY`, `EVIDENCE_FROM`, `IDENTITY_DENYLIST`, device root | Yes | **GAP** |

### Cloudflare / edge / DNS

| Item | Source WP/REQ | Action to complete | Blocks go-live? | Status |
|---|---|---|---|---|
| Cloudflare **Workers Paid** plan | `DEPLOYMENT.md:33` | Activate (Queues + DO require it) | Yes | Assumed active staging |
| Provision D1×3 · KV · R2 · Queues×2 + paste ids | `DEPLOYMENT.md:34,16-21` | `wrangler d1/kv/r2/queues create` per env | Yes (per env) | Done staging; **prod not provisioned** |
| Remote D1 migrations (tenant 0001–0005, control 0001) | `DEPLOYMENT.md:35` | `wrangler d1 execute <db> --remote --file <mig>` | Yes (per env) | Done staging; redo prod |
| Cloudflare **OIDC** creds (F1-A) | WP-01/WP-02 · REQ-117 · `secrets.md:6`; threat-model.md:20; dr-backups.md:7 | Configure GitHub Actions OIDC ↔ Cloudflare; unblocks CI deploy + nightly snapshot | Yes (no DB backups / CI deploy without it) | **Deferred (F1-A)** |
| CF **edge rate-limit** on `/pub/*` (+ optional Turnstile on `/pub/quote`) | WP-09 · REQ-193 · spec 14§06 | Provision per-IP edge rule before public GA (explicitly **not** an in-Worker gate; KV counter is defense-in-depth only) | Yes (public GA) | **F0-DEPLOY-NOTE** |
| CORS allowlist real origins | WP-09 · REQ-025/189/167 · `workers/api/src/middleware/cors.ts:15-20` | Replace `portal.example`/`status.example` with real Portal + status deploy origins in `CORS_ALLOWED_ORIGINS` | Yes (Portal/status surfaces) | Placeholder hosts only |
| `VITE_API_BASE` build var | `apps/command/src/lib/api.ts:15-19` | Set real per-env API host at build (unset ⇒ non-resolvable `.example`) | Yes (Command surface) | Build config |
| Self-hosted **Protomaps vectors** on R2 + offline SW cache | WP-03/WP-05 · REQ-075 · `packages/map/src/demo.ts:115`; `style.ts:9-34` | Host tiles on R2; swap `DEMO_TILE_URL`/style placeholders; wire driver airplane-mode offline cache | Yes (production-grade + driver offline; today renders off public demo host) | Deploy line item |
| Self-hosted **JetBrains-Mono glyph PBFs** on R2 | WP-03 · `style.ts` (`{PROVIDER_GLYPHS_URL}`) | Host on-map mono glyph PBFs; swap placeholder | No (cosmetic on-map; HTML chrome uses real fonts) | Deploy line item |
| Optional Mapbox path token | REQ-075 · `packages/map/src/style.ts:48`; threat-model.md:37 | Only if Mapbox chosen over self-host: `VITE_MAPBOX_TOKEN` + ToS confirm (conflicts REQ-075 no-third-party) | No (self-host is default) | **GAP — not in secrets inventory** |
| **`shuddl-backups-{env}` R2 bucket** | REQ-117 · `dr-backups.md:6` vs `DEPLOYMENT.md:34` | Provision backup bucket + add to provisioning/teardown lists | Yes (DR) | **GAP — inconsistent between the two docs** |
| Verified sending domain + **DKIM/SPF/DMARC** | WP-06 · REQ-092 · `secrets.md:24`; `DEPLOYMENT.md:48`; threat-model.md:19 | Publish 3 DNS records + `verify-domain`; wire bounce/suppression handling | Yes (any outbound / evidence email) | `send.shuddl.tech` verified staging; **prod sender NOT verified** |
| **Sending-domain 2-week warmup** (>98% deliverability) | WP-06 · REQ-157 · `secrets.md:24`; PROJECT-STATE.md:35 | Run seed-list ramp + bounce/complaint monitoring before tenant-0 consignee volume | Yes (prod email DoD) | **PILOT / deferred** |
| **Prod-sender domain divergence** (`send.shuddl.tech` vs `shuddl.tech`) | `DEPLOYMENT.md:48-49` vs `secrets.md:24`/PROJECT-STATE.md:35 | Resolve apex-vs-subdomain; pick + verify one prod sender | Yes (prod email) | **GAP — inconsistent across docs** |
| Per-shipment inbound address (`pro@tenant.shuddl.com`) + inbound webhook (svix verify + R2 body-resolver) | WP-06/WP-07 · REQ-091 · threat-model.md:19 | Provision addressing + inbox connectors; wire `email.received` → `message.received` (interim: bounded inline 2KB/32KB) | Yes (Concierge real email-in ingestion) | **Deferred** |
| Email suppression list | WP-06 · REQ-092/157 · threat-model.md:19 | Stand up + maintain outbound suppression list | Yes (prod email) | Listed mitigation; not evidenced |

### Engagement-workspace fixtures to vendor

All are **advisory-until-vendored**: harnesses loud-skip (exit 0), never false-green; a *partial* tariff vendor flips invoice+concierge harnesses to **hard-fail**. None block *merge*; each blocks its **WP DoD claim**. Verify with `pnpm check:fixtures` + `check:rater-parity`/`check:invoice-parity`/`check:concierge-parity`.

| Item | Source WP/REQ | Action to complete | Blocks go-live? | Status |
|---|---|---|---|---|
| **`zone-tariff-v1`** (keystone: zone tariff · 560-zip map · rate groups · accessorials · FSC · floors) | WP-04 · REQ-165 · `manifest.json:6`; `tools/rater/README.md:80` | Drop one JSON per rate_config kind into `fixtures/tariff/`; Zod-validate; flip manifest→vendored + sha256 | Yes — **gates WP-04, WP-06 & WP-07 DoDs simultaneously** | PENDING (dir absent) |
| `rater-48-tests` (audited engine's 48 cases) | WP-04 · REQ-027 · `manifest.json:4`; `parity.ts:202` | Load **exactly 48** ParityCase JSONs into `fixtures/rater/48-tests/`; pin sha256 | Yes (WP-04 REQ-027/165 DoD) | PENDING |
| `rater-504-sweep` (monotonic price sweep) | WP-04 · REQ-027 · `manifest.json:5`; `parity.ts:203` | Load **exactly 504** cases into `fixtures/rater/504-sweep/`; pin | Yes (WP-04 "no price on air") | PENDING |
| `invoice-500-replay` (penny-parity) | WP-06 · REQ-031 · `manifest.json:7`; `invoice-parity.ts:395` | Load **exactly 500** InvoiceReplayCase into `fixtures/invoice-replay/`; pin | Yes (WP-06 REQ-031 DoD) | PENDING |
| `concierge-parse-50` (50 real emails) | WP-07 · REQ-026/171 · `manifest.json:8`; `parse-parity.ts:408` | Load **exactly 50** ConciergeParityCase into `fixtures/concierge/parse-50/`; pin | Yes (WP-07 ≥90% parse + 100% floor-clean) | PENDING |
| `customer-roster` | WP-14/15 Migrator · `manifest.json:9` | Vendor roster into `fixtures/roster/`; pin (private manifest maps hash→origin, REQ-167) | Yes (Migrator DoD) | PENDING |
| `legacy-import-formats` | WP-15 · `manifest.json:10` | Vendor byte-exact formats into `fixtures/legacy-imports/`; pin (Migrator rule 10) | Yes (WP-15 overlay DoD) | PENDING |
| `legacy-export-replay` (9,314-bill / 4,405 re-rate, ±2%) | WP-02/04/15 · `manifest.json:11` | (a) **CONFIRM original export path at WP-01** (open); (b) vendor into `fixtures/legacy-export/`; pin | Yes (parity DoD) — **plus an open [CONFIRM] that blocks even vendoring** | PENDING + path unconfirmed |
| `synthetic-blitz-3100` | WP-15 shadow tooling · `manifest.json:12` | Vendor into `fixtures/blitz/`; pin | Yes (WP-15 shadow-run DoD) | PENDING |
| **Live legacy-TMS mirror feed** (not a byte fixture) | WP-15 · REQ-152 · `fixtures/README.md:17` (README-only) | Secure tenant standing data-access grant + wire nightly export/API mirror | Yes (WP-15 / Phase-0 clock) | PENDING — **not in `manifest.json`, easy to miss** |

### Per-tenant / per-partner activation

| Item | Source WP/REQ | Action to complete | Blocks go-live? | Status |
|---|---|---|---|---|
| **Tenant-0 seed load** (roster · tariff · zips · rate groups · accessorials · FSC · pro ranges · transit) | WP-04 · REQ-165 · Doc13§02.4 | Load config pack; must reproduce audited engine quotes **exactly** | Yes (tenant-0) | F0.2-SPEC'D |
| **Live EDI transport adapter + secret store** | WP-12 · REQ-034/205 · `workers/translator/src/index.ts:20-41`; `wrangler.toml:20` | Set `EDI_TRANSPORT_URL`+`EDI_TRANSPORT_TOKEN` (secret) + a per-partner HMAC secret store; **build** live VAN/AS2/SFTP adapter. Today `NotConfiguredTransport`+`NotConfiguredSecretResolver` fail-closed (every live 204→401, nothing transmitted) | Yes (all live EDI) | CONFIRM-gated, **adapter unbuilt** |
| **Per-partner LIVE EDI activation + cert** | WP-12 · REQ-203 · Doc13§01 · `workers/translator/src/tenants.ts:19` | Each partner = an `integrations` row; `cert_status→certified` only after that partner's replay round-trips clean; LIVE activation is a config-pack calendar object (genesis/13, outside repo) | Yes (per partner) | F0-SPEC'D (activation outside repo) |
| Pro-number ranges / legacy continuity config | WP-15 · REQ-058 | Per-tenant config preserving legacy pros verbatim | No (per-tenant config) | F0-SPEC'D |
| Hazmat workspace enablement | WP-14 · REQ-060 | Per-tenant workspace flag (excluded from Spark default) | No | F0-SPEC'D |
| Vanity multi-host per tenant (`tenants.host`) | WP-09 · genesis/13 | Onboarding provisions host; WP-09 uses static `HOST_TENANTS` allowlist | No | Deferred (onboarding) |
| PROOF-TO-CASH SKU provisioning | WP-14 · REQ-162 · Doc12§05 | Make standalone SKU provisionable via plan flag (excludes non-SKU agents) | No | F0.2-SPEC'D |

### Milestone / CONFIRM gates

| Item | Source WP/REQ | Action to complete | Blocks go-live? | Status |
|---|---|---|---|---|
| **M-H heartbeat unlocks GTM** | WP-06 · REQ-159 · Doc12§01 | Milestone decision at M-H exit; M-H demo video must exist before first outbound. **Never a code flag.** External auto-send of a firm quote also gated here | Yes (all GTM / demo #2) | Milestone gate |
| Tenant-0 legacy-TMS feed 3-day unattended mirror (Phase-0 exit) | WP-15 · REQ-152 · Doc13§02.6 | Nightly mirror must run unattended 3 days | Yes (tenant-0 onboarding) | F0.2-SPEC'D |
| Tenant **authority-flip** gate | WP-15 · REQ-153 · Doc13§04 | 30-day shadow ±2% · two consecutive clean closes · pilot week <0.5% exceptions · auto-fallback armed | Yes (authority cutover) | F0.2-SPEC'D |
| Per-module authority parity gates | WP-15 · REQ-023 | Flip blocked until ±2%/±10%/2-closes green | Yes (per module) | F0-SPEC'D |
| Overlay-before-authority fallback | WP-15 · REQ-008 · Doc00 L8 | Per-module flags + auto-fallback; forced-drift test triggers fallback | Yes (authority overlay) | F0-SPEC'D |
| **Pen-test clean** before launch | WP-16 · REQ-136 · 08§03 | Run pen-test; report clean | Yes (launch gate) | F0-SPEC'D |
| Pricing re-based on tenant-0 telemetry | WP-16 · REQ-130 · Doc04§5 | Re-base pricing + update doc 04 before public launch | Yes (public pricing) | **CONFIRM-GATED** |
| Naming/trademark clearance (SHUDDL) | F1 · REQ-141 · CONFIRM-1 | Clearance memo | Yes (public brand launch) | **CONFIRM-GATED** |
| ToS / Privacy / DPA for PLG signup | WP-14 · REQ-138 | Counsel sign-off | Yes (PLG signup GA) | **CONFIRM-GATED** |
| **Photo/PII retention policy + consignee notice** | WP-06 · REQ-140 · CONFIRM-2 · GA-11 | Counsel: what's kept, how long, notice wording (`lifecycle_class`/`visibility` knobs exist) | Yes (delivery-evidence data handling) | **CONFIRM-2 / counsel** |
| eBOL/e-signature validity per mode + driver location-consent text | WP-05 · REQ-142/166 · CONFIRM-2 | Counsel notes; consent-capture mechanism already built | Yes (signature-as-evidence + consent) | **CONFIRM-GATED / counsel** |
| **Real TSA (RFC-3161) endpoint** | WP-02/WP-16 · REQ-014 · `workers/api/src/routes/anchors.ts:19`; threat-model.md:29 | Insert `integrations` row `kind='tsa'` w/ `config.url` per prod tenant + clear F1 CONFIRM (`HttpTsaClient` fake-tested only; missing ⇒ day left UNANCHORED, never faked in prod) | Yes (evidentiary anchor spine) | Prod unconfigured; F1 CONFIRM open |
| 2023 repos archived read-only | F1 · REQ-144 · Doc06 | Archive prior repos read-only with pointer | No | F0-SPEC'D (F1) |
| Real-driver pilot: install (QR+magic-link+card) + zero-instruction gated stop, on video | WP-05 · REQ-164/006 L6 | Real tenant-0 driver completes gated stop unassisted | Yes (acceptance demo #3) | PILOT |
| 10-min CSR acceptance with a non-freight tester | WP-10 · L6 | Observed human run (never claimed from a test run) | Yes (acceptance demo, L6) | PILOT |
| Stranger signup → quote <10 min | WP-07 DoD | Depends on WP-14 signup + live parse | Yes (acceptance demo #2) | Depends WP-14 + pilot |
| MCP / command-bar booking places a gated append | WP-08→WP-13 · demo #4 | Build MCP intake surface (WP-13) | Yes (acceptance demo #4) | Deferred WP-13 |
| Outdoor readability field test | WP-05 · REQ-067 | Legibility under direct sun on real hardware | No | PILOT |
| Battery/data budget field measure (<5%/day GPS @30s) | WP-05 · REQ-070 | Field measurement (emitter itself is a follow-up, see §3) | No | PILOT |
| **vNEXT CONFIRM-gated OUT features** (do-not-build until CONFIRM): settle/escrow instant-settle (REQ-033/143), voice recording + per-state consent (REQ-096/137), MCP Direct-merchant (REQ-104) + credit-line guest (REQ-103), broker authority+insurance (REQ-139) | genesis/09 rows 34/97/104/105/138/140/144 | Counsel/owner sign-off before *any* build; keep unbuilt while CONFIRM open | Blocks those features (not v1 go-live) | **CONFIRM-GATED** |
| Process rituals: threat-model reviewed each WP (REQ-131) · weekly register review (REQ-120) · identity-denylist upkeep (REQ-167) · ICP+first-25 CRM (REQ-161) | WP-01/ongoing/WP-16 | Standing calendars + logs | No (process / post-M-H GTM) | F0(.2)-SPEC'D |

### Monitoring / DR

| Item | Source WP/REQ | Action to complete | Blocks go-live? | Status |
|---|---|---|---|---|
| **Nightly ledger + control snapshots to R2** | WP-01 · REQ-117 · `dr-backups.md:6` | Activate `.github/workflows/nightly.yml` once F1-A OIDC + WP-02 DBs exist (workflow is a **stub**) | Yes (no backups = data-loss risk) | Not active |
| DR multi-region backups (RPO 24h / RTO 4h) | WP-01 · REQ-135 · GA-19 | Provision multi-region backups | Yes (prod) | F0-SPEC'D |
| Quarterly restore drill | REQ-135 · `dr-backups.md:12` | Run restore→chain-verify→row-parity; log it | No to deploy, **Yes to trust DR** | **Never run** (drill log empty) |
| Uptime/SLO monitors per surface | WP-01 · REQ-114 · `slo.md` | Stand up live monitors on first deploy (F1-A account) | No to deploy, Yes to operate safely | Targets defined; **not stood up** |
| Watchtower budget-drift alarms | WP-11 · REQ-113 · `slo.md:11` | Wire drift alarms | No | Delivered WP-11 (Watchtower) |
| R2 lifecycle policies per doc kind (7-yr POD) | WP-11 · REQ-116 · GA-16 | Apply lifecycle rules; add storage cost line | No (retention compliance) | F0-SPEC'D |
| DLQ drain / poison-message runbook | `DEPLOYMENT.md:21` (`shuddl-agent-dlq-staging` exists) | Define who watches DLQ + replay procedure | No to deploy, Yes to operate | **GAP — DLQ provisioned, no procedure** |
| Public status-page hosting | `slo.md:10` | Stand up public status pages (server-side geo boundary must hold first — see §3) | No | **GAP — SLO'd, no deploy steps** |
| Weekly Watchtower telemetry series (case study) | WP-11 · REQ-160 · Doc12§06 | Weekly snapshot series (unbilled/DSO/POD→invoice latency) from Phase-1 wk 1 | No (GTM proof) | F0.2-SPEC'D |
| GitHub Actions activation (F1-A) + 5 blessed Playwright screenshots + measured map perf | WP-01/03/09/10 · REQ-158/079 | Activate workflows; generate/bless 5 canonical screenshots + perf numbers on browser-capable CI (design CI self-skips in sandbox) | No (gates also run via `pnpm verify`) | Deferred to first browser-capable CI run |

---

### WP-13 MCP v1 (appended 2026-07-20 per §1)

| Item | Source WP/REQ | Action to complete | Blocks go-live? | Status |
|---|---|---|---|---|
| **`workers/mcp` worker deploy** | WP-13 · REQ-101 · `workers/mcp/wrangler.toml` | Provision the 4th worker + its bindings per env: `API` service binding → `shuddl-api-{env}`, `CONTROL_DB`, `JWT_SECRET`, `GRANTS` KV, `CAPS_METER` Durable Object | Yes (the whole MCP surface) | Not deployed |
| **Live OAuth secret store + mcp pairing client secrets** | WP-13 · REQ-102/154 · `workers/mcp/src/{oauth,principal,secret-resolver}.ts` | Bind the pairing-secret store; `NotConfiguredSecretResolver` 401s every `/token` + `/register` until then (fail-closed) | Yes (all live MCP auth) | CONFIRM-gated flip |
| **Per-pairing caps provisioning** | WP-13 · REQ-105 · `pairings.caps` · `workers/mcp/src/caps.ts` | Set `caps={spend,velocity,lanes}` on every `kind='mcp'` pairing; the no-caps default is a fail-closed **refuse**, so an unprovisioned pairing cannot `book_shipment` (deliberate hard cutover) | Yes (per pairing) | Fail-closed until provisioned |
| **Webhook delivery activation** | WP-13 · REQ-109 · `workers/mcp/src/webhooks.ts` | Wire the live event-source (today `NotConfiguredEventSource` yields `[]` → inert); set the per-subscription webhook signing secret; receiver-side enforce a timestamp freshness window + restrict delivery URLs to `https://` | Only webhook delivery | Scaffolded / fail-closed |

### WP-14 PLG + metering (appended 2026-07-21 per §1) — all DARK until R4

| Item | Source WP/REQ | Action to complete | Blocks go-live? | Status |
|---|---|---|---|---|
| **REQ-138 legal (ToS / Privacy / DPA)** | WP-14 · REQ-138 · genesis/09 | Counsel-authored ToS/Privacy/DPA — the door-opener; **public signup legally cannot open** without sign-off. Do-not-build (CONFIRM-2) | Yes (all public self-serve) | CONFIRM-GATED |
| **Stripe keys + `STRIPE_WEBHOOK_SECRET`** | WP-14 · REQ-123/154 · `workers/billing/src/billing.ts` | Bind operator-injected (never toml); `NotConfiguredBilling` rejects until then | Yes (all billing) | DARK / fail-closed |
| **`PROVISIONING_ENABLED` flag** | WP-14 · REQ-121 · `workers/api/src/provision.ts` | Flip ON to open self-serve signup/provisioning; default OFF → `/pub/signup` 404s | Yes (self-serve) | DARK / OFF |
| **`PLATFORM_INTERNAL_SECRET`** | WP-14 · REQ-123/154 · `workers/api/src/internal-platform.ts` | Bind the credit-append/settle route secret (never toml); unbound → 503 | Yes (credit emission) | DARK / 503 |
| **Tenant-D1 pool provisioning** | WP-14 · REQ-121 · `workers/api/wrangler.toml` (`TENANT_POOL_0N_DB`) | Ops pre-creates + migrates the pool D1s the provisioner claims; a pool-refill runbook | Yes (per-signup capacity) | Local pool only |
| **Spark $5 tier plan-flag** | WP-14 · REQ-122/124 · `tenants.plan` | Provision the Spark plan on a tenant to activate the tier + caps; numbers `[HYPOTHESIS]` (REQ-130) | Gates the Spark tier | Plan-flag, unset |
| **REQ-125 per-IP edge rate-limit** | WP-14 · REQ-125 | A Cloudflare per-IP edge rule on `/pub/signup` (like REQ-193) before public GA (the in-Worker `SparkMeter` is per-workspace only) | Yes (public GA) | Deploy note |
| **Async/ACH checkout confirmation** | WP-14 · REQ-123 · `workers/billing/src/credits.ts` | Confirm the (landed) unpaid-branch settle reconciles a covered payment in staging before enabling async/ACH credit checkout | Only async checkout | Landed; verify in staging |

### WP-15 Overlay/authority (appended 2026-07-22 per §1) — DARK/inert until Phase-0 cutover

The overlay machinery is built + fixture-proven; nothing mirrors, flips, or falls back until an operator wires a live feed and the tenant-calendar gates go green. The M-AUTHORITY flip gates are **calendar objects that compress for no one** (genesis/13 §04) — a merge cannot close them.

| Item | Source WP/REQ | Action to complete | Blocks go-live? | Status |
|---|---|---|---|---|
| **Live legacy-feed provisioning** | WP-15 · REQ-152 · `workers/agents/src/mirror-sweep.ts` (`NotConfiguredFeedReader`) + `integrations.config` | Wire the tenant-0 legacy-TMS export/API feed into `integrations.config`; the sweep no-ops until then | Yes (the whole mirror) | DARK / no-op |
| **Tenant-0 config pack** | WP-15 · REQ-058/152/153 · engagement workspace (genesis/13) | The 171 literal column headers + field mapping, the pro-ranges + continuity (REQ-058), the flip/close calendar dates (REQ-153). Generic/config-driven in-repo; literal values are tenant-pack (no identity in-repo, REQ-167) | Yes (a real mirror + flips) | Tenant-pack, unbuilt |
| **M-AUTHORITY calendar gates** | WP-15 · REQ-153 · genesis/13 §04 | 30-day shadow ±2% · two consecutive clean closes · pilot-week <0.5% exceptions — calendar objects; flips gate on the milestone (M-H mirror / M-AUTHORITY flips), NEVER a week number. Non-compressible | Yes (per-module flips) | Calendar-gated |
| **Clean-close signal** | WP-15 · REQ-023 · `workers/api/src/routes/authority.ts` (`cleanCloseCount`) | No in-repo period-close representation → money-module (invoicing/settlement) forward flips are BLOCKED-BY-CONSTRUCTION until a real close signal is wired | Yes (money authority) | Blocked-by-construction |
| **Defer-to-mirror suppression** | WP-15 · REQ-030 · the 8 `resolveAuthority` consult sites (dormant `if(authority==='legacy')` intent-markers) | Light up per-module at cutover: a legacy-authoritative module with a live mirror value presents the legacy value / suppresses the native customer-facing output. Behavior-neutral (dormant) in-repo | Gates a real cutover | Dormant seam |
| **`cursorColumn` monotonic-on-change** | WP-15 · REQ-035 · `packages/adapters/src/legacy-mirror.ts:69` | Verify the tenant-pack feed `cursorColumn` bumps on every in-place edit (a last-modified/version cursor, not creation-only) — else continuous no-silent-drop degrades silently | Gates a correct mirror | Tenant-pack precondition |

## 3. Technical debt & known limitations

Ordered severity-descending. **High** = weakens/blocks a gate or a go-live path; **Med** = correctness/privacy residual or env hazard; **Low** = deferred refinement, fail-safe, or informational.

| Item | Source file / REQ | Nature | Fix | Severity |
|---|---|---|---|---|
| **Identity-leak lint fails OPEN** with no denylist | `tools/checks/identity-leak.ts:35-61` · REQ-167 | The one genuine fail-open gate: `return`s with a warning when `IDENTITY_DENYLIST` absent — a real tenant/person name could ship | Wire the CI secret / `.identity-denylist.local`; fail closed | **High** |
| **Ratecon generation flow unbuilt → dispatch fail-closed** | `workers/api/src/do/sequencer.ts:700-708` · REQ-184/043 | Nothing writes a `documents` row kind `ratecon`; REQ-043 dispatch gate cannot pass without a REQ-049 override (correctly blocked, not falsely open) | Build ratecon generation (booking/dispatch step) | **High** (no real dispatch until built) — register **vNEXT** |
| **EDI B2A revision/replace (04/05) convergence deferred** | `workers/translator/src/core/map-204.ts:70`; `inbound.ts` · REQ-205 | A PO-only re-tender that later gains a primary id yields a **visible duplicate** shipment (dup preferred over silent merge, rule 10) | Wire X12 B2A 04/05 same-load convergence before EDI go-live | **High** (fail-closed today) — **F0-DEPLOY-NOTE** |
| **EDI transport + inbound-204 HMAC resolver unwired** | `workers/translator/src/index.ts:20-41`; `inbound.ts:48-57` · REQ-034/154 | `NotConfigured*` fail-closed: every live 204→401, no EDI transmitted (also an operator item, §2) | Build live adapter + bind secret store | **High** (for EDI) — deferred |
| `credit_status` projection write-ordering (REQ-183) | `credit.checked`→`parties` · REQ-183 · WP-08 | A hold recorded before the party row exists was a silent no-op UPDATE, weakening the REQ-042 credit gate | Assert rows-affected==0 → durable `anomalies` row (**landed WP-11**) | **High→resolved** (register still `WP08-DISCOVERED`) |
| **REQ-170 missing-evidence send-gate UNIMPLEMENTED** | `workers/agents/src/biller.ts:465,480`; `packages/ledger/src/gates/transition-gates.ts:185` | A caller that emits a POD with a fabricated hash + no R2 upload still triggers an evidence email framing itself as "the record" over zero stored bytes (money invoice still valid) | Photo-URL resolver + hash-verify send-gate | **Med** — register `WP06-DISCOVERED` |
| Photos absent from evidence email (`photos: {}`) | `workers/agents/src/biller.ts:465` | Documentary placeholder slots, no real photo URLs | Wire R2 signed-URL resolver (ties REQ-170) | **Med** |
| Status-page server-side geo generalization | `packages/ledger/src/redact.ts` · REQ-074 | **VERIFIED server-side (WP-16)**: `redactEvent` coarsens PARTY geo to ~11 km + drops accuracy (structural walk, until out-for-delivery); `/pub/status` generalizes server-side (coarse even at OFD); `GET /v1/board` is tenant-only; the portal party fleet is synthetic. Proven by `redact.test.ts`. | Remaining: hold the boundary when public status-page HOSTING stands up (deploy gap, §2) + when a real party-scoped live feed lands | **Low** (verified; deploy-gated) |
| Driver auth + lockout deferred | `apps/driver/src/session.ts:68` · REQ-069 | Only a per-device P-256 key exists — no login/magic-link/PIN, no lockout counter | Build driver login + lockout policy | **Med** (driver auth) — F0-SPEC'D |
| Continuous 30s GPS emitter + detention/dwell ± math | `packages/ledger/src/geo/fence.ts:90` · REQ-018 | Gate stamps + accuracy radius ship; no continuous position emitter, no detention money engine | Build emitter + dwell calc disclosing its ± bounds | **Med** (battery test + live board depend) |
| 214-sweep dedup-key not partner-qualified | `workers/translator/src/sweep-214.ts:182` | R2 marker is partner-scoped but `dedupeKey`=`edi214/<event id>` is bare; a live partner-side-dedup adapter risks cross-partner collision | Scope dedup by `(partnerId + key)` when live adapter lands | **Med** (safe today, NotConfigured) |
| **PROJECT-STATE.md stale** (dated 2026-07-14, pre-WP-08) | `docs/ops/PROJECT-STATE.md` | "Done" stops at WP-06; "Parked" list predates 6 WPs; 1,131-test count stale — misleads status reads | Re-baseline against WP-07→WP-12 + register | **Med** (documentation) |
| iCloud `name 2.ext` duplicate hazard | PROJECT-STATE.md:46; MEMORY | Desktop iCloud sync spawns duplicate files that corrupt file-count budget gates | Check `find . -name "* 2.*"` each session; durable fix = move repo off `~/Desktop` | **Med** (env) |
| Dependency/env fragility | MEMORY `dep-env-fragility` | `node_modules` can drift from lockfile (eslint crash needs rm+reinstall; chai pinned 5.3.3 for vitest-pool-workers; pnpm v11 overrides in `pnpm-workspace.yaml`) | Run full `pnpm verify` at WP exit; reinstall on drift | **Med** (env) |
| Staging evidence sending is LIVE | PROJECT-STATE.md:7; `DEPLOYMENT.md:25` | Real email reaches any address in `parties.contacts` (synthetic tenants) — a live outbound path to be aware of | Disable by unsetting `EVIDENCE_FROM` + redeploy | **Med** (awareness) |
| Airplane-mode soak flake | `fixtures/README.md`; commit `b9e2d47` | Driver airplane-mode soak is timing-sensitive; a 30s ceiling was added to stabilize it | Keep the 30s ceiling; watch for regressions | **Low** (test flake) |
| Multi-factor cost surface + per-leg interline floors | WP-04 · `costBasis` seam | Floors ride the linehaul-freight cost proxy; compare executing share vs full-move floor — conservative (over-escalates, never under) | Real op-cost surface (stops/cube-miles/dwell) + per-leg floors (needs op-cost kind + engagement input) | **Low** (conservative) |
| Single-transaction atomicity across the 3 `/rate` events | WP-04.md:36 | Transient infra failure without a client retry can orphan `quote.priced` | True single-txn atomicity (mitigated by required Idempotency-Key) | **Low** |
| POD-gate `serviceClass` exemption unwired | `sequencer.ts:281-287` · REQ-030 | `invoice_without_pod_classes` inert (fail-**safe**: POD always required) | Thread `shipments.service`; add test before enabling any bypass | **Low** (fail-safe) |
| Precise `deriveOperatingState` (point-in-polygon) | WP-05.md:54 | Fail-closed to `XX` UNKNOWN outside ~45 coarse state boxes (an `XX` jurisdiction can never be consented) | Exact per-state polygon lookup (WP-08) | **Low** (fail-closed) |
| Round-trip / stop-off driver flows | `apps/driver/src/flow/stop-flow.ts:175` · REQ-053 | `buildFlow` models single-stop only | Multi-leg flows | **Low** |
| Per-ping raw-position co-signing | `workers/api/src/routes/positions.ts:22` · REQ-018 | Open [CONFIRM]: whether each raw GPS ping is per-ping co-signed (3 auth gates ARE enforced) | Decide perf/UX tradeoff | **Low** (open CONFIRM) |
| Server-side GPS plausibility cross-check | WP-05.md:59 | Device signs its own geo = attribution, not server-truth | Speed/teleport/tower corroboration | **Low** (future hardening) |
| Device signature does not bind `source`/`party_refs` | WP-02.md:137 | Closing it changes signed bytes | Register note before `clientView` frozen-law change | **Low** |
| CMS/cert-chain TSA receipt verification ~~deferred~~ LANDED (WP-16) | `packages/ledger/src/tsa/cms.ts` `verifyTsaSignature` · REQ-014 | Structural DER parse PLUS crypto verify: SignerInfo signature over signedAttrs (RSA/ECDSA-P256, SHA-256), messageDigest binds TSTInfo, chain to a CONFIGURED trust anchor, validity + timestamping EKU — fail-closed, opt-in on `trustAnchors`. Raw `.tsr` in R2 verifiable offline forever. | Remaining (deploy, not code): real trust anchors = config (F1 CONFIRM, line 99); revocation (OCSP/CRL) is a stamping-time/monitoring concern | **Resolved** |
| Live DO board fan-out (`notifyBoard`/`useFleet` no-op) | WP-02/03/10; threat-model.md:37 | Board is a polled read; real-time push is a seam | Wire DO fan-out push | **Low** |
| True OPERATING RATIO | WP-10.md:24 | No op-cost event kind; KPI honestly relabeled "Cost/Rev (quoted basis)" | Add linehaul/driver/asset op-cost kind | **Low** (future) |
| Dedicated `paid_ts` column | WP-10/WP-11 | Paid-when lives in `payment.received` ts | Later amendment if needed | **Low** |
| Exception resolution / claim-adjudication | `workers/api/src/routes/exceptions.ts:20` | "Resolved" = terminal-state heuristic; no `exception.resolved` kind | Formal resolve flow (register amendment) — WP-11 | **Low** |
| Dims stay PRICE-INERT (density/class pricing deferred) | WP-04/07/08/09/10 · REQ-175 | Dims fail-closed on presence only; not price-affecting anywhere (C1 gate regression-guarded) | Density/class pricing = future | **Low** (fail-closed) |
| Concierge SLA = 4h documented default | WP-07.md:66 | No per-tenant SLA-config kind | Per-tenant override kind (later WP) | **Low** |
| Status/claim inbound carries no SLA | WP-07.md:67 | Non-quote inbound resolves `unresolved`, no stream | Exceptions queue (WP-11) | **Low** |
| REQ-177 deterministic-request storage deferred | WP-07.md:30 | Arms only when live LLM bound; prevents concurrent-redelivery inconsistency | Record corroborated request in `quote.requested` on `ClaudeParser` go-live | **Low** |
| REQ-180 register alignment (6 vs 7 kinds) | WP-11.md:28 | Code floor clamps 7 internal kinds (incl `split.computed`); register names 6 (fail-closed superset) | Owner register amendment | **Low** |
| `referralBase` config-drift on evidence fast-path | `workers/agents/src/biller.ts:456` | Redelivery re-renders live `referralBase`; drift if it becomes body-load-bearing | Pin into `invoice.issued` (like `from_name`/REQ-178) | **Low** |
| `signed_by = "Signature on file"` | WP-06.md:70 | Ledger records a signature hash, not a printed name | Thread a name through capture when driver flow collects one | **Low** |
| Accepted quote = latest `quote.priced` before POD | WP-06.md:68 | No `quote.accepted` flow at WP-06 | Switch to booking-referenced quote (booking landed WP-08) | **Low** |
| NULL `bill_terms` → prepaid default | WP-06.md:69 | Payer terms-invariant; unrecognized non-NULL logs loud + proceeds prepaid | Unpick when booking populates terms + third-party column (WP-08) | **Low** |
| `pod.signed` with no `shipments` row | WP-06.md:92 | Logs loud + skips as data fault; REQ-169 sweep can't recover (nothing to project) | Recorded, not Critical | **Low** |
| `composeInvoice` throw burns 5 retries before DLQ | WP-06.md:93 | Noisy but bounded | DLQ + exceptions surface (WP-11) | **Low** |
| SMS evidence fallback throws (email-only) | `packages/agents/src/biller/sender.ts:266` · REQ-097 | `ResendSender` throws on `channel==='sms'` (non-retriable hold) | Wire Twilio adapter | **Low** |
| Voice / `call.transcribed` capture deferred | WP-07.md:27 · REQ-096 | Kind + internal visibility exist and are redacted; capture deferred (CONFIRM-gated do-not-build) | vNEXT | **Low** |
| Credit DECISION engine + credit-officer role | WP-08 · REQ-037 | WP-08 enforces a recorded hold only (no bureau call) | vNEXT | **Low** |
| Customer calendar `.ics` + confirmation surface | WP-08.md:23 | Scheduling events + transit window typed; rendered surface deferred | Portal/Command surface WP | **Low** |
| One leg per (shipment, kind) in v1 | WP-08.md:64 | Multi-stop/multi-leg-per-kind later | Later refinement | **Low** |
| Per-link cap revocation (jti denylist) | WP-09.md:26 | Short `exp` today (blast radius = milestone + 11km geo) | WP-13 | **Low** |
| Rate-card scraping resistance (banded sell) | WP-09.md:27 | Business-confidentiality residual (margin internals already excluded) | WP-12/GTM | **Low** |
| Dedicated portal `GET /v1/shipments?party` list | WP-09.md:29 | Board derives list from `/v1/invoices`; un-invoiced in-flight appear only on map | Add shipments-list route | **Low** |
| Dedicated `STATUS_SECRET`/`DOC_SECRET` | WP-09.md:63 | Derived from `JWT_SECRET` (domain-separated); no new secret to provision | Later hardening | **Low** |
| Weekly telemetry external publishing | WP-11.md:23 | R2 manifest is the telemetry; external publish deferred (CONFIRM-gated) | Post-CONFIRM | **Low** |
| Richer cash-app ambiguous-match surface | WP-11.md:24 | AR-settlement matches `payment.received`→open invoice; richer surface later | Later refinement | **Low** |
| Cash-account deposit journal line | WP-11.md:29 | Journal is AR/AP; deposit (payment→bank) mapping deferred | Later refinement | **Low** |
| `certifyPartner` validates mapping shape only | WP-12.md:43 | Round-trip-clean guarantee lives in test harness (`replayCertify`), not `certifyPartner` | Move the guard into cert flow | **Low** (operational gap) |
| 990 ack best-effort / no-ops when transport unwired | `workers/translator/src/inbound.ts:505` | 204 recorded + chain appended; outbound 990 re-attempts on success | Lands with transport | **Low** |
| EDI 210-out, inbound decoupling queue, Command EDI console | WP-12.md:41 | Out of the lite slice; Command EDI console is design-CI-blocking | Later register-amended WP | **Low** (out of scope) |
| REQ-111 log→ledger unification | WP-01/02 | Would need a 36th event kind (= register amendment); logs stay event-shaped | Deferred WP-11 Watchtower | **Low** |
| Traceability "bare `REQ-xxx` comment" ceiling | WP-02.md:140 | A bare comment satisfies the orphan detector — structural limitation | Accepted | **Low** |
| `mask()` leaks first-char + length | WP-02.md:141 | Pre-existing WP-01 behavior | Accepted / out of scope | **Low** |
| Interline handoff gate `assertInterline` (REQ-045) | WP-05.md:55 | Built ahead of scope; live+tested but register-status `vNEXT`, not DoD | Informational | **Low** (vNEXT) |
| Rater minor follow-ups | WP-04.md:31 | dims-value guard when density load-bearing; `proposed_sell_cents` anomaly coverage; all-zero-floors sanity; body-fingerprint on idempotency key; `effective_ts` ms handling | Non-blocking cleanup | **Low** |
| Dunning matrix deliberately NOT wired | `workers/api/src/routes/dunning.ts:28` · REQ-032 | Human review IS the approval (by design) | None (documented decision) | Informational |
| `settlement.executed` fee events synthetic only | `tools/fixtures/gen-qb-journal-month.ts:18` | Settle-execute is CONFIRM-gated do-not-build; exercised only synthetically | Keep unbuilt until CONFIRM | Informational |
| Design/perf CI advisory until WP-10 exit | `tools/harness/playwright-guard.ts` · REQ-158 | Squint-test + frame-budget report-only (exit 0); blocking with `--strict` after WP-10 | Automated mode-flip, not manual | Informational |

**Resolved after audit-discovery (verify register status advanced — several still read `*-DISCOVERED`):** positions.ts consent/auth bypass C-1 (REQ-190, **closed WP-09** via `gate-context.ts`) · duplicate-booking C-2 (REQ-191, **closed WP-09**) · Biller trigger-loss recon sweep (REQ-169, **closed WP-11** `recon-sweep.ts`) · held-reply surfacing (REQ-176) · from-name pin (REQ-178) · invoice.issued GL redaction (REQ-179, WP-09 `redact.ts`) · never-widen internal floor (REQ-180, WP-11) · full-tenant export (REQ-010, WP-11) · QB/statement export (WP-11) · held-invoice/Watchtower surface (WP-11) · OTD passport accrual (WP-08/10). These are **code-closed**; the debt is that `genesis/09` status tags may still read open — advance them at the next register review.

---

**WP-13 MCP v1 (appended 2026-07-20):**

| Item | Source file / REQ | Nature | Fix | Severity |
|---|---|---|---|---|
| Caps reserve-at-check over-counts on a post-`accept-quote` api failure | `workers/mcp/src/caps.ts` · REQ-105/106 | After the exit-audit fix the confirm-reject + retry facets are closed; only a rare api failure AFTER the reserve over-counts (fails **closed** — refuses a later booking; self-heals at UTC-month rollover) | A settle/release hook after a confirmed booking | **Low** (fail-closed) |
| Immediate cross-method OAuth revocation deferred | `workers/mcp/src/tools/registry.ts` dispatch · REQ-102 | A revoked/suspended pairing's outstanding OAuth tokens still authenticate the non-minting `initialize`/`tools/list` handshake until token TTL (no data exposure; every data/mutation path re-resolves the pairing + fails closed) | One control-DB pairing re-resolve per `dispatch` after grant resolution | **Low** (hygiene) |
| MCP lane cap is destination-zone-based | `workers/mcp/src/caps.ts` · REQ-105 | SEED-1 zoning is dest-based; origin-side lane restriction isn't expressible until origin zoning lands | Origin zoning + a per-leg lane key | **Low** |
| Full DO-backed live-booking E2E is a staging smoke | `workers/mcp/test/quote-book.test.ts` · REQ-101 | The api tenant D1 + `ShipmentSequencer` DO are unseedable in the mcp vitest pool (aux-worker isolation), so the tests prove the MCP layer + no-bypass via a recording fake api; the api gates are proven by the api suites | A cross-worker staging smoke driving a real booking end-to-end | **Low** (test-harness) |

**WP-14 PLG + metering (appended 2026-07-21):**

| Item | Source file / REQ | Nature | Fix | Severity |
|---|---|---|---|---|
| REQ-124 tier numbers are `[HYPOTHESIS]` | `tenants.plan` · REQ-124/130 | The tier *mechanism* (plan-flag + usage meter, no seats) ships; the actual Pro/Scale prices/limits are unset pending the WP-16 pricing re-base | Set final tiers at WP-16 (REQ-130) | **Low** |
| REQ-126 human escalation + SLA unbuilt | REQ-126 | Copilot-first support = the WP-10 copilot; human escalation + the Scale-tier SLA are product/ops deliverables, not code | Stand up the support model at go-live | **Low** (product/ops) |
| Internal credit-append route hardening | `workers/api/src/internal-platform.ts` · REQ-123 | (Task-10 review, Low, internal-only/DARK) `credit-settle` doesn't bind `payload.invoice_id === invoiceId`; `#resolveDb` memo returns before the platform re-check | Bind payment→invoice + add the memo platform re-check before the secret is bound at R4 | **Low** (internal/dark) |
| Platform-chart GL account uncovered | `workers/billing/src/credits.ts` `GL_PLATFORM_CREDITS_AR` · REQ-123 | The `_platform` credit chart is a second, unguarded GL chart (customer `CANONICAL_GL_ACCOUNTS` parity untouched) | Add parity coverage if a platform journal export is ever built | **Low** |
| Metering sweep cadence | `workers/billing/src/metering.ts` · REQ-123 | Hourly cron; the OVERWRITE-recompute makes cadence a freshness knob, not a correctness one | Tune cadence at go-live | **Low** (info) |

**WP-15 Overlay/authority (appended 2026-07-22):**

| Item | Source file / REQ | Nature | Fix | Severity |
|---|---|---|---|---|
| Defer-to-mirror suppression is a dormant seam | the 8 `resolveAuthority` consult sites · REQ-030 | The dormant `if(authority==='legacy')` intent-markers do not yet present the legacy value / suppress the native customer-facing output when a module is legacy-authoritative WITH a live mirror — that is a customer-facing CUTOVER behavior, left inert in-repo | Light up per-module at the tenant cutover (§2) | **Low** (cutover; also §2) |
| Dual-control on money promotions unbuilt | `workers/api/src/routes/authority.ts` · REQ-023 | The flip guard records the single deciding admin (co-sign); a second-approver (dual-control) on invoicing/settlement promotes is not built | Candidate R4 hardening (a REQ amendment) | **Low** (candidate) |
| UNKNOWN-while-native liveness unmonitored | `workers/agents/src/watchtower.ts` · REQ-008 | A native module whose legacy mirror goes UNKNOWN (feed stops) is unmonitored — drift is unassessable so there is correctly no auto-fallback, but no alarm either | A low-severity "mirror absent" liveness alarm (later task) | **Low** (fail-safe) |
| DO trusts `parsed.source` (legacy lock is route-layer) | `workers/api/src/do/sequencer.ts` · REQ-030 | `source:'legacy'` is locked at the route layer (force-native on every seam) + the coverage discipline; the DO itself does not restrict legacy to a verified internal marker — a future append seam added without forcing native would reopen the hole | Defense-in-depth: a DO-level restriction of legacy to a verified internal marker | **Low** (defense-in-depth) |
| Duplicate-fallback TOCTOU under concurrent same-tenant sweep | `workers/agents/src/watchtower.ts` · REQ-008 | Two concurrent same-tenant Watchtower sweeps could emit a duplicate (differently-seeded) `authority.flipped{drift}`; end state is still legacy (never re-promote) | Serialize per-tenant if the cron ever runs concurrently (unreachable on the daily sequential cron today) | **Low** (benign/unreachable) |

## 4. Cross-references (this ledger points, does not duplicate)

| Domain | Authoritative doc | What it owns | This ledger adds |
|---|---|---|---|
| Secrets registry | `docs/ops/secrets.md` | `JWT_SECRET`, `IDENTITY_DENYLIST`, device root, `RESEND_API_KEY`, `TEST_SEND_TOKEN`, `EVIDENCE_FROM` + rotation triggers | Gap rows to append: prod secret set, Stripe, Twilio, TSA URL, Mapbox token, `shuddl-backups-{env}` |
| Deploy runbook | `docs/ops/DEPLOYMENT.md` | Paid plan · D1/KV/R2/Queues provisioning · remote migrations · deploy order (api→agents) · domain verify | Reconcile: backup-bucket omission (#DR), prod-sender domain divergence (apex vs `send.` subdomain) |
| DR / backups | `docs/ops/dr-backups.md` | REQ-117/135: nightly snapshots, RPO 24h/RTO 4h, restore drill | Flags: nightly workflow is a **stub**, restore drill **never run**, backup bucket unprovisioned |
| SLO / monitoring | `docs/ops/slo.md` | REQ-114 per-surface targets, error-budget→merge-pause policy | Flags: monitors **not stood up**, no DLQ runbook, public status page has no deploy steps |
| Security debt | `docs/ops/threat-model.md` | Asset map, standing mitigations, TSA/tile provenance, suppression list | TSA CMS/cert-chain verify CLOSED (WP-16, `cms.ts`). Still-open: real TSA endpoint + trust anchors (F1 CONFIRM), revocation (deploy/monitoring), status-page server-side geo boundary |
| Pen-test basics (launch gate) | `docs/security/pen-test-basics.md` | REQ-136 STRIDE-per-surface review mapped to the existing proving suites; the WP-16 hardenings; verdict "report clean" for the in-repo perimeter | Depends on §2 deploy items (per-IP edge rate-limit, real TSA anchors, prod secrets, warmup, CORS) + §3 residuals (REQ-170/069/023/030) |
| Status snapshot | `docs/ops/PROJECT-STATE.md` | Per-WP done/parked list, test count | **STALE (2026-07-14, pre-WP-08)** — re-baseline against WP-07→WP-12 before trusting its status/parked lists |
| Fixture vendor-in | `fixtures/manifest.json` · `fixtures/README.md` · `tools/rater/README.md` | 9 pending hash-pinned fixtures (`status:"pending"`) + parity harness contracts | Adds the README-only **live legacy-TMS mirror feed** (REQ-152), absent from the manifest's "PENDING (9)" count |
| Scope + status of record | `genesis/09-REQUIREMENTS-REGISTER.csv` | Every REQ row + register status tags (`F0-SPEC'D`, `vNEXT`, `*-DISCOVERED`, `F0-DEPLOY-NOTE`, `CONFIRM-GATED`) | This ledger's REQ ids trace here; register is source-of-truth for scope |
| Per-WP DoD & follow-ups | `docs/wp/WP-01.md … WP-12.md` | Each close-out's operator line-items + logged follow-ups | This ledger is the merged, deduped roll-up of all twelve |
| Open-audit history | `docs/audits/2026-07-15-full-audit-and-skill-plan.md` | 60-agent audit + fix plan (positions.ts C-1, skills) | C-1/C-2 now **closed WP-09** (recorded above for traceability) |