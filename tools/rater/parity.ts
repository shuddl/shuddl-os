import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// `z` and the rate_config schemas both come from @shuddl/contracts — the repo's single zod boundary. tools/
// and non-contracts packages never take a direct zod dependency (see the re-export note in contracts/index).
import {
  z,
  ZoneTariff,
  FloorsConfig,
  FscConfig,
  AccessorialSchedule,
  ClassAdapter,
} from "@shuddl/contracts";
// The rater is consumed by its source module path (not the @shuddl/rater package name): this repo only
// links the workspace packages a tool declares, and root does not depend on @shuddl/rater. Importing
// price.js directly (not the barrel) also avoids pulling the class adapter the barrel re-exports.
import { priceShipment } from "../../packages/rater/src/price.js";
import type { RateRequest, TenantRatingConfig, QuoteResult } from "../../packages/rater/src/price.js";

// REQ-027 ("the 48 legacy tests pass in the service") + REQ-165 ("reproduces tenant-0 quotes exactly").
//
// THE HONEST CONTRACT — the load-bearing point of this file. The audited engine's 48 embedded tests, its
// 504-sweep, and the tenant-0 tariff live in the tenant ENGAGEMENT WORKSPACE, OUTSIDE this repo
// (fixtures/manifest.json lists rater-48-tests / rater-504-sweep / zone-tariff-v1 as status:"pending").
// So REQ-027/REQ-165 CANNOT be closed from inside this repo today. This harness therefore:
//   • runs the real parity gate THE MOMENT those fixtures are vendored (exit 1 on any divergence), and
//   • until then LOUD-SKIPS — prints the pending rows (id + path + source) and exits 0 as advisory.
// It must NEVER print a false green: no "passed", no exit-1 gate, on synthetic or absent data. This mirrors
// tools/fixtures/verify.ts (loud pending, exit 0). The runner below is PURE (no I/O) so it is unit-testable
// against a synthetic stand-in without ever masquerading that stand-in as vendored engagement data.

// ── The pure runner ────────────────────────────────────────────────────────────────────────────────────

// A parity case: a rate request + the audited engine's expected output for it. `.passthrough()` on the
// request keeps any extra keys a vendored case file carries (e.g. a source-line ref) rather than rejecting
// the file — forward-compatible with the real engine's export format; the extras are ignored when the
// request is fed to priceShipment.
const RequestShape = z
  .object({
    origin_zip: z.string(),
    dest_zip: z.string(),
    weight_lb: z.number().int().optional(),
    dims: z
      .object({
        l_in: z.number(),
        w_in: z.number(),
        h_in: z.number(),
        pieces: z.number().int(),
      })
      .nullable()
      .optional(),
    accessorials: z.array(z.string()).optional(),
  })
  .passthrough();

export const ParityCase = z
  .object({
    name: z.string(),
    request: RequestShape,
    expect: z.object({
      status: z.enum(["PRICED", "UNKNOWN"]),
      sell_cents: z.number().int().optional(), // required when PRICED (enforced by the refine below)
      floors: z
        .object({
          contribution: z.number().int(),
          full: z.number().int(),
          target: z.number().int(),
        })
        .optional(),
      reason: z.string().optional(), // when UNKNOWN
    }),
  })
  // A PRICED case with no expected sell_cents is a malformed case, not a pass — reject it at parse time so
  // a hollow "expect" can never silently sail through the comparison as a match.
  .refine((c) => c.expect.status !== "PRICED" || c.expect.sell_cents !== undefined, {
    message: "a PRICED parity case must specify expect.sell_cents",
    path: ["expect", "sell_cents"],
  });
export type ParityCase = z.infer<typeof ParityCase>;

export interface ParityMismatch {
  name: string;
  field: string;
  expected: unknown;
  actual: unknown;
}
export interface ParityResult {
  total: number;
  passed: number;
  mismatches: ParityMismatch[];
}

