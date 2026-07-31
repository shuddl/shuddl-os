import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SURFACES, PROD_API_BASE, checkBuiltApiBase, checkSurfaceConfig, isSingleLabelHost } from "./surface-contract.js";

// The three browser surfaces deploy as assets-only Workers. Each failure below is one that produces a
// CLEAN deploy and a broken product — a 200 that can never reach the API, a hostname that fails the TLS
// handshake, a deep link that 404s. Every test here asserts against a config mutated away from the real
// committed one, so a green result means the real file would have caught it.

const real = (app: string): string => readFileSync(SURFACES.find((s) => s.app === app)!.config, "utf8");
const surface = (app: string): (typeof SURFACES)[number] => SURFACES.find((s) => s.app === app)!;
const codes = (app: string, text: string): string[] => checkSurfaceConfig(surface(app), text).map((p) => p.code);

describe("the committed surface configs", () => {
  it("are all clean as committed", () => {
    for (const s of SURFACES) expect(checkSurfaceConfig(s, readFileSync(s.config, "utf8"))).toEqual([]);
  });

  it("serve the public status page from the PORTAL worker, not a fourth surface", () => {
    // track.shuddl.tech is a route inside the portal bundle (apps/portal/src/router.ts). A fourth surface
    // is forbidden outright, so this pins the hostname to the portal worker rather than a new one.
    expect(surface("portal").hosts).toContain("track.shuddl.tech");
    expect(SURFACES).toHaveLength(3);
  });
});

describe("hostnames universal TLS actually covers", () => {
  it("accepts a single label and rejects a second one", () => {
    // *.shuddl.tech matches ONE label. api.staging.shuddl.tech failed the handshake for exactly this
    // reason and had to become api-staging.shuddl.tech.
    expect(isSingleLabelHost("command.shuddl.tech")).toBe(true);
    expect(isSingleLabelHost("command.staging.shuddl.tech")).toBe(false);
    expect(isSingleLabelHost("shuddl.tech")).toBe(false);
    expect(isSingleLabelHost("command.example.com")).toBe(false);
  });

  it("FAILS a config whose hostname gained a second label", () => {
    const text = real("command").replace("command.shuddl.tech", "command.staging.shuddl.tech");
    expect(codes("command", text)).toContain("multi-label-host");
  });
});

describe("a config that looks routed and is not", () => {
  it("FAILS when the route block is spelled in a way the repo's parser cannot read", () => {
    // The real bug this guards: three prod workers once parsed as unrouted because the reader understood
    // only one of wrangler's route spellings. Reading through the SAME parser makes that a failure here.
    const text = real("driver").replace("[[env.prod.routes]]", "[[env.prod.route]]");
    expect(codes("driver", text)).toContain("missing-route");
  });

  it("FAILS when a surface routes a hostname it does not own", () => {
    const text = real("command").replace("command.shuddl.tech", "portal.shuddl.tech");
    expect(codes("command", text)).toContain("unexpected-route");
  });

  it("FAILS when the portal loses the public status hostname", () => {
    const text = real("portal").replace(/\n\[\[env\.prod\.routes\]\]\npattern = "track\.shuddl\.tech"\ncustom_domain = true\n/, "\n");
    expect(codes("portal", text)).toContain("missing-route");
  });
});

describe("assets-only serving", () => {
  it("FAILS without SPA fallback, because every client-side route would 404", () => {
    const text = real("command").replace('not_found_handling = "single-page-application"', 'not_found_handling = "404-page"');
    expect(codes("command", text)).toContain("no-spa-fallback");
  });

  it("FAILS if a surface grows a worker script or an assets binding", () => {
    // Both are invalid for an assets-only Worker; `binding` is only legal alongside a script.
    expect(codes("portal", `main = "src/index.ts"\n${real("portal")}`)).toContain("assets-only");
    expect(codes("portal", real("portal").replace('directory = "./dist"', 'directory = "./dist"\nbinding = "ASSETS"'))).toContain("assets-only");
  });

  it("FAILS on a wrong environment identity", () => {
    expect(codes("driver", real("driver").replace('name = "shuddl-driver-prod"', 'name = "shuddl-driver-staging"'))).toContain("worker-name");
    const wrongVar = real("driver").replace(/\[env\.prod\.vars\]\nENVIRONMENT = "prod"/, '[env.prod.vars]\nENVIRONMENT = "dev"');
    expect(codes("driver", wrongVar)).toContain("environment-identity");
  });
});

