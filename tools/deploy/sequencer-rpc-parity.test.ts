import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "../checks/repo-root.js";

// §1302 (REQ-030/025) — SIX HAND-WRITTEN COPIES OF ONE RPC CONTRACT.
//
// `ShipmentSequencer.append` is the single chokepoint every event enters the ledger through, and its request
// shape is declared ONCE as `type AppendReq` in the DO. But no caller can use that type: the sequencer's own
// comment explains why — the `LedgerEvent` union's `payload` is a recursive `z.lazy` type, and Workers-RPC's
// structural mapper recurses into it, "exploding into a TS2589 'excessively deep' instantiation at every
// stub.append() call site". So every caller casts to a HAND-WRITTEN surface instead.
//
// There are SIX of them, in five packages (agents ×2, api ×2, translator, and the billing port). They agree
// today — measured. Nothing keeps them agreeing: rename a field in `AppendReq` and every caller still compiles,
// because a cast is not a check (a lesson this record already carries: "a type argument can be a cast"), and
// fails at runtime the first time an event is appended.
//
// This is the third member of the cross-worker-contract family (§1300 billing↔api paths, §1301 mcp↔api paths)
// and the largest: six copies rather than two. Same remedy, same idiom — compare the declared field NAMES.

const APPEND_REQ = "workers/api/src/do/sequencer.ts";

/** The REQUIRED field names of the DO's own AppendReq (optional members are not part of the caller contract). */
function canonicalFields(root: string): string[] {
  const src = readFileSync(`${root}/${APPEND_REQ}`, "utf8");
  const m = /type AppendReq = \{([^}]*)\}/.exec(src);
  if (m === null) throw new Error(`AppendReq not found in ${APPEND_REQ} — this gate's parser is stale, not the tree`);
  return [...m[1]!.matchAll(/(\w+)(\??):/g)].filter((x) => x[2] !== "?").map((x) => x[1]!).sort();
}

/** Every hand-written `append(req: { … })` surface in shipped source, with its required field names. */
function handWritten(root: string): { file: string; line: number; fields: string[] }[] {
  // Pathspec NOT glob-quoted: `'workers/*/src'` matches nothing here (git treats it as a literal path, and the
  // sources live deeper). Measured — the gate's own non-vacuity floor caught this on its first run, which is
  // what that floor is for (§1274's precedent, second occurrence).
  const raw = execSync(`git grep -n 'append(req: {' -- workers packages || true`, { cwd: root, encoding: "utf8" });
  const out: { file: string; line: number; fields: string[] }[] = [];
  for (const l of raw.split("\n")) {
    if (l === "" || l.includes(".test.")) continue;
    const m = /^([^:]+):(\d+):(.*)$/.exec(l);
    if (m === null) continue;
    const body = /append\(req: \{([^}]*)\}/.exec(m[3]!);
    if (body === null) continue;
    out.push({
      file: m[1]!,
      line: Number(m[2]),
      fields: [...body[1]!.matchAll(/(\w+)(\??):/g)].filter((x) => x[2] !== "?").map((x) => x[1]!).sort(),
    });
  }
  return out;
}

// The billing port is NOT a DO stub: it POSTs the internal HTTP route, which supplies `tenant` server-side from
// the secret-gated seam (§1300). Its shape is deliberately different and is gated there, not here.
const NOT_A_DO_STUB = ["workers/billing/src/platform-ledger.ts"];

describe("§1302 REQ-030: every hand-written sequencer stub matches the DO's own AppendReq", () => {
  const root = repoRoot();

  it("both sides parse, and the caller surfaces are actually numerous (non-vacuity)", () => {
    expect(canonicalFields(root).length, "AppendReq parsed to no required fields — parser stale").toBeGreaterThanOrEqual(3);
    const stubs = handWritten(root).filter((s) => !NOT_A_DO_STUB.includes(s.file));
    expect(stubs.length, "no hand-written append surfaces found — the matcher is broken, not the tree").toBeGreaterThanOrEqual(4);
  });

  it("no caller declares a field set that differs from the DO's", () => {
    const canon = canonicalFields(root);
    const drift = handWritten(root)
      .filter((s) => !NOT_A_DO_STUB.includes(s.file))
      .filter((s) => s.fields.join(",") !== canon.join(","))
      .map((s) => `${s.file}:${s.line} declares [${s.fields.join(", ")}], the DO requires [${canon.join(", ")}]`);
    expect(
      drift,
      "a hand-written sequencer stub has drifted from `AppendReq`. Every caller CASTS to its own surface (the " +
        "recursive-union workaround the DO documents), so a cast cannot catch this and typecheck stays green — " +
        "the failure is at runtime, on the append chokepoint every event passes through:\n  " +
        drift.join("\n  "),
    ).toEqual([]);
  });
});
