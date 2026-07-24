# SHUDDL V2 Execution Framework

**Status:** Approved scope; requirements recorded; implementation not started
**Authority:** `genesis/09-REQUIREMENTS-REGISTER.csv` REQ-214 through REQ-288
**Design source:** `docs/plans/2026-07-23-v1-remediation-v2-framework-design.md`
**Release objective:** Tenant-0 end-to-end internal operations at R4 followed by evidence-backed authority cutover at R5

## 1. Definition of Done

V2 is complete only when:

- the authoritative register remains contiguous from REQ-001 through REQ-288;
- every V2 requirement maps bidirectionally to a phase, accountable owner, implementation, executable test, blocking gate, and exact-release evidence;
- the V1 remediation release has reached R2 before any V2 feature receives write or read authority;
- AT-1 through AT-6 pass against the same release SHA with API, browser, accessibility, isolation, degraded-path, and reconciliation assertions;
- all production resources, providers, licenses, secrets, alerts, recovery controls, tenant inputs, and field evidence required by the active scope are current;
- no skipped, pending, malformed, stale, zero-assertion, or environment-mismatched result promotes a release;
- the system completes the noncompressible 30-day shadow period within the reconciliation limits and proves fallback before R5.

This document is an execution contract. It does not claim that any REQ-214 through REQ-288 behavior is already built.

## 2. Governing Scope

### V2 critical path

V2 covers Tenant-0 internal operations:

- structured facilities, authoritative geocoding, and jurisdiction;
- AI-assisted quote-to-book;
- conversational pricing configuration;
- internal backhaul detection and marginal pricing;
- co-load and dispatch proposals;
- real driver synchronization and foreground browser location;
- live server-scoped operational views;
- a durable proposal and approval lifecycle;
- release, security, recovery, observability, cost, and accessibility assurance.

### Deferred scope

The following are specified but do not gate V2:

- REQ-239 through REQ-242: cold prospect sourcing and outreach at V2.5;
- REQ-263 through REQ-269: market context and the single-representative product at V2.5;
- REQ-270: team and manager rollup at V3.

Outreach remains disabled until REQ-242's counsel and operational confirmations are satisfied. The single-representative product has no driver, dispatch, or Command authority.

### Truth boundaries

- Browser location is sampled only while the application is foreground, visible, permitted, and assigned. Background state is explicit and is never represented as continuous tracking.
- Continuous background tracking requires a separately approved native client or authoritative ELD integration.
- Dispatch, capacity, and HOS recommendations abstain unless asset identity, qualifications, availability, location freshness, and ELD or separately co-signed HOS truth are authoritative.
- Missing pings, schedule gaps, model confidence, and silence never imply available hours.
- Cold outreach does not enter the V2 critical path.

## 3. Storage and Authority Architecture

The following ownership rules are governing invariants for every V2 phase:

| Store or runtime | Authoritative responsibility | Forbidden reliance |
|---|---|---|
| D1 | Business state; projections; facilities; parties; assets; approvals; provider provenance; configuration; and metadata or hash references to durable bytes | D1 projections cannot replace the append-only facts and decisions from which they are derived |
| Append-only ledger | Authoritative business facts and decisions; ordered event history; proposal creation; approval decisions; and the basis for reconciliation | No mutable row; cache; transcript; or model output may silently replace a committed fact or decision |
| Durable Objects | Serialize stream writes; coordinate ordering; own live connection cursors; batch fan-out; hibernate connections; and coordinate sessions | A Durable Object is never the sole durable record of a proposal; decision; business state; cursor outcome; or effect |
| R2 | Durable evidence bytes; recordings; transcripts where retention permits; licensed assets; and exports | An R2 object without tenant-scoped D1 metadata and the expected hash cannot satisfy an evidence or authority check |
| KV | Disposable cache and non-authoritative configuration acceleration | KV cannot authorize a fail-closed decision and loss or staleness of KV cannot destroy business truth |
| Queues and DLQs | Recoverable triggers for work and effect delivery | Queue presence; absence; ACK; or retry state is never sole business truth |

### 3.1 Write and recovery rules

