import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRegister } from "./register.js";

// REQ-118: orphan detector, both directions — spec'd-but-unbuilt and built-but-unspec'd.
function isDeferredStatus(status: string): boolean {
  const normalizedStatus = status.trim();
  return normalizedStatus === "vNEXT" || normalizedStatus === "CONFIRM-GATED";
}

export function findOrphans(input: { activeWps: string[]; sourceAnnotations: Set<string> }): {
  specdButUnbuilt: string[];
  builtButUnspecd: string[];
} {
  const rows = parseRegister();
  const known = new Set(rows.map((r) => r.req_id));
  const active = rows.filter(
    (r) => input.activeWps.some((wp) => r.wp.includes(wp)) && !isDeferredStatus(r.status),
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
  // docs/ops/PROJECT-STATE.md joins that exception list for the same reason: it is a status POINTER,
  // not a spec (its own header says so). It cites requirement ids to DESCRIBE state — including,
  // necessarily, the state "the whole V2 id range is not built" — so counting its citations would let a
  // sentence whose meaning is "this shipped nothing" stand as the evidence that code shipped. That is not
  // hypothetical: re-baselining it on 2026-07-27 added exactly one false annotation (the first V2 id) and
  // with it a phantom drift row. Rule for the next governance doc under docs/ops: if it records state
  // rather than implementing a requirement, it belongs here — and coverage.test.ts pins that both ways.
  // docs/ops/RELEASE-EVIDENCE.md is the next application of that rule (added 2026-07-27): it is a status
  // record too — a table of gates, most of them for requirements that are NOT built, whose rows read
  // "BLOCKED", "not vendored", "no such consumer exists". Exactly the sentence shape above. Before adding
  // it, every requirement id it cites was checked to survive on real source elsewhere (all of them do, in
  // 4+ non-excluded files each), so the exclusion drops no row's only annotation.
  // NOTE: never write a literal requirement id into this file or any other scanned source to illustrate
  // a point — this scanner reads itself, and the first draft of this very comment re-created the bug.
  const deferredById = new Map(
    parseRegister(join(cwd, "genesis/09-REQUIREMENTS-REGISTER.csv")).map((row) => [row.req_id, isDeferredStatus(row.status)]),
  );
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
      ":(exclude)docs/ops/PROJECT-STATE.md",
      ":(exclude)docs/ops/RELEASE-EVIDENCE.md",
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
      if (docsWp && deferredById.get(id) === true) continue;
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
