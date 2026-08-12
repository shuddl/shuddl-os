import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { scanCorpus } from "./scan-corpus.js";

// REQ-156 §613 — genesis/14 §04: "API CONVENTIONS (every endpoint, no exceptions)".
//
// Two of that section's clauses are load-bearing and hold BY CONSTRUCTION rather than by review:
//
//   · "Base /v1" — every endpoint lives under it;
//   · "Idempotency-Key header required on all mutations (generalizes REQ-106 beyond MCP)".
//
// The mechanism is two lines in workers/api/src/index.ts: `app.use("/v1/*", auth)` and
// `app.use("/v1/*", idempotency)`. Every mutation mounted under /v1 gets both for free, which is exactly the
// right design — and it means the convention has precisely one escape hatch: **a mutation mounted somewhere
// else**. Such a route silently gets no idempotency (a retried POST double-appends) and no session auth.
//
// MEASURED when this landed: 24 mutating handlers, 19 under /v1, 5 outside — and all five are deliberate,
// documented, and separately guarded. This locks a clean state rather than repairing a defect (§486's cheap
// half), and it is the §598 shape: a chokepoint that holds today because everyone used it, with nothing
// making the next person.
//
// The pin is BY IDENTITY, not by count, for the reason §598 gave: a count lets one exception be swapped for
// another, and the whole value here is that each escape was argued for individually.

interface Handler {
  method: string;
  path: string;
  file: string;
}

function apiSources(root: string): string[] {
  // §624 — ONE glob: git pathspec `*` crosses `/`, so this already reaches routes/, middleware/, do/ and
  // pub/. The `**` variant that used to sit beside it added zero files (measured). scanCorpus fails if it
  // matches nothing, which is the non-vacuity floor the separate count used to approximate.
  return scanCorpus(["workers/api/src/*.ts"], root, { excludeTests: true });
}

/** Every `.post|put|patch|delete("<literal>"` in the api worker. */
function mutatingHandlers(root: string): Handler[] {
  const out: Handler[] = [];
  for (const f of apiSources(root)) {
    const src = readFileSync(`${root}/${f}`, "utf8");
    for (const m of src.matchAll(/\.(post|put|patch|delete)\(\s*"([^"]+)"/g)) {
      out.push({ method: m[1]!.toUpperCase(), path: m[2]!, file: f });
    }
  }
  return out;
}

/**
 * The mutations that legitimately sit outside /v1. Each is a decision with a reason, not an oversight.
 *
 * TWO RULES ARE BEING EXEMPTED HERE, NOT ONE (audit §1106). `app.use("/v1/*", …)` mounts BOTH `auth` and
 * `idempotency`, so leaving /v1 drops both — and every reason below argues only the AUTH half. A reader
 * adding a sixth entry on auth grounds alone would ship a mutation with NO retry protection, which for a
 * money door means a double-append. So the idempotency mechanism each one earns INDEPENDENTLY is recorded
 * here; all five were measured at §1106 and all five hold, by five DIFFERENT mechanisms:
 *
 *  · credit-append  — the caller supplies a DETERMINISTIC event id (`paymentEventIdFor(correlationId)` /
 *    `invoiceEventIdFor`, derived from the Stripe correlation id) and the sequencer dedupes by event id.
 *  · credit-settle  — a state transition that is a no-op once paid; it never invents a paid state.
 *  · /pub/signup    — the slug and admin email are unique; a repeat is a clean 409 (SLUG_TAKEN /
 *    EMAIL_TAKEN), never a second tenant.
 *  · /pub/quote     — appends NOTHING to the ledger ("guest may QUOTE, never BOOK"), so it is pure compute.
 *  · PUT pin        — not an app route at all (the sequencer DO's own fetch handler).
 *
 * ADDING A SIXTH ENTRY: state its idempotency mechanism here, or it does not belong on this list.
 *
 *  · /pub/quote, /pub/signup — a STRANGER has no token, which is the entire point of the PLG path (demo 2:
 *    "a stranger signs up and quotes in <10 min"). They cannot sit behind `app.use("/v1/*", auth)`.
 *  · /internal/platform/credit-* — the platform-ledger door, deliberately outside the customer-JWT surface so
 *    a customer token can NEVER reach a `_platform` append. Guarded by its own fail-closed shared secret
 *    (PLATFORM_INTERNAL_SECRET: 503 when unbound, 403 on mismatch, no oracle between them).
 *  · PUT pin — not an app route at all: the sequencer Durable Object's own fetch handler, unreachable from
 *    the public router.
 */
