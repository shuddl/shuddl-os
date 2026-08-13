import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
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

// §1301 — THE SECOND INSTANCE, found by checking §1300's own closing claim.
//
// §1300 called the billing seam "the fifth and last member" of the unobservable family. It is not. The MCP
// worker POSTs four `/v1/*` paths to the same api worker as bare literals (`/v1/rate`, `/v1/parties`,
// `/v1/shipments`, `/v1/whoami`), and `mcp-api-seam.test.ts` (§983) does NOT cover this: it proves every tool
// routes THROUGH the service binding and issues no raw `fetch` — a structural property — while saying nothing
// about whether the paths those tools name actually exist. Rename `/v1/whoami` in the api and MCP's identity
// call 404s at runtime with both suites green, exactly as the billing seam would have.
//
// Same gate, second seam. The api side is read from the route modules rather than one file, because /v1 routes
// are mounted across many `mount*Routes` functions.
const MCP_SRC = "workers/mcp/src";
const API_ROUTES_DIR = "workers/api/src/routes";

function mcpCalledPaths(root: string): string[] {
  const files = execSync('git ls-files "workers/mcp/src/**/*.ts" "workers/mcp/src/*.ts"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f !== "" && !f.includes(".test."));
  const out = new Set<string>();
  for (const f of files) {
    for (const m of readFileSync(`${root}/${f}`, "utf8").matchAll(/path:\s*"(\/v1\/[^"]+)"/g)) out.add(m[1]!);
  }
  return [...out].sort();
}

function apiMountedV1Paths(root: string): string[] {
  const files = execSync(`git ls-files "${API_ROUTES_DIR}/*.ts" "workers/api/src/index.ts"`, { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f !== "" && !f.includes(".test."));
  const out = new Set<string>();
  for (const f of files) {
    for (const m of readFileSync(`${root}/${f}`, "utf8").matchAll(/\.(?:get|post|put|patch|delete)\("(\/v1\/[^"]*)"/g)) out.add(m[1]!);
  }
  return [...out].sort();
}

describe("§1301 REQ-030: every /v1 path the MCP worker calls is a route the api mounts", () => {
  const root = repoRoot();

  it("both sides parse (non-vacuity)", () => {
    expect(mcpCalledPaths(root).length, `no path: "/v1/…" literals found under ${MCP_SRC} — parser stale`).toBeGreaterThanOrEqual(3);
    expect(apiMountedV1Paths(root).length, "no /v1 routes parsed from the api — parser stale, not the tree").toBeGreaterThanOrEqual(10);
  });

  it("no MCP tool names a /v1 path the api does not mount", () => {
    const mounted = apiMountedV1Paths(root);
    // A mounted `/v1/shipments/:id/x` covers a called `/v1/shipments/abc/x`: compare on the literal prefix
    // before any parameter segment, which is what a rename would change.
    const covers = (called: string): boolean =>
      mounted.some((m) => {
        const mp = m.split("/:")[0]!;
        return called === m || called.startsWith(`${mp}/`) || called === mp;
      });
    const orphans = mcpCalledPaths(root).filter((c) => !covers(c));
    expect(
      orphans,
      "an MCP tool POSTs a /v1 path the api worker does not mount. Both suites stay GREEN — mcp-api-seam " +
        "(§983) proves the tools route THROUGH the binding, never that the paths exist — and the tool 404s the " +
        "first time a model calls it:\n  " +
        orphans.join("\n  "),
    ).toEqual([]);
  });
});

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
