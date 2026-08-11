import { describe, expect, it } from "vitest";
import { classify, failuresFrom, type Failure } from "./delta.js";

// §1081 — the value is entirely in the CLASSIFICATION: vitest already prints failures, and printing failures
// is what did not prevent §1080. So these pin the two directions that matter, plus the parse.

const known = [
  { file: "a.test.ts", title: "known one", why: "explained", until: "someday" },
  { file: "b.test.ts", title: "known two", why: "explained", until: "someday" },
] as const;

describe("§1081: delta separates new failures from the explained baseline", () => {
  it("reports NOTHING when only baseline entries fail — the everyday case", () => {
    const f: Failure[] = [
      { file: "a.test.ts", title: "known one" },
      { file: "b.test.ts", title: "known two" },
    ];
    expect(classify(f, known)).toEqual({ unexpected: [], healed: [] });
  });

  it("reports a NEW failure even while the baseline count is unchanged", () => {
    // §1080's exact shape inverted: a baseline entry passes and a new one fails, so the COUNT is identical
    // and a count-based check sees nothing. This is why the key is (file, title), never a number.
    const f: Failure[] = [
      { file: "a.test.ts", title: "known one" },
      { file: "c.test.ts", title: "something new" },
    ];
    const r = classify(f, known);
    expect(r.unexpected).toEqual([{ file: "c.test.ts", title: "something new" }]);
    expect(r.healed.map((h) => h.title)).toEqual(["known two"]);
  });

  it("reports a HEALED baseline — a silently-fixed entry is news too", () => {
    const r = classify([{ file: "a.test.ts", title: "known one" }], known);
    expect(r.unexpected).toEqual([]);
    expect(r.healed.map((h) => h.title)).toEqual(["known two"]);
  });

  it("does not confuse the same title in a DIFFERENT file", () => {
    // A title is not unique across the suite; the file is half the key.
    const r = classify([{ file: "z.test.ts", title: "known one" }], known);
    expect(r.unexpected).toEqual([{ file: "z.test.ts", title: "known one" }]);
  });

  it("parses failing assertions from a vitest report, ignoring passes", () => {
    const report = JSON.stringify({
      testResults: [
        {
          name: "/repo/x.test.ts",
          assertionResults: [
            { status: "passed", title: "fine" },
            { status: "failed", title: "broken" },
          ],
        },
      ],
    });
    expect(failuresFrom(report, "/repo")).toEqual([{ file: "x.test.ts", title: "broken" }]);
  });

  it("treats a report with no failures as clean rather than throwing", () => {
    expect(failuresFrom(JSON.stringify({ testResults: [] }), "/repo")).toEqual([]);
  });
});
