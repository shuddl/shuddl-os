import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./repo-root.js";
import {
  RATCHET_CONFIG_PATH,
  checkRatchet,
  countUnanchored,
  formatRatchetViolation,
  loadRatchetConfig,
  writeRatchetBaseline,
} from "./citation-ratchet.js";

// The citation link-checker: a `path:line` reference in a document or a source comment must name a
// file that exists AND a line that exists inside it. The predecessor of this gate was a one-off
// link-check that ran `existsSync` over paths only — it could see a wrong PATH but never a wrong LINE
// RANGE, which is the way a citation actually rots (code moves, the pointer does not). Real damage
// paid for this file: a close-out hand-corrected ~a dozen rotted citations twice, and two adversarial
// reviews were partly spent re-deriving line numbers from scratch.
//
// SCOPE (deliberate): every tracked `.md` file in full, and the COMMENTS of every tracked `.ts`/`.tsx`
// file. Those are the two places this repo writes citations. Code, strings and untracked files are not
// scanned; `git ls-files` is the resolution universe, so a citation to an untracked file reads as
// missing — a gate must be reproducible from a clean checkout.
//
// TWO RULES, and they cover different failures:
//   1. RESOLUTION + BOUNDS (always on): the path must resolve and the highest cited line must exist.
//      This catches a moved/renamed file and a citation into a file that has since shrunk.
//   2. CONTENT ANCHOR (opt-in, `path:line@symbol`): the symbol must appear within ±2 lines of the
//      cited span. This is the ONLY rule that catches the way citations usually rot — the line still
//      exists, and the code moved out from under it. Rule 1 is structurally blind to that, so an
//      UNanchored citation is only ever bounds-checked; adopting an anchor is per-citation, and the
//      places that have actually rotted before are the places worth spending one on.
//
// FALSE POSITIVES are the failure mode that kills a gate (a sibling drift check trained readers to
// skim past it by reporting three phantoms). Three rules keep this one honest:
//   1. a citation must carry a KNOWN source/doc extension, so `localhost:4321`, `12:30`, `host:8080`,
//      `pnpm@10.6.1`, `node:fs` and a bare requirement-id prefix cannot match;
//   2. URLs are masked before matching, so a port in a URL is never a line number;
//   3. when a basename resolves to several files, a violation is raised ONLY if EVERY candidate fails.
// A bare `:123` self-reference is NOT parsed: in this corpus it sometimes means "this file" and
// sometimes "the file named earlier in the sentence", and a guess would be exactly the phantom above.

/** Extensions a citation target may carry. An allowlist, so a domain (`.tech:8443`) can never match. */
const CITABLE_EXTENSIONS = [
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "json", "md", "sql", "yml", "yaml", "toml", "css", "html", "sh", "csv", "txt",
] as const;

const CITATION_RE = new RegExp(
  // not preceded by a path/word char (so we never match the tail of a longer token)
  String.raw`(?<![\w./@-])` +
    // the path: optional directory segments then `name.ext`
    String.raw`((?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\.(?:${CITABLE_EXTENSIONS.join("|")}))` +
    // `:` then one or more line specs: `12`, `12-14`, `12–14` (en dash), comma-joined
    String.raw`:(\d+(?:[-–]\d+)?(?:,\d+(?:[-–]\d+)?)*)` +
    // OPTIONAL content anchor `@symbol`, running to the next space, backtick or quote
    String.raw`(?:@([^\s\`'"]+))?` +
    // not followed by more word/digit chars (so `foo.ts:12abc` is not a citation)
    String.raw`(?![\w])`,
  "g",
);

/**
 * How far from the cited line an anchor may be found: ±2 lines (and ±2 at EACH end of a range).
 *
 * Zero tolerance would make the gate cry wolf on every cosmetic edit — an added import, a wrapped
 * signature, one blank line — which is the failure mode that gets a gate ignored. A wide tolerance
 * (±10) would let an anchor pass while the citation actually points into the NEIGHBOURING function,
 * i.e. it would certify the very defect it exists to catch. Two lines is the width of the ordinary
 * insertion (a blank line plus a comment) and is narrower than any real code block, so it absorbs
 * noise without ever spanning two subjects. The corpus already contains a live case: the
 * tile-provenance citation is written `:55` and the line is now 56.
 */
