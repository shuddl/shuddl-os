import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

// §1183 — A NAMED HANDLER BOUND THIS SCANNER TO THE WRONG FUNCTION.
//
// The original `handlerBody` searched for the next `=>` ANYWHERE after the registration. For an inline
// handler that is the right arrow. For a NAMED one — `app.get("/pub/status/:cap", publicStatusHandler)`, an
// idiom this repo already uses — there is no arrow in the registration at all, so the search ran on and bound
// to a LATER, UNRELATED function's body. Not a skip: a verdict computed from someone else's code and reported
// against this route.
//
// MEASURED at §1183, same route, same SQL, same file, one variable:
//   app.get("/v1/leak", async (c) => { … .all<…>() … })   → RED   (flagged unbounded)
//   app.get("/v1/leak", leakHandler)  + the identical body → 5/5 PASS  (invisible)
// `SELECT * FROM events` with no LIMIT, silent, because of how the handler was written.
//
// Resolved rather than merely flagged, because named handlers are legitimate and in use. An identifier is
// looked up in the same file; a handler that cannot be resolved there (an imported one) is reported by the
// input floor at the bottom of this file rather than silently analysed as something else.

/**
 * The brace-matched body of a function declared as `function NAME(` or `const NAME = …` in `src`.
 *
 * Skips the PARAMETER LIST before looking for the body brace. Written naively (first `{` after the
 * declaration) this returns the parameter's inline type annotation instead — `leakHandler(c: { env: … })`
 * yields `{ env: … }` — which reads as a handler body containing no row-set read, i.e. it fails EXACTLY the
 * way the bug being fixed failed. Caught because the §1183 plant used a typed object parameter.
 */
export function namedFunctionBody(src: string, name: string): string | undefined {
  const decl = new RegExp(String.raw`(?:async\s+)?function\s+${name}\s*\(|const\s+${name}\s*(?::[^=]+)?=`).exec(src);
  if (decl === null) return undefined;
  const paramOpen = src.indexOf("(", decl.index);
  if (paramOpen < 0) return undefined;
  let depth = 0;
  for (let j = paramOpen; j < src.length; j++) {
    if (src[j] === "(") depth += 1;
    else if (src[j] === ")") {
      depth -= 1;
      if (depth === 0) return braceMatched(src, j);
    }
  }
  return undefined;
}

