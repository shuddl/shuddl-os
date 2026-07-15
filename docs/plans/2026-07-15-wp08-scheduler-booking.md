# WP-08 — Scheduler + Booking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (this session) or superpowers:executing-plans (parallel session) to implement this plan task-by-task. Each task is TDD: write the failing test, watch it fail, minimal code, watch it pass, commit.

**Goal:** A quote becomes a *booked, scheduled, dispatch-ready* shipment — `booking.created` fills in the real consignee/bill-to (closing the WP-07 self-reference), a booking is **blocked on a credit hold and on a missing consignee contact** (server-side gates), an appointment claims a dock slot such that **double-booking is atomically impossible**, dispatch is **blocked until docs + an appointment exist**, quotes show an **honest transit window**, and reschedules are new events — all through the existing sequencer DO + Gatekeeper, no new event kind, no new table.

**Architecture:** WP-08 is the Scheduler/Booking layer over the append-only ledger. It (1) *types* five existing loose kinds (`booking.created`, `appointment.set`, `pickup.scheduled`, `dispatch.assigned`, `credit.checked`), (2) adds three server-side transition gates in the same Gatekeeper the physical gates live in (credit-hold + consignee-contact on `booking.created`; docs+appointment on `dispatch.assigned`), (3) makes double-booking impossible via a **D1 partial-UNIQUE-index slot claim on the `legs` table** (SQLite serializes writes across the independent per-shipment DOs — the second claim's batch aborts), (4) fills the facilities capacity/hours model + a `transit_matrix` rate-config kind, and (5) adds a queue-triggered **Booking agent** (`quote.accepted` → gated `booking.created`) and the reschedule flow. Money/physics stay events; the money path is untouched.

**Tech Stack:** Cloudflare Workers + Hono · D1 per-tenant (SQLite STRICT) · Durable Objects (the existing `ShipmentSequencer` — appends + gates run inside its per-stream mutex) · Queues (the Booking agent trigger) · React 19 PWAs (the honest-window surface) · TypeScript strict, no `any` · Zod at every boundary · integer-cents/microdegree canonical law.

---

## Source-of-truth grounding
- **DoD (genesis/08 §03, WP-08 Scheduler):** "Facility hours/capacity model; pickup windows; confirmations + calendar artifacts. **Double-book impossible in test; reschedule flows emit events; consignee-contact gate (GA-6) enforced at booking.**"
- **REQ rows (genesis/09):** REQ-028 (scheduler: windows vs facility capacity + driver hours — double-book impossible test) · REQ-042 (booking blocked on credit hold per policy) · REQ-043 (dispatch blocked until docs+appointment) · REQ-047 (booking gate requires consignee email/SMS or a named opt-out) · REQ-052 (facility hours + dock capacity slots model) · REQ-059 (transit standards matrix zone×zone days → honest windows) · REQ-057 (division codes on shipments+money — already live, the party-correction touches it).
- **WP-07 assumption WP-08 MUST fulfill:** the Concierge quote-stage shipment self-references all three party FKs to the requester (`packages/agents/src/concierge/resolve.ts:165-177`); `booking.created`'s projection currently updates ONLY `status_cache.state` on conflict (`packages/ledger/src/projection/status-cache.ts:16`) — WP-08 must add the party-correction. Plus **REQ-177** (record the deterministic request) rides the ClaudeParser CONFIRM, noted not built here.

## Reuse (do NOT rebuild)
- **The Gatekeeper** (`packages/ledger/src/gates/transition-gates.ts`): pure gate `(prior, incoming, ctx) => void`, throws `GateError` (`GATE_BLOCKED:{required_evidence}` → 403) or `GateValidationError` (`VALIDATION_FAILED:{reason}` → 400); `overrideSatisfies(ctx?.override)` runs first (REQ-049). The DO calls gates in `#enforceTransitionGate` (`workers/api/src/do/sequencer.ts:388-448`) **inside the append mutex, before the batch write**, with **server-sourced context only** (`#deliveryFence` reads `legs.geo`; `#isInterline` reads legs). `GATED_KINDS` (`sequencer.ts:94-96`) + an exhaustive `switch` with `assertNever` — adding a gated kind without a case is a compile error.
- **The typing pattern** (`packages/contracts/src/comms.ts` header): swap a loose `JsonObject` for a strict Zod schema in BOTH the `LedgerEvent` union (`events.ts:294-328`) and `EventInput` (`events.ts:405-429`); the 35-kind catalog is unchanged (`EVENT_KINDS.length===35` pinned, `contracts/test/events.test.ts:5`). Regenerate the roundtrip snapshot AND `tools/seed/seed.hash` (`pnpm seed`) — see [[dep-env-fragility]] (a WP-07 miss).
- **The rate-config pattern** (`workers/api/src/rate-config.ts` + its byte-identical agents mirror + `rate-config-parity.test.ts`): `EFFECTIVE_BY_KIND` (newest `effective_ts <= now`, tie-broken by `version`) + per-kind Zod parse. `rate_config.kind` CHECK **already includes `'transit_matrix'`** (`0002_domain.sql:84-88`); the schema was deliberately left for WP-08 (`rating.ts:15-16`). The rater's `matchZone` (longest-prefix zip→zone, `packages/rater/src/engine.ts:15,42`) resolves both endpoints.
- **The status-cache projection** (`packages/ledger/src/projection/status-cache.ts`): `booking.created` is the shipment-row writer (`BOOKING_SQL:13-16`); `dispatch.assigned` sets `assigned_driver` from `actor.user`. Extend, don't replace.
- **The DO append surface** (`SeqStubLike`) + the agent pattern (`workers/agents/src/{biller,concierge}.ts`): deterministic ids, DO id-dedupe, `INSERT OR IGNORE`, queue trigger enqueue in the sequencer. The Booking agent mirrors this.
- **The gate test templates:** `workers/api/test/gates.test.ts` (real API path → 403/`GATE_BLOCKED` + `requiredEvidence` + **zero append** on block; override tests) and `packages/ledger/test/transition-gates.test.ts` (pure gate). `sequencer.test.ts:101-118` (the 100-concurrent-append mutex proof) is the double-book test template.

## Do NOT build (defer — recorded, not dropped)
Credit DECISION engine / bureau (REQ-037 vNEXT — WP-08 only enforces a *recorded* hold) · COD at delivery (REQ-054 vNEXT) · master-job consolidated invoicing (REQ-055 vNEXT) · guest-quote <60s stopwatch (REQ-051 WP-09) · phone/walk-in command-bar intake (REQ-150 WP-10) · pro-number ranges (REQ-058 WP-15) · hazmat (REQ-060 WP-14) · the inbound reply→`quote.accepted` webhook (WP-07 deferred inbound). REQ-177/176/178/179/180 stay as registered (ledger hardening / CONFIRM).

---

## The five load-bearing decisions (resolve the real ambiguity up front)

1. **Double-book is made impossible by a D1 partial-UNIQUE index on a slot claim, NOT by a gate check alone.** Two bookings for the same dock slot are two DIFFERENT shipment streams → two DIFFERENT DOs → their appends do NOT serialize against each other, so a "read occupancy then block" gate has a TOCTOU race under concurrency. The atomic guarantee is SQLite: D1 serializes writes, so a `UNIQUE(facility_id, appt_slot_key)` claim means the second concurrent claim's `db.batch` (which includes the projection UPDATE) hits the constraint and **the whole append aborts** — the double-book event never commits. A pure **capacity gate** (server-sourced occupancy in `#enforceTransitionGate`) gives the clean `GATE_BLOCKED` UX for the common (sequential) case; the unique index is the concurrency backstop that makes the DoD literally true.
2. **The slot claim lives on `legs` (ALTER ADD columns), NOT a new `appointments` table.** The 22-table budget has ONE spare (`tools/checks/invariants.ts:8`); a new table spends it and needs a written deletion. Appointments are naturally leg-scoped (a stop at a facility at a time), so `ALTER TABLE legs ADD facility_id / appt_slot_key` (the ONE sanctioned migration form — nullable add) + a partial unique index is both budget-clean and semantically right. `legs` is a mutable domain table (NOT append-only-guarded), so `appointment.set` may UPDATE it.
3. **Capacity N = N discrete capacity-1 slots.** `facilities.capacity_slots` enumerates bookable slots, each a `(door × time-window)` unit of capacity 1; an appointment claims exactly one. A window with N parallel docks is N slots. This keeps "not double-booked" = "the slot key is UNIQUE" — no atomic counting needed, and it matches "dock capacity slots" (REQ-052).
4. **`booking.created` is the party-correction point AND is credit/consignee-gated.** Its payload names the real `consignee_party_id` / `bill_to_party_id`; the status-cache projection's `ON CONFLICT` path is extended to write them (closing the WP-07 self-reference for the Concierge path; a direct booking still INSERTs). The gate reads the credit-hold state (projected from `credit.checked`) and the consignee's contacts (`parties.contacts`) as **server-sourced** context — a hold or a contactless consignee (with no named opt-out) blocks the booking (overridable per REQ-049, except where policy says otherwise).
5. **Acceptance is `quote.accepted` → a queue-triggered Booking agent → gated `booking.created`.** The Booking agent mirrors the Biller/Concierge (deterministic ids, DO dedupe, idempotent redelivery). The manual/ops path (command bar, WP-10) and the inbound reply→accept path (WP-07 inbound, deferred) both funnel through the SAME gated `booking.created` append, so the gates enforce on every path (REQ-030).

---

## Task 1: Type the booking/scheduler event payloads (no new kind)

**Files:** Create the domain module `packages/contracts/src/booking.ts` (mirrors `comms.ts`); Modify `packages/contracts/src/events.ts` (swap `JsonObject`→the new schemas in both unions); Test `packages/contracts/test/booking.test.ts`; regenerate `packages/ledger/test/__snapshots__/roundtrip.test.ts.snap` + `tools/seed/seed.hash`.

Type five kinds, `.strict()`, integer canonical law:
- `credit.checked` — `{ party_id, status: enum("clear","hold","review"), limit_cents?: SafeInt, decided_by?: string, ref?: string }`.
- `booking.created` — `{ quote_event_id, shipper_party_id, consignee_party_id, bill_to_party_id, division, mode?, service?, bill_terms?: enum("prepaid","collect","third_party") }` (the party-correction source; `quote_event_id` anchors the accepted quote).
- `appointment.set` — `{ leg_kind: enum("pickup","delivery"), facility_id, slot_key, window_start_ts: SafeInt, window_end_ts: SafeInt, reschedule_of?: string }` (`reschedule_of` names a prior appointment.set — reschedule is a NEW event).
- `pickup.scheduled` — `{ facility_id, window_start_ts, window_end_ts }`.
- `dispatch.assigned` — `{ driver_user_id, asset_id?, legs?: array }` (driver from payload; the projection still reads `actor.user` — keep both consistent).

**Step 1 (RED):** `booking.test.ts` — each schema round-trips a valid payload and `.strict()`-rejects an extra key / a float cent; `EVENT_KINDS.length===35` still holds. Run → fail (schemas absent).
**Step 2 (GREEN):** write `booking.ts`, wire both unions in `events.ts`. Run booking.test + events.test → pass.
**Step 3:** `pnpm --filter @shuddl/ledger test` → the roundtrip snapshot moves for exactly these 5 kinds → regenerate it; then `pnpm seed` to regenerate `seed.hash` (the WP-07 lesson — the seed's QUOTED/BOOKED lifecycles include these kinds). `pnpm check:seed` green.
**Commit:** `feat(contracts): type the booking/scheduler event payloads (REQ-028/042/043/047/052/057)`

## Task 2: Facilities capacity/hours/appointment-rules model

**Files:** Add `Facility*` schemas to `packages/contracts/src/booking.ts` (or a `facilities.ts`); a loader `packages/api/.../facilities.ts` (or `workers/api/src/facilities.ts`) mirroring `rate-config.ts`; seed a facility in `workers/api/test/helpers.ts`; Test.

Define the three JSON shapes (`facilities.hours` / `capacity_slots` / `appointment_rules`, all empty-defaulted today):
- `hours` — `{ tz: string, weekly: Record<0..6, [{open_min, close_min}]> }` (minutes-from-midnight, integer).
- `capacity_slots` — `[{ slot_key: string, window_start_min, window_end_min, dow?: number }]` — each a capacity-1 unit (Decision 3). `slot_key` is the stable claim key.
- `appointment_rules` — `{ lead_time_min?, max_horizon_days?, allow_same_day?: boolean }`.
A `loadFacility(db, facility_id)` reads + Zod-parses the row.

**Step 1 (RED):** a test seeds a facility with two capacity-1 slots and asserts `loadFacility` parses hours/slots/rules; a malformed slot JSON throws loudly. Fail (loader absent).
**Step 2 (GREEN):** schemas + loader.
**Step 3:** `pnpm check:invariants` — still 21/22 tables (no new table). Green.
**Commit:** `feat(booking): facility hours + dock-capacity-slots model + loader (REQ-052)`

## Task 3: Transit-standards matrix (`transit_matrix` rate-config) + honest window

**Files:** Add `TransitMatrix` schema to `packages/contracts/src/rating.ts` (into the `RateConfig` union); a resolver `resolveTransitDays(originZip, destZip, matrix, zoneTariff)`; a loader entry (mirroring rate-config, NON-required so tenants without one still price); surface the window on the quote (`packages/agents/src/concierge/quote-reply.tsx` + the `/rate` response); Test.

- `TransitMatrix` — `{ kind: literal("transit_matrix"), id, version, days: Record<zone, Record<zone, SafeInt>>, default_days?: SafeInt }`.
- `resolveTransitDays`: `matchZone` both zips → look up `days[oz][dz]` (fallback `default_days`); UNKNOWN if unresolvable — an honest window means NO fabricated number.

**Step 1 (RED):** resolver test — a zone×zone lookup returns the pinned days; an unresolvable lane returns UNKNOWN (never a guess). Fail.
**Step 2 (GREEN):** schema + resolver + loader.
**Step 3:** thread the window into the quote reply/`/rate` (an "estimated transit: N business days" line, design-law-clean; UNKNOWN → omit the line, never fake it). Test the reply carries the honest window.
**Commit:** `feat(booking): transit-standards matrix + honest transit window on quotes (REQ-059)`

## Task 4: `booking.created` party-correction + `credit.checked` projection

**Files:** Modify `packages/ledger/src/projection/status-cache.ts` (the party-correction on conflict); add a credit-hold projection (a `parties` credit column via `0006` ALTER, or a passport row — prefer the sanctioned `ALTER TABLE parties ADD credit_status`); Test `packages/ledger/test/*`.

- **Party-correction:** extend `BOOKING_SQL`'s `ON CONFLICT` to `SET consignee_party_id = ?, bill_to_party_id = ?, status_cache = json_set(...,'$.state','booked')` (from the `booking.created` payload). On INSERT it already sets them. This closes the WP-07 self-reference: a Concierge shipment booked with a real consignee now carries it.
- **Credit projection:** `credit.checked{status:"hold"}` → `UPDATE parties SET credit_status='hold' WHERE id = party_id` (the gate in T6 reads this server-side). `clear`/`review` project accordingly.

**Step 1 (RED):** (a) a Concierge-style shipment (three FKs = requester) then a `booking.created` naming a DIFFERENT consignee → the row's `consignee_party_id`/`bill_to_party_id` become the booking's (party-correction proven); (b) `credit.checked{hold}` sets `parties.credit_status='hold'`. Fail.
**Step 2 (GREEN):** the projection edits + `0006_booking.sql` (ALTER parties ADD credit_status). Append-only invariants: ALTER-ADD-nullable is the sanctioned form; `db/migrations.lock.json` forward-only (new file, never edit a merged one).
**Commit:** `feat(ledger): booking.created party-correction + credit.checked projection (REQ-057/042)`

## Task 5: Appointment atomic-capacity model — double-book impossible

**Files:** `0006_booking.sql` (ALTER `legs` ADD `facility_id`, `appt_slot_key`, `appt_window_start_ts`, `appt_window_end_ts`; a PARTIAL `CREATE UNIQUE INDEX ux_legs_slot ON legs(facility_id, appt_slot_key) WHERE appt_slot_key IS NOT NULL`); an `appointment.set` projection (`packages/ledger/src/projection/*` — UPDATE the leg's appt fields); the capacity gate `packages/ledger/src/gates/transition-gates.ts` `assertAppointment`; wire `appointment.set` into `GATED_KINDS` + the DO switch with server-sourced occupancy; Test `sequencer.test.ts`-style.

- **Atomic backstop:** the projection sets `legs.appt_slot_key` = the claim; the partial UNIQUE index makes a second claim for the same `(facility_id, slot_key)` fail the batch → the append aborts (Decision 1). This is the "double-book impossible" guarantee.
- **Capacity gate (clean UX):** `#enforceTransitionGate` reads current occupancy for `(facility_id, slot_key)` from D1 (server-sourced) + the facility's slot list; blocks a full/nonexistent slot with `GATE_BLOCKED:{reason}` before the write. (The gate is the friendly answer; the index is the truth.)

**Step 1 (RED):** the DoD test — seed a facility + one capacity-1 slot; `appointment.set` on shipment A claiming it → 201; `appointment.set` on shipment B claiming the SAME slot → **blocked (gate) OR the batch aborts**, and `countEvents(B) === before` (zero append). A concurrency variant: two `appointment.set` for the same slot on different streams fired together → exactly ONE commits (mirror `sequencer.test.ts:101-118`). Fail (no gate/index).
**Step 2 (GREEN):** the migration + index + projection + gate + DO wiring.
**Step 3:** `pnpm check:invariants` — 21/22 tables (ALTER not a new table); the ALTER-ADD form passes the append-only check.
**Commit:** `feat(booking): dock-slot appointments — double-book atomically impossible (REQ-028/052)`

## Task 6: Booking gates — credit-hold + consignee-contact

**Files:** `packages/ledger/src/gates/transition-gates.ts` (`assertBookingCredit` REQ-042, `assertBookingConsignee` REQ-047); wire `booking.created` into `GATED_KINDS` + the DO switch with server-sourced context (D1 `parties.credit_status` for the bill_to; `parties.contacts` for the consignee); Tests: pure (`transition-gates.test.ts`) + negative API (`gates.test.ts`).

- **assertBookingCredit:** the bill_to party's `credit_status==='hold'` → `GATE_BLOCKED:{required_evidence:["credit_clear"]}` (overridable per policy — a named+reasoned override releases it, REQ-049).
- **assertBookingConsignee:** the consignee party has NO email/SMS contact in `parties.contacts` AND no `service_flags.contact_opt_out` → `GATE_BLOCKED:{required_evidence:["consignee_contact"]}`. This is the GA-6 fix — the heartbeat evidence email is guaranteed a recipient (REQ-047).
- **Server-sourced context:** the DO's `#enforceTransitionGate` loads the credit status + consignee contacts by the payload's party ids (like `#deliveryFence` loads legs). The gate stays pure; the DO supplies the facts. NOTE: `booking.created` is the FIRST event of a fresh direct-booking stream (`prior=[]`), so the gate must read D1, never prior events.

**Step 1 (RED):** (a) a bill_to on credit hold → booking `403`/`GATE_BLOCKED` credit_clear, zero append; a named override → 201 + stamped. (b) a consignee with no contact + no opt-out → `403` consignee_contact, zero append; add a contact → 201; the named-opt-out flag → 201. Fail.
**Step 2 (GREEN):** the gates + DO wiring.
**Commit:** `feat(gates): booking blocked on credit hold + consignee-contact required (REQ-042/047)`

## Task 7: Dispatch gate — blocked until docs + appointment

**Files:** `transition-gates.ts` `assertDispatch` (REQ-043); wire `dispatch.assigned` into `GATED_KINDS` + the DO switch (server-sourced: does an `appointment.set` exist for the shipment? are required docs present?); Tests pure + negative API.

- **assertDispatch:** blocks `dispatch.assigned` unless the shipment has (a) an appointment (`appointment.set` on the stream / `legs.appt_slot_key` set) AND (b) the required docs (a `documents`/rate-confirmation presence per policy). Missing → `GATE_BLOCKED:{required_evidence:["appointment","docs"]}` (the exact missing subset). Overridable (REQ-049).

**Step 1 (RED):** a booked shipment with no appointment → `dispatch.assigned` `403` (required_evidence includes "appointment"), zero append; set the appointment (+docs) → 201. Fail.
**Step 2 (GREEN):** the gate + DO wiring.
**Commit:** `feat(gates): dispatch blocked until docs + appointment (REQ-043)`

## Task 8: The Booking agent — quote.accepted → gated booking.created + reschedule

**Files:** `workers/agents/src/booking.ts` (`handleQuoteAccepted`, mirror `concierge.ts`/`biller.ts`); wire the `quote.accepted` trigger enqueue in the sequencer + the `queue()` dispatch in `workers/agents/src/index.ts`; the reschedule path (`appointment.set{reschedule_of}`); Tests `workers/api/test/booking.test.ts` (real DO+D1+gates).

- **Trigger:** a committed `quote.accepted` enqueues a Booking trigger (like `pod.signed`→Biller); `queue()` dispatches by kind. The agent loads the accepted `quote.priced` (via `quote_event_id`) + the shipment, derives the real consignee/bill_to (from the booking request / the accepted quote's party context), and appends `booking.created` THROUGH the gated DO. Idempotent: deterministic `booking.created` id from the `quote.accepted` id; DO dedupe; a gate block surfaces as a held outcome (never a throw-loop — the WP-07 REQ-173 lesson: catch a gate block → held, don't DLQ-loop).
- **Reschedule:** `appointment.set{reschedule_of: <prior>}` frees the prior slot (the projection clears the old `appt_slot_key`, claims the new) — a new event, never a mutation of the old (append-only). The unique index still guarantees no double-book on the new slot.

**Step 1 (RED):** `quote.accepted` → the agent appends a gated `booking.created`, party-correction applied, idempotent under redelivery (one booking); a credit-hold quote.accepted → held (no booking, no throw-loop); a reschedule frees the old slot and claims the new. Fail.
**Step 2 (GREEN):** the agent + wiring.
**Commit:** `feat(agents): Booking agent — quote.accepted → gated booking.created + reschedule (REQ-028)`

## Task 9: Scheduler integration + the double-book acceptance demo

**Files:** `workers/api/test/booking-heartbeat.test.ts` (the WP-08 demo, end to end through real seams) + the honest-window assertion; any surface wiring (the confirmation/calendar artifact is a design-law-clean render, deferred-minimal).

**Prove (the DoD, one causal chain):** quote → `quote.accepted` → Booking agent → gated `booking.created` (party-correction) → `appointment.set` claims a dock slot → a SECOND booking's `appointment.set` for the same slot is **impossible** (blocked + zero append; and the concurrency variant → exactly one wins) → `dispatch.assigned` blocked until the appointment+docs exist, then allowed → the quote showed an honest transit window. Reschedule emits a new `appointment.set{reschedule_of}` and frees the old slot.

**Step 1:** write the heartbeat test (mirror `workers/api/test/heartbeat.test.ts`). It must exercise every real seam (real `/v1` append, real gates, real DO, real projection). Run → green.
**Commit:** `test(wp08): scheduler heartbeat — book → schedule → double-book impossible → dispatch-gated (REQ-028/042/043/047/052/059)`

## Task 10: WP-08 exit audit (REQ-119) + close-out + merge

**Step 1 — adversarial exit-audit swarm (4+ lenses):** attack (a) **double-book** — ANY concurrency/gap where two shipments claim one slot (the index race, reschedule freeing, a gate TOCTOU the index must backstop)? (b) **gate bypass** — can `booking.created`/`dispatch.assigned` be appended past the credit/consignee/dispatch gate via any API path or the agent (REQ-030)? (c) **credit/consignee context** — can server-sourced context be spoofed (a payload party id pointing at a clear party while the real one is held; a stale `parties.credit_status`)? (d) **tenant isolation** — cross-tenant facility/slot/party read in a gate or the agent (REQ-025)? (e) **append-only** — does the `legs` slot-claim UPDATE or the credit projection violate any guard; is the reschedule a new event not a mutation? (f) **money/party-correction** — does the party-correction ever mis-set FKs so a later invoice bills the wrong party? (g) **honest window** — can a fabricated/UNKNOWN transit number reach a customer? (h) **idempotency** — redelivered `quote.accepted` → duplicate bookings/appointments? Verify each finding independently; fix Criticals with proving tests; register discovered scope; **no open Criticals at close.**
**Step 2 — close-out `docs/wp/WP-08.md`** (match `WP-06.md`/`WP-07.md`): DoD split OBSERVED vs CONFIRM-gated/deferred (credit-decision engine, calendar-artifact polish, inbound accept path) vs later WP; the 5 load-bearing decisions + assumption log; the REQ-119 audit record. Activate WP-08 in `tools/traceability/active-wps.json`; ensure every WP-08 REQ (028/042/043/047/052/057/059) is annotated. Run the FULL `pnpm verify` (exit 0) — it catches latent dep/seed drift ([[dep-env-fragility]]).
**Step 3 — merge** per superpowers:finishing-a-development-branch (verify → present options → execute the choice).
**Commit:** the close-out doc + activation.

---

## Execution handoff
**Plan saved to `docs/plans/2026-07-15-wp08-scheduler-booking.md`. Two execution options:**
1. **Subagent-Driven (this session)** — a fresh implementer subagent per task, two-stage review (spec then code-quality) + a fix loop between tasks, then the REQ-119 exit swarm. This is how WP-06/07 landed.
2. **Parallel Session (separate)** — a new session on a `wp-08-scheduler` branch using superpowers:executing-plans, batch execution with checkpoints.

**Recommended:** option 1 (subagent-driven), on a fresh `wp-08-scheduler` branch off `main`. Which approach?