// Build a clean RateRequest from a parsed case request. Optional fields are spread in ONLY when present so
// no key is ever set to `undefined` — required under the repo's exactOptionalPropertyTypes.
function toRateRequest(r: z.infer<typeof RequestShape>): RateRequest {
  return {
    origin_zip: r.origin_zip,
    dest_zip: r.dest_zip,
    ...(r.weight_lb !== undefined ? { weight_lb: r.weight_lb } : {}),
    ...(r.dims !== undefined ? { dims: r.dims } : {}),
    ...(r.accessorials !== undefined ? { accessorials: r.accessorials } : {}),
  };
}

type PriceFn = (request: RateRequest, config: TenantRatingConfig) => QuoteResult;

/**
 * runParity — the pure comparison. Runs each case through priceShipment(case.request, config) and compares
 * the audited-engine expectation EXACTLY:
 *   • status always;
 *   • when PRICED: sell_cents, and floors (contribution/full/target) when the case specifies them;
 *   • when UNKNOWN: reason when the case specifies it.
 * A status divergence short-circuits the field comparisons (they are not comparable across a status change).
 * `passed` counts cases with zero mismatches. Deterministic, no I/O.
 */
export function runParity(
  cases: readonly ParityCase[],
  config: TenantRatingConfig,
  priceFn: PriceFn = priceShipment,
): ParityResult {
  const mismatches: ParityMismatch[] = [];
  let passed = 0;

  for (const c of cases) {
    const before = mismatches.length;
    const actual = priceFn(toRateRequest(c.request), config);

    if (actual.status !== c.expect.status) {
      // Status diverged — downstream fields are incomparable; record the one decisive mismatch and move on.
      mismatches.push({
        name: c.name,
        field: "status",
        expected: c.expect.status,
        actual: actual.status,
      });
    } else if (actual.status === "PRICED") {
      // Defense-in-depth: runParity is exported. A PRICED expectation with no sell_cents is a MISMATCH, never
      // a status-only pass — the ParityCase.refine rejects it at CLI parse, but a caller constructing cases
      // by hand must not be able to green a hollow expect.
      if (c.expect.sell_cents === undefined) {
        mismatches.push({
          name: c.name,
          field: "sell_cents",
          expected: undefined, // a PRICED case must pin sell_cents; none was given
          actual: actual.sell_cents,
        });
      } else if (actual.sell_cents !== c.expect.sell_cents) {
        mismatches.push({
          name: c.name,
          field: "sell_cents",
          expected: c.expect.sell_cents,
          actual: actual.sell_cents,
        });
      }
      if (c.expect.floors !== undefined) {
        for (const k of ["contribution", "full", "target"] as const) {
          if (actual.floors[k] !== c.expect.floors[k]) {
            mismatches.push({
              name: c.name,
              field: `floors.${k}`,
              expected: c.expect.floors[k],
              actual: actual.floors[k],
            });
          }
        }
      }
    } else if (c.expect.reason !== undefined && actual.reason !== c.expect.reason) {
      // Both UNKNOWN — compare the machine-readable reason when the case pins one.
      mismatches.push({
        name: c.name,
        field: "reason",
        expected: c.expect.reason,
        actual: actual.reason,
      });
    }

    if (mismatches.length === before) passed += 1;
  }

  return { total: cases.length, passed, mismatches };
}

// ── The CLI ────────────────────────────────────────────────────────────────────────────────────────────
// Vendored inputs the parity gate needs (all engagement-workspace fixtures, currently pending):
//   • case dirs: fixtures/rater/48-tests/ + fixtures/rater/504-sweep/ — JSON ParityCase files (one case
//     per file, or an array of cases per file — both accepted).
//   • tenant-0 config: fixtures/tariff/ — one JSON per rate_config kind (zone_tariff/floors/fsc/
//     accessorials required; class_adapter optional). See tools/rater/README.md for the exact layout.