- A Durable Object may order a write but success is acknowledged only after the authoritative ledger fact or decision is durable.
- D1 projections are replayable from authoritative ledger events. Projection loss or lag produces an explicit stale or unavailable state until reconciliation completes.
- R2 bytes are addressed through tenant-scoped D1 metadata containing the object key, content hash, evidence kind, retention state, and originating event reference. Evidence authority requires both valid metadata and matching stored bytes.
- KV loss is handled as a cache miss. A stale, missing, or poisoned cache entry cannot broaden access, clear a hold, fabricate configuration, or satisfy a release check.
- Every queue and effect class declares its source fact, idempotency key, retry classes, maximum attempts, DLQ behavior, reconciliation query, re-drive command, and expected durable outcome.
- Queue loss is recoverable by querying ledger and projection state for committed intent without the expected outcome. Duplicate delivery is harmless under the declared idempotency key.
- Durable Object eviction, hibernation, or restart reconstructs authorized session and cursor state from durable D1 or ledger truth before serving scoped data.

### 3.2 P0 authority evidence

P0 cannot exit until exact-SHA evidence proves:

- D1 projections can be rebuilt from ledger facts without changing fact or decision history;
- Durable Object restart and hibernation lose no committed proposal, decision, cursor boundary, or effect and disclose no broader lens;
- deleting or poisoning KV changes only cache behavior and never changes authorization or business outcomes;
- missing, tombstoned, cross-tenant, or hash-mismatched R2 bytes fail evidence checks;
- dropped and duplicated queue deliveries converge through reconciliation and re-drive to exactly one expected durable outcome;
- every trigger and effect class appears in the retry/DLQ/reconciliation matrix and an omitted class fails the P0 gate.

## 4. Durable Proposal Lifecycle

Every consequential agent recommendation follows one durable state machine. This is the single proposal primitive for REQ-223, REQ-245, REQ-259, REQ-260, REQ-275, and REQ-286.

```text
agent.acted{*_proposed; proposal_id; recommended_verb;
            precondition_hash; expires_at; evidence_refs; basis_ref}
    -> approvals projection OPEN
    -> authenticated decision endpoint
    -> tenant + role + lens + expiry + OPEN-state + precondition validation
    -> approval.decided{accepted|rejected|expired|superseded}
    -> accepted only: one allowlisted server verb
    -> idempotent effect
    -> reconciliation verifies or re-drives the durable outcome
```

### 4.1 Creation and persistence

- Proposal creation is an append-only ledger fact. The server binds tenant, actor, lens, subtype, and creation time from authenticated context rather than trusting model or browser claims.
- Every new proposal write carries a unique proposal ID, a closed `agent.acted.payload.subtype`, a schema-valid allowlisted recommended verb, a hash of the authoritative preconditions, an expiry, durable evidence references, and a frozen decision basis reference.
- The D1 approvals projection opens only after the proposal event commits. It is a replayable read model rather than the proposal's unique truth.
- Proposal text, structured basis, evidence references, source versions, and redaction-safe rationale remain durably discoverable for decision, replay, audit, and reconciliation.
- Chat history, browser state, an agent run, a queue message, and Durable Object memory are transient aids. None may be the only record of the proposal, evidence, basis, decision, or expected effect.

### 4.2 Decision validation

The authenticated decision endpoint loads the durable proposal and validates in this order:

1. the proposal belongs to the authenticated tenant;
2. the caller's role satisfies the proposal's required role;
3. the caller's lens may see and decide the referenced shipment, party, asset, and evidence;
4. the approvals projection and authoritative event history still show the proposal OPEN;
5. server time is before `expires_at`;
6. the current authoritative inputs hash to the recorded `precondition_hash`;
7. the recommended verb remains allowlisted and its normal server-side gates pass.

Tenant, role, or lens failure rejects with zero decision append and zero effect. Expiry produces one durable `expired` outcome. A changed precondition produces one durable `superseded` outcome. Neither can execute the recommendation.

### 4.3 Outcomes and execution

- `accepted`, `rejected`, `expired`, and `superseded` are terminal durable decision outcomes.
- Only a committed `accepted` decision may invoke the proposal's allowlisted server verb. Model confidence, UI state, or an OPEN projection never invokes it.
- The verb re-runs normal identity, authority, financial, disclosure, and operational gates. Proposal approval cannot bypass a domain gate.
- The effect idempotency key is derived from proposal ID, decision event ID, and allowlisted verb. Retry returns or reconstructs the same outcome rather than appending a second effect.
- Reconciliation finds accepted decisions without their expected durable effect, re-drives the allowlisted verb, and records or verifies the outcome.
- An effect failure does not reopen the proposal or erase its accepted decision. It becomes a durable retry, DLQ, or terminal failure state under the effect-class contract.

### 4.4 Legacy compatibility

