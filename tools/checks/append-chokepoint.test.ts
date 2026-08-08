import { describe, expect, it } from "vitest";
import { ALLOWED_EVENT_WRITERS, findChokepointViolations, stripComments } from "./append-chokepoint.js";
import { insertIntoRe } from "./invariants.js";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-030 / I3 (audit §56). Every gate in the system is applied on the way to ONE `INSERT INTO events` in the
// sequencer DO. That was true only because no second writer happened to exist — the DB triggers fire on
// COLLISIONS, so a direct insert with a fresh id is accepted and skips every gate. These pin the lint that
// turns the coincidence into a rule.
describe("REQ-030: the events table has exactly one application writer", () => {
  it("the real tree is clean", () => {
    expect(findChokepointViolations()).toEqual([]);
  });

  it("the allowlist is exactly the two known writers, each with a stated reason", () => {
    // Pinned by NAME. A third entry is a deliberate act that has to change this test and say why —
    // which is the point: the allowlist is the place a bypass would be legitimised quietly.
    expect([...ALLOWED_EVENT_WRITERS.keys()].sort()).toEqual([
      "tools/seed/load.ts",
      "workers/api/src/do/sequencer.ts",
    ]);
    for (const reason of ALLOWED_EVENT_WRITERS.values()) expect(reason.length).toBeGreaterThan(40);
  });

  it("every allowlisted path still exists AND still writes events (§672 — no exemption outlives its subject)", () => {
    // ALLOWED's only effect is `continue`: the file is never scanned. So an entry is a bypass attached to a
    // PATH, not to a reason. If the module is deleted or stops writing events, the entry survives — and
    // whatever is created at that path next inherits a bypass of the append chokepoint it never earned,
    // silently, because the gate's job is to not look there.
    //
    // The gate itself now raises this (mutation-proved: moving tools/seed/load.ts takes it to exit 1). This
    // asserts the same property directly, so the rule is pinned in test:tools as well as on the CLI path.
    const root = repoRoot();
    const tracked = new Set(execSync("git ls-files", { cwd: root, encoding: "utf8" }).split("\n"));
    for (const [rel] of ALLOWED_EVENT_WRITERS) {
      expect(tracked.has(rel), `ALLOWED exempts ${rel}, which is not a tracked file — delete the entry`).toBe(true);
      const body = stripComments(readFileSync(`${root}/${rel}`, "utf8"));
      const eventInsert = insertIntoRe("events"); // the SHARED matcher the gate uses, not a re-authored copy
      expect(
        eventInsert.test(body),
        `ALLOWED exempts ${rel} from the append chokepoint, but it no longer writes the events table. The ` +
          "exemption is now attached to a path rather than to a reason — delete the entry",
      ).toBe(true);
    }
  });
});

// The stripper is where a FALSE NEGATIVE would hide: over-strip and a real bypass inside a template literal
// becomes invisible. Under-strip and the check flags its own documentation (it did, on the first run).
describe("comment stripping is exact enough to be trusted", () => {
  it("blanks comment bodies but keeps line numbers stable", () => {
    const out = stripComments(`const a = 1;\n// INSERT INTO events\nconst b = 2;\n`);
    expect(out.split("\n").length).toBe(4);
    expect(out).not.toContain("INSERT INTO events");
    expect(out).toContain("const b = 2;");
  });

  it("does NOT strip a real INSERT that merely sits in a string or template literal", () => {
    const out = stripComments('const SQL = `INSERT INTO events (id) VALUES (?)`;\n');
    expect(out).toContain("INSERT INTO events");
  });

  it("§674: is a TYPESCRIPT stripper — an unquoted `//` (CSS `url()`) blanks the rest of the line", () => {
    // NOT a bug in its current use, and deliberately pinned as a BOUNDARY rather than fixed.
    //
    // Every caller scans TypeScript (SOURCE_SCAN_GLOBS is .ts/.tsx only), where `//` outside a string IS a
    // comment and this behaviour is exactly right. The quoted-URL case immediately below proves the string
    // handling that makes it right.
    //
    // CSS is different: it has no line comments, so `url(https://x/i.png)` is CODE, and here the `//`
    // swallows everything after it on that line. §674 found this while considering whether to reuse this
    // helper in the design audit (which DOES scan .css) to stop it flagging a hex written in a comment.
    // Measured before making that change: the "fix" would have BLANKED a real `color: #ff0000` sitting after
    // a url() on the same line — a hole in a blocking gate, introduced while closing a cry-wolf.
    //
    // So this test exists to stop the next person doing what §674 nearly did. If a CSS-scanning gate needs
    // comment stripping, it needs a CSS-aware stripper, not this one.
    const css = "a { background: url(https://x.test/i.png); color: #ff0000; }";
    expect(stripComments(css)).not.toContain("#ff0000");
  });

  it("is not fooled by a // inside a string — that is a URL, not a comment", () => {
    const out = stripComments('const u = "https://x.test/a"; const SQL = "INSERT INTO events";\n');
    expect(out).toContain("INSERT INTO events");
    expect(out).toContain("https://x.test/a");
  });

  it("handles block comments and an escaped quote without losing the code after them", () => {
    expect(stripComments('/* INSERT INTO events */ const ok = 1;')).toContain("const ok = 1;");
    expect(stripComments('const s = "a\\"b"; const SQL = "INSERT INTO events";')).toContain("INSERT INTO events");
  });
});

