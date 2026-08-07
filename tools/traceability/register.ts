import { readFileSync } from "node:fs";
import { repoRoot } from "../checks/repo-root.js";

const REGISTER_HEADER = "req_id,domain,requirement,source,spec,wp,dod_test,status";

export type ReqRow = {
  req_id: string;
  domain: string;
  requirement: string;
  source: string;
  spec: string;
  wp: string;
  dod_test: string;
  status: string;
};

// §489 — the default is REPO-ANCHORED, not cwd-relative. As a bare relative path this threw an
// unhandled ENOENT whenever a gate ran from anywhere but the root, which read as "the gate failed"
// while being a statement about the caller's directory (see tools/checks/repo-root.ts).
export function parseRegister(path = `${repoRoot()}/genesis/09-REQUIREMENTS-REGISTER.csv`): ReqRow[] {
  const content = readFileSync(path, "utf8");
  if (content.trim().length === 0) throw new Error(`register ${path} is empty`);

  const lines = content.split(/\r?\n/);
  while (lines[lines.length - 1] === "") lines.pop();

  const header = lines.shift();
  if (header !== REGISTER_HEADER) {
    throw new Error(`register ${path} has invalid header; expected exactly: ${REGISTER_HEADER}`);
  }
  if (lines.length === 0) throw new Error(`register ${path} has no requirement rows`);

  const rows: ReqRow[] = [];
  let expectedNumber: number | undefined;
  for (const [i, line] of lines.entries()) {
    const fields = line.split(",");
    // The register is authored comma-safe (semicolons inside fields). A row that
    // splits to anything but 8 fields is a register defect — fail loudly, never guess.
    if (fields.length !== 8) throw new Error(`register row ${i + 2} has ${fields.length} fields, expected 8: ${line.slice(0, 60)}…`);
    const [req_id, domain, requirement, source, spec, wp, dod_test, status] = fields as [string, string, string, string, string, string, string, string];
    const match = /^REQ-(\d{3})$/.exec(req_id);
    if (!match || Number(match[1]) < 1) {
      throw new Error(`register row ${i + 2} has invalid requirement id ${req_id}; expected REQ-NNN`);
    }
    expectedNumber ??= Number(match[1]);
    const expectedId = `REQ-${String(expectedNumber).padStart(3, "0")}`;
    if (req_id !== expectedId) {
      throw new Error(`register row ${i + 2} has ${req_id}; expected ${expectedId} for strict append-only order`);
    }
    expectedNumber += 1;
    rows.push({ req_id, domain, requirement, source, spec, wp, dod_test, status });
  }
  return rows;
}