const ANCHOR_TOLERANCE = 2;

/** A line carrying this marker is skipped — the general escape hatch, for prose no rule below fits. */
const IGNORE_MARKER = "citation-check: ignore";

/**
 * A markdown `~~strikethrough~~` span is this repo's SUPERSESSION convention: a record row that is now
 * wrong is struck through in place with a dated correction beside it, never deleted
 * (`docs/ops/GO-LIVE-CHECKLIST.md` §1.1). A struck citation is therefore declared-stale by construction
 * — demanding it resolve would force deleting the history the convention exists to keep. The CORRECTION
 * that replaces it, sitting on the same line outside the strikethrough, is still checked.
 */
const STRIKETHROUGH_RE = /~~[\s\S]*?~~/g;

export interface Citation {
  /** repo-relative path of the file that CONTAINS the citation */
  citingFile: string;
  /** 1-indexed line of the citation inside `citingFile` */
  citingLine: number;
  /** the cited path exactly as written */
  path: string;
  /** the line spec exactly as written: `926-929`, `60,93`, `98–124` */
  spec: string;
  /** the spec parsed into inclusive [start, end] pairs */
  ranges: readonly (readonly [number, number])[];
  /** the OPT-IN content anchor: a literal substring that must appear near the cited line */
  symbol?: string;
}

export interface CitationViolation {
  citingFile: string;
  citingLine: number;
  citedPath: string;
  citedSpec: string;
  citedSymbol?: string;
  reason: string;
}

/** The resolution universe. `lines` returns null for a path that cannot be read. */
export interface RepoIndex {
  paths: readonly string[];
  lines(path: string): readonly string[] | null;
}

/** Blank out URLs so a port (`:8443`) can never be read as a line number. */
function maskUrls(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, (m) => " ".repeat(m.length));
}

/** Blank out `~~superseded~~` spans (markdown only) so a struck record keeps its stale pointer. */
function maskStrikethrough(text: string): string {
  return text.replace(STRIKETHROUGH_RE, (m) => " ".repeat(m.length));
}

function parseSpec(spec: string): readonly (readonly [number, number])[] {
  return spec.split(",").map((part) => {
    const [a, b] = part.split(/[-–]/);
    const start = Number(a);
    return [start, b === undefined ? start : Number(b)] as const;
  });
}

function citationsInLine(citingFile: string, citingLine: number, text: string): Citation[] {
  if (text.includes(IGNORE_MARKER)) return [];
  const out: Citation[] = [];
  for (const m of maskUrls(text).matchAll(CITATION_RE)) {
    const path = m[1];
    const spec = m[2];
    if (path === undefined || spec === undefined) continue;
    const symbol = m[3];
    out.push({ citingFile, citingLine, path, spec, ranges: parseSpec(spec), ...(symbol === undefined ? {} : { symbol }) });
  }
  return out;
}

/**
 * Return only the COMMENT text of one TypeScript line, given the block-comment state carried in.
 * Line-based, not a TS parse: enough for line comments, block comments and jsdoc continuations, and
 * it never reads code — which is what keeps a `path:line` inside a string literal from counting.
 */