const SANCTIONED_NON_V1: readonly string[] = [
  "POST /internal/platform/credit-append",
  "POST /internal/platform/credit-settle",
  "POST /pub/quote",
  "POST /pub/signup",
  "PUT pin",
];

describe("REQ-156 §613: genesis/14 §04 API conventions hold by construction", () => {
  const root = repoRoot();

  it("finds the api worker's mutating handlers (non-vacuity)", () => {
    // A renamed directory or a changed router idiom would scan nothing and pass — the class this repo met in
    // twelve gates (§487/§554/§572/§584/§586/§590/§592/§593/§598/§607/§608/§611).
    expect(apiSources(root).length, "no api source found — the scan is broken, not the tree").toBeGreaterThan(30);
    expect(
      mutatingHandlers(root).length,
      "no mutating handlers found — the `.post(\"...\")` idiom changed and this gate now watches nothing",
    ).toBeGreaterThan(15);
  });

  it("the two lines the whole convention rests on are still there", () => {
    // §531 justified this as "no route-level test would notice". MEASURED (§832), and that is FALSE:
    // deleting the idempotency mount fails **8** api tests, deleting the auth mount fails **372**. Route-level
    // tests notice both, loudly.
    //
    // The gate is still worth having, for the reason the original note reached for and missed. Its value is
    // not that it is the ONLY thing watching — it is that it fails with ONE legible sentence naming the
    // missing line, instead of 372 opaque authentication failures a reader must reverse-engineer into
    // "someone deleted a middleware mount". A structural pin is a better ERROR MESSAGE, not a unique
    // detector, and stating that correctly matters in both directions: a gate believed to be the only guard
    // gets over-trusted, and one whose stated premise is visibly false gets deleted by the next person who
    // checks it.
    const index = readFileSync(`${root}/workers/api/src/index.ts`, "utf8");
    expect(index, 'app.use("/v1/*", auth) is gone — every /v1 route is now unauthenticated').toContain('app.use("/v1/*", auth)');
    expect(
      index,
      'app.use("/v1/*", idempotency) is gone — a retried POST now double-appends, and genesis/14 §04 requires ' +
        "the Idempotency-Key on all mutations",
    ).toContain('app.use("/v1/*", idempotency)');
  });

  it("§832: the middleware mounts PRECEDE every route mount — Hono composes in registration order", () => {
    // The convention rests on `app.use("/v1/*", …)` wrapping the routes, and in Hono a handler registered
    // BEFORE a middleware is not wrapped by it. So mount ORDER is load-bearing, and the assertions above only
    // check the lines EXIST. Measured: moving one `mount*Routes(app)` call above the `app.use` pair leaves
    // `test:tools` at its baseline — no tools gate saw it — while the api suite fails **150** tests. Loud, but
    // loud in the least useful way: 150 red assertions about capacity gates and airplane-mode sync, none of
    // which say "a route was mounted before its middleware".
    const index = readFileSync(`${root}/workers/api/src/index.ts`, "utf8");
    const lastUse = Math.max(
      index.indexOf('app.use("/v1/*", auth)'),
      index.indexOf('app.use("/v1/*", idempotency)'),
    );
    expect(lastUse, "neither /v1 middleware mount was found — the assertion above owns that diagnosis").toBeGreaterThan(0);

    const early = [...index.matchAll(/^mount\w+Routes\(app\);/gm)]
      .filter((m) => m.index < lastUse)
      .map((m) => m[0]);
    expect(
      early,
      'a route mount precedes `app.use("/v1/*", auth/idempotency)`. Hono composes matched handlers in ' +
        "REGISTRATION order, so these routes are never wrapped: no session auth and no idempotency, while " +
        "every other /v1 route keeps both. Move the mount below the middleware pair:",
    ).toEqual([]);
  });

  it("every mutation is under /v1, except the sanctioned few", () => {
    const outside = mutatingHandlers(root)
      .filter((h) => !h.path.startsWith("/v1"))
      .map((h) => `${h.method} ${h.path}`)
      .sort();
    expect(
      outside,
      "a mutating endpoint outside /v1. It gets NO idempotency (a retried POST double-appends) and NO session " +
        "auth, because both are mounted as `app.use(\"/v1/*\", …)`. genesis/14 §04 says 'every endpoint, no " +
        "exceptions'. If this one genuinely belongs outside, add it to SANCTIONED_NON_V1 with the reason and " +
        "name what guards it instead:\n  " +
        outside.join("\n  "),
    ).toEqual([...SANCTIONED_NON_V1].sort());
  });
});
// ── §850 — EVERY DRIVER SYNC FETCH DECLARES A REDIRECT POLICY ─────────────────────────────────────────
//
// §849 fixed a live defect: `transport.ts` called `fetch` with no `redirect` option, so the platform default
// `follow` applied and `res.status` was the FINAL response's — a captive portal's 302 → login page → 200,
// read as the sequencer's ack, dropping a signed capture. §850 classified all 24 production fetch sites and
// found the driver was the ONLY one exposed, because it is the only status-only trust on a network path.
//
// SCOPED TO `apps/driver/src/sync/` ON PURPOSE. A repo-wide rule would flag twenty-two correct sites — the
// §845 lesson that a gate flagging correct code gets turned off — and would be WRONG besides: everywhere
// else the right protection is validating the BODY, which is strictly stronger. `biller/sender.ts` needs no
// redirect option because an interceptor's response cannot produce a Resend id; the driver needs one
// precisely because the sequencer's 202 carries nothing to validate.

