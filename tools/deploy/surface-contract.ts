import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWranglerToml, targetFromWrangler } from "./preflight.js";
import { EVIDENCE_EXIT } from "../release/evidence.js";

// THE SURFACE DEPLOY CONTRACT.
//
// The three browser surfaces are static bundles served by assets-only Workers. They bind nothing and
// enforce nothing — every gate that matters runs in the api worker (REQ-030). So the preflight, which
// exists to prove a worker's BINDINGS are provisioned, has nothing to say about them: they are deliberately
// NOT in WORKER_CONFIGS, whose members must also declare matching staging+prod binding sets
// (tools/deploy/wrangler-scope-parity.test.ts). Forcing surfaces into that list would weaken a real test.
//
// What can still go wrong is narrower, and this file covers exactly that:
//
//  1. THE API BASE FAILS TO BAKE IN. The surfaces read `VITE_API_BASE` at BUILD time. Miss it and the
//     bundle keeps its compiled-in default — a surface that serves a 200, renders its whole chrome, and
//     can never reach an API. It looks deployed. This is the failure this file exists for.
//  2. A CONFIG THAT LOOKS ROUTED AND IS NOT. Wrangler accepts several route spellings and a preflight bug
//     once read all three prod workers as unrouted because it understood only one of them. A hostname
//     typo'd into a second label (`command.staging.shuddl.tech`) is worse than a typo: universal TLS
//     covers `*.shuddl.tech` but NOT a second label, so it deploys clean and fails the TLS handshake.
//  3. SPA FALLBACK MISSING. Each surface has client-side routes with no file behind them.

export const SURFACES = [
  { app: "command", config: "apps/command/wrangler.toml", worker: "shuddl-command-prod", hosts: ["command.shuddl.tech"] },
  { app: "portal", config: "apps/portal/wrangler.toml", worker: "shuddl-portal-prod", hosts: ["portal.shuddl.tech", "track.shuddl.tech"] },
  { app: "driver", config: "apps/driver/wrangler.toml", worker: "shuddl-driver-prod", hosts: ["driver.shuddl.tech"] },
] as const;

export const PROD_API_BASE = "https://api.shuddl.tech";

export type SurfaceProblem = { code: string; surface: string; detail: string };

/** A hostname universal TLS actually covers. `*.shuddl.tech` matches ONE label, never two — the reason
 * api.staging.shuddl.tech had to become api-staging.shuddl.tech. */
export function isSingleLabelHost(host: string, zone = "shuddl.tech"): boolean {
  if (!host.endsWith(`.${zone}`)) return false;
  const label = host.slice(0, -(zone.length + 1));
  return label.length > 0 && !label.includes(".");
}

/** Check ONE surface's committed config. Pure: the caller supplies the TOML text. */
export function checkSurfaceConfig(surface: (typeof SURFACES)[number], text: string): SurfaceProblem[] {
  const problems: SurfaceProblem[] = [];
  const fail = (code: string, detail: string): void => void problems.push({ code, surface: surface.app, detail });

  const doc = parseWranglerToml(text);
  const target = targetFromWrangler(doc, "prod");

  if (target.worker !== surface.worker) {
    fail("worker-name", `[env.prod] name is ${JSON.stringify(target.worker)}, expected ${JSON.stringify(surface.worker)}`);
  }
  if (target.vars["ENVIRONMENT"] !== "prod") {
    fail("environment-identity", `[env.prod.vars] ENVIRONMENT is ${JSON.stringify(target.vars["ENVIRONMENT"])}, expected "prod"`);
  }

  // Routes, read through the SAME parser the preflight uses — so a spelling this repo's tooling cannot see
  // is a failure here rather than a silent unrouted deploy.
  const routed = new Set(target.routes.map((r) => r.replace(/\/\*$/, "")));
  for (const host of surface.hosts) {
    if (!routed.has(host)) fail("missing-route", `no [[env.prod.routes]] resolves to ${host} (parsed: ${[...routed].join(", ") || "none"})`);
  }
  for (const r of routed) {
    // `surface` is a UNION of the three SURFACES members, so `surface.hosts` is a union of readonly tuples
    // and `.includes` resolves its parameter to the INTERSECTION of their element types — `never`. Widened
    // to `readonly string[]` (the check is a membership test on strings; nothing depends on the literals).
    if (!(surface.hosts as readonly string[]).includes(r)) fail("unexpected-route", `${r} is routed but not declared for this surface`);
    // Checked against what the config ACTUALLY routes, not against the expected list — the expected hosts
    // are constants in this file and are single-label by construction, so checking those would be a test
    // of nothing. The hostname that can carry a second label is the one somebody typed into the TOML.
    if (!isSingleLabelHost(r)) fail("multi-label-host", `${r} is not covered by universal TLS for *.shuddl.tech — it would deploy clean and fail the handshake`);
  }

  // Assets: an assets-only Worker must omit `main`, and MUST answer unmatched paths with the SPA shell.
  const assets = (doc.root["assets"] ?? {}) as Record<string, unknown>;
  if (assets["directory"] !== "./dist") fail("assets-directory", `[assets] directory is ${JSON.stringify(assets["directory"])}, expected "./dist"`);
  if (assets["not_found_handling"] !== "single-page-application") {
    fail("no-spa-fallback", `[assets] not_found_handling is ${JSON.stringify(assets["not_found_handling"])}; client-side routes would 404`);
  }
  if (doc.root["main"] !== undefined) fail("assets-only", "declares `main`; these surfaces ship no worker script");
  // A binding is only valid alongside a script, and there is none.
  if (assets["binding"] !== undefined) fail("assets-only", "declares an [assets] binding, which is only valid with a worker script");

  return problems;
}

