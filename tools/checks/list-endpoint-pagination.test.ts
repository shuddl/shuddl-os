import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §824 — A TENTH UNPAGINATED LIST ENDPOINT MUST NOT BE FOUND BY HAND.
//
// §823 filed the ninth unbounded read (`GET /v1/approvals`) and closed by naming its own residual: the
// enumeration that found it was a **one-off script**, so nothing would notice a tenth. §822 gates full-table
// scans in SQL; this gates the surface above them — an HTTP list endpoint that returns rows to a caller with
// no bound on how many.
//
// WHY THE SURFACE AND NOT ONLY THE SQL. `/v1/approvals` has a `WHERE status = ?`, so §822's no-WHERE scanner
// is blind to it by design; only the fact that a CALLER receives every matching row makes it a hold. The two
// gates cover different halves and neither subsumes the other.
//
// THE DISCRIMINATOR, and the two false readings it took to get right:
//   1. First draft matched `/\bLIMIT\b/i` over the whole handler body. `{ shipment_id, limit: 1 }` — a JS
//      option object on an unrelated read — counted as SQL pagination. Right verdict for that endpoint, from
//      evidence that had nothing to do with the list query.
//   2. It also read `/v1/invoices` as paginated. It is NOT: the roster carries BOTH its lenses as unbounded,
//      and reading it as bounded would have silently removed a filed hold from this gate's view.
// So `LIMIT` now counts only inside a string that actually contains `SELECT`, and the query-param and
// route-param forms are matched explicitly. Evidence in SQL context, never a word in prose.

interface Endpoint {
  readonly route: string;
  readonly file: string;
  readonly bounds: readonly string[];
}

const STRING_LITERAL = /`[^`]*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

/** The brace-matched body of the handler registered at `app.get("…", …)`. */
function handlerBody(src: string, from: number): string | undefined {
  const arrow = src.indexOf("=>", from);
  if (arrow < 0) return undefined;
  const open = src.indexOf("{", arrow);
  if (open < 0) return undefined;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth += 1;
    else if (src[j] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, j);
    }
  }
  return undefined;
}

