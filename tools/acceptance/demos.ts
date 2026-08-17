// THE FIVE-DEMO ACCEPTANCE SPINE (REQ-119 DoD) — the single source of truth shared by the runner
// (run.ts) and the manifest (docs/wp/acceptance-demos.md), so the two can never drift.
//
// genesis/08:70 makes WP-16's DoD "the five doc-00 acceptance tests pass on video"; genesis/14:52
// promises "Playwright e2e scripted to the five acceptance demos". That DoD is TWO-TIER:
//   (1) the in-repo SPINE — the causal-chain proof already built per demo (the code-provable half), and
//   (2) the FILMED tenant-0 video — the wall-clock / real-hardware / real-Claude / visual half the spine
//       deliberately REFUSES to fabricate.
// This module names, per demo, exactly which in-repo spine test(s) are the code-provable half. The FILMED
// delta lives beside each demo (`filmed`) and is expanded, section by section, in the manifest.

/** A spine test file, addressed by its workspace package + a path RELATIVE to that package. The relative
 * path doubles as a vitest filename filter (an unambiguous tail of the absolute test path). */
export interface SpineTest {
  /** The pnpm workspace package the test lives in (the `pnpm --filter` target). */
  readonly pkg: string;
  /** Test file path relative to `pkg` — also the vitest positional filter. */
  readonly file: string;
}

export interface Demo {
  /** 1-based demo number, matching doc-00's five acceptance tests. */
  readonly n: number;
  readonly title: string;
  /** The code path the demo exercises (human-readable, for the manifest + the runner banner). */
  readonly codePath: string;
  /** The in-repo causal-chain spine test(s) — the half that IS asserted in-repo. */
  readonly spine: readonly SpineTest[];
  /** The FILMED half — what the tenant-0 video must ADDITIONALLY show that the spine cannot assert. */
  readonly filmed: string;
  /** A browser-drivable acceptance spec IF one is tractable in-repo, else null (documented-deferred). */
  readonly browser: string | null;
}

