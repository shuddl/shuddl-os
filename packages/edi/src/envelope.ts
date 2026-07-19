// X12 envelope tokenizer (REQ-204). PURE: no I/O, no ledger/rater import. A single linear pass — it never
// backtracks (String.split with a literal separator is O(n)) and is bounded against a hostile/huge/looping
// document by an explicit input-size ceiling. The delimiters are READ FROM the ISA (never hardcoded):
//   - element separator  = the char at index 3 (right after the "ISA" tag)
//   - sub-element sep     = ISA16 = the char right after the 16th element separator
//   - segment terminator  = the char right after ISA16
// so a partner that ships `|`-delimited or `\n`-terminated interchanges parses correctly.

export class EdiParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdiParseError";
  }
}

export interface EdiSegment {
  tag: string;
  elements: string[];
}

export interface EdiDelims {
  element: string;
  segment: string;
  sub: string;
}

export interface Tokenized {
  segments: EdiSegment[];
  isaControl: string;
  gsControl: string;
  delims: EdiDelims;
}

// A valid ISA header (16 elements + terminator) is exactly 106 bytes with single-char delimiters.
const ISA_MIN_LEN = 106;
// Hard ceiling so a hostile multi-megabyte / looping document can never make this hang.
const MAX_INPUT = 5_000_000;
// The 16th element separator ends ISA16; on a well-formed ISA it lands within the first ~106 chars.
const ISA_SCAN_LIMIT = 200;

export function tokenize(raw: string): Tokenized {
  if (raw.length > MAX_INPUT) throw new EdiParseError("interchange exceeds maximum size");
  if (!raw.startsWith("ISA")) throw new EdiParseError("interchange does not start with ISA");
  if (raw.length < ISA_MIN_LEN) throw new EdiParseError("ISA shorter than a valid header");

  const element = raw[3];
  if (element === undefined) throw new EdiParseError("ISA shorter than a valid header");

  // Locate the 16th element separator; ISA16 and the segment terminator follow it.
  let sepCount = 0;
  let idx16 = -1;
  const scanEnd = Math.min(raw.length, ISA_SCAN_LIMIT);
  for (let i = 3; i < scanEnd; i++) {
    if (raw[i] === element) {
      sepCount++;
      if (sepCount === 16) {
        idx16 = i;
        break;
      }
    }
  }
  if (idx16 === -1) throw new EdiParseError("ISA is malformed (16 element separators not found)");

  const sub = raw[idx16 + 1];
  const segment = raw[idx16 + 2];
  if (sub === undefined || segment === undefined) {
    throw new EdiParseError("ISA shorter than a valid header");
  }

  // Split into segments (linear), trim per-segment whitespace/newlines, drop empties.
  const segments: EdiSegment[] = [];
  for (const rawSeg of raw.split(segment)) {
    const trimmed = rawSeg.trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split(element);
    const tag = parts[0] ?? "";
    segments.push({ tag, elements: parts.slice(1) });
  }

  // Validate transaction-set balance and the interchange trailer in one pass.
  let hasIea = false;
  let stBalance = 0;
  for (const seg of segments) {
    if (seg.tag === "ST") {
      stBalance++;
    } else if (seg.tag === "SE") {
      stBalance--;
      if (stBalance < 0) throw new EdiParseError("SE without a matching ST");
    } else if (seg.tag === "IEA") {
      hasIea = true;
    }
  }
  if (!hasIea) throw new EdiParseError("missing IEA trailer");
  if (stBalance !== 0) throw new EdiParseError("ST without a matching SE");

  const isa = segments.find((s) => s.tag === "ISA");
  const gs = segments.find((s) => s.tag === "GS");
  const isaControl = isa?.elements[12]?.trim() ?? "";
  const gsControl = gs?.elements[5]?.trim() ?? "";

  return { segments, isaControl, gsControl, delims: { element, segment, sub } };
}
