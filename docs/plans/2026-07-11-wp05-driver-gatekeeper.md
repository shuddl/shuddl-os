# WP-05 — Driver PWA + Gatekeeper (THE HEARTBEAT) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, and superpowers:subagent-driven-development for per-task execution + two-stage review (spec then quality). Close with superpowers:finishing-a-development-branch.

**Goal:** Build the server-side **Gatekeeper** (L7 gate catalog — no transition without its captured evidence, enforced in the ledger, un-bypassable by API) and the **offline-first Driver PWA** (day-sheet → gated per-stop flow → forced photos → signature → geofence stamps → POD), so a delivery completes ONLY with geofence + signature + placed-freight photo and emits the POD event that (at WP-06) fires the invoice + evidence email.

**Architecture:** Gates live server-side in `packages/ledger/src/gates/*` (pure evaluators) and are enforced in the `ShipmentSequencer` DO **before append** (exactly like the existing `assertPodSigned`), so the same gate blocks every API path (REQ-030/007). The driver captures events **offline**, each **signed with its device P-256 key** (WP-02 `sign.ts`) with **evidence bytes hashed at capture** (upload deferred), queued locally, and synced to the sequencer which merges **by (device; per-device seq)** with no overwrite (REQ-016). The PWA (`apps/driver`) is an installable offline-first app: one question, one button per step; photos forced; signature on glass.

**Tech Stack:** TypeScript strict (no `any`), Zod at every boundary, WebCrypto P-256 (device keys), Cloudflare DO sequencer + D1 + R2 (evidence), React 19 + Vite PWA (service worker, Web App Manifest), MapLibre (existing), Vitest + the workers-pool harness.

---

## The honest scope split (read before any code)

Several WP-05 DoD items need **real hardware, a real driver, or counsel** — they can't close in a code-only session, exactly like WP-04's engagement fixtures. The plan builds the MECHANISM and proves it deterministically; the human/hardware/legal validation is **[CONFIRM]/pilot-gated**.

