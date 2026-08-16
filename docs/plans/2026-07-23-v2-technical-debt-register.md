# SHUDDL v2 — Technical-Debt Register

> **Record note (added 2026-08-01, on commit — 9 days after writing):** this is the verified debt inventory as of 2026-07-23, committed as a dated RECORD. The successor audit is `docs/audits/2026-08-01-technical-debt-audit.md`; the maintained ledger remains `docs/ops/GO-LIVE-CHECKLIST.md`. Parts of section (E) and several holds were resolved after this was written (exact point-in-polygon geo, the REQ-170 signature-byte gate, the driver login seam, real CORS origins, prod provisioning + the surfaces). `path:line` citations are FROZEN as-of 2026-07-23 and deliberately not repointed; enrolled in the citation ratchet as a dated record.
### Every deferred/incomplete item from prior builds. Product only (marketing-site/ and shuddl-site/ excluded). 2026-07-23.

> Cross-referenced against `genesis/09-REQUIREMENTS-REGISTER.csv` (213 rows), the team's existing debt ledger `docs/ops/GO-LIVE-CHECKLIST.md` (last fully synthesized 2026-07-19, stale re WP-13→16), and live code under `packages/`, `workers/`, `apps/`.
>
> **Severity:** `blocks-v2` = cannot go live / a gate is fail-closed for that feature · `degrades` = correctness/privacy/UX residual, safe default holds · `cosmetic` = deferred refinement or fail-safe.
>
> **Posture note:** almost every blocker below is **fail-closed today** — nothing silently ships wrong. The debt is *unbuilt* or *unwired*, not *broken*.

## (A) EDI debt
The Translator ships as its own worker (`workers/translator`) + dependency-free `packages/edi` (REQ-204). Format layer, inbound-204 parse, 214-outbound sweep, quarantine, cert gate, 990 scaffold are built and fixture-proven; **everything that touches a real wire is fail-closed and unwired.**

