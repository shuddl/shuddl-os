import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseRegister, type ReqRow } from "./register.js";
import { scanSourceAnnotations } from "./orphans.js";
import { computeCoverage, disposition, DISPOSITIONS, formatReport, scanRecordedHomes } from "./coverage.js";

// The 15 build WPs (WP-16 is the launch gate itself, handled by its own disposition).
const ACTIVE = [
  "WP-01", "WP-02", "WP-03", "WP-04", "WP-05", "WP-06", "WP-07", "WP-08",
  "WP-09", "WP-10", "WP-11", "WP-12", "WP-13", "WP-14", "WP-15",
];

// Build a fake, unregistered id at runtime so this test file never contains an
// unregistered literal (the orphan detector correctly scans tests too).
const fake = (n: string): string => ["REQ", n].join("-");
const suiteTempRoot = mkdtempSync(join(tmpdir(), "coverage-suite-"));
const annotationIds = {
  source: fake("991"),
  manifest: fake("992"),
  framework: fake("993"),
  implementationDoc: fake("994"),
  goLiveChecklist: fake("995"),
  audit: fake("996"),
  docsWpDeferred: fake("997"),
  docsWpBuilt: fake("998"),
  deferredSource: fake("999"),
};
let annotationRepo = "";
let fixtureAnnotations = new Set<string>();

