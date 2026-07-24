import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRegister } from "./register.js";

// REQ-118: orphan detector, both directions — spec'd-but-unbuilt and built-but-unspec'd.
export function findOrphans(input: { activeWps: string[]; sourceAnnotations: Set<string> }): {
  specdButUnbuilt: string[];
  builtButUnspecd: string[];
} {
  const rows = parseRegister();
  const known = new Set(rows.map((r) => r.req_id));
  const active = rows.filter(
    (r) => input.activeWps.some((wp) => r.wp.includes(wp)) && !["vNEXT", "CONFIRM-GATED"].includes(r.status),
  );
  return {
    specdButUnbuilt: active.filter((r) => !input.sourceAnnotations.has(r.req_id)).map((r) => r.req_id),
    builtButUnspecd: [...input.sourceAnnotations].filter((id) => !known.has(id)),
  };
}

export function scanSourceAnnotations(cwd = process.cwd()): Set<string> {
  // git grep across everything except governance prose: genesis docs cite every REQ,
  // plans discuss future-WP REQs, and CLAUDE.md/README/BUILD-PROMPT restate the law.
  // .claude/skills/** are governance/guidance too — a skill CITES REQs to teach, it does not
  // IMPLEMENT them, so its citations must not count as annotations (they would both mask a
  // genuinely-unbuilt active-WP REQ and, if a skill cited an unregistered REQ, false-fail the gate).
  // Implementation docs (docs/ops, docs/security, docs/wp) DO count — they are deliverables —
  // except for the exact governance framework/checklist, deferred coverage manifest, and audit history.
  const statusById = new Map(parseRegister(join(cwd, "genesis/09-REQUIREMENTS-REGISTER.csv")).map((row) => [row.req_id, row.status]));
  const result = spawnSync(
    "git",
    [
      "grep",
      "-I",
      "-l",
      "-z",
      "-E",
      "REQ-[0-9]{3}",
      "--",
      ".",
      ":(exclude)genesis",
      ":(exclude)docs/plans",
      ":(exclude)BUILD-PROMPT.md",
      ":(exclude)CLAUDE.md",
      ":(exclude)README.md",
      ":(exclude).claude",
      ":(exclude)tools/traceability/coverage-manifest.json",
      ":(exclude)docs/ops/V2-EXECUTION-FRAMEWORK.md",
      ":(exclude)docs/ops/GO-LIVE-CHECKLIST.md",
      ":(exclude)docs/audits",
    ],
    { cwd, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git grep failed in ${cwd} with status ${String(result.status)}: ${result.stderr.trim()}`);
  }

  const annotations = new Set<string>();
  for (const relativePath of result.stdout.split("\0").filter(Boolean)) {
    const normalizedPath = relativePath.replace(/\\/g, "/");
    const docsWp = normalizedPath.startsWith("docs/wp/");
    const ids = readFileSync(join(cwd, relativePath), "utf8").match(/REQ-\d{3}/g) ?? [];
    for (const id of ids) {
      const status = statusById.get(id);
      if (docsWp && (status === "vNEXT" || status === "CONFIRM-GATED")) continue;
      annotations.add(id);
    }
  }
  return annotations;
}

function main(): void {
  const wpFlag = process.argv.indexOf("--wp");
  const activeWps =
    wpFlag > -1 && process.argv[wpFlag + 1]
      ? [process.argv[wpFlag + 1] as string]
      : (JSON.parse(readFileSync("tools/traceability/active-wps.json", "utf8")) as { active: string[] }).active;
  const orphans = findOrphans({ activeWps, sourceAnnotations: scanSourceAnnotations() });
  if (orphans.builtButUnspecd.length > 0) {
    console.error(`FAIL built-but-unspec'd (annotations citing no register row): ${orphans.builtButUnspecd.join(", ")}`);
  }
  if (orphans.specdButUnbuilt.length > 0) {
    console.error(`FAIL spec'd-but-unbuilt (active-WP REQs with zero annotations): ${orphans.specdButUnbuilt.join(", ")}`);
  }
  if (orphans.builtButUnspecd.length + orphans.specdButUnbuilt.length > 0) process.exit(1);
  console.log(`traceability: no orphans in either direction (active: ${activeWps.join(", ")})`);
}
if (process.argv[1]?.endsWith("orphans.ts")) main();
