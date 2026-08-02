import { describe, expect, it } from "vitest";
import { ALLOWED_EVENT_WRITERS, findChokepointViolations, stripComments } from "./append-chokepoint.js";

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
