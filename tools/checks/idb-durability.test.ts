import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1248 (REQ-016/017) — EVERY READWRITE IDB TRANSACTION RESOLVES ON `oncomplete`, NEVER ON A REQUEST.
//
// `packages/driver-core/src/queue.ts` states the rule as a DURABILITY CONTRACT on the `QueueStore` port:
//
//   "`put`/`remove` MUST resolve only AFTER the write is durable (e.g. the IDB transaction has committed) …
//    a tab-kill between `enqueue()` and the IDB write would lose a signed airplane-mode POD (CLAUDE.md rule 6)."
//
// `apps/driver/src/storage/idb-queue-store.ts` honours it — both writes resolve on `tx.oncomplete`. **And
// nothing pinned that.** Measured at §1248: the only mention of the rule outside the two source comments is a
// COMMENT in `storage.test.ts` (`// resolves on tx.oncomplete`), which is prose, not an assertion.
//
// WHY A STATIC GATE RATHER THAN A TEST. This is a property a functional test structurally cannot see. In
// IndexedDB a request's `onsuccess` fires BEFORE the transaction commits, so a store that resolved on the
// request still writes the row and still passes every read-back assertion — under fake-indexeddb too. The
// difference is only observable by killing the process between the two moments, which no unit test does. The
// failure is silent and total: the queue reports the capture as saved, the tab dies, and a signed POD is gone.
// So the shape of the code IS the evidence, and a lint is the honest instrument (§"audit a law by the shape of
// its gate" — an ungated law with no observable failure needs a static check, not a fixture).

const RW = /\.transaction\(\s*[^)]*,\s*["']readwrite["']\s*\)/;
const ANY_TX = /\.transaction\(/;

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly why: string;
}

/** Read-write transaction blocks that do not settle on the transaction's own completion. */
export function offendingBlocks(files: readonly { path: string; text: string }[]): Finding[] {
  const out: Finding[] = [];
  for (const { path, text } of files) {
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
      if (!RW.test(line)) return;
      // The block runs to the next transaction of ANY kind — not the next READWRITE one. Measured at §1248:
      // bounding on readwrite made `put`'s block swallow the read-only `all()` method that sits between it and
      // `remove()`, and `all()` legitimately settles from `req.onsuccess` (a read has nothing to make durable).
      // The gate reported its own first run as a violation. Same class as §1211's brace matcher: the block
      // boundary decides what the rule can see.
      const next = lines.findIndex((l, j) => j > i && ANY_TX.test(l));
      const block = lines.slice(i, next === -1 ? Math.min(i + 30, lines.length) : next).join("\n");
      if (!/\btx\w*\.oncomplete\s*=/.test(block)) {
        out.push({ file: path, line: i + 1, why: "no `oncomplete` handler — resolves before the write is durable" });
        return;
      }
      // Settling from a REQUEST inside a readwrite block is the subtle form: the row lands, the promise
      // resolves early, and a tab-kill in between loses it.
      if (/\breq\w*\.onsuccess\s*=\s*\(\s*\)\s*=>\s*resolve\b/.test(block)) {
        out.push({ file: path, line: i + 1, why: "resolves on a request's `onsuccess` — fires BEFORE the transaction commits" });
      }
    });
  }
  return out;
}

function storageFiles(root: string): { path: string; text: string }[] {
  // §1506 — THE PATH WAS THE SCOPE. `apps/driver/src/storage/*.ts` is where the durable queue lives TODAY, and
  // the rule is about IndexedDB transactions wherever they are opened. MEASURED at §1506: a readwrite
  // transaction with no `oncomplete`, planted in `apps/driver/src/sync/useSync.ts` (which already touches
  // `indexedDB`), left this suite 4/4 green — while the identical plant inside `storage/` reds. §1419's defect:
  // the tree supplied the population and a PATH decided membership. Now the whole driver surface, both
  // extensions (§1505 — a component can open a transaction as easily as a module can).
  return execSync('git ls-files "apps/driver/src/*.ts" "apps/driver/src/**/*.ts" "apps/driver/src/*.tsx" "apps/driver/src/**/*.tsx"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f !== "" && !f.includes(".test."))
    .map((f) => ({ path: f, text: readFileSync(`${root}/${f}`, "utf8") }));
}

describe("§1248 REQ-016/017: the driver's durable writes settle on transaction commit", () => {
  const root = repoRoot();
  const files = storageFiles(root);

  it("finds the storage layer and at least one readwrite transaction (non-vacuity)", () => {
    // A moved directory or a renamed store would yield an empty corpus, and "no offenders" over nothing is
    // the false clean this repo has spent scores of phases on — floor the INPUT, not the finding.
    expect(files.length, "no driver storage sources found — the glob is broken, not the tree").toBeGreaterThanOrEqual(2);
    const rw = files.filter((f) => RW.test(f.text));
    expect(rw.length, "no readwrite transactions found — this gate has no subject; check the corpus, not the tree").toBeGreaterThanOrEqual(1);
  });

  it("no readwrite transaction resolves before its commit", () => {
    const bad = offendingBlocks(files).map((f) => `${f.file}:${f.line} — ${f.why}`);
    expect(
      bad,
      "durable-write violation(s). A queue write that resolves before the IDB transaction commits reports a " +
        "capture as saved and loses it on a tab-kill — signed airplane-mode evidence, gone with no error " +
        "(CLAUDE.md rule 6):\n  " +
        bad.join("\n  ") +
        "\n\nResolve the promise from `tx.oncomplete`, and reject from `tx.onerror` / `tx.onabort`.",
    ).toEqual([]);
  });

  it("the detector fires on BOTH bad shapes (positive control — a dead matcher would pass everything)", () => {
    const missing = [{ path: "synthetic.ts", text: 'const tx = db.transaction(S, "readwrite");\ntx.objectStore(S).put(x);\nresolve();' }];
    expect(offendingBlocks(missing), "the no-oncomplete shape is not detected").toHaveLength(1);
    const early = [
      {
        path: "synthetic.ts",
        text: 'const tx = db.transaction(S, "readwrite");\nconst req = tx.objectStore(S).put(x);\nreq.onsuccess = () => resolve();\ntx.oncomplete = () => undefined;',
      },
    ];
    expect(offendingBlocks(early), "the resolve-on-request shape is not detected").toHaveLength(1);
  });

  it("does NOT fire on the correct shape, nor on read-only transactions (false positives kill a gate)", () => {
    const good = [
      {
        path: "synthetic.ts",
        text: 'const tx = db.transaction(S, "readwrite");\ntx.objectStore(S).put(x);\ntx.oncomplete = () => resolve();\ntx.onerror = () => reject();',
      },
      // A read-only transaction legitimately settles from the request — there is nothing to make durable.
      { path: "synthetic2.ts", text: 'const tx = db.transaction(S, "readonly");\nconst req = tx.objectStore(S).getAll();\nreq.onsuccess = () => resolve(req.result);' },
    ];
    expect(offendingBlocks(good), "a false positive here is how this gate gets deleted").toEqual([]);
  });
});