/** The `{…}` block starting at or after `from`, brace-matched. */
function braceMatched(src: string, from: number): string | undefined {
  const open = src.indexOf("{", from);
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

/**
 * Resolve a named handler that is IMPORTED rather than declared locally, by following its import specifier.
 *
 * `public.ts` does exactly this — `import { publicStatusHandler } from "../pub/status.js"` — so without this
 * the two `/pub` routes stay invisible to the scanner, which is the same blind spot one indirection further
 * out. (Measured at §1183: both of that handler's reads are single-row — `WHERE id = ?` and `LIMIT 1` — so
 * nothing was hiding there today; the point is that nothing WOULD HAVE BEEN SEEN if there were.)
 */
function importedHandlerBody(root: string, file: string, src: string, name: string): string | undefined {
  const imp = new RegExp(String.raw`import\s*\{[^}]*\b${name}\b[^}]*\}\s*from\s*"([^"]+)"`).exec(src);
  if (imp === null) return undefined;
  const spec = (imp[1] as string).replace(/\.js$/, ".ts");
  if (!spec.startsWith(".")) return undefined; // a package import is not this repo's handler
  const resolved = join(dirname(file), spec);
  try {
    return namedFunctionBody(readFileSync(`${root}/${resolved}`, "utf8"), name);
  } catch {
    return undefined; // unresolvable on disk — reported by the input floor, never silently analysed
  }
}

/** The body of the handler registered at `app.get("…", …)` — inline arrow, or a named function, local or imported. */
export function handlerBody(src: string, from: number, root?: string, file?: string): string | undefined {
  // Classify from the registration's OWN argument list, not from the rest of the file. A bare identifier
  // followed by the closing paren is a named handler; anything else is treated as inline.
  const named = /^\s*,\s*([A-Za-z_$][\w$]*)\s*\)/.exec(src.slice(from, from + 200));
  if (named !== null) {
    const local = namedFunctionBody(src, named[1] as string);
    if (local !== undefined) return local;
    return root !== undefined && file !== undefined ? importedHandlerBody(root, file, src, named[1] as string) : undefined;
  }

  const arrow = src.indexOf("=>", from);
  // BOUNDED: the arrow must belong to THIS registration. Unbounded, it reaches the next function in the file.
  if (arrow < 0 || arrow > from + 200) return undefined;
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
    // §1507 — `.tsx?`, not `.ts`. There is no `.tsx` under workers today, so this is a no-op NOW; it is the
    // §1506 lesson applied before the fact, and it is what `corpus-extension.test.ts` enforces repo-wide.
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.") && !f.includes("/test/"));
  const out: Endpoint[] = [];
  for (const f of files) {
    const src = readFileSync(`${root}/${f}`, "utf8");
    for (const m of src.matchAll(/app\.get\(\s*"([^"]+)"/g)) {
      const body = handlerBody(src, m.index + m[0].length, root, f);
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

  // §1162 — SUBPROCESS TEST: this shells out, and the suite runs at vitest's DEFAULT 5000ms. Measured
  // at 5044-7725ms under the load of consecutive full-suite runs, where it failed as a TIMEOUT —
  // indistinguishable from a real defect. A per-test allowance; the suite default stays 5000ms so nothing
  // else's ceiling moves (audit §1162).
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
      .filter((f) => /\.tsx?$/.test(f) && !f.startsWith("workers/api/") && !f.includes(".test.") && !f.includes("/test/")) // §1507
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
  }, 20_000);

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

// §1183 — THE RESOLVER'S OWN UNIT TESTS. The gate's end-to-end behaviour cannot prove these: `/pub/status/:cap`
// carries a `c.req.param(` and a `LIMIT 1`, so it is judged BOUNDED however its body is resolved. That makes it
// a useless control for the resolution itself — the verdict is the same whether the body is read correctly, read
// from the wrong function, or not read at all. Test the resolver directly instead.
describe("§1183: the handler resolver reads the RIGHT body", () => {
  const root = repoRoot();

  it("resolves an INLINE arrow handler", () => {
    const src = 'app.get("/v1/x", async (c) => { const r = await db.prepare("SELECT 1").all<{ a: 1 }>(); });';
    expect(handlerBody(src, src.indexOf('"/v1/x"') + 7)).toContain(".all<");
  });

  it("resolves a LOCAL named handler past its parameter type annotation", () => {
    // The bug this catches: taking the first `{` after the declaration yields `{ env: { DB: D1Database } }` —
    // the PARAMETER's type — which contains no row-set read and reads exactly like a clean handler.
    const src = [
      'app.get("/v1/x", leak);',
      "async function leak(c: { env: { DB: D1Database } }): Promise<Response> {",
      '  const rows = await c.env.DB.prepare("SELECT * FROM events").all<{ id: string }>();',
      "}",
    ].join("\n");
    const body = handlerBody(src, src.indexOf('"/v1/x"') + 7);
    expect(body, "resolved the parameter type instead of the body").toContain(".all<");
    expect(body).not.toContain("D1Database }");
  });

  it("follows an IMPORT to another file — proved against real repo source", () => {
    // public.ts registers `publicStatusHandler`, which lives in ../pub/status.ts. `accuracy_m` appears in that
    // module and NOWHERE in public.ts, so finding it proves the import was followed to the right file.
    //
    // The first draft used `status_cache` and the premise assertion below FAILED — public.ts names it in prose
    // describing the endpoint. That is the assertion doing its job: without it the test would have "passed" on
    // a marker that proves nothing about which file was read.
    const file = "workers/api/src/routes/public.ts";
    const src = readFileSync(`${root}/${file}`, "utf8");
    expect(src, "premise: the marker must not be resolvable locally").not.toContain("accuracy_m");
    const body = handlerBody(src, src.indexOf('"/pub/status/:cap"') + 18, root, file);
    expect(body, "the imported handler body was not resolved").toBeDefined();
    expect(body).toContain("accuracy_m");
  });

  it("returns undefined for a handler it cannot resolve, rather than a WRONG body", () => {
    const src = 'app.get("/v1/x", handlerFromSomewhereElse);\nfunction other() { return "SELECT 1"; }';
    expect(handlerBody(src, src.indexOf('"/v1/x"') + 7, root, "workers/api/src/routes/public.ts")).toBeUndefined();
  });
});
