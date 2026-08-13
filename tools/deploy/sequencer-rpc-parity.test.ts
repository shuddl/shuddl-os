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


// §1303 — THE FOURTH SEAM: THE QUEUE, WHOSE DRIFT IS SILENT.
//
// The sequencer HAND-BUILDS agent triggers as object literals; the agents worker parses them with a Zod
// discriminated union whose members are `.strict()`. The api cannot import those schemas (separate workers),
// so this is the same structural duplication as §1302 — with a worse failure mode.
//
// A path mismatch 404s and a header mismatch 403s: both loud. A trigger whose shape drifts fails `safeParse`
// and, per the consumer's own comment, is **ACKed** — the message is consumed and discarded. §1275 measured
// that two of these triggers have NO recovery sweep, so a drift here is a permanently lost booking or a
// permanently unanswered customer email, with nothing anywhere reporting it.
//
// `.strict()` makes the contract exact in BOTH directions: a missing field is rejected, and so is an extra one.

const PRODUCER = "workers/api/src/do/sequencer.ts";
const CONSUMERS: readonly { file: string; schema: string }[] = [
  { file: "workers/agents/src/biller.ts", schema: "PodSignedMessage" },
  { file: "workers/agents/src/booking.ts", schema: "QuoteAcceptedTrigger" },
  { file: "workers/agents/src/concierge.ts", schema: "MessageReceivedTrigger" },
];

/** kind → { required, optional } as the consumer's Zod schema declares them. */
function consumerShapes(root: string): Map<string, { required: string[]; all: string[] }> {
  const out = new Map<string, { required: string[]; all: string[] }>();
  for (const c of CONSUMERS) {
    const src = readFileSync(`${root}/${c.file}`, "utf8");
    const m = new RegExp(`export const ${c.schema} = z\\s*\\.object\\(\\{([\\s\\S]*?)\\}\\)`).exec(src);
    if (m === null) throw new Error(`${c.schema} not found in ${c.file} — parser stale, not the tree`);
    const body = m[1]!;
    const kind = /kind: z\.literal\("([^"]+)"\)/.exec(body)?.[1];
    if (kind === undefined) throw new Error(`${c.schema} declares no z.literal kind`);
    const members = [...body.matchAll(/^\s*(\w+):\s*(.+)$/gm)].map((x) => ({ name: x[1]!, decl: x[2]! }));
    out.set(kind, {
      required: members.filter((x) => !x.decl.includes(".optional()")).map((x) => x.name).sort(),
      all: members.map((x) => x.name).sort(),
    });
  }
  return out;
}

/** Every trigger literal the producer sends: any `{ kind: "…", tenant … }` object in the DO. */
function producerLiterals(root: string): { kind: string; fields: string[] }[] {
  const src = readFileSync(`${root}/${PRODUCER}`, "utf8");
  return [...src.matchAll(/\{\s*kind:\s*"([\w.]+)"\s*,\s*tenant\b([^}]*)\}/g)].map((m) => ({
    kind: m[1]!,
    fields: ["kind", "tenant", ...[...m[2]!.matchAll(/(\w+)\s*[:,}]/g)].map((x) => x[1]!)]
      .filter((f, i, a) => a.indexOf(f) === i)
      .sort(),
  }));
}

describe("§1303 REQ-095/030: every queue trigger the sequencer sends satisfies the consumer's schema", () => {
  const root = repoRoot();

  it("both sides parse, and all three trigger kinds are present (non-vacuity)", () => {
    const consumers = consumerShapes(root);
    expect([...consumers.keys()].sort()).toEqual(["message.received", "pod.signed", "quote.accepted"]);
    expect(producerLiterals(root).length, "no trigger literals parsed from the sequencer — matcher stale").toBeGreaterThanOrEqual(3);
  });

  it("no trigger literal omits a required field or carries one the schema forbids", () => {
    const consumers = consumerShapes(root);
    const bad: string[] = [];
    for (const lit of producerLiterals(root)) {
      const shape = consumers.get(lit.kind);
      if (shape === undefined) {
        bad.push(`kind "${lit.kind}" has NO consumer schema — the message is ACKed and discarded`);
        continue;
      }
      const missing = shape.required.filter((f) => !lit.fields.includes(f));
      const extra = lit.fields.filter((f) => !shape.all.includes(f));
      if (missing.length > 0) bad.push(`kind "${lit.kind}" omits required [${missing.join(", ")}]`);
      if (extra.length > 0) bad.push(`kind "${lit.kind}" carries [${extra.join(", ")}] which .strict() rejects`);
    }
    expect(
      bad,
      "a queue trigger no longer satisfies its consumer schema. This does NOT 4xx — safeParse fails and the " +
        "consumer ACKs the message, so the trigger is silently discarded, and §1275 measured that two of these " +
        "have no recovery sweep:\n  " +
        bad.join("\n  "),
    ).toEqual([]);
  });
});
