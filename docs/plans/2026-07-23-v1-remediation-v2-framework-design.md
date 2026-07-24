# SHUDDL V1 Remediation and V2 Build Framework

**Status:** Approved by the owner on 2026-07-23
**Repository baseline:** `4f0a6f3278cea5f5a4a0073d8390476f375b6c0b`
**Decision:** Close V1 to an evidence-backed R2 release before making V2 authoritative.

## 1. Goal and Definition of Done

This program has two linked outcomes:

1. Move V1 from an audited launch candidate to a staging-certified freight operating system with no unresolved Critical or High code debt.
2. Replace the inconsistent V2 drafts with one normalized, dependency-ordered, testable build framework.

V1 is complete only when:

- every Critical and High debt item is fixed or is an explicit externally owned HOLD;
- no release check can skip its assertions and still report PASS;
- the real driver, portal, billing, evidence, credit, and quote-authority loops work against server state;
- all blocking tests, builds, migrations, browser tests, acceptance tests, smoke tests, and recovery drills pass against the same release SHA;
- every Critical and High requirement points to executable proof;
- production documentation describes verified behavior rather than planned behavior.

V2 is execution-ready only when:

- REQ-214 through REQ-288 are unique, append-only, and present in the authoritative register;
- each requirement names its milestone, owner, acceptance test, authority source, failure behavior, and release grade;
- the milestone dependency graph is explicit;
- external providers are isolated behind ports and cannot become implicit truth;
- proposal, approval, retry, rollback, security, observability, cost, retention, accessibility, and recovery contracts are defined before feature implementation.

## 2. Current Verified Baseline

The codebase has a strong deterministic spine:

- 35 frozen event kinds;
- append-only event and money ledgers;
- tenant-scoped D1 databases;
- server-side transition gates;
- deterministic Rater and injected agent ports;
- 13 named agents;
- three product surfaces;
- 213 registered V1 requirements;
- broad unit, integration, isolation, traceability, and acceptance coverage.

The baseline nevertheless remains release grade R0:

- Node 22 can run the current verification suite, while the default Node 20 runtime conflicts with the pinned pnpm release.
- `pnpm verify` passes under Node 22.
- the API suite passes 669 tests in 62 files;
- the acceptance suite passes 29 tests in 7 files;
- 213 of 213 V1 requirements are classified, but classification is not implementation proof;
- 28 rows have status drift;
- nine private fixture packs remain unavailable;
- production dependency audit reports zero vulnerabilities;
- the full development dependency graph reports 15 vulnerabilities;
- visual and performance commands can exit zero after skipping Playwright.

The production blockers are behavioral, not cosmetic:

- the driver app renders fixture stops and mock coordinates;
- the portal can label demo fleet data as live;
- billing can send a proof claim without confirming stored evidence bytes;
- a credit decision received before its party projection can disappear from the booking gate;
- billing selects a later quote instead of the quote accepted for the booking;
- unresolved invoice-correction inheritance can broaden visibility;
- CI does not yet make all release claims blocking and non-skippable;
- production resources, sender identity, recovery, alerting, jurisdiction data, and field evidence are not all proven.

## 3. Governing Scope

### 3.1 V1

V1 remains the WP-01 through WP-16 product defined in the genesis documents. The remediation program fixes correctness, authority, production behavior, assurance, and documentation. It does not silently add a conventional TMS backlog.

### 3.2 V2

V2 delivers Tenant-0 end-to-end internal operations:

- structured facilities and geography;
- AI-assisted quote-to-book;
- conversational pricing configuration;
- internal backhaul detection and marginal pricing;
- co-load and dispatch proposals;
- real driver synchronization and foreground tracking;
- live, server-scoped operations views;
- one durable proposal and approval primitive;
- full operational assurance.

### 3.3 Deferred

The following remain outside the V2 critical path:

- cold prospect sourcing and outbound outreach;
- the public single-representative product;
- rep-team and manager rollups;
- predictive routing or multi-leg vehicle-routing optimization;
- native general ledger, driver pay, report builder, a fourth product surface, seat pricing, escrow settlement, and other permanent exclusions without an owner-signed register amendment.

Cold outreach and the single-representative product are specified as V2.5 requirements so their constraints are not lost, but they do not gate V2 Tenant-0 readiness.

## 4. Release Grades

