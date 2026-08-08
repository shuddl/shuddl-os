import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

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
  return execSync('git ls-files "workers/api/src/*.ts" "workers/api/src/**/*.ts"', { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((f) => f && !f.includes(".test."));
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
 * The mutations that legitimately sit outside /v1. Each is a decision with a reason, not an oversight:
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
    // §531: a guard whose removal is silent will eventually be removed. Deleting either `app.use` line would
    // strip auth or idempotency from EVERY /v1 mutation at once, and no route-level test would notice —
    // each route would simply stop being wrapped.
    const index = readFileSync(`${root}/workers/api/src/index.ts`, "utf8");
    expect(index, 'app.use("/v1/*", auth) is gone — every /v1 route is now unauthenticated').toContain('app.use("/v1/*", auth)');
    expect(
      index,
      'app.use("/v1/*", idempotency) is gone — a retried POST now double-appends, and genesis/14 §04 requires ' +
        "the Idempotency-Key on all mutations",
    ).toContain('app.use("/v1/*", idempotency)');
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