// Audit §71 — the evasion corpus, mirroring the legs corpus in `invariants.test.ts`.
//
// This check shipped in §56 with a HAND-WRITTEN matcher requiring `INTO\s+`, so `INSERT INTO"events"` walked
// past it — the exact blind spot `share-lint-matchers-with-parity-tests` exists to prevent, already covered
// for `legs`, reproduced here anyway. The matcher is now the shared `insertIntoRe` builder; this corpus is
// what keeps that true, and what a future delimiter form gets added to.
describe("REQ-030: every delimiter/schema form of an event write is caught (share-lint parity)", () => {
  const EVASIONS = [
    'INSERT INTO events (id) VALUES (?)', // whitespace, bare
    'INSERT INTO"events" (id) VALUES (?)', // abutting quote — the \s+ blind spot that shipped in §56
    'INSERT OR REPLACE INTO main.events (id) VALUES (?)', // schema-qualified
    'INSERT OR IGNORE INTO [events] (id) VALUES (?)', // bracket delimiter
    'INSERT INTO `events` (id) VALUES (?)', // backtick
    'INSERT INTO "main" . "events" (id) VALUES (?)', // quoted schema, spaces around the dot
  ];
  for (const sql of EVASIONS) {
    it(`flags: ${sql.slice(0, 46)}…`, () => {
      const re = insertIntoRe("events");
      re.lastIndex = 0;
      expect(re.test(sql)).toBe(true);
    });
  }

  it("does NOT flag a write to a DIFFERENT table whose name merely starts with the target", () => {
    // `events_archive` must not read as `events` — \b after the alternation is what prevents it. Without
    // this the allowlist would be unfalsifiable: everything would look like a violation.
    const re = insertIntoRe("events");
    re.lastIndex = 0;
    expect(re.test('INSERT INTO events_archive (id) VALUES (?)')).toBe(false);
  });
});

// REQ-021/022/030 §567 — EVERY ROUTE THAT APPENDS MUST ESTABLISH source:'native'.
//
// The DO exempts `source:'legacy'` from the native physical-precondition gates (invoice→POD, appointment,
// dispatch), because a legacy row is a SHADOW MIRROR of something the incumbent already did. That carve-out
// is safe only while a client cannot self-declare it: a forged `source:'legacy'` would bypass those gates
// entirely and forge a "the incumbent already did this" record.
//
// `events.ts` states the property and enumerates the routes holding it up — *"rate.ts / portal-actions /
// dunning / approvals / authority all already hardcode 'native'"*. That enumeration was correct when measured
// (all seven append sites establish it), and `source-aware-ledger.test.ts` proves the coercion works for the
// general write route. **Nothing proved the list was complete**, and a hand-kept list of security-critical
// call sites is the §562 shape — the risk is route #8, not the seven that exist.
//
// SCOPE, stated plainly: this is FILE-level. It proves a route file that appends knows about the rule, not
// that every path inside it obeys. That is deliberate — the failure this catches is a NEW route written
// without the coercion, which is the one the enumeration cannot survive. A second append added to an
// already-compliant file is out of its reach, and `source-aware-ledger.test.ts` is where that lives.
describe("REQ-021/030 §567: no append route can omit the native-source lock", () => {
  const ROUTES_DIR = "workers/api/src/routes";
  const APPEND = /\b(?:stub|seq)\.append\s*\(/;
  const NATIVE = /source:\s*"native"|source\s*=\s*"native"/;

  function routeFilesThatAppend(): string[] {
    const root = repoRoot();
    const files = execSync(`git ls-files "${ROUTES_DIR}/*.ts"`, { cwd: root, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter((f) => f && !f.includes(".test."));
    return files.filter((f) => APPEND.test(stripComments(readFileSync(`${root}/${f}`, "utf8"))));
  }

  it("finds the append routes at all (non-vacuity)", () => {
    // A renamed directory or a changed append idiom would yield an empty list and pass over it — the class
    // this repo met in four gates (§487/§554/§558).
    expect(routeFilesThatAppend().length, "no appending route files found — the scan is broken, not the tree").toBeGreaterThan(4);
  });

  it("every appending route establishes source:'native' — hardcoded or coerced", () => {
    const root = repoRoot();
    const offenders = routeFilesThatAppend().filter((f) => !NATIVE.test(stripComments(readFileSync(`${root}/${f}`, "utf8"))));
    expect(
      offenders,
      "route(s) that append to the sequencer without pinning source:'native'. A client-supplied " +
        "`source:'legacy'` is EXEMPT from the DO's physical-precondition gates (invoice→POD, appointment, " +
        "dispatch), so a route that forwards a client body verbatim forges a mirror record and bypasses them. " +
        "Hardcode `source: \"native\"` in the event, or coerce it on the input before the append:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});

// §571's narrower tenant guard MOVED to tools/checks/tenant-scope.test.ts (§572): it watched one function
// through a glob that read 39% of the source. One mechanism owns REQ-025's argument invariant now — two
// enforcing one rule is itself the finding when their scopes differ.
