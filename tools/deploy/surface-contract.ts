import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWranglerToml, targetFromWrangler, type WranglerDoc } from "./preflight.js";
import { EVIDENCE_EXIT } from "../release/evidence.js";
import { repoRoot } from "../checks/repo-root.js";

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
//  4. A SECOND, UNAUDITED ORIGIN. `workers_dev = false` is argued in all three configs — one known
//     hostname for the board, no extra surface on the unauthenticated status page, one origin for the
//     installed PWA. Argued and unchecked is how it gets deleted.

export const SURFACES = [
  { app: "command", config: `${repoRoot()}/apps/command/wrangler.toml`, worker: "shuddl-command-prod", hosts: ["command.shuddl.tech"] },
  { app: "portal", config: `${repoRoot()}/apps/portal/wrangler.toml`, worker: "shuddl-portal-prod", hosts: ["portal.shuddl.tech", "track.shuddl.tech"] },
  { app: "driver", config: `${repoRoot()}/apps/driver/wrangler.toml`, worker: "shuddl-driver-prod", hosts: ["driver.shuddl.tech"] },
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

/** The value `wrangler deploy --env <env>` would actually use for an INHERITABLE key.
 *
 * Wrangler resolves inheritable keys as `env[key] ?? root[key] ?? <wrangler's default>` — its own
 * `inheritable()` helper, verified against wrangler 4.107.1's resolver. Two properties of that rule decide
 * the shape of this function, and getting either backwards silently breaks a real config:
 *
 *  - THE ENV VALUE WINS WHEN PRESENT. Reading only the root is the bug this exists to prevent: a
 *    plausible-looking `[env.prod.assets] not_found_handling = "404-page"` ("prod shouldn't mask 404s")
 *    leaves the root table saying `single-page-application`, so a root-only check passes while the deploy
 *    ships 404 handling and every minted status link 404s. Same shape for `[env.prod] main = "…"`.
 *  - THE ROOT VALUE WINS WHEN THE ENV OMITS THE KEY. Reading only prod is the opposite bug, and it would
 *    fail all three configs as committed: each states `[assets]` and `workers_dev` ONCE at the root and
 *    lets prod inherit them. That is the deployed reality — command.shuddl.tech/kpi/foo answers 200
 *    text/html today, which is the inherited SPA fallback doing its job.
 *
 * The env value REPLACES the root value wholesale; wrangler does not merge tables key-by-key, so an
 * `[env.prod.assets]` that omits `directory` really does deploy without one (and is caught here as such).
 * `??` and not `||` deliberately: `workers_dev = false` in the env scope must win over the root, not fall
 * through to it. */
function inherited(doc: WranglerDoc, environment: string, key: string): unknown {
  const envs = (doc.root["env"] ?? {}) as Record<string, unknown>;
  const scope = envs[environment];
  const scoped = typeof scope === "object" && scope !== null ? (scope as Record<string, unknown>)[key] : undefined;
  return scoped ?? doc.root[key];
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
  // Read at the EFFECTIVE scope (see `inherited`) — `assets` and `main` are inheritable, so what prod
  // deploys is the prod override if there is one and the root table otherwise.
  const assets = (inherited(doc, "prod", "assets") ?? {}) as Record<string, unknown>;
  if (assets["directory"] !== "./dist") fail("assets-directory", `effective [assets] directory is ${JSON.stringify(assets["directory"])}, expected "./dist"`);
  if (assets["not_found_handling"] !== "single-page-application") {
    fail("no-spa-fallback", `effective [assets] not_found_handling is ${JSON.stringify(assets["not_found_handling"])}; client-side routes would 404`);
  }
  if (inherited(doc, "prod", "main") !== undefined) fail("assets-only", "declares `main`; these surfaces ship no worker script");
  // A binding is only valid alongside a script, and there is none.
  if (assets["binding"] !== undefined) fail("assets-only", "declares an [assets] binding, which is only valid with a worker script");

  // No second origin. `workers_dev` is inheritable too, so stating it once at the root covers prod — but
  // it must be stated SOMEWHERE and it must resolve to false. Absent everywhere is not "off": wrangler
  // falls back to its own default, which the published config reference gives as `true` while the shipped
  // resolver derives it from the route count — a posture three configs argue for in prose should not rest
  // on which of those two a future wrangler applies.
  const workersDev = inherited(doc, "prod", "workers_dev");
  if (workersDev !== false) {
    fail("workers-dev-enabled", `effective workers_dev is ${JSON.stringify(workersDev)}, expected false — a *.workers.dev origin nobody audits would serve this surface too`);
  }

  return problems;
}

/** Did the BUILD actually bake the expected API base into the emitted bundle?
 *
 * What this proves and what it does not. The surfaces resolve their base as
 * `import.meta.env.VITE_API_BASE ?? <compiled-in default>`, so it is tempting to ALSO assert that the
 * `.example` placeholder is absent from a correct build. That cannot be asserted — but not because the
 * `??` survives minification. It often does not. Whether it survives is simply not uniform across the
 * three surfaces, from source that gives the minifier nothing to distinguish: the three `apiBase()`
 * bodies are character-identical (apps/command/src/lib/api.ts, apps/portal/src/lib/api.ts,
 * apps/driver/src/api/base.ts) and the three vite configs are identical too. The bundles disagree anyway.
 *
 *  - VITE_API_BASE UNSET — vite substitutes `undefined`, esbuild collapses the `??`, and only the
 *    placeholder survives: `const eE="https://api.shuddl.example";function jm(){return eE.replace(…)}`.
 *    Every surface behaves this way; it is the shape the "not baked" fixture in the tests models.
 *  - VITE_API_BASE SET — the fold is a coin toss per bundle. The three bundles this branch DEPLOYED:
 *      driver   `function jm(){return"https://api.shuddl.tech".replace(…)}` — folded, and
 *               `api.shuddl.example` appears NOWHERE in the bundle
 *      command  `const ez="https://api.shuddl.example";function tz(){return("https://api.shuddl.tech"??ez)…`
 *      portal   the same shape as command, placeholder kept
 *    Reproducible from this tree: the same `vite build` with and without the variable reproduces both.
 *
 * So placeholder-presence tracks how a chunk happened to be laid out, not whether the deploy is correct,
 * and an assertion in either direction would fail on some surface for an unrelated reason. What DOES
 * separate a correct build from a broken one is whether the expected base reached the bundle at all: no
 * source file mentions the prod API host, so the string is present if and only if VITE_API_BASE was set
 * when vite ran. That is precisely the failure mode worth gating on. */
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