| Grade | Meaning | Required evidence |
|---|---|---|
| R0 | Audited | Current-state audit and reproducible baseline |
| R1 | Mergeable | Zero open repository Critical/High debt; authoritative merge gate |
| R2 | Staging-certified | Builds, migrations, strict browser/a11y/performance, staging smoke, alerts, DLQ, rollback, and recovery evidence |
| R3 | Pilot-ready | Tenant pack, legal approvals, on-call, real devices, field acceptance, and restore drill |
| R4 | Production-ready | Production resources, secrets, DNS, CORS, rate limits, sender identity, backups, SLOs, acceptance, and rollback |
| R5 | Authority cutover | At least 30 days of shadow operation, aggregate reconciliation within 2%, two clean closes, clean pilot metrics, and tested fallback |

An evidence record has this minimum shape:

```json
{
  "gate": "string",
  "commit": "git-sha",
  "environment": "merge|staging|pilot|production|shadow",
  "scope": ["requirement-or-work-package"],
  "status": "PASS|FAIL|BLOCKED|PENDING|NOT_APPLICABLE",
  "executed": true,
  "assertions": 1,
  "fixture_hashes": ["sha256"],
  "artifact_uri": "durable-reference",
  "toolchain": {"node": "22.x", "pnpm": "pinned"},
  "started_at": "ISO-8601",
  "finished_at": "ISO-8601"
}
```

Rules:

- PASS requires `executed=true` and at least one assertion.
- A missing prerequisite is BLOCKED, never PASS.
- A malformed or stale evidence record cannot promote a release.
- A result containing `SKIPPED`, `PENDING`, `advisory`, `stub`, `not stood up`, or `never run` cannot promote a release.
- Commit, environment, fixture hashes, deployment version, and evidence expiry must match the promoted artifact.

## 5. V1 Remediation Architecture

### WP0 — Authoritative verification

Pin Node 22 and a compatible pnpm release in the package contract, local version file, CI, and contributor documentation.

The canonical merge gate must include:

- typecheck and lint;
- all tests;
- invariant, authority, identity, traceability, coverage, and migration-lock checks;
- Rater purity and all fixture parity checks;
- all application and Worker builds;
- acceptance tests;
- strict Playwright visual, accessibility, and performance tests;
- production dependency audit;
- secret-history scan;
- pull-request requirement checks.

CI must install the required browser. Local convenience skips may remain possible, but CI treats missing browser/tooling/fixtures as BLOCKED.

Exit:

- one clean-checkout command produces the complete merge evidence record;
- no blocking command exits zero after omitting its intended assertions;
- GitHub Actions are pinned to immutable commit SHAs.

### WP1 — Append-only uniqueness

Add a forward-only tenant migration. Do not edit pinned migrations.

Protect every event uniqueness surface from `INSERT OR REPLACE` and equivalent replacement behavior:

- primary event ID;
- canonical event hash;
- `(stream_id, device_id, device_seq)`;
- any correction uniqueness surface covered by the invariant scanner.

The invariant checker must compare declared UNIQUE surfaces with declared insert guards, so a future unique index without a guard fails CI.

Exit:

- collision tests prove the original row survives for every uniqueness target;
- migration lock, invariant, and schema tests pass.

### WP2 — Financial and disclosure authority

#### WP2A — Credit decisions

For new native writes:

- `credit.checked` requires an existing tenant-scoped party;
- an absent target rejects before event append;
- the API reports a deterministic validation/conflict response.

For legacy or previously appended events:

- an unresolved `credit_projection_gap` anomaly for the booking's bill-to party blocks booking;
- reconciliation loads the latest valid credit decision, applies it after the party exists, and resolves the anomaly;
- a later valid decision supersedes an earlier decision by ledger order;
- tenant isolation applies to write, gate, anomaly, and reconciliation paths.

Exit:

- no recorded hold can disappear;
- hold-before-party then party-created still blocks booking;
- a later clear decision permits booking only after successful projection/reconciliation.

#### WP2B — Accepted quote billing

`booking.created.quote_event_id` is the financial authority.

Before append:

- the referenced event exists;
- it belongs to the same tenant and shipment stream;
- it is a prior `quote.priced`;
- a prior valid `quote.accepted` selected that exact quote;
- no open scope-changing proposal remains;
- any later scope change creates a new quote and requires explicit re-acceptance.

Biller loads the booking's exact quote reference. It never substitutes the latest pre-POD quote and never derives authority from an unaccepted terminal node.

