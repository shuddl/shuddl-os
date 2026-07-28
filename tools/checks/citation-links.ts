import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
// WHAT IT CANNOT SEE — read this before trusting it: a citation whose line EXISTS but names the wrong
// code is invisible here. Only a content anchor could catch that. This gate catches a dangling path
// and an out-of-bounds line; it does not certify that a line still says what the citing text claims.
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
    // not followed by more word/digit chars (so `foo.ts:12abc` is not a citation)
    String.raw`(?![\w])`,
  "g",
);

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
}

export interface CitationViolation {
  citingFile: string;
  citingLine: number;
  citedPath: string;
  citedSpec: string;
  reason: string;
}

/** The resolution universe. `lineCount` returns null for a path that cannot be read. */
export interface RepoIndex {
  paths: readonly string[];
  lineCount(path: string): number | null;
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
    out.push({ citingFile, citingLine, path, spec, ranges: parseSpec(spec) });
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
 *   2. the path read as a sibling of the citing file (how `threat-model.md:8` and `anchor.ts:309` read);
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

/** Every violation among the given citations. Pure over `index`: no disk access, fully testable. */
export function checkCitations(citations: readonly Citation[], index: RepoIndex): CitationViolation[] {
  const violations: CitationViolation[] = [];
  for (const c of citations) {
    const base = { citingFile: c.citingFile, citingLine: c.citingLine, citedPath: c.path, citedSpec: c.spec };
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
    const counted = candidates.map((p) => ({ path: p, lines: index.lineCount(p) })).filter((x): x is { path: string; lines: number } => x.lines !== null);
    // Unreadable everywhere (binary / vendored bytes): unverifiable, and an unverifiable citation is
    // not evidence of a defect. Stay silent rather than cry wolf.
    if (counted.length === 0) continue;
    if (counted.some((x) => highest <= x.lines)) continue;
    const reason =
      counted.length === 1 && counted[0] !== undefined
        ? `${counted[0].path} has ${counted[0].lines} lines — line ${highest} does not exist`
        : `no candidate file reaches line ${highest} (${counted.length} candidates: ${counted.map((x) => `${x.path}=${x.lines}`).join(", ")})`;
    violations.push({ ...base, reason });
  }
  return violations;
}

/** `citing-file:line → cited-path:line — reason`, so a reader can jump straight to the citation. */
export function formatViolation(v: CitationViolation): string {
  return `${v.citingFile}:${v.citingLine} → ${v.citedPath}:${v.citedSpec} — ${v.reason}`;
}

function trackedFiles(cwd: string): string[] {
  return execSync("git ls-files", { cwd, encoding: "utf8" }).split("\n").filter(Boolean);
}

function countLines(content: string): number {
  const n = content.split("\n").length;
  return content.endsWith("\n") ? n - 1 : n;
}

/** The real repo as a RepoIndex: tracked paths, line counts read (and cached) on demand. */
export function buildRepoIndex(cwd: string = process.cwd()): RepoIndex {
  const paths = trackedFiles(cwd);
  const cache = new Map<string, number | null>();
  return {
    paths,
    lineCount(path: string): number | null {
      const hit = cache.get(path);
      if (hit !== undefined) return hit;
      let value: number | null = null;
      try {
        value = countLines(readFileSync(join(cwd, path), "utf8"));
      } catch {
        value = null;
      }
      cache.set(path, value);
      return value;
    },
  };
}

/** Every citation in every tracked markdown file and TypeScript comment. */
export function collectCitations(cwd: string = process.cwd()): Citation[] {
  const out: Citation[] = [];
  for (const file of trackedFiles(cwd)) {
    if (!/\.(md|ts|tsx|mts|cts)$/.test(file)) continue;
    let content: string;
    try {
      content = readFileSync(join(cwd, file), "utf8");
    } catch {
      continue;
    }
    out.push(...extractCitations(file, content));
  }
  return out;
}

function main(): void {
  const citations = collectCitations();
  const violations = checkCitations(citations, buildRepoIndex());
  if (violations.length > 0) {
    for (const v of violations) console.error(`FAIL citation-links ${formatViolation(v)}`);
    console.error(`\n${violations.length} rotted citation(s) of ${citations.length} checked.`);
    process.exit(1);
  }
  console.log(`citation-links OK — ${citations.length} path:line citations resolve to a real file and an in-bounds line`);
}

if (process.argv[1]?.endsWith("citation-links.ts")) main();