// REQ-027 pins the audited set's SIZE exactly: 48 embedded tests + a 504-quote sweep. A vendored set that is
// short or over is a REAL discrepancy to surface, never to bless — GREEN may print ONLY when each dir met its
// pinned count and every case matched. If the real engagement set ever legitimately differs, that is a
// DELIBERATE edit to these constants + a register note, not a silent pass.
const EXPECTED_48_TESTS_CASES = 48;
const EXPECTED_504_SWEEP_CASES = 504;
const CASE_DIRS = [
  { id: "rater-48-tests", dir: "fixtures/rater/48-tests", expected: EXPECTED_48_TESTS_CASES },
  { id: "rater-504-sweep", dir: "fixtures/rater/504-sweep", expected: EXPECTED_504_SWEEP_CASES },
] as const;
const CONFIG_DIR = "fixtures/tariff";
const CONFIG_FILES = {
  zone_tariff: "zone_tariff.json",
  floors: "floors.json",
  fsc: "fsc.json",
  accessorials: "accessorials.json",
  class_adapter: "class_adapter.json", // optional
} as const;
// The three manifest rows that must be vendored to activate the gate; printed loudly while pending.
const PARITY_FIXTURE_IDS = ["rater-48-tests", "rater-504-sweep", "zone-tariff-v1"];

type ManifestEntry = { id: string; status: string; path: string; source: string };
type Manifest = { fixtures: ManifestEntry[] };

function hasJsonFiles(dir: string): boolean {
  return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".json"));
}

function configPresent(dir: string): boolean {
  const required: (keyof typeof CONFIG_FILES)[] = ["zone_tariff", "floors", "fsc", "accessorials"];
  return required.every((k) => existsSync(join(dir, CONFIG_FILES[k])));
}