New `agent.acted` writes require a closed subtype schema with subtype-specific validation, redaction, tenant isolation, evidence, and basis rules. Legacy payloads remain readable and replayable. Legacy readability cannot authorize a new proposal, decision, command, or effect; an old payload must first pass an explicit compatibility adapter or migration into a current validated shape.

### 4.5 Failure and race semantics

- Proposal creation and decision appends are serialized on the relevant authoritative stream.
- Concurrent terminal decisions use first-valid-terminal-wins. Later attempts return a deterministic conflict and append or execute nothing.
- A repeated request with the same idempotency key returns the original decision result.
- If the process fails before the decision commit, a retry may decide the still-OPEN proposal.
- If the process fails after the decision commit but before effect execution or acknowledgement, reconciliation resumes the idempotent effect from the committed decision.
- If expiry or authoritative input change wins the race, acceptance loses and no effect executes.
- Projection lag cannot reopen a proposal whose authoritative event history is terminal.
- UI disconnect, chat loss, queue loss, and Durable Object eviction do not change proposal state.

### 4.6 P0 lifecycle evidence

P0 cannot exit until exact-SHA tests and evidence cover:

- every allowed subtype plus unknown-subtype rejection;
- schema, redaction, role, lens, tenant-isolation, expiry, current-state, and precondition-hash failures;
- all four terminal outcomes and replay from ledger into the OPEN or terminal projection;
- concurrent accept/reject, accept/expire, accept/supersede, and duplicate-accept races;
- failure before decision commit, after decision commit, after effect execution, and before effect acknowledgement;
- idempotent reconciliation and DLQ re-drive to exactly one durable outcome;
- readable legacy replay with proof that legacy payloads cannot authorize new execution;
- recovery after UI, chat, queue, and Durable Object state is discarded.

## 5. Dependency Graph

```text
V1 R2
  |
  v
P0 governance / migrations / flags / evidence / security / recovery
  |
  v
PA facilities / geocoding / jurisdiction
  |-------------------------------|
  |               |               |
  v               v               v
PB quote/book     PC pricing      PE driver/location
authority         configuration   truth
  |               |               |
  |---------------|---------------|
                  |
                  v
       PD optimization / dispatch
                  |
                  v
          PF integrated UX
                  |
                  v
          R3 pilot -> R4 production
                  |
                  v
       30-day shadow -> R5 cutover
```

The R5 shadow is at least 30 consecutive calendar days. Staffing cannot compress it.

## 6. Requirement Allocation

| Phase | Authoritative requirements | Accountable lead | Primary proof |
|---|---|---|---|
| P0 | REQ-271 through REQ-273; REQ-275 through REQ-284; REQ-286 through REQ-288 | Technical lead | Governance contract tests and release evidence |
| PA | REQ-214 through REQ-220 | Data/config owner | Migration; provider; provenance; jurisdiction tests |
| PB | REQ-221 through REQ-230 | Technical lead | AT-1 and AT-2 plus quote-authority tests |
| PC | REQ-231 through REQ-235 | Data/config owner | AT-5 and full-export replay |
| PD | REQ-236 through REQ-238; REQ-243 through REQ-245; REQ-287 | Technical lead | AT-3 and AT-6 |
| PE | REQ-246 through REQ-257; REQ-274 where the driver reference applies | Pilot owner | AT-4 and real-device evidence |
| PF | REQ-258 through REQ-262; REQ-274; REQ-285 | Owner/Product | All six ATs and integrated browser evidence |
| V2.5 deferred | REQ-239 through REQ-242; REQ-263 through REQ-269 | Owner/Product and Counsel | Separate owner-approved activation plan |
| V3 deferred | REQ-270 | Owner/Product | Separate owner-approved register amendment |

Cross-cutting requirements established in P0 remain active gates for every later phase. REQ-287 is established in P0 and exercised in PD. REQ-274 is shared by PE and PF.

## 7. Phase Entry and Exit Gates

### P0 — Governance and authority

**Entry**

- V1 has an R2 PASS evidence record for the exact baseline SHA.
- REQ-214 through REQ-288 are contiguous, classified, and owner-approved.
- Phase owners and evidence locations are assigned.

**Work**

- make `CONFIRM-GATED` a promotion-blocking state;
- establish bidirectional traceability and legacy-mirror fallback;
- close the new `agent.acted` subtype union while retaining legacy replay;
- encode the Section 3 storage ownership table as tested authority and recovery contracts;
- encode the Section 4 proposal state machine as the only consequential-agent execution path;
- install duplicate-source, migration, feature-flag, SLO, retry/DLQ, telemetry, cost, threat-model, retention/recovery, proposal-lifecycle, operational-truth, and release-evidence contracts;
- separate deploy, exposure, write-authority, and read-authority flags with all defaults off.