Exit:

- quote A accepted and booked, quote B later appended, POD bills quote A;
- dangling, cross-stream, cross-tenant, unaccepted, and superseded references reject with zero append/effect.

#### WP2C — Correction visibility

An invoice correction:

- references an existing original invoice event;
- references the same tenant and stream;
- references an allowed invoice kind;
- inherits the original visibility exactly.

Missing, wrong-kind, cross-stream, or cross-tenant references reject before append. There is no default visibility fallback.

Exit:

- correction visibility can never broaden disclosure;
- event, projection, and money rows remain unchanged on rejection.

### WP3 — Evidence bytes before proof claims

Before sending an evidence email, Biller must confirm:

- an active tenant-scoped POD document exists;
- the document is not tombstoned;
- the document's recorded hash matches the intended evidence;
- `EVIDENCE.head(r2_key)` confirms stored bytes;
- the sender adapter is configured and authorized.

Missing evidence produces a durable retryable state such as `issued_send_pending:evidence_missing`. It does not call the sender.

A later successful upload re-enqueues the original billing trigger. Existing invoice and send idempotency guarantee one invoice and one successful email.

Exit:

- every emailed proof link resolves to the verified stored bytes;
- missing, tombstoned, cross-tenant, or hash-mismatched evidence cannot send;
- retryable 4xx/5xx failures are not permanently memoized.

### WP4 — Real driver synchronization

Replace all production fixture fallbacks with:

- authenticated driver/device enrollment using the existing device-key authority;
- a driver-scoped day-sheet API;
- durable offline queue state;
- ordered event ACK, evidence ACK, and final synced state;
- retry policies for 429/5xx;
- explicit authentication and operator-resolution states for 401/403/422;
- foreground geolocation with truthful freshness and permission state;
- no mock stops or coordinates in production bundles.

Continuous browser tracking is not promised in the background. A future continuous background guarantee requires a native client or authoritative ELD integration.

Exit:

- queue state survives reload;
- a restart after event ACK resumes at evidence upload rather than duplicating the event;
- three real-device offline/reconnect runs lose and duplicate zero events;
- online board freshness is at most 45 seconds.

### WP5 — Real portal board

The board endpoint enforces:

- authenticated tenant and party scope;
- server-side shipment relationship filtering;
- lifecycle-dependent coordinate generalization before serialization;
- exclusion of unauthorized, terminal, or non-positioned entities.

The V1 portal uses bounded polling with visible last-updated, stale, empty, authentication-expired, and unavailable states. An API failure never falls back to demo data.

Exit:

- 100% of displayed entities are server-derived;
- party A cannot receive party B data;
- exact coordinates never reach an unauthorized browser;
- fixture modules are absent from production bundles.

### WP6 — Jurisdiction, browser acceptance, and performance

Replace broad state boxes with a versioned, hashed, licensed polygon data set and point-in-polygon resolution.

`XX` remains a fail-closed result and blocks jurisdiction-dependent capture. It never silently chooses a consent policy.

Blocking reference targets:

- map interaction at least 55 FPS on the declared CI machine;
- no long task over 100 ms during the reference interaction;
- board API p95 at most 500 ms under the declared load;
- all supported pilot coordinates select the approved policy;
- visual, accessibility, offline, isolation, and acceptance scenarios run in a real browser.

### WP7 — Deployment, observability, and recovery

Define and validate the production contract for:

- D1;
- R2;
- KV;
- queues and DLQs;
- Durable Objects;
- Worker routes and origins;
- secrets;
- transactional sender and DNS;
- timestamp authority;
- map and jurisdiction assets.

Required operational signals:

- request, event, and outcome correlation without PII;
- any critical anomaly;
- DLQ age over five minutes;
- evidence-send pending over 15 minutes;
- unresolved projection gaps;
- timestamp-anchor failures;
- board-freshness breaches.

Recovery targets:

- RPO at most 24 hours;
- RTO at most four hours;
- nightly D1 backup;
- defined R2 recovery policy;
- isolated restore with ledger-hash and invoice-count reconciliation;
- tested rollback and forward-repair.

### WP8 — Traceability and documentation

Every changed requirement maps to:

- implementation files;
- executable tests;
- a blocking CI gate;
- runtime/release evidence;
- owner;
- stage and status;
- explicit external HOLD where applicable.

CI fails on:

