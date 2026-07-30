# SHUDDL OS — Full Audit · Map/UX Instrument Plan · Mapbox API Assessment · Skill Deployment
## 2026-07-15 · method, verified findings, and deliverables

> **What this is.** A whole-codebase adversarial audit (defects/gaps/invariants), a plan to make the map a functional visibility instrument rather than decoration, an assessment of every Mapbox API family against the decided MapLibre+Protomaps stack (with recommendations for *the version after this one*), and the deployment of 12 SHUDDL-specific skills that encode the judgment those findings demand.
>
> **Standing.** Per the assurance system (`genesis/08` §02.3), audit-swarm findings **become REQ rows or defects, never Slack messages**. Everything in §2 is written to be lifted into `genesis/09` as an append-only defect/REQ row. Nothing here has been code-fixed yet — this is the audit; the fix sequencing is §8.
>
> **Committed to the repository 2026-07-29 (it had lived untracked on disk since it was written).** This is a
> FROZEN dated record and is not maintained: every `path:line` citation below is as-of **2026-07-15** and the
> code has moved since — C-1 was closed at WP-09, and the T14/T15 remediation and the V1 close-out rewrote
> parts of the ledger, the map and the deploy configuration. The citations were bounds-checked at commit time
> (all 44 still resolve to a real file and an in-bounds line), but they are deliberately NOT content-anchored:
> anchoring a dated observation to today's symbols would misrepresent when it was made. Read a line number
> here as "where this was on 2026-07-15", and use `git log -S` to follow anything that has moved.

---

## 0. TL;DR