/** Did the BUILD actually bake the expected API base into the emitted bundle?
 *
 * What this proves and what it does not. The surfaces resolve their base as
 * `import.meta.env.VITE_API_BASE ?? <compiled-in default>`, and esbuild does NOT fold that `??` — so a
 * CORRECT build still contains the default literal, and "the placeholder is absent" is not an assertion
 * that can ever hold. What separates a correct build from a broken one is simply whether the expected base
 * reached the bundle at all: no source file mentions the prod API host, so the string is present if and
 * only if VITE_API_BASE was set when vite ran. That is precisely the failure mode worth gating on. */
export function checkBuiltApiBase(assetsDir: string, expected: string, app: string): SurfaceProblem[] {
  let files: string[];
  try {
    files = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
  } catch {
    return [{ code: "no-build", surface: app, detail: `${assetsDir} does not exist — build before deploying` }];
  }
  if (files.length === 0) return [{ code: "no-build", surface: app, detail: `${assetsDir} contains no .js bundle` }];

  const found = files.some((f) => readFileSync(join(assetsDir, f), "utf8").includes(expected));
  return found
    ? []
    : [{
        code: "api-base-not-baked",
        surface: app,
        detail: `no bundle in ${assetsDir} contains ${expected} — VITE_API_BASE was not set when vite ran, so this surface would serve a page that can never reach the API`,
      }];
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────
// `pnpm check:surfaces` validates the committed configs alone (no build required).
// `pnpm check:surfaces -- --built` additionally requires each dist/ to carry the prod API base, which is
// what the deploy script runs — so a surface cannot reach the internet pointing at nothing.

function main(): void {
  const requireBuilt = process.argv.slice(2).includes("--built");
  const problems: SurfaceProblem[] = [];

  for (const surface of SURFACES) {
    try {
      problems.push(...checkSurfaceConfig(surface, readFileSync(surface.config, "utf8")));
    } catch (e) {
      problems.push({ code: "unreadable-config", surface: surface.app, detail: `${surface.config}: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    if (requireBuilt) problems.push(...checkBuiltApiBase(join("apps", surface.app, "dist", "assets"), PROD_API_BASE, surface.app));
  }

  const scope = requireBuilt ? "config + built bundle" : "config";
  console.log(`surface-contract: surfaces=${SURFACES.length} scope=${scope} problems=${problems.length}`);
  for (const p of problems) console.log(`  FAIL  ${p.code.padEnd(22)} ${p.surface} — ${p.detail}`);

  if (problems.length > 0) {
    console.error(`\nsurface-contract: FAIL — ${problems.length} problem(s). A surface in this state deploys clean and does not work.`);
    process.exit(EVIDENCE_EXIT.ASSERTIONS_FAILED);
  }
  console.log("\nsurface-contract: PASS — every surface is routed on a TLS-covered hostname, falls back to its SPA shell, and carries the prod API base.");
}

if (process.argv[1] !== undefined && /surface-contract\.ts$/.test(process.argv[1])) main();
