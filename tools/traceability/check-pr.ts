import { readFileSync } from "node:fs";
import { parseRegister } from "./register.js";

// REQ-118: every PR must cite at least one register row; unknown ids are new scope
// entering the wrong door (ADD A ROW FIRST).
export function checkPrText(text: string): { ok: boolean; reason?: string } {
  const cited = [...new Set(text.match(/REQ-\d{3}/g) ?? [])];
  if (cited.length === 0) return { ok: false, reason: "REQ-118: PR references no REQ-IDs. Every PR must cite at least one register row." };
  const known = new Set(parseRegister().map((r) => r.req_id));
  const unknown = cited.filter((id) => !known.has(id));
  if (unknown.length > 0) return { ok: false, reason: `REQ-118: unknown REQ-IDs (not in register): ${unknown.join(", ")}. New scope = ADD A ROW FIRST.` };
  return { ok: true };
}

function main(): void {
  // CI passes the PR body via $PR_BODY or a file arg; locally: pnpm check:pr <file>
  const arg = process.argv[2];
  const supplied = process.env["PR_BODY"] ?? (arg ? readFileSync(arg, "utf8") : undefined);
  const text = supplied ?? "";
  const r = checkPrText(text);
  if (!r.ok) {
    // NO INPUT is a different fact from "a PR body that cites nothing", and it used to print the same
    // sentence (audit §252). Every local `pnpm check:pr` hits the no-input case, so the battery reported
    // what read as a live REQ-118 violation when it had simply never been given a PR to inspect.
    // The EXIT CODE stays 1 in both cases, deliberately: if CI ever loses $PR_BODY, an exit-0 "nothing to
    // check" would let an uncited PR through — the failure must stay closed, only the diagnosis changes.
    if (supplied === undefined) {
      console.error(
        "FAIL REQ-118: no PR body supplied, so nothing was inspected — this is NOT a finding about your work. " +
          "Pass one to check it: `pnpm check:pr <file>` (or set $PR_BODY, as CI does). Exiting 1 by design: " +
          "a missing input must never read as a pass.",
      );
      process.exit(1);
    }
    console.error(`FAIL ${r.reason}`);
    process.exit(1);
  }
  console.log("traceability: PR cites valid REQ-IDs");
}
if (process.argv[1]?.endsWith("check-pr.ts")) main();
