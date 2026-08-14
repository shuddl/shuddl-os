// §1412 (REQ-118) — THE ONE COMMENT STRIPPER.
//
// A comment stripper written as `/\/\*[\s\S]*?\*\//g` is the same defect §1411 found in the strikethrough
// masks, in a different notation: `/*` inside a STRING is not a comment opener, but the regex cannot tell, so
// it swallows from a path glob like `app.use("/v1/*", auth)` or `globSync("{apps,workers}/*")` to the next
// `*/` anywhere in the file. Measured across the tree: 56 files contain such a string, one of them opening a
// 7,783-character swallow.
//
// NINE gates had hand-rolled that regex while THIS state machine already existed and is correct — it tracks
// string and template states, so a `/*` inside a literal opens nothing. **All nine corpora measured clean at
// §1412**, so the duplication had not yet cost anything; it is shared here because the cost when it lands is
// silent for at least the three `claimed-tenants` residue checks (a swallow REMOVES text, so a forbidden
// reference disappears and the gate passes), and because §1411 is what five uncoordinated copies of one
// matcher look like after they drift.
//
// Length-preserving: comments become spaces, newlines survive, so offsets and line numbers are unchanged.

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
