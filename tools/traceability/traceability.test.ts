import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRegister } from "./register.js";
import { checkPrText } from "./check-pr.js";
import { findOrphans } from "./orphans.js";

const registerHeader = "req_id,domain,requirement,source,spec,wp,dod_test,status";
const suiteTempRoot = mkdtempSync(join(tmpdir(), "traceability-suite-"));

afterAll(() => {
  rmSync(suiteTempRoot, { recursive: true, force: true });
});

function writeRegisterContent(content: string): string {
  const path = join(mkdtempSync(join(suiteTempRoot, "register-")), "register.csv");
  writeFileSync(path, content);
  return path;
}

function writeRegister(ids: string[], newline = "\n"): string {
  const rows = ids.map((id) => `${id},TEST,Requirement ${id},test design,test spec,vNEXT,Observable test,vNEXT`);
  return writeRegisterContent([registerHeader, ...rows].join(newline));
}

describe("register parser", () => {
  it("keeps the authoritative register contiguous through its approved terminal ID", () => {
    const terminalId = ["REQ", "288"].join("-");
    const rows = parseRegister();
    expect(rows).toHaveLength(288);
    for (const [index, row] of rows.entries()) {
      expect(row.req_id).toBe(`REQ-${String(index + 1).padStart(3, "0")}`);
    }
    expect(rows[rows.length - 1]?.req_id).toBe(terminalId);
  });

  it("rejects a duplicate requirement ID", () => {
    const path = writeRegister(["REQ-001", "REQ-002", "REQ-002"]);
    expect(() => parseRegister(path)).toThrow(/expected REQ-003/i);
  });

  it("rejects a gap in requirement IDs", () => {
    const path = writeRegister(["REQ-001", "REQ-002", "REQ-004"]);
    expect(() => parseRegister(path)).toThrow(/expected REQ-003/i);
  });

  it("rejects reordered requirement IDs", () => {
    const path = writeRegister(["REQ-001", "REQ-003", "REQ-002"]);
    expect(() => parseRegister(path)).toThrow(/expected REQ-002/i);
  });

  it("rejects an empty file", () => {
    const path = writeRegisterContent("");
    expect(() => parseRegister(path)).toThrow(/empty/i);
  });

  it("rejects a header-only register", () => {
    const path = writeRegisterContent(`${registerHeader}\n`);
    expect(() => parseRegister(path)).toThrow(/no requirement rows|empty/i);
  });

  it("rejects a headerless register", () => {
    const path = writeRegister(["REQ-001", "REQ-002"]);
    const content = `${["REQ-001", "TEST", "Requirement", "source", "spec", "vNEXT", "Observable test", "vNEXT"].join(",")}\n${["REQ-002", "TEST", "Requirement", "source", "spec", "vNEXT", "Observable test", "vNEXT"].join(",")}`;
    writeFileSync(path, content);
    expect(() => parseRegister(path)).toThrow(/header/i);
  });

  it("rejects a malformed header", () => {
    const path = writeRegister(["REQ-001"]);
    const malformedHeader = "id,domain,requirement,source,spec,wp,dod_test,status";
    writeFileSync(path, `${malformedHeader}\nREQ-001,TEST,Requirement,source,spec,vNEXT,Observable test,vNEXT`);
    expect(() => parseRegister(path)).toThrow(/header/i);
  });

  it("parses CRLF without contaminating field values", () => {
    const ids = [["REQ", "901"].join("-"), ["REQ", "902"].join("-")];
    const path = writeRegister(ids, "\r\n");
    const rows = parseRegister(path);
    expect(rows.map((row) => row.req_id)).toEqual(ids);
    expect(rows.map((row) => row.status)).toEqual(["vNEXT", "vNEXT"]);
  });

  it("keeps rejecting rows that do not have exactly eight fields", () => {
    const path = writeRegisterContent(`${registerHeader}\nREQ-001,TEST,Requirement,source,spec,vNEXT,Observable test,vNEXT,extra`);
    expect(() => parseRegister(path)).toThrow(/9 fields, expected 8/i);
  });
});