- duplicate or orphan requirement IDs;
- a requirement citing a missing test;
- a cited gate absent from CI;
- contradictions between release state, project state, checklists, and evidence.

Documentation is updated only from verified behavior.

## 6. V1 Dependency Graph and Estimate

```text
WP0 → WP1 → WP2B → WP3 → WP4 → WP5 → WP6 → WP7 → WP8
              ↘ WP2A/WP2C ↗
```

Estimated sequential effort is 19–31 engineer-days. Two independent lanes reduce expected elapsed time to 12–18 working days, excluding external provisioning, legal review, licensed data, sender-domain work, and physical-device scheduling.

## 7. V2 Authority Architecture

### 7.1 Storage and authority

- D1 stores business state, projections, facilities, parties, assets, provenance, approvals, and configuration.
- The append-only ledger stores authoritative facts and decisions.
- Durable Objects serialize stream writes and coordinate live sessions. They are not the unique store of business truth.
- R2 stores evidence bytes, transcripts, licensed assets, and durable exports.
- KV stores disposable cache and configuration only. It cannot satisfy a fail-closed truth check.
- Queues trigger work. Every effect is recoverable through a ledger/projection reconciliation query.

### 7.2 Proposal lifecycle

Every consequential agent recommendation uses one durable lifecycle:

```text
agent.acted{*_proposed, proposal_id, precondition_hash, expires_at,
            recommended_verb}
    → approvals projection OPEN
    → authenticated decision endpoint
    → role, lens, expiry, state, and precondition validation
    → approval.decided{accepted|rejected|expired|superseded}
    → accepted decisions invoke one allowlisted server verb
    → reconciliation verifies the expected durable effect
```

New writes require a closed `agent.acted.payload.subtype` union. Replay and reads remain backward-compatible with legacy payloads; legacy payload compatibility never authorizes a new write.

Proposal truth cannot live only in a Durable Object, UI session, agent run, or model transcript.

### 7.3 External providers

Every external or model-backed capability uses an injected port with:

- deterministic test implementation;
- explicit NotConfigured implementation;
- live implementation;
- timeouts, retry classification, quotas, cost attribution, and circuit state;
- provenance and input hashes;
- privacy-minimized request payloads;
- no direct import into ledger or Rater packages.

A forward geocoder may receive the minimum structured address fields required to resolve a location, but never party names, contacts, shipment economics, or unrelated PII. Stored provider results record precision, source, source version/hash, license/storage mode, and timestamp. A coarse ZIP centroid is map-only and cannot authorize booking, fences, jurisdiction, or priced accessorials.

### 7.4 Operational truth

Dispatch, co-load, and HOS recommendations abstain unless they have authoritative:

- asset identity;
- capacity and equipment qualifications;
- current assignment/availability;
- location freshness;
- HOS/ELD state or a separately co-signed manual state.

Silence, missing pings, or schedule gaps never imply available hours.

## 8. Normalized V2 Requirement Framework

The existing proposed rows are renumbered to eliminate suffixed identifiers:

- original REQ-214–REQ-225 remain REQ-214–REQ-225;
- original REQ-225a becomes REQ-226;
- original REQ-225b becomes REQ-227;
- original REQ-226–REQ-262 shift by two;
- original REQ-262a becomes REQ-265;
- original REQ-263–REQ-273 shift by three;
- new cross-cutting requirements occupy REQ-277–REQ-288.