| Item | REQ | File(s) | Gap | Severity |
|---|---|---|---|---|
| Live outbound EDI transport (VAN/AS2/SFTP) unbuilt | REQ-034/200/154 | `workers/translator/src/transport.ts:45-67` (`NotConfiguredTransport`), `index.ts:20-41` | Default transport rejects loudly; no env can transmit a 214/990. Needs `EDI_TRANSPORT_URL`+`_TOKEN` secrets **and** a built adapter. | blocks-v2 |
| Inbound-204 HMAC secret store unwired | REQ-201/154 | `workers/translator/src/inbound.ts:48-57` (`NotConfiguredSecretResolver`) | Default resolver returns nothing → every live 204 → 401. Logic ships; secret store deferred (CONFIRM-gated). | blocks-v2 |
| B2A revision/replace (04/05) convergence for PO-only re-tenders | REQ-205 (F0-DEPLOY-NOTE) | `workers/translator/src/core/map-204.ts:61-77` | PO-only re-tender treated as distinct shipment → visible duplicate (preferred over silent merge, CLAUDE.md#10). Full convergence needs B2A 04/05. Wire before EDI go-live. | blocks-v2 (fail-closed) |
| Partner cert / per-partner LIVE activation | REQ-203 | `workers/translator/src/partners.ts:80-105` | Cert gate works, but `certifyPartner` validates mapping-shape only; round-trip-clean lives in the test harness. LIVE activation is a genesis/13 config-pack calendar object. | degrades |
| 990 tender-response — best-effort, no-ops when transport unwired | REQ-201 | `packages/edi/src/build-990.ts`, `inbound.ts:553-568` | Serializer + dedupe built + byte-stable; `send990` throws under NotConfigured, so ack deferred (204 still recorded). Lands with transport. | degrades→cosmetic |
| 214-sweep dedupe key not partner-qualified | REQ-200 follow-up | `sweep-214.ts:182-187` | `dedupeKey=edi214/<eventId>` bare; a live partner-side-dedup adapter risks cross-partner collision. Safe today. | degrades (latent) |
| 210-out, inbound-decoupling queue, Command EDI console | WP-12 | — | Out of the "lite" slice; Command EDI console is design-CI-blocking → later register-amended WP. | cosmetic |

**EDI fixture debt:** the primary-partner 204/214 round-trip uses a synthetic fixture (`workers/translator/test/roundtrip.fixture.test.ts:25`); real partner-format fixtures are a tenant-pack vendor item.

## (B) Geo / map debt

| Item | REQ | File(s) | Gap | Severity |
|---|---|---|---|---|
| Coarse 5-box reverse-geocode stub | REQ-166 | `packages/ledger/src/geo/jurisdiction.ts:26-64` | `deriveOperatingState` fail-closes to `XX` outside ~5 loose state boxes; a GPS stamp outside can never be consented. Point-in-polygon (Protomaps admin polygons) never landed. **v2 WP-A REQ-220.** | cosmetic (fail-closed) → v2-fix |
| OpenFreeMap demo tiles vs self-hosted Protomaps on R2 | REQ-075 | `packages/map/src/demo.ts:116-123`, `style.ts:9-34` | All three surfaces render off the **public keyless demo host**. Self-hosted Protomaps vectors + JetBrains-Mono glyph PBFs + offline SW cache unmet in production; REQ-075 ("no 3rd-party branding; airplane map loads") unmet. | blocks-v2 |
| Driver app mounts no map | REQ-071/073 | `apps/driver/src/` (no `@shuddl/map`) | Day-sheet + gated flow only; no live dot. **v2 WP-E REQ-244.** | degrades → v2-fix |
| Continuous 30s GPS emitter not built | REQ-071/070 | `apps/driver/src/flow/captures.ts:10-17` (`MOCK_GEO`) | Gate stamps ship; continuous `position.updated` cadence loop does not → live dot inert, battery budget unmeasurable. **v2 WP-E REQ-251.** | degrades → v2-fix |
| `facilities.lat_e6/lon_e6` present-but-unpopulated (no geocoding) | REQ-052/028 | `db/tenant/migrations/0002_domain.sql:76-78` | Columns exist; nothing geocodes an address in. No geocoding pipeline anywhere (`grep geocod`→0). **v2 WP-A REQ-216.** | degrades → v2-fix |
| Detention/dwell ± money math deferred | REQ-018 | `packages/ledger/src/geo/fence.ts:90-96` | Geofence math ships; detention money engine does not. | degrades |
| Live DO board fan-out is a no-op (polled read) | REQ-073/080 | `apps/command/src/App.tsx:51`, board route | Board is a polled `GET /v1/board`; real-time DO push is a seam. **v2 WP-E REQ-255.** | cosmetic → v2-fix |
| Optional Mapbox tile path conflicts REQ-075 | REQ-075 | `packages/map/src/style.ts:39-97` | Owner opt-in promo path on Mapbox tiles; documented tension. v2 uses Mapbox **data-only** (geocode/route), never tiles. | cosmetic |
| Map heading truthfulness — CLOSED at WP-16 | REQ-208 | `packages/map/src/bearing.ts` | Great-circle bearing + stationary-hold landed. Resolved. | — |

## (C) Parked / CONFIRM-gated postures (do NOT build until CONFIRM signed)

| REQ | Domain | Posture | File / note |
|---|---|---|---|
| REQ-104 | MCP | Direct default merchant posture | Counsel-gated; not built |
| REQ-103 | MCP | Credit-line guest posture | Counsel-gated; not built |
| REQ-033 | AGENTS | Settler escrowed instant settle | CONFIRM-2; synthetic-only (`tools/fixtures/gen-qb-journal-month.ts:18`) |
| REQ-143 | LEGAL | Settle/escrow money-transmission review | Gates REQ-033 |
| REQ-096 | COMMS | Voice numbers + consent-aware recording | CONFIRM-2; kind exists+redacted, capture deferred |
| REQ-137 | LEGAL | Call-recording consent policy per state | Gates REQ-096 |
| REQ-139 | LEGAL | Broker authority + insurance for Direct | Gates REQ-104 |
| REQ-130 | PLG | Pricing re-base on tenant-0 telemetry | Tier numbers are `[HYPOTHESIS]` |
| REQ-138 | LEGAL | ToS/Privacy/DPA for PLG signup | Public signup cannot open without it |
| REQ-140 | LEGAL | Photo/PII retention policy + consignee notice | Knobs exist; policy text unwritten |
| REQ-141 | LEGAL | Naming/trademark clearance | CONFIRM-1 |
| REQ-142 | LEGAL | eBOL/e-sig validity + driver location-consent text | Mechanism built (REQ-166); legal text pending |

**Other vNEXT parked scope:** REQ-029 dispatcher copilot (v2 WP-D builds the proposal), REQ-037 credit-officer engine, REQ-054 COD prompt, REQ-055 master-job consolidated invoicing, REQ-066 photo-dims/dimensioner, REQ-068 cartage-partner external-driver mode, REQ-072 ELD/telematics adapters, REQ-088 spend analytics/QBR, REQ-089 white-label, REQ-110 agent-to-agent tokens, REQ-128 demand-trap micro-sites, REQ-212/213 (defense-in-depth, drafted-in-skill only). *(REQ-045 interline gate is actually built+tested at `transition-gates.ts:247`; register tag lags.)*

## (D) Deploy-time prerequisites not yet provisioned
**Edge / public surface:** CF edge rate-limit on `/pub/*` + optional Turnstile on `/pub/quote` (REQ-193, blocks public GA) · CF per-IP rate-limit on `/pub/signup` (REQ-125) · sending-domain 2-week warmup >98% (REQ-157; `send.shuddl.tech` verified staging, prod ramp + Watchtower monitoring not run; **apex-vs-subdomain sender inconsistency unresolved**) · pen-test clean (REQ-136; STRIDE doc authored, run pending) · self-hosted Protomaps tiles + glyphs on R2 (REQ-075).
**Secrets / prod provisioning:** prod `JWT_SECRET`(+`STATUS_SECRET`/`DOC_SECRET`), `RESEND_API_KEY`+`EVIDENCE_FROM`, `IDENTITY_DENYLIST`, device signing root — prod set never enumerated · DKIM/SPF/DMARC prod NOT verified · Workers-Paid + D1×3/KV/R2/Queues×2 prod NOT provisioned · CF OIDC deferred (blocks CI deploy + nightly snapshots) · `workers/mcp` 4th worker not deployed (REQ-101/102/105 fail-closed) · Stripe/Twilio creds GAP (PLG/billing + SMS dark) · `PROVISIONING_ENABLED`/`PLATFORM_INTERNAL_SECRET` off (self-serve signup 404s) · real TSA RFC-3161 endpoint unconfigured (REQ-014, day left UNANCHORED, never faked) · CORS allowlist still `*.example` placeholders (`middleware/cors.ts:15-20`).
**Tenant-0 / config-pack (genesis/13):** live legacy-TMS mirror feed dark (REQ-152, `NotConfiguredFeedReader`) · tenant-0 seed load reproducing audited quotes (REQ-165) · M-AUTHORITY calendar gates (REQ-153) · clean-close signal wiring.
**Monitoring / DR:** nightly snapshots stub not active (REQ-117) · DR multi-region + restore drill never run (REQ-135) · SLO monitors defined not stood up (REQ-114) · DLQ drain runbook GAP.

## (E) Code markers — TODO / stub / placeholder / assumption
*No skipped tests exist anywhere (`.skip`/`xit`/`test.todo` → 0 hits).*

| File:line | Marker | Description | Severity |
|---|---|---|---|
| `workers/api/src/do/sequencer.ts:325` | TODO(REQ-030) | `serviceClass` POD-gate exemption unwired; gate always enforces (fail-safe). | cosmetic |
| `workers/translator/src/index.ts:20-41` | stub/CONFIRM | EDI NotConfigured composition roots — the go-live flip. | blocks-v2 |
| `workers/translator/src/core/map-204.ts:70` | deferred | B2A revision-code convergence (REQ-205). | blocks-v2 |
| `packages/ledger/src/geo/jurisdiction.ts:9-26` | STUB | Coarse bounding-box geo; point-in-polygon = v2 WP-A. | cosmetic→v2 |
| `packages/ledger/src/geo/fence.ts:96` | DEFERRED | detention/dwell money calc (REQ-018). | degrades |
| `packages/map/src/demo.ts:116-123`, `style.ts:10-11` | assumption/PLACEHOLDER | demo tile/glyph endpoints; self-host on R2 = deploy (REQ-075). | blocks-v2 |
| `packages/ledger/src/gates/transition-gates.ts:185-191` | UNIMPLEMENTED | REQ-170 missing-evidence send-gate residual (photo-URL resolver deferred). | degrades |
| `packages/ledger/src/projection/status-cache.ts:23,97` | ASSUMPTION/placeholder | shipper==requester; `executor_party_id=bill_to` until dispatch/T8. | cosmetic |
| `packages/agents/src/concierge/resolve.ts:167` | ASSUMPTION | consignee/bill-to firm at booking (REQ-181). | cosmetic |
| `workers/agents/src/biller.ts:173,456-480` | ASSUMPTION(stale)/placeholder | stale "no booking flow" comment; evidence `photos:{}` slots; REQ-170 signed-URL resolver unwired; `referralBase` re-render drift. | degrades |
| `packages/agents/src/biller/sender.ts:266` | throws | SMS non-retriable hold — Twilio adapter unwired (REQ-097). | cosmetic |
| `apps/driver/src/flow/captures.ts:16` | MOCK_GEO | fixed GPS stamp; 30s emitter not shipped (v2 WP-E). | degrades→v2 |
| `apps/driver/src/session.ts` | deferred | driver login/magic-link/PIN + lockout not built; only P-256 key (REQ-069). | degrades→v2 |
| `apps/driver/src/flow/stop-flow.ts` | single-stop | `buildFlow` single-stop; round-trip/stop-off deferred (REQ-053). | cosmetic |
| `workers/api/src/routes/exceptions.ts:27`, `approvals.ts:26` | WP-10 assumption | "resolved" heuristic; flat role match not hierarchy. | cosmetic |
| `workers/mcp/src/webhooks.ts` | scaffolded | `NotConfiguredEventSource` yields `[]` until wired (REQ-109). | cosmetic |
| `packages/ledger/src/tsa/der.ts:323`, `contracts/src/events.ts:130` | stale/reserved | CMS-verify comment stale (landed WP-16); `cosig` reserved comment. | informational |

**Env debt (iCloud):** duplicate `" 2.*"` files physically present, corrupting file-count budget gates — e.g. `packages/ledger/src/tsa/cms 2.ts`, `packages/map/src/bearing 2.ts`, `docs/security/pen-test-basics 2.md`. **Fix: `find . -name "* 2.*"` each session; durable fix = move repo off `~/Desktop` iCloud (v2 REQ-273, merge-gating).**

## (F) Test / fixture / CI debt

| Item | REQ | Nature | Severity |
|---|---|---|---|
| Design/squint + perf CI **advisory** until WP-10 exit, blocking after | REQ-158/207 | Job still labeled `design-advisory`; the strict flip rides `--strict` in `audit:design`, not the job name — **verify the flip is actually active** now WP-10 has exited. | degrades (verify) |
| Identity-leak lint **fails OPEN** with no denylist locally | REQ-167/211 | `tools/checks/identity-leak.ts:35-61` warns when `IDENTITY_DENYLIST` absent. CI pins closed via `REQUIRE_DENYLIST=1`; local/other runners fail open. **The one genuine fail-open gate.** | blocks-v2 (leak risk) |
| Engagement-workspace fixtures **un-vendored** (harnesses loud-skip, never false-green) | REQ-112/165/027/031/026 | `zone-tariff-v1`, `rater-48-tests`, `rater-504-sweep`, `invoice-500-replay`, `concierge-parse-50`, `customer-roster`, `legacy-import/export`, `synthetic-blitz-3100` — dirs absent. None block merge; each blocks its WP DoD. A *partial* tariff vendor flips harnesses to hard-fail. | blocks-v2 (per-WP DoD) |
| MCP live-booking E2E is a recording-fake / staging smoke | REQ-101 | api tenant D1 + Sequencer DO unseedable in mcp vitest pool; needs a cross-worker staging smoke. | cosmetic |
| 5 blessed Playwright screenshots + measured map perf | REQ-158/079 | design CI self-skips in sandbox; deferred to first browser-capable CI. | cosmetic |
| Airplane-mode soak flake | — | timing-sensitive; 30s ceiling added; watch for regression. | cosmetic |

## (G) Other incomplete-build debt

| Item | REQ | Gap | Severity |
|---|---|---|---|
| **Ratecon generation unbuilt → dispatch gate fail-closed** | REQ-184(vNEXT)/043 | Nothing writes a `documents` row of kind `ratecon`; REQ-043 dispatch gate cannot pass without a named override. **No real dispatch until a booking/dispatch step generates it.** | blocks-v2 |
| REQ-170 missing-evidence send-gate UNIMPLEMENTED | REQ-170 | A POD with a fabricated hash + no R2 upload still triggers an evidence email framing itself as "the record." Money invoice valid (REQ-168 closes pre-upload byte-law); this is the send-side residual. | degrades |
| Driver auth + lockout deferred | REQ-069 | Only a per-device P-256 key — no login/magic-link/PIN, no lockout. **v2 WP-E REQ-252.** | degrades→v2 |
| `credit_status` projection write-ordering — LANDED WP-11 | REQ-183 | Fixed (asserts rows-affected==0 → anomalies); register tag still `WP08-DISCOVERED`. | resolved (tag lag) |
| Multi-factor cost surface + per-leg interline floors | REQ-040/027 | Floors ride linehaul-freight cost proxy (conservative, over-escalates); real op-cost surface needs an op-cost event kind + engagement input. | cosmetic (conservative) |
| True OR relabeled | REQ-083 | No op-cost kind; KPI honestly "Cost/Rev (quoted basis)." | cosmetic |
| **WP-15 overlay machinery DARK/inert** | REQ-152/153/023/008/035 | Mirror/flip/fallback all built+fixture-proven but nothing mirrors/flips/falls-back until a live feed + tenant-calendar gates go green. **v2 cross-cutting REQ-270 wires a synthetic feed so parity converges before any flip.** | degrades (cutover-gated) |
| WP-13 MCP residuals | REQ-105/102 | caps reserve-at-check over-counts on rare post-accept api failure (fails closed, self-heals); immediate cross-method OAuth revocation deferred; lane cap dest-zone only. | cosmetic |
| WP-14 PLG residuals | REQ-123/124/126 | All dark until R4; tier numbers `[HYPOTHESIS]`; credit-append doesn't bind `invoice_id`; `_platform` GL uncovered by parity. | cosmetic |
| Per-ping raw-position co-signing (open CONFIRM) | REQ-018 | Whether each raw GPS ping is per-ping co-signed is open; the 3 auth gates (assignment/device/consent) ARE enforced (REQ-190). | cosmetic |
| Server-side GPS plausibility cross-check | WP-05 | Device signs own geo = attribution not server-truth; no speed/teleport corroboration. | cosmetic (future) |
| REQ-111 log→ledger unification | REQ-111 | Needs a 36th kind (breaks 35-freeze); logs stay event-shaped. Deferred. | cosmetic |
| **PROJECT-STATE.md stale** (dated 2026-07-14, pre-WP-08) | — | "done" stops at WP-06; test count stale; misleads status reads. Re-baseline WP-07→16. | degrades (docs) |
| Register status tags lag code | REQ-120 | Rows read `*-DISCOVERED`/`vNEXT` though code shipped (REQ-169/176/178/179/180/183 + OTD). Advance at next register review. | cosmetic (hygiene) |

## Cross-cutting summary for the owner
1. **The five highest-impact `blocks-v2` debts:** (a) live EDI transport + inbound HMAC store (REQ-034/154) + B2A convergence (REQ-205); (b) ratecon generation → no real dispatch (REQ-184); (c) self-hosted tiles on R2 (REQ-075); (d) sending-domain warmup + prod sender verification (REQ-157); (e) CF edge rate-limit/Turnstile on `/pub/*` and `/pub/signup` (REQ-193/125). **Each is fail-closed today.**
2. **One genuine fail-open:** the identity-leak lint locally (REQ-167) — closed in canonical CI, open on other runners.
3. **Register accounting is complete and self-aware:** 213 rows, deferrals classified by `tools/traceability/coverage.ts`; `docs/ops/GO-LIVE-CHECKLIST.md` is the maintained ledger (its §2/§3 last synthesized 2026-07-19; WP-13→16 appended piecemeal; `PROJECT-STATE.md` stale).

**How v2 pays this down:** WP-A closes geo (B) + the reverse-geocode stub + facility geocoding + the dedupe housekeeping (REQ-273). WP-E closes the driver-map/GPS/board/auth debt (B, parts of G). The cross-cutting REQ-270 lights the dark overlay machinery. EDI go-live (A), self-hosted tiles, warmup, ratecon, and the deploy prerequisites (D) are explicit **production-gate line items** each phase's exit gate checks — see the phase-gated plan.
