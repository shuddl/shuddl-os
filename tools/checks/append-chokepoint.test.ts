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

// REQ-025 §571 — THE TENANT HANDLE COMES FROM AN AUTHENTICATED SOURCE, NEVER FROM REQUEST INPUT.
//
// CLAUDE.md rule 8: a cross-tenant read anywhere is a build failure. The isolation suites are large (five
// files, 1,200+ lines in `workers/api/test/isolation.test.ts` alone) and the skill carries a hand-kept
// `read-path-registry.md` whose own instruction is *"keep in sync with the code"* — an instruction, not a
// mechanism. Measured: the registry lists ~10 read paths; **29 files call `resolveTenantDb`.**
//
// That gap is not the defect it looks like. Per-route enumeration is the wrong frame, because every
// tenant-scoped read funnels through ONE function and the only thing that matters is **where its tenant
// argument comes from**. All 35 call sites were enumerated and every one derives from an authenticated
// source: `session.tenant` (32), the DO's re-derived+validated `tenant`, `claims.t` (MAC-verified by
// `verifyStatusCap` before use, fail-closed to the same 401), and one `c.get("session")`.
//
// What was missing is call site #36. A route written as `resolveTenantDb(c.env, c.req.param("tenant"))` is a
// direct cross-tenant read, and nothing would have caught it — the registry is a document, and no test
// asserts the shape of this argument.
//
// ALLOWLIST rather than denylist, deliberately: a denylist of bad shapes (`c.req.`, `param(`, `query(`) is a
// guess about how the next mistake will be spelled, and §525's rule is that the narrower the pattern the more
// confidently it lies. An allowlist fails on ANY new form, including ones nobody predicted, and the fix is to
// add the form here — which is exactly the review moment this exists to create.
describe("REQ-025 §571: every tenant-DB handle is derived from an authenticated identity", () => {
  const ALLOWED_TENANT_ARGS = new Set([
    "session.tenant", // the JWT claim, verified by the auth middleware — 32 of 35 sites
    "tenant", // do/sequencer.ts: the DO's own identity, re-derived and pin-checked BEFORE this call
    "claims.t", // pub/status.ts: MAC-verified by verifyStatusCap, fail-closed to a uniform 401
    'c.get("session"', // the same session, read off the Hono context
  ]);

  function tenantArgs(): { file: string; arg: string }[] {
    const root = repoRoot();
    const files = execSync('git ls-files "workers/*/src/**/*.ts"', { cwd: root, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter((f) => f && !f.includes(".test."));
    const out: { file: string; arg: string }[] = [];
    for (const f of files) {
      const text = stripComments(readFileSync(`${root}/${f}`, "utf8"));
      for (const m of text.matchAll(/resolveTenantDb\s*\(([^)]*)\)/gs)) {
        const args = m[1]!.split(",").map((s) => s.trim()).filter(Boolean);
        const last = args[args.length - 1];
        if (last !== undefined) out.push({ file: f, arg: last });
      }
    }
    return out;
  }

  it("finds the call sites at all (non-vacuity)", () => {
    expect(tenantArgs().length, "no resolveTenantDb call sites found — the scan is broken, not the tree").toBeGreaterThan(20);
  });

  it("no call site derives its tenant from request input", () => {
    const stray = tenantArgs().filter((s) => !ALLOWED_TENANT_ARGS.has(s.arg));
    expect(
      stray,
      "resolveTenantDb called with a tenant that is not a known authenticated source. If this is a NEW " +
        "authenticated form, add it to ALLOWED_TENANT_ARGS with a note on what verifies it. If it comes from " +
        "the request (a param, query, header or body field), it is a cross-tenant read: CLAUDE.md rule 8 makes " +
        "that a build failure (REQ-025).\n  " +
        stray.map((s) => `${s.file} → ${s.arg}`).join("\n  "),
    ).toEqual([]);
  });
});
