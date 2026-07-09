import { describe, expect, it } from "vitest";
import { parseDenylist, scanForIdentityLeaks } from "./identity-leak.js";

// REQ-167 DoD: a seeded denylist name in a PR fails CI. Tests inject a fake term —
// real names live only in the client-side denylist, never here.
describe("REQ-167: identity-leak lint", () => {
  const files = new Map<string, string>([
    ["src/ok.ts", "export const x = 1;"],
    ["docs/leak.md", "We visited Zebra-Carrier-Testname's dock yesterday."],
  ]);

  it("flags a seeded denylist name (case-insensitive) with file attribution", () => {
    const hits = scanForIdentityLeaks(["ZEBRA-CARRIER-TESTNAME"], files);
    expect(hits.length).toBe(1);
    expect(hits[0]?.file).toBe("docs/leak.md");
  });

  it("masks the term in output — the lint must not amplify the leak", () => {
    const hits = scanForIdentityLeaks(["ZEBRA-CARRIER-TESTNAME"], files);
    expect(hits[0]?.masked).toBe("Z*********************");
    expect(JSON.stringify(hits)).not.toContain("ZEBRA-CARRIER-TESTNAME");
  });

  it("clean tree with a populated denylist passes", () => {
    expect(scanForIdentityLeaks(["ZEBRA-CARRIER-TESTNAME"], new Map([["a.ts", "clean"]]))).toEqual([]);
  });

  it("parses denylists from newline/comma-separated input, ignoring blanks and comments", () => {
    expect(parseDenylist("Alpha Corp\n# comment\nbeta-inc, Gamma LLC\n\n")).toEqual(["Alpha Corp", "beta-inc", "Gamma LLC"]);
  });
});
