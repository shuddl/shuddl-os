# The five acceptance demos — in-repo spine + filmed-video manifest (REQ-119)

**DoD (genesis/08:70):** "the five doc-00 acceptance tests pass on video." **This is two-tier.**

- **The in-repo SPINE** — the causal-chain proof, already built per demo and run as one named set by `pnpm test:acceptance` (`tools/acceptance/run.ts`, source-of-truth `tools/acceptance/demos.ts`). Green ⇒ the code-provable half holds on the current tree.
- **The FILMED tenant-0 video** — the wall-clock / real-hardware / real-Claude / visual half the spine deliberately **refuses to fabricate** (e.g. `heartbeat.test.ts` asserts the POD→email chain is complete but never invents a latency number). These are launch-gate calendar objects on tenant-0's real freight (genesis/13:40), filmed with identity per the consent gate — **a merge cannot close them.**

`pnpm test:acceptance` runs each spine test in its OWN package's vitest config (the api/mcp pools are `vitest-pool-workers`, driver is node, map is jsdom — they can't share one root config) and is red on any genuine failure OR a typo'd filter (vitest exits non-zero on "no test files found", so a silent no-op can't pass).

## Per-demo: in-repo spine ↔ filmed delta

### Demo 1 — POD → invoice + evidence email (same second)
- **Code path:** gated driver flow → `pod.signed` → `AGENT_QUEUE` → the Biller (`invoice.issued` + evidence email through the real DO).
- **In-repo spine:** `workers/api/test/heartbeat.test.ts` (the full causal chain, every real seam).
- **Filmed delta:** the **<5s wall-clock** — p95 POD→email latency on the real substrate (Cloudflare Queues delivery + a real Resend send). The spine proves the chain is complete + code-path-real; it refuses to fabricate the latency (heartbeat.test.ts HONESTY NOTE).
- **⚠ CONSTRAINT — the "+ photos" half does not ship yet (audit §178).** `CLAUDE.md` phrases this demo as *"signature at a door → invoice **+ photos** in the client's inbox <5s"*, and REQ-087's DoD names *"sig/pallet photos"* — but the Biller passes `photos: {}` (`workers/agents/src/biller.ts:584@photos`); the R2 signed-URL resolver is unwired, tracked as a **Med** in `docs/ops/GO-LIVE-CHECKLIST.md`. The email view renders real `<img>` when given URLs and a documentary placeholder when not — its own suite in `packages/agents` covers that in 3 cases including a caption-swap trap (deliberately named without a path: `demos.test.ts` treats any test-file path in this manifest as a claimed acceptance-spine file, and that suite is not one) — so **the film will show placeholder slots, not photographs.** Film demo 1 as *"invoice + evidence email"*, or land the resolver first. **Do not stage photos into the capture to make the film match the sentence** — the whole point of the spine/filmed split is that neither half is allowed to assert what it did not observe.

### Demo 2 — a stranger signs up and quotes (<10 min)
- **Code path:** `POST /pub/signup` (claims a pool slot, flag-gated) → `POST /v1/import` → `POST /v1/rate` (a real priced SELL).
- **In-repo spine:** `workers/api/test/signup-to-quote.e2e.test.ts` (the flags-ON priced write-path through the sequencer **and** the flag-OFF DARK 404).
- **Filmed delta:** the **<10-minute wall-clock** of a real stranger, unassisted, from landing to first quote (+ the live parse, ToS/CONFIRM-2, `PROVISIONING_ENABLED` flipped on).

### Demo 3 — a real driver completes a gated stop with zero instruction
- **Code path:** the pure per-stop gate machine + the real-sequencer offline merge (2 devices, 55 signed events, loss-free/dup-free).
- **In-repo spine:** `apps/driver/src/flow/stop-flow.test.ts` (the gate order) + `workers/api/test/airplane-soak.test.ts` (the offline merge through the real DO).
- **Filmed delta:** the **real driver, on a real device, zero-instruction** (REQ-006/164) — live camera frame, signature on glass, GPS inside the fence.
- **⚠ PREREQUISITES — this demo cannot be filmed today (audit §196).** Two blocking gaps, neither visible from the demo definition:
  1. **There is no driver login.** REQ-069 is deferred; only a per-device P-256 key exists — no magic-link, no PIN, no lockout (`docs/ops/GO-LIVE-CHECKLIST.md`, *Driver auth + lockout deferred*). **A real driver cannot authenticate at all.**
  2. **A pickup custody handoff cannot record real parties.** The capture layer fails CLOSED with `CAPTURE_INPUT_MISSING` rather than fabricating them, and the driver manifest carries no real pair to supply — graded **High for any real driver run**, and itself gated on REQ-069.

  Film demo 3 **only after REQ-069 lands**. Staging a login to get the shot would make the film assert an identity the product cannot verify — the same fault as staging photos into demo 1, and the reason the spine/filmed split exists.