| ID | Stage | Requirement and acceptance boundary |
|---|---|---|
| REQ-214 | V2-A | Add origin/destination facility FKs to shipments through a forward migration; old rows remain valid and backfillable. |
| REQ-215 | V2-A | Inject deterministic, NotConfigured, and live forward/reverse geocoder ports; no provider import in ledger/Rater. |
| REQ-216 | V2-A | Store geocode precision, provenance, source hash/version, license/storage mode, and timestamp; coarse results are non-authoritative. |
| REQ-217 | V2-A | Geocoding never silently changes sold price or transit; price changes require a proposal and explicit co-sign. |
| REQ-218 | V2-A | Provider payloads contain only required structured address/location fields and exclude parties, contacts, economics, and unrelated PII. |
| REQ-219 | V2-A | Production basemap/offline assets remain self-hosted; external routing/geocoding is data-only. |
| REQ-220 | V2-A | Replace state boxes with versioned point-in-polygon jurisdiction resolution; unknown remains fail-closed. |
| REQ-221 | V2-B | Portal chat reuses the Concierge parse/resolve/compose core with authenticated sender binding and typed surface metadata. |
| REQ-222 | V2-B | Structured-lane auto-build requires booking-grade addresses; unresolved/coarse addresses return `unknown_address`. |
| REQ-223 | V2-B | Accessorial classifiers produce cited proposals; any sell increase requires client co-sign and durable rejection/acceptance. |
| REQ-224 | V2-B | Scheduler emits both pickup and delivery appointment facts through the gated sequencer; ambiguity produces options. |
| REQ-225 | V2-B | A scope change appends a new quote with a delta and re-runs floors/anomaly gates. |
| REQ-226 | V2-B | Billing uses the exact quote accepted and referenced by `booking.created.quote_event_id`; later unaccepted quotes are ignored. |
| REQ-227 | V2-B | Quote acceptance is blocked while a scope-changing proposal is open; post-accept changes require a new explicit acceptance. |
| REQ-228 | V2-B | Agent booking runs the same credit, evidence-recipient, identity, and authority gates as every other booking path. |
| REQ-229 | V2-B | Model-derived weights, dimensions, addresses, and identities are validated claims; missing/invalid truth yields UNKNOWN. |
| REQ-230 | V2-B | Reconciliation re-enqueues accepted quotes without a booking after a bounded delay, idempotently. |
| REQ-231 | V2-C | Onboarder interviews by archetype while pure factories produce every rate/config value. |
| REQ-232 | V2-C | Versioned broker, asset, LTL-adapter, and shipper templates generate deterministic candidate config. |
| REQ-233 | V2-C | Conversation replay is only a smoke test; go-live requires full historical export replay within 2%. |
| REQ-234 | V2-C | Store a versioned pricing-model reference/provenance on parties without making free-form JSON live authority. |
| REQ-235 | V2-C | Pricing publication is role-gated, re-based, approved, reversible, and never self-published by an agent. |
| REQ-236 | V2-D | Inject deterministic/NotConfigured/live routing ports with privacy, timeout, quota, and provenance controls. |
| REQ-237 | V2-D | Backhaul detection is idempotent and self-clearing over committed delivery, facility, asset, and position truth. |
| REQ-238 | V2-D | Marginal pricing snapshots detour/handling inputs and enforces existing floors, contribution, approval, and interline rules. |
| REQ-239 | V2.5 | Prospect ingestion admits only positively confirmed, legally permitted contacts and stores no unknown/EU/CA subject. |
| REQ-240 | V2.5 | Outreach sender enforces domain-wide suppression, identity, one-click opt-out, physical address, health, and graduated volume. |
| REQ-241 | V2.5 | Outreach decisions are durable and sends are idempotent; prospecting does not create parties before verified inbound identity. |
| REQ-242 | V2.5 | Outreach remains counsel-confirmed and disabled until jurisdiction, policy, sender, suppression, and domain gates pass. |
| REQ-243 | V2-D | `v_opportunities` is the single new canonical view for backhaul/co-load opportunities and provides event/basis drill-through. |
| REQ-244 | V2-D | Timeline degradation uses actual vs committed plan and raises a bounded, attributable anomaly without inventing causes. |
| REQ-245 | V2-D | Dispatch/co-load agents propose cited options; `dispatch.assigned` remains an allowlisted human-gated command. |
| REQ-246 | V2-E | Driver mounts the shared map under a driver lens and renders an offline-safe token-ground state. |
| REQ-247 | V2-E | Night map uses the existing token law and a declared blessed reference. |
| REQ-248 | V2-E | Corridor tile prefetch/cache is bounded, licensed, recoverable, and never exposes forward-stop detail. |
| REQ-249 | V2-E | Server manifest redacts forward-stop address/contact until the prior stop's terminal evidence is committed. |
| REQ-250 | V2-E | Offline lookahead contains at most one encrypted/authorized stop and advances only after locally valid capture. |
| REQ-251 | V2-E | A skip advances reveal state only after server-side dispatcher co-sign and only for the named stop. |
| REQ-252 | V2-E | Stops carry authoritative facility centroid, fence radius, corridor, and provenance needed by shared gates. |
| REQ-253 | V2-E | Browser location samples only while foreground, visible, permitted, and assigned; stale/background state is explicit. |
| REQ-254 | V2-E | Driver device enrollment binds P-256 keys to the authenticated driver with revocation and lockout. |
| REQ-255 | V2-E | Route-aware consent never blocks a moving driver; off-route samples buffer until safe consent and server validation. |
| REQ-256 | V2-E | ETA uses truthfully fresh inputs and labels unknown/stale states; it cannot imply external-router precision. |
| REQ-257 | V2-E | Live board uses hibernatable Durable Object WebSockets with serialized lens attachment, batching, reconnect, eviction, and polling fallback. |
| REQ-258 | V2-F | Zero-form intake makes the structured form a correction worksheet, not a mandatory happy-path step. |
| REQ-259 | V2-F | One accessible Proposal primitive renders every agent proposal and preserves role, evidence, expiry, and decision state. |
| REQ-260 | V2-F | Command-bar natural language only proposes blessed deterministic verbs; confidence never auto-executes. |
| REQ-261 | V2-F | Exceptions expose one-tap proposals with failure/retry state rather than requiring navigation. |
| REQ-262 | V2-F | AT-1 through AT-6 run as blocking browser, API, isolation, and screenshot evidence. |
| REQ-263 | V2.5 | Market benchmark ports provide context only; sold-price participation requires frozen/co-signed inputs. |
| REQ-264 | V2.5 | Single-rep SKU is one-user and excludes driver, dispatch, and Command authority. |
| REQ-265 | V2.5 | Rep workflows operate only on data the rep is authorized to originate; employer inbound data is not assumed portable. |
| REQ-266 | V2.5 | Evidence sender identity is pinned per rep at decision time and remains byte-stable on retry. |
| REQ-267 | V2.5 | Referral attribution is deterministic, event-backed, tenant-safe, and does not require a new table. |
| REQ-268 | V2.5 | Reputation Scorecard is scoped to the rep's own authorized activity and labels denominator/freshness. |
| REQ-269 | V2.5 | SELF passport is keyed to control-plane identity and has explicit tenant and rep isolation tests. |
| REQ-270 | V3 | Team/manager rollup is a later Portal lens, not a fourth surface. |
| REQ-271 | Cross-cutting | `CONFIRM-GATED` is a first-class status; an open confirmation prevents environment promotion. |
| REQ-272 | Cross-cutting | Every V2 requirement maps bidirectionally to milestone, implementation, test, evidence, and owner. |
| REQ-273 | Cross-cutting | Legacy mirror feeds real or representative values before any authority flip; drift triggers tested fallback. |
| REQ-274 | V2-E/F | The sixth blessed screenshot is an explicit governed budget amendment and passes the complete design audit. |
| REQ-275 | Cross-cutting | New `agent.acted` writes require a closed subtype and per-subtype schema/redaction/isolation proofs; legacy replay remains readable. |
| REQ-276 | P0 | Duplicate source artifacts are removed and a git-aware duplicate check protects count/enum gates. |
| REQ-277 | P0 | Every schema/contract change has expand/backfill/verify/contract steps, compatibility tests, rollback/forward-repair, and migration locks. |
| REQ-278 | P0 | Feature flags separate deployment, exposure, write authority, and read authority; defaults are off and rollback is tested. |
| REQ-279 | Cross-cutting | Each milestone declares measurable latency, freshness, throughput, availability, battery, and browser budgets with reference environments. |
| REQ-280 | Cross-cutting | Every queue/effect class defines idempotency, retry classes, max attempts, DLQ behavior, re-drive, and reconciliation. |
| REQ-281 | Cross-cutting | Structured telemetry correlates request, proposal, decision, event, effect, and outcome without leaking PII; alerts name owners and runbooks. |
| REQ-282 | Cross-cutting | External/API/storage/compute costs have tenant attribution, hard quotas, warnings, and fail-closed or degraded behavior. |
| REQ-283 | P0 | A maintained threat model covers tenants, roles, devices, agent/model inputs, providers, offline state, WebSockets, evidence URLs, and admin paths. |
| REQ-284 | P0 | Data classes define retention, deletion/tombstone, legal hold, export, backup, restore, RPO/RTO, and reconciliation. |
| REQ-285 | V2-F | Core journeys meet WCAG 2.2 AA, keyboard/screen-reader/touch requirements, supported viewport/device matrix, and reduced-motion behavior. |
| REQ-286 | P0 | All consequential proposals use the durable proposal lifecycle with expiry, precondition hash, supersession, role/lens validation, and reconciliation. |
| REQ-287 | P0/D | Dispatch/HOS/capacity decisions require authoritative asset, qualification, availability, location, and ELD/co-signed HOS truth; missing truth abstains. |
| REQ-288 | P0 | Release promotion consumes only complete evidence records tied to the exact commit, environment, fixtures, deployment, and assertions. |