**Exit**

- every P0 requirement has executable contract tests and a named owner;
- an uncovered migration, threat surface, effect class, cost surface, or evidence field blocks the gate;
- all Section 3 authority-loss drills pass and every queue or effect class has reconciliation and re-drive evidence;
- the complete Section 4 subtype, decision, race, crash-window, legacy, isolation, and reconciliation matrix passes;
- P0 evidence records bind those assertions to the exact commit, environment, fixtures, and deployment under test;
- rollback restores the prior read/write authority;
- all flags remain off in production;
- no feature phase begins with an unresolved Critical or High P0 finding.

### PA — Facilities and geography

**Entry**

- P0 passes.
- Licensed provider/storage modes and the jurisdiction-data source are approved.
- Facility backfill inputs and rollback ownership exist.

**Work**

- add forward-only facility references and backfill;
- add injected geocoder ports and provenance;
- make coarse results explicitly non-authoritative;
- protect sold terms from silent geocode changes;
- enforce privacy-minimized provider payloads;
- keep basemap/offline assets self-hosted;
- replace state boxes with versioned point-in-polygon resolution.

**Exit**

- migrations pass expand/backfill/verify/contract and compatibility tests;
- zero dangling facility references remain;
- all stored geocodes carry precision, source, version/hash, license/storage mode, and timestamp;
- unknown jurisdiction and coarse location fail closed;
- provider absence degrades or holds exactly as declared and never invents truth.

### PB — Quote and book authority

**Entry**

- P0 and PA pass.
- The durable proposal lifecycle and booking-grade address authority are available.

**Work**

- expose authenticated Portal Concierge chat;
- add structured-lane auto-build with address gates;
- add cited accessorial and scope-change proposals;
- append both appointment facts through the sequencer;
- bind billing to the exact accepted booking quote;
- enforce open-proposal and re-acceptance rules;
- make agent and non-agent booking gates identical;
- validate model-derived claims;
- reconcile accepted-but-unbooked quotes idempotently.

**Exit**

- AT-1 and AT-2 pass;
- later unaccepted quotes cannot affect billing;
- no booking path bypasses credit, evidence-recipient, identity, or authority gates;
- missing or invalid model claims remain UNKNOWN;
- reconciliation creates exactly one booking.

### PC — Pricing configuration

**Entry**

- P0 and PA pass.
- Tenant archetype inputs and a complete historical export are available.

**Work**

- interview by archetype while pure factories generate configuration;
- version broker, asset, LTL-adapter, and shipper templates;
- attach versioned pricing-model provenance to parties;
- role-gate publication, rebase, approval, and rollback;
- run complete historical replay.

**Exit**

- AT-5 passes;
- deterministic fixtures reproduce candidate hashes;
- free-form JSON cannot become rate authority;
- no agent can self-publish pricing;
- complete historical export replay is within 2% before live pricing is enabled.

Conversation replay alone is a smoke test and cannot satisfy this exit.

### PE — Driver and location truth

**Entry**

- P0 and PA pass.
- Real supported devices, authenticated test drivers, licensed offline tiles, and field-run owners are scheduled.

**Work**

- mount the shared map under the driver lens;
- add the governed night-map reference;
- bound corridor prefetch and cache;
- enforce server-side forward-stop redaction and one-stop offline lookahead;
- require dispatcher co-sign for skip advancement;
- attach authoritative stop geometry and provenance;
- sample browser location only in truthful foreground states;
- bind and revoke driver P-256 keys;
- buffer route-aware consent safely;
- label ETA freshness;
- operate the live board through scoped hibernatable WebSockets with polling fallback.

**Exit**

- AT-4 passes across API and browser;
- three declared real-device offline/reconnect runs lose and duplicate zero events;
- hidden, denied, unassigned, stale, and background states are explicit;
- unrevealed stop detail is absent from API responses, browser state, and offline cache;
- reconnect restores the same authorized lens and cursor.

This phase does not claim background browser GPS or infer HOS.

### PD — Optimization and dispatch

**Entry**

- P0, PA, PB, PC, and PE authority inputs pass.
- Asset, qualification, assignment, location-freshness, and HOS/ELD or co-signed-manual sources are named and testable.