function writeRepoFile(relativePath: string, content: string): void {
  const path = join(annotationRepo, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeAll(() => {
  annotationRepo = mkdtempSync(join(suiteTempRoot, "annotations-repo-"));
  execFileSync("git", ["init", "--quiet"], { cwd: annotationRepo });
  const registerHeader = "req_id,domain,requirement,source,spec,wp,dod_test,status";
  const registerRows = [
    coverageRow(annotationIds.source, "F0-SPEC'D", "WP-01"),
    coverageRow(annotationIds.manifest, "vNEXT", "vNEXT"),
    coverageRow(annotationIds.framework, "vNEXT", "vNEXT"),
    coverageRow(annotationIds.implementationDoc, "vNEXT", "vNEXT"),
    coverageRow(annotationIds.goLiveChecklist, "vNEXT", "vNEXT"),
    coverageRow(annotationIds.audit, "vNEXT", "vNEXT"),
    coverageRow(annotationIds.docsWpDeferred, "vNEXT", "vNEXT"),
    coverageRow(annotationIds.docsWpBuilt, "F0-SPEC'D", "WP-01"),
    coverageRow(annotationIds.deferredSource, "vNEXT", "vNEXT"),
  ].map((row) => [row.req_id, row.domain, row.requirement, row.source, row.spec, row.wp, row.dod_test, row.status].join(","));
  writeRepoFile("genesis/09-REQUIREMENTS-REGISTER.csv", [registerHeader, ...registerRows].join("\n"));
  writeRepoFile("src/implemented.ts", `export const implementedRequirements = ["${annotationIds.source}", "${annotationIds.deferredSource}"];\n`);
  writeRepoFile("tools/traceability/coverage-manifest.json", `{"dispositions":{"${annotationIds.manifest}":"recorded governance home"}}\n`);
  writeRepoFile("docs/ops/V2-EXECUTION-FRAMEWORK.md", `# Governance framework\n\n${annotationIds.framework}\n`);
  writeRepoFile("docs/ops/IMPLEMENTATION-EVIDENCE.md", `# Implementation evidence\n\n${annotationIds.implementationDoc}\n`);
  writeRepoFile("docs/ops/GO-LIVE-CHECKLIST.md", `# Governance checklist\n\n${annotationIds.goLiveChecklist}\n`);
  writeRepoFile("docs/audits/history/IMPLEMENTATION-REVIEW.md", `# Audit history\n\n${annotationIds.audit}\n`);
  writeRepoFile("docs/wp/WP-TEST.md", `# Work package\n\nDeferred: ${annotationIds.docsWpDeferred}\n\nBuilt: ${annotationIds.docsWpBuilt}\n`);
  execFileSync("git", ["add", "."], { cwd: annotationRepo });
  fixtureAnnotations = scanSourceAnnotations(annotationRepo);
});

afterAll(() => {
  rmSync(suiteTempRoot, { recursive: true, force: true });
});

function coverageRow(req_id: string, status: string, wp: string): ReqRow {
  return { req_id, domain: "TEST", requirement: "Test requirement", source: "test", spec: "test", wp, dod_test: "Observable test", status };
}

describe("REQ-118/119: check:coverage — 100% register-coverage gate", () => {
  it("1) classifies every row of the real register → 100%, zero unaccounted", () => {
    const rows = parseRegister();
    const res = computeCoverage({
      rows,
      annotations: scanSourceAnnotations(),
      recordedHomes: scanRecordedHomes(),
      activeWps: ACTIVE,
    });
    expect(res.total).toBe(rows.length);
    // Nothing unaccounted: no unknown status, no built row missing an annotation,
    // no deferred row missing a recorded home.
    expect(res.unaccounted).toEqual([]);
    // Every row lands in one of the 8 real buckets — none fall through to "unclassified".
    expect(res.perBucket["unclassified"]).toEqual([]);
  });

  it("2) FAILS on unaccounted rows: unknown status, built-w/o-annotation, deferred-w/o-home", () => {
    const csv = [
      "req_id,domain,requirement,source,spec,wp,dod_test,status",
      `${fake("901")},X,unknown status row,src,spec,WP-05,test,BOGUS-STATUS`,
      `${fake("902")},X,built row with no annotation,src,spec,WP-05,test,F0-SPEC'D`,
      `${fake("903")},X,deferred row with no recorded home,src,spec,vNEXT,test,vNEXT`,
    ].join("\n");
    const p = join(mkdtempSync(join(suiteTempRoot, "cov-")), "reg.csv");
    writeFileSync(p, csv);
    const rows = parseRegister(p);

    const res = computeCoverage({ rows, annotations: new Set(), recordedHomes: new Set(), activeWps: ACTIVE });
    const ids = res.unaccounted.map((u) => u.req_id);
    expect(ids).toContain(fake("901"));
    expect(ids).toContain(fake("902"));
    expect(ids).toContain(fake("903"));

    const reason = (id: string): string => res.unaccounted.find((u) => u.req_id === id)?.reason ?? "";
    expect(reason(fake("901"))).toMatch(/status/i); // unknown/empty status
    expect(reason(fake("902"))).toMatch(/annotation/i); // built, zero annotations
    expect(reason(fake("903"))).toMatch(/recorded|home|disposition/i); // deferred, no home

    // Discrimination proof: supply the evidence and 902/903 clear; the unknown status still fails.
    const res2 = computeCoverage({
      rows,
      annotations: new Set([fake("902")]),
      recordedHomes: new Set([fake("903")]),
      activeWps: ACTIVE,
    });
    const ids2 = res2.unaccounted.map((u) => u.req_id);
    expect(ids2).toContain(fake("901"));
    expect(ids2).not.toContain(fake("902"));
    expect(ids2).not.toContain(fake("903"));
  });

  it("3) disposition is pure + total: every (status,wp) → exactly one known bucket, deterministically", () => {
    const rows = parseRegister();
    for (const r of rows) {
      const d1 = disposition(r, ACTIVE);
      const d2 = disposition(r, ACTIVE);
      expect(DISPOSITIONS).toContain(d1); // total: always a known bucket
      expect(d1).toBe(d2); // pure: deterministic
      expect(d1).not.toBe("unclassified"); // the real register is fully classified
    }
    // Totality over an arbitrary (status, wp) matrix — never throws, always a known bucket.
    const statuses = ["F0-SPEC'D", "F0.2-SPEC'D", "WP07-DISCOVERED", "vNEXT", "CONFIRM-GATED", "F0-DEPLOY-NOTE", "", "GARBAGE"];
    const wps = ["WP-05", "WP-all", "WP-16", "ongoing", "F1", "vNEXT", "WP-99", ""];
    for (const status of statuses) {
      for (const wp of wps) {
        const d = disposition({ req_id: fake("000"), domain: "", requirement: "", source: "", spec: "", wp, dod_test: "", status }, ACTIVE);
        expect(DISPOSITIONS).toContain(d);
      }
    }
  });

  it("4) the report prints per-bucket counts summing to the row total", () => {
    const rows = parseRegister();
    const res = computeCoverage({
      rows,
      annotations: scanSourceAnnotations(),
      recordedHomes: scanRecordedHomes(),
      activeWps: ACTIVE,
    });
    const sum = DISPOSITIONS.reduce((n, d) => n + res.perBucket[d].length, 0);
    expect(sum).toBe(rows.length);
    const report = formatReport(res);
    expect(report).toContain(`${rows.length}`);
    expect(report).toMatch(/built-annotated/);
  });

  it("5) surfaces status-drift (vNEXT/*-DISCOVERED with shipped annotations) as advisory, not a fail", () => {
    const rows = parseRegister();
    const res = computeCoverage({
      rows,
      annotations: scanSourceAnnotations(),
      recordedHomes: scanRecordedHomes(),
      activeWps: ACTIVE,
    });
    // Every WP07-DISCOVERED row is annotated in shipped source → must be flagged for advancement.
    expect(res.drift).toContain("REQ-171");
    // Drift is advisory: it never makes the row unaccounted.
    expect(res.unaccounted.map((u) => u.req_id)).not.toContain("REQ-171");
  });

  it("6) records ClaudeParser deterministic-request work as confirmation-gated until it ships", () => {
    const id = ["REQ", "177"].join("-");
    const row = parseRegister().find((candidate) => candidate.req_id === id);
    expect(row?.status).toBe("CONFIRM-GATED");
    expect(scanRecordedHomes()).toContain(id);
  });
});

describe("implementation annotation integrity", () => {
  it("counts real source and normal implementation docs but excludes the exact governance inputs", () => {
    expect(fixtureAnnotations).toContain(annotationIds.source);
    expect(fixtureAnnotations).toContain(annotationIds.deferredSource);
    expect(fixtureAnnotations).toContain(annotationIds.implementationDoc);
    expect(fixtureAnnotations).not.toContain(annotationIds.manifest);
    expect(fixtureAnnotations).not.toContain(annotationIds.framework);
    expect(fixtureAnnotations).not.toContain(annotationIds.goLiveChecklist);
    expect(fixtureAnnotations).not.toContain(annotationIds.audit);
    expect(fixtureAnnotations).not.toContain(annotationIds.docsWpDeferred);
    expect(fixtureAnnotations).toContain(annotationIds.docsWpBuilt);
  });

  it("governance-only citations create no drift and cannot satisfy built coverage", () => {
    const rows = [
      coverageRow(annotationIds.source, "F0-SPEC'D", "WP-01"),
      coverageRow(annotationIds.framework, "F0-SPEC'D", "WP-01"),
      coverageRow(annotationIds.audit, "F0-SPEC'D", "WP-01"),
      coverageRow(annotationIds.docsWpBuilt, "F0-SPEC'D", "WP-01"),
      coverageRow(annotationIds.manifest, "vNEXT", "vNEXT"),
      coverageRow(annotationIds.goLiveChecklist, "vNEXT", "vNEXT"),
      coverageRow(annotationIds.docsWpDeferred, "vNEXT", "vNEXT"),
      coverageRow(annotationIds.implementationDoc, "vNEXT", "vNEXT"),
      coverageRow(annotationIds.deferredSource, "vNEXT", "vNEXT"),
    ];
    const res = computeCoverage({
      rows,
      annotations: fixtureAnnotations,
      recordedHomes: new Set([
        annotationIds.manifest,
        annotationIds.goLiveChecklist,
        annotationIds.docsWpDeferred,
        annotationIds.implementationDoc,
        annotationIds.deferredSource,
      ]),
      activeWps: ["WP-01"],
    });

    expect(res.unaccounted.map((row) => row.req_id)).toContain(annotationIds.framework);
    expect(res.unaccounted.map((row) => row.req_id)).toContain(annotationIds.audit);
    expect(res.unaccounted.map((row) => row.req_id)).not.toContain(annotationIds.source);
    expect(res.unaccounted.map((row) => row.req_id)).not.toContain(annotationIds.docsWpBuilt);
    expect(res.drift).not.toContain(annotationIds.manifest);
    expect(res.drift).not.toContain(annotationIds.goLiveChecklist);
    expect(res.drift).not.toContain(annotationIds.docsWpDeferred);
    expect(res.drift).toContain(annotationIds.implementationDoc);
    expect(res.drift).toContain(annotationIds.deferredSource);
  });
});