/** Every GET handler that returns a ROW SET, with whatever evidence bounds it. */
function listEndpoints(root: string): Endpoint[] {
  const files = execSync('git ls-files "workers/api/src"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.ts$/.test(f) && !f.includes(".test.") && !f.includes("/test/"));
  const out: Endpoint[] = [];
  for (const f of files) {
    const src = readFileSync(`${root}/${f}`, "utf8");
    for (const m of src.matchAll(/app\.get\(\s*"([^"]+)"/g)) {
      const body = handlerBody(src, m.index + m[0].length);
      if (body === undefined) continue;
      if (!body.includes(".all<") && !body.includes(".all()")) continue; // not a row-set read

      // SQL-context LIMIT only: a literal that actually contains SELECT.
      const sql = (body.match(STRING_LITERAL) ?? []).filter((s) => /\bSELECT\b/i.test(s)).join(" ");
      const bounds: string[] = [];
      if (/\bLIMIT\b/.test(sql)) bounds.push("SQL LIMIT");
      if (/c\.req\.query\(\s*"(cursor|after[_a-z]*|before[_a-z]*|next[_a-z]*)"/.test(body)) bounds.push("cursor param");
      if (/c\.req\.param\(/.test(body)) bounds.push("route-param scope");
      out.push({ route: m[1]!, file: f, bounds });
    }
  }
  return out;
}

/**
 * The list endpoints that return an unbounded row set, each with the reason it is tolerated TODAY.
 * Three are filed holds; the fourth is bounded by something this scanner cannot see.
 */
const KNOWN_UNPAGINATED: ReadonlyArray<{ route: string; why: string }> = [
  {
    route: "/v1/approvals",
    why: "FILED — the ninth unbounded read (§823). Every approval of a status, no cursor. Remedy needs a REQ row.",
  },
  {
    route: "/v1/invoices",
    why: "FILED — two roster rows (§794): the tenant lens has no WHERE at all, the party lens returns every invoice for a party.",
  },
  {
    route: "/v1/watchtower",
    why: "FILED — roster (§794): `status=all` drops the WHERE entirely.",
  },
  {
    route: "/v1/driver/manifest",
    why:
      "NOT a pagination hold. Scoped to `session.sub` — the AUTHENTICATED driver, never a client-supplied id " +
      "— so it is bounded per principal, and this scanner cannot see a session-derived bound. Its real defect " +
      "is the §185 INDEX hold (nothing supports the `shipment_id` filter on `legs`), which is a different one.",
  },
];

describe("§824: no NEW unpaginated list endpoint", () => {
  const endpoints = listEndpoints(repoRoot());

  it("the scan actually found the API surface (non-vacuity)", () => {
    // A broken brace-matcher or a moved directory would return [] and make every assertion below vacuous.
    expect(endpoints.length, "no GET list endpoints found at all — the scanner broke").toBeGreaterThanOrEqual(6);
    expect(endpoints.map((e) => e.route)).toContain("/v1/invoices");
  });

  it("the BOUNDED discriminator can fire — in both of its forms", () => {
    // The half that matters most. If `bounds` were always empty, the discovery test would red loudly and
    // someone would "fix" it by widening the allowlist; if it were always non-empty, the calibration below
    // would red. Pinning one endpoint per form keeps both failure modes visible for the right reason.
    const byRoute = new Map(endpoints.map((e) => [e.route, e.bounds]));
    expect(byRoute.get("/v1/exceptions"), "the cursor-param form stopped being detected").toContain("cursor param");
    expect(byRoute.get("/v1/shipments/:id/documents"), "the route-param form stopped being detected").toContain(
      "route-param scope",
    );
  });

  it("finds every KNOWN unpaginated endpoint (calibration on live positives)", () => {
    // These are real, not planted, so this calibration cannot rot the way a synthetic one can. If one stops
    // being reported it was either PAGINATED (good — drop the row here, and its roster row if it has one) or
    // the scanner broke. Both need a human.
    const unpaginated = new Set(endpoints.filter((e) => e.bounds.length === 0).map((e) => e.route));
    for (const k of KNOWN_UNPAGINATED) {
      expect(
        unpaginated,
        `${k.route} is no longer reported as unpaginated. If it gained a cursor, remove it here AND from ` +
          "the unbounded-read roster + GO-LIVE-CHECKLIST in the same commit — a hold that shrank must be " +
          "said out loud. If the scanner broke, every clean result below is worthless.",
      ).toContain(k.route);
    }
  });

  it("§825: the scan's SCOPE is still the whole HTTP surface — no routes outside workers/api/src", () => {
    // §824 scans `workers/api/src` and named that as its blind spot: a list endpoint in another worker would
    // be invisible. Measured (§825) and now PINNED rather than left as a point-in-time note — the other four
    // workers are raw `fetch()` handlers with no route table at all: zero `hono` imports, zero route verbs.
    // MCP is the only other caller-facing worker, and all five of its D1 reads are single-row lookups by
    // primary key (four carry an explicit `LIMIT 1`), so it returns no row set of its own; its data reads
    // proxy through `env.API`, which the assertions above already cover.
    //
    // The moment any of that stops being true this fails, and the answer is to WIDEN the scan — never to
    // relax this test. A blind spot that is measured once is a blind spot again on the next commit.
    const offenders = execSync('git ls-files "workers"', { cwd: repoRoot(), encoding: "utf8" })
      .split("\n")
      .filter((f) => /\.ts$/.test(f) && !f.startsWith("workers/api/") && !f.includes(".test.") && !f.includes("/test/"))
      .filter((f) => {
        const src = readFileSync(`${repoRoot()}/${f}`, "utf8");
        return /from "hono"/.test(src) || /\.(get|post|put|delete)\(\s*"\//.test(src);
      });
    expect(
      offenders,
      "a worker outside `workers/api/src` now registers HTTP routes. §824's list-endpoint scan does NOT " +
        "look there, so any list endpoint it serves is ungated. Widen `listEndpoints()` to cover it — do " +
        "not relax this assertion, which exists precisely to make that scope change deliberate.",
    ).toEqual([]);
  });

  it("no list endpoint returns an unbounded row set outside the filed set", () => {
    const known = new Set(KNOWN_UNPAGINATED.map((k) => k.route));
    const novel = endpoints.filter((e) => e.bounds.length === 0 && !known.has(e.route));
    expect(
      novel.map((n) => `${n.route}  (${n.file})`),
      "a GET endpoint returns every matching row to the caller — no SQL LIMIT, no cursor query param, and " +
        "no route-param scope. Every row the tenant has accumulated is loaded into one 128MB Worker " +
        "response. Give it a keyset cursor (REQ-197/010 established the shape; a bare LIMIT truncates " +
        "silently and this repo forbids that), or — if it is bounded by something this scanner cannot see, " +
        "such as a session-derived principal — add it to KNOWN_UNPAGINATED with that reason:",
    ).toEqual([]);
  });
});