**Work**

- add injected routing ports;
- detect and self-clear backhaul opportunities idempotently;
- snapshot marginal-price basis and apply existing economic gates;
- add the single canonical `v_opportunities` view;
- raise bounded timeline anomalies without invented causes;
- propose co-load and dispatch options while preserving human-gated `dispatch.assigned`.

**Exit**

- AT-3 and AT-6 pass;
- the schema adds exactly one canonical opportunity view;
- proposals drill through to committed facts and frozen basis;
- missing operational truth produces an explicit abstention;
- a proposal alone cannot append `dispatch.assigned`;
- repeated detection and reconciliation are idempotent and self-clearing.

### PF — Integrated experience and acceptance

**Entry**

- PB, PC, PD, and PE pass.
- The sixth blessed screenshot has an approved budget amendment.
- The supported browser, viewport, assistive-technology, touch, and device matrix is frozen.

**Work**

- make prose the zero-form happy path and the structured form a correction worksheet;
- render every consequential recommendation through one accessible Proposal primitive;
- constrain natural-language commands to proposals for allowlisted deterministic verbs;
- expose in-place exception actions and failure/retry state;
- execute the complete integrated acceptance and accessibility suite.

**Exit**

- AT-1 through AT-6 all pass against one release SHA;
- WCAG 2.2 AA, keyboard, screen-reader semantics, touch targets, viewport/device coverage, and reduced motion pass;
- six and only six governed reference screenshots pass the complete design audit;
- all phase SLO and cost budgets pass in their declared reference environments;
- zero unresolved Critical or High findings remain.

## 8. Acceptance Tests

### AT-1 — Accessorial truth

A residential or liftgate candidate is proposed with cited evidence. Sell changes only after explicit client co-sign. Rejection is durable and changes no sold terms.

### AT-2 — Zero-form book

A stranger moves from one prose request to booked in under three minutes using only Confirm and Book on the happy path. All normal booking gates still run.

### AT-3 — Backhaul opportunity

A seeded deadhead produces a marginal-priced opportunity with frozen detour and handling basis, existing floor verdict, and event drill-through.

### AT-4 — Address reveal

API, browser, and offline cache withhold stop N until stop N-1 terminal evidence is committed. A driver-authored skip alone does not advance reveal state.

### AT-5 — Pricing onboarding

Conversation creates candidate configuration. Live pricing stays off until the complete historical export replay reconciles aggregate results within 2%.

### AT-6 — Dispatch proposal

An unassigned load receives a cited eligible-truck proposal only from authoritative asset, capacity, qualification, availability, location, and HOS inputs. A human decision is required for `dispatch.assigned`.

Every AT must include:

- API assertions;
- role and cross-tenant probes;
- browser interaction;
- accessibility assertions;
- failure and degraded behavior;
- event/projection/effect reconciliation;
- screenshot or recording where visual or field behavior is material;
- a complete evidence record tied to the exact release SHA.

## 9. Release Grades

| Grade | Promotion rule |
|---|---|
| R0 — Audited | Current-state audit and reproducible baseline exist; no readiness claim |
| R1 — Mergeable | Zero open repository Critical/High debt and the authoritative merge gate passes |
| R2 — Staging-certified | Builds; migrations; strict browser; accessibility; performance; staging smoke; alerts; DLQ; rollback; and recovery evidence pass |
| R3 — Pilot-ready | Tenant pack; legal approvals; on-call; real devices; field acceptance; and restore drill pass |
| R4 — Production-ready | Production resources; secrets; DNS; CORS; rate limits; sender identity; backups; SLOs; acceptance; and rollback pass |
| R5 — Authority cutover | At least 30 shadow days; aggregate reconciliation within 2%; two clean closes; clean pilot metrics; and tested fallback pass |

Promotion is monotonic only in evidence. A stale prerequisite demotes the candidate to BLOCKED until it is renewed.

## 10. Evidence and Anti-Skip Rules

Every promotion gate records:

