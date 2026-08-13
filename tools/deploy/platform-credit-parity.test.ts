import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "../checks/repo-root.js";

// §1300 (REQ-123/154) — THE PLATFORM-CREDIT CONTRACT SPANS TWO WORKERS AND NOTHING WATCHED IT.
//
// `workers/billing` reaches the api sequencer over the `API` service binding, POSTing two internal paths with a
// shared-secret header. `workers/api` declares those routes and reads that header. The two sides are FOUR
// independent string literals in two packages with no shared constant — and no test spans both: billing's
// suite drives a fake `Fetcher` (§1291), the api's calls its routes directly. Rename the route on either side
// and every credit purchase fails AT RUNTIME with both suites green.
//
// That is the §1226 shape (one fact written twice, nothing notices divergence) in the category §1274/§1293–
// §1299 kept surfacing: a property no unit suite can observe because the failure only exists when the two
// deployed workers talk. This repo already answers that with parity gates — CORS origins, GL accounts, enums,
// tenant slugs, wrangler scopes — and this is the same gate for the money seam.
//
// Both sides are read as TEXT on purpose: importing the billing module into a node-environment tools test drags
// in the Workers `Fetcher` types, and the artifact under test is the literal that ships (§1245's reasoning).

const SENDER = "workers/billing/src/platform-ledger.ts";
const ROUTES = "workers/api/src/routes/internal-platform.ts";

const read = (root: string, rel: string): string => readFileSync(`${root}/${rel}`, "utf8");

/** The paths the billing worker POSTs, from its own path constants. */
function sentPaths(src: string): string[] {
  return [...src.matchAll(/^const CREDIT_\w+_PATH = "([^"]+)";/gm)].map((m) => m[1]!).sort();
}
/** The internal paths the api worker actually mounts. */
function declaredPaths(src: string): string[] {
  return [...src.matchAll(/app\.post\("(\/internal\/[^"]+)"/g)].map((m) => m[1]!).sort();
}
/** The shared-secret header name, as each side spells it. */
function headerOf(src: string): string[] {
  return [...new Set([...src.matchAll(/"(X-Platform-[\w-]+)"/g)].map((m) => m[1]!))].sort();
}

describe("§1300 REQ-123: the platform-credit seam agrees across the two workers", () => {
  const root = repoRoot();
  const sender = read(root, SENDER);
  const routes = read(root, ROUTES);

  it("both sides parse (non-vacuity — an empty side would make every comparison below hold)", () => {
    expect(sentPaths(sender).length, `no CREDIT_*_PATH constants found in ${SENDER} — this gate's parser is stale`).toBeGreaterThanOrEqual(2);
    expect(declaredPaths(routes).length, `no /internal/ routes found in ${ROUTES} — parser stale, not the tree`).toBeGreaterThanOrEqual(2);
    expect(headerOf(sender).length, "no X-Platform-* header literal in the sender").toBe(1);
    expect(headerOf(routes).length, "no X-Platform-* header literal in the routes").toBe(1);
  });

  it("every path the billing worker POSTs is a route the api worker mounts", () => {
    const sent = sentPaths(sender);
    const declared = declaredPaths(routes);
    const orphans = sent.filter((p) => !declared.includes(p));
    expect(
      orphans,
      "the billing worker POSTs an internal path the api worker does not mount. Both suites stay GREEN (billing " +
        "drives a fake Fetcher, the api calls its routes directly) and EVERY credit purchase fails at runtime:\n  " +
        orphans.join("\n  ") +
        `\n\nKeep ${SENDER} and ${ROUTES} in step.`,
    ).toEqual([]);
  });

  it("the api mounts no internal credit route the billing worker never calls (dead seam, both directions)", () => {
    // The reverse direction matters less but is not free: a mounted, secret-gated route nobody calls is
    // attack surface with no owner. Restricted to the credit paths this seam owns.
    const credit = declaredPaths(routes).filter((p) => p.includes("credit-"));
    const unused = credit.filter((p) => !sentPaths(sender).includes(p));
    expect(unused, `the api mounts a credit route no caller uses — remove it or wire it:\n  ${unused.join("\n  ")}`).toEqual([]);
  });

  it("the shared-secret header is spelled identically on both sides", () => {
    expect(
      headerOf(sender)[0],
      "the two workers disagree on the shared-secret header name. The api answers 403 to every credit append " +
        "and nothing appends — with both suites green, because neither crosses the binding.",
    ).toBe(headerOf(routes)[0]);
  });
});
