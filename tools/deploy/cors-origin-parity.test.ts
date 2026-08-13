import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "../checks/repo-root.js";

// §1245 (REQ-154/156) — EVERY DEPLOYED BROWSER ORIGIN IS IN THE CORS ALLOWLIST.
//
// `CORS_ALLOWED_ORIGINS` and the app workers' `custom_domain` routes are two copies of one fact — *which
// hostnames a browser loads a SHUDDL surface from* — and until this gate they were bound by nothing but prose.
// §1226's rule: duplicated claims are debt exactly when no mechanism would notice them diverging.
//
// THE DANGEROUS DIRECTION IS ONE-WAY. A deployed origin MISSING from the allowlist is a surface that boots and
// then fails every API read in the browser, with a CORS error that names no cause. The reverse — an allowlisted
// origin with no deployment — is harmless and DELIBERATE here: the list keeps two RFC 2606 `.example`
// placeholders the design/screenshot harness asserts against, plus localhost. So this gate is an INCLUSION
// check, never an equality one; asserting equality would fail on the placeholders and be deleted.
//
// MEASURED at §1245: the four deployed origins (command, driver, portal, and `track`, a SECOND custom domain on
// the portal worker for the public status page) are all present. The gate exists for the fifth surface, not for
// a defect today.
//
// SOURCE IS READ, NOT IMPORTED. `cors.ts` is worker code; importing it into a node-environment tools test drags
// in the hono types and the middleware's whole module graph. Both sides are parsed as text, which is the same
// choice §728 made for the vitest include globs and for the same reason — the artifact under test is the file.

/** Prod browser hostnames: a `pattern` that is bound as a `custom_domain` in an app worker's config. */
function deployedBrowserHosts(root: string): { file: string; host: string }[] {
  const files = execSync('git ls-files "apps/*/wrangler.toml"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f !== "");
  const out: { file: string; host: string }[] = [];
  for (const f of files) {
    const lines = readFileSync(`${root}/${f}`, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.trim().startsWith("#")) return;
      const m = /^\s*pattern\s*=\s*"([^"]+)"/.exec(line);
      if (m === null) return;
      // `custom_domain = true` sits directly beneath its pattern in every app config; a route pattern WITHOUT
      // it is a path route (e.g. `api.example/*`), not a browser origin, so it is not this gate's subject.
      const near = lines.slice(i, i + 3).join("\n");
      if (!/custom_domain\s*=\s*true/.test(near)) return;
      out.push({ file: f, host: m[1]!.replace(/\/\*$/, "") });
    });
  }
  return out;
}

/** The allowlist, parsed out of the middleware source as literals. */
function allowedOrigins(root: string): string[] {
  const src = readFileSync(`${root}/workers/api/src/middleware/cors.ts`, "utf8");
  const m = /CORS_ALLOWED_ORIGINS[^=]*=\s*\[([\s\S]*?)\]/.exec(src);
  if (m === null) throw new Error("CORS_ALLOWED_ORIGINS array not found in cors.ts — this gate's parser is stale, not the tree");
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

describe("§1245 REQ-154/156: every deployed browser origin is CORS-allowed", () => {
  const root = repoRoot();
  const hosts = deployedBrowserHosts(root);
  const origins = allowedOrigins(root);

  it("finds both corpora (non-vacuity — an empty side would make every assertion below hold)", () => {
    expect(hosts.length, "no custom_domain app routes found — the toml parser is broken, not the tree").toBeGreaterThanOrEqual(3);
    expect(origins.length, "no origins parsed from cors.ts — the allowlist parser is broken").toBeGreaterThanOrEqual(4);
  });

  it("every custom_domain host has an https origin in the allowlist", () => {
    const missing = hosts.filter((h) => !origins.includes(`https://${h.host}`)).map((h) => `${h.host}  (${h.file})`);
    expect(
      missing,
      "deployed browser origin(s) NOT in CORS_ALLOWED_ORIGINS — the surface will load and then fail every API " +
        "read with a CORS error that names no cause:\n  " +
        missing.join("\n  ") +
        "\n\nAdd `https://<host>` to workers/api/src/middleware/cors.ts.",
    ).toEqual([]);
  });

  it("the allowlist carries no wildcard — the middleware's own claim, pinned", () => {
    // cors.ts states "There is no wildcard fallback." A `*` here would silently make every check above moot.
    expect(origins.filter((o) => o.includes("*")), "a wildcard origin defeats the allowlist entirely").toEqual([]);
  });

  it("the parser reads the REAL hosts, not a shape that would match anything (positive control)", () => {
    // Guards the inclusion check from passing because `deployedBrowserHosts` returned something meaningless:
    // every host must be a bare hostname, and the set must contain the three surfaces doc 00 names.
    expect(hosts.every((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h.host)), `parsed a non-hostname: ${hosts.map((h) => h.host).join(", ")}`).toBe(true);
    for (const surface of ["command", "driver", "portal"]) {
      expect(
        hosts.some((h) => h.host.startsWith(`${surface}.`)),
        `no custom_domain route found for the ${surface} surface — either it lost its route or this parser did`,
      ).toBe(true);
    }
  });
});