describe("REQ-118: PR gate", () => {
  it("DoD: a dummy PR without a REQ-ID fails", () => {
    const r = checkPrText("Adds a thing. No requirement referenced.");
    expect(r.ok).toBe(false);
  });
  it("passes with a valid REQ-ID", () => {
    expect(checkPrText("## REQ-IDs\nREQ-118").ok).toBe(true);
  });
  it("fails on a REQ-ID that is not in the register", () => {
    // Fake id built dynamically so this file never contains an unregistered literal
    // (the orphan detector scans tests too — correctly).
    const fake = ["REQ", "999"].join("-");
    const r = checkPrText(`${fake} does not exist`);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(fake);
  });
});

describe("REQ-118: orphan detector, both directions", () => {
  it("direction A: an active-WP REQ with no annotation anywhere is an orphan", () => {
    const orphans = findOrphans({ activeWps: ["WP-01"], sourceAnnotations: new Set(["REQ-118"]) });
    expect(orphans.specdButUnbuilt.length).toBeGreaterThan(0);
    expect(orphans.specdButUnbuilt).toContain("REQ-025");
  });
  it("direction B: an annotation citing an unregistered REQ is an orphan", () => {
    const fake = ["REQ", "999"].join("-");
    const orphans = findOrphans({ activeWps: [], sourceAnnotations: new Set([fake]) });
    expect(orphans.builtButUnspecd).toContain(fake);
  });
});

// audit §252 — the CLI's no-input branch. `checkPrText("")` cannot express this: the distinction lives in
// main(), between "a PR body that cites nothing" and "no PR body was supplied at all". Both must EXIT 1
// (fail-closed: if CI ever loses $PR_BODY, a "nothing to check" pass would let an uncited PR through), so
// the only thing separating them is the diagnosis — which is exactly what the test pins.
describe("§252: check:pr distinguishes NO INPUT from an uncited PR, without ever failing open", () => {
  const HERE_PR = dirname(fileURLToPath(import.meta.url));
  const REPO_PR = join(HERE_PR, "..", "..");
  const CLI_PR = join(HERE_PR, "check-pr.ts");
  const TSX_PR = join(REPO_PR, "node_modules", ".bin", "tsx");

  // `PR_BODY=""` is NOT "no input": `??` treats a set-but-empty var as SUPPLIED, and an empty PR body IS an
  // uncited PR, so that must stay a REQ-118 violation. Simulating "no input" therefore means UNSETTING it.
  function run(args: string[], env: Record<string, string | undefined> = {}): { code: number; out: string } {
    const merged: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete merged[k];
      else merged[k] = v;
    }
    try {
      const out = execFileSync(TSX_PR, [CLI_PR, ...args], {
        cwd: REPO_PR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: merged,
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number | null; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
    }
  }

  it("NO input: exits 1 (fail-closed) and says nothing was inspected — not that the work is uncited", () => {
    const r = run([], { PR_BODY: undefined });
    expect(r.code, "a missing input must never read as a pass").toBe(1);
    expect(r.out).toContain("no PR body supplied");
    expect(r.out).toContain("NOT a finding about your work");
  });

  it("a SET-BUT-EMPTY PR_BODY is a violation, not 'no input' — an empty PR body IS an uncited PR", () => {
    const r = run([], { PR_BODY: "" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("PR references no REQ-IDs");
    expect(r.out).not.toContain("no PR body supplied");
  });

  it("a SUPPLIED body citing nothing still gets the original REQ-118 violation message", () => {
    const r = run([], { PR_BODY: "Adds a thing. No requirement referenced." });
    expect(r.code).toBe(1);
    expect(r.out).toContain("PR references no REQ-IDs");
    expect(r.out, "the no-input diagnosis must not leak into a real violation").not.toContain("no PR body supplied");
  });

  it("a body citing a real REQ-ID passes (the CI path is unchanged)", () => {
    const r = run([], { PR_BODY: "closes REQ-118" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("cites valid REQ-IDs");
  });
});
