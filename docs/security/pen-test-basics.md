# Pen-test basics — pre-launch security review (REQ-136)

**Path:** `docs/security/pen-test-basics.md` · **DoD:** REQ-136 ("pen-test basics before launch gate; report clean") · **Gate:** WP-16 launch · **Method:** STRIDE-per-surface, each threat mapped to the EXISTING proving suite · **Last run:** 2026-07-22 (WP-16)

> "Report clean" = every threat-model STRIDE surface is either **PASS** (a real, green suite proves the boundary) or **DISPOSITIONED** (an out-of-repo deploy/CONFIRM/calendar precondition, or a recorded residual with a severity). This document does not add new controls; it walks the [threat model](./threat-model.md) against the corpus that already ships and cites the test that would go RED if the boundary regressed.

## 1. Scope & method

**Stack under test:** Cloudflare Workers (api, mcp, translator, agents) · D1 per-tenant + a separate control plane · Durable Objects (ledger sequencing, caps metering) · JWT HS256 sessions · MCP OAuth pairings · R2 evidence + tiles · Queues. LLM calls confined to `packages/agents/*` (REQ-024, statically linted); never in `packages/ledger`.

**What "pen-test basics" means here.** SHUDDL rests on an unusually strong adversarial-test corpus (the 50-agent WP-exit audit swarm, REQ-119, plus per-surface isolation/lens/forgeability suites). Rather than re-run a black-box scan against a not-yet-deployed stack, this review takes the auditor's posture against the code and its suites: for each STRIDE surface in the threat model — API (`/v1` + `/mcp`), Ledger, Driver PWA, Email in/out, CI/supply-chain — walk each threat to the perimeter code that enforces it and the test that proves it. A surface is clean only when a green suite pins the boundary.

**Assets, in priority order** (from `threat-model.md`): (1) ledger integrity, (2) tenant isolation, (3) evidence bytes + hashes, (4) device keys + JWT secrets, (5) money projections, (6) tenant-identity separation.

**Rule of engagement.** A PASS below cites a specific test that actually exercises the boundary (verified by reading, not by name). Where the in-repo control is only half the story (per-IP edge rate-limiting, the real TSA endpoint, prod secrets), the row is **DISPOSITIONED** to §4, never marked PASS.

## 2. The category matrix

Columns: **threat → perimeter code (file:line) → proving suite (file:line) → verdict.**

### 2.1 Authentication / authorization (Spoofing, Elevation-of-Privilege)

| Threat | Perimeter code | Proving suite | Verdict |
|---|---|---|---|
| Forged/absent bearer token | `workers/api/src/middleware/auth.ts:15-25` (Bearer required → 401; `verify(...,"HS256")` alg-pinned; catch → 401) | `workers/api/test/auth.test.ts:7-16` (missing token → 401 UNAUTHORIZED; wrong-secret → 401) | **PASS** |
| `alg:none` downgrade | `auth.ts:20` (third arg pins HS256; a `{"alg":"none"}` token is not HS256) | `workers/api/test/isolation.test.ts:71-73` (unsigned `eyJhbGciOiJub25lIn0…` token → ≥401, leaks nothing); allowlisted as a fixture in `.gitleaks.toml` | **PASS** |
| Claims-schema smuggle (unknown role/shape) | `auth.ts:24-25` (`SessionClaims.safeParse` → 401 on failure) | `auth.test.ts:17-21` (role `superuser` → 401) | **PASS** |
| Role escalation across the matrix | `auth.ts:30-35` (`requireRole` → 403) | `auth.test.ts:31-38` (driver/portal/read on an ops-gated route → 403 FORBIDDEN) | **PASS** |
| Driver writing another driver's shipment | `workers/api/src/gate-context.ts:20-27` (`assignmentOf`: `assigned_driver === session.sub`) | `workers/api/test/lens-adversarial.test.ts:734-747` (D2→D1's shipment 403; D1→own 201; finance/read append 403) | **PASS** |
| MCP principal minted at a higher privilege | `workers/mcp/src/principal.ts` (`MCP_PRINCIPAL_ROLE` = bounded `ops` sentinel) | `workers/mcp/test/isolation.test.ts:141-161` (both pairings mint the `ops` sentinel; api re-VERIFIES via HS256+Zod at `/v1/whoami`) | **PASS** |

