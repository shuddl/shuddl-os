// THE SOURCE CORPUS FOR I3 ENFORCEMENT, DECLARED ONCE (audit §493).
//
// Two gates guard the append-only law over TypeScript source, and they must see the same files:
//   • `append-chokepoint.ts` — WHO may write `events` (an allowlist of legitimate writers).
//   • `invariants.ts` `findForbiddenReplaceSources` — HOW anyone may write it (never REPLACE-family,
//     never an upsert, on `events` / `positions` / `money_lines`).
//
// They had DIFFERENT hand-maintained glob lists, and the delta was a hole. §120 caught it once, in one
// direction: the REPLACE scanner covered `packages` + `workers` only, so 4 of 6 (tree × extension) cells
// were blind, and it was widened to match chokepoint's `apps/`. Nobody checked the OTHER direction —
// chokepoint scanned `tools/**` and the REPLACE scanner never did.
//
// MEASURED, not reasoned (§493): `INSERT OR REPLACE INTO events` planted in `tools/seed/load.ts` passed
// `check:invariants` (tools/ outside its globs), `check:chokepoint` (that file is an ALLOWLISTED writer)
// and `lint`. Nothing in the build caught a REPLACE on the events table. The allowlist answers *who may
// write*; it was being read as an exemption from *how*, purely because the second gate did not look there.
//
// So the glob set is declared HERE and imported by both. A hole can no longer open by one list being
// edited and the other not — which is the only way this one opened, twice.
// (`append-chokepoint.ts` already imports `insertIntoRe` FROM `invariants.ts`, so the shared list cannot
// live in either of them without a cycle.)

/** Every tracked TypeScript source tree where SQL touching an append-only table could be written. */
export const SOURCE_SCAN_GLOBS = [
  "workers/*/src/**/*.ts",
  "workers/*/src/**/*.tsx",
  "packages/*/src/**/*.ts",
  "packages/*/src/**/*.tsx",
  "apps/*/src/**/*.ts",
  "apps/*/src/**/*.tsx",
  "tools/**/*.ts",
  "tools/**/*.tsx",
  // §1369 — THE TOP LEVEL OF EVERY src/ TREE, WHICH THE `**` FORMS ABOVE DO NOT MATCH UNDER git ls-files.
  //
  // This roster is consumed by TWO ENGINES with different `**` semantics, and nobody had compared them:
  //   • `node:fs globSync` (invariants.ts) — `**` matches ZERO directories, so `packages/*/src/**/*.ts`
  //     includes `packages/ledger/src/anchor.ts`. Corpus: 335 files.
  //   • `git ls-files` (scan-corpus.ts, used by append-chokepoint, credential-blank-guard,
  //     event-source-producers) — pathspec `*` crosses `/`, so `src/**/` requires at least one real directory
  //     and every top-level file is INVISIBLE. Corpus: 185 files.
  //
  // 150 files — 45% — were missing from the git side, including `workers/api/src/intake-core.ts` (an append
  // surface), `packages/ledger/src/anchor.ts` (REQ-014) and `workers/agents/src/index.ts`. Neither side could
  // notice: each gate's non-vacuity floor was calibrated against its own already-wrong number, which is the
  // §1148 failure — a floor bounds the corpus you HAVE, never the corpus you SHOULD have.
  //
  // These five patterns are redundant under globSync and load-bearing under git ls-files. With them the two
  // engines return an identical 335, asserted in source-corpus.test.ts so they can never diverge again.
  "workers/*/src/*.ts",
  "packages/*/src/*.ts",
  "packages/*/src/*.tsx",
  "apps/*/src/*.ts",
  "apps/*/src/*.tsx",
] as const;

/**
 * Globs that match NOTHING today and are kept deliberately (audit §466). Both are FORWARD-SAFE: workers and
 * tools are server-side/tooling trees with no TSX, and the patterns exist so a `.tsx` appearing there is
 * scanned from its first commit rather than from whenever someone notices. Listing them is what lets the
 * per-glob non-vacuity rule be strict about every OTHER pattern — the §455 distinction between "empty
 * because nothing produces it yet" and "empty because the pattern broke".
 */
export const EXPECTED_EMPTY_GLOBS: ReadonlySet<string> = new Set(["workers/*/src/**/*.tsx", "tools/**/*.tsx"]);

/**
 * Test files are NOT part of the enforcement corpus — they legitimately contain the forbidden SQL as probe
 * fixtures. `append-chokepoint.test.ts` feeds `INSERT OR REPLACE INTO events` to the scanner on purpose;
 * scanning it flags the gate's own evidence and the gate starts crying wolf about itself, which is the
 * failure mode that gets a gate disabled rather than fixed.
 *
 * Shared for the same reason the globs are (§493): this predicate lived inline in `append-chokepoint.ts`
 * only, so the moment the REPLACE scanner was widened to the same trees it inherited the trees WITHOUT the
 * exclusion — the fix and its precondition arriving separately.
 */
export function isTestPath(rel: string): boolean {
  return rel.includes("/test/") || rel.endsWith(".test.ts") || rel.endsWith(".test.tsx");
}

// Moved here from `append-chokepoint.ts` (§493), because BOTH I3 source gates need it and only one had
// it. Its own header already named the victim: "the check flags its own header and `invariants.ts`'s
// explanation of the same rule" — which is exactly what happened the moment the REPLACE scanner was
// widened to the same trees.
//
// Blank out comment BODIES, preserving newlines so reported line numbers stay true. Without this the check
// flags its own header and `invariants.ts`'s explanation of the same rule — a lint that cannot describe
// itself is a lint nobody can document. Quote/template state is tracked so a `//` inside a string literal
// (a URL, a SQL fragment) is not mistaken for a comment.
export function stripComments(src: string): string {
  let out = "";
  let state: "code" | "line" | "block" | "'" | '"' | "`" = "code";
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") { state = "line"; out += "  "; i++; continue; }
      if (c === "/" && next === "*") { state = "block"; out += "  "; i++; continue; }
      if (c === "'" || c === '"' || c === "`") state = c;
      out += c;
      continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; } else out += " ";
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") { state = "code"; out += "  "; i++; } else out += c === "\n" ? c : " ";
      continue;
    }
    // inside a string/template: a backslash escapes the next character, so a quote cannot close early
    if (c === "\\") { out += c + (next ?? ""); i++; continue; }
    if (c === state) state = "code";
    out += c;
  }
  return out;
}
