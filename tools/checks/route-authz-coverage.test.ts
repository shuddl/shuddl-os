import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { stripComments } from "./source-corpus.js";

// §927 — EVERY AUTHENTICATED ROUTE IS AUTHORIZED BY *SOMETHING*, AND THAT SOMETHING IS NAMED.
//
// CLAUDE.md rule 3: gates are server-side, and any flow reachable by API must enforce the same gate
// (REQ-030). §84 swept the 403 GUARDS that exist — 18 of them, one real hole — by neutralising each and
// running the full api suite. A guard sweep is the right instrument for a guard, and it is structurally
// unable to answer the prior question: **is there a guard at all?**
//
// MEASURED AT §927: 40 `/v1` route registrations. 31 carry `requireRole` inline. The other 9 do NOT, and
// eight of those are CORRECT — reads in this system are authorized by the LENS (`lensFor`/`lensWhere`),
// not by role, which is what lets a portal session read its own party's rows through the same endpoint an
// ops session reads tenant-wide. The ninth is `/v1/health`, which returns no tenant data at all.
//
// So there is no defect here. What there is: **nothing makes the next route choose.** A registration added
// with neither a role gate nor a lens serves whatever the handler queries to any authenticated session —
// and the principal that hurts is `portal`, whose whole containment is the lens. That is the §265 shape:
// a decision made once per route, with no mechanism requiring it to be made again.
//
// THE SPLIT IS DELIBERATE. Role-guarded routes are DERIVED (the registration says `requireRole`, so no row
// can go stale). Everything else must be DECLARED with the mechanism that authorizes it. A row is a
// decision; its absence is what this gate exists to make impossible.
//
// WHAT A GREEN HERE DOES NOT MEAN. It does not prove the named mechanism is correctly applied — a handler
// could resolve a lens and then ignore it. §84's mutation sweep is what proves a guard bites; this proves
// one was chosen. Two questions, two instruments, and this repo has repeatedly found the gap between them.

const API_SRC = "workers/api/src";
const ROUTE = /\bapp\.(get|post|put|patch|delete)\(\s*"([^"]+)"(.*)$/;

interface Route {
  file: string;
  line: number;
  method: string;
  path: string;
  /** `requireRole` appears in the registration itself — derived, never declared. */
  roleGuarded: boolean;
}

function routes(root: string): Route[] {
  const files = execSync(`git ls-files ${API_SRC}`, { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".ts") && !f.includes(".test."));
  const out: Route[] = [];
  for (const f of files) {
    const lines = stripComments(readFileSync(`${root}/${f}`, "utf8")).split("\n");
    lines.forEach((raw, i) => {
      const m = ROUTE.exec(raw.trim());
      if (m === null) return;
      const path = m[2] as string;
      if (!path.startsWith("/v1") && !path.startsWith("/pub") && !path.startsWith("/internal")) return;
      const registration = `${m[3] ?? ""} ${lines[i + 1] ?? ""}`;
      out.push({
        file: f,
        line: i + 1,
        method: (m[1] as string).toUpperCase(),
        path,
        roleGuarded: registration.includes("requireRole") || raw.includes("requireRole"),
      });
    });
  }
  return out;
}

/**
 * Every `/v1` route NOT guarded by an inline `requireRole`, and the mechanism that authorizes it instead.
 * Measured at §927. Keyed by method+path rather than line number — a registration moves, its authorization
 * does not (§913's anchor lesson).
 */
const NON_ROLE_AUTHZ: Record<string, string> = {
  "GET /v1/health": "PUBLIC PROBE — returns no tenant data. The only row here that authorizes nothing, and it is allowed to because it reads nothing.",
  "GET /v1/whoami": "LENS — echoes the caller's own session claims; there is no other party's data to reach.",
  "POST /v1/_echo": "LENS — diagnostic echo of the caller's own body under their own session.",
  "GET /v1/anchors/:day": "TENANT SCOPE — reads anchors/<session.tenant>/… through readAnchorManifest, which tenant-scope.test.ts guards at every call site.",
  "GET /v1/anchors/:day/proof": "TENANT SCOPE — same builder, same guard.",
  "GET /v1/shipments/:id/documents": "LENS — documents are filtered by the caller's resolved lens (documentVisibilityFor, REQ-085).",
  "GET /v1/documents/:id/url": "LENS — resolves the lens before minting a cap whose tenant is session.tenant alone (§921 pins the cap's confinement).",
  "GET /v1/shipments/:id/events": "LENS — readEvents applies lensWhere; this is the canonical lens read (REQ-015/I6).",
  "GET /v1/invoices": "LENS — the money read is lens-scoped; a portal session sees only its own party's invoices.",
};

/**
 * The UNAUTHENTICATED surface. `/pub/*` sits outside `auth`, so neither role nor lens applies and the rule
 * above cannot judge it — but the membership question matters MORE here, not less: these routes answer
 * before any identity exists.
 *
 * CORRECTED AT §927: this file first excluded `/pub` on the stated grounds that it "is capability-gated".
 * That is false for HALF of it — `/pub/quote` and `/pub/signup` carry no capability at all and are
 * deliberately public (acceptance demo #2, *a stranger signs up and quotes in under ten minutes*). The
 * exclusion was right; the reason I wrote for it was not, which is exactly the kind of comment that reads
 * as a decision and is really a guess.
 */
const PUB_AUTHZ: Record<string, string> = {
  "GET /pub/documents/:cap": "CAPABILITY — a MAC'd cap carrying {t,k}; the route additionally confines k to evidence/<t>/ (§921 pins that confinement).",
  "GET /pub/status/:cap": "CAPABILITY — a MAC'd status cap scoped to one shipment; verifyStatusCap is round-trip tested with each claim varied.",
  "POST /pub/quote": "DELIBERATELY PUBLIC — acceptance demo #2 (a stranger quotes). No identity exists yet; the rating path is server-side and the response carries no tenant data.",
  "POST /pub/signup": "DELIBERATELY PUBLIC — acceptance demo #2 (a stranger signs up). Creates the identity the rest of the system authorizes against.",
};