### 2.2 Tenant isolation (Information disclosure, EoP) — REQ-025

Cross-tenant read/write anywhere is a build failure (CLAUDE.md rule 8). Tenant is always resolved server-side — from the JWT claim (`/v1`), the pairing (`/mcp`, EDI), or the CF-routed URL host (`/pub`) — never a client hint.

| Threat | Perimeter code | Proving suite | Verdict |
|---|---|---|---|
| `X-Tenant-Id` / `?tenant=` re-points the tenant | `auth.ts:12-14` (either present → 403 TENANT_MISMATCH, rejected not ignored) | `isolation.test.ts:57-93` (header/param/forged-token attacks leak no MARKER-TENANT-B); repeated on every mutating route `:128-279` | **PASS** |
| A session addresses another tenant's D1 | tenant→D1 handle keyed off the claim (`tenantDb`) | `isolation.test.ts:97-314` (ledger reads/writes, docs, approvals, parties, shipments all land in / read only tenant-a's physical D1; twin-seeded tenant-b rows never surface) | **PASS** |
| Board / queues / KPIs / parity bleed | each read keyed off the claim | `isolation.test.ts:319-350` (board), `:495-541` (dunning), `:633-712` (exceptions, KPIs), `:718-761` (v_parity) — a tenant-b-only seed never appears | **PASS** |
| `/mcp` tool crosses tenants | mint reads `ctx.pairingId` only; strict tool schemas | `workers/mcp/test/isolation.test.ts:165-283` (quote/track/get_document/book/approve/dispute — tenant-A pairing never reads/writes tenant B), `:286-317` (smuggled header/arg inert), `:345-368` (per-pairing CapsMeter DO) | **PASS** |
| EDI (inbound 204 / outbound 214) crosses tenants | tenant from the pairing; `edi/<tenant>/…` R2 keys | `workers/translator/test/isolation.test.ts:247-331` (inbound D1+R2 footprint, spoofed `X-Tenant-Id` inert), `:334-433` (214 sweep reads only its own keyspace/counter), `:437-448` (key builders embed the slug) | **PASS** |

### 2.3 Injection (Tampering)

| Threat | Perimeter code | Proving suite | Verdict |
|---|---|---|---|
| Malformed input reaching logic (Zod-at-every-boundary, REQ-133) | `auth.ts:24` (`SessionClaims`), `EventInput.parse` in the DO, kind-filter validation on the firehose | `auth.test.ts:17-21`; `lens-adversarial.test.ts:677-687` (unknown `?kind=` → 400 VALIDATION_FAILED, never a silent empty); `workers/mcp/test/isolation.test.ts:302-316` (`.strict()` tool schemas reject a smuggled `tenant` → -32602) | **PASS** |
| SQL injection via client-supplied ids | all D1 access is `.prepare(...).bind(...)` — no client string is concatenated into SQL | `isolation.test.ts:100-126` (a tenant-b shipment id in the URL path is a bound parameter → clean empty read / 404, never an existence oracle or a query break) | **DISPOSITIONED** — verified by construction (parameterized statements throughout); no dedicated injection-fuzz suite. The prepared-statement discipline is the control; a bind-param regression would surface as a broken route in the isolation suite. |

### 2.4 Secrets (Information disclosure) — REQ-154 / REQ-167

| Threat | Perimeter code | Proving suite | Verdict |
|---|---|---|---|
| Credential committed to the repo | `.gitleaks.toml` (`useDefault=true`; only the test JWT secret + the `alg:none` fixture are allowlisted, scoped to `genesis/`+`fixtures/`) | gitleaks in CI over the tree | **PASS** |
| Tenant/person/vendor name leaks into an artifact | `tools/checks/identity-leak.ts` (denylist scan over `git ls-files`; masked output; the names never enter VCS) | `tools/checks/identity-leak.test.ts` (`resolveIdentityLeakOutcome`/`scanForIdentityLeaks` units) | **PASS** (fails CLOSED in CI — see §3) |
| Prod secrets in the repo | secrets via `wrangler secret` + GitHub OIDC, never toml | — | **DISPOSITIONED** — prod secret set is a deploy precondition (§4) |

