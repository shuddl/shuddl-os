import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-105 §752 — WHEN A GUARD CANNOT BE PINNED, PIN THE CONDITION THAT KEEPS IT UNNECESSARY.
//
// `CapsMeter.#checkAndReserve` is a read-modify-write over the MCP spend/velocity caps — the money-moving
// `book_shipment` mutation. It is wrapped in a mutex, and that mutex's own comment is unusually honest:
//
//   "why deleting this line is SILENT in CI, yet a cap bypass after any future non-storage await lands in
//    `#checkAndReserve` … Do not 'simplify' it away."
//
// MEASURED, both halves:
//   · deleting the mutex leaves `workers/mcp test/hostile-prompt.test.ts` at 17/17 GREEN — including its
//     "velocity cap 3, SIX concurrent books → EXACTLY 3 ACCEPTED" race. The claim of silence is TRUE.
//   · every await in that method today is `this.ctx.storage.*` (3 of 3), which is precisely why: the DO input
//     gate DOES close across the DO's own storage operations, so the method is already serialized and the
//     mutex is redundant — today.
//
// So the mutex is defensive against a change nobody has made yet, and no test can hold it, because there is
// nothing to observe until that change lands. §319's rule — an unenforced trigger is a hope — would normally
// end there.
//
// IT DOES NOT HAVE TO. The trigger is mechanical: the guard becomes load-bearing the moment a NON-storage
// await appears in that method. That is checkable from source, so the hope becomes a gate. This does not pin
// the mutex; it pins the reason the mutex is currently unpinnable, and it fires on exactly the edit the
// comment warns about — a `fetch`, a D1 subrequest, a KV read, an RPC hop dropped into the reserve path.
//
// The failure is a CAP BYPASS: two concurrent `book_shipment` calls read the same tally, both pass, both
// write, and the pairing books past its spend or velocity cap. That is money, over an EXTERNAL surface
// (OAuth-paired MCP clients), which is why this is worth a static gate rather than a comment.

const SRC = "workers/mcp/src/caps-meter.ts";
const METHOD = "#checkAndReserve";

/** The brace-matched body of a method, so an `await` in a sibling method cannot leak into the scan. */
function methodBody(src: string, name: string): string | null {
  const head = new RegExp(`${name}\\s*\\([^)]*\\)[^{]*\\{`).exec(src);
  if (head === null) return null;
  let depth = 1;
  let i = head.index + head[0].length;
  const from = i;
  while (depth > 0 && i < src.length) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  return depth === 0 ? src.slice(from, i - 1) : null;
}

/** `await` expressions in a body, comment lines excluded (the header discusses awaits in prose). */
function awaitLines(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("//") && !l.startsWith("*") && /\bawait\b/.test(l));
}

describe("REQ-105 §752: every await in the caps reserve path is a DO-storage call", () => {
  const src = readFileSync(`${repoRoot()}/${SRC}`, "utf8");

  it("finds the method at all (non-vacuity — a rename must not read as clean)", () => {
    // Without this, renaming or restructuring the method makes `awaitLines` scan an empty string and every
    // assertion below pass over nothing — the shape this repo has met in a dozen gates (§487…§607).
    expect(methodBody(src, METHOD), `${METHOD} did not parse in ${SRC} — a broken scan, not a clean result`).not.toBeNull();
  });

  it("finds the awaits it is supposed to be judging (a second floor on the same scan)", () => {
    // The method could parse to a body while the await filter silently matches nothing.
    expect(awaitLines(methodBody(src, METHOD) ?? "").length, "no awaits found in the reserve path — the scan broke").toBeGreaterThanOrEqual(3);
  });

  it("no await in the reserve path is anything but `this.ctx.storage.*`", () => {
    const offenders = awaitLines(methodBody(src, METHOD) ?? "").filter((l) => !/await\s+this\.ctx\.storage\./.test(l));
    expect(
      offenders,
      "a NON-storage await entered the caps reserve path. The Cloudflare DO input gate closes only across the " +
        "DO's OWN storage operations, so this await reopens it mid read-modify-write: two concurrent " +
        "`book_shipment` calls read the same tally, both pass, both commit, and the pairing books past its " +
        "spend/velocity cap — money, over an external OAuth-paired surface.\n\n" +
        "The mutex in `CapsMeter` exists for exactly this and becomes LOAD-BEARING now — but it is not pinned " +
        "by any test (measured: deleting it leaves hostile-prompt.test.ts at 17/17), so nothing else will tell " +
        "you. Keep the await out of this method, or make the mutex's protection observable and say so here:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("the mutex is still present (the assumption this gate rests on)", () => {
    // This file argues the mutex is redundant TODAY and load-bearing after a non-storage await. If the mutex
    // were removed, the third assertion above would be the only thing standing between a future await and a
    // cap bypass — a much weaker position than the comment describes. Make its removal loud (§721's pattern).
    expect(
      /this\.lock\s*=\s*run\.catch/.test(src),
      "the CapsMeter mutex is gone. It was redundant while every await here is a storage call, but it is the " +
        "thing that makes a future non-storage await survivable rather than a cap bypass. Restore it, or " +
        "delete this gate and record why the reserve path no longer needs serialization",
    ).toBe(true);
  });
});