export function commentTextOf(line: string, inBlock: boolean): { text: string; inBlock: boolean } {
  const masked = maskUrls(line);
  let out = "";
  let i = 0;
  let block = inBlock;
  let quote: string | null = null;
  while (i < masked.length) {
    if (block) {
      const end = masked.indexOf("*/", i);
      if (end === -1) {
        out += ` ${masked.slice(i)}`;
        break;
      }
      out += ` ${masked.slice(i, end)}`;
      i = end + 2;
      block = false;
      continue;
    }
    const ch = masked[i];
    // Quote tracking is what makes "it never reads code" true: a `//` INSIDE a string literal opens
    // no comment. Without it, a test that passes a comment-SHAPED string to the parser is itself read
    // as a citation — which is exactly how this gate first false-positived, on its own test file.
    if (quote !== null) {
      if (ch === "\\") i += 2;
      else {
        if (ch === quote) quote = null;
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === "/" && masked[i + 1] === "/") {
      out += ` ${masked.slice(i)}`;
      break;
    }
    if (ch === "/" && masked[i + 1] === "*") {
      block = true;
      i += 2;
      continue;
    }
    i += 1;
  }
  return { text: out, inBlock: block };
}

/** Every citation in one file. Markdown is read in full; TypeScript only in its comments. */
export function extractCitations(citingFile: string, content: string): Citation[] {
  const lines = content.split("\n");
  const out: Citation[] = [];
  if (/\.(ts|tsx|mts|cts)$/.test(citingFile)) {
    let inBlock = false;
    lines.forEach((raw, i) => {
      const region = commentTextOf(raw, inBlock);
      inBlock = region.inBlock;
      if (region.text.trim() !== "") out.push(...citationsInLine(citingFile, i + 1, region.text));
    });
    return out;
  }
  lines.forEach((raw, i) => out.push(...citationsInLine(citingFile, i + 1, maskStrikethrough(raw))));
  return out;
}

function posixNormalize(path: string): string {
  const segments: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") segments.pop();
    else segments.push(seg);
  }
  return segments.join("/");
}

function dirOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Every file the cited path could plausibly mean, most-specific first:
 *   1. the path read from the repo root;
 *   2. the path read as a sibling of the citing file — how a bare basename in a doc, or in a source
 *      comment next to the file it names, is meant to be read;
 *   3. every tracked file whose path ENDS with it — this is what lets a partial path
 *      (`contracts/src/events.ts`) and a bare basename (`money.ts`) resolve at all.
 * An explicitly relative citation (`./x`, `../x`) is resolved relative to the citing file only.
 */
export function resolveCandidates(cited: string, citingFile: string, paths: readonly string[]): string[] {
  const known = new Set(paths);
  const sibling = posixNormalize(`${dirOf(citingFile)}/${cited}`);
  if (cited.startsWith("./") || cited.startsWith("../")) return known.has(sibling) ? [sibling] : [];

  const normalized = posixNormalize(cited);
  const out: string[] = [];
  if (known.has(normalized)) out.push(normalized);
  if (known.has(sibling) && !out.includes(sibling)) out.push(sibling);
  const suffix = normalized.includes("/")
    ? paths.filter((p) => p.endsWith(`/${normalized}`))
    : paths.filter((p) => baseOf(p) === normalized);
  for (const p of suffix) if (!out.includes(p)) out.push(p);
  return out;
}

function malformedReason(ranges: readonly (readonly [number, number])[]): string | null {
  for (const [start, end] of ranges) {
    if (start < 1 || end < 1) return "line 0 is not a line — a citation is 1-indexed";
    if (start > end) return `inverted range ${start}-${end} — the start is past the end`;
  }
  return null;
}

/**
 * The window an anchor may be found in: the cited span, widened by ANCHOR_TOLERANCE at each end and
 * clamped to the file. Returned 1-indexed and inclusive, matching how a citation is written.
 */
function anchorWindow(ranges: readonly (readonly [number, number])[], lineCount: number): { from: number; to: number } {
  const lowest = Math.min(...ranges.map(([start]) => start));
  const highest = Math.max(...ranges.map(([, end]) => end));
  return { from: Math.max(1, lowest - ANCHOR_TOLERANCE), to: Math.min(lineCount, highest + ANCHOR_TOLERANCE) };
}