function inputsPresent(): boolean {
  return CASE_DIRS.every((c) => hasJsonFiles(c.dir)) && configPresent(CONFIG_DIR);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadConfig(dir: string): TenantRatingConfig {
  const config: TenantRatingConfig = {
    zone_tariff: ZoneTariff.parse(readJson(join(dir, CONFIG_FILES.zone_tariff))),
    floors: FloorsConfig.parse(readJson(join(dir, CONFIG_FILES.floors))),
    fsc: FscConfig.parse(readJson(join(dir, CONFIG_FILES.fsc))),
    accessorials: AccessorialSchedule.parse(readJson(join(dir, CONFIG_FILES.accessorials))),
    ...(existsSync(join(dir, CONFIG_FILES.class_adapter))
      ? { class_adapter: ClassAdapter.parse(readJson(join(dir, CONFIG_FILES.class_adapter))) }
      : {}),
  };
  return config;
}

function loadCases(dir: string): ParityCase[] {
  const out: ParityCase[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
    const raw = readJson(join(dir, f));
    const items = Array.isArray(raw) ? raw : [raw];
    for (const item of items) out.push(ParityCase.parse(item));
  }
  return out;
}

function main(): void {
  const manifest = JSON.parse(readFileSync("fixtures/manifest.json", "utf8")) as Manifest;
  const rows = manifest.fixtures.filter((e) => PARITY_FIXTURE_IDS.includes(e.id));
  const present = inputsPresent();

  // DORMANCY GUARD — a vendored manifest claim and a dormant gate must never coexist. If the manifest marks
  // any parity fixture "vendored" but inputsPresent() is false (e.g. a future vendoring used different
  // filenames, or dropped files in the wrong place), we would otherwise quietly PENDING-skip while
  // check:fixtures greens on the flipped manifest — the gate silently OFF. Refuse: a vendored claim the
  // harness cannot honor is a hard failure, not a skip.
  if (!present) {
    const vendoredButUnfindable = rows.filter((e) => e.status === "vendored");
    if (vendoredButUnfindable.length > 0) {
      console.error(
        "PARITY FAILED — the manifest marks parity fixtures as VENDORED but the harness cannot find the files they name; the gate would be silently OFF:",
      );
      for (const e of vendoredButUnfindable) {
        console.error(
          `  - ${e.id} [vendored] path=${e.path} (${existsSync(e.path) ? "path exists but the expected case/config files are missing" : "path MISSING"}) source=${e.source}`,
        );
      }
      console.error(
        "A vendored claim must be honorable: vendor the actual case/config files at the layout in tools/rater/README.md, or revert the manifest status. No silent dormancy.",
      );
      process.exit(1);
    }

    // PENDING — the current reality. Print the not-yet-vendored rows LOUDLY. Never a false green: no
    // "passed", no gate. Advisory exit 0 so pixel/ledger work is not blocked on vendored data.
    console.warn(
      `PARITY PENDING (${rows.length}) — the audited engine's tests + tenant-0 tariff are NOT vendored in this repo; these are engagement-workspace fixtures:`,
    );
    for (const e of rows) {
      const onDisk = existsSync(e.path) ? "present on disk" : "absent on disk";
      console.warn(`  - ${e.id} [${e.status}] path=${e.path} (${onDisk}) source=${e.source}`);
    }
    console.warn(
      "PARITY PENDING — vendor the engagement fixtures (manifest.private M-01/M-02…) into fixtures/rater/48-tests, fixtures/rater/504-sweep and fixtures/tariff to activate REQ-027/REQ-165 parity. Advisory (exit 0) until then — see tools/rater/README.md.",
    );
    return;
  }

  // PRESENT — the real REQ-027/REQ-165 gate. Load per-dir so a short / empty / over vendoring is SURFACED,
  // never blessed. A 0/0 or partial run must never reach the GREEN line.
  const config = loadConfig(CONFIG_DIR);
  const perDir = CASE_DIRS.map((c) => ({ ...c, cases: loadCases(c.dir) }));
  const cases = perDir.flatMap((d) => d.cases);

  const countErrors: string[] = [];
  for (const d of perDir) {
    if (d.cases.length !== d.expected) {
      const detail =
        d.cases.length === 0 ? "present but yielded 0 cases" : `yielded ${d.cases.length} cases`;
      countErrors.push(`${d.id} (${d.dir}/): ${detail} — REQ-027 pins exactly ${d.expected}`);
    }
  }

  if (cases.length === 0) {
    // Vendored config + case files that load to nothing (empty [] files, a glob that hit only metadata,
    // cases parked in a subdir, …). Reproducing over zero comparisons is the exact false green the header
    // forbids — hard-fail.
    console.error(
      "PARITY FAILED — vendored fixtures present but yielded 0 cases; the audited set did not load.",
    );
  }
  if (countErrors.length > 0) {
    for (const e of countErrors) console.error(`  COUNT MISMATCH ${e}`);
  }
  if (cases.length === 0 || countErrors.length > 0) {
    console.error(
      "PARITY FAILED — the vendored case set does not match the audited REQ-027 counts (48-tests=48, 504-sweep=504); a short/over/empty set is a real discrepancy, not a pass. No merge.",
    );
    process.exit(1);
  }

  const result = runParity(cases, config);
  console.log(`rater parity — ${result.passed}/${result.total} cases reproduce the audited engine`);
  if (result.mismatches.length > 0) {
    for (const m of result.mismatches) {
      console.error(
        `  MISMATCH ${m.name} · ${m.field}: expected ${JSON.stringify(m.expected)} got ${JSON.stringify(m.actual)}`,
      );
    }
    console.error(
      "PARITY FAILED — the service diverges from the audited engine (REQ-027/REQ-165). No merge.",
    );
    process.exit(1);
  }
  console.log(
    `PARITY GREEN — REQ-027 (${EXPECTED_48_TESTS_CASES} tests + ${EXPECTED_504_SWEEP_CASES} sweep = ${result.total} cases) and REQ-165 (tenant-0 tariff) reproduced exactly.`,
  );
}

if (process.argv[1]?.endsWith("parity.ts")) main();
