import { describe, expect, it } from "vitest";
import { resolveRoute } from "./router.js";

// REQ-086/051 — the tiny portal router. Two PUBLIC routes (status, guest quote) must resolve WITHOUT a
// session; the default is the authed board. The legacy ?screen= switch (visual harness) + the #status
// "Track" link must keep resolving so nothing that worked in WP-03 regresses.

function loc(pathname: string, search = "", hash = ""): { pathname: string; search: string; hash: string } {
  return { pathname, search, hash };
}

describe("resolveRoute (REQ-086/051)", () => {
  it("the default (root) is the authed board", () => {
    expect(resolveRoute(loc("/"))).toEqual({ name: "board" });
    expect(resolveRoute(loc("/anything/else"))).toEqual({ name: "board" });
  });

  it("/status/:cap is the PUBLIC status page and carries the cap from the path", () => {
    expect(resolveRoute(loc("/status/CAP-ABC.123"))).toEqual({ name: "status", cap: "CAP-ABC.123" });
  });

  it("/status/:cap url-decodes the cap segment", () => {
    expect(resolveRoute(loc("/status/CAP%2FABC"))).toEqual({ name: "status", cap: "CAP/ABC" });
  });

  it("/status with a ?cap= query resolves the public status page too", () => {
    expect(resolveRoute(loc("/status", "?cap=CAP9"))).toEqual({ name: "status", cap: "CAP9" });
  });

  it("/quote is the PUBLIC guest quote page", () => {
    expect(resolveRoute(loc("/quote"))).toEqual({ name: "quote" });
  });

  it("trailing slashes do not change the route", () => {
    expect(resolveRoute(loc("/quote/"))).toEqual({ name: "quote" });
  });

  it("the legacy ?screen= switch still resolves (visual harness)", () => {
    expect(resolveRoute(loc("/", "?screen=status"))).toEqual({ name: "status", cap: null });
    expect(resolveRoute(loc("/", "?screen=email"))).toEqual({ name: "email" });
    expect(resolveRoute(loc("/", "?screen=quote"))).toEqual({ name: "quote" });
    expect(resolveRoute(loc("/", "?screen=portal"))).toEqual({ name: "board" });
  });

  it("the #status Track link resolves to the status page", () => {
    expect(resolveRoute(loc("/", "", "#status"))).toEqual({ name: "status", cap: null });
  });
});
