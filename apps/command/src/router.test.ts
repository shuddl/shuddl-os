import { describe, expect, it } from "vitest";
import { resolveRoute } from "./router.js";

// REQ-081 — the command surface's tiny path/hash router. The map board is the default (the map IS the home,
// REQ-073/080). Queues (approvals/exceptions/money), the KPI drill-through, and the ⌘K copilot are the stubs
// T9-T12 wire to real views. The resolver is PURE (it takes only the location pieces) so the whole routing
// table is exhaustively unit-tested without a DOM. It must NOT invent a 13th canonical view.

function loc(pathname: string, search = "", hash = ""): { pathname: string; search: string; hash: string } {
  return { pathname, search, hash };
}

describe("resolveRoute (REQ-081)", () => {
  it("the default (root) is the map board", () => {
    expect(resolveRoute(loc("/"))).toEqual({ name: "board" });
    // The visual harness loads command at `/` — the board must resolve there (no regression).
  });

  it("an unknown path falls back to the board", () => {
    expect(resolveRoute(loc("/anything/else"))).toEqual({ name: "board" });
  });

  it("/queue/:kind resolves the three canonical queues", () => {
    expect(resolveRoute(loc("/queue/approvals"))).toEqual({ name: "queue", kind: "approvals" });
    expect(resolveRoute(loc("/queue/exceptions"))).toEqual({ name: "queue", kind: "exceptions" });
    expect(resolveRoute(loc("/queue/money"))).toEqual({ name: "queue", kind: "money" });
  });

  it("/queue with a ?kind= query resolves the queue too", () => {
    expect(resolveRoute(loc("/queue", "?kind=exceptions"))).toEqual({ name: "queue", kind: "exceptions" });
  });

  it("an unknown queue kind falls back to the board (never a 13th view)", () => {
    expect(resolveRoute(loc("/queue/nope"))).toEqual({ name: "board" });
    expect(resolveRoute(loc("/queue"))).toEqual({ name: "board" });
  });

  it("/kpi/:metric is the KPI drill-through and carries the metric slug", () => {
    expect(resolveRoute(loc("/kpi/dso"))).toEqual({ name: "kpi", metric: "dso" });
  });

  it("/kpi with no metric resolves the drill index (metric null)", () => {
    expect(resolveRoute(loc("/kpi"))).toEqual({ name: "kpi", metric: null });
  });

  it("/copilot is the ⌘K copilot surface", () => {
    expect(resolveRoute(loc("/copilot"))).toEqual({ name: "copilot" });
  });

  it("trailing slashes do not change the route", () => {
    expect(resolveRoute(loc("/queue/approvals/"))).toEqual({ name: "queue", kind: "approvals" });
    expect(resolveRoute(loc("/copilot/"))).toEqual({ name: "copilot" });
  });
});
