import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { checkMigrationSql } from "./invariants.js";
import { repoRoot } from "./repo-root.js";

// REQ-118 §611 — CLAUDE.md's HARD BUDGETS ARE CHECKED AGAINST THE THINGS THAT ENFORCE THEM.
//
// §610's rule: any summary that RESTATES a value something else COMPUTES will drift, and the fix is to read
// one side and compute the other. The largest instance in the repo is not a gate's output — it is CLAUDE.md
// line 15, which states six budgets as law:
//
//   ≤22 tables (21 used) · 3 surfaces · 12 canonical views · 35 event kinds · 5 color tokens · 2 font families
//
// Every one is enforced somewhere, and **nothing read CLAUDE.md as data** — every reference to it across the
// repo is a comment or an error message quoting it. So a budget amendment (which CLAUDE.md itself says
// requires a register amendment) moves the constant and leaves the document stating the old number, in the
// file whose own header says it OVERRIDES any default behaviour and which every session reads first. A stale
// law is worse than an absent one: it is followed.
//
// MEASURED when this landed: all six agree. This locks a clean state rather than repairing a defect — §486's
// cheap half, and the case that most needs a test because nothing is failing and nothing else would notice it
// starting to.
//
// A STATIC SCAN, matching rater-purity / authority-coverage / append-chokepoint / visual-corpus. The
// alternative — importing MAX_CANONICAL_VIEWS from apps/command and TOKENS from packages/design — would pull
// a React app and a CSS-adjacent module into a node-environment tools test for two integers.
//
// The "(21 used)" parenthetical was NOT covered here, on the stated grounds that re-deriving it would be a
// second, weaker implementation of a check that already exists — the §"two mechanisms" trap. That reasoning
// is right and the conclusion drawn from it was wrong (audit §830).
//
// `check:invariants` COMPUTES the used count and prints it, but it only FAILS above TABLE_BUDGET. So a 22nd
// table makes it print `22/22` and pass, while CLAUDE.md still reads `(21 used)` — in the file whose own
// header says it overrides any default behaviour and which every session reads first. Measured: the number is
// pinned only against a copy of itself in the BUDGETS roster below, so editing both together is silent, and
// `invariants.test.ts`'s `tableCount === 21` is asserted over a SYNTHETIC fixture, not the real migrations.
//
// The fix is not a second implementation — it is READING THE FIRST. `checkMigrationSql` is the same authority
// the script calls, over the same `db/**/migrations/*.sql`; this asserts CLAUDE.md's stated figure equals what
// that authority returns. Read one side, COMPUTE the other; never store both.

interface Budget {
  /** What CLAUDE.md calls it, for the failure message. */
  label: string;
  /** Pulls the stated number out of CLAUDE.md. */
  stated: RegExp;
  /** The file that actually enforces it. */
  source: string;
  /** Pulls the enforced number out of that file. */
  enforced: (src: string) => number | null;
}