/** Every 1-indexed line of `lines` containing `symbol` as a literal substring. */
function linesContaining(lines: readonly string[], symbol: string): number[] {
  const hits: number[] = [];
  lines.forEach((text, i) => {
    if (text.includes(symbol)) hits.push(i + 1);
  });
  return hits;
}

/**
 * Why the anchor fails on this candidate, or null if it holds. The message must let a reader fix the
 * citation WITHOUT opening the file: it says where the symbol actually is, or that it is gone.
 */
function anchorReason(c: Citation, path: string, lines: readonly string[]): string | null {
  const symbol = c.symbol;
  if (symbol === undefined) return null;
  const { from, to } = anchorWindow(c.ranges, lines.length);
  const hits = linesContaining(lines, symbol);
  if (hits.some((n) => n >= from && n <= to)) return null;
  if (hits.length === 0) return `anchor "${symbol}" appears nowhere in ${path} — the anchor itself is wrong, or the code is gone`;
  const shown = hits.slice(0, 3).map((n) => `:${n}`).join(", ");
  const more = hits.length > 3 ? ` (+${hits.length - 3} more)` : "";
  return `anchor "${symbol}" not found in lines ${from}-${to} (cited span ±${ANCHOR_TOLERANCE}) — it IS at ${shown}${more}: repoint the citation`;
}

/** Every violation among the given citations. Pure over `index`: no disk access, fully testable. */
export function checkCitations(citations: readonly Citation[], index: RepoIndex): CitationViolation[] {
  const violations: CitationViolation[] = [];
  for (const c of citations) {
    const base = {
      citingFile: c.citingFile,
      citingLine: c.citingLine,
      citedPath: c.path,
      citedSpec: c.spec,
      ...(c.symbol === undefined ? {} : { citedSymbol: c.symbol }),
    };
    const malformed = malformedReason(c.ranges);
    if (malformed !== null) {
      violations.push({ ...base, reason: malformed });
      continue;
    }
    const candidates = resolveCandidates(c.path, c.citingFile, index.paths);
    if (candidates.length === 0) {
      violations.push({ ...base, reason: "no such file in the repo (dangling path — check for a moved or renamed file)" });
      continue;
    }
    const highest = Math.max(...c.ranges.map(([, end]) => end));
    const read = candidates
      .map((p) => ({ path: p, lines: index.lines(p) }))
      .filter((x): x is { path: string; lines: readonly string[] } => x.lines !== null);
    // Unreadable everywhere (binary / vendored bytes): unverifiable, and an unverifiable citation is
    // not evidence of a defect. Stay silent rather than cry wolf.
    if (read.length === 0) continue;

    // BOUNDS first — an out-of-range line is the more basic fault, and reporting the anchor instead
    // would send the reader looking for a symbol in a region that does not exist.
    const inBounds = read.filter((x) => highest <= x.lines.length);
    if (inBounds.length === 0) {
      const first = read[0];
      const reason =
        read.length === 1 && first !== undefined
          ? `${first.path} has ${first.lines.length} lines — line ${highest} does not exist`
          : `no candidate file reaches line ${highest} (${read.length} candidates: ${read.map((x) => `${x.path}=${x.lines.length}`).join(", ")})`;
      violations.push({ ...base, reason });
      continue;
    }
    if (c.symbol === undefined) continue;

    // Same ambiguity discipline as bounds: a violation only when EVERY viable candidate fails.
    const reasons = inBounds.map((x) => anchorReason(c, x.path, x.lines));
    if (reasons.some((r) => r === null)) continue;
    // `.some(r => r === null)` above already returned for any null, but that cannot narrow the array —
    // collapse the out-of-range `undefined` into `null` so the single-candidate branch is a plain string.
    const first = reasons[0] ?? null;
    const reason =
      reasons.length === 1 && first !== null
        ? first
        : `anchor "${c.symbol}" holds in none of the ${reasons.length} candidate files — ${inBounds.map((x, i) => `${x.path}: ${reasons[i] ?? ""}`).join(" | ")}`;
    violations.push({ ...base, reason });
  }
  return violations;
}

