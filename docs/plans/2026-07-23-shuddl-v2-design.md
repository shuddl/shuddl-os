# SHUDDL v2 — The AI-Native Freight Operating System

> **Record note (added 2026-08-01, on commit):** committed as the dated design record. `genesis/09-REQUIREMENTS-REGISTER.csv` and `docs/ops/V2-EXECUTION-FRAMEWORK.md` are authoritative wherever they disagree with this file. Citations FROZEN as-of writing.
### One design, synthesized from seven lenses and hardened against adversarial review. For owner approval.

---

## 1. Vision & Principles

SHUDDL v1 proved the hard part: an append-only, co-signed ledger of physical freight reality, three surfaces on a live map, money as a projection of physics (POD → invoice + evidence email, same second), and a disciplined injected-port agent seam that keeps every LLM out of the ledger. That spine is genuinely solid — append-only INSERT guards, deterministic idempotent agents, server-side gate parity, tenant isolation, canonical-hash byte law, and commit→enqueue recovery sweeps are all real and audit-clean.

**But v1 is still a forms product wearing a beautiful skin.** `QuotePanel` opens on four empty inputs. `IntakeFlow` makes a CSR key three parties and a lane by hand. The command bar is a deterministic filter that cannot *act*. Accessorials are a free-text comma field. The driver app mounts no map. And every one of the owner's four flagship AI-native behaviors — proactive accessorial flagging, backhaul revenue optimization, conversational pricing onboarding, the solo-rep product — is unbuilt.

**v2 closes that gap. The thesis:**

> SHUDDL v2 is an AI-native operating system, not a TMS. An agentic workforce does everything reasonable to handle; the human's job collapses to a stream of one-tap confirmations over pre-done work, punctuated by the map going quiet when something is wrong. "Award-winning" is not decoration — it is **the measured elimination of every unnecessary action**, achieved through industry-deep design plus a well-implemented agent workforce, all under Terminal Gallery law (5 tokens, 2 fonts, squint-test CI).

The thesis has a hard test the v1 design failed: **the agent workforce must cover the highest-frequency daily action, not just the glamorous edges.** For a carrier running all its freight, that action is *dispatch — assigning loads to trucks*. A design that automates accessorial detection but leaves dispatch a fully manual board has not collapsed the human's job; it has decorated it. v2 therefore ships a **dispatch-proposal agent** as a first-class member of the workforce (§3.6). Auto-commit of a physical-custody decision stays out of scope; the *proposal* is not optional.

### The nine interaction principles (the constitution)

Every screen is auditable against these the way the squint-test audits pixels.

1. **Zero-form intake.** The default input is prose or a photo, never a field grid. The typed form is the agent's worksheet, revealed only to correct it.
2. **Question-at-a-time.** The agent asks only the single physical fact it genuinely cannot infer. A question the agent *could* answer (residential from the address) is a bug, not a field.
3. **One-tap approval is the terminal gesture of every agent action.** The agent does the work; the human taps Approve/Deny once — including on the day's dispatch board.
4. **The command bar accepts intent, not just labels.** ⌘K resolves natural language to a proposed, gate-checked, one-tap verb — NL routed through `packages/agents`, never the ledger.
5. **Proactive suggestion replaces navigation.** The thing that needs attention comes to the operator — as a map pulse, a queue row, a pre-drafted approval. The 12 canonical views are where you *audit*, not where you *work*.
6. **Provenance on click, everywhere.** Every number, state, and agent claim is one tap from the ledger event that produced it. Trust is a click away or it isn't trust.
7. **Honest-by-construction states.** The UI never fakes a success the server didn't grant. "BOOKING REQUESTED" never "BOOKED"; UNKNOWN shows no price; below-floor shows PENDING APPROVAL with no book button.
8. **Status is grammar, not chrome.** Geometry, opacity, motion, one mono chip. No greens, no yellows, no badges, no toast soup. The exception is the world going quiet.
9. **Agent reasoning is visible but collapsed.** One mono-line rationale that expands on click to cited evidence. Trust the AI without auditing it every time — but be able to, in one tap.

### The load-bearing engineering doctrine (unchanged, extended)

Every v2 behavior obeys: **REQ-024** (no LLM/external in `packages/ledger` or `packages/rater` — statically linted; every new port lives in `packages/agents`); **no price on air** (missing weight/dims → UNKNOWN, no sell); **interline floors compare the executing share, never gross** (the $222,084/35-lb regression is permanent); **gates are server-side** with API parity; **the model is never trusted at a truth boundary** — it decides *what to do*, the pure tested spine decides *what is true*.

**The rater is a pure function of frozen, co-signed inputs.** This is not a location rule about *where* the LLM lives; it is a determinism rule about *what the rater eats*. Any external-sourced number that participates in a sold quote (a market benchmark, a marginal-detour cost) must be **snapshotted into the co-signed request at quote time** and thereafter treated as a frozen input, or the 504-quote monotonic sweep and the ±2% replay fixtures cannot hold. A floating input that reaches the rater breaks replayability even if the *port* that fetched it is correctly quarantined in `packages/agents` (§3.3, §5.4).

**The whole of v2 costs the schema budget almost nothing: 0 new event kinds (the 35-kind freeze holds), 0 new tables (the spare stays intact), 1 additive column-ALTER on `shipments`, and 1 `integrations` CHECK-enum amendment.** Portal chat reuses the existing `messages.channel='portal'` value with a payload sub-discriminant — **no third schema change** (§5.3). Every new behavior rides existing primitives — `agent.acted` (with a mandatory payload sub-type discriminant, §5.3), `anomalies`, `messages`, `agent_runs`, `facilities`, `rate_config`, `legs.geo`, `pickup.scheduled` / `appointment.set`, and *views* over the ledger.

---

## 2. v2 Scope Statement & Explicit Non-Goals

### In scope (owner-confirmed this session)

**v2 = Tenant-0 running ALL their freight end-to-end** — the TMS-replacement core: quote → confirm → auto-build → schedule → **dispatch-propose** → driver tracking → POD → invoice + evidence email, plus *internal* optimization (backhaul **detection**, marginal-cost repricing, co-load support, timeline analytics) and full visibility. The shared ledger is visible to counterparties that tenant-0 adds via the existing lens + Passport model.

**Backhaul *outreach* (Apollo prospecting + cold send) is explicitly NOT a v2 build.** The critique is correct that front-loading the highest-legal-risk, most-external-dependency *send* stack into the core-replacement milestone — only to keep it dark behind a CONFIRM — burns tent-pole time for zero v2 outcome. v2 builds the part of the backhaul thesis that has standalone value *without* outreach: **detecting** empty/underfilled lanes, pricing them at a truthful marginal basis, surfacing them on the OPPORTUNITIES queue, and using that same geometry for **co-load** proposals and **repositioning** insight. The outreach engine (prospecting, sender, suppression, warmup) ships in v2.5 where its CONFIRM flips anyway (§10).

### Explicitly deferred (documented, not relitigated)

| Deferred to | Item | Why |
|---|---|---|
| **v2.5** | The entire cold-outreach engine — `ApolloProspectPort`, `OutreachSender`, domain-scoped suppression, graduated warmup, jurisdiction-at-collection gate; auto-invite-all-clients onto the shared ledger; Apollo cold-sourcing of *missing* client emails; **the entire public "SHUDDL Rep" solo product** (self-serve signup, inbox OAuth, `MarketRatePort`, per-seat evidence identity, portable SELF passport, Reputation Scorecard, referral attribution); solo-rep paid unlock | Requires tenant-0 live + a warm sending domain + counsel sign-off; **none of it is exercised by a v2 user** (tenant-0 has a `rate_config`, so it never touches `MarketRatePort`), so per doctrine it is not v2 code |
| **v3** | Solo-rep team/desk lens + manager rollup; carrier-sales-rep variant (Apollo/DAT lane sourcing); learned accessorial detection; multi-party negotiated pricing; true multi-leg VRP tour optimization; real-time corridor router for ETAs; zero-trust HKDF offline address chain; background geolocation | Heavier tooling; overlaps tenant backhaul agent; needs matured control-plane identity |
| **v4** | Anything on the permanent "Do not build" list — native GL/period close, driver-pay v1, report builder, a fourth surface, seat-based pricing, Direct-merchant/escrow-settle, voice recording, SMC3/class as engine foundation | Each needs an owner-signed register amendment |

**The one sequencing rule that governs everything below: structured lane + geocoding (§5.1) is the tent-pole.** The driver map, live board, backhaul geography, accessorial detection, facility appointments, and the consent-gate footprint *all* block on it. It ships in the first v2 work package **on the injected Mapbox geocoder behind the port** (data-only, no tiles rendered — REQ-075-clean); self-hosted Nominatim/Pelias is a fast-follow behind the identical interface (§5.1). We do **not** gate the entire milestone on a multi-week self-hosted-geocoder infra build.

---

## 3. The Ideal End-to-End Flows

### 3.1 The shipper journey — prose to booked in one conversation

**Design principle: one parse→resolve→compose decision core, four intake channels feeding it, one reply/confirm surface projecting out.** Every channel produces the same `message.received` fact; every answer is a `message.sent` / `quote.priced` fact. **Channel is `messages.channel='portal'` with a payload sub-discriminant `surface:'chat'|'form'`** — not a new CHECK value, not a new event kind (§5.3).

```
intake ─▶ PARSE ─▶ RESOLVE ─▶ BUILD ─▶ ACCESSORIAL SCAN ─▶ SCHEDULE ─▶ PRICE ─▶ CONFIRM ─▶ BOOK
         Concierge  Concierge  Concierge   Auditor(new)     Scheduler   Rater   Concierge  Booking
```

