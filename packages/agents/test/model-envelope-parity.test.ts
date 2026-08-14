import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { stripComments } from "../../../tools/checks/strip-comments.js";

// §1351 (REQ-024/038/059) — THE LLM RESPONSE-ENVELOPE READER IS IMPLEMENTED THREE TIMES, AND AGREED WITH NOTHING.
//
// `readModelText` — the function that turns an Anthropic API `Response` into the model's text, or `undefined` —
// exists BYTE-IDENTICALLY in all three LLM consumers: the Concierge parser, the Copilot answerer, and the
// Migrator's column guesser. Found by normalising every function body in the shipped tree and grouping
// duplicates (§1351): three copies, 476 normalised characters each, and **zero test files mention it by name**.
//
// WHY THIS MATTERS EVEN THOUGH A DRIFT FAILS CLOSED. Each copy returns `undefined` on anything it cannot read,
// and every caller treats `undefined` as "no usable model output" — the Copilot abstains (§1255), the Concierge
// degrades, the Migrator guesses nothing. So a divergence does not corrupt data; it makes ONE agent stop
// understanding a response shape its siblings still handle, silently, and the symptom is an abstention rate
// rather than an error. That is the quiet failure this repo files under §1226: duplicated claims are debt
// exactly when no mechanism would notice them diverging.
//
// THE PRECEDENT IS THIS REPO'S OWN. §786 found the recipient rule implemented twice with neither copy pinned,
// and closed it with `workers/api/test/recipient-parity.test.ts` — normalised-body comparison plus a
// non-vacuity case, because "a parity test alone would happily certify two copies that are identically WRONG".
// This is that shape applied to the three-copy case, and it deliberately reuses that file's technique: bodies
// extracted by BRACE MATCHING (§1338 — a fixed line window errs in both directions), comments stripped,
// whitespace collapsed.
//
// WHAT THIS DOES NOT CLAIM: that the shared implementation is correct. It claims only that the three cannot
// drift apart unnoticed. Correctness of the envelope contract belongs to the adapters' own suites.

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string): string => readFileSync(resolve(here, "..", "src", rel), "utf8");

/** Extract a function body by name, brace-matched so nested blocks survive. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) {
    throw new Error(`model-envelope-parity: ${name} not found — renamed or removed, which is itself the drift this guards`);
  }
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`model-envelope-parity: unbalanced braces while reading ${name}`);
}

/** Strip comments and collapse whitespace — the copies may be commented and indented differently. */
function normalise(body: string): string {
  return stripComments(body)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//"))
    .join("\n")
    .replace(/\s+/g, " ");
}

const COPIES = [
  ["concierge", "concierge/parse.ts"],
  ["copilot", "copilot/answer.ts"],
  ["migrator", "migrator/guess.ts"],
] as const;

describe("§1351 REQ-024: the three LLM response-envelope readers agree", () => {
  const bodies = COPIES.map(([name, rel]) => ({ name, body: normalise(functionBody(src(rel), "readModelText")) }));

  it("finds all three bodies, and none is empty (non-vacuity — an empty extraction must not read as agreement)", () => {
    // The §786 warning, applied: comparing "" to "" passes and proves nothing, and a renamed function would
    // otherwise make this suite green by extracting nothing at all.
    expect(bodies.map((b) => b.name)).toEqual(["concierge", "copilot", "migrator"]);
    for (const b of bodies) {
      expect(b.body.length, `${b.name}: readModelText extracted empty — the reader moved, it did not shrink`).toBeGreaterThan(120);
    }
  });

  it("all three implementations are logically identical", () => {
    const [first, ...rest] = bodies;
    for (const other of rest) {
      expect(
        other.body,
        `readModelText has DRIFTED between ${first!.name} and ${other.name}. All three LLM consumers must read the ` +
          "same response envelope: a divergence makes one agent stop understanding a shape its siblings still " +
          "handle, and because every copy fails closed to `undefined` the symptom is a silent abstention, not an " +
          "error. Either re-sync the copies or extract ONE shared reader and delete the others.",
      ).toBe(first!.body);
    }
  });

  it("the shared body still fails closed — it returns undefined rather than throwing on a bad envelope", () => {
    // A parity test certifies sameness, never correctness (§786). This pins the one property every caller
    // depends on: unreadable input yields `undefined`, which is what lets the Copilot abstain instead of 500.
    const body = bodies[0]!.body;
    expect(body, "readModelText no longer returns undefined on an unparseable body").toContain("return undefined");
    expect(body, "readModelText no longer guards the JSON parse").toContain("catch");
  });
});
