import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1507 (REQ-118) — NO GATE SCANS A SOURCE TREE WITH A `.ts`-ONLY FILTER.
//
// WHY THIS EXISTS, and it is a count rather than an argument. §1505 and §1506 found SIX gates whose corpus
// excluded the file their own rule was written about, every one by the same mechanism: a `git ls-files` over a
// production tree, narrowed by `/\.ts$/`, in a repo whose `packages/` and `workers/` hold 14 `.tsx` files —
// server-side render views, not app code. Each was proved blind by planting its own violation in a `.tsx` and
// watching the suite stay green, with a `.ts` control proving the probe:
//
//   float-money-division    `cents / 100`                                — drops `biller/evidence-email-view.tsx`,
//                                                                          whose formatCents prints the dollar
//                                                                          amount on every customer invoice
//   constant-time-compare   `token === otherToken`                       — 52% of app source, after §1448 had
//                                                                          deliberately widened the TREE to apps
//   unbounded-reads-roster  `db.prepare("SELECT * FROM events").all()`
//   dark-stub-roster        a root returning `new NotConfigured…()`
//   idb-durability          a readwrite tx with no `oncomplete`          — (a PATH scope, §1506)
//   gate-roster             (an `export`-keyword scope, §1504)
//
// At instance two the rule is to stop fixing and start counting (§1349); at six it is to make the class
// unrepeatable. The three remaining `.ts`-only corpora were widened at §1507 even though their trees hold no
// `.tsx` today — a scope that is TRUE TODAY and a scope that is RIGHT are indistinguishable until something
// moves, and this gate is what notices the move.
//
// SCOPE, stated. This checks the EXTENSION filter only, over corpora that name a production tree. It says
// nothing about which trees a gate should scan — that is a judgement each gate must state for itself
// (`float-money-division`'s exclusion of `apps/` is argued in its header and is correct). A narrower rule that
// holds beats a broader one that needs exemptions.

const PRODUCTION_TREE = /"(?:workers|packages|apps)[^"]*"|\b(?:workers|packages|apps)\b/;
/** A `.ts`-only extension predicate: matches `.ts` and does NOT admit `.tsx`. */
// §1774 — `*.ts'` NOW MATCHES WHEREVER IT ENDS A PATHSPEC, not only as a bare `'*.ts'`. The original
// alternation required the quote immediately before the star, which is the `git ls-files`/`globSync` shape;
// a git-grep pathspec is path-qualified (`'workers/**/*.ts'`), so the star is preceded by a slash and none of
// the four alternatives fired. That was the SECOND inert fix in this phase — the mechanism list was widened,
// then the tree test was moved to the statement, and the suite stayed green through both because the
// extension predicate itself could not see the string. A gate widened in three places is still blind if any
// one of them is the narrow one.
const TS_ONLY = /\.ts\$|endsWith\("\.ts"\)|\*\.ts'|\*\.ts"/;

