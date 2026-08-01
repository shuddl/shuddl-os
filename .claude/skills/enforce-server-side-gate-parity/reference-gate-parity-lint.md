# Gate-parity lint (CI) — pseudocode

Goal: fail the build when a write path can persist a gated physical fact WITHOUT invoking the gate
predicate the sequencer would have applied (REQ-030). This catches the `positions.ts` class of RED
statically, so a future bypass route cannot silently drop a gate.

## Inputs (three sources of truth)
1. **`GATED_KINDS`** — `workers/api/src/do/sequencer.ts:94-96`. The kinds the DO gates before append.
2. **The bypass registry** — an explicit allow-list of routes that persist a gated fact WITHOUT
   traversing `SHIPMENT_SEQ.append`. Today: `POST /v1/positions` (positions.ts). Adding a bypass route
   = adding a row here (the sanctioned-bypass discipline; an unregistered write path is a lint failure
   on its own, see rule C).
3. **The required-predicate map** — for each gated fact, which of `{assignmentOf, deviceOwnedBy,
   assertConsentBeforeGps}` must appear on the path. e.g. a GPS/position write requires all three.

## Rules
```
A. For each route in the bypass registry:
     parse its handler AST.
     for each required predicate of the fact it writes:
       if the predicate symbol is not called on the handler's path BEFORE the INSERT/db.batch:
         FAIL "REQ-030: <route> persists <fact> without <predicate> (sequencer enforces it at <do:line>)"

B. Consent coverage:
     any handler that INSERTs into `positions` OR appends kind in {position.updated, stop.arrived}
     must call assertConsentBeforeGps with a SERVER-derived operating_state (deriveOperatingState over
     the stamp's own coords). A literal/client-sourced operating_state FAILS (spoofable claim).

C. No stealth bypass:
     grep for INSERT/UPDATE against physical-fact tables (positions, events, legs, appointments) in
     workers/api/src/routes/**. Any write site NOT going through SHIPMENT_SEQ.append and NOT listed in
     the bypass registry FAILS — an unregistered, therefore un-audited, write path.

D. Client-id taint:
     if a handler binds req-body `shipment_id`/`device_id` into a write, require assignmentOf +
     deviceOwnedBy on the path. (PositionInput validates SHAPE, not AUTHORITY — position.ts:11-21.)
```

## Why static, not just tests
The DO-side gates are unit-tested pure functions (transition-gates.ts). The gap is not the gate — it is
a NEW path that never calls it. A test only covers a path someone remembered to write; the lint covers
the paths nobody wrote a test for. Pair it with the existing tenant-isolation suite (REQ-025) that
already runs every merge.

## Seed assertion (regression pin for the positions RED)
```
assert path("POST /v1/positions") calls assertConsentBeforeGps   // REQ-166
assert path("POST /v1/positions") calls assignmentOf             // driver-assignment parity w/ events.ts:167-173
assert path("POST /v1/positions") calls deviceOwnedBy            // device-ownership parity w/ sequencer.ts:237-256
```
