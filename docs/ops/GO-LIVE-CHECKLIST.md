# SHUDDL — Go-Live Checklist & Technical-Debt Ledger

**Path:** `docs/ops/GO-LIVE-CHECKLIST.md` · **Owner:** register owner · **Last synthesized:** 2026-07-19 (from the 5 WP-12-era audit sweeps) · **Last re-audited:** 2026-07-27 (V1 close-out Task 6 — every hold and failure row re-run against a live command *where one exists*; two holds have no gate at all and now say so. See §1.1 for the row schema and the bottom two ledgers for the schema applied) · **Closed out:** 2026-07-27 (V1 close-out Task 8 — the six objective questions, each answered with a citation or an honest no, and the close-out statement itself, are **§5 at the foot of this file**)

## 1. Purpose & upkeep

This is the single central ledger of everything that must be **done by a human** before SHUDDL can go live (secrets, Cloudflare/DNS provisioning, engagement-workspace fixtures, per-tenant/per-partner activation, milestone/CONFIRM gates, monitoring/DR) and everything that is **deferred, shortcut, or fails open** in the code. Its job: when every WP reads "done," nothing operational or debt-shaped is silently missing. It **points at** the existing ops docs (`secrets.md`, `DEPLOYMENT.md`, `dr-backups.md`, `slo.md`, `PROJECT-STATE.md`, `fixtures/manifest.json`) rather than re-stating them — see §4. **Keep it current:** every WP close-out and every adversarial-audit swarm (REQ-119) appends new operator/debt rows here as part of DoD; when an item lands, flip its Status/Severity in place (do not delete — struck-through history is traceability). Re-baseline against `genesis/09-REQUIREMENTS-REGISTER.csv` at each WP exit; a register status still reading `*-DISCOVERED`/`vNEXT` while the code shipped is itself a debt row (see §3).

### 1.1 The eight-field row schema (added by the V1 close-out Task 6, 2026-07-27)

Every row in the two ledgers at the **bottom** of this file — **External holds** and **Repository-owned failures & debt** — carries all eight fields below. The §2 operator tables and the §3 debt tables predate the schema and keep their original columns: they are narrative history, and re-columning every legacy row would rewrite the wording this file exists to preserve. Where a legacy row is now factually wrong it is **superseded in place** with a dated note — struck through, never deleted.

| Field | Vocabulary / rule |
|---|---|
| **Item** | what is wrong, in one clause |
| **Severity** | **Critical** = a launch-gate stopper or a live correctness/security defect · **High** = weakens or blocks a gate or a go-live path · **Med** = correctness/privacy residual, environment hazard, or a record that misleads a reader · **Low** = deferred refinement, fail-safe, or informational |
| **Ownership** | **Repo** = reproducible from this checkout and closable by a commit · **External** = needs an account, a credential, a licence, a vendored private artifact, or a named human; no commit can clear it |
| **Proof** | the exact command and the verdict it printed — never a summary. A row whose claim no command can produce says so plainly — **"no gate exists"**, or **"source read"** with the `file:line` a reader can open — and never dresses a reading up as a run. That absence is itself a finding. |
| **Owner** | infrastructure · backend · assurance · ops · counsel · founder · on-call · register owner |
| **Status** | `OPEN` · `FIXED` · `BLOCKED` (external; cannot be worked from here) · `NOT_APPLICABLE`. A **†** after the status means the claim is **not verified in this environment** — see the workerd row in the failures table. |
| **Blocks grade** | the lowest V2 release grade (`docs/ops/V2-EXECUTION-FRAMEWORK.md` §9: R0 audited → R1 mergeable → R2 staging-certified → R3 pilot-ready → R4 production-ready → R5 authority cutover) this row denies |
| **Evidence expires** | when the verdict above stops being evidence — **at the earlier of** (a) the SHA changing in the files the proof reads, and (b) the external fact it depends on changing (credentials rotated, resources provisioned, fixtures vendored, a human named). Past either, the row is unproven: re-run the command. |

---

## 2. Operator / deploy requirements

Legend — **Blocks:** Yes = cannot go live for that surface/feature without it; No = safe default holds or non-blocking.

### Secrets & auth