interface Site {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Every corpus call in the tooling that names a production tree and filters to `.ts` only. */
function tsOnlyCorpora(root: string, selfPath: string): Site[] {
  const files = execSync("git ls-files tools", { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".ts") && f !== selfPath);
  const out: Site[] = [];
  for (const file of files) {
    const lines = readFileSync(`${root}/${file}`, "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      // §1774 — `git grep` JOINED THIS LIST, and its absence is why three gates shipped `.ts`-only past a
      // gate written to make that unrepeatable. The rule was enumerated by MECHANISM (the two corpus calls
      // that existed when it was written) rather than by BEHAVIOUR (any call that builds a corpus from a
      // pathspec). A gate keyed on an API call is blind to the same class under a different call — measured:
      // 5 gates now build their corpus with `git grep`, 3 of them `.ts`-only, all invisible here.
      if (!/git ls-files|globSync|git grep/.test(line)) continue;
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
      // The predicate usually sits on the next line or two (`.split("\n")` then `.filter(...)`). Bounded by
      // the END OF THE STATEMENT — the first line whose trailing character closes it — never by a fixed
      // window (§1378): a fixed reach would read the NEXT call's filter and call this one clean.
      let win = line;
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
        const l = lines[j] as string;
        win += `\n${l}`;
        if (/;\s*$/.test(l.trim())) break;
      }
      // §1774 — THE TREE TEST MOVED FROM THE LINE TO THE STATEMENT, and this is what made the `git grep`
      // extension actually work. It read `PRODUCTION_TREE.test(line)` and skipped before the window existed,
      // which is right for `git ls-files tools` (one line, tree included) and wrong for a pathspec built by
      // string concatenation, where the trees sit on the NEXT line. Measured: with the tree test on the line,
      // re-narrowing a `git grep` gate to `.ts`-only left this suite GREEN — the extension was inert and
      // would have been credited as working.
      if (!PRODUCTION_TREE.test(win)) continue;
      if (TS_ONLY.test(win) && !/tsx/.test(win)) out.push({ file, line: i + 1, text: line.trim().slice(0, 100) });
    }
  }
  return out;
}

describe("§1507 REQ-118: no gate scans a source tree with a `.ts`-only filter", () => {
  const root = repoRoot();
  const SELF = "tools/checks/corpus-extension.test.ts";
  const offenders = tsOnlyCorpora(root, SELF);

  it("derives a real population (non-vacuity — an empty scan certifies every gate)", () => {
    // Floor the INPUT, never the finding (§1148): count the corpus calls this rule ranges over, so a broken
    // extractor cannot report "no offenders" over nothing. LIVE, MEASURED at §1507: 37 gates build a
    // production-tree corpus (6 via the shared roster, 31 rolling their own).
    const all = execSync("git ls-files tools", { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => f.endsWith(".ts") && f !== SELF)
      .flatMap((f) =>
        readFileSync(`${root}/${f}`, "utf8")
          .split("\n")
          .filter((l) => /git ls-files|globSync/.test(l) && !l.trim().startsWith("//") && PRODUCTION_TREE.test(l)),
      );
    expect(all.length, "no production-tree corpus call found — the extractor broke, not the tooling").toBeGreaterThanOrEqual(20);
  });

  it("no corpus over a production tree is filtered to `.ts` only", () => {
    expect(
      offenders.map((o) => `${o.file}:${o.line} — ${o.text}`),
      "a gate builds its corpus from a production tree and then drops every `.tsx`. `packages/` and " +
        "`workers/` hold 14 of them — the evidence email, the dunning notice, the quote reply, the design and " +
        "map primitives — and `apps/` is more `.tsx` than `.ts`. Six gates were measured blind this way " +
        "(§1505/§1506), one of them the float-money rule that its own dropped file states in its header. Use " +
        "`/\\.tsx?$/`; if this corpus genuinely cannot contain a component, widening it is free and this gate " +
        "is the reason it stays that way:\n  " + offenders.map((o) => `${o.file}:${o.line}`).join("\n  "),
    ).toEqual([]);
  });

  it("the detector fires on the exact shape it exists for (positive control)", () => {
    // Without this, a matcher that silently stopped recognising the predicate would report a clean tree
    // forever — the failure mode §1387 names: a scan whose green means "found none".
    const probe = [
      'const files = execSync(\'git ls-files "packages" "workers"\', { cwd: root, encoding: "utf8" })',
      '  .split("\\n")',
      '  .filter((f) => /\\.ts$/.test(f) && !f.includes(".test."));',
    ].join("\n");
    expect(PRODUCTION_TREE.test(probe.split("\n")[0] as string), "the tree matcher no longer recognises a production tree").toBe(true);
    expect(TS_ONLY.test(probe), "the `.ts`-only predicate is no longer recognised").toBe(true);
    expect(/tsx/.test(probe), "the probe must not already admit tsx, or it proves nothing").toBe(false);
  });
});
