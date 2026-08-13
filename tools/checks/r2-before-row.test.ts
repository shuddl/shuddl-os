import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1274 (REQ-016/017/198) — THE BYTES MOVE FIRST, THE ROW MOVES LAST.
//
// Two places pair an R2 operation with a `documents` row write, and both state the same rule in a comment:
//
//   evidence.ts   "R2 FIRST, documents row LAST … the row exists iff the bytes are stored"
//   retention.ts  "DELETE bytes FIRST (idempotent), THEN tombstone — the crash-safe, self-healing ordering"
//
// The ordering is not stylistic, because THE RECOVERY IS ASYMMETRIC. In the documented order a crash between
// the two leaves bytes with no row, and the next upload heals it (`INSERT OR IGNORE`, byte-identical re-put of
// a verified hash). REVERSED, a crash leaves a row pointing at an r2_key that holds nothing — and nothing
// heals that: the upload route's `retention_status === 'active'` branch returns the stored key WITHOUT
// re-checking the bytes, so the lie is permanent. A POD evidence email (acceptance demo #1) would cite
// evidence that does not exist.
//
// WHY A STATIC GATE, not a test. Observing the order requires dying BETWEEN two awaits. Measured at §1274:
// swapping evidence.ts's two writes left `evidence-upload.test.ts` at 19/19 GREEN — including its own
// "TORN-STATE HEALING" and "ROW-IFF-BYTES" cases, because a pre-seeded torn state does not depend on the
// source order that produced it. The shape of the code IS the evidence (§1248's precedent, the same argument
// for IndexedDB durability). Deleting the R2 write entirely REDs 3 — presence is well covered; only ORDER is
// invisible.

interface Site {
  readonly file: string;
  readonly r2: RegExp; // the R2 operation
  readonly row: RegExp; // the documents-row write that must follow it
}

const SITES: readonly Site[] = [
  { file: "workers/api/src/routes/evidence.ts", r2: /\.EVIDENCE\.put\(/, row: /INSERT OR IGNORE INTO documents/ },
  { file: "packages/ledger/src/documents/retention.ts", r2: /r2\.delete\(/, row: /db\.prepare\(TOMBSTONE_SQL\)/ },
  { file: "packages/ledger/src/anchor.ts", r2: /r2\.put\(receiptKey/, row: /INSERT OR IGNORE INTO documents/ },
];

/** Every R2 mutation in shipped source — the completeness floor for SITES. */
function r2WriteSites(root: string): string[] {
  const out = execSync(
    `git grep -nE '(r2|R2|EVIDENCE|bucket)\\.(put|delete)\\(' -- packages workers || true`,
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .filter((l) => l !== "" && !l.includes(".test.") && !/^\S+:\d+:\s*(\/\/|\*)/.test(l));
  return out;
}

describe("§1274 REQ-016/017: R2 moves before the documents row", () => {
  const root = repoRoot();

  it("every declared site still has both halves (non-vacuity — a rename would make the order check vacuous)", () => {
    for (const s of SITES) {
      const text = readFileSync(`${root}/${s.file}`, "utf8");
      expect(s.r2.test(text), `${s.file}: the R2 operation ${String(s.r2)} is gone — this gate is stale`).toBe(true);
      expect(s.row.test(text), `${s.file}: the row write ${String(s.row)} is gone — this gate is stale`).toBe(true);
    }
  });

  it("the R2 operation precedes the row write, in every declared site", () => {
    const wrong: string[] = [];
    for (const s of SITES) {
      const lines = readFileSync(`${root}/${s.file}`, "utf8").split("\n");
      const iR2 = lines.findIndex((l) => s.r2.test(l) && !l.trim().startsWith("//"));
      const iRow = lines.findIndex((l) => s.row.test(l) && !l.trim().startsWith("//"));
      if (iR2 >= 0 && iRow >= 0 && iR2 > iRow) wrong.push(`${s.file}: row write at :${iRow + 1} precedes the R2 op at :${iR2 + 1}`);
    }
    expect(
      wrong,
      "a documents row is written BEFORE its bytes. A crash between the two then leaves a row citing an " +
        "r2_key that holds nothing, and nothing heals it — the upload route returns a stored key without " +
        "re-checking the bytes. Put the R2 operation first:\n  " +
        wrong.join("\n  "),
    ).toEqual([]);
  });

  it("no UNDECLARED R2 write site has appeared (a new one needs this ordering decided, not defaulted)", () => {
    const found = r2WriteSites(root);
    expect(found.length, "no R2 write sites found — the matcher is stale, not the tree").toBeGreaterThanOrEqual(3);
    const declared = SITES.map((s) => s.file);
    const undeclared = found.filter((l) => !declared.some((d) => l.startsWith(`${d}:`)));
    // EXEMPT, each with its reason — an R2 write pairs with nothing, so there is no order to get wrong:
    //   sweep-214.ts       — a transmitted-EDI artifact; no documents row.
    //   watchtower-snapshot — an operator snapshot blob; no documents row, and nothing reads it by key from D1.
    const EXEMPT = ["workers/translator/src/sweep-214.ts:", "packages/ledger/src/watchtower-snapshot.ts:"];
    const known = undeclared.filter((l) => !EXEMPT.some((e) => l.startsWith(e)));
    expect(
      known,
      "a new R2 write appeared. If it pairs with a row write, add it to SITES so its ordering is enforced; " +
        "if it does not, add it to the exemption above WITH the reason:\n  " +
        known.join("\n  "),
    ).toEqual([]);

    // §1359 (§672) — NO EXEMPTION OUTLIVES ITS SUBJECT.
    //
    // The two entries above are excused because their R2 write pairs with no `documents` row. If either file
    // stops writing to R2 at all — deleted, rewritten, its transport swapped — the exemption becomes a
    // standing excuse for a site that no longer exists, and nothing here would ever say so. An exemption's
    // failure mode is SILENCE, which is precisely the class §1357 says to re-test. Swept at §1359: sixteen
    // gates carry an exemption list, eight assert this, and this one did not.
    const orphanedExemptions = EXEMPT.filter((e) => !found.some((l) => l.startsWith(e)));
    expect(
      orphanedExemptions,
      "an EXEMPT entry no longer names a file that writes to R2. Its subject is gone, so the exemption is now " +
        "a standing excuse — delete it, or point it at whatever replaced that write:\n  " +
        orphanedExemptions.join("\n  "),
    ).toEqual([]);
  });
});