| Item | Source WP/REQ | Action to complete | Blocks go-live? | Status |
|---|---|---|---|---|
| `JWT_SECRET` (+ derived `STATUS_SECRET`/`DOC_SECRET`, domain-separated) | WP-01 · REQ-154/134 · `workers/api/wrangler.toml`; `secrets.md:14` | `wrangler secret put JWT_SECRET --env <env>` via OIDC; rotate 90d/on-suspicion | Yes (all authed `/v1` routes) | Set on staging; **prod pending** |
| `IDENTITY_DENYLIST` (REQ-167 leak lint) | WP-01/WP-12 · REQ-167 · `tools/checks/identity-leak.ts:35-61`; `secrets.md:15` | Set GitHub Actions secret (or gitignored `.identity-denylist.local`); rotate on tenant on/offboarding | No (CI-time) — **but the lint SKIPS locally without it, so a local run proves nothing about REQ-167** | ~~Open — fails open locally & CI~~ **Corrected 2026-07-27: fails CLOSED in CI, OPEN locally.** CI binds the secret (`.github/workflows/ci.yml:49`) and `REQUIRE_DENYLIST`/`CI` force the fail-closed branch (`tools/checks/identity-leak.ts:54-59`). Verdicts: `pnpm -s check:identity` → `Lint SKIPPED` exit 0; `pnpm -s check:identity -- --mode merge` → `{"gate":"identity-leak","status":"BLOCKED","executed":false}`. Still **Open** — the secret is unset here |
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
| Optional Mapbox path token | REQ-075 · `packages/map/src/style.ts:48`; `docs/security/threat-model.md:55` (corrected 2026-07-27: the old `threat-model.md:37` pointer was already stale and Task 5's insertions shifted it further — line 37 is now T14/T15 prose; the tile-provenance/no-third-party entry it means is the WP-03 change-log line 55) | Only if Mapbox chosen over self-host: `VITE_MAPBOX_TOKEN` + ToS confirm (conflicts REQ-075 no-third-party) | No (self-host is default) | **GAP — not in secrets inventory** |
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
| **Real TSA (RFC-3161) endpoint** | WP-02/WP-16 · REQ-014 · `workers/api/src/routes/anchors.ts:19`; `docs/security/threat-model.md:31` (corrected 2026-07-27 from `:29`, which now lands on the seq-race row) | Insert `integrations` row `kind='tsa'` w/ `config.url` per prod tenant + clear F1 CONFIRM (`HttpTsaClient` fake-tested only; missing ⇒ day left UNANCHORED, never faked in prod) | Yes (evidentiary anchor spine) | Prod unconfigured; F1 CONFIRM open |
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
| **Identity-leak lint fails OPEN** with no denylist | `tools/checks/identity-leak.ts:35-61` · REQ-167 | ~~The one genuine fail-open gate: `return`s with a warning when `IDENTITY_DENYLIST` absent — a real tenant/person name could ship~~ **Superseded 2026-07-27 (T14/T15 + Task 6 re-verify):** the gate now fails **CLOSED** in CI and under `--mode merge/release`; the fail-open branch survives only in a bare local run (`identity-leak.ts:62-69`). The residual is narrower and real: **REQ-167 is unverified in every local run and at every WP-exit run on this machine** | Wire the CI secret / `.identity-denylist.local`; fail closed | ~~**High**~~ → **Med** (CI is closed; local is unproven). Eight-field row: see the failures ledger at the bottom |
| **Ratecon generation flow unbuilt → dispatch fail-closed** | `workers/api/src/do/sequencer.ts:700-708` · REQ-184/043 | Nothing writes a `documents` row kind `ratecon`; REQ-043 dispatch gate cannot pass without a REQ-049 override (correctly blocked, not falsely open) | Build ratecon generation (booking/dispatch step) | **High** (no real dispatch until built) — register **vNEXT** |
| **EDI B2A revision/replace (04/05) convergence deferred** | `workers/translator/src/core/map-204.ts:70`; `inbound.ts` · REQ-205 | A PO-only re-tender that later gains a primary id yields a **visible duplicate** shipment (dup preferred over silent merge, rule 10) | Wire X12 B2A 04/05 same-load convergence before EDI go-live | **High** (fail-closed today) — **F0-DEPLOY-NOTE** |
| **EDI transport + inbound-204 HMAC resolver unwired** | `workers/translator/src/index.ts:20-41`; `inbound.ts:48-57` · REQ-034/154 | `NotConfigured*` fail-closed: every live 204→401, no EDI transmitted (also an operator item, §2) | Build live adapter + bind secret store | **High** (for EDI) — deferred |
| `credit_status` projection write-ordering (REQ-183) | `credit.checked`→`parties` · REQ-183 · WP-08 | A hold recorded before the party row exists was a silent no-op UPDATE, weakening the REQ-042 credit gate | Assert rows-affected==0 → durable `anomalies` row (**landed WP-11**) | **High→resolved**. ~~(register still `WP08-DISCOVERED`)~~ **Corrected 2026-07-27:** REQ-183 now reads `F0-SPEC'D` (`wp=WP-11`) — advanced on verified evidence in commit `7c1a0b4`; it is no longer a drift row (`pnpm check:coverage` does not list it) |
| **REQ-170 missing-evidence send-gate UNIMPLEMENTED** | `workers/agents/src/biller.ts:465,480`; `packages/ledger/src/gates/transition-gates.ts:185` | A caller that emits a POD with a fabricated hash + no R2 upload still triggers an evidence email framing itself as "the record" over zero stored bytes (money invoice still valid) | Photo-URL resolver + hash-verify send-gate | **Med** — register `WP06-DISCOVERED`. **Re-verified 2026-07-27 and DELIBERATELY LEFT OPEN:** Task 2 advanced this row with the other ten, then **reverted it**, because `workers/agents/src/biller.ts:594-601` still declares the placed-photo half unimplemented in the source itself. This is the one `*-DISCOVERED` tag on this page that is *correct*; do not "advance" it |
| Photos absent from evidence email (`photos: {}`) | `workers/agents/src/biller.ts:465` | Documentary placeholder slots, no real photo URLs | Wire R2 signed-URL resolver (ties REQ-170) | **Med** |
| Status-page server-side geo generalization | `packages/ledger/src/redact.ts` · REQ-074 | **VERIFIED server-side (WP-16)**: `redactEvent` coarsens PARTY geo to ~11 km + drops accuracy (structural walk, until out-for-delivery); `/pub/status` generalizes server-side (coarse even at OFD); `GET /v1/board` is tenant-only; the portal party fleet is synthetic. Proven by `redact.test.ts`. | Remaining: hold the boundary when public status-page HOSTING stands up (deploy gap, §2) + when a real party-scoped live feed lands | **Low** (verified; deploy-gated) |
| Driver auth + lockout deferred | `apps/driver/src/session.ts:68` · REQ-069 | Only a per-device P-256 key exists — no login/magic-link/PIN, no lockout counter | Build driver login + lockout policy | **Med** (driver auth) — F0-SPEC'D |
| Continuous 30s GPS emitter + detention/dwell ± math | `packages/ledger/src/geo/fence.ts:90` · REQ-018 | Gate stamps + accuracy radius ship; no continuous position emitter, no detention money engine | Build emitter + dwell calc disclosing its ± bounds | **Med** (battery test + live board depend) |
| 214-sweep dedup-key not partner-qualified | `workers/translator/src/sweep-214.ts:182` | R2 marker is partner-scoped but `dedupeKey`=`edi214/<event id>` is bare; a live partner-side-dedup adapter risks cross-partner collision | Scope dedup by `(partnerId + key)` when live adapter lands | **Med** (safe today, NotConfigured) |
| ~~**PROJECT-STATE.md stale** (dated 2026-07-14, pre-WP-08)~~ **FIXED 2026-07-27** | `docs/ops/PROJECT-STATE.md` | ~~"Done" stops at WP-06; "Parked" list predates 6 WPs; 1,131-test count stale — misleads status reads~~ **Re-baselined onto WP-01..16 + T14/T15 reality in commit `d562d2b`** (corrected at `75ed83b`, which also added it to the annotation-scanner exclusion list so a status pointer cannot annotate itself into evidence — `tools/traceability/orphans.ts:35-41,67`). Its header now reads `As of 2026-07-27 · HEAD 7c1a0b4` | ~~Re-baseline against WP-07→WP-12 + register~~ done | ~~**Med** (documentation)~~ **resolved** |
| iCloud `name 2.ext` duplicate hazard | PROJECT-STATE.md:46; MEMORY | Desktop iCloud sync spawns duplicate files that corrupt file-count budget gates | Check `find . -name "* 2.*"` each session; durable fix = move repo off `~/Desktop` | **Med** (env) |
| Dependency/env fragility | MEMORY `dep-env-fragility` | `node_modules` can drift from lockfile (eslint crash needs rm+reinstall; chai pinned 5.3.3 for vitest-pool-workers; pnpm v11 overrides in `pnpm-workspace.yaml`) | Run full `pnpm verify` at WP exit; reinstall on drift | **Med** (env) |
| Staging evidence sending is LIVE | PROJECT-STATE.md:7; `DEPLOYMENT.md:25` | Real email reaches any address in `parties.contacts` (synthetic tenants) — a live outbound path to be aware of | Disable by unsetting `EVIDENCE_FROM` + redeploy | **Med** (awareness) |
| Airplane-mode soak flake | `fixtures/README.md`; commit `b9e2d47` | Driver airplane-mode soak is timing-sensitive; a 30s ceiling was added to stabilize it | Keep the 30s ceiling; watch for regressions | **Low** (test flake) |
| Multi-factor cost surface + per-leg interline floors | WP-04 · `costBasis` seam | Floors ride the linehaul-freight cost proxy; compare executing share vs full-move floor — conservative (over-escalates, never under) | Real op-cost surface (stops/cube-miles/dwell) + per-leg floors (needs op-cost kind + engagement input) | **Low** (conservative) |
| Single-transaction atomicity across the 3 `/rate` events | WP-04.md:36 | Transient infra failure without a client retry can orphan `quote.priced` | True single-txn atomicity (mitigated by required Idempotency-Key) | **Low** |
| POD-gate `serviceClass` exemption unwired | `sequencer.ts:281-287` · REQ-030 | `invoice_without_pod_classes` inert (fail-**safe**: POD always required) | Thread `shipments.service`; add test before enabling any bypass | **Low** (fail-safe) |
| Precise `deriveOperatingState` (point-in-polygon) — **resolver LANDED (V1 Task 13); LICENSED artifact is a BLOCKED external HOLD** | `packages/ledger/src/geo/{jurisdiction,polygon-source}.ts` · REQ-166 | Coarse five-box stub REPLACED by exact integer point-in-polygon over a **version/hash-pinned** admin-boundary artifact. Fail-closed to `XX` on parse/coverage/**fixture-hash-mismatch**/malformed-polygon, on any boundary edge, outside all coverage, or interior to >1 state — the boxes were fail-**open** on coastal/border cases (ocean-off-Big-Sur and Reno-NV both derived a confident `CA`; PIP resolves both to `XX`). Proven by `packages/ledger/test/jurisdiction.test.ts` (38 tests). The **active** artifact is **SYNTHETIC / coarse / 5-state** (`fixtures/jurisdiction/us-states.synthetic.json`, sha256-pinned in `fixtures/jurisdiction/manifest.json`) — a test/dev stand-in, byte-bound to the embedded const; any coordinate outside its coverage → `XX` (fail-closed). | **BLOCKED external HOLD** — the production-grade, cartographically-accurate, **all-states+territories LICENSED** admin-boundary dataset (`manifest.json` id `us-admin-boundaries-licensed`, status `blocked`; license [CONFIRM] owner=ops+counsel) is NOT committed. **Go-live consumes it by:** (1) vendor bytes under `fixtures/jurisdiction/` via the approved fixture process, (2) pin its sha256 in the manifest and flip status→`vendored`, (3) point the `jurisdiction.ts` active artifact at it, (4) re-run the jurisdiction + consent + position suites green. Until then GPS consent for unsupported jurisdictions stays fail-closed. | **Low (fail-closed) — code landed; data = external HOLD** |
| Round-trip / stop-off driver flows | `apps/driver/src/flow/stop-flow.ts:175` · REQ-053 | `buildFlow` models single-stop only | Multi-leg flows | **Low** |
| Per-ping raw-position co-signing | `workers/api/src/routes/positions.ts:22` · REQ-018 | Open [CONFIRM]: whether each raw GPS ping is per-ping co-signed (3 auth gates ARE enforced) | Decide perf/UX tradeoff | **Low** (open CONFIRM) |
| Server-side GPS plausibility cross-check | WP-05.md:59 | Device signs its own geo = attribution, not server-truth | Speed/teleport/tower corroboration | **Low** (future hardening) |
| Device signature does not bind `source`/`party_refs` | WP-02.md:137 | Closing it changes signed bytes | Register note before `clientView` frozen-law change | **Low** |
| CMS/cert-chain TSA receipt verification ~~deferred~~ LANDED (WP-16) | `packages/ledger/src/tsa/cms.ts` `verifyTsaSignature` · REQ-014 | Structural DER parse PLUS crypto verify: SignerInfo signature over signedAttrs (RSA/ECDSA-P256, SHA-256), messageDigest binds TSTInfo, chain to a CONFIGURED trust anchor, validity + timestamping EKU — fail-closed, opt-in on `trustAnchors`. Raw `.tsr` in R2 verifiable offline forever. | Remaining (deploy, not code): real trust anchors = config (F1 CONFIRM, line 99); revocation (OCSP/CRL) is a stamping-time/monitoring concern | **Resolved** |
| Live DO board fan-out (`notifyBoard`/`useFleet` no-op) | WP-02/03/10 (2026-07-27: the `threat-model.md:37` pointer was struck — the threat model has never carried a board fan-out row; `grep -niE "fan-out\|notifyBoard" docs/security/threat-model.md` returns nothing) | Board is a polled read; real-time push is a seam | Wire DO fan-out push | **Low** |
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
| Interline handoff gate `assertInterline` (REQ-045) | WP-05.md:55 | Built ahead of scope; live+tested but register-status `vNEXT`, not DoD | ~~Informational~~ **Diagnosed 2026-07-27: this is a register DATA defect, not a build gap** — genuinely built (`packages/ledger/src/gates/transition-gates.ts:261-275`) and tested (`packages/ledger/test/transition-gates.test.ts:273`, `workers/api/test/gates.test.ts:163`); the register row's `spec` column already says `WP-05` while its `wp` column reads `vNEXT`. Correcting that one cell (plus the status) is the cleanest of the eight drift fixes. See the failures ledger | **Low** (vNEXT) |
| Rater minor follow-ups | WP-04.md:31 | dims-value guard when density load-bearing; `proposed_sell_cents` anomaly coverage; all-zero-floors sanity; body-fingerprint on idempotency key; `effective_ts` ms handling | Non-blocking cleanup | **Low** |
| Dunning matrix deliberately NOT wired | `workers/api/src/routes/dunning.ts:28` · REQ-032 | Human review IS the approval (by design) | None (documented decision) | Informational |
| `settlement.executed` fee events synthetic only | `tools/fixtures/gen-qb-journal-month.ts:18` | Settle-execute is CONFIRM-gated do-not-build; exercised only synthetically | Keep unbuilt until CONFIRM | Informational |
| Design/perf CI advisory until WP-10 exit | `tools/harness/playwright-guard.ts` · REQ-158 | Squint-test + frame-budget report-only (exit 0); blocking with `--strict` after WP-10 | Automated mode-flip, not manual | Informational |

**Resolved after audit-discovery** ~~(verify register status advanced — several still read `*-DISCOVERED`)~~ **— register CORRECTED 2026-07-27, see the closing note below:** positions.ts consent/auth bypass C-1 (REQ-190, **closed WP-09** via `gate-context.ts`) · duplicate-booking C-2 (REQ-191, **closed WP-09**) · Biller trigger-loss recon sweep (REQ-169, **closed WP-11** `recon-sweep.ts`) · held-reply surfacing (REQ-176) · from-name pin (REQ-178) · invoice.issued GL redaction (REQ-179, WP-09 `redact.ts`) · never-widen internal floor (REQ-180, WP-11) · full-tenant export (REQ-010, WP-11) · QB/statement export (WP-11) · held-invoice/Watchtower surface (WP-11) · OTD passport accrual (WP-08/10). These are **code-closed**. ~~The debt is that `genesis/09` status tags may still read open — advance them at the next register review.~~

**Corrected 2026-07-27 (V1 close-out Task 2, commit `7c1a0b4`):** that register debt is **discharged for eleven rows**. REQ-169, REQ-171, REQ-172, REQ-173, REQ-174, REQ-175, REQ-176, REQ-178, REQ-179, REQ-180 and REQ-183 now read `F0-SPEC'D`, each advanced only on a verified pair (a source annotation **and** a passing test, recorded row by row in that commit). Proof: `pnpm check:coverage` → `8 status-drift row(s) … REQ-045, REQ-170, REQ-184, REQ-249, REQ-276, REQ-284, REQ-285, REQ-288` — none of the eleven appears. **REQ-170 is the deliberate exception**: it was advanced with the rest and then reverted to `WP06-DISCOVERED`, because the placed-photo half is still declared unimplemented in the source (`workers/agents/src/biller.ts:594-601`). The remaining seven drift rows are a *different* defect — their `wp` column names no active WP, so a status edit alone cannot advance them; see the register rows in the failures ledger at the bottom of this file.

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

**WP-16 launch-gate audit (appended 2026-07-22):** full 8-lens REQ-119 swarm, ZERO open Criticals (report: `docs/audits/2026-07-22-wp16-launch-gate-audit.md`). Findings:

| Item | Source file / REQ | Nature | Fix | Severity |
|---|---|---|---|---|
| Invoice-void AR divergence | `packages/ledger/src/projection/money.ts` · REQ-209 | An `invoice.corrected` void left the `invoices` row `status='issued'` so AR-aging/DSO/Collector overstated a voided invoice while QB/GL read 0 (latent — no producer emits `invoice.corrected` today) | **FIXED** — a `void` InvoiceUpsert flips the row to `status='void', total_cents=0`; reconciliation-tested | **High→resolved** |
| Redaction forward-guard (payment/settlement `division`) | `packages/ledger/src/redact.ts` · REQ-210 | `payment.received`/`settlement.executed` weren't in INTERNAL_NESTED — a party lens would leak `division` if a real emitter added it (not reachable today) | **FIXED** — both kinds strip `division` | **Low→resolved** |
| CI didn't run `check:coverage`; product fences not git-scoped | `.github/workflows/ci.yml` · `tools/checks/invariants.ts` · REQ-211 | The 100% register gate ran only on manual `verify`; the stray-SQL/eslint fences false-tripped on a git-ignored sibling project sharing the repo dir | **FIXED** — coverage+authority-coverage in ci.yml, `REQUIRE_DENYLIST` pins identity fail-closed, fences git-aware | **Med→resolved** |
| Append-only guards don't enumerate every UNIQUE surface | `db/tenant/migrations/0003_insert_guards.sql` · REQ-212 | The `events`/`money_lines` BEFORE INSERT guards omit `hash`/`ux_events_device`/`ux_ml_corrects` — a future REPLACE evasion or new UNIQUE could silently rewrite a chained row. NOT exploitable today (plain INSERT aborts; REPLACE lint-banned) | Ship the drafted complete guard (`.claude/skills/complete-append-only-insert-guards/reference-0006_...sql`) + a WHEN-completeness lint | **Low** (deferred, vNEXT) |
| DO trusts `parsed.source` (route-layer-only legacy lock) | `workers/api/src/do/sequencer.ts` · REQ-213 | `source:'legacy'/'edi'/'email'` is locked by per-route coercion; a future route forgetting to coerce reopens the forgery vector. NOT exploitable today (every route covered + tested) | A one-line DO-side assertion (reject a client non-native source unless an internal flag, mirroring `platform:true`) makes it structural | **Low** (deferred, vNEXT) |
| Comms parity counts internal ops notes | `packages/ledger/src/parity.ts` · REQ-008 | `sla-sweep`/`biller` `message.received` notes inflate the native comms count | Fail-safe (only raises drift, never a false green); documented coarse count — future refinement | **Low** (fail-safe) |
| `usage_credits` row-identity/roster divergence at R4 | `workers/api/src/provision.ts` vs `workers/billing/src/metering.ts` · REQ-123 | Provisioning keys `uc-<slot>-<period>`; the metering sweep keys `<slug>:<period>` + iterates only static `TENANT_SLUGS` — a pool tenant would carry two rows + not be swept. Latent while PLG DARK | Reconcile the row identity + roster before R4 flips the flag | **Low** (DARK) |

## 4. Cross-references (this ledger points, does not duplicate)

| Domain | Authoritative doc | What it owns | This ledger adds |
|---|---|---|---|
| Secrets registry | `docs/ops/secrets.md` | `JWT_SECRET`, `IDENTITY_DENYLIST`, device root, `RESEND_API_KEY`, `TEST_SEND_TOKEN`, `EVIDENCE_FROM` + rotation triggers | Gap rows to append: prod secret set, Stripe, Twilio, TSA URL, Mapbox token, `shuddl-backups-{env}` |
| Deploy runbook | `docs/ops/DEPLOYMENT.md` | Paid plan · D1/KV/R2/Queues provisioning · remote migrations · deploy order (api→agents) · domain verify | Reconcile: backup-bucket omission (#DR), prod-sender domain divergence (apex vs `send.` subdomain) |
| DR / backups | `docs/ops/dr-backups.md` | REQ-117/135: nightly snapshots, RPO 24h/RTO 4h, restore drill | Flags: nightly workflow is a **stub**, restore drill **never run**, backup bucket unprovisioned |
| SLO / monitoring | `docs/ops/slo.md` | REQ-114 per-surface targets, error-budget→merge-pause policy | Flags: monitors **not stood up**, no DLQ runbook, public status page has no deploy steps |
| Security debt | `docs/security/threat-model.md` (path corrected 2026-07-27 — there is no `docs/ops/threat-model.md`; every bare `threat-model.md:N` pointer in §2/§3 resolves here) | Asset map, standing mitigations, TSA/tile provenance, suppression list | TSA CMS/cert-chain verify CLOSED (WP-16, `cms.ts`). Still-open: real TSA endpoint + trust anchors (F1 CONFIRM), revocation (deploy/monitoring), status-page server-side geo boundary |
| Pen-test basics (launch gate) | `docs/security/pen-test-basics.md` | REQ-136 STRIDE-per-surface review mapped to the existing proving suites; the WP-16 hardenings; verdict "report clean" for the in-repo perimeter | Depends on §2 deploy items (per-IP edge rate-limit, real TSA anchors, prod secrets, warmup, CORS) + §3 residuals (REQ-170/069/023/030) |
| Status snapshot | `docs/ops/PROJECT-STATE.md` | Per-WP done/parked list, test count | ~~**STALE (2026-07-14, pre-WP-08)** — re-baseline against WP-07→WP-12 before trusting its status/parked lists~~ **Re-baselined 2026-07-27** (`d562d2b`, corrected `75ed83b`): header reads `As of 2026-07-27 · HEAD 7c1a0b4`, covers WP-01..16 + T14/T15, and grades staging against `V2-EXECUTION-FRAMEWORK.md` §9 (**not** yet R2). Trustworthy as of that SHA |
| Fixture vendor-in | `fixtures/manifest.json` · `fixtures/README.md` · `tools/rater/README.md` | 9 pending hash-pinned fixtures (`status:"pending"`) + parity harness contracts | Adds the README-only **live legacy-TMS mirror feed** (REQ-152), absent from the manifest's "PENDING (9)" count |
| Scope + status of record | `genesis/09-REQUIREMENTS-REGISTER.csv` | Every REQ row + register status tags (`F0-SPEC'D`, `vNEXT`, `*-DISCOVERED`, `F0-DEPLOY-NOTE`, `CONFIRM-GATED`) | This ledger's REQ ids trace here; register is source-of-truth for scope |
| Per-WP DoD & follow-ups | `docs/wp/WP-01.md … WP-12.md` | Each close-out's operator line-items + logged follow-ups | This ledger is the merged, deduped roll-up of all twelve |
| Open-audit history | `docs/audits/2026-07-15-full-audit-and-skill-plan.md` | 60-agent audit + fix plan (positions.ts C-1, skills) | C-1/C-2 now **closed WP-09** (recorded above for traceability) |
---

## External holds — named owners (Task 15, REQ-288 · re-audited to the eight-field schema, Task 6, 2026-07-27)

Every one of these is BLOCKED, not failed, and none may be relabelled PASS. ~~`pnpm verify:release` runs
each as a real command and returns its own verdict, so a hold clears the moment the environment is
genuinely fixed — no code change required.~~ **Qualified 2026-07-27:** true of seven rows. `backup-manifest`
is a *declared* hold (`run-gate.ts:79`) because nothing in a release run can synthesize a manifest, and the
last two rows have no gate at any profile. The rest of the sentence stands: a real-command hold clears the
moment the environment is genuinely fixed, with no code change.

**Every proof below was re-run on 2026-07-27 at HEAD `72b2fc2`.** Two rows are the exception and say so: they have **no gate at all**, which is why they are still here after two close-outs. `pnpm verify:release` itself could **not** be run end-to-end this session — it spawns `unit-tests` first, and the workerd runtime is wedged (see the failures ledger); each hold's own gate command was therefore run directly, which is what `verify:release` would have spawned.

| Hold — and what it is blocked on | Severity | Ownership | Proof — command → verdict | Owner | Status | Blocks grade | Evidence expires |
|---|---|---|---|---|---|---|---|
| **Production resources** — all five `[env.prod]` scopes are structurally complete, but every id is an all-zero placeholder — declared, not provisioned | High | External (the resources must exist before the ids can be pasted) | `pnpm exec tsx tools/deploy/preflight.ts --env prod` → **19** × `BLOCK placeholder-resource-id`, e.g. `shuddl-api-prod.CONTROL_DB — database_id for shuddl-control-prod is an all-zero placeholder UUID`; run verdict `preflight: BLOCKED — 26 unsatisfied prerequisites. This is not a green.` | infrastructure | BLOCKED | **R4** | when any `[env.prod]` block in the five `wrangler.toml`s changes (SHA), or the moment the D1/KV resources are provisioned — whichever is sooner |
| **Staging placeholder ids** — all-zero D1 UUIDs (`PLATFORM_TENANT_DB`, both `TENANT_POOL_*`) and the mcp `GRANTS` KV id | High | External (same: provision, then paste) — but the placeholder ids themselves are repo-visible defects | `pnpm exec tsx tools/deploy/preflight.ts --env staging` → **5** × `BLOCK placeholder-resource-id`: `shuddl-api-staging.{PLATFORM_TENANT_DB,TENANT_POOL_01_DB,TENANT_POOL_02_DB}`, `shuddl-billing-staging.PLATFORM_TENANT_DB`, `shuddl-mcp-staging.GRANTS`; run verdict `BLOCKED — 12 unsatisfied prerequisites` | infrastructure | BLOCKED | **R2** | same rule as the prod row, against the `[env.staging]` scopes |
| **Secrets bound** — `JWT_SECRET`, `RESEND_API_KEY`, `STRIPE_WEBHOOK_SECRET`, `PLATFORM_INTERNAL_SECRET` (the last three were required by DEPLOYMENT.md but absent from the checker's contract, so their absence read as satisfied until 2026-07-25) | High | External | Both envs → **4** × `BLOCK missing-secret`, e.g. `JWT_SECRET is not bound in prod (wrangler secret put JWT_SECRET --env prod)`. **Read this verdict precisely:** the same run prints `preflight: no --state supplied — account-side facts (secrets, origins, sender, TSA, backups) are UNPROVEN and therefore blocked.` On staging `JWT_SECRET` and `RESEND_API_KEY` *are in fact bound* (that is how staging sending works — `PROJECT-STATE.md:182`), so the staging verdict proves **unproven**, not **absent**; the prod verdict is a genuine absence | infrastructure | BLOCKED | **R2** (staging, unproven) · **R4** (prod, absent) | on any secret rotation, and on the first `preflight --state <file>` run that supplies account-side facts — whichever is sooner. Nothing in-repo can extend it |
| **CORS origins** — no served allowlist; `.example` placeholders remain in `cors.ts` | High | External for the real origins; **Repo** for the placeholder (`workers/api/src/middleware/cors.ts:15-20`) | Both envs → `BLOCK no-origins  cors — no origin allowlist is configured for <env>; every browser surface would be refused` | backend | BLOCKED | **R2** | when `cors.ts` changes (SHA) or when the Portal/status deploy origins first exist |
| **TSA endpoint** — no RFC 3161 authority configured — anchors cannot be timestamped | High | External (an `integrations` row per prod tenant + the F1 CONFIRM) | Both envs → `BLOCK tsa-unconfigured  tsa — no RFC 3161 timestamp authority endpoint is configured` | infrastructure (F1 CONFIRM: owner) | BLOCKED | **R4** | when the F1 CONFIRM closes or an `integrations` row `kind='tsa'` is inserted. Until then every day is left UNANCHORED, never faked (`anchors.ts:19`) |
| **Backups** — `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` unbound; **no backup exists** | High | External | Two independent verdicts: (1) both envs → `BLOCK no-backup  backups — no backup manifest exists for this environment`; (2) the release profile declares `backup-manifest: BLOCKED — OIDC/external backup credentials (.github/workflows/nightly.yml) — absent in-repo` (`tools/release/run-gate.ts:79` — a *static* hold, the only one left, because nothing in a release run can synthesize a manifest) | infrastructure | BLOCKED | **R2** | on the first successful nightly run, or on binding the two credentials — whichever is sooner |
| **Restore drill** — no backup artifact to reconcile | High | External | `pnpm -s restore:verify -- --mode release` → `##SHUDDL-GATE## {"gate":"restore-verify","status":"BLOCKED","executed":false,"assertions":0,"detail":"no --source/--restored snapshots supplied; a restore has not been reconciled"}` | on-call | BLOCKED | **R3** | the moment a backup artifact exists (this hold is downstream of Backups; it cannot clear first) |
| **Deployed smoke** — `SMOKE_API_BASE` + JWT secret | Med | External | `pnpm -s smoke:staging -- --mode release` → `staging-smoke: BLOCKED — SMOKE_API_BASE is not set — there is no deployed environment to smoke` / `nothing was exercised; this is a named external hold, not a pass.` | infrastructure | BLOCKED | **R2** | on the first deploy that publishes a reachable base URL |
| **On-call rota** — no human is named; alerts have no recipient | Med | External | **NO GATE EXISTS.** No command in this repo can verify that a human is named — the original "Gate: all SLO alerts" column named a policy, not a runnable check. The claim rests on two documents: `docs/ops/slo.md:25` (*"The rota is **not yet staffed** — naming a human is a launch prerequisite"*) and `docs/ops/dr-backups.md:76`. Recorded as a finding in its own right: **this is a hold with no gate** | founder | BLOCKED | **R3** | never expires automatically — a document assertion, not a measurement. Re-read both lines at every close-out |
| **7-year monthly snapshots** — retention is 30 days; the REQ-116 archive tier is unimplemented | Low | External | **NO GATE EXISTS** (the original row's gate column was literally `—`). Rests on `docs/ops/dr-backups.md:23-24`: *"Monthly snapshots kept 7 years (matching the POD lifecycle, REQ-116) are **not yet implemented** — the nightly artifact retention is 30 days."* Second hold with no gate | infrastructure | BLOCKED | **R4** | document assertion; re-read `dr-backups.md:23-24` at every close-out |

### Hold ↔ gate reconciliation (Task 6 Step 3 — run 2026-07-27, HEAD `72b2fc2`)

**No gate verdict without a hold.** Every `BLOCK` either preflight emits maps to exactly one row above:

| Preflight verdict | prod | staging | Hold row |
|---|---|---|---|
| `placeholder-resource-id` | 19 | — | Production resources |
| `placeholder-resource-id` | — | 5 | Staging placeholder ids |
| `missing-secret` | 4 | 4 | Secrets bound |
| `no-origins` | 1 | 1 | CORS origins |
| `tsa-unconfigured` | 1 | 1 | TSA endpoint |
| `no-backup` | 1 | 1 | Backups |
| **total** | **26** | **12** | — |

Both totals match the aggregate the tool prints, so no BLOCK is unaccounted for. The three non-preflight release gates each map to exactly one row as well: `restore-verify` → Restore drill, `staging-smoke` → Deployed smoke, `backup-manifest` → Backups (which is why Backups cites two verdicts).

**No hold without a gate — FAILS for two rows.** *On-call rota* and *7-year monthly snapshots* have no executable gate at all; nothing in this repo can observe either fact. They are true, they are named, and they are unmeasurable, so they can only be re-read, never re-run. Closing that asymmetry (a gate that reads a named-owner file; a gate that asserts the archive tier exists) is itself deferred work.

**Re-confirmed 2026-07-27 at HEAD `c09d9a5` (the V1 evidence sweep, Task 7).** The staging column was re-run — `pnpm preflight -- --mode release` → `deploy-preflight … "12 blocked: placeholder-resource-id, missing-secret, no-origins, tsa-unconfigured, no-backup"`, with the same 5/4/1/1/1 split — and `restore-verify` and `staging-smoke` returned the same two BLOCKED sentinels quoted in their rows above. No hold cleared, no hold was added, and no verdict changed. The prod column was not re-run this session; it is unchanged since `72b2fc2` because no `[env.prod]` block has been touched. Full sweep, including every gate that could **not** be run and why: [`RELEASE-EVIDENCE.md`](./RELEASE-EVIDENCE.md) § *Sweep — 2026-07-27*.

## Repository-owned failures & debt (NOT external holds)

These are ours: reproducible from this checkout, closable by a commit. Same eight fields.

| Item | Severity | Ownership | Proof — command → verdict | Owner | Status | Blocks grade | Evidence expires |
|---|---|---|---|---|---|---|---|
| ~~`anchors/run` backfill flake~~ **FIXED 2026-07-27** — original text preserved: *"INTERMITTENT, pre-dates this branch. `POST /v1/anchors/run` 500s in ~half of full-suite runs of `workers/api` and passes in isolation. Root cause: the route backfills every unanchored day in the tenant DB, which under `isolatedStorage:false` + `singleWorker:true` holds whatever every other test file wrote, so a per-day exception escapes `anchorDay` and fails the whole request. ~~Two fixes are available and neither was taken here (out of scope for the T14/T15 plan): scope the run test to its own tenant (the precedent in 43661ff), or catch per-day in `runDailyAnchor` and push to the `failed[]` array the contract already has.~~"* **Resolution (Task 1): the second fix was taken, and more** — per-day containment (`1aa0db5`), a durable contained `anchor.build_failed` record with escalation (`8f24e68`, `packages/ledger/src/anchor.ts:317`), three recorder guards + a narrowed contained region (`501330c`), and the actual root cause: a **non-hex hash at epoch 0** in `workers/api/test/driver-manifest.test.ts` | High (was) → resolved | Repo | `git log --oneline` → `1aa0db5`, `8f24e68`, `501330c`, `6e33e89`, approved after three review rounds. **The fix has NOT been observed green in this environment**: `pnpm test` and `pnpm -F @shuddl/ledger test` cannot execute — `workerd` is wedged (next row). That is why this row carries a † | backend | FIXED † | — (was R1) | **already expired for the verification half.** Re-run `pnpm -F @shuddl/ledger test` and `pnpm -F @shuddl/api test` after a reboot; until someone does, "fixed" rests on the diff and the review, not on a green |
| **The `workerd` runtime is wedged on this machine** — `packages/ledger`, all five `workers/*` suites, `pnpm test`, `test:acceptance`, `verify:dev`, `verify:merge` and `verify:release` could not be run during this entire close-out | Med (environment) | External (the machine, not the code) | `workerd --version` never returns. Diagnostic: `ps -eo stat,command \| grep '[w]orkerd' \| grep -c '^UE'` → **127** (of 128 workerd processes) stuck in uninterruptible-exit, with load average 5.18 on an otherwise idle box. Remedy: **reboot** | on-call / founder | BLOCKED | **R1** (the authoritative merge gate cannot be run at all) | at reboot. Every † in this file expires with it |
| **A stale anomaly marker can outlive a day that anchors** — if `clearAnchorFailures` rejects *after* the `documents` row commits, the markers survive; the next run sees the documents row, marks the day `skipped`, `anchorDay` is never called again, and the markers can never clear or escalate | Low | Repo | Source read, no command reproduces it: `packages/ledger/src/anchor.ts:216` awaits `clearAnchorFailures(...).catch(...)`, logs, and returns `"anchored"`; `anchor.ts:245` then skips any day already carrying a `tsa_receipt` documents row. Raised by an adversarial reviewer in Task 1, judged real, consciously deferred. **UNKNOWN** how reachable it is in practice — it needs a D1 fault confined to that one statement, and nothing measures that | backend | OPEN | none (Low; R1 requires zero Critical/High) | when `packages/ledger/src/anchor.ts` changes |
| **`runDailyAnchor`'s two pre-loop queries are uncontained** — so `POST /v1/anchors/run` can still 500 on a fault there. **The claim "the endpoint cannot 500" is false**; what shipped was *per-day* containment | Med (it corrects a claim a reader would otherwise trust) | Repo | Source read: `packages/ledger/src/anchor.ts:226-228` (the `MIN(recorded_at)` union) and `:237-239` (the anchored-days sweep) both `await db.prepare(...)` **outside** the per-day try/catch that `1aa0db5` introduced | backend | OPEN | none by grade — but any doc that claims the endpoint is 500-proof is wrong until this closes | when `packages/ledger/src/anchor.ts` changes |
| **The anchor test seam discriminates on a SQL substring and stubs only `.bind()`** — a future unbound `anomalies` statement would throw a `TypeError` that the guard swallows, leaving the test green for the wrong reason | Low | Repo | Source read: `packages/ledger/test/anchor.test.ts:60` (`anomaliesBrokenDb()`) and `:69` (`tsaMarkerBrokenDb()`), consumed at `:251` and `:266` | assurance | OPEN | none (Low) | when `packages/ledger/test/anchor.test.ts` changes |
| **`recordAnchorFailure`'s `ON CONFLICT` does not reset `status='open'`** while `raiseAlarm` does — and `raiseAlarm`'s comment claims to mirror it. An operator who resolves an anchor marker gets a row that keeps re-failing while reading `resolved`, invisible to the default `GET /v1/watchtower?status=open`. Pre-existing for the TSA path; now extended to a second failure kind (`anchor.build_failed`) | Med | Repo | Exact SQL diff. `packages/ledger/src/anchor.ts:344` → `... ON CONFLICT(id) DO UPDATE SET severity = excluded.severity, detail = excluded.detail` (no `status`). `workers/agents/src/watchtower.ts:161` → `... DO UPDATE SET severity = excluded.severity, detail = excluded.detail, status = 'open'`. `watchtower.ts:146` calls itself *"the anchor.ts self-clearing UPSERT pattern"* — it is not the same pattern | backend | OPEN | **R2** (an alarm that hides itself is a monitoring defect, and R2 requires alerts) | when either file changes |
| **The release-record binding is self-satisfied** — `evaluateEvidence`'s SHA/environment/fixtures/deployment mismatch checks can never fire | Low (latent) | Repo | `tools/release/run-gate.ts:142-144` builds the `PromotionContext` out of the `record` it just constructed, so every comparison compares a value with itself. `git grep -n "evaluateEvidence" -- . ':(exclude)docs'` → the only non-test consumer is `run-gate.ts:144`. Latent, **not live**: no promote step exists yet. Already recorded at `docs/ops/RELEASE-EVIDENCE.md:171` and `docs/security/threat-model.md:46` | assurance | OPEN | none today — **High** the day a separate promote step reads a record it did not write | when `tools/release/run-gate.ts` or `evidence.ts` changes, or the day a promote step is added |
| **REQ-167 is unverified in every local run** — `check:identity` reports `Lint SKIPPED — no denylist available` and fails closed only in CI (the eight-field restatement of the §3 row, which this re-audit downgraded from High to Med) | Med | Repo (the gate) + External (the denylist secret) | `pnpm -s check:identity` → `REQ-167: no denylist available … Lint SKIPPED — wire the secret before external contributions. NOTE: this gate fails CLOSED in CI (or when REQUIRE_DENYLIST is set); the skip is local-dev only.` exit 0. `pnpm -s check:identity -- --mode merge` → `##SHUDDL-GATE## {"gate":"identity-leak","status":"BLOCKED","executed":false,"assertions":0,"detail":"no denylist …"}`. CI binds it at `.github/workflows/ci.yml:49` | register owner (denylist contents) / infrastructure (the secret) | OPEN | **R1** for any *locally-made* mergeable claim; CI is closed | on binding `IDENTITY_DENYLIST` or creating `.identity-denylist.local`, or when `tools/checks/identity-leak.ts` changes |
| **REQ-288 is recorded as unbuilt while ~25 files implement it — and the fix is entangled** | Med | Repo (register + manifest data) | `tools/traceability/coverage-manifest.json:90` reads `"REQ-288": "vNEXT — P0 exact-artifact release evidence contract defined by the approved V2 framework; not built."` while `git grep -l "REQ-288"` returns 25 files including `tools/release/evidence.ts`, `tools/release/run-gate.ts` and `.github/workflows/ci.yml:47`; `pnpm check:coverage` lists it among the 8 drift rows. **Entanglement (why this is not a one-line fix):** the register row also carries `wp=P0`, which names no active WP, so advancing `status` alone routes it to `unclassified` and fails `check:coverage` (`tools/traceability/coverage.ts:105`) — while the manifest's own rule forbids a *built* row holding a deferral disposition. The `wp` amendment and the manifest removal must land together. **Deliberately not attempted in Task 6**, which owns this file, not the register | register owner | OPEN | **R1** (a coverage ledger that misrecords built scope is open Med debt) | when `genesis/09-REQUIREMENTS-REGISTER.csv` or `coverage-manifest.json` changes |
| **REQ-045 is a register DATA defect, not a build gap** — and it is the cleanest single fix among the eight drift rows | Low | Repo (one register cell) | Built: `packages/ledger/src/gates/transition-gates.ts:261-275` (`assertInterline`). Tested: `packages/ledger/test/transition-gates.test.ts:273`, `workers/api/test/gates.test.ts:163`. Register row: `spec=WP-05`, `wp=vNEXT`, `status=vNEXT` — the `spec` column **already names the WP** the `wp` column is missing, so the correct value is not a judgement call. Listed by `pnpm check:coverage` as drift | register owner | OPEN | **R1** | when `genesis/09-REQUIREMENTS-REGISTER.csv` changes |
| **§3's status-page row now misstates the portal** — it still reads "`GET /v1/board` is tenant-only; the portal party fleet is synthetic". That was true at WP-16 and was superseded by remediation Task 12; it is a stale record, **not** a regression | Med | Repo (this file) | Source read — no command reproduces a doc claim. The route serves TWO lenses: `workers/api/src/routes/board.ts:17-31` documents and implements the PARTY lens (party-relationship predicate in SQL + `generalizePosition`, REQ-085/074/025). The portal consumes it: `apps/portal/src/api/board.ts:6-7` (the seam's own header) and `:59-60` fetch `GET /v1/board` and Zod-`.strict()`-parse it. Corroborating grep: `git grep -n "demoFleet" -- ':(exclude)docs'` → the only definition is `packages/map/src/demo.ts:112`, **no app imports it**, and `apps/portal/src/App.test.tsx:77,88,124,145,156` asserts it is never called on five paths | assurance | OPEN | none (the code is right; the record is not) | when `workers/api/src/routes/board.ts` or `apps/portal/src/api/board.ts` changes |
| **Two path citations in this file do not resolve** | Med | Repo (this file) | Link-check of every backticked path in this file (113 distinct, `existsSync` each): `workers/api/src/internal-platform.ts` — cited twice, the file is `workers/api/src/routes/internal-platform.ts`; and `workers/api/src/do/sequencer.ts:700-708` for REQ-184 — that range is the `booking.created` gate, while the ratecon fail-closed marker is at `:926-929`. The two other misses are **not** defects: `docs/ops/threat-model.md` is cited as a negative example, and the `.claude/skills/…/reference-0006_….sql` name is elided prose | register owner | OPEN | none (record accuracy) | when this file or either cited source changes |
| **The 2026-07-15 60-agent audit — the closure record for both V1 Criticals — is not in the repository** | Med | Repo | `ls docs/audits/` → exactly one file, `2026-07-22-wp16-launch-gate-audit.md`. `git log --all --oneline -- docs/audits/2026-07-15-full-audit-and-skill-plan.md` → empty; it was never committed. (That command also prints `fatal: bad object refs/heads/codex/cl-d-driver 2` on this machine — an iCloud-spawned duplicate of a branch ref, i.e. the §3 iCloud hazard reaching `.git/refs`, not a result.) §4 of this file and `docs/audits/2026-07-22-wp16-launch-gate-audit.md:8` both cite it as the record that C-1 (REQ-190) and C-2 (REQ-191) are closed. The **closures** are independently checkable — both register rows read `F0-SPEC'D`, both are annotated, `pnpm check:traceability` is clean — but the audit that graded them cannot be re-read from a checkout | register owner | OPEN | **R0** (a baseline audit absent from the tree cannot be re-read at a later SHA) | when the audit is committed, or the citation is replaced by one that resolves |
| **The V2 phase vocabulary diverges between the register and the framework** | Low | Repo (register/doc data) | The 75 V2 register rows carry `wp` cells `P0` / `V2-A`…`V2-F` / `Cross-cutting` (`awk -F, '$1~/^REQ-2[1-8][0-9]$/' genesis/09-REQUIREMENTS-REGISTER.csv`); `docs/ops/V2-EXECUTION-FRAMEWORK.md` §6 allocates those same rows to phases named `P0` / `PA`…`PF`, and the string `V2-A` appears nowhere in it (`git grep -n "V2-A" -- docs` hits only the design plan and this file). Nothing is unallocated — §6's ranges cover the register's contiguous 75 rows with no gaps — but no document declares that `V2-A` and `PA` are the same phase | register owner | OPEN | none (naming) | when the register `wp` column or framework §6 changes |
| **Seven of the eight drift rows cannot be advanced by a status edit** — the register needs a `wp` amendment pass | Med | Repo (register data) | `pnpm check:coverage` → `coverage: 8 status-drift row(s) … REQ-045, REQ-170, REQ-184, REQ-249, REQ-276, REQ-284, REQ-285, REQ-288`. Their `wp` cells read: REQ-045 `vNEXT` · REQ-184 `vNEXT` · REQ-249 `V2-E` · REQ-276 `P0` · REQ-284 `P0` · REQ-285 `V2-F` · REQ-288 `P0` — **none names an active WP** (`tools/traceability/active-wps.json` = WP-01..WP-16), so a status edit routes each to `unclassified` and fails the gate (`coverage.ts:105`). Verified end-to-end on a scratch CSV in Task 5. **REQ-170 is the eighth and is different**: a genuine unbuilt residual, deliberately reverted (`workers/agents/src/biller.ts:594-601`). **Caution for the next auditor:** "unadvanceable by a status edit" ≠ "built". REQ-184's annotation is a fail-closed marker at `workers/api/src/do/sequencer.ts:700-708`, not an implementation — whether each of the seven is genuinely built is a separate, per-row question | register owner (owner-signed amendment) | OPEN | **R1** | when `genesis/09-REQUIREMENTS-REGISTER.csv` or `active-wps.json` changes |

Cleared 2026-07-25 (all four browser gates now PASS in `--mode merge`):

| Was failing | Gate | Now |
|---|---|---|
| 1,000-entity long task | `perf` | NOT a defect — it was compositor rasterization in a GPU-less harness (a zero-entity board blocked 358ms; a real GPU blocks 0ms). The budget is enforced where a hardware rasterizer exists. The REAL finding it masked — 58-62% main-thread occupancy drawing a static picture — is closed: **measured 58.6% → 20.3%**. |
| No blessed screenshots | `visual` | five blessed, each opened and reviewed. `visual: PASS — 5 passed`. |
| Stale visual ready-selectors | `visual` | repaired — and a fourth screen was found rotten the same way: `command.png` was capturing five NETWORK REQUEST FAILED panels, because its ready selector waited for a `canvas` that the failure state also has. |

Those visual failures were invisible until Task 14 installed the browser: the harness self-skipped to
exit 0, so a suite that could never pass reported green.

That table is **pre-schema history** and is deliberately not retrofitted to the eight fields — a cleared
row has no severity, no owner and no expiry to carry. Its clearance was nevertheless **re-proved on
2026-07-27** at HEAD `72b2fc2`, because a cleared gate that is never re-run is exactly the failure mode
Task 14 found:

| Command | Verdict |
|---|---|
| `pnpm -s test:a11y -- --mode merge` | `##SHUDDL-GATE## {"gate":"a11y","status":"PASS","executed":true,"assertions":4}` |
| `pnpm -s test:e2e -- --mode merge` | `##SHUDDL-GATE## {"gate":"e2e","status":"PASS","executed":true,"assertions":6}` |
| `pnpm -s test:visual -- --mode merge` | `##SHUDDL-GATE## {"gate":"visual","status":"PASS","executed":true,"assertions":5}` |
| `pnpm -s perf:map -- --mode merge` | `##SHUDDL-GATE## {"gate":"perf","status":"PASS","executed":true,"assertions":1}` |

Sixteen assertions, all executed, none skipped. That evidence expires at the next change to
`apps/**`, `packages/map/**` or the blessed baselines under `tests/visual/`.

---

## 5. The V1 close-out — the objective, question by question (Task 8, 2026-07-27, HEAD `dc26ea8`)

The close-out question is not "did the tasks finish" but **is the objective met**. Each answer below cites
either a command run at this SHA, or a file a reader can open. Where the proof **could not be produced
here**, the answer names the suite, states its last known verdict *and where that verdict came from*, and
marks it **unverified at this SHA**. A "no, and here is what would prove it" is a complete answer; a
green-sounding paragraph resting on an unrun suite is not.

Two facts govern every answer:

- **The environment hold.** `workerd` is wedged on this machine (failures ledger, row 2), so
  `packages/ledger`, all five `workers/*` suites, `pnpm test`, `pnpm test:acceptance`, `pnpm verify:dev`,
  `pnpm verify:merge` and `pnpm verify:release` could not be run during this entire close-out. Full
  diagnostic and remedy: [`RELEASE-EVIDENCE.md`](./RELEASE-EVIDENCE.md) § *Sweep — 2026-07-27*.
- **Which SHA the Task-7 sweep measured.** Its verdicts were obtained at `c09d9a5`. `dc26ea8` differs from
  it in two documentation files only (`git diff --name-only c09d9a5 dc26ea8` → `docs/ops/GO-LIVE-CHECKLIST.md`,
  `docs/ops/RELEASE-EVIDENCE.md`) — no source, test, fixture or config — so nothing those gates measure could
  have changed. **Rule 1 of `RELEASE-EVIDENCE.md` still binds an artifact to its exact SHA**, so they are
  formally evidence about `c09d9a5`. Where an answer below needed a verdict *at this SHA*, the command was
  re-run here and is marked as such.

### Q1 — Is all V1 Critical/High **code** debt closed? · **Criticals yes. Highs no: four survive.**

- **Criticals: zero open.** The two from the 2026-07-15 60-agent audit — C-1 `POST /v1/positions` consent/auth
  bypass (REQ-190) and C-2 duplicate `booking.created` (REQ-191) — closed at WP-09; both register rows read
  `F0-SPEC'D`, both are annotated, and `pnpm check:traceability` reports no orphan in either direction. The
  WP-16 launch-gate swarm re-probed the crown jewels and recorded
  `docs/audits/2026-07-22-wp16-launch-gate-audit.md:6` — *"Verdict: ZERO open Criticals. CLEAR-TO-CLOSE."*
  **Caveat, now a debt row:** the 2026-07-15 audit document itself was never committed, so its narrative
  cannot be re-read from a checkout; only its outcomes can.
- **Highs closed with a fix commit.** WP-16's one High — invoice-void AR divergence (REQ-209) — is **FIXED at
  `1d3cf83`** ("invoice void flips AR out of issued"). Its regression test exists and is readable
  (`packages/ledger/test/money-projection.test.ts:119`) but is a `workerd` suite, so **it was not run here**;
  the "reconciliation-tested" claim is the WP-16 audit's, at that SHA, not this close-out's. The four
  code-unremediated Highs the 2026-07-15 audit carried (identity-leak fail-open, idempotency-4xx memoization,
  design-CI blind spots, map bearing) were fixed and reconciled at WP-16 as REQ-167/206/207/208 — REQ-206/207/208
  read `F0-SPEC'D`, REQ-167 reads `F0.2-SPEC'D` (a standing process row), and all four are annotated. The
  `credit_status` write-ordering High landed at WP-11 (REQ-183, §3).
- **Four Highs survive, and each is a *stated hold*, not a closed row:**
  1. `anchors/run` backfill containment — **`FIXED †`** (`1aa0db5`, `8f24e68`, `501330c`, `6e33e89`, approved
     after three review rounds) but **never observed green in this environment**. The † is the whole point.
  2. **Ratecon generation unbuilt** (§3, REQ-184) — nothing writes a `documents` row of kind `ratecon`, so the
     REQ-043 dispatch gate cannot pass without a REQ-049 override. Fail-**closed**, at
     `workers/api/src/do/sequencer.ts:926-929`. Register `vNEXT`.
  3. **EDI B2A 04/05 convergence deferred** (§3, REQ-205) — `workers/translator/src/core/map-204.ts:70`; a
     PO-only re-tender yields a visible duplicate. Deliberate: a visible duplicate beats a silent merge.
  4. **EDI transport + inbound-204 HMAC resolver unwired** (§3, REQ-034/154) —
     `workers/translator/src/index.ts:27,36` return `NotConfiguredTransport` / `NotConfiguredSecretResolver`;
     every live 204 401s and nothing transmits.
- **Consequence for the grade.** §9 R1 reads *"zero open repository Critical/High debt **and** the
  authoritative merge gate passes."* Both clauses fail: three of the four Highs above are still graded High in
  §3, and `pnpm verify:merge` cannot be run at all. Either those three are re-graded with a written rationale
  (they are unbuilt scope behind fail-closed gates, not live defects), or R1 waits on them.

### Q2 — Is there a demo/mock success path in production clients? · **No fabricated data. Yes, a third-party demo tile host.**

The prescribed grep, run at this SHA, returns **six hits across five files, and all six are comments**:

```text
apps/command/src/lib/board.ts:3          "replaces the synthetic demoFleet() the map used to render"
apps/portal/src/App.tsx:70               "No demoFleet anywhere: a failure shows an honest stale/empty/…"
apps/portal/src/api/board.ts:7,40        "REPLACES the synthetic demoFleet…" / "a re-introduced demoFleet would be dropped"
apps/driver/src/components/GatedFlow.tsx:40   "the FOREGROUND geolocation reader that REPLACES the hardcoded MOCK_GEO"
apps/driver/src/flow/captures.ts:12      "Task 11 removes the hardcoded MOCK_GEO"
```

Proof, not assertion, that nothing behind them ships:

- `git grep -n "demoFleet" -- ':(exclude)docs'` — the only **definition** is `packages/map/src/demo.ts:112`; **no
  app imports it**. Every remaining reference is a test spy, and `apps/portal/src/App.test.tsx:77,88,124,145,156`
  asserts on five separate paths that it is never called.
- `git grep -n "MOCK_GEO"` — **no definition anywhere.** Three comments record its removal.
- The boards are server-scoped reads: `apps/portal/src/api/board.ts:59-60` fetches `GET /v1/board` and
  Zod-`.strict()`-parses it; `workers/api/src/routes/board.ts:17-31` resolves the lens from the JWT claim,
  applies the party-relationship predicate in SQL and generalizes coordinates server-side (REQ-085/074/025).
  A forged `?party_id` buys nothing.
- `git grep -niE "synthetic|fake|stub|placeholder" -- 'apps/*/src'` minus tests → **zero hits.**

**The honest residual.** All three shipping surfaces hardcode a public third-party demo basemap:
`apps/command/src/App.tsx:209`, `apps/portal/src/App.tsx:85` and `apps/portal/src/status.tsx:78` pass
`DEMO_TILE_URL` / `DEMO_GLYPHS_URL` = `https://tiles.openfreemap.org/{planet,fonts}`
(`packages/map/src/demo.ts:119,123`) — constants, not build vars. It fabricates no freight, no fleet and no
position, but it *is* a demo dependency on a shipping path and it sits against REQ-075's no-third-party rule
until the R2 self-host lands. Already recorded in §2 (*Self-hosted Protomaps vectors on R2*, blocks go-live).
**And a record defect found here:** §3's status-page row still says the portal party fleet is synthetic — three
tasks out of date. New failures-ledger row.

### Q3 — Is financial / evidence authority proven at this SHA? · **No. It is unproven, and the largest unproven thing in this close-out.**

| Claim | Suite / gate | Verdict, and where it was obtained |
|---|---|---|
| Invoice math matches the Rater **to the penny** on a 500-case replay (REQ-031, WP-06 DoD) | `pnpm check:invoice-parity -- --mode merge` | **BLOCKED, run at `dc26ea8`** — exit **2**, `##SHUDDL-GATE## {"gate":"invoice-parity","status":"BLOCKED","executed":false,"assertions":0,…}`. `invoice-500-replay` and `zone-tariff-v1` are not vendored. The harness's in-repo smoke did run: `invoice parity smoke — 5/5 in-repo synthetic cases: invoice === rater, penny for penny (harness live; NOT the 500-replay DoD)`. **Five synthetic cases are not the DoD** |
| **QB export reconciles to the penny** (CLAUDE.md rule 6) | `packages/ledger/test/qb-journal.fixture.test.ts`, `.../gl-netting.fixture.test.ts`, `.../iif.test.ts`, `workers/api/test/export-journal.test.ts` | **NOT RUN at this SHA — unverified.** All four are `vitest-pool-workers` suites (`packages/ledger/vitest.config.ts:1` is `defineWorkersConfig`), and `workerd` is wedged. The last recorded execution of those pools is the close-out plan's starting-state table (`docs/plans/2026-07-27-v1-closeout-t16-t17.md`, HEAD **`f269f95`**: api 719 tests / 65 files) — a SHA *before* the four Task-1 ledger commits, and **the same table records that suite as intermittently failing**. What *did* run here: `tools/checks/gl-accounts-parity.test.ts` → **6 passed at `dc26ea8`**, which proves the Biller's `GL_MAP` and the ledger money projection agree on the canonical GL chart — **not** that any export reconciles |
| Evidence hash / chain / anchor authority (canonical byte law, Merkle root, device signature, CMS receipt, upload hash-verify) | `packages/ledger/test/{canonical,roundtrip,chain,merkle,sign,cms,anchor}.test.ts`; `workers/api/test/{evidence-upload,documents,anchors}.test.ts` | **NOT RUN at this SHA — unverified.** Same pool, same hold, and no later verdict exists for these files anywhere: `PROJECT-STATE.md:97` lists all six pools under *"Not measured on 2026-07-27"*. The most recent recorded execution is the same `f269f95` starting-state table above. Nothing in this close-out re-observed any of them |

So: **this SHA proves nothing about the ledger, the sequencer, the gates, the queues or the API surface** — the
same line Task 7 drew. What would prove it, in order: reboot the machine → `pnpm -F @shuddl/ledger test` and
`pnpm -F @shuddl/api test` → `pnpm verify:merge` (one artifact replaces most of this page) → and, for the DoD
half of the money claim, vendor `invoice-500-replay` + `zone-tariff-v1` from the engagement workspace.

### Q4 — Are the release checks non-skippable? · **Yes mechanically, and its own guard tests execute here — but the gate they protect has never been run at this SHA.**

- `tools/release/run-gate.ts:41-81` — 12 plain + 9 skippable gates under `--profile merge`; 4 more under
  `--profile release`. Every skippable gate is spawned with `--mode <profile>` (`run-gate.ts:91-92`), so it never
  chooses the advisory branch.
- `tools/release/evidence.ts:148-151` `unavailableStatus` — the single disposition rule: `local` ⇒ `PENDING`
  (exit 0), `merge`/`release` ⇒ **`BLOCKED` (exit 2)**. `evidence.ts:130` — BLOCKED and PENDING both fail to
  promote; `evidence.ts:70-71` — a PASS must additionally carry `executed: true` and `assertions > 0`
  (*"a PASS asserting nothing is a skip in disguise"*), so a skip cannot wear a green coat.
- `tools/harness/playwright-guard.ts:59-64,89-92` — under `--mode merge|release` an absent browser, an empty
  suite or an all-skipped suite is BLOCKED with exit 2: *"every test was skipped … a skip is not a pass."*
- **Executed at `dc26ea8`:** `pnpm exec vitest run --config vitest.tools.config.ts tools/harness/playwright-guard.test.ts
  tools/release/evidence.test.ts tools/release/ci-contract.test.ts` → **3 files, 69 tests passed**, plus
  `tools/fixtures/fixtures.test.ts:39-52` (REQ-288: *"pending + merge → BLOCKED"*). Live behaviour at the same
  SHA: `check:invoice-parity -- --mode merge` exited **2**, not 0.
- **Three limits stated plainly:** (1) `pnpm verify:merge` itself cannot be run here, so the aggregate has never
  been observed at this SHA — under rule 1 this SHA has **no evidence record at all**; (2) `verify:release` is
  wired into no workflow (`RELEASE-EVIDENCE.md:129`) — a release record exists only if a human made one;
  (3) the record's own commit/environment/fixtures/deployment binding is **self-satisfied** by construction
  (`run-gate.ts:142-144`; failures ledger row 7), so it cannot catch a stale record until a separate promote
  step exists.

### Q5 — Is all technical debt documented? · **No at the start of this task; yes at this commit — and, by design, with the eight fields only in the two bottom ledgers.**

- **Scope of the schema.** §1.1 states it: the eight fields govern the **External holds** (10 rows) and
  **Repository-owned failures & debt** (11 rows before this task, **15 after**) ledgers. §2's operator tables and
  §3's debt tables keep their original columns as narrative history. That is a deliberate, declared exclusion —
  but the arithmetic is worth stating: this file carries **245 table rows**, and **25** of them carry the eight
  fields. Every known defect is *recorded* here; only those 25 are recorded to the schema.
- **This audit found four record defects that were not documented anywhere.** All four are now rows in the
  failures ledger with all eight fields: the stale portal-is-synthetic claim; two unresolvable path citations;
  the never-committed 2026-07-15 audit; and the V2 phase-vocabulary divergence.
- **A property worth knowing before editing this file.** Every `REQ-nnn` written here is a *recorded home* for
  `pnpm check:coverage` (`tools/traceability/coverage.ts:134`), and this file is excluded from the annotation
  scan (`tools/traceability/orphans.ts:66`). Citing an id here therefore records a **deferral** and can never
  mint a false claim that code shipped — the failure mode Task 3 hit in `PROJECT-STATE.md`. Rewording a row is
  safe; **deleting the last citation of a deferred id is not** — it drops that row's home and fails the gate.

### Q6 — Is the V2 design, requirements, DAG, owners, estimates, acceptance and evidence contract authoritative? · **Six of the seven are complete; estimates are complete for five of seven phases, by explicit design.**

| Part | Where | State |
|---|---|---|
| Design | `V2-EXECUTION-FRAMEWORK.md` §3 (storage/authority ownership + write-and-recovery rules), §4 (the single durable proposal state machine), §14 (failure semantics); design source `docs/plans/2026-07-23-v1-remediation-v2-framework-design.md` — **present in the tree** | Complete |
| Requirements | `genesis/09-REQUIREMENTS-REGISTER.csv` REQ-214…REQ-288 — **75 rows, verified contiguous, no gaps**, every row `vNEXT` with a phase in its `wp` cell | Complete |
| DAG | §5 — V1 R2 → P0 → PA → {PB, PC, PE} → PD → PF → R3/R4 → 30-day shadow → R5, with the shadow declared noncompressible | Complete |
| Owners | §6 (accountable lead per phase) + §11 (nine accountable roles, with *"no role may self-approve a control for which it produced the sole evidence"*) | Complete — **per phase and per role, not per requirement row**; the register carries no owner column |
| Estimates | §13 — P0 3–5 · PA 7–10 · PB 10–15 · PD 10–15 · PF 5–8 engineer-days | **5 of 7.** PC and PE are deliberately un-baselined until export size and the device matrix are measured; external lead times are named as lead times rather than hidden in engineering estimates |
| Acceptance | §8 — AT-1…AT-6, each requiring API assertions, role/cross-tenant probes, browser interaction, accessibility, degraded behaviour, reconciliation, a recording where material, and an exact-SHA evidence record | Complete |
| Evidence contract | §10 (the per-gate record schema + the anti-skip rules) with §9's six release grades R0…R5 | Complete |

Two caveats a reader must carry: (a) the register's `wp` cells say `V2-A`…`V2-F` while §6 says `PA`…`PF`, and
no document declares the equivalence — nothing is unallocated (§6's ranges cover all 75 rows), but the mapping
is inferred (new failures-ledger row); (b) **"authoritative" means recorded and approved, never built** — §1 of
the framework says so itself, and five V2 rows (REQ-249, REQ-276, REQ-284, REQ-285, REQ-288) already show status
drift, code annotated while the row still reads `vNEXT`.

### The close-out statement

> **At `dc26ea8`, V1 is a repository whose static, traceability, design and browser gates all pass and whose
> twelve runnable test suites pass 1,470 assertions with zero failures — and whose six ledger/Worker suites,
> five-demo acceptance spine and authoritative merge gate could not be executed here at all, so this SHA proves
> nothing about the ledger, the sequencer, the gates, the queues or the API surface. Staging is partially
> provisioned and certified in no respect: five placeholder resource ids, four secrets the checker cannot see,
> no CORS origins, no timestamp authority, no backup, and nothing deployed to smoke. Production is
> unprovisioned — nineteen placeholder ids, its secrets absent. Ten external holds are open, seven of them
> High, and two of those ten have no gate that could ever observe them; fifteen repository-owned rows are open,
> none Critical and none open-High — though the one High among them reads `FIXED †` precisely because it has
> never been observed green here, and §3 still grades three unbuilt, fail-closed rows High. V1 is not ready to
> launch, and no promotion is available from this commit: the merge gate has not run, so under rule 1 of
> `RELEASE-EVIDENCE.md` this SHA carries no evidence record at all.**
>
> *Where those green verdicts came from:* the gate list and the 1,470 assertions are the Task-7 sweep at
> `c09d9a5`, from which this SHA differs in two documentation files and no executable byte
> (`git diff --name-only c09d9a5 dc26ea8`). `check:coverage`, `check:traceability`, `check:invoice-parity` and
> the anti-skip guard tests were re-run at `dc26ea8` itself. Nothing in this statement is inferred from a gate
> that did not run.

What would change that sentence, in dependency order: **reboot** (clears H1 and the four † claims) → run
`pnpm verify:merge` (produces the first evidence record this SHA can have) → vendor the nine engagement
fixtures and bind `IDENTITY_DENYLIST` (clears five fail-closed gates) → provision staging resources and supply
`preflight --state` (converts *unproven* to *proven*) → deploy and smoke (clears H9 and unblocks the field rows)
→ back up and reconcile a restore (clears H8, then the drill) → name the on-call human and build the archive
tier (the two holds no command can see). Nothing in this repository can do any of them.