describe("the scope wrangler would actually deploy", () => {
  // `assets`, `main` and `workers_dev` are INHERITABLE: `wrangler deploy --env prod` resolves each as
  // `[env.prod].<key> ?? <root>.<key>`, the env value replacing the root one WHOLESALE. Reading only the
  // root would miss a prod override; reading only prod would miss today's configs, which state these keys
  // once at the root and inherit them. The check has to resolve them the same way wrangler does.

  const prodAssets = (app: string, body: string): string => `${real(app)}\n[env.prod.assets]\n${body}\n`;

  it("FAILS when [env.prod.assets] overrides the SPA fallback away", () => {
    // The plausible-looking edit: "prod shouldn't mask 404s". The root table still says
    // single-page-application, so a root-only reader passes it — while the deploy ships 404 handling and
    // every minted track.shuddl.tech/status/:cap link breaks.
    const text = prodAssets("portal", 'directory = "./dist"\nnot_found_handling = "404-page"');
    expect(codes("portal", text)).toContain("no-spa-fallback");
  });

  it("FAILS when [env.prod.assets] overrides the directory", () => {
    const text = prodAssets("command", 'directory = "./public"\nnot_found_handling = "single-page-application"');
    expect(codes("command", text)).toContain("assets-directory");
  });

  it("FAILS when [env.prod.assets] adds a binding to an assets-only worker", () => {
    const text = prodAssets("driver", 'directory = "./dist"\nnot_found_handling = "single-page-application"\nbinding = "ASSETS"');
    expect(codes("driver", text)).toContain("assets-only");
  });

  it("FAILS when [env.prod] grows a worker script the root does not have", () => {
    const text = real("driver").replace('[env.prod]\nname = "shuddl-driver-prod"', '[env.prod]\nname = "shuddl-driver-prod"\nmain = "src/index.ts"');
    expect(codes("driver", text)).toContain("assets-only");
  });

  it("PASSES a config that states [assets] once at the root and inherits it, which is what is committed", () => {
    // The other direction of the same fix: reading prod-only would fail all three real files, none of which
    // declares [env.prod.assets]. Verified against wrangler's own resolver, and live —
    // https://command.shuddl.tech/kpi/foo answers 200 text/html.
    for (const s of SURFACES) expect(readFileSync(s.config, "utf8")).not.toContain("[env.prod.assets]");
    expect(codes("command", real("command"))).toEqual([]);
  });
});

describe("no second, unaudited origin", () => {
  // All three configs argue this key is load-bearing — a dispatcher board reachable at one known hostname,
  // an unauthenticated public status page with no widened attack surface, a PWA that installs against ONE
  // origin. An argued config is one to assert, not assume.

  it("FAILS when nothing in the file turns the workers.dev subdomain off", () => {
    for (const app of ["command", "portal", "driver"]) {
      expect(codes(app, real(app).replaceAll("workers_dev = false", ""))).toContain("workers-dev-enabled");
    }
  });

  it("FAILS when [env.prod] turns the workers.dev subdomain back on", () => {
    // The override direction: the root still says false, and the prod scope wins.
    const text = real("portal").replace('[env.prod]\nname = "shuddl-portal-prod"\nworkers_dev = false', '[env.prod]\nname = "shuddl-portal-prod"\nworkers_dev = true');
    expect(codes("portal", text)).toContain("workers-dev-enabled");
  });

  it("PASSES when only the root states it, because prod INHERITS it", () => {
    // Deleting the prod line leaves a config wrangler still deploys with workers.dev off. Failing it would
    // be the checker encoding a rule the deployment does not have.
    const text = real("driver").replace('[env.prod]\nname = "shuddl-driver-prod"\nworkers_dev = false', '[env.prod]\nname = "shuddl-driver-prod"');
    expect(codes("driver", text)).toEqual([]);
  });
});

describe("the API base actually reaching the bundle", () => {
  // The failure this whole file exists for: VITE_API_BASE is read at BUILD time, and a surface built
  // without it serves its entire chrome over an API host it can never reach. It looks deployed.
  const dist = (contents: string | null): string => {
    const dir = mkdtempSync(join(tmpdir(), "surface-"));
    const assets = join(dir, "assets");
    mkdirSync(assets);
    if (contents !== null) writeFileSync(join(assets, "index-abc123.js"), contents, "utf8");
    return assets;
  };

  it("PASSES when the prod base is present", () => {
    expect(checkBuiltApiBase(dist(`const KE="https://api.shuddl.example";function QE(){return("${PROD_API_BASE}"??KE).replace(/\\/+$/,"")}`), PROD_API_BASE, "command")).toEqual([]);
  });

  it("FAILS when the build fell back to its compiled-in default", () => {
    // The unset shape: esbuild collapses the ?? away entirely and only the placeholder survives.
    const problems = checkBuiltApiBase(dist('const KE="https://api.shuddl.example";function QE(){return KE.replace(/\\/+$/,"")}'), PROD_API_BASE, "command");
    expect(problems.map((p) => p.code)).toEqual(["api-base-not-baked"]);
  });

  it("FAILS when the driver bundle resolves its API to same-origin", () => {
    // The driver's unset shape is `?? ""`, which under SPA fallback makes GET /v1/* return 200 + the HTML
    // shell — which its service worker would then cache-first on a phone, surviving redeploys.
    expect(checkBuiltApiBase(dist('function qm(){try{return sE?.VITE_API_BASE??""}catch{return""}}'), PROD_API_BASE, "driver").map((p) => p.code)).toEqual(["api-base-not-baked"]);
  });

  it("FAILS on an absent or empty build rather than passing vacuously", () => {
    expect(checkBuiltApiBase(join(tmpdir(), "surface-does-not-exist-xyz"), PROD_API_BASE, "portal").map((p) => p.code)).toEqual(["no-build"]);
    expect(checkBuiltApiBase(dist(null), PROD_API_BASE, "portal").map((p) => p.code)).toEqual(["no-build"]);
  });
});
