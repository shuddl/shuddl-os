import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1376 (REQ-025/030) — EVERY TEST DOUBLE THAT COLLAPSES REPEATS IS DECLARED, WITH THE KEY IT COLLAPSES ON.
//
// A double that absorbs duplicates is blind to duplication, and doubles are written to be well-behaved. §1065
// found a High-severity race ten sibling tests could not see because the double deduplicated the symptom.
// §1066 answered "how many others?" by classifying FIFTEEN doubles and concluding one — and its table was a
// hand-kept list of NAMES (`NotConfigured*`, `RecordingLedger`, `RecordingSender`, `RecordingTransport`,
// `FakeTsaClient`). `RecordingSeq` was never a row in it, and it exists in FOUR files.
//
// What that cost, measured at §1375: `workers/translator/test/isolation.test.ts` — the file whose entire
// purpose is REQ-025 cross-tenant isolation — used a double keyed on the bare event id. An append of the same
// id under a DIFFERENT tenant returned early and was never recorded, so its central assertion
// (`appended.every((a) => a.tenant === "tenant-a")`) could pass while the leak it exists to catch went unseen.
// Worse than lossy: production does NOT dedupe across tenants (one Durable Object per (tenant|stream)), so the
// double modelled a guarantee the system does not make.
//
// SIX COUNTS IN ONE SESSION came up short because a scan encoded one SURFACE FORM of a behaviour — a name
// prefix, a `seen` identifier, a `**` glob — instead of the behaviour. This gate is the third of that family to
// be closed by derivation rather than attention (after `dark-stub-roster` §1366 and `git-glob-toplevel` §1370):
// the population comes from the TREE, and membership is decided by what the body DOES.

interface Double {
  readonly file: string;
  readonly cls: string;
  readonly port: string;
  readonly collapses: boolean;
}

/** Every `class X implements Y` in a test file, classified by whether its body short-circuits on a lookup. */
function doubles(root: string): Double[] {
  const files = execSync("git ls-files packages workers tools apps", { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.includes(".test."));
  const out: Double[] = [];
  for (const file of files) {
    const lines = readFileSync(`${root}/${file}`, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = /class (\w+)\s+implements\s+(\w+)/.exec(lines[i]!);
      if (!m) continue;
      let depth = 0;
      const body: string[] = [];
      for (let j = i; j < lines.length; j++) {
        body.push(lines[j]!);
        depth += (lines[j]!.match(/\{/g) ?? []).length - (lines[j]!.match(/\}/g) ?? []).length;
        if (depth <= 0 && body.length > 1) break;
      }
      // COLLAPSING = it consults prior state and returns early, i.e. a second identical call does less work.
      // Deliberately behavioural: `seen.has(...)`, `byId.get(...) !== undefined`, `?? return` all qualify, and
      // no name is consulted — the §1066 list was names, which is exactly how RecordingSeq escaped it.
      // LINE-WISE, never a character window. A first draft used `.get(...)` within 80 chars of the early
      // return and MISSED `inbound.test.ts` the moment a comment was inserted between them — a fixed window,
      // which is the error §1338 already corrected once and which this session has now produced twice.
      const collapses = body.some((line) => /\bif\s*\(/.test(line) && /\breturn\b/.test(line) && /\.has\(|!==\s*undefined|!=\s*null/.test(line));
      out.push({ file, cls: m[1]!, port: m[2]!, collapses });
    }
  }
  return out;
}

// DECLARED collapsing doubles. Each states the KEY it collapses on and why that key is faithful to production.
// A double may collapse only where the real collaborator collapses, on the same identity.
const DECLARED: readonly { readonly cls: string; readonly file: string; readonly key: string; readonly why: string }[] = [
  {
    cls: "RecordingSeq",
    file: "workers/agents/test/mirror-sweep.test.ts",
    key: "event id",
    why:
      "single-tenant flow: every append in this suite is tenant-a's, so an id-keyed collapse matches the real " +
      "per-(tenant|stream) DO. Its CALL count is asserted separately (§1373) because the collapse hides work, " +
      "not correctness — a re-ingest is free in rows and not in subrequests.",
  },
  {
    cls: "RecordingSeq",
    file: "workers/translator/test/inbound.test.ts",
    key: "event id",
    why: "single-tenant flow; `seq.calls` is asserted alongside `appended.length` (§1374) so redelivery WORK stays visible.",
  },
  {
    cls: "RecordingSeq",
    file: "workers/translator/test/roundtrip.fixture.test.ts",
    key: "event id",
    why: "single-tenant flow, and no assertion reads `appended.length`, so the collapse certifies nothing.",
  },
  {
    cls: "RecordingSeq",
    file: "workers/translator/test/isolation.test.ts",
    key: "tenant|id",
    why:
      "MULTI-TENANT by construction — this suite exists to catch a cross-tenant append. Keyed on the bare id " +
      "until §1375, which let a same-id append for another tenant vanish. Now keyed as production is: one " +
      "Durable Object per (tenant|stream), so a different tenant is a different DO and is NOT deduped.",
  },
];

describe("§1376 REQ-025: every collapsing test double is declared with its key", () => {
  const root = repoRoot();
  const all = doubles(root);

  it("derives a real population (non-vacuity — an empty scan would certify everything)", () => {
    expect(all.length, "no test doubles found — the extractor broke, not the tree; there were 19 at §1376").toBeGreaterThanOrEqual(15);
    expect(all.some((d) => d.collapses), "no COLLAPSING double detected — the classifier broke; there were 4 at §1376").toBe(true);
  });

  it("the classifier detects the known collapsing double (positive control)", () => {
    // §1370's lesson: a detector that always returns false makes the assertion below vacuous, and that is the
    // exact failure mode this whole family keeps producing.
    const iso = all.find((d) => d.file === "workers/translator/test/isolation.test.ts" && d.cls === "RecordingSeq");
    expect(iso, "the isolation-suite double is no longer found at all — this gate is stale").toBeDefined();
    expect(iso!.collapses, "the isolation-suite double no longer reads as collapsing — the classifier missed it").toBe(true);
  });

  it("no UNDECLARED double collapses repeats", () => {
    const undeclared = all
      .filter((d) => d.collapses)
      .filter((d) => !DECLARED.some((e) => e.cls === d.cls && e.file === d.file))
      .map((d) => `${d.file} :: ${d.cls} implements ${d.port}`);
    expect(
      undeclared,
      "a test double silently collapses repeated calls. Whatever duplication its suite claims to rule out, it " +
        "cannot see — §1065's race and §1375's cross-tenant leak were both invisible for this reason. Declare " +
        "it above with the KEY it collapses on and why that key is what the real collaborator uses; if the key " +
        "is narrower than production's, the double is certifying a guarantee the system does not make:\n  " +
        undeclared.join("\n  "),
    ).toEqual([]);
  });

  it("every DECLARED entry still exists and still collapses (no exemption outlives its subject)", () => {
    const stale = DECLARED.filter((e) => !all.some((d) => d.cls === e.cls && d.file === e.file && d.collapses)).map(
      (e) => `${e.file} :: ${e.cls}`,
    );
    expect(
      stale,
      "a DECLARED collapsing double no longer exists, or no longer collapses. Either way the entry is now a " +
        "standing excuse for nothing — delete it, or point it at whatever replaced that double (§1359):\n  " +
        stale.join("\n  "),
    ).toEqual([]);
  });
});
