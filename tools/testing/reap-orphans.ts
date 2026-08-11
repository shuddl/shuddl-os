import { execFileSync } from "node:child_process";
import { repoRoot } from "../checks/repo-root.js";

// §1061 — REAP `workerd` PROCESSES THIS REPO'S TESTS ORPHANED, AND NOTHING ELSE.
//
// MEASURED AT §1061, because §1054 found 37 of them at 19 hours old and asserted the wrong cause. Two probes:
//
//   | condition                                   | leaked |
//   |---------------------------------------------|--------|
//   | a workerd suite that RUNS TO COMPLETION      | **0**  |
//   | the runner killed mid-flight (closed term.)  | **1+** |
//
// So normal operation leaks nothing — §1054's implication that "orphaned test sandboxes outlive their runner
// and accumulate" is true only of ABNORMAL termination. The chain is `pnpm` → `node (vitest)` → `workerd`, and
// killing the `pnpm` wrapper leaves the node process alive holding workerd; when that node later dies, workerd
// reparents to `launchd` (PPID 1). That is exactly the 19-hour PPID-1 population §1054 cleared.
//
// WHY IT MATTERS BEYOND TIDINESS: ambient load is what turned §1052's 3.5s assertion into a 5.08s timeout
// against vitest's 5000ms default. Stray sandboxes are ambient load, and they survive across sessions.
//
// TWO SAFETY RULES, both necessary:
//   1. PPID 1 ONLY. A live run's workerd has a live vitest parent, so an orphan is exactly a reparented one.
//      Without this the reaper would kill the suite that is currently running — including its own caller.
//   2. THIS REPO'S BINARY ONLY. The match is the absolute path under this repo's `node_modules`, so a workerd
//      belonging to another checkout on the same machine is never touched.

interface Orphan { readonly pid: number; readonly etime: string }

/** Parse `ps` output into orphaned workerd processes belonging to `root`. Exported for the test. */
export function parseOrphans(psOutput: string, root: string): Orphan[] {
  const out: Orphan[] = [];
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    const [, pid, ppid, etime, args] = m as unknown as [string, string, string, string, string];
    // Rule 1: reparented to init. Rule 2: our checkout's binary, matched on the absolute path.
    if (ppid !== "1") continue;
    if (!args.includes(`${root}/node_modules`) || !args.includes("workerd")) continue;
    out.push({ pid: Number(pid), etime });
  }
  return out;
}

function main(): void {
  const root = repoRoot();
  const ps = execFileSync("ps", ["-eo", "pid,ppid,etime,args"], { encoding: "utf8" });
  const orphans = parseOrphans(ps, root);

  if (orphans.length === 0) {
    console.log("reap: no orphaned workerd processes (a completed run leaks none — §1061).");
    return;
  }
  for (const o of orphans) {
    try {
      process.kill(o.pid, "SIGTERM");
      console.log(`reap: SIGTERM → workerd ${o.pid} (orphaned ${o.etime})`);
    } catch (e) {
      console.error(`reap: could not signal ${o.pid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(
    `reap: signalled ${orphans.length} orphan(s). They were state S at §1061 and SIGTERM sufficed — ` +
      "no -9 and no reboot, which corrects the note that called this an uninterruptible wedge.",
  );
}

if (process.argv[1]?.endsWith("reap-orphans.ts")) main();