export const DEMOS: readonly Demo[] = [
  {
    n: 1,
    title: "POD → invoice + evidence email (same second)",
    codePath: "gated driver flow → pod.signed → AGENT_QUEUE → Biller (invoice.issued + evidence email)",
    spine: [{ pkg: "@shuddl/api", file: "test/heartbeat.test.ts" }],
    filmed:
      "the <5s wall-clock: p95 POD→email latency on the real substrate (Cloudflare Queues delivery + real " +
      "Resend send). The spine asserts the causal chain is complete + code-path-real, but refuses to " +
      "fabricate a latency number (heartbeat.test.ts HONESTY NOTE). " +
      "CONSTRAINT (audit §178): CLAUDE.md phrases this demo as 'invoice + PHOTOS in the client's inbox', " +
      "and REQ-087's DoD names 'sig/pallet photos' — but the email ships with `photos: {}` today " +
      "(workers/agents/src/biller.ts:600@photos; the R2 signed-URL resolver is unwired, GO-LIVE-CHECKLIST " +
      "§'Photos absent from evidence email'). The view renders real <img> when given URLs and a " +
      "documentary placeholder when not, so the film will show PLACEHOLDER SLOTS, not photographs. " +
      "Film it as 'invoice + evidence email' — or land the resolver first. Do not stage photos into the " +
      "capture to make the film match the sentence.",
    browser: null, // full-DO queue+Resend latency is not browser-drivable in-repo — integration spine + filmed.
  },
  {
    n: 2,
    title: "a stranger signs up and quotes (<10 min)",
    codePath: "POST /pub/signup (claims a pool slot) → POST /v1/import → POST /v1/rate (a real priced SELL)",
    spine: [{ pkg: "@shuddl/api", file: "test/signup-to-quote.e2e.test.ts" }],
    filmed:
      "the <10-minute wall-clock of a real stranger, unassisted, from landing to first quote. The spine " +
      "proves the flags-ON priced write-path through the sequencer AND the flag-OFF DARK 404. " +
      "PREREQUISITE (audit §237): THERE IS NO SIGNUP SURFACE. `/pub/signup` is a raw JSON API and no " +
      "product surface calls it — verified exhaustively: no <form>, no email input and no submit handler " +
      "exists in apps/command, apps/driver, apps/portal or any worker, and there is no landing page in " +
      "this repo. So 'a stranger, unassisted, from landing' cannot be filmed today: the only way to sign " +
      "up is to hand-issue HTTP requests, which is neither unassisted nor a demonstration of a product. " +
      "This is disclosed elsewhere ONLY as a browser-TEST gap (the `browser: null` note below), which is " +
      "why it reads as a coverage limitation rather than the filming blocker it is. Film demo 2 only " +
      "after a signup surface exists — or film it honestly as an API walkthrough and say so. Do not film " +
      "an operator typing curl and narrate it as a stranger signing up, which is the same fault as " +
      "staging photos into demo 1 or staging a login into demo 3. (The flag/legal prerequisites the " +
      "manifest already names — PROVISIONING_ENABLED on, ToS/CONFIRM-2 in place — still stand.)",
    browser: null, // no in-repo browser signup SURFACE exists (signup is a raw /pub/signup API) — see manifest gap.
  },
  {
    n: 3,
    title: "a real driver completes a gated stop with zero instruction",
    codePath: "the pure per-stop gate machine + the real-sequencer offline merge (2 devices, 55 events)",
    spine: [
      { pkg: "@shuddl/driver", file: "src/flow/stop-flow.test.ts" },
      { pkg: "@shuddl/api", file: "test/airplane-soak.test.ts" },
    ],
    filmed:
      "the REAL driver, on a REAL device, completing a REAL gated stop with zero instruction (REQ-006/164) " +
      "— live camera frame, signature on glass, GPS inside the fence. The spine proves the gate order + the " +
      "loss-free/dup-free offline merge; the browser layer proves the zero-instruction SHAPE + the gate BLOCK. " +
      "PREREQUISITES (audit §196) — this is the demo most blocked by absent capability, and neither block is " +
      "visible from this file otherwise. (1) THERE IS NO DRIVER LOGIN: REQ-069 is deferred and only a " +
      "per-device P-256 key exists — no magic-link, no PIN, no lockout — so a real driver cannot authenticate " +
      "at all today (GO-LIVE-CHECKLIST, Driver auth + lockout deferred). (2) A PICKUP CUSTODY HANDOFF CANNOT " +
      "RECORD REAL PARTIES: the capture layer fails CLOSED with CAPTURE_INPUT_MISSING rather than fabricating " +
      "them, and the manifest carries no real pair to supply — graded HIGH for any real driver run, and gated " +
      "on REQ-069 as well. Film demo 3 only after REQ-069 lands: a staged login would make the film assert an " +
      "identity the product cannot verify, which is the same fault as staging photos into demo 1.",
    browser: null, // deferred: the gated-stop SHAPE + gate-BLOCK browser spec (hardware-free, mocked camera/GPS/signature seams) is the documented next in-repo increment (manifest §Browser layer).
  },
  {
    n: 4,
    title: "a booking placed from Claude via MCP",
    codePath: "OAuth grant → mint → dispatch → chokepoint → quote_freight + book_shipment (accept-quote only)",
    spine: [{ pkg: "@shuddl/mcp", file: "test/quote-book.test.ts" }],
    filmed:
      "the REAL Claude-via-MCP booking against the full DO-backed api (a deferred STAGING smoke). The spine " +
      "proves the exact verb set + the no-bypass invariant over a recording-fake api seam.",
    browser: null, // full-DO cross-worker booking is not in-repo browser-drivable — integration spine + filmed.
  },
  {
    n: 5,
    title: "the exception pulse dims the map while everything else stays quiet",
    codePath: "exception.raised → status_cache projection → GET /v1/board status:'exception' → map world-dim",
    spine: [
      { pkg: "@shuddl/api", file: "test/command-heartbeat.test.ts" },
      { pkg: "@shuddl/map", file: "test/MapCanvas.test.tsx" },
    ],
    filmed:
      "the VISUAL capture: the greige world dropping to 35% around the one pulsing coral mark. The spine " +
      "proves the real exception→board status AND the world-dim wiring; the browser layer proves the " +
      "world-dim FIRES/LIFTS in a real browser (the behavioral half the screenshot diff doesn't cover).",
    browser: null, // deferred: the real-browser world-dim on/off spec (the behavioral half the screenshot diff misses) is the documented next in-repo increment (manifest §Browser layer).
  },
];

/** The spine tests grouped by package (dedup-preserving), for the runner's per-package vitest invocation. */
export function spineByPackage(): Map<string, string[]> {
  const byPkg = new Map<string, string[]>();
  for (const demo of DEMOS) {
    for (const { pkg, file } of demo.spine) {
      const files = byPkg.get(pkg) ?? [];
      if (!files.includes(file)) files.push(file);
      byPkg.set(pkg, files);
    }
  }
  return byPkg;
}

/** Total distinct spine files (7: four in @shuddl/api, one each in driver/mcp/map). */
export function spineFileCount(): number {
  return [...spineByPackage().values()].reduce((n, files) => n + files.length, 0);
}
