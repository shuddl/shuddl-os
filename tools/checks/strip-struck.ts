// §1411 (REQ-118) — THE ONE STRIKETHROUGH MASK. Paragraph-bounded, length-preserving, shared by every gate
// that reads a record.
//
// THE DEFECT THIS CLOSES, measured before the fix. Five gates each carried their own copy of
// `/~~[\s\S]*?~~/g`, and `[\s\S]` crosses anything. This repo's records also *talk about* the convention
// — "the repo marks superseded text by ~~striking~~ it", "nine gates touch `~~`" — so an UNPAIRED `~~`
// appears in ordinary prose: 37 such lines in the audit, 18 in the checklist, 55 in all. A global
// non-greedy pair does not care which markers were meant to go together; it takes them two at a time in
// file order, so ONE unpaired marker re-pairs every marker after it and a span meant to end four words
// later instead runs to the next `~~` thousands of lines away.
//
// The audit is 5.9 MB. The global pair masked **3,905,463 characters of it — 66% of the document**. The
// citation gates were therefore reading **123 of the 308 tracked `path:line` citations** in the two
// records: 191 of them, 62%, were invisible to every citation gate in the repo, including
// `check:citations`, which is a MERGE gate. Two of the hidden citations were dead and had been reported
// clean for as long as they had been hidden.
//
// HOW IT SURFACED, which is the part worth keeping: not by inspection. §1411 appended one row to the
// audit's index table containing five `~~` markers. That flipped the running parity above §431 from odd
// to even, one previously-masked citation became live text, and the gate failed on it instantly. **The
// gate's verdict depended on how many times the document happened to mention its own notation.** A gate
// whose scope moves when unrelated prose is edited is not a gate; it is a coin flip with a green light.
//
// THE BOUNDARY IS A BLANK LINE, AND THE FIRST FIX GOT THIS WRONG. This function was line-wise for one
// commit, on the stated ground that "GFM strikethrough cannot span a line break". That is false —
// inline emphasis crosses SOFT breaks and stops at a paragraph break — and both formats here rely on it:
// GO-LIVE-CHECKLIST.md:344-346 strikes a wrapped sentence, and workers/agents/wrangler.toml:108-110
// strikes a correction wrapped across three `#` comment lines. Line-wise under-masked both, and
// `wrangler-absence-claims` went red reading a corrected §944 claim as a live one. The mechanism I wrote
// down was wrong even though the direction was right; the gate said so within a minute.
//
// Paragraph-bounding is what actually holds: 334 tracked citations visible either way (against the global
// pair's 123), the multi-line strikes both records use are masked, and an unpaired marker can now damage
// at most its own paragraph instead of the rest of the file.
//
// BOTH FAILURE DIRECTIONS (§1378's discipline, and they are not symmetric):
//   · UNDER-mask — a real strike stays visible, so a gate reads a superseded claim and complains about
//     it. LOUD: someone looks, and the record is right there saying it was corrected. Cheap, and it is
//     how the line-wise version was caught in one run.
//   · OVER-mask — live text is hidden, so every claim inside it is certified without being read. SILENT,
//     and it is the direction the old regex failed in, at 62%. The residual bias is toward under-masking:
//     `[^~]` stops at the first stray tilde, and a paragraph break stops everything.

/** Blank out one paragraph's `~~superseded~~` spans, preserving every character position and newline. */
const maskParagraph = (block: string): string =>
  block.replace(/~~[^~]*~~/g, (m) => m.replace(/[^\n]/g, " "));

/**
 * Mask `~~superseded~~` spans. A span may cross a soft line break but never a blank line, so a stray
 * marker cannot reach past its own paragraph. Offsets, line numbers and line count are all preserved.
 */
export function stripStruck(text: string): string {
  const lines = text.split("\n");
  const out = [...lines];
  for (let i = 0; i < lines.length; ) {
    if ((lines[i] as string).trim() === "") {
      i += 1;
      continue;
    }
    let j = i;
    while (j < lines.length && (lines[j] as string).trim() !== "") j += 1;
    out.splice(i, j - i, ...maskParagraph(lines.slice(i, j).join("\n")).split("\n"));
    i = j;
  }
  return out.join("\n");
}