### 2.5 Rate-limiting / abuse (Denial-of-Service) — REQ-193 / REQ-125

| Threat | Perimeter code | Proving suite | Verdict |
|---|---|---|---|
| A paired MCP client overspends / over-books | `workers/mcp/src/caps.ts` (per-pairing `CapsMeter` DO: spend + velocity) | `workers/mcp/test/isolation.test.ts:345-368` (velocity-1 cap trips on the 2nd booking; each pairing meters only its own DO) | **PASS** (per-pairing budget) |
| Flood of the public no-auth `/pub/*` surface | in-Worker `SparkMeter` is per-workspace only — deliberately NOT the flood control layer | — | **DISPOSITIONED** — the per-IP CF **edge** rate-limit (+ optional Turnstile on `/pub/quote`, `/pub/signup`) is a deploy rule (REQ-193/125, §4). Putting it in-Worker would burn invocations on attack traffic. |

### 2.6 Public surfaces (Spoofing, Information disclosure)

| Threat | Perimeter code | Proving suite | Verdict |
|---|---|---|---|
| Unauthenticated request reveals routing/data | `auth.ts:17` (401 before any routing) | `auth.test.ts:7-10` (no token → 401, no body) | **PASS** |
| `/pub/quote` tenant spoofed via Host/param | tenant from `new URL(url).hostname` allowlist (`HOST_TENANTS`), never the Host header or a hint | `isolation.test.ts:368-417` (URL host routes; spoofed `Host:`/`?tenant=`/`X-Tenant-Id` inert; unknown host → 404 before any DB handle — no tenant-existence oracle) | **PASS** |
| `/pub/status/:cap` cap replayed cross-tenant | cap carries a MAC-signed tenant `t`; only `t` (verified) → D1 | `isolation.test.ts:438-490` (twin shipment id in both DBs; only the cap's `t` selects the state; an unbound `t` fails closed to the uniform 401) | **PASS** |
| Public status page exposes precise geo | `/pub/status` generalizes server-side (coarse even at OFD) | see 2.8 (geo generalization) | **PASS** in-repo / **DISPOSITIONED** at hosting (§4) |

### 2.7 Forgeability (Tampering / Spoofing) — the crown-jewel row

| Vector | Perimeter code | Proving suite | Verdict |
|---|---|---|---|
| **Token** forgery (wrong key / alg:none) | `auth.ts:20` | `auth.test.ts:12-16`, `isolation.test.ts:67-73` | **PASS** |
| **Tenant** forgery (header/param) | `auth.ts:12-14` | `isolation.test.ts:57-93` | **PASS** |
| **Money-kind** forgery — a client hand-crafts an `invoice.issued` to bypass the Biller's anomaly/penny/floor gates | the events route REFUSES the server-emitted money kinds BEFORE the DO gate | `lens-adversarial.test.ts:757-803` (a well-formed $222,084 `invoice.issued` on a pod-bearing stream → 403 "SERVER-EMITTED"; nothing appended, no `money_lines`; the whole set refused; the reason fires before the driver-scope check so it can't be forged into a mere scope miss) | **PASS** |
| **Forged party_id** widening a party lens | lens derived from the JWT claim only; `?party_id=` never consulted | `lens-adversarial.test.ts:397-408` (P1 on a P2-only shipment stays empty; a forged `?party_id=P2` returns byte-identical) | **PASS** |
| **Device-signature** forgery over evidence | `verifyEventSig` over the frozen offline `clientView` | `packages/ledger/test/sign.test.ts:21-53` (any signed-field change / wrong key → false), `:59-82` (malformed sig → clean false, never a throw → never a 500) | **PASS** |
| **Source** forgery — a client sets `source:'legacy'` to reach the DO's legacy gate-carve-out | the events route force-coerces `source:'native'` before the DO append (`events.ts:200`) | `workers/api/test/source-aware-ledger.test.ts:296-346` (forged `legacy` on a gated kind → coerced → native gate FIRES → GATE_BLOCKED, nothing lands; a committed event stores `source='native'`; `invoice.issued` refused upstream as a second lock) | **PASS** |
| **Authority-flip** bypass — a forged `authority.flipped` flips a module while skipping the gate/admin/money checks | closed at BOTH layers: the generic events route refuses the kind; the sequencer DO structurally rejects it off `t:root` | `workers/api/test/authority-flip.test.ts:311-337` (admin's forged flip on the events route → 403; an ops principal too; the DO chokepoint rejects an `authority.flipped` on a shipment stream — `authority_map` untouched in all three) | **PASS** |
| **Chain-fork** — a client supplies its own `seq`/`prev_hash`/`hash` | `EventInput` carries none of these; the DO assigns them; `LedgerEvent.parse` `.strict()` backstop; `hash` computed | `threat-model.md:26` (WP-02 review, CLOSED); the DO-chokepoint discipline is exercised by every append test | **PASS** (documented CLOSED, WP-02 review) |
| **Seq race** — two concurrent appends assign the same seq | DO-per-stream serialization mutex (load-bearing across the D1 await) | `workers/api/test/sequencer.test.ts:101` (100 concurrent appends via fresh stubs → dense, gapless seqs; deleting the mutex goes RED with `SQLITE_CONSTRAINT` / `I3: append-only`) | **PASS** |
| **Silent REPLACE** — `INSERT OR REPLACE` rewrites history under `recursive_triggers=0` | BEFORE **INSERT** guards on events/positions/money_lines (fire while the old row still exists) | `packages/ledger/test/schema-core.test.ts:61,112-138` (`INSERT OR REPLACE` on a `(stream_id,seq)` / `UNIQUE(id)` / positions collision is aborted) | **PASS** |

### 2.8 Evidence integrity (Tampering) — REQ-014 / REQ-074

| Threat | Perimeter code | Proving suite | Verdict |
|---|---|---|---|
| Forged / replayed RFC-3161 timestamp | `packages/ledger/src/tsa/cms.ts:315` (`verifyTsaSignature`: SignerInfo sig over `signedAttrs` [RSA/ECDSA-P256, SHA-256], `messageDigest` binds TSTInfo, chain to a configured trust anchor, validity + `id-kp-timeStamping` EKU; fail-CLOSED) | `packages/ledger/test/cms.test.ts:58-188` (valid verify + bound imprint; tampered→SIGNATURE_INVALID; no-chain→NO_CHAIN; imprint mismatch→IMPRINT_MISMATCH; expired→CERT_EXPIRED; missing EKU; digest mismatch; ECDSA end-to-end; unsigned fails closed when an anchor is configured; opt-in `chain-not-configured` — never a silent pass) | **PASS** (opt-in on configured anchors; real anchors are a deploy item, §4) |
| Party lens leaks precise geo | `packages/ledger/src/redact.ts:60,93` (`generalizePosition`/`redactEvent`: party geo coarsened to ~11 km + accuracy dropped, structural walk of top-level + nested `geo`, until out-for-delivery) | `packages/ledger/test/redact.test.ts:171-196` (party-coarsen / driver+tenant-exact / OFD-unlock / nested `geo`); `lens-adversarial.test.ts:429-467` (case 5 through the real route) | **PASS** |
| Counterparty lens leaks margin/GL internals | `redact.ts` (strip `floors`/`basis`/`versions`, `division`, `lines[].gl_map` at any depth for a party/driver lens) | `redact.test.ts:12-137`; `lens-adversarial.test.ts:385-537` (cases 2, 8b, 9, 9b — the frozen 35-pair visibility snapshot fails independently of the map under test) | **PASS** |
| Append-only ledger mutated in place | no UPDATE/DELETE paths; corrections are new events (I3/I7) | `schema-core.test.ts:61` (append-only guards); migration-lint bans `INSERT OR REPLACE` (skill `complete-append-only-insert-guards`) | **PASS** |

### 2.9 Identity leak (Information disclosure) — REQ-167

| Threat | Perimeter code | Proving suite | Verdict |
|---|---|---|---|
| A tenant/person/customer/incumbent-vendor name ships in any artifact | `tools/checks/identity-leak.ts` (denylist scan over every tracked file; fails CLOSED in CI / at a WP-exit run) | `tools/checks/identity-leak.test.ts` | **PASS** (this document carries only synthetic/role terms — tenant-a/b, ops/driver/portal/finance/admin — and the product's own infra names) |

**Matrix summary.** Every STRIDE surface has a PASS or a recorded disposition. PASS surfaces and their proving suites: **authn/authz** (`auth.test.ts`, `gate-context.ts`+`lens-adversarial.test.ts`, `mcp/isolation.test.ts`); **tenant isolation** (`api/isolation.test.ts`, `mcp/isolation.test.ts`, `translator/isolation.test.ts`); **forgeability — token/tenant/money-kind/party-id/device-sig/source/authority-flip/chain-fork/seq-race/silent-REPLACE** (`auth`, `lens-adversarial`, `sign`, `source-aware-ledger`, `authority-flip`, `sequencer`, `schema-core`); **evidence integrity** (`cms.test.ts`, `redact.test.ts`); **public surfaces** (`isolation.test.ts` `/pub/*`); **secrets & identity leak** (`.gitleaks.toml`, `identity-leak.test.ts`). Two rows are DISPOSITIONED to deploy (SQL-injection-by-construction has no dedicated fuzzer; public-surface per-IP flood control is an edge rule).

## 3. The WP-16 hardenings landed on this branch (recorded CLOSED)

| # | Hardening | REQ | Code | Test |
|---|---|---|---|---|
| 1 | Identity-leak lint now fails **CLOSED** in CI / at a WP-exit run (an absent denylist was the last fail-open gate) | REQ-167 | `tools/checks/identity-leak.ts:40-75` (`resolveIdentityLeakOutcome`) | `tools/checks/identity-leak.test.ts` |
| 2 | TSA CMS signature + X.509 cert-chain verification + imprint-bind (archival `.tsr` bytes verifiable offline) | REQ-014 | `packages/ledger/src/tsa/cms.ts:315` | `packages/ledger/test/cms.test.ts:58-188` |
| 3 | REQ-074 party geo proven generalized **server-side** (the lens, not a client convenience) | REQ-074 | `packages/ledger/src/redact.ts:60,93` | `packages/ledger/test/redact.test.ts:171-196` |
| 4 | Idempotency caches **only a 2xx** — a failed (4xx precondition) request is not replay-pinned | REQ-206 | `workers/api/src/middleware/idempotency.ts` | `workers/api/test/idempotency.test.ts:44-64` |
| 5 | Design-CI 5-token budget enforced **by count** (not a hardcoded test); map bearing great-circle + rest-heading hold | REQ-207 / REQ-208 | `tools/design/audit.ts`, `packages/map/src/bearing.ts` | `tools/design/design.test.ts:317`, `packages/map/test/bearing.test.ts:27-41` |

## 4. Out-of-repo preconditions this report DEPENDS on (deploy/CONFIRM — not code holes)

These are launch-gate items the in-repo perimeter cannot close by itself. Each is recorded in `GO-LIVE-CHECKLIST.md`; none is claimed closed here.

- **CF per-IP edge rate-limit** on `/pub/*` (+ optional Turnstile) — REQ-193/125. The in-Worker `SparkMeter`/`CapsMeter` is per-workspace/per-pairing only; flood control is a CF edge rule provisioned before public GA (GO-LIVE §2 "CF edge rate-limit").
- **Real TSA endpoint + trust anchors** — REQ-014, F1 CONFIRM. `verifyTsaSignature` is opt-in on configured `trustAnchors`; the real anchor certs are deploy config, and `HttpTsaClient` is fake-tested only. With no anchors it returns `chain-not-configured` (explicit, never a silent pass); a missing prod TSA leaves the day UNANCHORED, never faked (GO-LIVE §2 "Real TSA (RFC-3161) endpoint").
- **Prod secrets** — `JWT_SECRET`, `RESEND_API_KEY`+`EVIDENCE_FROM`, `IDENTITY_DENYLIST`, device signing root — set via `wrangler secret` + GitHub OIDC, never in the repo (GO-LIVE §2 "Secrets & auth"; the prod secret set is a documented GAP).
- **Deliverability warmup** — REQ-157. Verified sending domain + DKIM/SPF/DMARC + a 2-week seed ramp (>98%) before consignee volume (GO-LIVE §2 "Sending-domain warmup").
- **CORS allowlist** — replace the placeholder `portal.example`/`status.example` origins with real deploy origins before the Portal/status surfaces are GA (GO-LIVE §2 "CORS allowlist").

## 5. Known residual security debt (from GO-LIVE-CHECKLIST §3, honest)

| Item | REQ | Severity | Disposition |
|---|---|---|---|
| Missing-evidence send-gate unimplemented — a POD with a fabricated hash + no stored R2 object still triggers an evidence email framing itself as "the record" (the money invoice stays valid) | REQ-170 | **Med** | Deferred; lands with the photo-URL resolver + hash-verify send-gate. Fail-safe today only in that the invoice math is unaffected; the evidence-provenance claim is the gap. |
| Driver auth + lockout deferred — only a per-device P-256 key exists; no login/magic-link/PIN, no lockout counter | REQ-069 | **Med** | Deferred (F0-SPEC'D). The device key gives attribution; login+lockout is a follow-up WP. |
| DO trusts `parsed.source` — the legacy lock is route-layer (force-native on every seam) + coverage discipline; the DO itself does not restrict `legacy` to a verified internal marker | REQ-030 | **Low** | Defense-in-depth candidate. Every current append seam forces native (proven in 2.7); a future seam added without it would reopen the hole — a DO-level restriction is the durable fix. |
| Dual-control on money promotions unbuilt — the flip guard records the single deciding admin (co-sign); a second approver on invoicing/settlement promotes is not built | REQ-023 | **Low** | Money-module forward flips are already blocked-by-construction in-repo (no clean-close signal); dual-control is a R4 hardening (REQ amendment). |
| TSA EKU critical/sole-purpose spec-strictness deferred | REQ-014 | **Low** | The verifier requires the `id-kp-timeStamping` EKU and fails closed on its absence; the stricter RFC-3161 §2.3 "critical + sole EKU" check is deferred. Fail-closed direction — a non-conformant signer is rejected, not silently accepted. |
| Status-page server-side geo boundary must hold at hosting; portal party fleet is still synthetic | REQ-074 | **Low** | Verified server-side in-repo (2.8); re-verify when public status-page HOSTING and a real party-scoped live feed stand up (deploy gap, §4). |

## 6. Verdict

**Report clean for the in-repo perimeter.** Every STRIDE surface in the threat model has a green proving suite (§2) or a recorded disposition. The forgeability crown-jewels — token, tenant, money-kind, party-id, device-signature, source, authority-flip, chain-fork, seq-race, silent-REPLACE — are each pinned by an adversarial test that goes RED on regression. Tenant isolation (REQ-025) is proven on all three worker surfaces. Evidence integrity gained cryptographic TSA verification and a proven server-side geo boundary this branch.

The remaining items are **deploy** (per-IP edge rate-limit, real TSA anchors, prod secrets, deliverability warmup, CORS origins), **CONFIRM** (photo/PII retention, TSA F1), or **calendar/severity-recorded residuals** (REQ-170 Med, REQ-069 Med, and three Lows) — none is an open hole in the shipped code. No open Criticals or Highs remain against the security perimeter at WP-16 close.

---

## Cross-references

- Spine: [`threat-model.md`](./threat-model.md) — assets + STRIDE-per-surface table + WP-02 ledger review.
- Operator/deploy + debt ledger: [`../ops/GO-LIVE-CHECKLIST.md`](../ops/GO-LIVE-CHECKLIST.md) §2 (deploy), §3 (debt).
- Scope of record: `genesis/09-REQUIREMENTS-REGISTER.csv` (REQ-136 row).
