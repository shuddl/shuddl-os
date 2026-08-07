import { globSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";

// BUNDLE RATCHET (REQ-079, audit §481) — the shipped JS may not grow silently.
//
// Vite already warns ("Some chunks are larger than 500 kB after minification") on TWO of the three surfaces,
// and nothing reads it: the line scrolls past in CI and no budget exists anywhere in the repo. `apps/command`
// and `apps/portal` sit at ~1.39–1.41 MB raw / ~385 kB gzip; `apps/driver` at 316 kB / 96 kB. The split is
// not accidental — the two large ones depend on `@shuddl/map` (MapLibre GL) and the driver does not.
//
// THIS IS A RATCHET, NOT A BUDGET. It does not claim 1.4 MB is acceptable — that is a product call, and
// §470's rule is that product calls belong to the owner. It claims only that the number must not grow
// unnoticed, which is the same discipline the citation ratchet applies to rotting links: a frozen baseline
// that may FALL freely and may not RISE without someone editing this file and saying why.
//
// GZIP is the ratcheted figure. Raw size moves with minifier releases and comment volume; gzip is what a
// driver on a bad connection actually waits for, and it is the number the airplane-mode soak cares about.
const HEADROOM = 1.05; // 5% — absorbs minifier/dependency patch noise without hiding a real regression

const BASELINE_GZIP: Readonly<Record<string, number>> = {
  command: 389_087,
  driver: 95_598,
  portal: 384_213,
};

export interface BundleReading {
  app: string;
  gzip: number;
  baseline: number;
  ceiling: number;
}

export function readBundles(cwd: string = process.cwd()): BundleReading[] {
  const out: BundleReading[] = [];
  for (const [app, baseline] of Object.entries(BASELINE_GZIP)) {
    const files = globSync(`apps/${app}/dist/assets/*.js`, { cwd });
    if (files.length === 0) continue; // not built — the caller decides whether that is a failure
    const largest = files
      .map((f) => ({ f, size: statSync(`${cwd}/${f}`).size }))
      .sort((a, b) => b.size - a.size)[0]!;
    out.push({
      app,
      gzip: gzipSync(readFileSync(`${cwd}/${largest.f}`)).byteLength,
      baseline,
      ceiling: Math.round(baseline * HEADROOM),
    });
  }
  return out;
}

export function checkBundleRatchet(readings: readonly BundleReading[]): string[] {
  const violations: string[] = [];
  // NON-VACUITY (§466/§467): a ratchet that reads no bundles reports clean. Every declared app must be built.
  const seen = new Set(readings.map((r) => r.app));
  for (const app of Object.keys(BASELINE_GZIP)) {
    if (!seen.has(app)) {
      violations.push(`apps/${app}: no built bundle found — run \`pnpm -r build\` first. A ratchet that reads nothing reports clean (audit §481).`);
    }
  }
  for (const r of readings) {
    if (r.gzip > r.ceiling) {
      violations.push(
        `apps/${r.app}: gzipped bundle ${r.gzip} B exceeds the ratchet ceiling ${r.ceiling} B (baseline ${r.baseline} B + 5%). ` +
          `The shipped JS grew. Either shrink it, or raise the baseline in tools/checks/bundle-ratchet.ts and say why (audit §481).`,
      );
    }
  }
  return violations;
}

function main(): void {
  const readings = readBundles();
  const violations = checkBundleRatchet(readings);
  if (violations.length > 0) {
    for (const v of violations) console.error(`FAIL ${v}`);
    process.exit(1);
  }
  const summary = readings.map((r) => `${r.app} ${Math.round(r.gzip / 1024)}kB`).join(" · ");
  console.log(`bundle-ratchet OK — ${summary} (gzip, each within 5% of its frozen baseline)`);
}

if (process.argv[1]?.endsWith("bundle-ratchet.ts")) main();