describe("§850: every fetch in the driver's sync path declares a redirect policy", () => {
  const root = repoRoot();

  function syncFetchSites(): Array<{ site: string; hasPolicy: boolean }> {
    const files = execSync('git ls-files "apps/driver/src/sync"', { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."));
    const out: Array<{ site: string; hasPolicy: boolean }> = [];
    for (const f of files) {
      const src = readFileSync(`${root}/${f}`, "utf8");
      const lines = src.split("\n");
      lines.forEach((raw, i) => {
        const line = raw.trim();
        if (line.startsWith("//") || line.startsWith("*")) return;
        if (!/\b(?:doFetch|fetchImpl|fetch)\s*\(/.test(line)) return;
        // The RequestInit follows the URL; look ahead to the end of the call.
        const window = lines.slice(i, i + 16).join("\n");
        out.push({ site: `${f}:${i + 1}`, hasPolicy: /redirect:\s*"(error|manual)"/.test(window) });
      });
    }
    return out;
  }

  it("the scan finds the sync fetches at all (non-vacuity)", () => {
    // A moved directory or a renamed transport would return [] and make the assertion below vacuous.
    const sites = syncFetchSites();
    expect(sites.length, "no fetch found under apps/driver/src/sync — the scan is stale, not the code").toBeGreaterThanOrEqual(2);
  });

  it("no sync fetch follows redirects", () => {
    const unguarded = syncFetchSites().filter((s) => !s.hasPolicy).map((s) => s.site);
    expect(
      unguarded,
      'a fetch in the driver\'s sync path does not declare `redirect: "error"`. The platform default is ' +
        "`follow`, and `res.status` is then the FINAL response's — so a captive portal on truck-stop or depot " +
        "wifi answering 302 → login page has its redirect followed, the login page returns 200, and the queue " +
        "reads that as the sequencer's ack and DROPS a signed capture that never arrived (§849). The API never " +
        "returns a 3xx, so a redirect here is always an interceptor:\n  " +
        unguarded.join("\n  "),
    ).toEqual([]);
  });
});
