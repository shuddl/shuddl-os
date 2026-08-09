import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-105/118 §752/§753 — WHEN A GUARD CANNOT BE PINNED, PIN THE CONDITION THAT KEEPS IT UNNECESSARY.
//
// Three Durable Objects serialize a read-modify-write behind a `this.lock` chain. Two of them meter MONEY or
// entitlement: `CapsMeter` (MCP spend/velocity caps on `book_shipment`, an external OAuth-paired surface) and
// `SparkMeter` (the Spark allotment). The third is `ShipmentSequencer`.
//
// MEASURED, all three:
//
//   | DO                | delete its mutex → its own suite      | awaits in the locked method |
//   |-------------------|---------------------------------------|-----------------------------|
//   | ShipmentSequencer | RED (§750: the 100-concurrent test)   | D1 subrequests — NON-storage |
//   | CapsMeter         | GREEN 17/17 — SILENT                  | 3 of 3 `ctx.storage.*`       |
//   | SparkMeter        | GREEN 122/122 — SILENT                | 3 of 3 `ctx.storage.*`       |
//
// The pattern is one fact seen twice. A Cloudflare DO input gate closes across the DO's OWN storage
// operations and NOT across a plain subrequest. So the sequencer's mutex is load-bearing (it awaits D1) and
// therefore testable — §750 re-ran its documented falsification and it still reds. The two meters await only
// storage, so they are ALREADY serialized, their mutexes are redundant today, and no test can hold them:
// there is nothing to observe until someone adds a non-storage await.
//
// §319's rule — an unenforced trigger is a hope — would end there. It does not have to, because "a future
// non-storage await" is a property of the SOURCE. So this gate pins the PRECONDITION rather than the guard:
// while every await in a meter's locked method is `ctx.storage.*`, its mutex is redundant and its silence is
// explained; the day one is not, the mutex becomes the only thing standing between two concurrent
// `book_shipment` calls and a cap bypass — both read the same tally, both pass, both commit.
//
// A guard nobody can test and a precondition anybody can check are the same guarantee from two sides.
//
// THE ROSTER IS DERIVED (§699: membership is a property of the code) — every file declaring a DurableObject
// subclass, found at run time, so a fourth one is covered on the day it lands rather than the day someone
// remembers this file.

interface Guarded {
  readonly file: string;
  readonly method: string;
  readonly src: string;
}

/**
 * Files declaring a DO subclass whose read-modify-write is chained on `this.lock`, with the method it wraps.
 * A DO with no lock is not in scope here — it has no guard to reason about.
 */
function lockedDurableObjects(root: string): Guarded[] {
  const files = execSync('git grep -l "extends DurableObject" -- workers packages', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.includes(".test.") && !f.includes("/test/"));
  const out: Guarded[] = [];
  for (const file of files) {
    const src = readFileSync(`${root}/${file}`, "utf8");
    const m = /this\.lock\.then\(\(\) => this\.(#?\w+)\(/.exec(src);
    if (m !== null) out.push({ file, method: m[1]!, src });
  }
  return out;
}

/**
 * The brace-matched body of a method, so an await in a sibling method cannot leak into the scan.
 *
 * ANCHORED ON THE DECLARATION, not on any occurrence of the name. `#append` appears first as a CALL inside
 * `this.lock.then(() => this.#append(req))`, and a name-anywhere match walked forward from there to the next
 * `{` and returned a garbage body with zero awaits. Caught by this file's own non-vacuity floor, which is the
 * argument for having one on a scan you wrote yourself. A declaration begins its line (after indentation and
 * an optional `async`/`private`), which a call never does.
 */
function methodBody(src: string, name: string): string | null {
  const head = new RegExp(`^[ \\t]*(?:private\\s+)?(?:async\\s+)?${name}\\s*\\([^)]*\\)[^{]*\\{`, "m").exec(src);
  if (head === null) return null;
  let depth = 1;
  let i = head.index + head[0].length;
  const from = i;
  while (depth > 0 && i < src.length) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") depth -= 1;
    i += 1;
  }
  return depth === 0 ? src.slice(from, i - 1) : null;
}

/** `await` expressions in a body, comment lines excluded (headers discuss awaits in prose). */
function awaitLines(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("//") && !l.startsWith("*") && /\bawait\b/.test(l));
}