/**
 * The SERVER-TO-SERVER surface, and the third mechanism — a shared secret. Found only because this file's
 * own `/pub` exclusion was checked: `/internal/*` sits outside `app.use("/v1/*", auth)` exactly as `/pub`
 * does, so a gate scoped to `/v1` + `/pub` misses it entirely. That is the corpus gap §925 found in
 * `tenant-scope.test.ts`, reproduced here by me, one phase later, in the gate written to close it.
 *
 * It matters more than its size: these two routes are the ONLY door to the reserved `_platform` revenue
 * tenant. The sequencer resolves `_platform` solely when an append carries `platform: true`, and that flag
 * is set only here.
 */
const INTERNAL_AUTHZ: Record<string, string> = {
  "POST /internal/platform/credit-append": "SHARED SECRET — X-Platform-Internal, constant-time compared; 503 when PLATFORM_INTERNAL_SECRET is unbound (DARK), 403 on mismatch, with no oracle between them.",
  "POST /internal/platform/credit-settle": "SHARED SECRET — same gate, same fail-closed posture.",
};

describe("§927: every /v1 route is authorized by a named mechanism", () => {
  const root = repoRoot();
  const all = routes(root);

  it("the scan finds a real population (non-vacuity — an empty scan authorizes nothing)", () => {
    // A changed registration style or a moved src layout yields [] and every assertion below passes over
    // nothing — the failure this repo met in four gates (§487/§554/§572). Floor well under the 40 measured.
    expect(all.length, `no /v1 route registrations found under ${API_SRC} — the scan is broken, not the router`).toBeGreaterThanOrEqual(30);
    expect(all.filter((r) => r.roleGuarded).length, "no route appears role-guarded — the requireRole detection broke").toBeGreaterThanOrEqual(20);
    expect(all.filter((r) => r.path.startsWith("/pub")).length, "no /pub route found — the unauthenticated surface scan broke").toBeGreaterThanOrEqual(3);
    expect(all.filter((r) => r.path.startsWith("/internal")).length, "no /internal route found — the server-to-server surface scan broke").toBeGreaterThanOrEqual(2);
  });

  it("every route without an inline requireRole declares what authorizes it instead", () => {
    const undeclared = all
      .filter((r) => r.path.startsWith("/v1"))
      .filter((r) => !r.roleGuarded)
      .filter((r) => !(`${r.method} ${r.path}` in NON_ROLE_AUTHZ))
      .map((r) => `${r.method} ${r.path}  (${r.file}:${r.line})`);
    expect(
      undeclared,
      "a /v1 route carries neither an inline `requireRole` nor a declared authorization mechanism. Reads in " +
        "this system are authorized by the LENS rather than by role, which is legitimate — but a route with " +
        "NEITHER serves whatever its handler queries to any authenticated session, and the principal that " +
        "hurts is `portal`, whose entire containment is the lens. Add `requireRole`, or add a row naming the " +
        "mechanism (lens / tenant scope / public probe) and why it suffices:\n  " + undeclared.join("\n  "),
    ).toEqual([]);
  });

  it("every /pub route declares why it may answer without a session", () => {
    // The unauthenticated surface. A new /pub route is the highest-stakes registration in the repo: it is
    // reachable by anyone, so "nobody chose" is not a survivable default.
    const undeclared = all
      .filter((r) => r.path.startsWith("/pub"))
      .filter((r) => !(`${r.method} ${r.path}` in PUB_AUTHZ))
      .map((r) => `${r.method} ${r.path}  (${r.file}:${r.line})`);
    expect(
      undeclared,
      "a /pub route answers without any session and nothing says why that is safe. Two shapes are legitimate " +
        "and they are NOT interchangeable: a CAPABILITY (a MAC'd token carrying its own scope) or a " +
        "DELIBERATELY PUBLIC endpoint whose response carries no tenant data. Name which, and what bounds it:\n  " +
        undeclared.join("\n  "),
    ).toEqual([]);
  });

  it("every /internal route declares its server-to-server gate", () => {
    const undeclared = all
      .filter((r) => r.path.startsWith("/internal"))
      .filter((r) => !(`${r.method} ${r.path}` in INTERNAL_AUTHZ))
      .map((r) => `${r.method} ${r.path}  (${r.file}:${r.line})`);
    expect(
      undeclared,
      "an /internal route is reachable without a session and nothing declares what gates it. This surface " +
        "is the only path to the reserved platform tenant, so an ungated addition is the highest-privilege " +
        "hole the router can grow. Name the secret and its fail-closed posture:\n  " + undeclared.join("\n  "),
    ).toEqual([]);
  });

  it("no declared row outlives its route (§672)", () => {
    // A row rots two ways: the route is deleted, or it GAINS a requireRole — at which point the row is no
    // longer what authorizes it and would mask a later removal of the real guard.
    const live = new Set(all.map((r) => `${r.method} ${r.path}`));
    const guarded = new Set(all.filter((r) => r.roleGuarded).map((r) => `${r.method} ${r.path}`));
    const stale = [...Object.keys(NON_ROLE_AUTHZ), ...Object.keys(PUB_AUTHZ), ...Object.keys(INTERNAL_AUTHZ)]
      .filter((k) => !live.has(k) || guarded.has(k))
      .map((k) => (!live.has(k) ? `${k} — route no longer exists` : `${k} — now has requireRole; delete the row`));
    expect(stale, `a NON_ROLE_AUTHZ row no longer describes its route:\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});