**Four channels, one core.** Inbound email (built), guest quote (built, pure preview), authenticated portal form (built), and **portal chat (new)** all feed the identical `ClaudeParser → resolveConcierge → composeConcierge` core. Portal chat is a `ChatConcierge` Durable Object holding one client↔agent session — a synchronous, multi-turn envelope around the same pure core. Its one power email lacks: when `resolve` returns `low_confidence` or a missing ZIP, chat **asks one targeted clarifying question** ("What's the delivery ZIP?") instead of dropping to a human queue. Same corroboration and floor gates still bound any auto-quote it emits.

**The pipeline, agent by agent:**

- **Parse (Concierge).** Freeform → structured `RateRequestPayload`. Malformed model output fail-safes to `{unknown, 0}`. Zod at the boundary; the model's self-reported confidence is never trusted.
- **Resolve (Concierge) — identity is keyed off verifiable facts, never confidence alone.** Ties inbound to Party + Shipment using the **authenticated envelope sender-domain match as the primary key** (REQ-172); the model's resolution confidence is only a *secondary* filter that can *withhold* an auto-tie, never *authorize* one. A wrong tie merges two parties' freight, and any cross-party read is a build failure (REQ-025) — so a "90% confident" tie on unverified signal is forbidden. When no verifiable sender-identity anchor exists, the inbound drops to a human resolution queue (or a clarifying chat turn), never an auto-tie. A mis-tie discovered later is corrected append-only by a new resolution event that re-points the shipment; the mis-tied party's data is never rendered under the wrong lens in the interim because the lens is recomputed from the *current* tie on every read.
- **Auto-build (Concierge) — v2 delta.** Today the build is a quote-stage self-reference that never captures a consignee address. v2 captures *structured origin/dest* via the injected `GeocoderPort` so scheduling and accessorial detection become possible. **Fail-closed:** an address the geocoder cannot resolve to a rooftop does not silently become a bare ZIP — it drops to `queued{unknown_address}`.
- **Proactive accessorial scan (Auditor — NEW agent).** This is the owner's "likely accessorials flagged and proactively brought to the client." Today the system only echoes accessorials the client literally typed — it *detects nothing*. The Auditor (injected `AccessorialClassifierPort`: Deterministic rule table over the resolved address / USPS RDI / landuse tag / place-category; NotConfigured; live reverse-geocode adapter) proposes `{code, reason, confidence, added_cents}` — e.g. *residential* because rooftop landuse = residential and RDI = Y. **The proposal is never silently priced.** It surfaces as a client confirm ("This looks residential with no dock — add liftgate (+$75) and residential (+$45)? [Confirm] [Not residential]"). Only an explicit client co-sign (`agent.acted{subtype:accessorial_confirm}`) moves it into the priced request. A rejection is recorded so the tenant sees the false-positive. Target: **>70% of applicable accessorials caught before the client mentions them; the client never learns the word "accessorial."**
- **Schedule (Scheduler — NEW agent).** Today "Scheduler" is only the `assertAppointment` capacity gate; nothing proposes windows. The new agent reads `facilities` hours/capacity and the honest `transit_matrix`, proposes concrete pickup/delivery windows, and writes through the *same* gated DO. **It emits both kinds it is meant to: `pickup.scheduled` for the origin pickup window and `appointment.set` for the delivery appointment** — resolving the dead-kind problem (`pickup.scheduled` had zero emitters and, un-reconciled, would remain dead weight against the 35-kind freeze). The `ux_legs_slot` UNIQUE index keeps double-book impossible. Proposes only inside open hours with lead-time satisfied; ambiguity surfaces options, never an auto-claim.
- **Price (Rater — pure, unchanged).** `priceShipment` over the confirmed accessorial set, over frozen inputs.
- **Confirm + seamless price adjustment (NEW loop, with an ordering gate).** The owner's "book, with seamless price adjustment." An accessorial confirm appends a **new** `quote.priced` referencing the prior via `refs` — an append-only correction, exactly like `invoice.corrected`. The client sees a **delta**: "Rate updated: $420 → $540 (liftgate + residential). [Confirm & book]." Floor-clean + anomaly gates re-run on every re-price. **The ordering is enforced, not assumed:** a shipment **cannot transition to `quote.accepted` while any `accessorial_unconfirmed` proposal is open** — the accept button is server-gated on an empty open-proposal set. This closes the race the critique found: an async client tap can no longer land *after* accept and silently re-price a booked load. A genuine scope change discovered *after* accept is a **new quote requiring a fresh accept**, never a silent in-place re-price. **Billing reads the terminal node of the `quote.priced` refs chain** (latest-by-refs) as the billable amount — an amended shipment bills the *amended* total, and a fixture asserts exactly that (§6, REQ-225a).
- **Book (Booking agent — unchanged).** `booking.created` → credit gate (REQ-042) + evidence-recipient gate (REQ-182) → materializes shipment + skeleton legs, fed the corrected consignee/bill_to from the build step.

**The exception ladder.** v2 extends the existing `queued` enum (`below_floor | not_corroborated | unknown_price | low_resolution`) with `unknown_address` and `accessorial_unconfirmed`. Each queues a draft a human sends in one click — never a silent drop. **The client-facing surface never shows "error"; it shows "an agent is confirming your quote."**

### 3.2 Conversational pricing setup — the Onboarder

The owner's mandate: *the AI figures out THROUGH CONVERSATION how pricing is done for each party that signs up.* The pure factories already exist (`brokerageTemplate`, `assetTemplate`) — but **nothing conversationally elicits their parameters.** The Onboarder is a conversational agent (`PricingInterviewPort`: Deterministic / NotConfigured / Claude) whose sole job is to fill a typed `PricingModel` and materialize a `rate_config` bundle via the existing pure factories. **The LLM conducts the interview; the pure factory (in `packages/rater`) emits every rate — the model never authors a number** (REQ-024 doctrine).

| Party type | Pricing model | Factory | The interview elicits |
|---|---|---|---|
| **Broker** | market + margin | `brokerageTemplate` (exists) | "A market rate plus a margin? Typical margin %? Lane floors?" → `marketRateCentsPerCwt`, `marginBps`, `minChargeCents`, `fscPctBps` |
| **Asset carrier** | zip-zone tariff | `assetTemplate` → guided builder / Migrator import | "Upload your tariff, or let's build a ZIP-zone grid." SHUDDL fabricates nothing |
| **LTL carrier** | tariff + class adapter | `assetTemplate` + `ClassAdapter` (edge-only) | "Rate by class? Density breaks?" → `class_to_density_pcf` as an *adapter*, never the engine foundation |
| **Shipper** | cost-plus (they buy) | **NEW `shipperTemplate`** | "What do you pay per shipment today? Negotiated lane rates?" → seeds a *reference cost* to show savings |

**The interview → capture → validate → confirm loop:**

1. **Classify** the archetype from signup metadata or one opening question.
2. **Elicit** the *minimum* factory params, one question at a time, with industry-deep defaults ("most regional brokers run 15–18% — sound right?"). Each answer is validated at the boundary by the same `assert*` guards the factory enforces — a nonsense margin is rejected *in the conversation*.
3. **Capture** filled params straight into the pure factory → a schema-valid bundle, JSON-serialized into `rate_config.payload`.
4. **Validate in two tiers — and do not oversell tier one.** A captured model is confirmed in two stages:
   - **Smoke test (in-conversation):** the party supplies 3 recent historical quotes; they must replay through the fresh config within ±2%. This is a **fast sanity check that the archetype and headline params aren't grossly wrong** — three lanes cannot validate five hundred, and the design says so plainly. A divergence surfaces the implied param ("your number implies ~16.5% margin, not 15% — update?") and is corrected before go-live.
   - **Real validation (hand-off to the Migrator):** the Onboarder hands the confirmed draft to the standard **Migrator full historical-export ±2% aggregate replay** — the same fixtures discipline that gates every migration. **The tariff is not "validated" until the full-export replay is green;** the 3-quote smoke test gates only whether the conversation may proceed, never whether the config goes live. For a shipper, the aggregate replay of stated historical *spend* is the savings proof.
5. **Confirm + persist** — stamp `parties.pricing_model` (JSON on the party row, like `credit_status`) and write the `rate_config`. **Until confirmed, `/v1/rate` returns UNKNOWN `no_tariff`** — the honest cold-start default. Publication is **CONFIRM-GATED and re-based** (REQ-130): a drafted tariff is inert until `approved_by` is set by an authorized principal. No agent self-publishes a live sell tariff.

**Rendered as terminal-gallery chat**, not a settings form: `--ink-dark` ground, Display section headers ("HOW YOU PRICE"), agent questions as mono lines, no chat bubbles or typing-dots (use the sanctioned ⌘K typewriter caret). Each extracted rule becomes a **tappable confirm chip** the human corrects, with a teal convergence fill toward "PRICING UNDERSTOOD." The conversation is a form-elimination device.

### 3.3 Backhaul detection & revenue optimization (outreach deferred to v2.5)

The owner's signature behavior: *if the OS notices we run backhauls empty, it should automatically use Apollo + Mapbox to identify shippers at the origin/destination and reach out with aggressive dynamic pricing to fill the lane.* v2 builds everything up to and excluding the cold send; the send engine is v2.5 (see the deferral rationale in §2 and the phasing in §10). The four stages, and where each lives:

**Detect (v2 — per-tenant cron, structured like `sla-sweep.ts`).** Reads committed `delivery.evidenced` / `pod.signed` events, cross-references live `positions` and `facilities` geo. A truck running home empty or returning underfilled is the target. **The detection is an `agent.acted{subtype:backhaul_detected}` event on the originating shipment's stream** — deterministic id from the delivery event id, `NOT EXISTS` self-clearing guard so each empty lane flags exactly once. **The "Backhaul Board" is a VIEW, not a table.** Detection has standalone value even with outreach dark: it drives **co-load** proposals (§3.6) and repositioning insight.

**Price — the floor interaction (the load-bearing decision, v2).** "Aggressive" is made safe by pricing the backhaul *add* against a **marginal cost basis**, not by disabling floors. The truck's deadhead is sunk; the marginal cost of added freight is detour fuel + handling. `computeFloors` **does not change** — it is fed the marginal basis, and **the marginal detour cost is snapshotted into the co-signed request** so the priced quote stays a pure function of frozen inputs (the replayability rule from §1):

```
Deadhead return: 300 mi committed (sunk).
Backhaul add: 40-mi detour, 12,000 lb, 1 stop.
Marginal basis = detour fuel + handling = $140 (14,000¢)   ← snapshotted into the request
computeFloors(14000, floorsConfig): contribution $84 · full $126 · target $154
Aggressive sell offered: $135  → below target, above contribution
  → evaluateApproval ⇒ SINGLE ops approval (not a bypass)
  → detectAnomaly($135, 12000 lb) = null (nowhere near the $2,000/lb cap) ✅
```

The margin looks "impossible" only against fully-allocated cost; against the truthful marginal basis it clears contribution at a rational ops approval. A sell below marginal *contribution* (a real cash loss) correctly trips dual/finance approval. Law 5 is honored verbatim: the backhaul is its own **executing share**, never judged against the tour gross. The anomaly net stays on; backhaul pricing routes through the identical `/rate` gate path (REQ-030 — no side door). **No new `rate_config` kind.**

**Prospect + Outreach — the entire external-facing engine ships in v2.5, gated at *collection*, not send.** The critique correctly identified that gating a cold-outreach compliance boundary at *send* is the wrong boundary and that the shared sending domain breaks per-tenant suppression. The v2.5 design therefore specifies, as build-time invariants of the outreach engine:

- **Jurisdiction fail-closed at the prospect-ingestion boundary — before anything is written to any cache.** Caching or processing an EU/CA data subject's personal data is itself regulated processing regardless of whether a send ever occurs. So **no EU/CA data subject is ever written to the R2 prospect cache in the first place.** The filter suppresses on **ANY** EU/CA signal (contact geo, company HQ country, email TLD, phone country code) **and on UNKNOWN jurisdiction** — the only ingest path is a *positively confirmed US* data subject. Company-country filtering alone is insufficient (an EU-resident salesperson at a US company is protected), so the predicate is data-subject-level.
- **Suppression at sending-domain / control-plane scope, not per-tenant.** CAN-SPAM opt-outs must be honored across *all* mail from the sending identity for ≥30 days; the moment many senders share one `hello.<domain>`, per-tenant suppression would let a recipient who opted out of one sender still receive another. Suppression lives in the control plane keyed to the sending domain (or every sender gets its own verified domain), checked fail-closed pre-send.
- **A graduated per-day volume governor, independent of the CONFIRM.** "Domain warm" is not a binary flag. `OutreachSender` enforces a per-day send-cap *schedule* (the seed-ramp curve) and **fails closed above the day's cap** — a single on/off CONFIRM cannot torch reputation on day one.
- **The Apollo CI fixture must be wholly synthetic and denylist-scanned, as a required DoD.** The deterministic Apollo fixture is a committed repo artifact; seeded from real Apollo output it would contain real company/person names — a REQ-167 identity-leak violation *in the tree*. The synthetic-fixture assertion + denylist scan is a merge-gating DoD on the outreach REQ rows.
- **Separate warmed subdomain, CAN-SPAM baked into the Zod render, prospect→party only on verified inbound reply, outreach is a projection (`messages`, not an event), jurisdiction CONFIRM (owner = counsel)** — all as previously specified, now all v2.5.

**Delivery-timeline analytics (v2, "why are timelines long").** A sweep compares actual transit against the honest `transit_matrix` standard and attributes cause from existing events: **dwell** (`stop.arrived`→`stop.departed`), **appointment wait** (`appointment.set` window vs. `stop.arrived`), **interline handoff** (`custody.transferred` gap), **HOS** (`position.updated` gap, truck stationary). A lane exceeding its standard beyond a `tenants.policy` threshold raises an `anomalies` row (`rule=lane_transit_degraded`) on Command's existing dwell/lane-P&L KPI strip. No new kind, no new table, no new surface.

### 3.4 Driver map + POD-before-address gate

