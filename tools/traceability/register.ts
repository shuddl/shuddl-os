import { readFileSync } from "node:fs";

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

export function parseRegister(path = "genesis/09-REQUIREMENTS-REGISTER.csv"): ReqRow[] {
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const rows: ReqRow[] = [];
  let expectedNumber: number | undefined;
  for (const [i, line] of lines.slice(1).entries()) {
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
