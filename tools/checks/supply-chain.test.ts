import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-118 §593 — THE TWO WORKSPACE LEVERS THAT RUN OR REPLACE CODE ARE ALLOWLISTS, AND GROWTH IS REVIEWED.
//
// §592 established that the lockfile is the dependency guarantee and `--frozen-lockfile` its enforcement.
// Two levers in `pnpm-workspace.yaml` sit OUTSIDE that guarantee, because both are decisions the lockfile
// faithfully records rather than constrains:
//
//   • `allowBuilds` — pnpm blocks dependency install scripts by default; every entry here is a package
//     granted ARBITRARY CODE EXECUTION at install time, on CI and on every developer machine. This is the
//     npm ecosystem's primary supply-chain execution vector.
//   • `overrides` — silently replaces a transitive dependency's version tree-wide. Legitimate (the chai pin
//     below exists because chai@6's `use` export does not resolve under workerd), and equally the way a
//     package gets quietly downgraded to a vulnerable version.
//
// The posture is already right: default-deny, two builds permitted, `sharp` explicitly denied. DELETION is
// self-enforcing — remove `allowBuilds` and pnpm blocks esbuild/workerd, and the install fails loudly.
// **Growth is not.** Adding a line is invisible in review unless something makes it a decision, and that is
// all this file does: it turns an addition into a failing test with a message explaining what is being
// granted. §571 made the same argument for tenant-source allowlists — an allowlist is right, and its growth
// is the review moment worth manufacturing.
//
// A flat regex parse rather than a YAML dependency: the block is two levels deep and adding a parser to read
// four lines would itself widen the dependency surface this file exists to watch.

function workspaceYaml(): string {
  return readFileSync(`${repoRoot()}/pnpm-workspace.yaml`, "utf8");
}

/** Entries of a flat `key:\n  name: value` block, comments stripped. */
function blockEntries(yaml: string, key: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === `${key}:`);
  if (start < 0) return out;
  for (const raw of lines.slice(start + 1)) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (line.trim() === "") continue;
    if (!/^\s+\S/.test(line)) break; // dedent — the block ended
    const m = /^\s+([\w@/.-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) out.set(m[1]!, m[2]!.replace(/^["']|["']$/g, ""));
  }
  return out;
}

describe("REQ-118 §593: install-time code execution is allowlisted", () => {
  const yaml = workspaceYaml();

  it("parses both blocks (non-vacuity)", () => {
    // A renamed key or a restructured file would yield empty maps and pass over them — the class this repo
    // met in eight gates (§487/§554/§572/§584/§586/§590/§592).
    expect(blockEntries(yaml, "allowBuilds").size, "allowBuilds did not parse — the file moved, not the policy").toBeGreaterThan(2);
    expect(blockEntries(yaml, "overrides").size, "overrides did not parse").toBeGreaterThan(0);
  });

  it("exactly two packages may run install scripts, and sharp stays denied", () => {
    const builds = blockEntries(yaml, "allowBuilds");
    const permitted = [...builds].filter(([, v]) => v === "true").map(([k]) => k).sort();
    expect(
      permitted,
      "a package was granted install-script execution. Every name here can run arbitrary code on CI and on " +
        "every developer machine at `pnpm install`. If the addition is genuinely needed (a native binary), " +
        "add it here WITH a comment naming what it builds and why a prebuilt binary will not do:\n  " +
        permitted.join(", "),
    ).toEqual(["esbuild", "workerd"]);
    // Denials are load-bearing too: `sharp: false` records a decision, and losing the line reverts it to
    // pnpm's default rather than to "denied".
    expect(builds.get("sharp"), "the explicit sharp denial disappeared").toBe("false");
  });

  it("the version overrides are exactly the one documented pin", () => {
    const overrides = blockEntries(yaml, "overrides");
    expect(
      [...overrides.keys()].sort(),
      "a transitive dependency version was overridden tree-wide. That is how a package gets quietly " +
        "downgraded; each entry needs a comment stating the runtime reason, as the chai pin does",
    ).toEqual(["chai"]);
  });
});
