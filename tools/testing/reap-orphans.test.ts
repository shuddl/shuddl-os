import { describe, expect, it } from "vitest";
import { parseOrphans } from "./reap-orphans.js";

// §1061 — the reaper's two safety rules are the whole gate. A reaper that is too eager kills the suite that is
// running (including its own caller); one that is too narrow leaves the debris that raises ambient load and
// pushes a boundary-adjacent assertion over its timeout (§1052). Both directions are pinned here rather than
// trusted, because neither is observable from a run that happens to be clean.

// A synthetic checkout root. NOT a `/Users/<name>` or `/home/<name>` path: REQ-167 bans that SHAPE in any
// tracked artifact regardless of whether the name is real, and §1062 caught this file violating it with a
// placeholder. A fixture that would fail a constitutional lint is not a safe fixture.
const ROOT = "/srv/checkout";
const ps = (rows: readonly string[]): string => ["  PID  PPID ELAPSED ARGS", ...rows].join("\n");

describe("§1061: the orphan reaper touches exactly the orphans of this checkout", () => {
  it("reaps a reparented workerd belonging to this repo", () => {
    const out = parseOrphans(ps([`  270     1 19:01:23 ${ROOT}/node_modules/.pnpm/@cloudflare+workerd/bin/workerd serve`]), ROOT);
    expect(out).toEqual([{ pid: 270, etime: "19:01:23" }]);
  });

  it("NEVER touches a workerd with a live parent — that is a RUNNING suite, possibly its own caller", () => {
    // The dangerous direction. A live run's workerd is parented to the vitest node process, so PPID !== 1 is
    // the only thing standing between this script and killing the tests that invoked it.
    expect(parseOrphans(ps([`  270   254 00:00:30 ${ROOT}/node_modules/.pnpm/@cloudflare+workerd/bin/workerd serve`]), ROOT)).toEqual([]);
  });

  it("NEVER touches another checkout's workerd on the same machine", () => {
    // Same binary name, same orphaned state, different repo. Matching on the absolute path is what scopes it.
    expect(parseOrphans(ps([`  271     1 19:01:23 /srv/other-checkout/node_modules/.pnpm/@cloudflare+workerd/bin/workerd`]), ROOT)).toEqual([]);
  });

  it("NEVER touches an unrelated orphan under this repo (the match needs BOTH conditions)", () => {
    expect(parseOrphans(ps([`  272     1 19:01:23 ${ROOT}/node_modules/.bin/esbuild --serve`]), ROOT)).toEqual([]);
  });

  it("handles a realistic mixed table (the state §1054 actually found)", () => {
    const out = parseOrphans(
      ps([
        `   23091     1 19:01:23 ${ROOT}/node_modules/.pnpm/@cloudflare+workerd/bin/workerd serve --socket-addr`,
        `   23092     1 19:01:23 ${ROOT}/node_modules/.pnpm/@cloudflare+workerd/bin/workerd serve --socket-addr`,
        `     270   254 00:00:30 ${ROOT}/node_modules/.pnpm/@cloudflare+workerd/bin/workerd serve`,
        `     254     1 00:00:31 node /usr/local/vitest.mjs`,
      ]),
      ROOT,
    );
    expect(out.map((o) => o.pid)).toEqual([23091, 23092]);
  });
});