- **CLOSES NOW (built + tested in-repo):** the Gatekeeper gate catalog + server-side enforcement (REQ-007/030/044/045/046/049); geofence math ± accuracy (REQ-065); the physical event payload contracts + evidence-hash-at-capture (REQ-017); offline signed capture + merge-by-(device;seq) + the **airplane-mode soak: 50 events / 2 devices / zero loss or dupes** (REQ-016/013); the consent-before-first-GPS gate mechanism (REQ-166 mechanism); forced-photo-untypassable + signature-hash-in-pod.signed (REQ-063/064); the offline-first installable PWA + the full gated stop flow (REQ-061/062); the POD event that triggers the heartbeat; the **adversarial gate-bypass test** (gate-bypass impossible in UI *and* API).
- **[CONFIRM]/PILOT-GATED — build the mechanism, do NOT claim the human/hardware result:** real tenant-0 driver installs + completes a gated stop unassisted (REQ-164/L6 zero-instruction, REQ-062); outdoor readability (REQ-067); battery/data budget <5%/day GPS at 30s (REQ-070); driver location-consent **legal policy** + counsel note (REQ-142/166 — owner=counsel). Record these as observed-mechanism / pending-pilot in `docs/wp/WP-05.md`; never mark the human/hardware DoD green from CI.
- **SPANS WP-06 (note, don't build here):** "signature → invoice event + consignee photo email <5s." WP-05 emits `pod.signed` + `delivery.evidenced`; the invoice projection + evidence email are WP-06 (Biller). The <5s end-to-end demo lands when WP-06 closes.

Every "it works" claim in the final report cites a passing test or a committed real-pixel render — never a relayed assumption. Where a render is claimed, it must be an actual headless-browser screenshot (the WP-03 harness `tools/live/render-app.mjs`), not a spec-level assertion.

---

## Grounding facts (already in the repo — read first, do not re-derive)

- `packages/ledger/src/gates/invoice-gate.ts`: `assertPodSigned(events, incoming, policy)` + `GatePolicy`; throws `GateError` → `GATE_BLOCKED:{"required_evidence":[...]}`. Wired in `workers/api/src/do/sequencer.ts` **before append** (search `assertPodSigned`, ~line 177). New gates follow this exact shape + wiring.
- `packages/ledger/src/sign.ts`: WebCrypto P-256 device sign/verify (WP-02). `packages/contracts/src/events.ts`: I4 already requires `custody.transferred`/`pod.signed` to carry `actor.device` OR `payload.unwitnessed`. `EVENT_KINDS` has every physical kind; `PodSignedPayload`={signature_hash, geo, unwitnessed?}, `CustodyTransferredPayload`, `PositionUpdatedPayload` are shaped; **`stop.arrived`/`freight.counted`/`freight.photographed`/`dims.captured`/`seal.applied`/`stop.departed`/`osd.captured`/`delivery.evidenced` are still generic `JsonObject`** (Task 1 shapes them).
- Sequencer append surface (from WP-02/WP-04): `env.SHIPMENT_SEQ.get(idFromName(`${tenant}|${streamId}`)).append({tenant, streamId, input})`; input is an `EventInput` `{id, shipment_id, ts, actor:{party, device?}, party_refs, evidence[], source, confidence, kind, payload}`; the DO owns seq/prev_hash/hash/visibility and verifies the device signature. Tests use `cloudflare:test` `env` + `ensureSchema` + `TENANT_A_DB`.
- Gate catalog (doc 01 §4): Pickup Arrive→Depart needs count+photos(+dims)+shipper-sign; Interline handoff needs seal-scan+receiver-ack; Delivery Arrive→**Delivered** needs geofence+signature+**placed-freight photo (forced)**; Any exception needs photo+reason. Overrides = named + reason + permanently visible (REQ-049).
- Design law (doc 07 §03 driver surface): ink-dark ground, the camera UI is "always-dark", one question + one button per screen, teal = progress only. The WP-03 driver screen (`apps/driver/src/App.tsx`) is the starting chrome.

---

### Task 1: Physical event payload contracts + evidence-hash-at-capture

**Files:** Modify `packages/contracts/src/events.ts`; create `packages/contracts/test/physical-events.test.ts`.

Give the generic-`JsonObject` physical kinds real Zod payloads (integer geo, hashes as `Hash64`):
- `StopArrivedPayload` = `{ geo: GeoStamp, auto: boolean }` (auto = geofence-triggered).
- `FreightCountedPayload` = `{ pieces: SafeInt(≥0), expected?: SafeInt }`.
- `FreightPhotographedPayload` = `{ photo_hash: Hash64, kind: enum["freight","placed","seal","exception"] }` (REQ-017 — the bytes are hashed at capture; upload deferred).
- `DimsCapturedPayload` = `{ l_in, w_in, h_in, pieces: SafeInt, method: enum["camera","manual"] }`.
- `SealAppliedPayload` = `{ seal_id: string.min(1), photo_hash: Hash64 }`.
- `StopDepartedPayload` = `{ geo: GeoStamp, auto: boolean }`.
- `OsdCapturedPayload` = `{ photo_hash: Hash64, reason_code: enum[…], note?: string }` (opens a claim draft downstream).
- `DeliveryEvidencedPayload` = `{ placed_photo_hash: Hash64, geo: GeoStamp }` (the forced placed-freight photo).
- `ConsentCapturedPayload` (a NEW payload for REQ-166 — captured BEFORE the first GPS stamp): `{ policy_version: string, operating_state: string, acknowledged: z.literal(true) }`. **Adding a new event KIND requires a register amendment** — so DO NOT add a new kind; ride consent on an existing control kind (`document.attached` with a `consent` doc kind, OR `agent.acted`-style). CONFIRM the mapping in the task; if a genuine new kind is needed, STOP and propose the register row first (35-kind budget).

Wire each into the `ev(...)`/`evInput(...)` maps (replace the `JsonObject` entries). **TDD:** each payload parses a valid example and rejects junk (non-integer geo, non-64-hex hash, missing forced field). Run `pnpm --filter @shuddl/contracts test` + tsc. **Commit** `contracts: physical-event payloads (geo/hash/count/dims/seal/osd/placed-photo) — REQ-017/063/064`.

---

### Task 2: Geofence math (± accuracy)

**Files:** Create `packages/ledger/src/geo/fence.ts`, `packages/ledger/test/fence.test.ts`.

Pure, integer-friendly: `insideFence(point: GeoStamp, fence: {lat_e6, lon_e6, radius_m}): { inside: boolean; distance_m: number; ambiguous: boolean }` — haversine on `_e6` coords; `ambiguous = |distance_m - radius_m| <= point.accuracy_m` (the ± accuracy band where auto-arrive/depart must NOT silently fire — it prompts instead). **TDD:** a point well inside → inside; well outside → outside; within the accuracy band of the boundary → `ambiguous`. Known-answer distances (hand-checked). REQ-065. **Commit** `ledger: geofence math with ±accuracy ambiguity band — REQ-065`.

---

### Task 3: The Gatekeeper — the gate catalog (pure, server-side)

**Files:** Create `packages/ledger/src/gates/transition-gates.ts`, `packages/ledger/test/transition-gates.test.ts`.

Mirror `invoice-gate.ts`'s shape (`GateError` with `required_evidence`). Pure evaluators over the stream's prior events + the incoming event:
- `assertPickupDepart(events, incoming)` — `stop.departed` (pickup) blocked unless the stream already has `freight.counted` + a `freight.photographed{kind:"freight"}` (+ `dims.captured` if the shipment is dims-fitted) + a shipper co-signed `custody.transferred` (REQ-044).
- `assertDelivery(events, incoming)` — `delivery.evidenced`/the delivered transition blocked unless there is a `stop.arrived` inside the geofence (or a logged override) + a `pod.signed` (signature) + a `freight.photographed{kind:"placed"}`/`delivery.evidenced{placed_photo_hash}` (REQ-046 — the forced placed-freight photo).
- `assertInterline(events, incoming)` — interline `custody.transferred` blocked unless `seal.applied` + receiver ack (co-sign) (REQ-045).
- `assertException(incoming)` — `exception.raised`/`osd.captured` blocked unless it carries a `photo_hash` + `reason_code` (REQ-050).
- **Override:** any gate accepts a named override `{ by: party, reason: string }` on the incoming event; when present the gate PASSES but records the override (it must be permanently visible — REQ-049). A gate blocked WITHOUT override throws `GATE_BLOCKED` with the exact `required_evidence` list.

**TDD (this is the heart — test hard):** each gate blocks with the right `required_evidence` when evidence is missing; passes when complete; passes-with-override when overridden (and the override is surfaced); a delivery outside the fence with no override → blocked (REQ-046); a pickup depart missing the freight photo → blocked (REQ-044). **Commit** `ledger: Gatekeeper transition gates (pickup/delivery/interline/exception) + named overrides — REQ-007/044/045/046/049/050`.

---

### Task 4: Consent-before-first-GPS gate (REQ-166 mechanism)

**Files:** Modify `packages/ledger/src/gates/transition-gates.ts` (+ tests).

`assertConsentBeforeGps(events, incoming)` — a `position.updated` or `stop.arrived` (the first geo-bearing event on a driver's stream) is blocked unless a consent record (per Task 1's decided mapping) already exists on the stream for the driver's operating state. **TDD:** first `position.updated` with no prior consent → `GATE_BLOCKED:{required_evidence:["consent.captured"]}`; after consent → passes. Note in the DoD that this is the MECHANISM; the **legal policy text + counsel sign-off is [CONFIRM] (owner=counsel)**. **Commit** `ledger: consent-before-first-GPS gate (mechanism; legal policy is [CONFIRM]) — REQ-166`.

---

### Task 5: Wire the Gatekeeper into the sequencer + the adversarial gate-bypass test

**Files:** Modify `workers/api/src/do/sequencer.ts` (call the new gates before append, beside `assertPodSigned`); create `workers/api/test/gates.test.ts`.

Enforce every Task-3/4 gate in the DO **before append**, so the gate is identical on every API path (REQ-030/007). Translate `GateError` → the existing `GATE_BLOCKED:{required_evidence}` envelope (already handled). **TDD (adversarial — REQ-030 "API bypass attempts fail"):** attempt each blocked transition DIRECTLY via the sequencer/API (not the UI) — a `delivery.evidenced` with no `pod.signed`, a pickup `stop.departed` with no count/photo, an interline handoff with no seal — assert each is `GATE_BLOCKED` and **no event is appended**; then the same transition with complete evidence (or a named override) succeeds and the override is recorded. **Commit** `api: Gatekeeper enforced in the sequencer before append; gate-bypass impossible via API (adversarial) — REQ-007/030/044/045/046`.

---

### Task 6: Offline signed capture + evidence-hash-at-capture + per-device merge

**Files:** Create `packages/driver-core/` (a new pure package: offline event capture/queue/merge — no DOM, testable in Vitest) `src/{capture,queue,merge,device-key}.ts` + tests; add to the workspace.

- `deviceKey`: generate/persist a P-256 device keypair (WebCrypto), reuse `@shuddl/ledger/sign` to sign an `EventInput` offline.
- `capture(kind, payload, evidenceBytes?)`: hash evidence bytes at capture (`Hash64`) → put the hash in the payload, keep the bytes for deferred upload; assign a **per-device monotonic seq**; sign; enqueue (REQ-016/017).
- `merge(incoming, existingByDeviceSeq)`: dedup/merge by `(device_id, device_seq)` — **never overwrite** an existing (device,seq); a re-synced duplicate is a no-op; two devices' streams interleave by the sequencer's global seq without loss (REQ-016/013).
- **TDD:** capturing hashes the bytes and defers upload (REQ-017); the same event synced twice merges once (no dupe); two devices capturing offline merge with no loss and no overwrite. **Commit** `driver-core: offline signed capture, evidence-hash-at-capture, merge-by-(device;seq) no overwrite — REQ-013/016/017`.

---

### Task 7: The airplane-mode soak (GA-14 / REQ-016)

**Files:** Create `packages/driver-core/test/airplane-soak.test.ts` + `fixtures/airplane-soak/` (in-repo generated, like gl-netting — no engagement data); flip the `airplane-soak` manifest row to `vendored` (generated in-repo) if it's produced deterministically here.

Simulate 2 devices capturing **50 events total offline** (a full stop cycle each: arrived→counted→photographed→dims→sign→departed, plus positions), then sync both to a sequencer (the workers-pool harness or a pure sequencer stub) in an arbitrary order with duplicate re-sends, and assert: **every event lands exactly once (zero loss), no duplicates, each device's per-device seq is contiguous, the global hash-chain verifies** (`@shuddl/ledger/chain`). Deterministic (no Date.now/random — seed it). This is the DoD's airplane-mode soak. **Commit** `driver-core: airplane-mode soak — 50 events / 2 devices / zero loss, zero dupes, chain verifies — REQ-016/GA-14`.

---

### Task 8: The Driver PWA — offline-first, installable, gated stop flow

**Files:** Modify `apps/driver/` — `src/App.tsx` (the flow), add `src/flow/` (the per-stop state machine), `src/service-worker.ts` + `manifest.webmanifest` (installable offline-first, REQ-061), wire `@shuddl/driver-core`. Modify `vite.config.ts` (PWA/service-worker).

- **Day sheet → per-stop gated flow** (REQ-062): each screen is ONE question + ONE button; the flow is a state machine (arrive → count → photograph → dims? → sign → depart for pickup; arrive → geofence → photograph-placed → sign → delivered for delivery). The button to advance is DISABLED until the step's evidence is captured — the gate is the training (L7).
- **Forced photos** (REQ-063): the photo step cannot be skipped; the "camera always-dark" UI; the captured photo is hashed via driver-core.
- **Signature on glass** (REQ-064): a canvas signature → hash → `pod.signed`.
- **Offline-first installable** (REQ-061): a service worker caches the shell + queues captures; the Web App Manifest makes it installable (no app store).
- **RENDER IT (per the WP-03 honesty lesson):** build the driver PWA, render the key flow screens in real headless Chrome (`tools/live/render-app.mjs`), commit the screenshots; each screen must visibly obey the driver recipe (ink-dark, one-question-one-button, teal progress). Do NOT claim it works without a committed render.
- **TDD:** the flow state machine advances ONLY when each step's evidence is present (unit tests on the machine); a build renders; the service worker registers. **Commit** `driver: offline-first installable PWA + gated per-stop flow (forced photos, signature on glass, one-question-one-button) — REQ-061/062/063/064` + the blessed renders.

---

### Task 9: The heartbeat — POD completes the delivery gate

**Files:** `apps/driver` (the delivery completion) + `workers/api/test/rate.test.ts`-style `workers/api/test/pod.test.ts`.

Drive the delivery gate end to end: `stop.arrived`(in-fence) → `freight.photographed{placed}` → `pod.signed` → the sequencer passes `assertDelivery` and appends `delivery.evidenced` (the POD). Assert the POD event lands with the placed-photo hash + signature hash + geo, and that it is the trigger the Biller will project at WP-06. **Explicitly note in code + the test that the invoice + evidence email (<5s) is WP-06** — this task proves the POD event fires, not the email. **Commit** `driver/api: delivery gate completes → pod.signed + delivery.evidenced (the POD heartbeat; invoice+email = WP-06) — REQ-046`.

---

### Task 10: WP-05 exit audit (REQ-119) + close-out + finish

**Files:** Create `docs/wp/WP-05.md`; modify `tools/traceability/active-wps.json` (add WP-05) + annotate any WP-05 REQ lacking a source tag; `genesis/09` only if new scope was discovered (append-only).

**Step 1** — `pnpm verify` all-green. **Step 2** — the REQ-119 adversarial gate swarm over the Gatekeeper + sequencer + driver-core (4–5 auditors): hunt a gate reachable by API but not enforced; a delivery completable outside the fence with no override; a forced-photo path that's skippable; an offline merge that loses or overwrites an event; a co-sign that isn't required; a consent bypass; a device-signature forgery. Fix every Critical (no open Criticals at close). **Step 3** — add WP-05 to `active-wps.json`, ensure every WP-05 REQ has a source annotation (esp. the DRIVER/GATES rows); `check:traceability` green. **Step 4** — write `docs/wp/WP-05.md`: DoD as **OBSERVED** (gates/offline-soak/flow/POD, each linked to its test/render) vs **[CONFIRM]/PILOT** (real-driver install REQ-164, outdoor REQ-067, battery REQ-070, counsel REQ-142/166) vs **WP-06** (the <5s email). **Step 5** — `pnpm verify` green + commit; then **REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch.**

---

## Out of scope (owned elsewhere — do not build here)
- POD→invoice projection + evidence email (<5s) → **WP-06** (this WP fires the POD event that triggers it).
- Booking/scheduling gates (Booked→Dispatched appointment/window) → WP-08.
- The map dot latency <60s (REQ-071 positions on the live board) → the position events emit here; the board rendering is WP-10/existing map.
- Real-driver pilot, outdoor readability, battery budget, legal consent policy → **[CONFIRM]/pilot** (mechanism built here; human/hardware/counsel validation is an engagement step).
- Damage/claims full flow beyond the OS&D capture event + claim-draft trigger → later.