```json
{
  "gate": "string",
  "commit": "git-sha",
  "environment": "merge|staging|pilot|production|shadow",
  "scope": ["requirement-or-phase"],
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
- Missing tooling, fixtures, providers, permissions, data, or environments returns BLOCKED rather than PASS.
- SKIPPED, PENDING, advisory, stub, not-available, and never-run output cannot promote.
- Commit, environment, fixture hashes, deployment version, and evidence expiry must match the artifact being promoted.
- NOT_APPLICABLE requires an owner-approved rationale and cannot hide an in-scope requirement.
- Release aggregation consumes only complete current records.

## 11. Accountable Roles

| Role | Accountable decisions |
|---|---|
| Owner/Product | Scope; phase activation; acceptance journeys; release signature |
| Technical lead | Architecture; dependency graph; implementation integration; merge readiness |
| Requirements owner | Register continuity; stage; owner; traceability; status truth |
| Assurance owner | Evidence schema; non-skip gates; AT completeness; grade promotion |
| SRE/Platform | Environments; resources; telemetry; queues; rollback; backup and recovery |
| Security | Threat model; tenant and role isolation; device; provider; offline and admin controls |
| Data/config owner | Facility and pricing provenance; tenant packs; mirror and parity |
| Counsel | Consent; outreach; retention; e-sign; broker and communications gates |
| Pilot owner | Real users and devices; field runs; pilot defects and acceptance |

No role may self-approve a control for which it produced the sole evidence. Owner/Product signs scope and release; Assurance validates the evidence contract.

## 12. External Holds

An external hold is explicit, owned, dated, and promotion-blocking only for the phase that needs it.

| Hold | Owner | Blocks | Observable release condition |
|---|---|---|---|
| Geocoder/routing license and durable-storage terms | Data/config owner | PA and PD | Approved provider mode and retained license record |
| Versioned licensed jurisdiction polygons | Data/config owner and Counsel | PA | Hash; version; source; policy mapping; supported-coordinate fixtures |
| Complete Tenant-0 historical pricing export | Data/config owner | PC and R5 | Export hash; row count; replay report within 2% |
| Authoritative asset/capacity/qualification/availability feed | Pilot owner | PD | Source contract and missing-input abstention tests |
| ELD or separately co-signed manual HOS truth | Pilot owner | HOS-sensitive PD decisions | Current source evidence and reconciliation tests |
| Native client if continuous background GPS is later requested | Owner/Product | Only that future claim | Separately approved requirement and field evidence |
| Cloud resources; routes; secrets; queues; DLQs; Durable Objects; R2 and D1 | SRE/Platform | R2 through R4 | Exact-deployment smoke; alert; rollback; and restore evidence |
| Real supported devices and field operators | Pilot owner | PE and R3 | Scheduled matrix and three clean offline/reconnect runs |
| Counsel approval for outreach | Counsel | REQ-242 and V2.5 only | Current written approval plus all named operational gates |
| Sender domain; suppression; and deliverability controls | SRE/Platform and Counsel | V2.5 outreach only | Domain and control evidence; does not block V2 internal operations |

Missing external inputs produce HOLD or BLOCKED. They never become guessed values or a successful gate.

## 13. Schedule and Critical Chain

Approved critical-chain estimates after V1:

- P0: 3–5 engineer-days;
- PA: 7–10 engineer-days;
- PB: 10–15 engineer-days;
- PD: 10–15 engineer-days;
- PF: 5–8 engineer-days;
- PC and PE run in parallel after their P0/PA dependencies permit;
- PC and PE estimates are baselined only after export size and supported device matrices are measured;
- field scheduling, provider/legal confirmation, tenant export delivery, and production provisioning are external lead times rather than hidden engineering estimates;
- the R5 shadow is at least 30 calendar days and is noncompressible.

Each phase is opened only after its entry record is PASS. Work may be developed behind default-off deployment flags, but exposure and write/read authority cannot advance ahead of the dependency graph.

## 14. Failure Semantics

Every interface chooses one truthful outcome:

- **reject:** caller, input, role, tenant, or authority failure; append and effect counts remain zero;
- **hold:** valid intent is missing a legal, provider, field, or owner prerequisite;
- **retry:** transient failure uses bounded backoff, durable idempotency, DLQ, re-drive, and reconciliation;
- **degrade:** an optional capability is unavailable while authoritative core behavior remains correct.

UNKNOWN is a value. It is never converted into an address, identity, clear credit decision, available HOS, stored evidence, successful send, or release PASS.

## 15. Framework Maintenance

- The register is append-only. Existing IDs are never renumbered or reused after approval.
- The requirement parser rejects malformed, duplicate, gapped, suffixed, and reordered IDs.
- Requirement status advances only with executable implementation and evidence; a manifest entry is a deferred home rather than proof of construction.
- Scope changes require an owner-approved register amendment and updated dependency/evidence mappings.
- Operational documents describe verified behavior. Exploratory drafts cannot override the register or exact-release evidence.
