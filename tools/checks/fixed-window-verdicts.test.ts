import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1378 (REQ-118) — A GATE MAY NOT REACH A VERDICT THROUGH A FIXED LINE WINDOW WITHOUT DECLARING ITS REACH.
//
// §1338 established that a body ends where its braces close and a fixed-window approximation errs in BOTH
// directions. §1339 applied it to the gates and triaged eleven sites — and stopped at *documented*. What that
// cost is measurable: I then wrote `lines.slice(i, i + 22)` at §1368 to decide whether an eslint block bans a
// clock, and `[\s\S]{0,80}` at §1376 inside the gate written to close this very class. **Twice in ten sections,
// by the author of the rule.** A rule its own author breaks twice is not held by attention.
//
// SCOPE, deliberately narrow. This detects exactly `slice(X, X + <literal>)` — the SAME base variable, a
// literal span — which is the shape both of my regressions took. It does NOT flag `slice(a, b + 1)` where `b`
// is a FOUND index (structural, e.g. `wrangler-absence-claims`), nor slices to `indexOf(...)`, nor character
// windows built for an error MESSAGE. A broad noisy gate would be worse than none: it teaches people to add
// exemptions, and §1360 is this audit's own record of a pattern-derived population being mostly correct uses.
//
// WHAT A DECLARATION MUST SAY: what the window DECIDES, and BOTH failure directions — because they are almost
// never symmetric, and the silent one is the whole risk. `api-conventions` is §1339's worked example: under-reach
// reports a violation that is not real (loud, gets fixed); OVER-reach lets a LATER call's `redirect:` satisfy
// this site, so an unpoliced fetch passes silently.

interface Site {
  readonly file: string;
  readonly line: number;
  readonly span: number;
  readonly code: string;
}

function fixedWindowSites(root: string): Site[] {
  const files = execSync("git ls-files tools", { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".ts"));
  const out: Site[] = [];
  for (const file of files) {
    const lines = readFileSync(`${root}/${file}`, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
      // SAME base variable on both sides, literal span. `slice(i, i + 16)` qualifies; `slice(a, b + 1)` does not.
      const m = /\.slice\(\s*(\w+)\s*,\s*(\w+)\s*\+\s*(\d+)\s*\)/.exec(line);
      if (m === null || m[1] !== m[2]) continue;
      out.push({ file, line: i + 1, span: Number(m[3]), code: line.trim() });
    }
  }
  return out;
}

// DECLARED windows. Each states what it decides and BOTH failure directions, silent one first where it exists.
//
// §1379 — `tools/deploy/cors-origin-parity.test.ts` was here with a 3-line span and a SILENT under-reach. It is
// gone because the window is gone: a TOML table ends where the next `[` header begins, so that gate now
// delimits structurally and has no reach to declare. THE RIGHT OUTCOME FOR AN ENTRY IN THIS LIST IS DELETION —
// a declaration is a record of an assumption still being made, not a permit to keep making it.
const DECLARED: readonly { readonly file: string; readonly span: number; readonly decides: string; readonly under: string; readonly over: string }[] = [
  {
    file: "tools/checks/api-conventions.test.ts",
    span: 16,
    decides: "whether a fetch in the driver's sync path declares redirect: \"error\"|\"manual\" (§1339's worked example)",
    under: "LOUD — a RequestInit longer than the window reports a violation that is not real, and gets fixed",
    over: "SILENT — a LATER call's `redirect:` falls inside this window and satisfies this site, so an unpoliced fetch passes",
  },
  {
    file: "tools/checks/list-endpoint-pagination.test.ts",
    span: 200,
    decides: "whether an `app.get(\"…\", …)` registration passes a NAMED handler (bare identifier then `)`) or an inline arrow",
    under:
      "LOUD — and effectively unreachable: the consumer regex is ANCHORED at `^`, so the match must begin at " +
      "the slice's first character. The 200 is SLACK for an argument list's leading whitespace, not REACH. " +
      "Under-reach would need >200 characters before the identifier, and a miss falls through to the inline " +
      "branch, which then fails to find an arrow and reports.",
    over:
      "IMPOSSIBLE — the `^` anchor cannot match anything later in the window, so a neighbouring registration " +
      "can never satisfy this one. This is the third category the gate distinguishes: a span that is slack " +
      "behind an anchor has no reach problem at all.",
  },
];

describe("§1378 REQ-118: every fixed-window verdict declares its reach", () => {
  const root = repoRoot();
  const sites = fixedWindowSites(root);

  it("the detector finds the known window (positive control — a blind detector certifies everything)", () => {
    const known = sites.find((s) => s.file === "tools/checks/api-conventions.test.ts");
    expect(known, "api-conventions' 16-line window is no longer detected — the detector broke, not the gate").toBeDefined();
    expect(known!.span).toBe(16);
  });

  it("the detector does NOT flag a structural slice (negative control — noise costs more than silence here)", () => {
    // `wrangler-absence-claims.test.ts` slices `lines.slice(a, b + 1)` where `b` is a FOUND index. Different
    // base variable, so it is a delimited region, not a fixed reach. Flagging it would be the false positive
    // that turns this gate into an exemption farm.
    expect(sites.some((s) => s.file === "tools/checks/wrangler-absence-claims.test.ts")).toBe(false);
  });

  it("no UNDECLARED fixed window decides anything", () => {
    const undeclared = sites
      .filter((s) => !DECLARED.some((d) => d.file === s.file && d.span === s.span))
      .map((s) => `${s.file}:${s.line} — reaches ${s.span} lines: ${s.code}`);
    expect(
      undeclared,
      "a gate decides something by looking a FIXED number of lines ahead. That reach is an assumption about " +
        "today's formatting, and it errs in both directions — one of which is usually SILENT. Either delimit " +
        "the region structurally (to the next declaration, the closing brace, the next `files:`), or declare it " +
        "above with what it decides and BOTH failure directions:\n  " +
        undeclared.join("\n  "),
    ).toEqual([]);
  });

  it("every DECLARED window still exists at its declared span (§1359 — no exemption outlives its subject)", () => {
    const stale = DECLARED.filter((d) => !sites.some((s) => s.file === d.file && s.span === d.span)).map(
      (d) => `${d.file} (declared span ${d.span})`,
    );
    expect(
      stale,
      "a DECLARED window is gone or its span changed. If it was made structural, delete the entry; if the span " +
        "moved, re-derive both failure directions — they scale with the reach:\n  " + stale.join("\n  "),
    ).toEqual([]);
  });

  it("every declaration names a SILENT direction or says why neither is", () => {
    // The point of the declaration is not paperwork: it is that the two directions are almost never symmetric,
    // and only the silent one can ship a false clean.
    for (const d of DECLARED) {
      expect(
        // IMPOSSIBLE joined this set when the gate found the anchored site: a span behind a `^` anchor has no
        // reach at all, which is a STRONGER classification than "loud" and was not a category I anticipated.
        // The gate taught it to me on its first run, which is the argument for gates over prose in one line.
        /SILENT|LOUD|IMPOSSIBLE/.test(d.under) && /SILENT|LOUD|IMPOSSIBLE/.test(d.over),
        `${d.file}: a declaration must classify BOTH directions as SILENT, LOUD or IMPOSSIBLE`,
      ).toBe(true);
    }
  });
});