## 9. V2 Build Graph

```text
V1 R1/R2
   ↓
P0 governance, migrations, flags, evidence, security, recovery
   ↓
PA structured facilities, geocoding, jurisdiction
   ├──→ PB quote/book authority ───────┐
   ├──→ PC pricing configuration ─────┼──→ PD optimization/dispatch
   └──→ PE driver/location truth ─────┘             ↓
                                               PF integrated UX
                                                    ↓
                                        R3 pilot → R4 production
                                                    ↓
                                         30-day shadow → R5
```

Critical-chain estimates after V1:

- P0: 3–5 engineer-days;
- PA: 7–10 engineer-days;
- PB: 10–15 engineer-days;
- PD: 10–15 engineer-days;
- PF: 5–8 engineer-days;
- PC and PE run in parallel where their P0/PA dependencies permit;
- the R5 shadow period is at least 30 calendar days and cannot be compressed by staffing.

## 10. Acceptance Tests

- **AT-1 — Accessorial truth:** a residential/liftgate candidate is proposed with evidence; sell changes only after co-sign.
- **AT-2 — Zero-form book:** a stranger moves from one prose request to booked in under three minutes using only Confirm and Book on the happy path.
- **AT-3 — Backhaul opportunity:** a seeded deadhead produces a marginal-priced, floor-verdict opportunity with frozen basis and event drill-through.
- **AT-4 — Address reveal:** API and UI withhold stop N until stop N-1 terminal evidence; a driver-authored skip alone does not advance the pointer.
- **AT-5 — Pricing onboarding:** conversation produces a candidate config, but live pricing remains disabled until full-export replay reconciles within 2%.
- **AT-6 — Dispatch proposal:** an unassigned load receives a cited eligible-truck proposal; a human decision is required for `dispatch.assigned`.

