# A-2 — Demo Film Shot List (staging, demos #1 and #5)

**Status:** DRAFT v1 for owner review — **nothing is filmed until the owner reads §6 and §7 and confirms the prerequisites are closed.**
**Gates:** [F1-icp.md](F1-icp.md) ✅ (audience) · [A1-messaging.md](A1-messaging.md) claims firewall applied to every caption ✅ · [P1-press-kit.md](P1-press-kit.md) §5 (this list may not promise more than the kit offers) ✅
**Readiness ceiling:** [docs/research/2026-08-01-coordination-layer/01-system-readiness.md](../research/2026-08-01-coordination-layer/01-system-readiness.md) §5 ("doc 01 §5"). A shot that is not backed by a doc-01 §5 line marked **Complete** or **Most complete** is not in this file.
**Owns:** this file only. Every source path below was read read-only.

---

## 0. What these two films are — and are not

These are **staging demo films**: sales/press assets that let the owner stop scheduling live screen-shares (P-1 §5 Assets: *"Demo films: not yet produced… until they exist, demos are live screen-shares, scheduled, staging-labeled"*).

They are **not** the five launch-gate acceptance videos in [docs/wp/acceptance-demos.md](../wp/acceptance-demos.md) §"The filmed-video launch-gate checklist". Those are filmed on **tenant-0's real freight**, and a merge cannot close them. These films use **synthetic staging data only**, and every frame says so.

Only two of the five demos are filmable today. Doc 01 §5 disqualifies the other three:

| Demo | doc 01 §5 verdict | Filmable now? |
|---|---|---|
| 1. POD → invoice + evidence email | **"Complete; proven on live staging (penny-exact 55,800¢, real email sent)"** | **YES — on staging** |
| 2. Stranger signs up and quotes | *"no signup UI exists"* + counsel-blocked | No |
| 3. Real driver, gated stop, zero instruction | *"Code: driver login/lockout (REQ-069) is unbuilt — a driver cannot sign in"* | No (see §7.1) |
| 4. Booking from Claude via MCP | *"full DO-backed booking never exercised e2e"* | No |
| 5. Exception pulse dims the map | **"Most complete — full chain hash-verified"** | **YES — on staging** |

Demo 1's remaining gap in doc 01 §5 is **production** config (`prod sender domain verification + 2-week deliverability warmup (REQ-157) + EVIDENCE_FROM binding + a tenant with real PODs`). None of that blocks a **staging** film: staging already has a verified sender and sends real evidence email — `docs/ops/DEPLOYMENT.md:27` (*"Staging now has both… So the deployed Biller **sends real evidence email**. Proven end-to-end"*).

Demo 5's remaining gap in doc 01 §5 is literally *"The filmed live capture"* — this document — plus the CI-hardware perf finding (doc 01 §3.1), which is a hosted-CI measurement, not a local render defect, and is disclosed in §7.

---

## 1. Shot-to-readiness ledger (falsifier (a))

Every shot below, beside the doc-01 line that says it works. Nothing else gets filmed.

| Shot | Depends on | doc 01 line that confirms it |
|---|---|---|
| A2–A6 driver gated flow | the per-stop gate machine + capture | §5 demo 1 "**Complete**"; §5 demo 3 "**Complete** incl. offline soak" (the *flow* is complete; only the *login* is unbuilt — §7.1) |
| A7–A8 evidence email in an inbox | Biller → real Resend send | §5 demo 1 "**Complete**; proven on live staging… real email sent" |
| A8 penny-exact invoice total | invoice = quote sell = Σ money_lines | §5 demo 1 "penny-exact 55,800¢" |
| B2 the live board with marks | `GET /v1/board` over ledger state | §4 "Surfaces: all three built and deployed"; §5 demo 5 "**Most complete**" |
| B3–B4 world-dim + exception throb | `exception.raised` → status_cache → board → map | §5 demo 5 "**Most complete** — full chain hash-verified" |
| B6 EXCEPTIONS queue | durable exception read | §4 "Views: 11 of 12 canonical"; §5 demo 5 |
| B7 lens panel event tail | lens-scoped event read | §4 "Ledger: 35/35 event kinds… 8 projections" |
| Both — server gates visibly refusing | Gatekeeper | §4 "The Gatekeeper is the strongest piece: server-side, Durable-Object-enforced" |

