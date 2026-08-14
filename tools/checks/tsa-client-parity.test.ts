import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { stripComments } from "./strip-comments.js";

// §1352 (REQ-014/154) — THE TSA CLIENT FACTORY IS IMPLEMENTED TWICE, AND ITS ENVIRONMENT GATE WAS PINNED BY NOTHING.
//
// `tsaFor` (agents cron) and `tsaClientFor` (the api's anchors route) are byte-identical: both decide which
// timestamping-authority client the REQ-014 daily anchor talks to. Found by §1351's duplicate-body search as
// the last of five copy-sets, and the only one left unheld after that phase.
//
// WHY THIS PAIR IS NOT THE `readModelText` CASE. §1351's copy-set fails CLOSED — every copy returns `undefined`
// and every caller abstains, so a drift costs an abstention. This one can fail OPEN. Its first line is
//
//     if (env.ENVIRONMENT !== "prod") return new FakeTsaClient();
//
// so the gate that separates a REAL timestamp from a fake one is a single string comparison, duplicated. A
// drift that widened either copy's non-prod branch would hand prod a `FakeTsaClient`, and the anchor would keep
// producing receipts that are not timestamps — REQ-014 tamper evidence, silently synthetic, with every gate
// still green because the anchor still "succeeds".
//
// WHAT §1066 DID AND DID NOT COVER. The test-double sweep classified `FakeTsaClient` as unable to mask a
// duplicate ("no dedupe path"), which is a different question from whether the FACTORY chooses it correctly.
// Measured 2026-08-13: zero test files name `tsaFor` or `tsaClientFor`.
//
// Modelled on `recipient-parity.test.ts` (§786) and `model-envelope-parity.test.ts` (§1351): brace-matched
// bodies (§1338), comments stripped, plus the two guards §786 insisted on — a non-vacuity floor, and a
// PROPERTY assertion, because a parity test alone certifies sameness rather than correctness.

const SITES = [
  ["agents cron", "workers/agents/src/index.ts", "tsaFor"],
  ["api anchors route", "workers/api/src/routes/anchors.ts", "tsaClientFor"],
] as const;

/** Extract a function body by name, brace-matched so nested blocks survive. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`tsa-client-parity: ${name} not found — renamed or removed, which is itself the drift this guards`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`tsa-client-parity: unbalanced braces while reading ${name}`);
}

function normalise(body: string): string {
  return stripComments(body)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//"))
    .join("\n")
    .replace(/\s+/g, " ");
}

describe("§1352 REQ-014: the two TSA client factories agree, and both gate on prod", () => {
  const root = repoRoot();
  const bodies = SITES.map(([label, file, fn]) => ({ label, body: normalise(functionBody(readFileSync(`${root}/${file}`, "utf8"), fn)) }));

  it("finds both bodies and neither is empty (non-vacuity — comparing nothing to nothing passes)", () => {
    expect(bodies.map((b) => b.label)).toEqual(["agents cron", "api anchors route"]);
    for (const b of bodies) {
      expect(b.body.length, `${b.label}: the factory extracted empty — it moved, it did not shrink`).toBeGreaterThan(150);
    }
  });

  it("the two implementations are logically identical", () => {
    expect(
      bodies[1]!.body,
      "the TSA client factory has DRIFTED between the agents cron and the api anchors route. Both decide whether " +
        "REQ-014's anchor talks to a REAL timestamping authority or a fake one, so a divergence means one path " +
        "can produce receipts the other would refuse. Re-sync them, or extract ONE factory and delete the other.",
    ).toBe(bodies[0]!.body);
  });

  it("both still gate the FAKE client on non-prod — the fail-OPEN property, not just sameness", () => {
    // §786's warning applies with teeth here: two copies that agreed on `ENVIRONMENT === "dev"` would pass the
    // identity case above while handing prod a FakeTsaClient. This pins the direction of the comparison.
    for (const b of bodies) {
      expect(b.body, `${b.label}: the non-prod fake-client gate is gone`).toMatch(/ENVIRONMENT\s*!==\s*"prod"/);
      expect(b.body, `${b.label}: the non-prod branch no longer returns the fake client`).toMatch(/!==\s*"prod"\s*\)\s*return new FakeTsaClient/);
      // And prod must still be able to reach a REAL client, or the gate is inverted in the other direction.
      expect(b.body, `${b.label}: the real HTTP client is unreachable`).toContain("HttpTsaClient");
    }
  });
});
