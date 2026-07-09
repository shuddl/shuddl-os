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
  const text = process.env["PR_BODY"] ?? (arg ? readFileSync(arg, "utf8") : "");
  const r = checkPrText(text);
  if (!r.ok) {
    console.error(`FAIL ${r.reason}`);
    process.exit(1);
  }
  console.log("traceability: PR cites valid REQ-IDs");
}
if (process.argv[1]?.endsWith("check-pr.ts")) main();