/** Count the double-quoted strings inside a named `as const` array literal. */
function countArrayEntries(src: string, name: string): number | null {
  const m = new RegExp(`${name}[^=]*=\\s*\\[(.*?)\\]\\s*as const`, "s").exec(src);
  return m === null ? null : (m[1]!.match(/"[^"]+"/g) ?? []).length;
}

/** Count the `key: value` pairs of a named `as const` object literal. */
function countObjectKeys(src: string, name: string): number | null {
  const m = new RegExp(`export const ${name} = \\{(.*?)\\}\\s*as const`, "s").exec(src);
  return m === null ? null : (m[1]!.match(/^\s*\w+:/gm) ?? []).length;
}

/** Read a `export const NAME = <int>` declaration. */
function readIntConst(src: string, name: string): number | null {
  const m = new RegExp(`export const ${name} = (\\d+)`).exec(src);
  return m === null ? null : Number(m[1]);
}

const BUDGETS: readonly Budget[] = [
  {
    label: "tables",
    stated: /≤(\d+) tables/,
    source: "tools/checks/invariants.ts",
    enforced: (s) => readIntConst(s, "TABLE_BUDGET"),
  },
  {
    label: "surfaces",
    stated: /(\d+) surfaces/,
    source: "tools/checks/invariants.ts",
    enforced: (s) => countArrayEntries(s, "SURFACE_ROSTER"),
  },
  {
    label: "canonical views",
    stated: /(\d+) canonical views/,
    source: "apps/command/src/views/registry.ts",
    enforced: (s) => readIntConst(s, "MAX_CANONICAL_VIEWS"),
  },
  {
    label: "event kinds",
    stated: /(\d+) event kinds/,
    source: "packages/contracts/src/events.ts",
    enforced: (s) => countArrayEntries(s, "EVENT_KINDS"),
  },
  {
    label: "color tokens",
    stated: /(\d+) color tokens/,
    source: "packages/design/src/tokens.ts",
    enforced: (s) => countObjectKeys(s, "TOKENS"),
  },
  {
    label: "font families",
    stated: /(\d+) font families/,
    source: "packages/design/src/tokens.ts",
    enforced: (s) => countObjectKeys(s, "FONTS"),
  },
];

// §1173 — A BUDGET IS LAW ONLY ON THE HARD-BUDGETS LINE, SO THAT IS THE ONLY PLACE TO READ IT.
//
// Every `stated` regex above used to be exec'd against the WHOLE of CLAUDE.md, and `exec` returns the FIRST
// match. Five of the six patterns occur exactly once, so they read the budgets line — by luck of phrasing,
// not by construction. `/(\d+) surfaces/` occurs TWICE: CLAUDE.md:5 ("**3 surfaces** (Command, Driver PWA,
// Portal)", the "What you are building" paragraph) comes before CLAUDE.md:15, so the surfaces budget was read
// out of PROSE and the budgets line was never consulted.
//
// MEASURED: editing the budgets line to `· 4 surfaces + command bar + queues ·` and leaving SURFACE_ROSTER at
// three left this file **9/9 GREEN** — the governing document stating a budget its enforcer contradicts, in
// the exact scenario this gate exists for. The prose restatement absorbed the drift.
//
// The completeness floor below was already correct, because it execs against the LINE. That is the whole
// difference, and it is why this is one line of fix rather than a redesign: read the law where the law is.
/** The hard-budgets line — the one place in CLAUDE.md where a budget is stated AS LAW. */
export function budgetsLine(claudeMd: string): string {
  return /## Hard budgets[^\n]*\n([^\n]*)/.exec(claudeMd)?.[1] ?? "";
}

describe("REQ-118 §611: CLAUDE.md's hard budgets match what enforces them", () => {
  const root = repoRoot();
  const claudeMd = readFileSync(`${root}/CLAUDE.md`, "utf8");
  // §1173 — read every stated budget from HERE, never from the document at large.
  const line = budgetsLine(claudeMd);

  it("every budget is stated in CLAUDE.md and readable from its source (non-vacuity)", () => {
    // Both halves can go silent: a reworded CLAUDE.md line stops matching, and a renamed/restructured
    // constant stops parsing. Either would compare undefined to undefined and pass — the class this repo met
    // in eleven gates (§487/§554/§572/§584/§586/§590/§592/§593/§598/§607/§608).
    const unreadable = BUDGETS.filter((b) => {
      const stated = b.stated.exec(line);
      const enforced = b.enforced(readFileSync(`${root}/${b.source}`, "utf8"));
      return stated === null || enforced === null;
    }).map((b) => b.label);
    expect(
      unreadable,
      "a budget could not be read from CLAUDE.md or from its enforcing source. That is a BROKEN SCAN, not a " +
        "clean record — fix the parse before trusting the comparison below",
    ).toEqual([]);
  });

  // §743 — THE ROSTER'S OWN COMPLETENESS. Both assertions above iterate BUDGETS, so a budget stated in
  // CLAUDE.md that nobody added to the roster is invisible to the gate whose entire job is "stated equals
  // enforced". MEASURED: inserting `· 7 agent queues ·` into the hard-budgets line — a budget nothing anywhere
  // enforces — left this file at 2/2 GREEN.
  //
  // That is §671's completeness-floor shape at the level of the gate itself, and it matters here more than
  // usual because the hard-budgets line is EXACTLY where a new budget would be written: CLAUDE.md says a
  // budget change is a register amendment, so the amendment lands in this line first and the enforcement
  // follows. The window between those two edits is the window this floor closes.
  //
  // Derived, not listed (§699: membership is a property of the DOCUMENT). Every `<number> <word>` pair on the
  // hard-budgets line must be claimed by some BUDGETS entry — or be named below with its reason.
  /** Every document that states the used-table figure, with the regex that finds it. §833 gates completeness. */
  const DOCS: ReadonlyArray<{ file: string; re: RegExp }> = [
    // §1174 — ANCHORED TO ITS SUBJECT, not to its shape. This read `/\((\d+)\s+used/`, and CLAUDE.md's budgets
    // line carries TWO such parentheticals — `≤22 tables (21 used; …)` and `12 canonical views (11 used, one
    // spare)`. It returned 21 only because tables are written first. Reorder the line and it compares the
    // migrations' table count against the VIEWS figure. That direction fails LOUD rather than silent (11 ≠ 21,
    // so the assertion reds), which is why this is a latent bet rather than the false pass §1173 found — but
    // it is the same mechanism, and BUILD-PROMPT.md's entry below was already anchored this way.
    { file: "CLAUDE.md", re: /≤\d+ tables \((\d+) used/ },
    { file: "README.md", re: /35 kinds,\s*(\d+)\s+tables/ },
    // FOUND BY THE §833 DISCOVERY HALF, which is the point of having one: §829 rewrote this file's stale
    // register count and §830/§831 pinned the table figure in two documents — and BUILD-PROMPT.md states it
    // too, in the same Definition of Done, and was on neither roster.
    { file: "BUILD-PROMPT.md", re: /≤22 tables \((\d+) used\)/ },
  ];

  it("§830: the \"(N used)\" table figure equals what the migrations actually declare", () => {
    // The one budget-line number that is an OBSERVATION rather than a law. `check:invariants` computes it and
    // prints it, but fails only ABOVE the budget — so a 22nd table prints `22/22`, passes, and leaves this
    // document stating 21. Nothing linked the two: the roster below holds a copy of the same literal, and
    // `invariants.test.ts` asserts 21 over a synthetic fixture rather than over `db/`.
    //
    // This calls `checkMigrationSql` — the SAME function the script calls, over the same files — so it is not
    // a second implementation of the count. It reads the authority and compares the document to it.
    const migrations = globSync("db/*/migrations/*.sql", { cwd: repoRoot() });
    expect(migrations.length, "no migration files found — the scan is stale, not the schema").toBeGreaterThan(4);
    const actual = checkMigrationSql(migrations.map((f) => readFileSync(`${repoRoot()}/${f}`, "utf8"))).tableCount;

    // BOTH documents that state the figure (§831). CLAUDE.md is the governing file; README.md is the repo's
    // front door and had already been corrected once for exactly this rot (audit §172 found its status line
    // stale by ten work packages). A gate that covered only one of them would leave the other free to drift,
    // which is how the number got two copies in the first place.
    // COLLECT then assert, rather than a loop of `expect`s. A loop is fail-fast, so when BOTH documents drift
    // — the likely case, since a table lands once and both go stale together — it names only the first and
    // the second surfaces a run later. Measured that behaviour on a planted 22nd table before changing it.
    const drifted = DOCS.map((d) => {
      const stated = d.re.exec(readFileSync(`${repoRoot()}/${d.file}`, "utf8"));
      if (stated === null) return `${d.file}: no longer states the used-table figure where this gate reads it`;
      return Number(stated[1]) === actual ? null : `${d.file}: says ${stated[1]}, migrations declare ${actual}`;
    }).filter((x): x is string => x !== null);

    expect(
      drifted,
      "a document states a used-table count the migrations contradict. A table was added or removed and the " +
        "document was not updated — and because the budget check only fails ABOVE TABLE_BUDGET, nothing else " +
        "would have said so. A stale law is worse than an absent one: it is followed.",
    ).toEqual([]);
  });

  // §1175 — EVERY RESTATEMENT OF A BUDGET, NOT JUST THE ONE THAT IS LAW.
  //
  // §610's rule is that any summary RESTATING a computed value will drift, and §1173 proved the consequence is
  // not hypothetical: CLAUDE.md:5's prose "**3 surfaces**" ABSORBED a planted drift on the budgets line and
  // kept the gate green. A second copy of a number does not merely fail to help — it conceals the first going
  // stale.
  //
  // MEASURED: the six budgets are restated 22 times across the three root governing documents, and exactly one
  // of those figures — the `(N used)` table count — was checked (by DOCS above). A budget amendment therefore
  // has to be hand-propagated to sixteen places, fifteen of which nothing verifies:
  //
  //   CLAUDE.md:5      3 surfaces                     README.md:2      3 surfaces
  //   CLAUDE.md:33     12 views (report builder)      README.md:8      35 kinds
  //   BUILD-PROMPT:13  5 tokens · 2 fonts             BUILD-PROMPT:14  ≤22 tables · 35 event kinds · 12 views · 3 surfaces
  //   BUILD-PROMPT:85-86  ≤22 tables · 35 kinds · 12 views · 3 surfaces · 5 tokens · 2 fonts
  //
  // All twenty-two agree today. This LOCKS a clean state rather than repairing a defect — §486's cheap half,
  // and the case that most needs a test because nothing is failing and nothing else would notice it starting to.
  //
  // WHOLE-TEXT, WHITESPACE-NORMALISED, NOT LINE-BY-LINE. BUILD-PROMPT.md wraps `12` at the end of :85 and
  // `views` at the start of :86, so a line scan silently misses that restatement — a budget figure invisible to
  // the gate purely because of where the paragraph wrapped.
  //
  // The BUDGET, never the USED figure: `≤(\d+) tables` is the ceiling; a bare "21 tables" (README.md:8) is the
  // observation DOCS already owns. Two different properties that share a noun.
  /** Budget label (matching BUDGETS above) → every phrasing that restates its CEILING. */
  const RESTATEMENTS: ReadonlyArray<readonly [string, RegExp]> = [
    ["tables", /≤(\d+)\s+tables/g],
    ["surfaces", /(\d+)\s+surfaces/g],
    ["canonical views", /(\d+)\s+(?:canonical\s+)?views/g],
    ["event kinds", /(\d+)\s+(?:event\s+)?kinds/g],
    ["color tokens", /(\d+)\s+(?:color\s+)?tokens/g],
    ["font families", /(\d+)\s+(?:font\s+families|fonts)/g],
  ];
  // §1176 — genesis/11 is HERE because it carries a `## Hard budgets (CI-enforced; …)` SECTION of its own: it
  // is the spec CLAUDE.md was written from, and it states the six ceilings as law rather than quoting them.
  // The two documents are NOT copies (50 differing lines; CLAUDE.md has evolved past it), which is exactly why
  // the values can drift apart silently. Measured at §1176: all 8 of its restatements agree.
  const RESTATEMENT_DOCS = ["CLAUDE.md", "README.md", "BUILD-PROMPT.md", "genesis/11-REPO-CLAUDE-MD.md"] as const;

  /** Documents that DECLARE the budgets — a `## Hard budgets` section — as opposed to quoting a figure in passing. */
  function docsDeclaringBudgets(docs: readonly { file: string; text: string }[]): string[] {
    return docs.filter((d) => /^#+ Hard budgets/m.test(d.text)).map((d) => d.file);
  }

  it("§1176 SENSITIVITY: a document declaring its own budgets section is discovered", () => {
    const planted = [
      { file: "rostered.md", text: "# X\n\n## Hard budgets (CI-enforced)\n≤22 tables\n" },
      { file: "quotes-it.md", text: "the hard budgets are CI-enforced; see CLAUDE.md\n" },
    ];
    // A HEADING declares; a mention quotes. Only the first is a place a budget goes stale as law.
    expect(docsDeclaringBudgets(planted)).toEqual(["rostered.md"]);
  });

  it("§1176: every document DECLARING a hard-budgets section is on the restatement roster", () => {
    // The roster above is an enumeration, and §1175 shipped it missing genesis/11 — a genesis document with a
    // full budgets section of its own. Enumerations acquire holes; this closes the class instead of the
    // instance. One-directional by design: the roster may cover documents that merely restate figures inline
    // (README.md, BUILD-PROMPT.md have no section), but a document that DECLARES the budgets must be on it.
    const tracked = execSync("git ls-files '*.md'", { cwd: root, encoding: "utf8" }).split("\n").filter((f) => f !== "");
    expect(tracked.length, "no tracked markdown found — the scan broke, not the corpus").toBeGreaterThan(20);
    const declaring = docsDeclaringBudgets(tracked.map((f) => ({ file: f, text: readFileSync(`${root}/${f}`, "utf8") })));
    expect(declaring.length, "no document declares a hard-budgets section — CLAUDE.md must").toBeGreaterThanOrEqual(1);

    const unrostered = declaring.filter((f) => !(RESTATEMENT_DOCS as readonly string[]).includes(f));
    expect(
      unrostered,
      "a document declares its own `## Hard budgets` section but nothing checks its figures against the " +
        "enforcers. A budget stated as law in an unchecked document is the §1173 defect with a new host: it " +
        "goes stale, it is read as current, and it absorbs drift. Add it to RESTATEMENT_DOCS:\n  " +
        unrostered.join("\n  "),
    ).toEqual([]);
  });

  /** Every stated ceiling for every budget across the given documents, wrapped lines included. */
  function statedCeilings(docs: readonly { file: string; text: string }[]): { doc: string; label: string; stated: number }[] {
    const out: { doc: string; label: string; stated: number }[] = [];
    for (const { file, text } of docs) {
      const flat = text.replace(/\s+/g, " ");
      for (const [label, re] of RESTATEMENTS) {
        for (const m of flat.matchAll(re)) out.push({ doc: file, label, stated: Number(m[1]) });
      }
    }
    return out;
  }

  it("§1175 SENSITIVITY: a restated budget that disagrees with its ceiling is flagged", () => {
    const planted = [{ file: "x.md", text: "respect budgets (≤22 tables / 35 kinds / 12\nviews / 4 surfaces / 5 tokens / 2 fonts)" }];
    const found = statedCeilings(planted);
    // The wrapped "12\nviews" must be among them — the whole reason this reads normalised text.
    expect(found.filter((f) => f.label === "canonical views").map((f) => f.stated), "wrapped restatement missed").toEqual([12]);
    expect(found.filter((f) => f.stated !== 3 && f.label === "surfaces")).toHaveLength(1);
  });

  it("§1175: every RESTATEMENT of a hard budget agrees with the number that enforces it", () => {
    const enforced = new Map(BUDGETS.map((b) => [b.label, b.enforced(readFileSync(`${root}/${b.source}`, "utf8"))!]));
    const docs = RESTATEMENT_DOCS.map((f) => ({ file: f, text: readFileSync(`${root}/${f}`, "utf8") }));
    const found = statedCeilings(docs);

    // FLOOR THE INPUT, not the findings: a pattern that stops matching would report zero disagreements, which
    // is exactly what a clean run prints. Twenty-two restatements measured at §1175.
    expect(found.length, "budget restatements vanished from the root documents — the scan broke, not the docs").toBeGreaterThanOrEqual(15);
    const silent = BUDGETS.map((b) => b.label).filter((l) => !found.some((f) => f.label === l));
    expect(silent, "a budget's restatement pattern matched NOTHING anywhere, including its own budgets line").toEqual([]);

    const wrong = found
      .filter((f) => f.stated !== enforced.get(f.label))
      .map((f) => `${f.doc}: restates ${f.label} as ${f.stated}, enforced value is ${enforced.get(f.label)}`);
    expect(
      wrong,
      "a governing document restates a hard budget that no longer matches its enforcer. These documents " +
        "are read as current law — CLAUDE.md's header says it overrides any default behaviour — and §1173 " +
        "proved a stale restatement does worse than mislead: it ABSORBS the drift and keeps the gate green. " +
        "A budget change is a register amendment; propagate it to every statement of the figure:\n  " +
        wrong.join("\n  "),
    ).toEqual([]);
  });

  it("§1174: the used-table regex names its SUBJECT, so line order cannot change what it reads", () => {
    // CLAUDE.md's budgets line carries two "(N used)" parentheticals. Shape-matching picks whichever comes
    // first; subject-anchoring picks the table figure wherever it sits. Written with the order REVERSED,
    // because with the real order both regexes agree and the test would prove nothing (§1145: a plant must
    // separate the two mechanisms, not merely coexist with them).
    const reordered = "12 canonical views (11 used, one spare) · ≤22 tables (21 used; the spare requires a written deletion)";
    expect(/\((\d+)\s+used/.exec(reordered)![1], "shape-matching reads whichever parenthetical is written first").toBe("11");
    const anchored = DOCS.find((d) => d.file === "CLAUDE.md")!.re;
    expect(anchored.exec(reordered)![1], "subject-anchored reads the TABLE figure regardless of position").toBe("21");
  });

  it("§833: no OTHER tracked document states a used-table figure without being on the DOCS roster", () => {
    // §831's residual: the assertion above reads a ROSTER of documents, so a document not on it is not
    // covered — the same blind spot §821 named for quote surfaces and §824 for list endpoints. This is the
    // discovery half. It looks for the two phrasings the roster already knows ("(N used)" beside a table
    // budget, and "N tables") in every tracked markdown file, and requires each hit to be a rostered document.
    const rostered = new Set(DOCS.map((d) => d.file));
    // ROOT-LEVEL contract documents only, and the bound is deliberate. A standing claim — "the budgets are
    // X" — lives in the files a reader treats as current: CLAUDE.md, README.md, BUILD-PROMPT.md. Everything
    // under docs/ states its counts inside a DATED structure instead: the audit is a ledger of dated phase
    // gates, RELEASE-EVIDENCE's figures sit in tables whose headers read "re-executed at <sha>", and the
    // 82e04c7 sweep established that shape across all nine ops docs. Widening this scan to docs/ would need a
    // filter that reads a table header three rows above the hit — measured, it produces eight false positives
    // and zero real ones, which is the profile of a gate people learn to silence (§817).
    const md = execSync("git ls-files '*.md'", { cwd: repoRoot(), encoding: "utf8" })
      .split("\n")
      .filter((f) => f !== "" && !f.includes("/"));
    const novel: string[] = [];
    for (const f of md) {
      if (rostered.has(f)) continue;

      const text = readFileSync(`${repoRoot()}/${f}`, "utf8");
      text.split("\n").forEach((raw, i) => {
        // Only a LIVE claim counts. A line carrying its own date or SHA is a dated observation, which §831
        // established is not this defect — README's second "167 rows" is exactly that shape and is correct.
        if (/20\d\d-\d\d-\d\d|\bat [0-9a-f]{7,40}\b|as of|History:/i.test(raw)) return;
        if (/\b\d+\s+tables\b/.test(raw) || /\(\d+\s+used/.test(raw)) novel.push(`${f}:${i + 1}  ${raw.trim().slice(0, 90)}`);
      });
    }
    expect(
      novel,
      "a document states a used-table count but is not on the DOCS roster above, so nothing checks it against " +
        "the migrations. Add it to DOCS with the regex that finds its figure, or — if the line is a dated " +
        "historical record rather than a live claim — scope it with its date, which is what makes it correct:",
    ).toEqual([]);
  });

  it("every budget STATED in CLAUDE.md is covered by the roster (§743 completeness floor)", () => {
    expect(line.length, "the hard-budgets line did not parse — a broken scan, not a clean record").toBeGreaterThan(60);

    // ZERO-TOLERANCE RULES ARE NOT COUNT COMPARISONS. "0 shadows/gradients/radius>4px" is enforced by the
    // design audit refusing a PLANTED artifact (CLAUDE.md rule 7 records that proof: a shadow, an over-budget
    // radius and a raw hex), not by reading an integer out of a source file. Exempt WITH its reason, the way
    // every other allowlist in this repo carries one — never by widening the pattern until it stops matching.
    // Each exemption is matched at the NUMBER's own position and carries its reason. The floor found all three
    // on its first run, which is the evidence it works: they are the only numbers on that line that are not
    // count-vs-constant comparisons.
    const EXEMPT: readonly string[] = [
      // A RUNTIME figure, not a budget: `check:invariants` recomputes it from the migration set across two
      // databases on every run (`invariants OK — 21/22 tables`) and fails if it exceeds TABLE_BUDGET. This
      // file's own header already excludes it, for the §"two mechanisms" reason — re-deriving it here would be
      // a second, weaker copy of a check that exists.
      "21 used",
      // §1055 — the canonical-views usage, added when CLAUDE.md's views entry adopted the tables entry's
      // convention. Same category as "21 used" and exempt for the same reason: a RUNTIME figure, not a budget.
      // `checklist-figures.test.ts` re-derives it from `apps/command/src/views/registry.ts` on every run and
      // fails if the roster and the ceiling disagree, so re-deriving it here would be the second, weaker copy
      // of a check that already exists. The BUDGET is the ceiling (12), which the roster entry above covers.
      "11 used",
      // ZERO-TOLERANCE, proven by PLANTING an artifact rather than by reading an integer: CLAUDE.md rule 7
      // records the design audit refusing a planted shadow, an over-budget radius and a raw hex. There is no
      // constant to compare against, which is exactly why it cannot be a roster entry.
      "0 shadows",
      // The radius half of the same zero-tolerance rule, and the only number on the line with no whitespace
      // after it — `radius>4px`.
      "4px",
    ];

    // Matched by SPAN, not by reconstructing the phrase: a roster regex reads `(\d+) canonical views` while a
    // naive `<n> <word>` pair yields "12 canonical", and comparing those two strings is a guess about how many
    // words a budget's name has. Instead, run each roster regex against the LINE and record the character range
    // it claims; every number on the line must fall inside some claimed range.
    const claimed: (readonly [number, number])[] = [];
    for (const b of BUDGETS) {
      const m = b.stated.exec(line);
      if (m?.index !== undefined) claimed.push([m.index, m.index + m[0].length] as const);
    }
    const numbers = [...line.matchAll(/\d+/g)];
    expect(numbers.length, "no numbers found on the hard-budgets line — the scan broke, not the line").toBeGreaterThanOrEqual(6);

    const uncovered = numbers
      .filter((m) => {
        const at = m.index!;
        if (claimed.some(([from, to]) => at >= from && at < to)) return false;
        // EXEMPT entries are matched at the same position, so a zero-tolerance rule is excused precisely where
        // it appears rather than anywhere the digit happens to occur.
        return !EXEMPT.some((e) => line.startsWith(e, at));
      })
      .map((m) => `"${line.slice(m.index!, Math.min(line.length, m.index! + 28))}…"`);
    expect(
      uncovered,
      "CLAUDE.md states a hard budget that the BUDGETS roster does not cover, so nothing checks it against an " +
        "enforcing source. A budget in this line is LAW — every session reads it first. Add a roster entry " +
        "naming what enforces it, or, if it is a zero-tolerance rule proven by planting an artifact rather " +
        "than by a count, add it to EXEMPT with that reason:\n  " +
        uncovered.join("\n  "),
    ).toEqual([]);
  });

  it("§1173: a budget is read from the BUDGETS LINE, never from prose that restates it", () => {
    // The defect this pins, as a self-contained document: the intro says three surfaces, the LAW says four.
    // Reading the document at large returns the prose figure and the drift disappears.
    const synthetic =
      "SHUDDL: the freight operating system … **13 agents**; **3 surfaces** (Command, Driver PWA, Portal) …\n" +
      "\n## Hard budgets (CI-enforced; exceeding = the PR is wrong)\n" +
      "≤22 tables (21 used) · 4 surfaces + command bar + queues · 12 canonical views · 35 event kinds\n";
    const surfaces = /(\d+) surfaces/;
    expect(surfaces.exec(synthetic)![1], "whole-document exec reaches the intro prose first").toBe("3");
    expect(surfaces.exec(budgetsLine(synthetic))![1], "the LAW says four — this is the figure the gate must check").toBe("4");
  });

  it("each stated budget equals the number its gate actually enforces", () => {
    const drift = BUDGETS.map((b) => {
      const stated = Number(b.stated.exec(line)![1]);
      const enforced = b.enforced(readFileSync(`${root}/${b.source}`, "utf8"))!;
      return { label: b.label, stated, enforced, source: b.source };
    }).filter((d) => d.stated !== d.enforced);

    expect(
      drift,
      "CLAUDE.md states a budget that no longer matches what enforces it. The document is the source-of-truth " +
        "every session reads FIRST and its header says it overrides any default behaviour, so a stale number " +
        "there is followed as law. If the budget genuinely changed, that is a register amendment (CLAUDE.md " +
        "says so itself) — amend the row, then update the line:\n  " +
        drift.map((d) => `${d.label}: CLAUDE.md says ${d.stated}, ${d.source} enforces ${d.enforced}`).join("\n  "),
    ).toEqual([]);
  });
});
// ── §842 — EVERY FIXTURE GATE CLAUDE.md NAMES MUST EXIST ──────────────────────────────────────────────
//
// §830/§831 pinned CLAUDE.md's table COUNT to the migrations. Nothing pinned that the fixture gates rule 6
// NAMES correspond to real fixtures — which is how `routes ±10%` sat in the governing file for the length of
// the build with no fixture, no manifest entry, and no implementation anywhere in `tools/` or `package.json`.
//
// It is filed as an OWNER DECISION (GO-LIVE-CHECKLIST, audit §61/§68) and appears in TWO source-of-truth
// documents (`genesis/11:41`, `genesis/14:52`), which is what makes it settled intent rather than a typo.
// So it is recorded as a known exception rather than made to fail: **a gate that reds on a filed, parked
// decision gets disabled, and takes the unfiled cases with it.** The point of this check is the FIFTH name.

// §953 — REAL ≠ REACHED. This gate answers "does something IMPLEMENT each gate rule 6 names?" and has
// answered it correctly throughout. It does NOT answer "is that implementation RUN by the merge gate?" —
// a separate property that was FALSE for three of the four: the soak (workers/api), the QB export and the
// legacy-export replay (packages/ledger) all live in the package suites, which §940 proved were not
// executing while `test`'s `&&` short-circuited on the REQ-289 row. "Fixtures gate merges" was a law whose
// enforcement was not running, and nothing was broken only because every package suite was green.
// Reachability is enforced by `gate-wiring.test.ts` — the recursive half must run UNCONDITIONALLY (§941)
// and with `--no-bail` (§949). Two gates, two claims; neither implies the other, and the space between them
// had no owner until §953 named it.
/** Rule 6's named gates → the manifest fixture that implements each. */
const NAMED_FIXTURE_GATES: Record<string, string> = {
  "legacy-export replay": "legacy-export-replay",
  "QB export": "qb-journal-month",
  "airplane-mode soak": "airplane-soak",
};

/** Named in rule 6, implemented by nothing. Each needs its filed decision. */
const NAMED_BUT_ABSENT: Record<string, string> = {
  "routes ±10%":
    "OWNER DECISION, filed in GO-LIVE-CHECKLIST (audit §61/§68): a gate name with nothing behind it, in genesis/11:41 AND genesis/14:52. Verified again at §842 — no manifest fixture, no tools/ implementation, no package.json script. Either implement it or strike it from rule 6; this row goes in the same commit.",
};

describe("§842: every fixture gate CLAUDE.md rule 6 names is real", () => {
  const root = repoRoot();
  const rule6 = readFileSync(`${root}/CLAUDE.md`, "utf8")
    .split("\n")
    .find((l) => /^\d+\.\s+\*\*Fixtures gate merges\*\*/.test(l.trim()));
  const manifest = JSON.parse(readFileSync(`${root}/fixtures/manifest.json`, "utf8")) as Record<string, unknown>;
  const fixtureIds = new Set(
    (Array.isArray(manifest) ? manifest : ((manifest["fixtures"] as unknown[]) ?? [])).flatMap((f) => {
      const o = f as Record<string, unknown>;
      const id = o["id"] ?? o["name"];
      return typeof id === "string" ? [id] : [];
    }),
  );

  it("rule 6 and the manifest both parsed (non-vacuity)", () => {
    expect(rule6, "CLAUDE.md no longer has a `**Fixtures gate merges**` line — the scan is stale, not the rule").toBeDefined();
    expect(fixtureIds.size, "fixtures/manifest.json yielded no ids — the shape changed").toBeGreaterThanOrEqual(10);
  });

  it("every gate rule 6 names is backed by a manifest fixture, or filed as absent", () => {
    const unbacked = Object.entries(NAMED_FIXTURE_GATES)
      .filter(([name]) => rule6!.includes(name))
      .filter(([, fixture]) => !fixtureIds.has(fixture))
      .map(([name, fixture]) => `${name} → expected fixture "${fixture}", not in the manifest`);
    expect(
      unbacked,
      "CLAUDE.md rule 6 names a fixture gate whose manifest fixture is gone. Rule 6 is LAW — every session " +
        "reads it first — so a gate name with nothing behind it reads as coverage that does not exist, which " +
        "is exactly the `routes ±10%` defect filed since §61. Restore the fixture, rename the mapping here, " +
        "or strike the gate from rule 6:\n  " +
        unbacked.join("\n  "),
    ).toEqual([]);
  });

  it("rule 6 names no NEW gate that is neither backed nor filed", () => {
    // The point of the whole check: the fifth name. Splits rule 6 on its own separator and requires each
    // fragment to be a known-backed gate, a known-absent one, or a numeric tolerance rather than a gate name.
    const fragments = (rule6 ?? "")
      .replace(/^.*?\*\*Fixtures gate merges\*\*:\s*/, "")
      .split("·")
      .map((f) => f.replace(/\(.*?\)/g, "").trim())
      .filter((f) => f.length > 0);
    const known = [...Object.keys(NAMED_FIXTURE_GATES), ...Object.keys(NAMED_BUT_ABSENT)];
    const novel = fragments.filter((f) => !known.some((k) => f.includes(k.split(" ")[0]!)));
    expect(
      novel,
      "rule 6 names a fixture gate this check does not know. Map it to its manifest fixture in " +
        "NAMED_FIXTURE_GATES, or — if nothing implements it — file it in NAMED_BUT_ABSENT with the decision, " +
        "the way `routes ±10%` is filed:\n  " +
        novel.join("\n  "),
    ).toEqual([]);
  });

  it("§672: the `routes` exception has not outlived its subject", () => {
    // If routes is ever implemented or struck, this row must go in the same commit.
    expect(rule6, "`routes` is filed as named-but-absent, but rule 6 no longer names it — delete the row").toContain("routes");
    expect(
      fixtureIds.has("routes"),
      "a `routes` fixture now EXISTS — the §61 owner decision resolved. Move it into NAMED_FIXTURE_GATES and delete the NAMED_BUT_ABSENT row.",
    ).toBe(false);
  });
});