/**
 * The ONE DO exempt from the storage-only rule, with its reason. Its mutex is proven load-bearing by a named
 * test, so its non-storage awaits are not an exposure — they are precisely why it is testable at all.
 * Exempting it is not a weakening: an exemption whose subject is DEFENDED is the opposite of a hole.
 */
const PINNED_BY_TEST: Readonly<Record<string, string>> = {
  "workers/api/src/do/sequencer.ts":
    "its mutex IS pinned — delete it and `workers/api test/sequencer.test.ts` reds " +
    '"assigns dense, gapless seqs under 100 concurrent appends via fresh stubs", with ' +
    "`D1_ERROR: I3: append-only` (§750 re-ran this; the D1 awaits are the reason it is load-bearing)",
};

describe("REQ-105/118 §753: a DO whose mutex is unpinned awaits only its own storage", () => {
  const root = repoRoot();
  const guarded = lockedDurableObjects(root);

  it("finds the lock-guarded Durable Objects (non-vacuity — an empty roster must not read as clean)", () => {
    // Two ways to go silent: the grep stops finding DO subclasses, or the lock pattern stops matching. Either
    // makes every assertion below iterate nothing and pass — the shape this repo has met in a dozen gates.
    expect(guarded.length, "no lock-guarded DurableObject found — the scan broke, not the tree").toBeGreaterThanOrEqual(3);
  });

  it.each(lockedDurableObjects(repoRoot()))("$file: its locked method parses and has awaits to judge", ({ file, method, src }) => {
    const body = methodBody(src, method);
    expect(body, `${method} did not parse in ${file} — a broken scan, not a clean result`).not.toBeNull();
    expect(awaitLines(body ?? "").length, `no awaits found in ${file}'s ${method} — the scan broke`).toBeGreaterThanOrEqual(1);
  });

  it.each(lockedDurableObjects(repoRoot()))("$file: keeps its mutex", ({ file, src }) => {
    // §721's pattern — a gate that says what would make it obsolete. If a mutex is removed, the storage-only
    // rule below is the ONLY thing between a future await and a lost read-modify-write.
    expect(
      /this\.lock\s*=\s*run\.catch/.test(src),
      `${file}'s mutex is gone. For the meters it was redundant while every await is a storage call, but it ` +
        "is what makes a future non-storage await survivable rather than a cap bypass. Restore it, or delete " +
        "this gate and record why that DO no longer needs serialization",
    ).toBe(true);
  });

  it.each(lockedDurableObjects(repoRoot()).filter((g) => PINNED_BY_TEST[g.file] === undefined))(
    "$file: every await in its locked method is `this.ctx.storage.*`",
    ({ file, method, src }) => {
      const offenders = awaitLines(methodBody(src, method) ?? "").filter((l) => !/await\s+this\.ctx\.storage\./.test(l));
      expect(
        offenders,
        `a NON-storage await entered ${file}'s ${method}. The DO input gate closes only across the DO's OWN ` +
          "storage operations, so this await reopens it mid read-modify-write: two concurrent calls read the " +
          "same tally, both pass, both commit, and the actor books past its cap.\n\n" +
          "That DO's mutex exists for exactly this and becomes LOAD-BEARING now — but it is NOT pinned by any " +
          "test (measured: deleting it leaves its suite green), so nothing else will tell you. Keep the await " +
          "out, or make the mutex's protection observable — a test that FAILS without it — and add the file to " +
          `PINNED_BY_TEST with that test's name:\n  ${offenders.join("\n  ")}`,
      ).toEqual([]);
    },
  );

  it("every PINNED_BY_TEST entry still names a real, lock-guarded DO (the exemption cannot outlive its subject)", () => {
    // An exemption for a file that no longer exists, or no longer has a lock, is a silent hole: the storage-only
    // rule would skip a DO that nobody is checking. Same discipline as §672's chokepoint staleness guard.
    const known = new Set(guarded.map((g) => g.file));
    const stale = Object.keys(PINNED_BY_TEST).filter((f) => !known.has(f));
    expect(
      stale,
      "a PINNED_BY_TEST exemption names a file that is not a lock-guarded DurableObject any more. Its reason " +
        `cannot still hold — re-verify the named test and either fix the path or drop the entry:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });
});
