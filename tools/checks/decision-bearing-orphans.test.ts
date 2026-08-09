import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §796 — A SCHEMA FIELD THAT DRAWS A DISTINCTION NOTHING ACTS ON.
//
// Three defects this session were the same shape: information the system correctly PARSES and then
// DISCARDS. §773's below-floor branch, §783's marker classification nobody read, and — the one that mattered
// — §795's `TenderDoc.purpose`, where `parse-204.ts` reads X12 B2A01, types it `z.enum(["00","01"])`, puts it
// on the doc, and nothing in `workers/translator/src` ever looks at it. `01` is a CANCELLATION, so a load the
// partner called off is booked exactly like an original: 200, full gated chain, one shipment, zero anomalies.
//
// Such a field is invisible to every test, because the fixtures that would exercise the distinction are
// precisely the ones nobody wrote — every existing fixture used `"00"`.
//
// THE DISCRIMINATOR, and why it is narrow enough to gate on:
//   · `z.literal(X)`      → CONSUMED BY THE PARSE. Only one value survives `safeParse`, so the check IS the
//                           enforcement (`ConsentAck.acknowledged: z.literal(true)` — an unacknowledged
//                           consent simply fails to parse). Never a finding.
//   · `z.string()/number()` → data carried for the record. Often legitimately inert (a pass-through field on
//                           an append-only event). Too noisy to gate.
//   · a MULTI-MEMBER `z.enum([…])` or a bare `z.boolean()` with NO reader → the schema went to the trouble of
//                           distinguishing cases and nothing branches on the distinction. That is the shape.
//
// Measured across `packages/ workers/ apps/ tools/`: **203 schema fields, exactly ONE** match — `purpose`,
// the known §795 hold. The detector is calibrated against a known positive rather than merely tuned to
// return few results, which is the only way a zero-result gate means anything.

/** Fields with no reader anywhere. A read INSIDE the declaring file counts — same-file consumption is real. */
function orphanFields(root: string): Array<{ field: string; file: string; type: string }> {
  const files = execSync('git ls-files "packages" "workers" "apps" "tools"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.") && !f.includes("/test/"));
  const blob = new Map(files.map((f) => [f, readFileSync(`${root}/${f}`, "utf8")]));

  const declared = new Map<string, { file: string; type: string }[]>();
  for (const [f, t] of blob) {
    for (const m of t.matchAll(/^\s{2,}([a-z][a-z0-9_]{2,}):\s*(z\.[^\n]*)$/gm)) {
      const list = declared.get(m[1]!) ?? [];
      list.push({ file: f, type: m[2]! });
      declared.set(m[1]!, list);
    }
  }

  const out: Array<{ field: string; file: string; type: string }> = [];
  for (const [field, decls] of declared) {
    const types = decls.map((d) => d.type).join(" | ");
    if (types.includes("z.literal")) continue; // the parse is the enforcement
    if (!/z\.enum\(|z\.boolean\(/.test(types)) continue; // only decision-bearing shapes
    const decl = new RegExp(`^\\s{2,}${field}:\\s*z\\.`);
    const read = new RegExp(
      `\\.${field}\\b|\\["${field}"\\]|\\$\\.${field}\\b|\\{[^}\\n]*\\b${field}\\b[^}\\n]*\\}\\s*=|\\b${field}\\s*===`,
    );
    let consumed = false;
    for (const t of blob.values()) {
      const stripped = t.split("\n").filter((l) => !decl.test(l)).join("\n");
      if (read.test(stripped)) {
        consumed = true;
        break;
      }
    }
    if (!consumed) out.push({ field, file: decls[0]!.file, type: decls[0]!.type });
  }
  return out;
}

/** The one known member, held open by a filed hold rather than by neglect. */
const FILED: ReadonlyArray<{ field: string; why: string }> = [
  {
    field: "purpose",
    why: "§795 / GO-LIVE-CHECKLIST — X12 B2A01 purpose. `01` = CANCELLATION is parsed and ignored, so a cancelled tender books like an original. NOT in the register (REQ-205 covers 04/05 only); a REQ row is proposed in §795. Tripwire: workers/translator/test/inbound.test.ts \"§795 GAP\".",
  },
];

describe("§796: a schema field that draws a distinction nothing acts on", () => {
  const found = orphanFields(repoRoot());

  it("the detector still finds its known positive (calibration — a zero-result scan proves nothing)", () => {
    // If `purpose` ever stops being reported, either it gained a consumer (good — close the hold, drop the
    // roster row, delete the tripwire) or the detector broke. Both need a human; neither may pass silently.
    expect(
      found.map((f) => f.field),
      "the detector no longer reports `purpose` — it was either fixed (update §795 + the checklist + this roster) or the scan is broken",
    ).toContain("purpose");
  });

  it("no NEW decision-bearing field is parsed and then ignored", () => {
    const filed = new Set(FILED.map((f) => f.field));
    const novel = found.filter((f) => !filed.has(f.field));
    expect(
      novel,
      "a schema declares a multi-member enum or a boolean that NOTHING reads. The schema drew a distinction " +
        "and no code branches on it — which is invisible to every test, because the fixture exercising the " +
        "other case is the one nobody wrote (§795: a B2A cancellation booked like an original). Either act on " +
        "the value, narrow it to a z.literal so the parse enforces it, or file it here with its hold:\n  " +
        novel.map((f) => `${f.file}: ${f.field} — ${f.type}`).join("\n  "),
    ).toEqual([]);
  });
});
