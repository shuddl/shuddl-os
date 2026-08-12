import { describe, expect, it } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { EXPECTED_EMPTY_GLOBS, SOURCE_SCAN_GLOBS, isTestPath, stripComments } from "./source-corpus.js";
import { repoRoot } from "./repo-root.js";

// §1147 (REQ-025) — THE TENANT COMES FROM THE CLAIM, AND NOW SOMETHING CHECKS IT.
//
// CLAUDE.md rule 8: "a cross-tenant read anywhere is a build failure". Every tenant-scoped D1 handle in this
// build comes from `resolveTenantDb(env, <tenant>)`, so that argument is the single place a tenant can be
// chosen — and §1135 verified by READING that all of them take it from a JWT claim, a MAC-verified capability,
// or a server-side roster. Nothing enforced it.
//
// WHY A READING WAS NOT ENOUGH (audit §1144). §1135's probe was `git grep resolveTenantDb | grep -v
// "session.tenant"`. A violation was planted in the shape one actually arrives in — a client override with the
// claim as FALLBACK:
//
//     resolveTenantDb(c.env, c.req.header("X-Tenant") ?? session.tenant)
//
// and the probe FILTERED IT OUT AS SAFE, because the malicious line contains the safe token. A negative filter
// is defeated by any line carrying both tokens, and `??` / `||` / a ternary are all that shape. The conclusion
// survived re-derivation; the method did not. This file is the method's replacement, and it POSITIVE-MATCHES
// THE DANGER rather than subtracting the safe.
//
// THE RULE: the tenant argument may not contain a request-derived value. The legitimate forms measured at
// §1144 are `session.tenant` (31), a cron roster `slug` (12), `c.get("session").tenant` (2), a MAC-verified
// `claims.t` (1), a queue `trigger.tenant` (1, static-allowlist resolved) and the DO's own pinned `tenant` (1).
// None of them reads the request, which is what makes the danger side enumerable and the safe side irrelevant.
//
// The test below plants the violation ITSELF (`SENSITIVITY_PROBE`) so this gate can never become the thing it
// was written to replace: a check that reads every file and could not fire.

/** Request-derived sources. A tenant may never come from one — REQ-025. */
const CLIENT_INPUT = /\b(?:c\.req\.(?:header|query|param|json|valid)|req\.(?:header|query|params|body)|searchParams\.get|body\.tenant|params\.tenant)\b/;

/** Every `resolveTenantDb(...)` call's argument list, with comments stripped so a discussion cannot trip it. */
export function tenantCallArgs(source: string): string[] {
  const out: string[] = [];
  const re = /resolveTenantDb\s*\(/g;
  const src = stripComments(source);
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    // Walk to the matching close paren so a nested call (`?? f(x)`) is captured whole rather than truncated.
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i += 1) {
      if (src[i] === "(") depth += 1;
      else if (src[i] === ")") depth -= 1;
    }
    out.push(src.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

/** Call sites whose argument list reads the request. Empty is the only acceptable answer. */
export function clientSourcedTenants(files: readonly { path: string; text: string }[]): string[] {
  const bad: string[] = [];
  for (const f of files) {
    for (const args of tenantCallArgs(f.text)) {
      if (CLIENT_INPUT.test(args)) bad.push(`${f.path}: resolveTenantDb(${args.trim().slice(0, 90)})`);
    }
  }
  return bad;
}

function corpus(): { path: string; text: string }[] {
  const root = repoRoot();
  const files: { path: string; text: string }[] = [];
  for (const g of SOURCE_SCAN_GLOBS) {
    const hits = globSync(g, { cwd: root }).filter((p) => !isTestPath(p));
    if (hits.length === 0 && !EXPECTED_EMPTY_GLOBS.has(g)) {
      throw new Error(`tenant-source: glob matched ZERO files — ${g} (a broken pattern reads as a clean scan)`);
    }
    for (const p of hits) files.push({ path: p, text: readFileSync(`${root}/${p}`, "utf8") });
  }
  return files;
}

describe("§1147 REQ-025: the tenant is never taken from client input", () => {
  const files = corpus();
  const callSites = files.flatMap((f) => tenantCallArgs(f.text));

  it("finds the resolveTenantDb corpus at all (non-vacuity — §968's rule)", () => {
    // Measured 43+ call sites at §1144. A floor well under that catches a broken scan without pinning a
    // number that ordinary growth would falsify.
    expect(callSites.length, "no resolveTenantDb call sites found — the scan is broken, not the code").toBeGreaterThan(25);
  });

  it("SENSITIVITY: the detector fires on the exact shape that defeated §1135's filter", () => {
    // The whole reason this file exists. `?? session.tenant` makes the line contain the SAFE token, which is
    // what a `grep -v` reads. A positive match on the danger is immune to that.
    const planted = [{ path: "planted.ts", text: 'const db = await resolveTenantDb(c.env, c.req.header("X-Tenant") ?? session.tenant);' }];
    expect(clientSourcedTenants(planted)).toHaveLength(1);
  });

  it("SENSITIVITY: it also fires on a query param and a body field", () => {
    const planted = [
      { path: "a.ts", text: "resolveTenantDb(c.env, c.req.query(\"tenant\"))" },
      { path: "b.ts", text: "resolveTenantDb(env, body.tenant)" },
    ];
    expect(clientSourcedTenants(planted)).toHaveLength(2);
  });

  it("does NOT fire on the six legitimate forms (the rule has a boundary)", () => {
    const ok = [
      { path: "ok.ts", text: [
        "resolveTenantDb(c.env, session.tenant)",
        'resolveTenantDb(c.env, c.get("session").tenant)',
        "resolveTenantDb(env, slug)",
        "resolveTenantDb(c.env, claims.t)",
        "resolveTenantDb(env, trigger.tenant)",
        "resolveTenantDb(this.env, tenant)",
      ].join("\n") },
    ];
    expect(clientSourcedTenants(ok)).toEqual([]);
  });

  it("a discussion of the violation in a COMMENT does not trip it", () => {
    const commented = [{ path: "c.ts", text: '// never write resolveTenantDb(c.env, c.req.header("X-Tenant"))\nresolveTenantDb(c.env, session.tenant);' }];
    expect(clientSourcedTenants(commented)).toEqual([]);
  });

  it("no production call site takes its tenant from the request", () => {
    expect(clientSourcedTenants(files)).toEqual([]);
  });
});