Every AT includes:

- API assertions;
- role and cross-tenant probes;
- browser interaction;
- accessibility assertions;
- failure/degraded behavior;
- event/projection/effect reconciliation;
- screenshot or recording where visual/field behavior is material;
- an evidence record attached to the exact release SHA.

## 11. Error Handling

The system uses four explicit outcomes:

- **reject:** caller/input/authority failure; append/effect count stays zero;
- **hold:** valid intent but missing external or legal prerequisite;
- **retry:** transient failure with bounded backoff and durable idempotency;
- **degrade:** optional capability unavailable while the authoritative core remains truthful.

Unknown is a first-class value. It is never converted to:

- a guessed address;
- available HOS;
- an accepted identity;
- a clear credit decision;
- stored evidence;
- a successful send;
- a production-ready gate.

## 12. Ownership

| Role | Accountable decisions |
|---|---|
| Owner/Product | Scope, stage, acceptance journeys, release signature |
| Technical lead | Architecture, dependency graph, merge readiness |
| Requirements owner | Register integrity and traceability |
| Assurance owner | Evidence schema, non-skip gates, acceptance proof |
| SRE/Platform | Environments, observability, queues, rollback, recovery |
| Security | Threat model, isolation, device/provider/data controls |
| Data/config owner | Tenant packs, provider provenance, mirror/parity |
| Counsel | Consent, outreach, retention, e-sign, broker/communications gates |
| Pilot owner | Real users/devices, field runs, defect acceptance |

## 13. Source of Truth and Document Migration

Authority order:

1. owner-approved requirement register;
2. immutable code/migrations/contracts;
3. executable tests and exact release evidence;
4. this approved design;
5. implementation plans and operational documentation;
6. exploratory drafts.

The existing untracked July 23 V2 and debt documents remain preserved as source material. They are not authoritative until their valid content is migrated into the tracked register, implementation plan, and verified operational documents.

## 14. Approval Record

The owner approved this boundary on 2026-07-23:

- V1 R1/R2 remediation first;
- V2 Tenant-0 internal operations under REQ-214–REQ-288;
- cold outreach and the single-representative product deferred to V2.5;
- no background-GPS or HOS authority claim without native/ELD or explicitly co-signed truth.
