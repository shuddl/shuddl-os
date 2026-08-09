import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-085/073 §782 — A SURFACE MAY NOT ASSERT THE SHAPE OF A SERVER RESPONSE.
//
// Both surface clients end their request path with `return parsed as T`. So a type argument on `get`/`post`
// is a CAST, not a check — a compile-time claim about a server-controlled body that nothing verifies. Every
// view that did
//
//     get<{ rows: Row[] }>(path).then((res) => setRows(res.rows))
//
// set state to `undefined` when the key was absent, and the NEXT RENDER reached `.length` / `.map` — an
// uncaught TypeError that white-screens the surface. The `.catch` beside each of those calls cannot help:
// the throw happens in the render, not in the promise. Measured in a real browser (§781):
// `PAGEERROR: Cannot read properties of undefined (reading 'length')`, and an empty `<body>`.
//
// Worse than the crash was the quiet case: a row missing `total_cents` rendered **NaN as a billing total**,
// with no error state at all. CLAUDE.md's stack rule is "Zod at every boundary"; this gate is that rule made
// mechanical for the one boundary where the type system actively lies about it.
//
// THE RULE: a `get`/`post` type argument must be `unknown` (the honest description of what the client
// guarantees). The shape then comes from a Zod parse, whose ZodError lands in the `.catch` each view already
// has and becomes an honest error state.
//
// SCOPE, stated: apps/*/src only — the three surfaces. Workers parse with Zod at their own boundaries and
// are covered by their own gates; this is about the client casts specifically.

/** The banned form, ASSEMBLED AT RUNTIME. Spelling `get` + `<` + `{` literally in this file would make the
 *  gate match its own source — the mistake §749 made three times in one session (an example becoming the
 *  artifact). Everything here is built from fragments so the scanner can never be its own violation. */
const CALL = ["get", "post"];
const OPEN = "<";
const OBJ = "{";

function offendingLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("//") || line.startsWith("*")) continue; // prose may describe the shape
    for (const fn of CALL) {
      // `fn<{` with optional whitespace — the inline-object type argument.
      if (new RegExp(`\\b${fn}\\s*${OPEN}\\s*${OBJ}`).test(line)) out.push(line);
    }
  }
  return out;
}

/** Every shipped surface source file (tests excluded — a test may legitimately construct a wire shape). */
function surfaceFiles(root: string): string[] {
  return execSync('git ls-files "apps/"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.") && !f.includes("/test/"));
}

describe("REQ-085/073 §782: a surface parses its API responses, it does not assert them", () => {
  const root = repoRoot();
  const files = surfaceFiles(root);

  it("finds the surface sources (non-vacuity — an empty scan must not read as clean)", () => {
    // Without this, a rename of apps/ or a change to the glob turns this gate into a no-op that still passes.
    // Measured 71 shipped (non-test) surface sources at §782; the floor is deliberately well under that
    // so ordinary deletions do not trip it, while a broken glob (which returns 0) still does.
    expect(files.length, "no surface source files found — the scan broke, not the tree").toBeGreaterThan(40);
  });

  it("no view casts a server response into a shape", () => {
    const offenders = files.flatMap((f) => offendingLines(readFileSync(`${root}/${f}`, "utf8")).map((l) => `${f}: ${l}`));
    expect(
      offenders,
      "a surface asserted the shape of a server-controlled body. The client ends in `return parsed as T`, so " +
        "that type argument is a CAST — when the key is absent the state becomes undefined and the NEXT RENDER " +
        "throws on .length/.map, white-screening the surface (the .catch cannot see it). Use an `unknown` type " +
        "argument and parse the body with Zod; the ZodError lands in the .catch you already have:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("the detector actually fires on the banned form (non-vacuity for the matcher itself)", () => {
    // Built from the same fragments, so this proves the regex is live rather than merely returning [].
    const probe = `const r = await ${CALL[0]}${OPEN}${OBJ} rows: Row[] }>("/v1/x");`;
    expect(offendingLines(probe), "the matcher no longer detects the shape it exists to ban").toHaveLength(1);
    // …and does NOT fire on the honest form, or the gate would ban the fix it is asking for.
    expect(offendingLines(`const r = await ${CALL[0]}${OPEN}unknown>("/v1/x");`)).toEqual([]);
  });
});