/** `citing-file:line → cited-path:line[@symbol] — reason`: a reader can jump straight to the citation. */
export function formatViolation(v: CitationViolation): string {
  const anchor = v.citedSymbol === undefined ? "" : `@${v.citedSymbol}`;
  return `${v.citingFile}:${v.citingLine} → ${v.citedPath}:${v.citedSpec}${anchor} — ${v.reason}`;
}

function trackedFiles(root: string): string[] {
  return execSync("git ls-files", { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
}

/** A file's lines, 1-indexed by position, with the trailing empty element of a final newline dropped. */
function splitLines(content: string): string[] {
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

/** The real repo as a RepoIndex: tracked paths, file contents read (and cached) on demand. */
export function buildRepoIndex(cwd: string = process.cwd()): RepoIndex {
  // Listing and reading must share ONE resolved root: rooting the list while reading against `cwd` would
  // resolve every path wrongly the moment this ran from anywhere but the top.
  const root = repoRoot(cwd);
  const paths = trackedFiles(root);
  const cache = new Map<string, readonly string[] | null>();
  return {
    paths,
    lines(path: string): readonly string[] | null {
      const hit = cache.get(path);
      if (hit !== undefined) return hit;
      let value: readonly string[] | null = null;
      try {
        value = splitLines(readFileSync(join(root, path), "utf8"));
      } catch {
        value = null;
      }
      cache.set(path, value);
      return value;
    },
  };
}

/** Every citation in every tracked markdown file and TypeScript comment. */
/**
 * Every line the `citation-check: ignore` escape suppresses, as `file:line` (audit §272).
 *
 * The marker makes `citationsInLine` return `[]` — silently, and the gate's success line never mentioned it,
 * so a rotted citation could be retired by adding a comment and NOTHING would report the change. That is the
 * one way this gate can be weakened without failing. Counting is the whole fix: the OK line now names the
 * number, and a test pins it, so the first real suppression is a deliberate, visible act rather than a
 * silent one. (Today: zero. The only occurrences in the tree are this scanner's own docs and its tests.)
 */
export function suppressedLines(cwd: string = process.cwd()): string[] {
  const root = repoRoot(cwd); // §487 — one resolved root for both listing and reading
  const out: string[] = [];
  for (const file of trackedFiles(root)) {
    if (!/\.(md|ts|tsx|mts|cts)$/.test(file)) continue;
    if (file.startsWith("tools/checks/")) continue; // the scanner's own source, docs and fixtures
    let content: string;
    try {
      content = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    content.split("\n").forEach((line, i) => {
      if (!line.includes(IGNORE_MARKER)) return;
      // A MENTION is not a USE. `citationsInLine` skips any line containing the marker, so prose *about* the
      // escape hatch (this file's own docs, an audit section explaining it) is skipped too — but nothing was
      // suppressed there. Count only lines where removing the marker would actually have yielded a citation,
      // i.e. where the hatch is doing work. Found by this counter's own pin failing on the section that
      // introduced it (audit §272).
      const withoutMarker = line.split(IGNORE_MARKER).join("");
      if (citationsInLine(file, i + 1, withoutMarker).length > 0) out.push(`${file}:${i + 1}`);
    });
  }
  return out;
}

export function collectCitations(cwd: string = process.cwd()): Citation[] {
  const root = repoRoot(cwd); // §487 — one resolved root for both listing and reading
  const out: Citation[] = [];
  for (const file of trackedFiles(root)) {
    if (!/\.(md|ts|tsx|mts|cts)$/.test(file)) continue;
    let content: string;
    try {
      content = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    out.push(...extractCitations(file, content));
  }
  return out;
}

// REQ-118 §733 — REPAIRING AN ANCHORED CITATION IS DERIVABLE; DOING IT BY HAND IS NOT RELIABLE.
//
// An anchored citation (`path:line@symbol`) rots whenever lines shift in the target. That is not a rare
// event and it is documented as a RECURRENCE: `share-lint-matchers-with-parity-tests` records its own
// citations reading `:204` until §175 and `:392`/`:29` until §253, and §732 shifted the same file a third
// time — 8 rotted citations across five files from a 25-line comment insert.
//
// The repair is mechanical, and yet the hand repair failed TWICE in one sitting (§732): once by matching only
// the rooted `tools/checks/invariants.ts:` form and missing the bare `invariants.ts:` one, once by taking the
// line from `grep -n "\bSYMBOL\b" | head -1` — the first MENTION, usually a comment, not the DECLARATION.
// A mechanical repair belongs in code.
//
// IT FAILS CLOSED, AND THAT IS THE WHOLE DESIGN. A repair tool that silently repoints a citation at the wrong
// line is strictly worse than the manual chore, because the gate then goes green over a false address. So it
// derives a new line ONLY when the answer is unambiguous, and REFUSES — loudly, non-zero — otherwise:
//
//   • unanchored citation      → no ground truth exists. The anchor is the only thing that says WHAT was meant.
//   • multi-range spec         → one symbol cannot tell you the new span of `926-929` or `60,93`.
//   • target unreadable        → a moved or deleted file is a human decision, not a line shift.
//   • symbol found 0 times     → renamed or removed. Repointing would invent an address.
//   • symbol found >1 times    → AMBIGUOUS. This is exactly the case my hand repair got wrong by picking the
//                                first hit; the tool must not repeat it under an air of authority.

export interface CitationRepair {
  citingFile: string;
  citingLine: number;
  /** the citation exactly as it appears today */
  from: string;
  /** the same citation with the line re-derived from the anchor */
  to: string;
}

export interface CitationRepairRefusal {
  citingFile: string;
  citingLine: number;
  cited: string;
  reason: string;
}

/** Pure: what a `--fix` run WOULD do, and what it declines to touch. No I/O beyond the supplied index. */
export function planCitationRepairs(
  violations: readonly CitationViolation[],
  index: RepoIndex,
): { repairs: CitationRepair[]; refusals: CitationRepairRefusal[] } {
  const repairs: CitationRepair[] = [];
  const refusals: CitationRepairRefusal[] = [];
  for (const v of violations) {
    const cited = `${v.citedPath}:${v.citedSpec}${v.citedSymbol === undefined ? "" : `@${v.citedSymbol}`}`;
    const refuse = (reason: string): void => {
      refusals.push({ citingFile: v.citingFile, citingLine: v.citingLine, cited, reason });
    };
    if (v.citedSymbol === undefined) {
      refuse("unanchored — there is no anchor to re-derive the line from; fix it by hand or adopt an anchor");
      continue;
    }
    if (/[-–,]/.test(v.citedSpec)) {
      refuse(`multi-line spec "${v.citedSpec}" — one symbol cannot determine the new span`);
      continue;
    }
    // Resolve the cited path the SAME way the gate does. A citation may be written bare (a filename, no
    // directory — this comment deliberately does NOT spell the form out, because the gate would parse the
    // example as a real citation and report it rotted; measured, and it is the only rot this phase caused)
    // or rooted; the first build of this planner passed the raw string to `index.lines()` and refused every
    // bare form as "does not resolve" — 8 of the 15 refusals in its first real run. Reusing `resolveCandidates`
    // is not a convenience, it is the difference between the tool answering the same question as the gate and
    // answering a different one.
    const candidates = resolveCandidates(v.citedPath, v.citingFile, index.paths);
    if (candidates.length !== 1) {
      refuse(
        candidates.length === 0
          ? "cited file does not resolve — a move or delete is a human decision, not a line shift"
          : `cited path is ambiguous across ${candidates.length} files — the gate would not know which either`,
      );
      continue;
    }
    const lines = index.lines(candidates[0]!);
    if (lines === null) {
      refuse("cited file resolved but could not be read");
      continue;
    }
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) if (lines[i]!.includes(v.citedSymbol)) hits.push(i + 1);
    if (hits.length === 0) {
      refuse(`anchor "${v.citedSymbol}" appears nowhere in the target — renamed or removed, so any new line would be invented`);
      continue;
    }
    // MULTIPLE HITS ARE THE NORMAL CASE, NOT THE EXCEPTION — and the first build got this wrong.
    //
    // A symbol appears at its declaration AND at every use, so `FORBIDDEN_REPLACE` matched 4 lines and the
    // planner refused. Refusing everything is safe and useless: it refused 15 of 15 on the exact rot it was
    // built for. But "pick the first hit" is the specific error my hand repair made in §732.
    //
    // The resolution is that these citations point at where a symbol is DEFINED, so a declaration is a
    // qualitatively different hit from a use — and if exactly one hit is a declaration, there is no guess
    // left to make. If none is (an anchor may be arbitrary text, not just a symbol), or several are, it
    // still refuses. This narrows the refusals to cases that genuinely need a human, instead of all of them.
    const declaration = new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:const|let|var|function|class|interface|type|enum)\\s+${v.citedSymbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    const declHits = hits.filter((n) => declaration.test(lines[n - 1]!));
    const chosen = hits.length === 1 ? hits[0]! : declHits.length === 1 ? declHits[0]! : null;
    if (chosen === null) {
      refuse(
        `anchor "${v.citedSymbol}" appears on ${hits.length} lines (${hits.slice(0, 5).join(", ")}${hits.length > 5 ? ", …" : ""}) and ` +
          `${declHits.length} of them look like a declaration — AMBIGUOUS; picking one is how a hand repair goes wrong`,
      );
      continue;
    }
    const to = `${v.citedPath}:${chosen}@${v.citedSymbol}`;
    if (to === cited) {
      refuse("already points at the anchor — the violation is something other than a line shift");
      continue;
    }
    repairs.push({ citingFile: v.citingFile, citingLine: v.citingLine, from: cited, to });
  }
  return { repairs, refusals };
}

/**
 * Apply a plan. Returns the repairs it could NOT apply — a citation whose text is not on the line it was
 * reported on, or appears twice there, is left alone rather than guessed at.
 */
export function applyCitationRepairs(repairs: readonly CitationRepair[], root: string): CitationRepair[] {
  const byFile = new Map<string, CitationRepair[]>();
  for (const r of repairs) byFile.set(r.citingFile, [...(byFile.get(r.citingFile) ?? []), r]);
  const unapplied: CitationRepair[] = [];
  for (const [file, rs] of byFile) {
    const path = join(root, file);
    const lines = readFileSync(path, "utf8").split("\n");
    let touched = false;
    for (const r of rs) {
      const idx = r.citingLine - 1;
      const line = lines[idx];
      if (line === undefined || line.split(r.from).length !== 2) {
        unapplied.push(r); // absent, or present more than once — ambiguous within the line
        continue;
      }
      lines[idx] = line.replace(r.from, r.to);
      touched = true;
    }
    if (touched) writeFileSync(path, lines.join("\n"));
  }
  return unapplied;
}

function main(): void {
  const citations = collectCitations();
  const index = buildRepoIndex();

  // NON-VACUITY (audit §487). This gate's inputs are `git ls-files` scans, which were CWD-relative — run
  // from `tools/checks/` it reported `citation-links OK — 0 path:line citations resolve to a real file`,
  // a clean bill over an empty corpus, in the gate whose whole job is keeping the record's addresses
  // honest. (It then happened to exit 1, but from an unhandled ENOENT on the ratchet config, not from a
  // verdict — a crash that made the vacuous OK above it look survivable.) The rooting in `trackedFiles`
  // removes the cause; this floor catches any other way the corpus could empty out, and is stated in terms
  // of the RESOLUTION UNIVERSE as well as the citations, because a repo with zero tracked files and a repo
  // with zero citations are different failures.
  if (index.paths.length === 0 || citations.length === 0) {
    console.error(
      `FAIL citation-links — scanned ${index.paths.length} tracked file(s) and found ${citations.length} ` +
        `citation(s). A gate that reads nothing reports clean (audit §487). Expected \`git ls-files\` to ` +
        `list the tree from ${process.cwd()}; run this from the repo root.`,
    );
    process.exit(1);
  }

  const violations = checkCitations(citations, index);

  // §733 — `--fix` re-derives the LINE of an anchored citation from its anchor. It never invents an address:
  // anything ambiguous is refused and the run exits non-zero, so a partial repair can never read as a clean one.
  if (process.argv.includes("--fix")) {
    const { repairs, refusals } = planCitationRepairs(violations, index);
    const root = repoRoot(process.cwd());
    const unapplied = applyCitationRepairs(repairs, root);
    const applied = repairs.filter((r) => !unapplied.includes(r));
    for (const r of applied) console.log(`fixed ${r.citingFile}:${r.citingLine}  ${r.from} → ${r.to}`);
    for (const r of unapplied) console.error(`REFUSED ${r.citingFile}:${r.citingLine} — "${r.from}" is not uniquely present on that line`);
    for (const r of refusals) console.error(`REFUSED ${r.citingFile}:${r.citingLine} ${r.cited} — ${r.reason}`);
    const left = refusals.length + unapplied.length;
    console.log(`\ncitation-fix: ${applied.length} repaired, ${left} left for a human (of ${violations.length} rotted).`);
    process.exit(left > 0 ? 1 : 0);
  }

  if (violations.length > 0) {
    for (const v of violations) console.error(`FAIL citation-links ${formatViolation(v)}`);
    console.error(`\n${violations.length} rotted citation(s) of ${citations.length} checked.`);
    process.exit(1);
  }
  const suppressed = suppressedLines();
  const anchored = citations.filter((c) => c.symbol !== undefined).length;
  console.log(
    `citation-links OK — ${citations.length} path:line citations resolve to a real file and an in-bounds line; ` +
      `${anchored} of them are content-anchored (the symbol still sits within ±${ANCHOR_TOLERANCE} lines of the cited span); ` +
      `${suppressed.length} line(s) suppressed by \`citation-check: ignore\`${suppressed.length > 0 ? ` — ${suppressed.join(", ")}` : ""}`,
  );

  // The adoption ratchet runs only once the citations themselves are clean: a rotted citation is the
  // more basic fault, and reporting an adoption count on top of it would bury the defect.
  // The ratchet config is read at a REPO-RELATIVE path, so it needs the same root the scans now use.
  // Off-root this threw an unhandled ENOENT — a crash, not a verdict, which is why the vacuous
  // `OK — 0 citations` above it looked survivable (audit §487).
  const root = repoRoot(process.cwd());
  const config = loadRatchetConfig(root);
  const live = countUnanchored(citations, config.targets, (cited, citing) => resolveCandidates(cited, citing, index.paths));
  if (process.argv.includes("--write-ratchet")) {
    writeRatchetBaseline(live, root);
    const total = Object.values(live).reduce((sum, per) => sum + Object.values(per).reduce((a, b) => a + b, 0), 0);
    console.log(`citation-ratchet: baseline rewritten — ${total} unanchored citation(s) into ${config.targets.length} ratcheted target(s). Commit ${RATCHET_CONFIG_PATH}.`);
    return;
  }
  const drift = checkRatchet(live, config);
  if (drift.length > 0) {
    for (const d of drift) console.error(`FAIL citation-ratchet ${formatRatchetViolation(d)}`);
    process.exit(1);
  }
  const total = Object.values(live).reduce((sum, per) => sum + Object.values(per).reduce((a, b) => a + b, 0), 0);
  console.log(`citation-ratchet OK — ${total} unanchored citation(s) into ${config.targets.length} high-churn target(s), exactly the frozen baseline (it may fall, never grow)`);
}

if (process.argv[1]?.endsWith("citation-links.ts")) main();