- **The core is unusually disciplined.** The ledger, canonical-hash byte law, DO sequencer, and transition gates are among the most defensively-written code I've reviewed. Many things that *look* like gaps are documented, fail-safe TODOs (e.g. the unwired POD-gate service-class exemption always requires a POD). The audit bar was therefore high.
- **1 Critical, 6 High, 18 Medium, 12 Low** survived adversarial re-verification (60 agents, ~4.7M tokens; each finding re-read against the cited code, default-REFUTE).
- **The one Critical is real and security-grade:** `POST /v1/positions` — the primary location channel — enforces **no consent gate, no driver write-scope, and no device signature**, even though `sequencer.ts:92-93` explicitly names that route as the owner of the consent gate. A driver can inject GPS for any shipment under any device id, with zero consent record, and it becomes a Merkle leaf.
- **The map currently *lies* on the canonical screens** in three verified ways (chevrons collapse to due-north; the exception pulse never fires for a moving truck; the shipped basemap JSON is invisible to the design audit). The skeleton (feature-state paint, world-dim, clustering) is correct — it just needs to be made truthful.
- **Mapbox verdict:** keep the renderer decision (MapLibre + self-hosted Protomaps) untouched. **Adopt the style-spec/expression patterns now** (they're MapLibre-parity and encode the entity grammar); **use Mapbox server-side compute (Matrix/Directions/Isochrone/Geocoding) only behind a Zod-validated provider seam with an OSS fallback**, never as a gate, because each carries a "must display on a Mapbox map" ToS clause and lock-in.
- **12 skills deployed** to `.claude/skills/`, each grounded in a verified finding, each distinct from the generic mapbox/cloudflare/resend/supabase/superpowers skills already available.

---

## 1. Method & scope

**How.** A 7-phase multi-agent workflow: (1) cartography — 8 subsystem readers; (2) an adversarial defect hunt across 10 audit lenses; (3) per-lens skeptic verification (re-read the cited `file:line`, default to REFUTED, drop anything unconfirmable); (4) Mapbox research across 6 API families against the stack constraints; (5) a map-as-instrument synthesis; (6) skill identification with hard dedup against existing skills; (7) skill authoring + a per-skill verification pass. 60 agents, 0 errors.

**Grounding.** Every finding cites a real `path:line`. The reviewer (me) independently read the crown-jewel files (`canonical.ts`, `chain.ts`, `sequencer.ts`, the migration guards, `floors`, the Concierge prompt) and spot-verified the skills' citations against source — including confirming the pinned empty-object hash `44136fa3…aff8a` is the true SHA-256 of `{}`.

**What this audit did NOT do.** It did not fix code (§8 sequences that). It did not run the full fixture suite or deploy anything. Findings marked **PLAUSIBLE** are likely-real but the verifier could not fully reproduce them from code alone — treat as "investigate," not "confirmed defect."

---

## 2. Verified defect register

### 2.1 🔴 CRITICAL

**C-1 · `POST /v1/positions` bypasses consent, driver-scope, and device-signature — the primary GPS channel is unauthenticated at the object level.**
`workers/api/src/routes/positions.ts:15-60` · REQ-166, REQ-030, REQ-016/011, REQ-025
The handler does role-check + `PositionInput.safeParse` + canonical hash + `INSERT OR IGNORE INTO positions` and returns. There is **no** `deriveOperatingState`, **no** consent lookup, **no** driver-assignment check, and **no** device-signature verify — yet `sequencer.ts:434-441` gates `stop.arrived` through `assertConsentBeforeGps`, `sequencer.ts:92-93` names this exact route as the consent owner ("owned by the positions bypass route, which must enforce the same consent gate"), `events.ts:167-173` 403s an unassigned driver, and `sequencer.ts:237-256` requires a verifying device signature before a device may claim a slot.
**Failure:** a driver assigned to shipment A posts `{shipment_id: B, device_id: <someone else's>, lat, lon}`; the row inserts, pollutes B's live track, and becomes a Merkle-anchored leaf attributed to a foreign device — with zero consent acknowledgment for the operating jurisdiction. The identical facts as a `stop.arrived` **event** are 403'd/UNAUTHORIZED.
**Fix:** before the insert, (1) if `role==='driver'` require `status_cache.$.assigned_driver === session.sub` (reuse the events.ts query); (2) require `device_id` registered to `session.sub`; (3) `assertConsentBeforeGps(prior, stamp, {operating_state: deriveOperatingState(coords)})`. Factor a single shared consent/assignment predicate so the route and the DO cannot drift. **Open [CONFIRM]:** are raw positions intentionally *unsigned*? If yes, document why; if no, require a position signature. → skill `enforce-server-side-gate-parity`.

### 2.2 🟠 HIGH

**H-1 · (folded into C-1) `positions.ts` has no driver write-scope and no device verification** — `positions.ts:41`. Same root as C-1, separately verified: client `shipment_id`/`device_id` are bound straight into the row. Fix as C-1.

**H-2 · Chevron heading is overwritten with the glide-delta and collapses to due-north for every static/at-target entity.**
`packages/map/src/MapCanvas.tsx:97` · REQ-075, doc 07
`animatedRef` and `targetsRef` are both seeded from the same fleet, so `current === target`; `animateToward` then unconditionally sets `bearing = bearingTo(same,same) = atan2(0,0) = 0`, run every frame. The real per-truck bearings (`demo.ts:72`) render for one frame, then all chevrons snap north. **The 5 blessed screenshots ship a field of identical north-pointing arrows.** Fix: only derive bearing when displacement exceeds an epsilon; seed new features at their *prior* position, not the target; otherwise keep the last real/ledger-supplied heading. → skill `keep-map-instrument-truthful`.

**H-3 · The shipped basemap `greige-style.json` is invisible to the design audit — `.json` is not in the scan glob.**
`tools/design/audit.ts:249` · REQ-145, REQ-075, REQ-158
`scannedFiles()` globs only `.css/.tsx/.ts/.jsx/.mjs/.html`. But `greige-style.json` **is** the runtime style (`style.ts:2` imports it) and carries raw paint colors (`#D5D1CC`, `#1A1A1A`, `#FF4A33`, `rgba(255,74,51,.55)`). An operator can set `fill-color:#3388FF` (blue water) and CI stays green even once blocking at WP-10. Fix: add `**/*.json` to the glob **or** a dedicated map-style color validator, plus a parity test pinning the JSON colors against the `style.ts` inline copy so the two basemaps can't drift. → skill `keep-map-instrument-truthful`.

**H-4 · The "5 color tokens" hard budget is not enforced by the audit gate and is bypassable via non-6-digit hex.**
`tools/design/audit.ts:282` · REQ-145
`main()` discards `auditTokens().colorTokens` (the count is never checked by the script); the only count check is a hardcoded `toEqual` in `design.test.ts:36`, and `readTokens`' regex captures **only** 6-digit hex. A `--brand:#00f` or `--accent:rgba(0,0,255,1)` added to `tokens.css` (which is exempt from `auditColor`) ships a 6th blue token with zero CI signal. Fix: emit a violation when `colorTokens.length !== 5`; broaden `readTokens` to 3/4/8-digit hex + `rgb()/rgba()/hsl()`. → skill `keep-map-instrument-truthful` (design-CI guardrails).

**H-5 · Idempotency middleware caches 4xx responses → a legitimate retry never re-runs the mutation (silent evidence loss).**
`workers/api/src/middleware/idempotency.ts:35` · REQ-156/106/168, airplane-mode soak
Any status `<500` (incl. 422) is cached for 24h under the client key; the lookup short-circuits before `next()`. **Failure:** the Driver PWA replays its offline queue and POSTs `/v1/evidence` *before* the `delivery.evidenced` event that records `photo_hash` has synced → `422 hash_not_recorded` gets cached → the recording event commits → the PWA retries the **same key** → the cached 422 replays, `next()` never runs, the verified bytes are **permanently lost**. Fix: cache only 2xx; let precondition 4xx (422/409/404) fall through so a same-key retry re-executes (doc-id PK/`INSERT OR IGNORE` already prevents double effects). → skill `make-agent-idempotent-and-adapter-ported`.

**H-6 · REQ-167 identity-leak lint fails OPEN (exit 0) when the CI secret is unset.**
`tools/checks/identity-leak.ts:56` · REQ-167
`loadDenylist()` returns null when `IDENTITY_DENYLIST` is empty/absent; `main()` prints "Lint SKIPPED" and returns exit 0. GitHub substitutes an unset/fork secret with `''` → silent skip → green. A commit containing a real tenant/person/customer name passes CI unflagged. *(This session's `pnpm check:identity` run reproduced the skip live.)* Fix: fail closed when no denylist is available under `CI=true`/a `REQUIRE_DENYLIST` flag; add a `ci.yml` preflight asserting the secret is non-empty; add a test that empty-denylist exits non-zero. → skill `share-lint-matchers-with-parity-tests` (adjacent CI-integrity class).

### 2.3 🟡 MEDIUM (18) — all CONFIRMED unless marked

| # | File:line | Finding |
|---|---|---|
| M-1 | `db/tenant/migrations/0003_insert_guards.sql:9` | BEFORE INSERT guard WHEN-clause omits the `hash` and `ux_events_device` UNIQUE keys → an `INSERT OR REPLACE` conflicting on either silently deletes a historical event (recursive_triggers=0 suppresses BEFORE DELETE). Defense-in-depth gap vs the advertised backstop. |
| M-2 | `tools/checks/invariants.ts:204` | Source-side forbidden-REPLACE scanner isn't schema-qualifier aware (`INSERT OR REPLACE INTO main.events` and `INTO"events"` evade); asymmetric to the migration scanner which catches them. |
| M-3 | `workers/api/test/isolation.test.ts:67` | REQ-025 isolation suite grew no cross-tenant case for the `evidence`/`anchors`/`rate` routes (R2+D1 paths added in WP-04/06). |
| M-4 | `packages/ledger/src/projection/money.ts:151` | Voiding an invoice reverses `money_lines` but leaves the `invoices` read-model row `issued`/full-total → AR overstated. |
| M-5 | `eslint.config.mjs:25` | REQ-024 LLM-import lint covers `packages/ledger/**` but **not** `workers/api` — the actual ledger-commit host (the sequencer DO) is unguarded against an LLM import. |
| M-6 | `packages/agents/src/concierge/parse.ts:311` | Prompt-injection fence uses **static, source-public** delimiters (no per-message nonce); the comment overstates it as a "unique sentinel." |
| M-7 *(PLAUSIBLE)* | `packages/agents/src/concierge/parse.ts:275` | No reusable hardened LLM-port scaffold — injection defense, fail-safe, schema-revalidation are bespoke to the Concierge; the 11 unbuilt agents will each reinvent (or omit) them. |
| M-8 | `packages/map/src/MapCanvas.tsx:122` | The exception **pulse** never fires for a moving truck — only rest-circles and clusters throb; a `symbol`-layer truck-kind exception dims the world but sits static. ~half of exceptions don't pulse. |
| M-9 *(PLAUSIBLE)* | `packages/map/src/useFleet.ts:72` | A stale local feature-state override permanently shadows the authoritative source status → a later ledger exception is hidden. |
| M-10 | `tools/design/audit.ts:26` | Contrast gate checks only `--signal-deep`/`--field`; `--signal-55` (documented body-text color) is never checked and fails WCAG AA. |
| M-11 | `tools/design/audit.ts:263` | The teal (`--progress`) "fills only, never text/icons/states" law is unenforced — teal-as-text passes the color audit. |
| M-12 | `workers/api/src/do/sequencer.ts:514` | Tenant policy (gate + visibility config) parsed with a bare `as` cast — no Zod at a security-relevant control-plane boundary. |
| M-13 | `workers/api/src/middleware/idempotency.ts:14` | Idempotency key scope omits the request body → reusing a key with different content silently returns the first response and drops the new mutation. |
| M-14 | `workers/agents/src/index.ts:343` | Queue consumer retries **non-retriable** handler throws (4xx ParseError, permanent DO append failures) instead of acking → poison-message retry storms / DLQ churn. |
| M-15 | `workers/agents/src/sla-sweep.ts:56` | SLA sweep re-scans and per-row re-queries every auto-answered past-due inbound on every cron tick, unbounded — the self-clearing set never shrinks. |
| M-16 | `.github/workflows/ci.yml:29` | REQ-118 "every PR cites a REQ-ID" gate is skipped on push-to-main — which is the repo's actual dev flow. |
| M-17 | `tools/traceability/orphans.ts:16` | Orphan detector treats **any** textual REQ mention (comment/test/doc) as "built," weakening the both-directions traceability claim. |
| M-18 *(PLAUSIBLE)* | `tools/checks/identity-leak.ts:45` | identity-leak lint silently skips binary/unreadable tracked files — REQ-167's "any artifact" isn't fully covered. |

### 2.4 ⚪ LOW (12)

| # | File:line | Finding |
|---|---|---|
| L-1 | `packages/ledger/src/visibility.ts:67` | `resolveVisibility` fails **OPEN** to `counterparty` for `invoice.corrected` when the corrected event's visibility is undefined (should fail closed / require it). |
| L-2 *(PLAUSIBLE)* | `packages/ledger/src/redact.ts:11` | `invoice.issued` carries internal GL codes + division, is counterparty-visible, but is never redacted for a non-tenant lens. |
| L-3 | `packages/ledger/src/projection/money.ts:272` | `invoices.shipment_ids` is hard-coded `'[]'` on every insert and never populated → invoices unlinked from their shipments. |
| L-4 *(PLAUSIBLE)* | `packages/agents/src/concierge/resolve.ts:175` | Quote-stage shipment self-references `bill_to = requester`; the Biller bills that party verbatim → wrong-payer risk. |
| L-5 | `packages/agents/src/concierge/parse.ts:408` | Untrusted email body sent to the LLM with no input-size cap and no `agent_runs` cost record — unbounded token-cost attack surface. |
| L-6 | `packages/map/src/MapCanvas.tsx:49` | `bearingTo` uses planar `atan2(dLng,dLat)` with no `cos(lat)` correction — headings skew (worsens toward the poles / at NE bearings). |
| L-7 | `workers/api/src/do/sequencer.ts:529` | Device public JWK loaded with unguarded `JSON.parse` + `as` cast before crypto verification. |
| L-8 | `workers/api/src/routes/anchors.ts:23` | Prod TSA config parsed with `as {url?}` — duplicated, unvalidated D1 boundary feeding an outbound request. |
| L-9 *(PLAUSIBLE)* | `workers/agents/src/index.ts:184` | Dev evidence-test-send body validated with hand-rolled `JSON.parse` + `typeof`/`in` instead of a Zod `.strict()` schema. |
| L-10 | `fixtures/manifest.json:4` | The Law-4 headline fixtures gate (48 engine tests + 504 sweep, REQ-027/165) is dormant in the `verify` chain — only exercised in-repo, not by the gate. |
| L-11 | `tools/traceability/register.ts:18` | `parseRegister` relies on convention-only comma-safety; a future field-embedded comma corrupts traceability scoping. |
| *(L-1 dup)* | `visibility.ts:67` | Second verifier confirmed the same widen-to-counterparty path independently. |

---

## 3. The agent build — is it seamless?

**Reality check.** Of the 13 agents, **only Concierge and Biller are built.** The other 11 (Scheduler, Dispatcher, Gatekeeper-as-agent, Collector, Watchtower, Translator, Overlay, Copilot, MCP, etc.) are unbuilt; WP-08 (Scheduler) is starting now.

**What's excellent.** The two built agents are disciplined: the Concierge fences untrusted email between labeled delimiters and tells the model that content is *data, never instructions* (`parse.ts:308-322`); confidence gating, fail-closed party/dims/unpriceable paths (REQ-172/173/174/175) all landed in the WP-07 exit fixes.

**The seam that isn't there yet (the real answer to "make the agent build seamless").** There is **no reusable hardened agent scaffold** (M-7). The injection defense, the fail-safe-on-low-confidence, the schema re-validation of model output, idempotency under at-least-once Queue redelivery, and the "adapter-ported, provider-agnostic external seam" discipline are all **bespoke to the Concierge**. If the next 11 agents are each hand-rolled, each is a chance to forget one of these — and the injection fence's static delimiters (M-6), the unbounded token cost (L-5), and the non-retriable-retry poison loop (M-14) show the failure modes already present in the two that exist.

**→ This is why two P0 skills exist:** `harden-agent-against-model-trust` (never let the model touch a price-affecting field un-revalidated; never key identity off model-extracted text; auto-send only above a fail-closed confidence floor; re-extraction fail-closed checklist) and `make-agent-idempotent-and-adapter-ported` (every agent core is pure + idempotent under redelivery, every vendor call goes through a Zod-validated adapter seam with an OSS fallback). Building agents 3–13 against these two skills is what makes the agent build seamless.

---

## 4. The map as operational instrument

**Thesis (from the synthesis).** The map is the one surface where *product performance* (everything nominal → quiet greige) is separated from *product exception* (one thing wrong → loud coral, world dimmed). Acceptance demo #5 — "the exception pulse dimming the map while everything else stays quiet" — is the acceptance test for the whole instrument. **The skeleton is correct** (one clustered GeoJSON source, feature-state paint, world-dim by paint expression, armed off the ledger not a prop). **But three verified defects mean the instrument currently lies on the canonical screens** (H-2 north-collapse, M-8 pulse-never-fires-for-trucks, L-6 bearing skew), and one CI blind spot lets the basemap drift off-palette silently (H-3/H-4).

**Make it truthful first (fix-forward, tied to REQ + MapLibre technique):**

| Behavior | REQ | MapLibre technique | Current state |
|---|---|---|---|
| Exception world-dim to ≤35% + exception pulses at 100% | REQ-077, demo #5 | `case` expr on `feature-state.status` + `clusterProperties.maxStatus`; one global rAF driving `setPaintProperty` | dim correct; **pulse skips the `symbol` truck layer (M-8)** |
| Heading chevron oriented to real bearing | REQ-075 | `icon-rotate` from a `bearing` property | **collapses to due-north (H-2); planar skew (L-6)** |
| Lens separation (click mark → panel, map never navigates) | REQ-080 | classic `on('click', layerId)` + `queryRenderedFeatures` + `setFeatureState` — **NOT** Mapbox's `addInteraction` (no MapLibre equiv) | skeleton present |
| Teal only as progress fill | REQ-078 | `line-gradient` + `['line-progress']` (needs `lineMetrics:true`) | to build (WP-08/09) |
| 1K entities @60/30fps | REQ-079 | GeoJSON `cluster:true` + `clusterProperties` exception rollup | perf harness present |
| Basemap stays on-palette | REQ-145/158 | design-CI must scan `greige-style.json` | **blind spot (H-3/H-4)** |

**Then extend as live data arrives:** bind `feature-state` directly to the Durable Object live-board diff stream so the pulse is a *projection of the ledger* set/cleared in the same tick the co-signed event lands (not a client guess); derive `symbol-sort-key` from an event-severity ordinal so an exception mark always wins a collision; feed `line-progress` from GPS-derived traveled fraction (physics, not interpolation). **Guardrails:** 5 tokens, greige/coral only, teal fills only, no shadows/terrain/3D — enforced by wiring the DevKit `validate_style`/`check_color_contrast` validators into design-CI (see §5). → skills `keep-map-instrument-truthful` + `preserve-canonical-hash-byte-law` (position-leaf byte identity).

---

## 5. Mapbox API assessment vs the MapLibre + Protomaps stack

**Governing rule (unchanged):** the renderer is MapLibre GL + self-hosted Protomaps on R2 — no third-party branding, offline-capable, no lock-in. Nothing below swaps it. The recurring caveat across Mapbox's *service* APIs: almost every one carries a **"Results must be displayed on a Mapbox map using a Mapbox SDK"** ToS clause and/or vendor lock-in — so the correct pattern is a **Zod-validated provider seam** (`geocode_provider`, `routing_provider`) with a Mapbox adapter **and** a self-hosted OSS fallback (Valhalla/OSRM/Pelias/`@turf`), keeping the ledger provider-agnostic and the appointment/dispatch flow correctable-by-new-event.

### 5.1 Adopt **now** — style spec & expressions (MapLibre-parity, zero conflict)
These *are* the entity grammar and carry no Mapbox dependency:
- **Expressions** (`match`/`case`/`interpolate`/`step`/`get`/`zoom`) — one `['get','status']` drives chevron/square/hollow/pulse + 100/55/35 opacity (REQ-076/078). *Zero conflict.*
- **`feature-state` + `setFeatureState`** — the exact mechanism for the exception dim+pulse (REQ-077/080).
- **Symbol collision** (`symbol-sort-key`, `*-allow-overlap`, `text-variable-anchor`) — exception marks always win collisions; keeps the map calm (REQ-076).
- **`line-gradient` + `line-progress`** — teal-only progress fills (REQ-078), the one sanctioned teal use.
- **GeoJSON clustering** (`cluster`, `clusterProperties`) — *adopt-vNext* for 1K entities @60fps (REQ-079); the cluster must roll up an exception count so it can never hide a lone exception.
- **DevKit MCP validators** (`validate_style`, `validate_expression`, `check_color_contrast`) — *evaluate* as a **design-CI aid** (author/CI-time only, ships nothing), pinned to SHUDDL's own tuned `--signal-deep` threshold, not Mapbox defaults. Directly closes H-3/H-4/M-10.

### 5.2 Adopt **vNext** — server-side compute behind a provider seam (no renderer conflict, ToS/lock-in caveats)
| API | Freight use | Fit | Guardrail |
|---|---|---|---|
| **Matrix** (`/directions-matrix/v1`) | WP-08 Scheduler appointment-feasibility (driver×stop duration grid), ETA ranking | adopt-vNext | OSRM-table-compatible → low lock-in; **advisory only, never a gate** (REQ-030/043) |
| **Directions** `driving-traffic` (`depart_at`/`arrive_by`) | live driver-ETA-to-next-stop; route polyline drawn client-side over Protomaps; heartbeat enrichment (REQ-047) | adopt-vNext | **offline caveat** — a live call can't be the source of truth for a disconnected driver |
| **Isochrone** (`depart_at`) | appointment-window feasibility / catchment overlay (WP-08) | adopt-vNext / evaluate | ToS display-restriction → **prefer self-hosted Valhalla**; advisory only |
| **Geocoding v6** (batch/structured/reverse) | address→coord at Tenant-0 seed + booking; reverse-geocode POD label for the evidence email | evaluate / reverse=adopt-vNext | **`permanent=true` is the ONLY compliant way to store Mapbox coords** in D1; emit as event evidence (correctable-by-new-event, I3/I7), not a mutation; must live in `packages/agents/*` not `packages/ledger` (REQ-024) |

### 5.3 **Avoid** — breaks the renderer, branding, offline, or lock-in laws
- **Optimization v2 (VRP)** — proprietary beta, highest lock-in; *evaluate* only as a suggestion-only spike behind a flag once the Scheduler's deterministic double-book gate is solid.
- **Tilequery** — only queries *Mapbox-hosted* tilesets; the zone-resolver must be a self-hosted Worker doing `@turf/boolean-point-in-polygon` over the tenant ZIP-zone polygons (REQ-165).
- **Static Images API** — renders from a Mapbox basemap; build a self-hosted `maplibre-native` rasterizer for the "delivered-here" evidence-email thumbnail so the artifact stays ours.
- **Search Box API / Address Autofill** — browser-interactive, streams keystrokes to Mapbox from the Portal; use a self-hosted Photon/Pelias autocomplete over the tenant roster.
- **Map Matching** — ToS display-restriction; use Mapbox's own MIT `geojson-tidy` in a Worker to clean the 30s GPS trail instead.
- **Movement data** — evaluate only post-M-H/GTM as a batch analytics flat-file into R2; SHUDDL's own POD/GPS telemetry is the authoritative lane signal.
- **Vision SDK, Standard style / GL JS v3 basemap, globe/3D terrain/fill-extrusion/model layers, Interactions API** — all either exfiltrate telemetry, require Mapbox hosting/branding, or have no MapLibre equivalent, and several fail the design squint test outright.

### 5.4 Recommended additions for **the version after this one**
1. **A `routing_provider` + `geocode_provider` seam** (Zod-validated `{value, confidence, source}` shapes) with a Mapbox adapter and a self-hosted OSS fallback — ship *before* any live routing/geocoding so the Scheduler is never bound to one vendor and degrades gracefully offline. (This is the shape the `gate-external-routing-server-side` skill teaches.)
2. **Server-generate the entity-grammar style from the event taxonomy** and store the style JSON in R2 next to the tiles — adding an event kind adds a `match` arm, not a hand-edit.
3. **Wire the DevKit style/contrast validators into design-CI** so `greige-style.json` is contract-tested every merge — makes REQ-158 blocking-ready before WP-10 without hand screenshots.
4. **Self-hosted static-image + isochrone Workers** (maplibre-native raster; Valhalla) so the evidence email and feasibility overlays never depend on Mapbox hosting.

---

## 6. Skills deployed (12)

Installed to `.claude/skills/`, each grounded in a verified finding above, each **distinct** from the generic mapbox/cloudflare/resend/supabase/superpowers skills already available (the workflow correctly rejected 11 duplicate categories — e.g. it did *not* recreate `cloudflare:durable-objects`, `mapbox:mapbox-cartography`, or `resend:resend`). All 12 PASS the authoring verification; the build stays green (lint/traceability/identity checks pass with `.claude/**` excluded as governance prose).

| Priority | Skill | Type | Closes |
|---|---|---|---|
| P0 | `enforce-server-side-gate-parity` | discipline | C-1/H-1 — every API-reachable write re-enforces the DO's gates (consent, driver-scope, device sig) |
| P0 | `complete-append-only-insert-guards` | discipline | M-1 — enumerate PK + *every* UNIQUE key in a BEFORE INSERT guard's WHEN-clause |
| P0 | `harden-agent-against-model-trust` | discipline | M-6/M-7/L-5 — the hardened-prompt contract for the 11 unbuilt agents |
| P0 | `make-agent-idempotent-and-adapter-ported` | pattern | H-5/M-14 — idempotent-under-redelivery agent cores + provider-seam external calls |
| P1 | `preserve-canonical-hash-byte-law` | reference | the frozen serializer law + SQL-NULL→omitted-key + position-leaf byte identity |
| P1 | `prove-tenant-isolation-read-paths` | discipline | M-3 — every new read path grows an isolation-suite case |
| P1 | `keep-readmodel-consistent-with-ledger` | discipline | M-4/L-3 — projections/corrections never let a read-model row diverge from the ledger |
| P1 | `fail-closed-on-inherited-visibility` | discipline | L-1/L-2 — inherited visibility/division/party must fail closed, never widen |
| P1 | `redact-counterparty-payloads-completely` | technique | L-2 — outbound-visible payloads strip internal fields, incl. nested-in-array |
| P1 | `keep-map-instrument-truthful` | discipline | H-2/H-3/H-4/M-8/M-10/M-11/L-6 — the map instrument never lies |
| P1 | `gate-external-routing-server-side` | pattern | §5 — external routing/ETA behind a seam, advisory-only, never a gate |
| P2 | `share-lint-matchers-with-parity-tests` | technique | M-2/H-6 — one shared matcher + parity test when a rule is enforced in two places |

---

## 7. Config changes made this session

Two minimal, principled exclusions so skill documentation (governance prose, like `CLAUDE.md`) does not gate or corrupt the build — **no product code touched**:
- `eslint.config.mjs` — added `.claude/**` to `ignores` (skill reference `.ts`/`.sql` snippets are illustrative, not build source).
- `tools/traceability/orphans.ts` — added `:(exclude).claude` to the REQ-scan grep (a skill *cites* REQs to teach; it does not *implement* them — counting them would mask an unbuilt REQ and could false-fail the gate).

Verified after install: `pnpm lint` ✅, `pnpm check:traceability` ✅ (no orphans), `pnpm check:identity` (skipped — no local denylist; that skip is H-6 itself).

---

## 8. Recommended fix sequencing

1. **C-1/H-1 first (security).** Add the shared consent+assignment+device predicate to `positions.ts` with tests; resolve the "are raw positions signed?" [CONFIRM]. Register as a REQ/defect row before the PR.
2. **H-5 (evidence loss).** Cache only 2xx in the idempotency middleware; add an airplane-mode-reorder fixture proving the same-key retry re-executes.
3. **H-6 + M-16 (CI integrity).** Fail the identity-leak lint closed under CI; run the REQ-ID gate on push-to-main.
4. **H-2/H-3/H-4 (the map stops lying).** Fix the bearing overwrite; add the JSON basemap + token-count to the design audit; add the JSON↔TS color parity test.
5. **The Medium batch**, grouped by skill: M-1/M-2 (guard completeness + shared matcher), M-4 (AR read-model), M-12/L-7/L-8 (Zod the `as` casts), M-14/M-15 (queue retry + sweep bound).
6. **Before agents 3–13:** build them against `harden-agent-against-model-trust` + `make-agent-idempotent-and-adapter-ported`, and stand up the `routing_provider`/`geocode_provider` seam (§5.4) before WP-08 wires any live routing.

*Full machine-readable findings + Mapbox recommendations: workflow run `wf_7f07ec8a-066` (60 agents, 0 errors).*