### Demo 4 — a booking placed from Claude via MCP
- **Code path:** OAuth grant → mint → dispatch → chokepoint → `quote_freight` + `book_shipment` (stops at accept-quote; the gated `booking.created` is the Booking agent's).
- **In-repo spine:** `workers/mcp/test/quote-book.test.ts` (the exact verb set + the no-bypass invariant over a recording-fake api seam — the full DO-backed booking is a deferred STAGING smoke, aux-worker isolation).
- **Filmed delta:** the **real Claude-via-MCP booking against the full DO-backed api** on the tenant-0 sandbox (mcp worker deployed, OAuth secret store, per-pairing caps provisioned).

### Demo 5 — the exception pulse dims the map while everything else stays quiet
- **Code path:** `exception.raised` → status_cache projection → `GET /v1/board` `status:'exception'` → map world-dim.
- **In-repo spine:** `workers/api/test/command-heartbeat.test.ts` (real exception→board status, whole chain hash-verified) + `packages/map/test/MapCanvas.test.tsx` (world-dim wired-on automatically). The most fully in-repo-covered demo.
- **Filmed delta:** the **visual capture** — the greige world dropping to ~35% around the one pulsing coral mark.

## Browser layer (`Playwright e2e`, genesis/14:52) — the documented remaining in-repo increment
The in-repo spine (above) proves every demo's causal chain. genesis/14:52 also promises "Playwright e2e scripted to the five acceptance demos"; today Playwright runs ONLY the 5-screenshot visual diff (`tests/visual/screens.spec.ts`, advisory via `tools/harness/playwright-guard.ts` — self-skips, exits 0 unless `--strict`). The browser layer is scoped as the next increment and recorded here honestly rather than faked:

- **Demo 5 (map world-dim)** — the strongest browser candidate: drive the Command app and assert the map world-dims when an exception mark is present, and lifts when it clears (the behavioral half the screenshot diff doesn't cover). The dev-server boot already exists in `playwright.config.ts`.
- **Demo 3 (gated stop)** — drive the Driver PWA gated flow with camera/GPS/signature **mocked** exactly as `GatedFlow.test.tsx` mocks them (no live hardware): the zero-instruction SHAPE + the gate BLOCK on a missing precondition.
- **Demo 2 (signup→quote)** — **the concrete blocker:** the Playwright dev-servers boot with NO flag env, so `PROVISIONING_ENABLED` is off and `/pub/signup` 404s. A browser signup→quote run first needs the API worker booted with `PROVISIONING_ENABLED=true` (a wrangler `--var` / `.dev.vars` / a `webServer` env in `playwright.config.ts`). That flags-on dev-server wiring does not exist yet — it is the specific in-repo gap to close before a browser demo-2 is possible.
- **Demos 1 & 4** are NOT browser-drivable in-repo (demo 1's `<5s` is a real-substrate latency measurement; demo 4's full-DO Claude booking is a cross-worker staging smoke) — they stay integration-spine + filmed.

When built, the browser acceptance specs should be **blocking** (the guard's `--strict`, or a dedicated `test:acceptance:e2e`), not advisory.

## The filmed-video launch-gate checklist (out-of-repo — a merge cannot close these)
On tenant-0's real freight, with identity handled per the consent gate (genesis/13:40; the M-OPS / M-PRODUCT milestone videos, genesis/14:56-62):
1. Demo 1 — POD→invoice+email, timed **<5s** on the real Queues + Resend substrate (prod sender verified + warmed, REQ-157).
2. Demo 2 — a stranger, unassisted, signup→quote in **<10 min** (`PROVISIONING_ENABLED` on, ToS/CONFIRM-2 in place).
3. Demo 3 — a **real driver**, zero instruction, completing a gated stop on real hardware (REQ-006/164 pilot).
4. Demo 4 — a **real Claude-via-MCP booking** against the deployed DO-backed api (the staging smoke).
5. Demo 5 — the **visual** exception-pulse world-dim, captured on the live board.