**Ceiling check against P-1 §5 (falsifier (d)).** P-1 §5 "Can be shown today" lists seven assets. These two films draw on exactly three of them — *Signature → invoice*, *Exception on the map*, *A gate refusing* — and add nothing. The other four (fail-closed prod API, the three surfaces' empty states, the offline soak record, the red gates) stay as live screen-share material and are **out of scope for A-2**.

---

## 2. The rig (read before booking a shoot day)

**There is no staging surface deployment.** `build:surfaces` bakes `VITE_API_BASE=https://api.shuddl.tech` (`package.json:46`) and each surface's `deploy` script targets `--env prod` (`apps/command/package.json:5`, `apps/command/wrangler.toml` `[env.prod]`). The deployed `command/driver/portal.shuddl.tech` therefore point at the **production** API, which has zero tenants and dark email — filming them produces empty screens.

**Film against locally-served surfaces pointed at staging:**

- Staging API origin: `https://api-staging.shuddl.tech` (`workers/api/wrangler.toml`, `[[env.staging.routes]]`).
- Run e.g. `VITE_API_BASE=https://api-staging.shuddl.tech pnpm --filter @shuddl/command dev`.
- **One surface at a time on port 5173.** The CORS allowlist admits only `http://localhost:5173` and `http://localhost:4322` for local dev (`workers/api/src/middleware/cors.ts:31-32`), and staging serves the dev list because `ENVIRONMENT="staging"` is in `DEV_ENVIRONMENTS` (`cors.ts:44-47`). All three apps default to Vite's 5173 (`apps/*/vite.config.ts` set no port), so a second app started concurrently lands on 5174 and is **CORS-denied**.
- Sessions arrive as `?token=` and are stripped from the URL on first render (`apps/command/src/session.ts:92-102`). **Start recording after the strip** — the bearer is in the address bar for one frame otherwise.

---

## 3. The STAGING treatment (non-negotiable, every frame)

P-1 §5: *"Every demo asset is labeled STAGING on the frame, not just in the caption."*

**Watermark text (exact):**

```
STAGING · SYNTHETIC DATA · NO CUSTOMER FREIGHT
```

**Style** — drawn from the locked design tokens (`packages/design/src/tokens.ts:6-17`), so the label reads as part of the system rather than an afterthought:

- Type: `JetBrains Mono` (`FONTS.mono`), uppercase, letter-spacing `0.08em`, ~14px at 1080p.
- Colour: `--signal` `#FF4A33` on an 88%-opacity `--field` `#D5D1CC` plate, or `--field` text directly on the ink ground.
- **No shadow, no gradient, radius 0** (CLAUDE.md hard budgets).
- Burned in at export. Never a separate track that an editor can toggle off.

**Placement, per surface** (chosen to clear real chrome):

| Frame | Position | Why that spot is clear |
|---|---|---|
| Command board (Film B, and A9 if used) | **bottom-centre, 32px from the bottom edge** | The nav spans the top (`apps/command/src/App.tsx:229-241`); the KPI strip is bottom-**left** at `bottom:84` (`apps/command/src/views/KpiStrip.tsx:45`); the queues are a right-hand aside from `top:84` (`App.tsx:278`); the lens panel is the right 360px (`packages/map/src/LensPanel.tsx:26-33`). Bottom-centre is the only permanently empty band. |
| Driver PWA (Film A, beats 2–6) | **in the composite frame margin, centred above the device** | `Screen` is a 460px centred column on an ink-dark ground (`apps/driver/src/components/Screen.tsx:6-11`) with content pinned top and bottom; there is no safe in-column band. Composite the portrait phone capture into a 1920×1080 `#1A1A1A` frame and put the label in the surround. |
| Inbox / email (Film A, beats 7–8) | **top-centre, above the mail-client chrome** | Keeps it off the email body, which is the shot. |

**Plus** a 4-second head card and a 4-second tail card carrying the full disclosure (§4 beat 1 / §5 beat 1).

---

## 4. FILM A — "Signature at the door" (demo #1) · target 84s · 9 beats

**Premise on screen:** a driver completes a gated delivery stop; the invoice and its evidence land in the bill-to party's inbox in the same second.

| # | t (mm:ss) | Shot | What must be on camera | Source file |
|---|---|---|---|---|
| **A1** | 0:00–0:05 | **Head card.** Static `--field` ground, Display type. | Title + disclosure block (text in §4.1). | — (title card, not a product screen) |
| **A2** | 0:05–0:13 | **Day sheet.** Phone, ink-dark ground, ruled stop rows, teal progress track. | `DaySheet` — the ordered stops, `--progress` fill, and the bottom line `OFFLINE — TAP A STOP TO BEGIN`. Thumb taps the delivery row. | `apps/driver/src/components/DaySheet.tsx:8` (rows `:33-66`, progress `:27-29`, footer `:69-71`) |
| **A3** | 0:13–0:23 | **Gate 1/4 — arrival.** One question, one button. | `ProgressLine` header reading `STOP n · DELIVERY · 1/4`; Display question **"Confirm the delivery arrival"**; Mono caption **"CONSENT ON FILE · GPS INSIDE THE FENCE"**; button **"I'm at the door"**. | `apps/driver/src/components/GatedFlow.tsx:179` (header), `:326` (StopScreen render); step copy in `apps/driver/src/flow/stop-flow.ts:136-144`; `ProgressLine.tsx:5` |
| **A4** | 0:23–0:36 | **Gate 2/4 — the forced photo.** Live viewfinder, 1px coral reticle corners, then the captured frame. | `CAMERA · LIVE` → shutter → `FRAME CAPTURED`; the Mono line under the buttons flipping from **"A PHOTO IS REQUIRED — CANNOT SKIP"** to **"HASHED · QUEUED OFFLINE"**. Hold 1s on the disabled `Advance` **before** the shutter — that dead button is the shot. | `apps/driver/src/components/CameraScreen.tsx:140-219` (viewfinder `:144-190`, state line `:180-182`, shutter/advance `:192-218`, reticle `:225-236`) |
| **A5** | 0:36–0:50 | **Gate 3/4 — signature on glass.** Light `--field` panel on the ink ground; ink-dark strokes; baseline rule. | Caption **"SIGN ABOVE THE LINE"** flipping to **"SIGNATURE CAPTURED"** as the first stroke lands; `Advance` enabling only then. | `apps/driver/src/components/SignatureScreen.tsx:15` (glass `:104-121`, prompt `:116-120`, disabled-until-ink `:129-131`) |
| **A6** | 0:50–0:57 | **Gate 4/4 — the terminal transition.** | Display **"Delivered"**, button **"Complete delivery"**, caption **"STAMPS DELIVERY · INVOICE FIRES ON SYNC"**. Thumb taps. Cut on the tap. | `apps/driver/src/flow/stop-flow.ts:163-172`; terminal emit path `GatedFlow.tsx:230-240` |
| **A7** | 0:57–1:10 | **The inbox.** Wide shot: phone (left) beside a laptop with an empty inbox open (right). A visible stopwatch overlay started at the A6 tap. | The unread message arriving. Subject shape is `DELIVERED · <SHIPMENT-REF> · PROOF + INVOICE` (`docs/ops/DEPLOYMENT.md:27` records this exact subject shape from the proven staging send). Stopwatch stops on arrival, on camera. | Sender wiring: `packages/agents/src/biller/sender.ts`; staging binding recorded at `docs/ops/DEPLOYMENT.md:27` |
| **A8** | 1:10–1:20 | **The email body.** Slow scroll, no cursor motion. | `Delivered` in Display hero; the two full-bleed photo cells (signature · freight as placed); the five mono meta rows over 1px coral rules — **Shipment / Delivered / Signed by / Location / Invoice + total**; the `Ship like this` referral line; the footer **"This email is the record · Reply to dispute within 48h"**. | `packages/agents/src/biller/evidence-email-view.tsx:83` (data shape `:22-31`, meta rows `:84-90`, photo cells + rules + footer in the same component body) |
| **A9** | 1:20–1:24 | **Tail card.** | Disclosure block repeated (§4.1). | — |

*Optional 8-second insert between A8 and A9, only if §6 item 5b is closed:* the portal **INVOICES** tab showing the same invoice id and penny-exact total (`apps/portal/src/views/InvoicesView.tsx:44`, total `:114-122`). Cut it if the party-lens token is not ready — the film is complete without it.

### 4.1 Caption / narration text (verbatim — written to the A-1 firewall)

Deliver as **on-screen caption cards**, not voice-over. If a VO is later recorded it must read these words unchanged.

**A1 head card:**
> **SHUDDL — signature to invoice**
> Recorded on our staging environment. Synthetic shipment, synthetic parties, synthetic amounts.
> Zero customers. Zero tenants. Zero real freight.

**A2:**
> A driver's day. Three taps and a signature per stop. Nothing to learn.

**A3:**
> Every step is a server-side gate. The app doesn't decide — the server does, and it says what evidence it still needs.

**A4:**
> The photo can't be skipped. Advance stays dead until a real frame exists.

**A5:**
> The signature is hashed the moment it's captured.

**A6:**
> That tap is the last thing anyone types.

**A7:**
> The invoice and its evidence, in the bill-to party's inbox.
> **Measured on staging, this take. Not a production figure — there is no production freight yet.**

**A8:**
> Proof and money in one artifact. A dispute ends with this email instead of an argument.

**A9 tail card:**
> Built and running on our own infrastructure. Entering Founding Carrier pilots.
> Staging capture · synthetic data · no customer freight.

**Firewall audit of the above:** no "customers are using"; no tenant/person/customer/vendor name; automation described as mechanism, never as the value ("AI" appears nowhere); the same-second claim is labelled staging-measured **on the frame it appears** (A-1 don't #4); no platform/network/coordination-layer language. The closing status sentence is A-1's exact permitted form and P-1 §0.1's only permitted status sentence.

### 4.2 Data state required in staging **before** A2 rolls

All of this is set up off-camera. Nothing here is filmed.

1. **A shipment in `shuddl-t-tenant-a-staging`** with a `delivery` leg, `shipper/consignee/bill_to` party ids of the synthetic `party-*` form (shape mirrored in `tools/deploy/staging-smoke.ts:252-253`).
2. **A priced quote on that shipment**, so the Biller can issue a penny-exact invoice (`invoice total == quote sell == Σ money_lines`, asserted by the smoke — `docs/ops/DEPLOYMENT.md:70`).
3. **The driver assigned** via `status_cache.assigned_driver` — the events route refuses a driver write on an unassigned shipment (`workers/api/src/routes/events.ts:176` role gate; the same assignment predicate guards `workers/api/src/routes/positions.ts:38-42`). Smoke's seeding note: `tools/deploy/staging-smoke.ts:267`.
4. **A registered signing device** for that driver in the control DB's `users.device_keys` (`tools/deploy/staging-smoke.ts:233-236`).
5. **A consent acknowledgement on the stream** before any GPS stamp — the delivery `arrive` step requires `consent` *and* `geofence` (`apps/driver/src/flow/stop-flow.ts:137-138`), and the position route re-enforces consent server-side (`positions.ts:56-62`).
6. **The delivery leg's geofence re-seeded to the actual filming location.** The `arrive` gate needs a fresh, permitted, **in-fence** fix (`GatedFlow.tsx:107` GPS steps, `:281-283` the block). The smoke's fence is a fixed synthetic point (`staging-smoke.ts:64-66`) — it will not match a shoot location.
7. **The demo inbox address on `party-bill-to`'s `parties.contacts`.** Without it the Biller resolves no recipient and sends nothing — `docs/ops/DEPLOYMENT.md:29` (*"most synthetic parties carry none → `recipient_unresolved`, no send"*).
8. **The driver session bearer planted** in the PWA's `localStorage` under `shuddl.driver.session.token` (`apps/driver/src/auth/session.ts:19`). There is no login screen to film — see §7.1.
9. **Camera and location permissions granted** on the device beforehand. A denial blocks the forced photo (`CameraScreen.tsx:110-138`) and a stale/denied fix blocks the GPS step (`GatedFlow.tsx:281-283`) — correct behaviour, wrong film.

---

## 5. FILM B — "The exception pulse" (demo #5) · target 78s · 8 beats

**Premise on screen:** one shipment goes wrong; the whole world dims around it and nothing else in the system raises its voice.

| # | t (mm:ss) | Shot | What must be on camera | Source file |
|---|---|---|---|---|
| **B1** | 0:00–0:05 | **Head card.** | Title + disclosure (§5.1). | — |
| **B2** | 0:05–0:17 | **The quiet board.** Full-viewport greige canvas, all marks at full opacity. Slow, no cursor motion. | The map as the home surface; the KPI strip labelled `(01) BOARD — KPIS`; the right-hand queue stack with **EXCEPTIONS** reading **"NO OPEN EXCEPTIONS"**. | `apps/command/src/App.tsx:226` (canvas), `:275` (KPI strip), `:283` (exceptions queue); `views/KpiStrip.tsx:43-47`; `views/ExceptionsQueue.tsx:56` + empty state `:65-68` |
| **B3** | 0:17–0:24 | **The raise.** An `exception.raised` is appended from a second machine, off-camera; the operator reloads the board **on camera**. | The browser reload is deliberately visible — see §5.2. Nothing is concealed by the cut. | Append path `workers/api/src/routes/events.ts:176`; projection `packages/ledger/src/projection/status-cache.ts:187`; read `workers/api/src/routes/board.ts:51-53` |
| **B4** | 0:24–0:38 | **The dim.** Everything drops to 35%; one coral mark throbs. | The world-dim (`0.35` on every non-exception layer) and the exception stroke breathing on a **1.6-second** sine while at-risk breathes at 3s and healthy never moves. Hold long enough for at least **eight full throb cycles**. | `packages/map/src/entities.ts:217-231` (`setWorldDim`, `dim = 0.35`); `packages/map/src/pulse.ts:6-10`; wiring `packages/map/src/MapCanvas.tsx:41-44`, `:128-133`, `:275-278` |
| **B5** | 0:38–0:48 | **The quiet hold.** No cursor, no click, no scroll. | Prove the negative: no banner, no toast, no modal, no colour anywhere but the one mark. This is the whole thesis of the film. | (behavioural — the absence is the shot) |
| **B6** | 0:48–0:58 | **The queue catches up.** Cursor moves for the first time. | The **EXCEPTIONS** panel now carrying one row: shipment id, `hh:mm`, and the reason code. Cursor hovers, then clicks the row. | `apps/command/src/views/ExceptionsQueue.tsx:70-98` (row `:72-86`, click-through `:90`) |
| **B7** | 0:58–1:12 | **The lens.** Right-side ink-dark panel slides over the same canvas — the map does not navigate away. | Shipment id + status, 1px divider, then the event tail: kind + timestamp per row, `exception.raised` among them. Scroll the tail slowly. | `packages/map/src/LensPanel.tsx:23` (panel `:24-41`, tail `:50-68`); fed by `apps/command/src/App.tsx:297-305` and `lib/board.ts` |
| **B8** | 1:12–1:18 | **Tail card.** | Disclosure (§5.1). | — |

### 5.1 Caption / narration text (verbatim)

**B1 head card:**
> **SHUDDL — the exception pulse**
> Recorded on our staging environment. Synthetic shipments, synthetic parties.
> Zero customers. Zero tenants. Zero real freight.

**B2:**
> The map is the home screen. A calm board is a calm business.

**B3:**
> One shipment records an exception. Nobody types it into a status field — it's an event on the ledger.

**B4:**
> The world dims to 35%. One mark throbs. That's the entire alert.

**B5:**
> No banner. No pop-up. No sound. Nothing else in the system raises its voice.

**B6:**
> The queue reads the ledger, not a status column — so it can't drift from what happened.

**B7:**
> Click the mark and the record opens over the map. Every line is an event that was signed when it happened, on a chain that verifies.

**B8 tail card:**
> Built and running on our own infrastructure. Entering Founding Carrier pilots.
> Staging capture · synthetic data · no customer freight.

**Firewall audit:** no customer/production implication; no names; automation not claimed as the value; no timing figure of any kind; no platform language. B7's chain-verification line is P-1 §3a claim 12 (*"The live map's exception behaviour runs on a fully hash-verified event chain"* — VERIFIED) stated no more strongly than the kit states it.

### 5.2 The reload is not a cheat — and the honest alternative

**The Command board does not poll.** `useBoardFleet` runs one `GET /v1/board` in an effect keyed only on `enabled` (`apps/command/src/App.tsx:54-79`). A newly-raised exception therefore cannot appear on a Command board that is already painted. Two honest ways to shoot B3:

- **Option A (primary).** Film the operator's browser reload. The reload is *in frame*. B2 and B4 are then two takes of the same board either side of a visible refresh — an edit that hides nothing.
- **Option B (live arrival, no reload).** Film the **Portal** board instead, which polls on a bounded 20-second interval (`apps/portal/src/api/board.ts:31`) and re-runs the same `MapCanvas` world-dim effect (`MapCanvas.tsx:275-278`) when the new frame lands. Trade-off: the portal is party-scoped and its coordinates are generalised server-side pre-OFD (`workers/api/src/routes/board.ts:152-160`), so the fleet is smaller and coarser — the "everything else stays quiet" contrast is weaker. Use only if a live arrival is worth more than fleet density.

Do **not** fake a live arrival by any other means.

### 5.3 Data state required in staging **before** B2 rolls

1. **A tenant-lens session token** with role `admin`, `ops`, `finance` or `read` (`workers/api/src/routes/board.ts:168`), delivered as `?token=` (`apps/command/src/session.ts:92`).
2. **Marks on the map require `positions` rows.** `GET /v1/board` inner-JOINs each shipment to its latest position and *drops any shipment without one* (`workers/api/src/routes/board.ts:107-110`). **The seed loader does not write positions** — `tools/seed/load.ts` inserts `parties`, `shipments` and `events` only (`:51-60`), and the staging smoke does not insert them either. A seed-loaded tenant therefore renders an **empty** board. Positions must be created either by `POST /v1/positions` (needs a registered device + consent — `workers/api/src/routes/positions.ts:28-62`) or by direct `wrangler d1 execute --remote` inserts into `shuddl-t-tenant-a-staging`. **This is the single largest setup item in Film B.**
3. **Non-terminal `status_cache.state` on every mark you want visible** — `delivered` and `settled` are filtered off the live board (`board.ts:39`).
4. **Enough marks to read as a fleet.** Target 40–140 positioned shipments. The board caps at 1,000 (`board.ts:43`).
5. **Exactly one shipment at `status_cache.state = 'exception'`.** Only `exception` has a ledger source; every other active state maps to `healthy` and the board never fabricates `at-risk` (`board.ts:45-53`). If two marks are in exception, the "one alarm" thesis of the film collapses.
6. **`prefers-reduced-motion` OFF on the capture machine.** Under reduced motion `MapCanvas` renders a single static pulse frame and never schedules the loop (`MapCanvas.tsx:46-49`, `:234-239`). Your exception will sit there, dim and still. Verify before rolling.

---

## 6. Prerequisites checklist — what is blocked today, and on whom

| # | Item | Status | Owner |
|---|---|---|---|
| 1 | **Staging surface serving.** No staging surface deployment exists; `build:surfaces` bakes the prod API base (`package.json:46`) and every surface `deploy` is `--env prod` (`apps/command/package.json:5`). Films must run the apps locally against `api-staging.shuddl.tech`. | **BLOCKED — needs a shoot-day setup step** | Owner, with the product-code session (do **not** change the deploy scripts for a film) |
| 2 | **Staging JWT secret.** There is no login endpoint anywhere in the API (doc 01 §1). Tenant-lens and driver bearers must be minted with the staging `JWT_SECRET`, the way the smoke does (`tools/deploy/staging-smoke.ts:45-47`). | **BLOCKED — secret custody** | Whoever holds the staging `JWT_SECRET` |
| 3 | **`positions` rows in `shuddl-t-tenant-a-staging`.** Without them `GET /v1/board` returns an empty board (`board.ts:107-110`; `tools/seed/load.ts:51-60` writes none). | **BLOCKED — data seeding not done** | Owner / product-code session |
| 4 | **One `exception.raised` shipment**, appended through `POST /v1/shipments/:id/events` (`events.ts:176`). | **BLOCKED — data seeding not done** | Owner |
| 5a | **Demo inbox on `party-bill-to.contacts`** or the Biller resolves no recipient and no email is sent (`docs/ops/DEPLOYMENT.md:29`). | **BLOCKED** | Owner |
| 5b | *(optional)* **Party-lens token** for the portal INVOICES insert. | Optional — cut the insert if absent | Owner |
| 6 | **Geofence re-seeded to the shoot location** + a consent ack on the stream, or the `arrive` gate correctly refuses (`stop-flow.ts:137-138`, `GatedFlow.tsx:281-283`). | **BLOCKED — location-dependent, do on shoot day** | Owner |
| 7 | **Driver bearer planted in `localStorage`** (`apps/driver/src/auth/session.ts:19`) — the login path is unbuilt (doc 01 §5 demo 3). | **BLOCKED by REQ-069** (worked around off-camera; never filmed) | Owner |
| 8 | **Camera + location permissions granted** on the filming device before rolling. | Shoot-day step | Owner |
| 9 | **`prefers-reduced-motion` OFF** on the capture machine (`MapCanvas.tsx:46-49`). | Shoot-day step | Owner |
| 10 | **Basemap tile licensing.** The map renders from a third-party demo tile host, `https://tiles.openfreemap.org/planet` (`packages/map/src/demo.ts:119`), which the register itself flags as a violation to close (doc 01 §5 demo 3; P-1 §3f). MapLibre attribution is off on this path (`MapCanvas.tsx:169-170`). Confirm the host's terms permit a published promotional film before release. | **OPEN — check before publishing, not before filming** | Owner / counsel |
| 11 | **Owner read of this file and P-1 §5** before a frame is shot. | **OPEN** | Owner |

**Not blocked (verified built, no action needed):** the driver gated flow and its capture path; the staging Biller's real evidence send (`docs/ops/DEPLOYMENT.md:27`); the world-dim and pulse; the exceptions queue; the lens panel.

---

## 7. Shots we must NOT film

Each of these would either claim something unbuilt, imply a customer, or exceed P-1 §5's ceiling.

1. **A driver signing in, or any login screen.** The login path is unbuilt (doc 01 §5 demo 3: *"a driver cannot sign in"*; P-1 §5 "Cannot be shown"). The bearer is planted off-camera and the film **starts at the day sheet**. Never imply a driver authenticated on camera.
2. **A stranger signing up, a signup form, or a self-serve quote flow.** No signup UI exists and it is counsel-blocked (doc 01 §5 demo 2; P-1 §5).
3. **A booking placed through Claude / MCP.** Never exercised end-to-end (doc 01 §5 demo 4; P-1 §5).
4. **Anything implying production sending.** Prod `EVIDENCE_FROM` is deliberately unbound and test-locked (`tools/deploy/preflight.test.ts:632`; `docs/ops/PROJECT-STATE.md:460`). The email in Film A is a **staging** send and the caption says so.
5. **The evidence-email specimen route (`?screen=email`).** It renders a fully fictional fixture that includes a person-shaped name and a real city + ZIP (`apps/portal/src/evidence-email.tsx:13-22`) — exactly the "plausible-looking fake data" P-1 §5 forbids in assets. It is also unreachable in a deployed build, falling through to the real board (`apps/portal/src/main.tsx:22-29`). Film the **actually delivered** email only.
6. **`?perf` mode, `fleet1k()`, or `demoFleet()`.** Deterministic synthetic fleets of 1,000 and 140 marks (`packages/map/src/demo.ts:107`, `:112`), routed in by `App.tsx:177-181`. They look magnificent and they are entirely invented. Never film them as the fleet.
7. **An exception being resolved, or the dim lifting.** There is no `exception.resolved` kind in the frozen 35 (`apps/command/src/views/ExceptionsQueue.tsx:6-11`); a lift would require hand-editing `status_cache`. Film B ends with the exception **open**.
8. **Any `at-risk` (amber-breathing) mark presented as live.** There is no at-risk projection and the board never fabricates one (`workers/api/src/routes/board.ts:45-53`) — an at-risk mark on camera can only have come from a fixture.
9. **The shadow-parity dashboard (`/parity`).** It depends on a live legacy-TMS mirror feed, which doc 01 §6 lists under EXTERNAL as absent. It would render empty or misleading.
10. **Rate or invoice parity against a real tariff.** Those gates are BLOCKED on private fixtures that do not exist in the repo (doc 01 §3; P-1 §5).
11. **Any real company, person, driver, receiver, DOT or MC number, address, phone number, email address, signature, or logo** — in the app, on a clipboard, on a truck door, on a badge, on a package label, or in browser chrome (REQ-167; P-1 §4.2). Includes a legible real signature on the glass in A5: sign an obviously synthetic mark.
12. **Terminals, `wrangler` output, the D1 console, DevTools, or the `?token=` URL.** None of it is product, and the last one is a credential.
13. **Any dollar figure framed as a carrier's revenue, savings, or ROI.** The invoice total in A8 is a synthetic staging amount and nothing else. Modeled ROI lives in A-3, labelled as arithmetic; it does not enter these films.
14. **The ⌘K copilot answering a question** (`apps/command/src/views/CopilotPanel.tsx`). Built, but LLM-backed — and A-1 don't #3 keeps automation out of the lead. Out of scope for A-2; revisit only with an explicit owner decision.

---

## 8. Capture mechanics

**Resolution and frame rate**
- Master at **3840×2160**, deliver **1920×1080**. The Command app is `position: fixed; inset: 0` (`apps/command/src/App.tsx:225`), so it fills the viewport exactly — set the browser window to 1920×1080 at DPR 2 and it composes with no letterboxing.
- **Capture at 60fps.** The exception stroke animates on a 1.6-second sine (`packages/map/src/pulse.ts:7`) and positions glide on a ~30fps throttled push (`MapCanvas.tsx:183`). A 30fps capture aliases the throb into a stutter. Motion blur off; no frame interpolation in the edit.
- Driver capture is native portrait phone screen recording, composited into a 1920×1080 `#1A1A1A` (`TOKENS.inkDark`) frame — the design ground, so the surround reads as intentional rather than as bars.

**Cursor**
- **Command (Film B): cursor visible.** It is an operator surface and the click into the exception row is the beat. But no synthetic click rings, no keystroke overlays, no zoom-follow effects. The app already sets `cursor: pointer` over marks (`MapCanvas.tsx:227-232`) — that's the only cursor feedback allowed.
- **Driver (Film A): no cursor.** Touch only. Do not add a synthetic tap indicator; if the device shows a native one, that's fine.
- Move the cursor **only when a beat calls for it**. B5's whole point is stillness.

**Identity hygiene on the frame**
- Every id in shot must be an obviously-synthetic placeholder: shipments `SHP-…`/`SMK-…`, invoices `INV-…`, parties `party-shipper` / `party-consignee` / `party-bill-to` (the forms already used at `tools/deploy/staging-smoke.ts:252`). If a city label is ever needed, use the generic public airport codes the fixtures use (`packages/map/src/demo.ts:32-35`) — geography, never an identity.
- **Two known frame artifacts to plan around, both hardcoded in components (do not edit code to fix them):**
  - The day sheet header renders a fixed string, `MON JUL 13 · n STOPS · PORTLAND LOOP` (`apps/driver/src/components/DaySheet.tsx:22`). It will contradict the shoot date and names a real city. Frame it out of a tight shot, or accept and caption it as a placeholder label.
  - A revealed stop's "address" line renders the stop's **coordinate**, `lat, lon` to four decimals (`apps/driver/src/App.tsx:41-47`). Since the fence must be re-seeded to the shoot location (§4.2 item 6), that is the shoot location's real coordinate, on camera. **Film in a neutral public location** — never a home or an office — or crop the address line.
- The email recipient address is necessarily real. Use a purpose-created inbox with a non-identifying local part, and crop or blur the account chrome (avatar, display name, folder list, other threads). No other message in the inbox may be legible.
- Browser: clean profile, no extensions, no bookmarks bar, no profile avatar, no second tab, no notification banners. macOS/Windows notifications off. Recording starts **after** the `?token=` strip (`apps/command/src/session.ts:92-102`).

**Audio**
- Silent, or one flat room tone. **No music bed, no voice-over on v1.** Captions carry every claim, so there is exactly one text to audit. If a VO is added later it reads §4.1 / §5.1 verbatim.

**Delivery**
- Two files, `A2-demo-01-signature-to-invoice.mp4` and `A2-demo-05-exception-pulse.mp4`, watermark burned in, head and tail cards attached, no separate "clean" export. A clean export will eventually be sent to someone who doesn't know it's staging.

---

## 9. Falsifier checks applied

- **(a) No shot depends on an unbuilt or blocked feature.** §1 lists every shot beside the doc-01 §5/§4 line that confirms it. The two films draw only on demo 1 (*"Complete; proven on live staging"*) and demo 5 (*"Most complete — full chain hash-verified"*). Demos 2, 3 and 4 are excluded in §0 and their tempting shots are explicitly banned in §7.1–7.3.
- **(b) Every named screen/component exists and was read.** All 21 file:line citations point at files opened read-only during this pass: `apps/command/src/App.tsx`, `views/{KpiStrip,ExceptionsQueue,MoneyQueue}.tsx`, `session.ts`, `lib/board.ts`; `apps/driver/src/App.tsx`, `components/{DaySheet,GatedFlow,CameraScreen,SignatureScreen,ProgressLine,Screen}.tsx`, `flow/stop-flow.ts`, `auth/session.ts`; `apps/portal/src/{App,main,evidence-email,router}.tsx/.ts`, `api/board.ts`, `views/InvoicesView.tsx`; `packages/map/src/{MapCanvas,LensPanel,entities,pulse,demo}.ts(x)`; `packages/agents/src/biller/evidence-email-view.tsx`; `packages/design/src/tokens.ts`; `workers/api/src/routes/{board,events,positions}.ts`, `middleware/cors.ts`; `tools/{seed/load,deploy/staging-smoke,acceptance/demos}.ts`; `docs/ops/DEPLOYMENT.md`.
- **(c) No caption claims customers, production usage, or a production timing.** Both tail cards use A-1's exact permitted status sentence. Caption A7 labels the timing **"Measured on staging, this take. Not a production figure"** on the same frame the number appears (A-1 don't #4, P-1 §4.4). Film B carries no timing figure at all.
- **(d) Nothing exceeds P-1 §5.** The films use three of the seven "Can be shown today" assets and add none. Each of P-1 §5's seven "Cannot be shown" items appears as a hard ban in §7 (login 7.1, signup 7.2, MCP booking 7.3, production email 7.4, tariff parity 7.10, real carrier/load/driver/invoice/dollar 7.11 + 7.13, promotable release — not claimed anywhere).
- **(e) No frame would show a real company, person, DOT number, or address.** §8 mandates synthetic ids throughout and bans real identity in-app and in the physical set; §7.5 bans the one route that ships a person-shaped name and a real city+ZIP; §8 flags and mitigates the two hardcoded artifacts (the `PORTLAND LOOP` label and the coordinate-as-address line) that would otherwise put a real place on camera; the necessarily-real email address is cropped.
- **Extra finding surfaced, not papered over:** the Command board is a one-shot fetch, so a "live" exception arrival is impossible without a reload. §5.2 films the reload rather than staging a fake live push, and offers the portal's 20-second poll as the honest live-arrival alternative.