Three marquee capabilities are each half-built: the driver app has a strong gated capture flow but **no map**; the positions pipe has both ends built but **no client geolocation loop and no *driver-device* enrollment**; and the POD-before-next-address gate **does not exist in any form** (`DaySheet.tsx` prints every stop's address on first paint).

**The driver map.** Mount the *existing* `MapCanvas` (`useFleet` already ships a `driver` lens) — do not fork it. It renders the driver's own truck (one chevron), the day's stops as sequenced `at_rest` leaves (completed dimmed, current lit, gated-ahead drawn at coarsened block-level centroids), and the single teal current-leg line. **The A2 dark-ground inversion:** add `greigeStyleNight()` to `packages/map/src/style.ts` — the same grammar inverted, the *same five tokens*, entity layers unchanged. **Offline tiles:** on "Start day" (online, at the yard), a service-worker prefetch walks the day's routed corridor and caches PMTiles byte-ranges within ~2 km. A cache miss offline draws the token ground with no vector detail rather than erroring (the honest-instrument rule).

**The POD-before-next-address gate — the centerpiece.** *"Drivers are restricted from seeing the full address of the next stop until they upload the POD from the previous stop (routed/mapped correctly, but gated)."*

This is a **read gate, and SHUDDL has never had one** — every existing gate refuses to *append*; this refuses to *reveal*. It lives at **the manifest endpoint, server-side — never a client `if`** over a fully-provisioned `stops.ts`. A stop's location splits into three tiers:

| Tier | Content | Revealed |
|---|---|---|
| **Corridor** | routed polyline + block-level centroid (~1 km) | **Always** — the truck is never "lost" |
| **Precise** | exact street address, unit/dock/door, gate code | Only for the current active stop, and for stop N+1 once stop N's POD is committed |
| **Contact** | receiver name, phone, appointment notes | Same trigger as Precise |

**The reveal trigger, the airplane-mode tension, and an honest statement of offline strictness.** REQ-061 mandates a full stop cycle in airplane mode; strict "server receipt of upload" would strand a driver in a dead-zone dock. The trigger is therefore the **local co-signed terminal capture** (`GatedFlow.completeTerminal()` produces a hash-at-capture, co-signed, durably-queued `delivery.evidenced`). **The critique is right that offline reveal is irreversible, and the design states the limit honestly rather than overselling it:**

- **Offline lookahead is capped at exactly one stop, and only released by a capture that passes *local* fence + hash checks.** Completing the current terminal capture releases the *next* stop's decryption key in driver-core, behind a monotonic completed-stops counter — but only if the local GPS-inside-geofence and photo-hash-present checks pass at capture time. A capture that fails those local checks does not release the next key.
- **The gate is strict online and best-effort-plus-audit offline, stated as such.** If a locally-released capture later fails *server* re-verification on sync (hash mismatch, GPS spoof), the driver may already have driven to N+1 — you cannot un-reveal bytes already on the device. So the server re-verification is defense-in-depth and an audit trail, **not** a second gate that can retract a reveal. Stops N+2…end ship with `precise:null` — their bytes are **never on the device** offline, so the blast radius of an offline compromise is exactly one stop. The zero-trust HKDF forward-chain that would close even the rooted-phone case is explicitly v3.

**Server enforcement.** A new `GET /v1/manifest` (driver-role, tenant-off-JWT) projects assigned stops and runs `revealPrecise(stop_i)` — "is stop_{i-1}'s terminal event on the stream, or is stop_i the first-incomplete?" If false → `precise:null, reveal_gated:true`. The predicate is **factored into `gate-context.ts`** exactly as REQ-190's predicate was, so the route and any MCP driver verb cannot drift. New tenant-scoped read → new `isolation.test.ts` case. **No new event kind, no new table.**

**The skip path — a driver cannot self-advance the reveal pointer.** The critique correctly found that a driver-authored skip note would be a one-tap bypass of the entire gate ("couldn't deliver — next address please"). **A skip that advances the reveal pointer requires server-side dispatcher co-sign.** The driver may *raise* an `exception.raised{subtype:skip_requested}` with a reason, but that event alone does **not** release the next stop's precise tier; a dispatcher's co-signed approval does. A per-stop, logged, server-side `reveal.override` (an ops action appending a normal note, not a new kind) is the same segregation-of-duties path; ops can never reveal the whole day.

### 3.5 Live tracking → Command board

`POST /v1/positions` is exemplary and finished (full REQ-190 predicate through `gate-context.ts`); `GET /v1/board` joins latest position per shipment and drops unpositioned shipments. **The gap is entirely the client source and driver-device enrollment.**

- **The geolocation loop (`packages/driver-core/src/position-loop.ts`, new).** Reads `geolocation.watchPosition`, throttles to 30s while moving, converts to integer-microdegree `PositionInput`, and enqueues to the **same `OfflineQueue`** the capture flow uses. Battery budget (<5%/day, REQ-070): **stationary suppression** (5-min cadence when parked — the single biggest win), **batched flush**, `enableHighAccuracy` **only inside a geofence**. Foreground-only in v2 (true background is v3 native-shell).
- **The blocking gap, stated accurately.** `provision.ts` *does* write `device_keys` (as `'[]'`) for the admin user — so the column is not "never written." **The real gap is that no *driver device* is ever enrolled into `users.device_keys[]`; there is no driver-device enroll path**, so the first real position a real driver POSTs 403s on `deviceOwnedBy`. New `POST /v1/devices/enroll` binds the PWA's P-256 public JWK at first launch (part of the REQ-164 magic-link install). First-run consent (REQ-166) and enrollment happen in the *same* step.
- **First-run + route-aware consent (not a mid-drive modal).** `SESSION_CONSENT` is hardcoded today; the screen writes the `.strict()` `ConsentAck` as a `document.attached` *before* the loop's first emit. **The critique is right that a modal on crossing a state line at speed is a safety hazard and a coverage hole.** So consent is **pre-acquired at Start-day for every operating state the day's routed corridor already implies** (the corridor names the states). Only a genuinely *off-route* state falls back to a prompt — and that fallback **queues positions and consents the state on next safe stop, never modal-blocks the moving driver** (positions are buffered locally, not dropped, and flushed once consent is acknowledged). This also depends on fixing the 5-box `jurisdiction.ts` stub (§5.1) so states outside CA/OR/WA/TX/NY don't fail closed.
- **Honest ETA without a router.** `positions` carries `speed_cms`. A cheap, truthful ETA = haversine(latest position → current-stop centroid) ÷ rolling-average speed, computed server-side in the board read — no external call. It arms the **appointment-window-vs-ETA at-risk check** in `sla-sweep.ts`, finally firing acceptance demo #5 (the exception pulse dimming the map) off **real driver telemetry**. A real corridor router (Mapbox Directions, injected-port) is a v2.5 upgrade.
- **Live fan-out.** Positions landing in D1 notify the live-board Durable Object, which pushes scoped fleet frames to Command over WebSocket via the existing `useFleet` seam — replacing the `GET /v1/board` poll.

### 3.6 Dispatch-proposal + co-load decision support — closing the highest-volume step

Assigning loads to trucks is the highest-frequency daily action for a carrier running all its freight. Leaving it a fully manual Command board falsifies the thesis exactly where volume is highest. v2 therefore ships a **dispatch-proposal agent**:

- **Propose, human commits.** The agent ranks candidate trucks for an unassigned load by proximity (from live `positions` + `MapboxRoutingPort.matrix()`), HOS headroom (`position.updated` gaps), and capacity fit, and surfaces a **best-truck proposal** as the unified Proposal primitive (§7) — headline, one-line rationale, cited evidence, a single blessed `dispatch.assign` verb, confidence. **The dispatcher one-taps commit.** `dispatch.assigned` stays a human, gated, physical-custody decision — the agent never auto-commits. This is the co-load primitive applied to *normal* assignment, and it is what makes "the human's job collapses to one-tap confirmations" true at the volume that matters.
- **Co-load support (same geometry).** Using `MapboxRoutingPort.matrix()`, the agent finds pending pickups within a detour envelope of an assigned route and proposes co-loads at a marginal price (snapshotted into the request, §3.3). Surfaced as `agent.acted{subtype:coload_proposed}` + a Command tile, cite-or-abstain like the Copilot.

Auto-dispatch — autonomous commit of custody — is never in v2 scope; only the *proposal* is.

---

## 4. The Solo-Rep Individual Product (specified in full, entirely v2.5)

The critique is right on two counts that reshape this section: (a) the v2 "seed" is code no v2 user exercises — tenant-0 has a `rate_config`, so it never touches `MarketRatePort` — and per doctrine that means **it does not belong in v2 at all**; and (b) the wedge as first drafted was adoption-clever but compliance- and retention-naive. **The entire solo-rep product, including every line of `MarketRatePort` and per-seat evidence-identity plumbing, ships in v2.5** (alongside the warm sending domain it depends on). It is specified here so the phasing and the design are on record, not because any of it is v2 code.

### The ICP, precisely

**PRIMARY — "The Customer Rep":** the individual account-manager / customer-sales rep inside a large brokerage or asset carrier who owns a book of shipper accounts, lives in Outlook/Gmail + the company TMS + a load board, judged on **first-response latency, quote volume, win rate, and "no surprises" reliability.**

**SECONDARY — "The Solo Broker"** (1–3 person independent under an MC-lease): functionally identical; single-seat → Pro *is* company-wide adoption.

**Explicitly NOT this product:** the carrier-sales rep (needs Apollo/DAT capacity sourcing — v3) and owner-operators (Spark's R4 target).

### The wedge — "SHUDDL Rep," built on data the rep is authorized to originate

The critique correctly flags that forwarding a shipper's RFQ (shipper identity, lane, rate) to a third party is exactly what brokerage data policies and employment agreements prohibit — the behavior that gets a product IT-banned company-wide. **The wedge is therefore built on the rep's own authorized outbound work, not on exfiltrating the employer's inbound customer data:**

1. **Draft a compliant reply in seconds — everything but the number (Concierge).** The value is **speed of a correct, on-brand reply**, not a magic price. The rep pastes or forwards the request they are *authorized to originate a quote for*; the ToS puts that authorization burden explicitly on the rep. Concierge drafts the clean, structured reply under the rep's signature and **leaves the price for the rep to drop in** — because a rep's employer already has negotiated contract lane rates the rep must honor, and a generic benchmark systematically diverges from them. Optionally the rep runs a *mini-onboarder* over their *own* rate basis (§3.2) so their real numbers drive the draft. `MarketRatePort` provides a *reference benchmark shown alongside*, never sold as "their quote." "No price on air" holds — missing weight/dims drafts the clarifying question, never a number.
2. **Kill the check-call (Copilot).** The grounded read-only Copilot becomes "ask my loads anything" — every answer cited to a real ledger event, ungroundable → abstains. Plus one-tap "send update to customer" drafts on milestone hits. Attacks the rep's two hardest metrics: response latency and reliability.
3. **The hero artifact (Biller, REQ-129).** On delivery the **signed-POD evidence email fires under the rep's name** — the single most impressive thing a freight rep can put in a shipper's inbox, a thing *no incumbent sends*. **This artifact IS the viral engine.**

### Freemium + viral model — moat and vanity, correctly assigned

- **Free (the flywheel):** N quote-drafts/mo + read-only personal tracking + the public status page + **unlimited evidence emails** (the email *is* the marketing). Capped by usage-credits, never by feature.
- **The Reputation Scorecard is a *free* viral/vanity hook — not "the stickiest paid feature."** The critique is right: a portable PDF the rep pastes into a job interview *helps them leave*, and on-time %/margin derived from freight executed on the *employer's* authority is a data-ownership landmine to sell as "theirs." So the scorecard is free and framed as vanity/shareability, and its metrics are scoped to the rep's own drafting/response behavior rather than the employer's execution record wherever that line can be drawn.
- **The actual moat is inbox integration + accumulated quote history that resets on churn.** Paid ($20–50/mo) unlocks: inbox-connector OAuth (auto-draft vs. manual paste — the biggest convenience unlock), volume caps lifted, branded evidence emails, the reference benchmark on every quote. Stickiness comes from the accumulated, in-product quote/response history and the connected inbox — assets that evaporate on churn — not from an export designed to travel.
- **Seat-pricing law — resolved, not violated.** The ban is on a *company paying per-employee for the company's workspace*. The Rep SKU is **a person buying their own personal workspace on their own card** — the antithesis. Codified so the pricing-page audit (REQ-124) doesn't false-trip.

### Why it feeds the core without cannibalizing it

No driver/dispatch/Command surface — quote + track + evidence only (a reduced lens of `apps/portal`, *not* a fourth surface). The conversion moment is precisely when the rep wants SHUDDL to *execute* — which *is* the tenant upsell. Expansion: **individual → desk (3–5 reps, a Portal config) → tenant.** All of it v2.5+.

---

## 5. Architecture & Data-Model Deltas

### 5.1 The tent-pole: structured lane + geocoding

Today: `shipments` has no geo columns; the lane is a free-string `origin_zip`/`dest_zip`; **no forward geocoder exists**; reverse geo→state is a coarse 5-box stub; `facilities.lat_e6/lon_e6` exist but are NULL.

**The unified geo layer (build first, in the first v2 WP — on the injected commercial geocoder):**
- **Structured lane** — additive `origin_facility_id` / `dest_facility_id` FK columns on `shipments` (ALTER, additive — **not a new table**) resolving to `facilities`. The free-string ZIP path stays as the rater's deterministic input (REQ-024 keeps the rater pure); the *physical* lane is now addressable. Corridor geometry rides `legs.geo` (JSON, exists).
- **`GeocoderPort`** — an injected port in `packages/agents` (Deterministic / NotConfigured / live). **v2 ships on the injected Mapbox geocoder behind the interface** — data-only (lon/lat in, never a tile rendered), so REQ-075 self-hosted-basemap law is untouched. **Self-hosted Nominatim/Pelias is a fast-follow behind the identical interface**, not a milestone-gating infra build (the critique correctly flagged that standing up planet-scale self-hosted geocoding is a multi-week project and everything blocks on the tent-pole; we do not gate v2 on it).
- **`facilities.lat_e6/lon_e6` is the geocode cache** — a resolved address writes back to the facility row; a cache hit never re-hits the port; an unresolvable address fails to a coarse ZIP centroid, **never a guess**.
- **Reverse geo** — replace the 5-box `deriveOperatingState` stub with point-in-polygon against self-hosted Protomaps admin polygons (the documented WP-08 refinement), keeping the fail-closed `XX` sentinel. Unblocks the consent gate for tenant-0's full operating footprint.

**Purity guardrails — stated honestly.** Geocoded coordinates are **advisory projection data, never ledger truth** — they backfill domain tables (`facilities`, `legs.geo`), never the `events`/`positions` Merkle chain. Device GPS remains the only physical measurement. **The invariant is *not* "geo can never influence a sold price" — the Auditor uses geocoded landuse to *propose* a residential/liftgate accessorial, and an accepted proposal raises the sold total.** The honest invariant is: **geo may *propose* a priced accessorial, but the proposal is inert until an explicit client co-sign (`agent.acted{subtype:accessorial_confirm}`); the co-sign, not geo-independence, is the truth boundary that lets the number touch the quote.** Geo never *silently* alters a sold quote, and geo never alters the sold *transit window* (that stays `resolveTransitDays` config). Only lon/lat leave the tenant to the port — **never a party/consignee name** (REQ-167). The basemap stays self-hosted Protomaps (REQ-075).

### 5.2 The new agents (all injected-port, all in `packages/agents`, all LLM-quarantined)

| Agent | Phase | Port | Job | Emits |
|---|---|---|---|---|
| **ChatConcierge** | v2 | (reuses ClaudeParser) | DO chat envelope around parse/resolve/compose | `message.received/sent{channel:portal,surface:chat}` |
| **Auditor** | v2 | `AccessorialClassifierPort` | proactive accessorial detection → client-confirm proposals | `agent.acted{subtype:accessorial_confirm/reject}` |
| **Scheduler** | v2 | (reads facilities/transit) | proposes pickup + delivery windows through gated DO | `pickup.scheduled`, `appointment.set` |
| **Onboarder** | v2 | `PricingInterviewPort` | conversational capture → pure factory → smoke-test → Migrator replay | `rate_config` draft, `agent_runs` |
| **Backhaul-detect** | v2 | `MapboxRoutingPort` | detect empty/underfilled lanes; marginal-price basis | `agent.acted{subtype:backhaul_detected}`, `anomalies` |
| **Dispatch-propose** | v2 | `MapboxRoutingPort` | best-truck proposal; human commits `dispatch.assigned` | `agent.acted{subtype:dispatch_proposed}` |
| **Co-load support** | v2 | `MapboxRoutingPort` | co-load proposals at marginal price (advisory) | `agent.acted{subtype:coload_proposed}` |
| **Timeline analytics** | v2 | (reads events + transit_matrix) | attributes long-transit cause | `anomalies{rule=lane_transit_degraded}` |
| **Backhaul-outreach** (ApolloProspect + OutreachSender) | **v2.5** | `ApolloProspectPort` + `OutreachSender` | jurisdiction-at-collection prospecting; compliant cold send | `agent.acted{subtype:outreach_decided}`, `messages` |
| **MarketRate (solo)** | **v2.5** | `MarketRatePort` | reference benchmark for a no-`rate_config` seat (snapshotted) | (rater emits money over frozen input) |

**New pure factory:** `shipperTemplate` (cost-plus reference) in `packages/rater/src/tariff-templates.ts` (v2).

**Delivery structure.** Following the Translator precedent, the revenue lens ships as its own worker (`workers/agents` revenue-sweep) plus a thin `@shuddl/geo` port package. Every Mapbox/Apollo/R2 key + D1 read is tenant-scoped with `isolation.test` cases; the ports are lint-forbidden in `ledger`/`rater` (REQ-024 extended).

### 5.3 Budget compliance (the single most important property)

- **Event kinds: 0 new (35-freeze intact) — *and `agent.acted` carries a mandatory payload sub-type discriminant*.** The critique correctly identified that overloading `agent.acted` into a junk-drawer has a *security* consequence, not just an aesthetic one: redaction (I6), lens generalization, and the authority/parity overlays key off event *kind*, so a backhaul *prospect-decision* payload (counterparty data) and a client-facing accessorial proposal sharing one kind would make counterparty-visibility a payload-discriminant *bug* instead of a structural guarantee. **Fix, specified as an invariant:** `agent.acted.payload.subtype` is a required, closed Zod enum (`accessorial_confirm | accessorial_reject | backhaul_detected | dispatch_proposed | coload_proposed | outreach_decided | …`); **each subtype's lens/redaction behavior is proven in `redact.test.ts` and `isolation.test.ts` as its own case.** "One kind" ≠ "one visibility rule" — the discriminant + per-subtype redaction tests restore the structural guarantee. `pickup.scheduled` and `appointment.set` are both emitted (no dead kind). Portal chat = `messages.channel='portal'` with `payload.surface='chat'` — no CHECK change.
- **Tables: 0 new (spare intact).** Address → `facilities.lat_e6/lon_e6` (exist) + additive FK columns on `shipments` + `legs.geo`. `pricing_model` → JSON on the `parties` row. Accessorial proposals + chat turns → DO state / `agent_runs`. Backhaul Board, lane analytics, co-load candidates, dispatch candidates → **views**. Prospect cache + suppression → R2/KV / control-plane (v2.5). Solo-rep seat → existing control-plane tables (v2.5).
- **Schema amendments: exactly two.** (1) additive `shipments.origin_facility_id/dest_facility_id` column-ALTER; (2) `integrations` CHECK-enum (`+geocode`, and `+apollo` when v2.5 lands) with `integrations.config` JSON. **No `messages.channel` amendment** (the critique's verified third-amendment catch is resolved by reusing `portal` + payload discriminant rather than adding `portal_chat`).
- **Surfaces: 3 held.** The solo-rep board (v2.5) and the pricing-chat are reduced lenses/configs of existing apps.
- **Design law: 5 tokens, 2 fonts held — and the blessed-screenshot count increase is *declared*, not silent.** The night map adds a sixth blessed screenshot, which exceeds the "5 blessed screenshots" pin in CLAUDE.md rule 7. Rather than let that drift silently, **it ships as an explicit design-CI budget amendment (5 → 6), governed exactly as REQ-158 governs the pixel law** (REQ-271). The night style still inverts the *same five tokens*; the Proposal primitive and chat reuse existing grammar.

### 5.4 Replayability of externally-sourced numbers (the pure-rater rule, made concrete)

Two v2/v2.5 numbers originate outside the tenant: the **backhaul marginal-detour cost** (`MapboxRoutingPort`, v2) and the **solo-rep market benchmark** (`MarketRatePort`, v2.5). Both are external, floating inputs to a sold price. The rule (§1): each is **snapshotted into the co-signed rate request at quote time and thereafter frozen.** The rater consumes only the snapshot, never a live call — so the 504-quote monotonic sweep and the ±2% replay fixtures replay a booked quote to the same cent regardless of what the external API returns later. Quarantining the *port* in `packages/agents` is necessary but not sufficient; snapshotting the *number* is what preserves replayability. A test asserts a booked quote re-prices identically from its frozen snapshot with the port stubbed to a different value.

---

## 6. Reliability & Pitfalls — the v2-Must-Fix List

The ledger spine is trustworthy; the money leg (POD→invoice→evidence) is the strongest link, backstopped by reconciliation. **The chain's soft middle is everything between "quote accepted" and "driver at the door"** — scheduling, dispatch, accessorial intelligence, and geography are manual-only, stubbed, or absent.

**Ruthlessly prioritized:**

1. **Structured geography + geocoding (§5.1).** The tallest blocker. Ships on the commercial geocoder behind the port; self-hosted is a fast-follow.
2. **Dispatch-proposal agent (§3.6).** Without it the highest-volume daily action stays fully manual and the thesis is false where volume is highest. Ship the *proposal*; commit stays human.
3. **Scheduler agent** emitting *both* `pickup.scheduled` and `appointment.set` (no dead kind). Without it the chain stalls after booking.
4. **Booking reconciliation sweep.** `quote.accepted → booking` enqueue is best-effort with **no backstop sweep** — a lost trigger = an accepted quote that silently never books. Clone `recon-sweep.ts`.
5. **The money leg closes through the amendment loop — and it is *tested*, not asserted.** Two specific holes the critique found:
   - **Terminal-quote billing (REQ-225a).** Invoicing **resolves the `quote.priced` refs chain to its terminal node**; a fixture asserts an amended shipment bills the *amended* total, not the first `quote.priced`. Without this, every amended shipment under-bills "the strongest link."
   - **Re-price ordering gate (REQ-225b).** A shipment **cannot reach `quote.accepted` with an open `accessorial_unconfirmed` proposal**; a post-accept scope change is a new quote requiring re-accept. Enforced server-side, tested.
6. **Proactive accessorial agent** (depends on #1), with the co-sign-is-the-truth-boundary invariant (§5.1) and the `agent.acted` sub-type discriminant + per-subtype redaction tests (§5.3).
7. **Driver map + POD reveal gate** — server-side redaction; offline lookahead capped at one and released only by a *locally*-valid capture; **skip advances the pointer only on dispatcher co-sign** (§3.4).
8. **Wire a real (even synthetic-but-representative) legacy-mirror feed** so `authoritativeSource` gets `legacyValueAvailable=true` and parity converges module-by-module *before* any authority flip.
9. **Seed + geocode facilities** as part of the REQ-165 tenant-0 seed load.
10. **Verify (don't assume) the registered-but-unverified guarantees:** photo hash byte-verification and offline driver replay idempotency.
11. **Housekeeping that the budget claims depend on: dedupe the iCloud `" 2.ext"` copies before trusting any count/enum gate.** Grep surfaces in-tree duplicates (`packages/ledger/src/tsa/cms 2.ts`, `test/tsa-cms-fixtures 2.ts`); per project memory these corrupt file-count gates, and the entire "0 new kinds / 22-table" assurance rests on count/enum gates (`events.ts` pins `.length === 35`). **A gate corrupted by a duplicate file is not proof of budget compliance.** De-duplication is a merge-gating pre-req for trusting the budget CI (REQ-273), and a session-start check per the standing memory note.

**Open pitfall classes to hold green as agents grow:** re-rate-after-booking is blocked by REQ-191 (the amendment loop, §3.1, resolves this); the DO source-lock becomes load-bearing when the real mirror feed lands; the never-widen visibility floor relies on REQ-192 staying green as new `agent.acted` sub-type payloads appear — hence the per-subtype redaction tests.

**Closed and trustworthy (do not re-litigate):** tenant isolation (REQ-025), positions/GPS gate parity (REQ-190), credit-decision SoD (REQ-185), append-only INSERT guards (REQ-212), canonical hash byte-law, idempotency-caches-only-2xx (REQ-206), POD→invoice recon (REQ-169/199), invoice-void read-model consistency (REQ-209).

---

## 7. UX Standard & Acceptance Tests

**Surfacing the agentic workforce without a chatbot bolted onto everything.** SHUDDL's answer is the **unified agent-Proposal primitive**: every agent (Concierge, Auditor, Scheduler, **Dispatch-propose**, Biller, Backhaul, Co-load) emits one UI object — `{ headline, one-line rationale, EventRef evidence, a single blessed server verb, confidence }` — rendering identically to an `ApprovalsQueue` row. It feels like an **inbox of pre-done work**, each item a single decision. **Confidence gates *routing*, never the send itself** (REQ-171 discipline).

**Four queues, one grammar:** APPROVALS (built — now includes the day's dispatch proposals), EXCEPTIONS (built — v2 adds resolve-by-proposal, the biggest Command UX debt), MONEY (built), and **OPPORTUNITIES (new)** — backhaul-detection + co-load proposals (outreach drafts join here in v2.5). Chat is allowed only where the interaction is genuinely a dialogue (onboarding pricing, client confirmation); everywhere else agents propose into queues.

**The five genesis demos remain the floor.** Five new award-winning acceptance tests, each a blessed screenshot + e2e assertion gating merges:

- **AT-1 · Residential caught before the client asks.** A prose quote to a single-family address returns a quote *with a liftgate proposal already surfaced*, priced only on co-sign — the client never typed "residential."
- **AT-2 · Zero-form book.** Stranger → booked from a single prose line, no field keyed on the happy path, in <3 min. The human touched only Confirm + Book.
- **AT-3 · Empty backhaul detected and priced.** A seeded recurring deadhead → the OPPORTUNITIES queue produces a marginal-priced, floor-verdicted opportunity with the marginal basis snapshotted; the empty leg renders as a hollow route. *(Outreach draft-and-send is an AT added in v2.5, not v2.)*
- **AT-4 · The address stays locked, and stays locked against a skip.** A driver cannot see stop N's street address until stop N-1's POD terminal-captures; **an API probe for the next address pre-POD returns redacted** (Gatekeeper parity); **a driver-authored skip does NOT reveal the next address** without dispatcher co-sign. On POD, the address resolves — zero extra taps.
- **AT-5 · Onboarding with no settings form.** A new carrier/broker/shipper completes pricing setup through conversation → a valid config pack, each rule a tappable confirm chip, **go-live gated on the Migrator full-export replay, not the 3-quote smoke test.**
- **AT-6 · Dispatch by one tap.** An unassigned load surfaces a best-truck proposal (proximity/HOS/capacity, cited); the dispatcher one-taps commit; `dispatch.assigned` is human-gated and never auto-committed.

---

## 8. New REQ Rows (proposed — append to `genesis/09` before building)

Highest live id is REQ-213; v2 rows start at **REQ-214**. Introduce one new status: **`CONFIRM-GATED`**. All rows fit the 35-kind freeze and 22-table budget except the noted additive column-ALTER, the CHECK-enum amendment, and the declared blessed-screenshot 5→6 design-CI amendment.

**A. Structured lane + geocoding (the tent-pole)**
- **REQ-214** BOOKING — Structured lane: additive `origin_facility_id`/`dest_facility_id` FK columns on `shipments`; free-string ZIP stays the rater input. *No new table.*
- **REQ-215** AGENTS — `GeocoderPort` (Det/NotConfigured/live); **v2 ships on injected Mapbox (data-only), self-hosted Nominatim/Pelias a fast-follow behind the same interface**; address→(lat_e6,lon_e6); never in ledger/rater (REQ-024).
- **REQ-216** LEDGER — `facilities.lat_e6/lon_e6` is the geocode cache; cache hit never re-hits the port; unresolvable → coarse ZIP centroid, never a guess.
- **REQ-217** GATES — Geocode never *silently* alters a sold price and never alters the sold transit window (`resolveTransitDays`); geo may *propose* a priced accessorial whose truth boundary is the explicit client co-sign (`agent.acted{accessorial_confirm}`), not geo-independence. *(Restated to remove the internal contradiction with the Auditor.)*
- **REQ-218** SEC — Only lon/lat leave the tenant to the port, never a counterparty name (REQ-167).
- **REQ-219** MAP — Basemap stays self-hosted Protomaps (REQ-075); Mapbox geocode/route is data-only, never renders tiles/branding.
- **REQ-220** GATES — Replace the 5-box `deriveOperatingState` stub with point-in-polygon reverse-geocode; keep the `XX` fail-closed sentinel.

**B. AI-native quote→book loop**
- **REQ-221** AGENTS — Portal-chat Concierge on the SAME core; a low-confidence resolve asks ONE clarifying question; **auto-tie keys off the authenticated sender-domain match (REQ-172) as the primary key, confidence only as a secondary filter that may withhold but never authorize a tie**; auto-quote bounded by floor-clean + C1 corroboration. `message.received/sent{channel:portal,surface:chat}`. *(No `messages.channel` amendment.)*
- **REQ-222** BOOKING — Structured-lane auto-build via `GeocoderPort`; an unresolvable address fails CLOSED to `unknown_address`, never a bare-ZIP fallback.
- **REQ-223** AGENTS — Auditor accessorial-detection (`AccessorialClassifierPort`): proposes with `{reason,confidence,added_cents}`; a proposal that raises the sell is never auto-priced — client co-sign (`agent.acted{accessorial_confirm}`) required; rejection recorded.
- **REQ-224** AGENTS — Proactive Scheduler: reads facilities hours + transit_matrix; **emits `pickup.scheduled` for the pickup window AND `appointment.set` for delivery through the gated DO** (reconciles the previously dead `pickup.scheduled` kind); ambiguity surfaces options.
- **REQ-225** BOOKING — Seamless quote amendment: a scope change appends a NEW `quote.priced` via `refs`; shows a delta; floor + anomaly gates re-run on every re-price.
- **REQ-225a** BOOKING/MONEY — Invoicing resolves the `quote.priced` refs chain to its **terminal** node as the billable amount; fixture asserts an amended shipment bills the amended total.
- **REQ-225b** GATES/BOOKING — A shipment cannot transition to `quote.accepted` while any `accessorial_unconfirmed` proposal is open; a post-accept scope change is a NEW quote requiring re-accept, never a silent in-place re-price. Server-enforced, tested.
- **REQ-226** GATES — Agent booking path enforces identical gates (credit REQ-042/185 + evidence-recipient REQ-182), no bypass (REQ-030).
- **REQ-227** AGENTS — Model-distrust hardening: parsed weight/dims/addresses are Zod-validated claims; missing weight/dims → UNKNOWN, no sell (Law 4).
- **REQ-228** AGENTS — Booking reconciliation sweep: re-enqueue any `quote.accepted` with no `booking.created` older than N min (POD-recon parity).

**C. Conversational pricing setup**
- **REQ-229** AGENTS — Onboarder (`PricingInterviewPort`): classifies broker/asset/LTL/shipper and elicits only that archetype's factory params; the LLM interviews, the pure factory emits every rate (REQ-024).
- **REQ-230** BUILD — Per-archetype capture templates + new pure `shipperTemplate` (cost-plus reference); LTL class handled as an adapter, never the engine foundation.
- **REQ-231** AGENTS — Two-tier pricing validation: the 3-quote in-conversation replay is a **smoke test** that gates only conversational progress; **go-live is gated on the Migrator full historical-export ±2% aggregate replay** — the Onboarder hands off, never substitutes. Until confirmed, `/v1/rate` returns UNKNOWN `no_tariff`.
- **REQ-232** BOOKING — `parties.pricing_model` JSON capture (mirrors `credit_status`). *No new table.*
- **REQ-233** GATES — Pricing publication is **CONFIRM-GATED** and re-based (REQ-130); `approved_by` set by an authorized principal; no agent self-publishes a live sell tariff.

**D. Backhaul detection + revenue optimization (detection/pricing v2; outreach v2.5)**
- **REQ-234** AGENTS — `MapboxRoutingPort` (matrix/isochrone/directions) for detour cost + candidate geometry; injected trio, `fetchImpl` injected; deterministic fixture is the CI path; never imported by ledger/rater.
- **REQ-235** AGENTS — Backhaul-detection sweep reads committed `delivery.evidenced`/`positions`/`facilities`; emits `agent.acted{backhaul_detected}`, deterministic id, self-clearing; Backhaul Board is a VIEW. *(v2.)*
- **REQ-236** AGENTS/LAWS — Marginal-cost backhaul pricing HONORS FLOORS: `computeFloors` fed the marginal (detour-fuel+handling) basis **snapshotted into the co-signed request** (§5.4); approval matrix + anomaly net + interline executing-share (REQ-040) apply unchanged; below-marginal-contribution ⇒ dual approval; no new `rate_config` kind. *(v2.)*
- **REQ-237** AGENTS/SEC — **`ApolloProspectPort` (v2.5): jurisdiction fail-closed at the *prospect-ingestion* boundary — no EU/CA data subject (by contact geo, company country, email TLD, phone country code, OR unknown jurisdiction) is ever written to the R2 cache; only a positively-confirmed-US data subject ingests.** Results ephemeral, never ledger, never auto-written to `parties`; convert to a party only on a verified inbound reply (REQ-172).
- **REQ-238** COMMS/SEC — **Compliant `OutreachSender` (v2.5):** separate warmed subdomain (REQ-092/157); CAN-SPAM ID + one-click opt-out + physical address required Zod fields; **suppression at sending-domain/control-plane scope (not per-tenant), checked fail-closed pre-send**; **a graduated per-day volume-cap schedule enforced fail-closed, independent of the CONFIRM**; REQ-167 denylist extended to templates; **the Apollo CI fixture is asserted wholly synthetic + denylist-scanned as a required DoD.**
- **REQ-239** LEDGER — Outreach is a projection (v2.5): logged to `messages`(dir out, party_id NULL) + `agent_runs`; appends no event; the reach-out *decision* is `agent.acted{outreach_decided}`.
- **REQ-240** SEC/LEGAL — Outreach legal gate **CONFIRM-GATED** (v2.5): CAN-SPAM (US) target; CASL/GDPR/e-privacy suppressed at collection until counsel CONFIRM; owner = counsel.
- **REQ-241** COMMAND — OPPORTUNITIES queue / Backhaul Board (v2 for detection/co-load; outreach drafts added v2.5): empty lanes, marginal price + floor verdict; click → basis/events.
- **REQ-242** AGENTS/COMMAND — Delivery-timeline degradation detector (v2): actual vs. `transit_matrix`; attributes cause from existing events; raises `anomalies{rule=lane_transit_degraded}`. No new kind/table.
- **REQ-243** COMMAND/AGENTS — **Dispatch-proposal agent (v2):** best-truck by proximity/HOS/capacity as `agent.acted{dispatch_proposed}` + a Command tile; `dispatch.assigned` stays human and gated; auto-commit out of scope. Co-load support (`agent.acted{coload_proposed}`) shares the geometry.

**E. Driver map + POD gate + live tracking**
- **REQ-244** MAP/DRIVER — Driver PWA mounts `MapCanvas` in a night (A2 ink-ground) variant, driver lens; airplane-mode renders with no network.
- **REQ-245** MAP — `greigeStyleNight()` inverted basemap: same five tokens. *(Blessed-screenshot count increase declared in REQ-271.)*
- **REQ-246** MAP/DRIVER — Service-worker corridor tile prefetch on Start-day; PMTiles range-cache within 2 km; cache-miss degrades to token-ground, never errors.
- **REQ-247** GATES/DRIVER — POD-before-next-address reveal gate: `GET /v1/manifest` redacts `precise`/`contact` of forward stops until the prior stop's terminal event is committed; predicate factored in `gate-context.ts`, shared with MCP; new isolation test. *Projection redaction — no new kind/table.*
- **REQ-248** DRIVER — Offline lookahead capped at **exactly one** stop, released in driver-core only by a capture that passes **local** fence+hash checks behind a monotonic completed-stops counter; N+2 stays absent from the device; server re-verification is defense-in-depth/audit, **not a retractable second gate** (stated: strict online, best-effort-plus-audit offline).
- **REQ-249** GATES — Skip that advances the reveal pointer requires **server-side dispatcher co-sign**; a driver-authored `exception.raised{skip_requested}` alone never releases the next precise tier. Per-stop `reveal.override` logged, one stop at a time, never whole-day; SoD.
- **REQ-250** DRIVER/DATA — Stops carry structured `centroid` + `fence_radius_m` + corridor; populates `facilities.lat_e6/lon_e6` so `insideFence()` fires; geocode at booking time via `GeocoderPort`.
- **REQ-251** DRIVER — `position-loop.ts`: 30s-moving, 5-min stationary suppression, high-accuracy scoped to geofences, batched flush through `OfflineQueue`; <5%/day (REQ-070); survives airplane mode.
- **REQ-252** DRIVER/AUTH — `POST /v1/devices/enroll` binds the PWA's P-256 public JWK to `users.device_keys[]` at first launch (part of REQ-164). *(Justification corrected: `provision.ts` already writes `device_keys` for the admin; the real gap is that no **driver device** is ever enrolled, so a driver position 403s.)*
- **REQ-253** DRIVER/LEGAL — Route-aware consent: pre-consent every operating state the Start-day routed corridor implies, writing `ConsentAck` before the first GPS stamp; a genuinely off-route state **buffers positions locally and consents on next safe stop — never a modal that blocks a moving driver**; enforced in the airplane-mode soak.
- **REQ-254** MAP/AGENTS — Board ETA from `speed_cms` + haversine-to-centroid (server-side, no external router); appointment-vs-ETA at-risk in `sla-sweep.ts`.
- **REQ-255** MAP — Live-board DO fan-out over WebSocket via the `useFleet` seam (replaces the `GET /v1/board` poll).

**F. UX standard**
- **REQ-256** UX — Zero-form intake standard; the form is the correction worksheet. *DoD: AT-2.*
- **REQ-257** UX — Unified agent-Proposal primitive across all agents (incl. Dispatch-propose); a design-CI check asserts no bespoke agent chrome.
- **REQ-258** UX — Command-bar intent path: ⌘K NL → proposed blessed verb; the deterministic filter stays the discoverable floor; confidence never auto-executes.
- **REQ-259** UX — Exception resolve-by-proposal: exception rows carry one-tap fixes, not navigation.
- **REQ-260** UX — Award-winning acceptance suite AT-1…AT-6 as blessed screenshots + e2e gating merges.

**G. Solo-rep (ENTIRELY v2.5 — no v2 seed)**
- **REQ-261** AGENTS — `MarketRatePort` (**v2.5**, not a v2 seed): reference benchmark shown alongside a rep's own rate, **snapshotted into the co-signed request** if it ever participates in a sold price (§5.4); agent-side trio, never in `packages/rater`; missing dims → UNKNOWN + clarifying draft. Sold to reps as *speed of a compliant reply*, drafting everything-but-the-number; the rep supplies the honored contract rate.
- **REQ-262** PLG — SHUDDL Rep single-seat SKU (v2.5): `plan='rep'`, one-user workspace, NO driver/dispatch/Command surface; personal SKU explicitly NOT seat pricing; passes REQ-124.
- **REQ-262a** PLG/LEGAL — The rep wedge operates only on data the rep is authorized to originate (their own outbound quotes); ToS places the authorization burden on the rep explicitly; the product does not present forwarding the employer's inbound customer data as frictionless.
- **REQ-263** AGENTS — Per-seat evidence-email identity (**v2.5**): Biller `from_name`/signature/`referral_url` parameterized per seat and PINNED into the committed payload (REQ-178 class); per-rep REQ-129 code; redelivery does not 409-hold.
- **REQ-264** PLG — Per-rep referral attribution (v2.5): the REQ-129 link resolves a signup to the referring rep, event-sourced, no new table.
- **REQ-265** PLG — Reputation Scorecard (v2.5): personal on-time %/quote volume/response latency/margin as a **free vanity/viral artifact** (not the paid moat); metrics scoped to the rep's own drafting/response behavior wherever the employer-authority line requires.
- **REQ-266** LEDGER — SELF passport ownership (v2.5): keyed to the control-plane `users` identity; isolation suite gains a `plan='rep'` read-path case.
- **REQ-267** PLG — Rep-team lens (v3): shared desk board as a Portal config (not a new surface); rep→manager rollup is the product-qualified path to a tenant.

**H. Governance mechanics + housekeeping**
- **REQ-268** BUILD — `CONFIRM-GATED` as a first-class register status; a CI check blocks any code path implementing a CONFIRM-GATED REQ from going live while the CONFIRM is open.
- **REQ-269** BUILD — v2 milestone map references every REQ-214→273 row; traceability CI blocks orphans both directions before any v2 WP closes.
- **REQ-270** OVERLAY — Wire a live (even synthetic-but-representative) legacy-mirror feed so `authoritativeSource` receives `legacyValueAvailable=true` and per-module parity converges before any authority flip.
- **REQ-271** DESIGN-CI — Declared blessed-screenshot budget amendment (5 → 6) for the night map, governed as REQ-158 governs the pixel law; the added shot passes the same color/contrast/font/case/radius/shadow/motion audits.
- **REQ-272** LEDGER/SEC — `agent.acted.payload.subtype` is a required closed Zod enum; each subtype's lens/redaction behavior is a distinct proven case in `redact.test.ts` and `isolation.test.ts` (kind-level redaction is insufficient once one kind carries both client-facing and counterparty-facing payloads).
- **REQ-273** BUILD — De-duplicate iCloud `" 2.ext"` copies (e.g. `packages/ledger/src/tsa/cms 2.ts`) as a merge-gating pre-req and session-start check; a count/enum budget gate corrupted by a duplicate file is not proof of budget compliance.

**Budget summary:** 0 new event kinds (`agent.acted` sub-typed, REQ-272) · 0 new tables · 1 additive `shipments` column-ALTER (REQ-214) · 1 `integrations` CHECK-enum amendment (`+geocode`; `+apollo` at v2.5) · 1 **declared** design-CI blessed-screenshot amendment (5→6, REQ-271). **No `messages.channel` amendment** (portal chat reuses `portal` + payload discriminant). **CONFIRM-gated rows:** REQ-233, REQ-240 (REQ-237/238/262a as scope/identity/legal guards). Every LLM/external port lives in `packages/agents`; every externally-sourced sold-price input is snapshotted (REQ-236, REQ-261 / §5.4).

---

## 9. Skills to Generate (`.claude/skills/`)

Thirteen skills exist. v2 adds eight (five invariant-enforcement + three workflow); the v2.5 outreach skill is authored now, enforced when the engine ships.

**Invariant-enforcement:**
1. **`geocode-adapter-port`** — forward/reverse geocode behind an injected port; cache to `facilities.lat_e6/lon_e6`; UNKNOWN not a guess; **geo may only *propose* a priced accessorial gated on client co-sign, never silently alter a price**; absent from `ledger`/`rater`. Sibling to `gate-external-routing-server-side`.
2. **`pod-before-address-gate`** — next-stop full address is a server-side lens redaction withheld until the predecessor terminal capture; **offline lookahead capped at one and released only by a locally-valid capture; a skip advances the pointer only on dispatcher co-sign**; route allowed, exact string gated. Extends `fail-closed-on-inherited-visibility` + `enforce-server-side-gate-parity`.
3. **`snapshot-external-price-inputs`** — any externally-sourced number that participates in a sold price (marginal-detour cost, market benchmark) is snapshotted into the co-signed request and frozen, so the rater stays replayable; quarantining the port is necessary but not sufficient. Covers REQ-236/261, the $222k/35-lb guard on backhaul quotes, and the executing-share interline floor (REQ-040).
4. **`compliant-cold-outreach-gate`** (authored now, enforced v2.5) — **jurisdiction fail-closed at *ingestion*, no EU/CA/unknown data subject ever cached**; suppression at sending-domain/control-plane scope; **graduated per-day volume governor fail-closed, independent of the CONFIRM**; CAN-SPAM ID/opt-out/physical-address as required Zod fields; outreach subdomain ≠ transactional; **the Apollo CI fixture asserted wholly synthetic + denylist-scanned**; idempotent send key.
5. **`price-config-rebase-before-publish`** — a `rate_config` draft is inert until re-based (REQ-130) and `approved_by` is set; **go-live gated on the Migrator full-export replay, not the 3-quote smoke test**; corrections are new versions (I5); monotonic sweep + 48 engine tests green before live.

**Workflow:**
6. **`conversational-pricing-capture`** — the per-archetype dialogue that drafts `rate_config`; every captured number is unconfirmed until the **full-export** replay (Law 4/6); the 3-quote check is an explicit smoke test; logs to `agent_runs`. Composes with `harden-agent-against-model-trust`.
7. **`autonomous-quote-to-book-loop`** — the Concierge/Auditor/Scheduler/Dispatch chain, enforcing identical booking gates, the **accept-blocked-on-open-proposal ordering gate**, and **terminal-`quote.priced` billing resolution**. Composes with `make-agent-idempotent-and-adapter-ported`.
8. **`agent-acted-subtype-redaction`** — every `agent.acted` payload carries a closed sub-type enum, and each sub-type has its own lens/redaction case; a counterparty-bearing sub-type is never rendered under a client lens. Composes with `redact-counterparty-payloads-completely`.

Reuse across the new agents: `make-agent-idempotent-and-adapter-ported` (every new queue consumer, incl. dispatch-propose), `prove-tenant-isolation-read-paths` (every new key/read path), `harden-agent-against-model-trust` (geocode/parse/benchmark outputs never become truth), `keep-map-instrument-truthful` (driver map), `keep-readmodel-consistent-with-ledger` (Backhaul Board / board / **terminal-quote billing** projections), `share-lint-matchers-with-parity-tests` (suppression + identifier regexes; dedupe count-gate matchers).

---

## 10. Phased Roadmap & Sequencing

### v2 — Tenant-0 end-to-end (TMS-replacement core), no external-facing send stack

**WP order (the tent-pole first):**

1. **WP-A · Structured lane + geocoding** (REQ-214→220, REQ-273 dedupe pre-req) — *build first; everything blocks on it.* Ships the `GeocoderPort` **on the injected Mapbox geocoder** (self-hosted a fast-follow), the `facilities` geo cache, the additive `shipments` FK columns, and the point-in-polygon reverse-geocode. Seed + geocode tenant-0's facilities here. **Dedupe the `" 2.ext"` copies before trusting the budget gates.**
2. **WP-B · AI-native quote→book loop** (REQ-221→228, incl. REQ-225a/225b, REQ-272) — portal chat, verifiable-fact auto-tie, auto-build, Auditor with co-sign-truth-boundary + sub-type redaction, Scheduler emitting both `pickup.scheduled` and `appointment.set`, seamless amendment with the **accept-ordering gate** and **terminal-quote billing**, gate parity, model-distrust hardening, booking reconciliation sweep.
3. **WP-C · Conversational pricing setup** (REQ-229→233) — the Onboarder, per-archetype templates, **two-tier validation (smoke test → Migrator full-export replay)**; publication CONFIRM-gated.
4. **WP-D · Backhaul detection + revenue optimization + dispatch** (REQ-234→236, 241→243) — `MapboxRoutingPort`, detection sweep, marginal-cost floor pricing with **snapshotted basis**, **dispatch-proposal agent**, co-load support, timeline analytics. **No Apollo, no OutreachSender, no suppression, no warmup in v2** — detection/pricing/co-load/dispatch have standalone value; outreach has none until the domain is warm.
5. **WP-E · Driver map + POD gate + live tracking** (REQ-244→255, REQ-271) — night map (declared 6th screenshot), corridor prefetch, reveal gate with **one-stop offline cap + dispatcher-co-signed skip**, position loop, **driver-device enrollment**, **route-aware non-blocking consent**, honest ETA, live DO fan-out.
6. **WP-F · UX standard** (REQ-256→260) — zero-form intake, the Proposal primitive, command-bar intent, exception resolve-by-proposal, AT-1…AT-6.
7. **Cross-cutting** — the legacy-mirror feed (REQ-270) so parity converges before any authority flip; governance mechanics (REQ-268, REQ-269). **No solo-rep seed** (moved wholly to v2.5).

### v2.5 — after tenant-0 is live and the sending domain is warm

Build and turn on the **entire cold-outreach engine** — `ApolloProspectPort` with **jurisdiction-at-collection**, `OutreachSender` with **domain-scoped suppression + graduated volume governor**, the synthetic-fixture DoD — then flip the outreach CONFIRM (REQ-240). Build and ship the **entire public "SHUDDL Rep" solo product** (REQ-261→266): `MarketRatePort`, per-seat evidence identity, inbox OAuth, portable SELF passport, the free Reputation Scorecard, referral attribution. Auto-invite tenant-0's clients onto the shared ledger; Apollo cold-sourcing of missing client emails; fully-autonomous outreach auto-send behind its own CONFIRM.

### v3 — network + portability

Solo-rep team/desk lens + manager rollup (REQ-267); the carrier-sales-rep variant with Apollo/DAT lane sourcing; learned accessorial detection (the Auditor training on confirmed/rejected proposals); multi-party negotiated pricing; true multi-leg VRP tour optimization; a real-time corridor router for ETAs; **the zero-trust HKDF offline address chain that closes the rooted-phone reveal case**; background geolocation; deeper cross-tenant capacity matching via the Passport layer.

### v4 — platform expansion (each needs an owner-signed register amendment)

Anything on the permanent "Do not build" list — native GL/period close, driver-pay v1, report builder, a fourth surface, seat-based pricing, Direct-merchant/escrow-settle, voice recording beyond `call.transcribed`, SMC3/class as anything beyond an adapter; predictive backhaul.

---

### The through-line

Every AI-native flow in v2 collapses onto **one decision core** (parse → resolve → compose), **one config path** (interview → pure factory → smoke-test → full-export replay), and **one agent-surfacing primitive** (the Proposal into a ranked queue — now covering dispatch, the highest-volume step). We add channels, detectors, an onboarding interviewer, a dispatch proposer, a driver map, and a read gate — we do not add trust in the model, event kinds, tables (beyond one additive column), or a floating external number in a sold price (every one is snapshotted). **The model decides what to do; the pure, tested, append-only spine decides what is true — over frozen inputs, resolving the terminal quote, blocked from accepting while a proposal is open, and refusing to reveal the next address until the POD is real.** Close the geography gap, ship the agent workforce *including dispatch*, keep the highest-legal-risk send stack out of the core milestone until the domain is warm, and the interface stops being software the operator drives and becomes a workforce the operator approves.

**Open questions for the owner:** (1) confirm backhaul *outreach* (Apollo + sender + warmup) is correctly deferred wholesale to v2.5 and only *detection/pricing/co-load/dispatch* ship in v2; (2) confirm the entire solo-rep product — including `MarketRatePort` — moves to v2.5 (no v2 seed), accepting that tenant-0 never exercises it; (3) counsel sign-off scope for REQ-240 and the ingestion-boundary jurisdiction predicate (which positive-US signals are sufficient to *cache* a prospect at all); (4) the `tenants.policy` marginal-cost inputs (fuel $/mi, handling) that gate backhaul pricing; (5) confirm the declared design-CI 5→6 blessed-screenshot amendment (REQ-271) rather than folding night-mode into an existing shot; (6) confirm dispatcher-co-signed skip (REQ-249) as the reveal-pointer advance authority for AT-4.