import { describe, expect, it } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §983 — EVERY MCP TOOL REACHES THE LEDGER THROUGH THE API SERVICE BINDING, NEVER AROUND IT.
//
// CLAUDE.md rule 3: "Gates are server-side (Gatekeeper); UIs merely reflect them. Any flow reachable by API
// must enforce the same gate (REQ-030)." MCP is the surface where that is hardest to hold, because it is
// driven by a language model rather than a UI — a tool that talked to D1 or a queue directly would bypass
// every /v1 gate while still looking like a normal tool.
//
// It does not. `workers/mcp/src/index.ts:72` dispatches through `env.API.fetch(request)` — a service binding
// that runs the api worker's own Hono app in-process and returns its Response untouched, so auth,
// idempotency and the Gatekeeper run for an MCP caller exactly as for a browser. MEASURED AT §983: all
// **6** tool modules route through that seam (`quote`, `book`, `approve`, `dispute` via `mutatingCallApi`;
// `track`, `document` via `callApi`), and **no tool contains a raw `fetch(`**.
//
// The `mutatingCallApi` variant is the stronger half: a tool that declares `mutating: false` but writes has
// no chokepoint, so its context is never cleared and the call THROWS rather than silently skipping caps and
// confirm. That is the append-chokepoint pattern (REQ-030) applied to the MCP surface.
//
// This was enforced by nothing. A seventh tool added tomorrow with a direct binding call would pass every
// existing test — `workers/mcp/test/parity.test.ts` proves REST ≡ MCP for the tools that EXIST, which is a
// different claim from "no tool escapes the seam".
//
// SCOPE: this checks the DISPATCH PATH, not what the api does with the request. The gates themselves are
// api-side and covered there; what this pins is that MCP cannot reach the ledger any other way.

const TOOLS_GLOB = "workers/mcp/src/tools/*.ts";
const SEAM = /\b(mutatingCallApi|callApi)\b/;

function toolModules(root: string): string[] {
  return globSync(TOOLS_GLOB, { cwd: root })
    .filter((f) => !f.endsWith("registry.ts")) // the registry DEFINES the seam; it does not consume it
    .sort();
}

describe("§983: no MCP tool bypasses the api service binding", () => {
  const root = repoRoot();
  const tools = toolModules(root);

  it("finds tool modules at all (non-vacuity — §968's rule)", () => {
    // A renamed tools/ directory would otherwise certify "no bypasses" over an empty set, which is the
    // failure this whole session has been about.
    expect(
      tools.length,
      `no MCP tool modules found under ${TOOLS_GLOB} — the glob is broken, not the surface`,
    ).toBeGreaterThanOrEqual(5);
  });

  it("every tool reaches the api through the seam", () => {
    const bypass = tools.filter((f) => !SEAM.test(readFileSync(`${root}/${f}`, "utf8")));
    expect(
      bypass,
      "MCP tool module(s) that never call `callApi` / `mutatingCallApi`:\n  " +
        bypass.join("\n  ") +
        "\n\nEvery MCP tool must reach the ledger through the api service binding, so that auth, idempotency " +
        "and the Gatekeeper run for a model-driven caller exactly as for a browser (CLAUDE.md rule 3, " +
        "REQ-030). A tool that talks to D1, a queue or the network directly bypasses all of them while " +
        "looking like a normal tool.",
    ).toEqual([]);
  });

  it("no tool issues a raw network fetch", () => {
    // The seam check above is satisfied by MENTIONING the helper; this closes the other half — a tool could
    // import it and still call out directly. Together they mean: the only route out is the binding.
    // ANYWHERE, not line-start. The first version anchored with /^\s*(?:await\s+)?fetch\(/m and a mutation
    // planting `){ await fetch("…") }` on one line went GREEN — a real bypass is far likelier inline
    // (`const r = await fetch(url)`) than at column zero. `(?<![.\w])` keeps `env.API.fetch(` exempt,
    // which is the sanctioned route, without exempting a bare global `fetch(`.
    const raw = tools.filter((f) => /(?<![.\w])fetch\(/.test(readFileSync(`${root}/${f}`, "utf8")));
    expect(
      raw,
      "MCP tool module(s) issuing a raw `fetch(`:\n  " +
        raw.join("\n  ") +
        "\n\nThe api service binding is the only sanctioned route out of the MCP worker. A raw fetch leaves " +
        "the in-process dispatch and therefore leaves every /v1 gate behind.",
    ).toEqual([]);
  });

  it("the seam itself still dispatches through the service binding", () => {
    // If `callApi` stopped using `env.API.fetch`, the two assertions above would keep passing while every
    // tool routed somewhere else — the §963 shape, where a guard is made vacuous by a change upstream of it.
    const entry = readFileSync(`${root}/workers/mcp/src/index.ts`, "utf8");
    expect(
      entry,
      "workers/mcp/src/index.ts no longer dispatches through `env.API.fetch` — the seam every tool routes " +
        "through has stopped being the api service binding, which makes the tool-level checks above vacuous.",
    ).toMatch(/env\.API\.fetch\(/);
  });
});
