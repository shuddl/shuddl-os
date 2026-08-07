// react-global MUST be the first import: it sets globalThis.React (a side effect) before the agents/
// design view modules — which composeConcierge renders through — are evaluated. See react-global.ts.
import "./react-global.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../checks/repo-root.js";
// `z` and the rate_config schemas come from @shuddl/contracts — the repo's single zod boundary (tools
// never take a direct zod dependency; see the re-export note in contracts/index).
import {
  z,
  ZoneTariff,
  FloorsConfig,
  FscConfig,
  AccessorialSchedule,
  ClassAdapter,
} from "@shuddl/contracts";
// Consumed by SOURCE module path (not package name), exactly like tools/rater/parity.ts and
// invoice-parity.ts: root only links the workspace packages it declares, and the tools chain must not add
// package deps for a CLI. These two are PURE (no I/O): the DeterministicParser extracts the request; the
// composeConcierge core prices → drafts → DECIDES (auto_reply | queued). The harness calls both directly.
import { DeterministicParser, ParseResultSchema } from "../../packages/agents/src/concierge/parse.js";
import type { ParseResult, InboundEmail } from "../../packages/agents/src/concierge/parse.js";
import { composeConcierge } from "../../packages/agents/src/concierge/compose.js";
import type { ConciergeDecision } from "../../packages/agents/src/concierge/compose.js";
import type { TenantRatingConfig } from "../../packages/rater/src/price.js";
// hashPath is the SAME path+bytes hash tools/fixtures/verify.ts pins fixtures by — the pin check is only
// meaningful if it hashes exactly the way the manifest recorded it.
import { hashPath } from "../fixtures/verify.js";
// V1 remediation Task 3 (REQ-288): merge/release turns the advisory PENDING skip into a non-promotable
// BLOCKED. run-gate consumes the structured GateResult, never this file's prose.
import { parseMode, unavailableStatus, formatGateResult } from "../release/evidence.js";

// REQ-026/093/098/171 — WP-07 Concierge DoD: "≥90% of real historical quote emails parse; 100% of the
// quotes we AUTO-SEND are floor-clean." This harness MIRRORS the rater parity harnesses' honest contract
// (tools/rater/parity.ts, tools/rater/invoice-parity.ts): loud-skip while pending, NEVER a false green.
//
//   • A VENDORED-IN-REPO SYNTHETIC SMOKE set (below, defined INLINE — NEVER under fixtures/, REQ-167) runs
//     on EVERY invocation. Each case is a made-up email run through the REAL DeterministicParser (assert the
//     extracted request) then the REAL composeConcierge (assert the DECISION: auto_reply | queued+reason).
//     The decisions are driven by the REAL gates — floor-clean (a REQ-040 anomaly holds), independent
//     corroboration (REQ-171), no-price-on-air (REQ-004), and the resolution floor (REQ-093) — never a
//     hand-wave. A smoke mismatch is a hard failure (exit 1): the harness FAILS loudly if the parse or the
//     decision drifts, and its green line is worded as SMOKE — never the DoD claim.
//   • The PENDING 50-real-email set is engagement-workspace material (fixtures/manifest.json lists
//     `concierge-parse-50` status:"pending"; it prices against the same tenant-0 tariff `zone-tariff-v1`).
//     So the DoD row CANNOT be closed from inside this repo today. The harness activates the REAL gate the
//     moment those fixtures are vendored AND hash-pinned (manifest rows status:"vendored" with a non-null
//     sha256 matching the on-disk bytes) — exit 1 on any divergence. A set PRESENT on disk but NOT
//     vendored/pinned is a REAL discrepancy (the exact self-consistent false green the WP-04 pattern exists
//     to prevent) and hard-fails. Until then it LOUD-SKIPS (advisory exit 0), never a false DoD green.
//
// The DeterministicParser is the AUDITABLE parse floor the DoD measures (the LLM ClaudeParser only ever
// STEERS, never gates — REQ-024/171). The money NEVER comes from the model: the price is the Rater's over
// the corroborated request. This runner is PURE (no network, no Date/random): same input → same decision.

// ── shared types ─────────────────────────────────────────────────────────────────────────────────────
// The queued reasons composeConcierge can return (compose.ts ConciergeDecision). Kept as a const list so
// the vendored-file schema and the type stay in lockstep.
const CONCIERGE_REASONS = ["below_floor", "not_corroborated", "unknown_price", "low_resolution"] as const;
type ConciergeReason = (typeof CONCIERGE_REASONS)[number];

// What the DeterministicParser is expected to have extracted. `weight_lb` undefined ⇒ MUST be absent;
// `dims` (when given) asserts dims PRESENCE (Boolean); `accessorials` is compared as a SET (default empty).
// The optionals carry an explicit `| undefined` because these values arrive from `ExpectedRequestShape`
// (zod `.optional()`), whose inferred type is `number | undefined` — under exactOptionalPropertyTypes a
// bare `?:` would refuse that assignment. The type now states exactly what the schema produces; the
// strictness flag is untouched, and every read below already handles the absent case.
interface ExpectedRequest {
  origin_zip: string;
  dest_zip: string;
  weight_lb?: number | undefined;
  dims?: boolean | undefined;
  accessorials?: readonly string[] | undefined;
}
export type ExpectedDecision = { status: "auto_reply" } | { status: "queued"; reason: ConciergeReason };
interface Expected {
  request?: ExpectedRequest; // absent ⇒ the parser must NOT have formed a request (both zips required)
  decision: ExpectedDecision;
}

// One unit of work for the comparison core: an email + its expectation, the config it prices against, and
// the resolution the resolve-step is standing in with. `composeParse` (smoke-only) OVERRIDES the parse fed
// to compose so the corroboration gate can be exercised with a model parse that DIVERGES from the email —
// the deterministic parse of the raw email is still what the parse-accuracy assertion checks.
interface EvalUnit {
  name: string;
  email: InboundEmail;
  expected: Expected;
  config: TenantRatingConfig;
  resolutionBps: number;
  composeParse?: ParseResult;
}

export interface Mismatch {
  name: string;
  field: string;
  expected: unknown;
  actual: unknown;
}
interface CaseOutcome {
  name: string;
  parsedOk: boolean; // the extracted request matched the expectation
  sent: boolean; // compose returned auto_reply
  expectSend: boolean; // the expectation was auto_reply
  mismatches: Mismatch[];
}
interface ParityResult {
  total: number;
  passed: number; // zero mismatches (parse AND decision correct)
  parsed: number; // request matched (parse accuracy — the ≥90% DoD metric)
  falseSends: number; // sent when the expectation said DON'T (the 100%-floor-clean-sends violation)
  mismatches: Mismatch[];
}

// ── the pure comparison core ─────────────────────────────────────────────────────────────────────────

/** Order-independent string-set equality (accessorials are a set). */
function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  for (const x of a) if (!sb.has(x)) return false;
  return true;
}

/** Compare the DeterministicParser's extracted request to the expectation; push any divergence.
 *  EXPORTED for parity-detection.test.ts (2026-08-02 §17): this harness had no negative test at all, so
 *  nothing proved it could report a divergence rather than silently agreeing with whatever it was given. */
export function compareRequest(
  name: string,
  actual: ParseResult["request"],
  expected: ExpectedRequest | undefined,
  out: Mismatch[],
): void {
  if (expected === undefined) {
    // The parser must NOT have formed a request (e.g. only one ZIP present → no rate request on air).
    if (actual !== undefined) {
      out.push({ name, field: "request", expected: "absent", actual });
    }
    return;
  }
  if (actual === undefined) {
    out.push({ name, field: "request", expected, actual: "absent" });
    return;
  }
  if (actual.origin_zip !== expected.origin_zip) {
    out.push({ name, field: "request.origin_zip", expected: expected.origin_zip, actual: actual.origin_zip });
  }
  if (actual.dest_zip !== expected.dest_zip) {
    out.push({ name, field: "request.dest_zip", expected: expected.dest_zip, actual: actual.dest_zip });
  }
  // weight_lb === weight_lb also asserts undefined === undefined (an expected-absent weight).
  if (actual.weight_lb !== expected.weight_lb) {
    out.push({ name, field: "request.weight_lb", expected: expected.weight_lb, actual: actual.weight_lb });
  }
  if (expected.dims !== undefined) {
    const actualHasDims = actual.dims !== undefined && actual.dims !== null;
    if (actualHasDims !== expected.dims) {
      out.push({ name, field: "request.dims(present)", expected: expected.dims, actual: actualHasDims });
    }
  }
  if (!sameStringSet(actual.accessorials ?? [], expected.accessorials ?? [])) {
    out.push({
      name,
      field: "request.accessorials",
      expected: expected.accessorials ?? [],
      actual: actual.accessorials ?? [],
    });
  }
}

/** A readable rendering of a decision for mismatch output. */
function describeDecision(d: ConciergeDecision): string {
  return d.status === "queued" ? `queued(${d.reason})` : "auto_reply";
}

/** Compare the composed decision to the expectation; push any divergence. */
/** EXPORTED for parity-detection.test.ts (§17) — see compareRequest above. */
export function compareDecision(name: string, actual: ConciergeDecision, expected: ExpectedDecision, out: Mismatch[]): void {
  if (actual.status !== expected.status) {
    out.push({ name, field: "decision.status", expected: expected.status, actual: describeDecision(actual) });
    return; // status diverged — the reason is not comparable
  }
  if (expected.status === "queued" && actual.status === "queued" && actual.reason !== expected.reason) {
    out.push({ name, field: "decision.reason", expected: expected.reason, actual: actual.reason });
  }
}

/**
 * evaluateCase — the pure, deterministic unit: parse the email with the REAL DeterministicParser and assert
 * the extracted request; then run composeConcierge (with the deterministic parse, or a diverging override)
 * over the case's config + resolution and assert the DECISION. Any throw is recorded as that case's mismatch
 * (one bad case never hides the rest). Network-free.
 */
async function evaluateCase(unit: EvalUnit): Promise<CaseOutcome> {
  const mismatches: Mismatch[] = [];
  let parsedOk = false;
  let sent = false;
  const expectSend = unit.expected.decision.status === "auto_reply";
  try {
    const det = await new DeterministicParser().parse(unit.email);
    const reqBefore = mismatches.length;
    compareRequest(unit.name, det.request, unit.expected.request, mismatches);
    parsedOk = mismatches.length === reqBefore;

    const parseForCompose = unit.composeParse ?? det;
    const decision = await composeConcierge({
      parse: parseForCompose,
      email: unit.email,
      resolved: { party_id: "party-parity", shipment_id: "SHP-PARITY", resolution_confidence: unit.resolutionBps },
      ratingConfig: unit.config,
      tenantFromName: TENANT_FROM_NAME,
    });
    sent = decision.status === "auto_reply";
    compareDecision(unit.name, decision, unit.expected.decision, mismatches);
  } catch (err) {
    mismatches.push({
      name: unit.name,
      field: "exception",
      expected: `parse + decision ${describeExpected(unit.expected.decision)}`,
      actual: err instanceof Error ? err.message : String(err),
    });
  }
  return { name: unit.name, parsedOk, sent, expectSend, mismatches };
}

function describeExpected(d: ExpectedDecision): string {
  return d.status === "queued" ? `queued(${d.reason})` : "auto_reply";
}

/** Run every unit through the comparison core and aggregate. Deterministic; no I/O. */
async function runConciergeParity(units: readonly EvalUnit[]): Promise<ParityResult> {
  const mismatches: Mismatch[] = [];
  let passed = 0;
  let parsed = 0;
  let falseSends = 0;
  for (const unit of units) {
    const outcome = await evaluateCase(unit);
    mismatches.push(...outcome.mismatches);
    if (outcome.mismatches.length === 0) passed += 1;
    if (outcome.parsedOk) parsed += 1;
    if (outcome.sent && !outcome.expectSend) falseSends += 1; // a quote auto-sent that should NOT have been
  }
  return { total: units.length, passed, parsed, falseSends, mismatches };
}

// ── the vendored-in-repo SMOKE SET — the harness's own liveness proof ──────────────────────────────────
// Synthetic + engagement-free (REQ-167): made-up names / .example domains only. The configs mirror the api
// test harness's TEST_RATE_CONFIG / ANOMALY_RATE_CONFIG shape so the Rater prices. Runs on EVERY invocation;
// a mismatch here is the parse→decide path itself drifting, independent of the pending 50-set.

const TENANT_FROM_NAME = "Example Freight Desk";

// dest 972xx / 981xx → Z1 → rg-near; 800xx → Z5 → rg-far. Ordinary min charges — nothing anomalous prices.
const SMOKE_CONFIG: TenantRatingConfig = {
  zone_tariff: ZoneTariff.parse({
    kind: "zone_tariff",
    id: "zt-concierge-smoke",
    version: "v1",
    zip_to_zone: { "972": "Z1", "981": "Z1", "800": "Z5" },
    rate_groups: [
      { id: "rg-near", zones: ["Z1"], breaks: [{ min_lb: 0, cwt_cents: 3800 }, { min_lb: 500, cwt_cents: 3200 }], min_charge_cents: 9500 },
      { id: "rg-far", zones: ["Z5"], breaks: [{ min_lb: 0, cwt_cents: 5200 }, { min_lb: 500, cwt_cents: 4500 }], min_charge_cents: 11500 },
    ],
  }),
  floors: FloorsConfig.parse({ kind: "floors", id: "fl-concierge-smoke", version: "v1", target_or_bps: 9800, full_cost_bps: 9200, contribution_bps: 8500 }),
  fsc: FscConfig.parse({ kind: "fsc", id: "fsc-concierge-smoke", version: "v1", pct_bps: 2400 }),
  accessorials: AccessorialSchedule.parse({ kind: "accessorials", id: "acc-concierge-smoke", version: "v1", items: { liftgate: 3500, residential: 2500 } }),
};

// An absurd min charge ($250k) so a tiny-weight shipment prices ~$310k → far over the $2,000/lb REQ-040 cap
// → the anomaly net trips → the quote is NOT floor-clean → it MUST queue (below_floor), never auto-send.
const ANOMALY_CONFIG: TenantRatingConfig = {
  zone_tariff: ZoneTariff.parse({
    kind: "zone_tariff",
    id: "zt-concierge-anom",
    version: "v1",
    zip_to_zone: { "981": "Z5", "800": "Z5" },
    rate_groups: [{ id: "rg-anom", zones: ["Z5"], breaks: [{ min_lb: 0, cwt_cents: 5200 }], min_charge_cents: 25_000_000 }],
  }),
  floors: FloorsConfig.parse({ kind: "floors", id: "fl-concierge-anom", version: "v1", target_or_bps: 9800, full_cost_bps: 9200, contribution_bps: 8500 }),
  fsc: FscConfig.parse({ kind: "fsc", id: "fsc-concierge-anom", version: "v1", pct_bps: 2400 }),
  accessorials: AccessorialSchedule.parse({ kind: "accessorials", id: "acc-concierge-anom", version: "v1", items: {} }),
};

const HIGH_RESOLUTION = 9500; // ≥ the 9000 REQ-093 floor — resolution never blocks these sends
const LOW_RESOLUTION = 8000; // < 9000 → the resolution gate queues (low_resolution)

// A prompt-injected model parse for the corroboration case: same lane/dims as the email, but a cheap 1-lb
// weight the deterministic re-extraction (1500 lb from the raw email) will refuse to confirm (REQ-171).
const INJECTED_UNDERWEIGHT_PARSE: ParseResult = ParseResultSchema.parse({
  intent: "quote",
  confidence: 10_000, // even a maxed self-reported confidence cannot force the send — it never gates
  request: { origin_zip: "80216", dest_zip: "97203", weight_lb: 1, dims: { l_in: 45, w_in: 45, h_in: 45, pieces: 4 } },
});

const SMOKE_CASES: EvalUnit[] = [
  // 1. CLEAN AUTO-REPLY + accessorials + the infinitive-ZIP trap ("to ship from 80216 to 97203": the
  //    leading "to" must NOT steal the dest). Floor-clean + self-corroborated + resolved-high ⇒ auto_reply.
  {
    name: "clean-quote-accessorials-infinitive-trap",
    email: {
      from: "Jamie Rivera <jamie@acme-logistics.example>",
      subject: "Rate request — DEN to PDX",
      body: "Hi, can I get a quote to ship from 80216 to 97203? Weight is 1200 lbs, dims 48x40x60, 2 pallets. Needs a liftgate and residential delivery.",
    },
    config: SMOKE_CONFIG,
    resolutionBps: HIGH_RESOLUTION,
    expected: {
      request: { origin_zip: "80216", dest_zip: "97203", weight_lb: 1200, dims: true, accessorials: ["liftgate", "residential"] },
      decision: { status: "auto_reply" },
    },
  },
  // 2. CLEAN AUTO-REPLY, minimal (no accessorials). The plain happy path.
  {
    name: "clean-quote-minimal",
    email: {
      from: "dispatch@shipper.example",
      subject: "Quote please",
      body: "Please quote a shipment from 80216 to 97203, 1500 lbs, 48x40x48, 3 pallets.",
    },
    config: SMOKE_CONFIG,
    resolutionBps: HIGH_RESOLUTION,
    expected: {
      request: { origin_zip: "80216", dest_zip: "97203", weight_lb: 1500, dims: true },
      decision: { status: "auto_reply" },
    },
  },
  // 3. BELOW-FLOOR MUST QUEUE — the REQ-040 permanent net. A 35-lb piece against an absurd min charge
  //    prices ~$310k (~$8,857/lb ≫ the $2,000/lb cap) → anomaly → NOT floor-clean → queued(below_floor).
  //    Corroborated + max resolution CANNOT override it: a physically-absurd quote never auto-sends.
  {
    name: "anomaly-tiny-weight-below-floor",
    email: {
      from: "ops@shipper.example",
      subject: "Quote",
      body: "Quote from 80216 to 98101, 35 lbs, 12x12x12, 1 pallet.",
    },
    config: ANOMALY_CONFIG,
    resolutionBps: HIGH_RESOLUTION,
    expected: {
      request: { origin_zip: "80216", dest_zip: "98101", weight_lb: 35, dims: true },
      decision: { status: "queued", reason: "below_floor" },
    },
  },
  // 4. NO PRICE ON AIR — both zips + a weight but NO dims → the Rater returns UNKNOWN (missing physics) →
  //    queued(unknown_price). Underspecified: a human handles it (REQ-004).
  {
    name: "missing-dims-unknown-price",
    email: {
      from: "warehouse@shipper.example",
      subject: "Need a rate",
      body: "Please quote a shipment from 80216 to 97203, about 900 lbs. No dimensions handy yet.",
    },
    config: SMOKE_CONFIG,
    resolutionBps: HIGH_RESOLUTION,
    expected: {
      request: { origin_zip: "80216", dest_zip: "97203", weight_lb: 900, dims: false },
      decision: { status: "queued", reason: "unknown_price" },
    },
  },
  // 5. NO REQUEST — only an origin ZIP (no dest keyword+ZIP) → the parser forms no rate request →
  //    queued(unknown_price). Proves the request-absent path (compose does not assume resolve gated it).
  {
    name: "one-zip-no-request-unknown-price",
    email: {
      from: "someone@shipper.example",
      subject: "Pickup request",
      body: "Please quote a pickup from 80216, 1000 lbs, 48x40x48, 2 pallets. Where should we send the driver?",
    },
    config: SMOKE_CONFIG,
    resolutionBps: HIGH_RESOLUTION,
    expected: {
      // request absent
      decision: { status: "queued", reason: "unknown_price" },
    },
  },
  // 6. RESOLUTION FLOOR — a clean, corroborated, floor-clean quote whose resolution (8000) sits below the
  //    9000 REQ-093 floor → queued(low_resolution). The belt-and-suspenders re-gate compose owns.
  {
    name: "low-resolution-queues",
    email: {
      from: "receiving@shipper.example",
      subject: "Rate needed",
      body: "Please quote a shipment from 80216 to 97203, 1100 lbs, 40x48x50, 2 skids.",
    },
    config: SMOKE_CONFIG,
    resolutionBps: LOW_RESOLUTION,
    expected: {
      request: { origin_zip: "80216", dest_zip: "97203", weight_lb: 1100, dims: true },
      decision: { status: "queued", reason: "low_resolution" },
    },
  },
  // 7. NOT CORROBORATED — the raw email says 1500 lb (the parse-accuracy assertion checks that), but the
  //    model parse fed to compose claims a cheap 1 lb. The independent deterministic re-extraction refuses
  //    to confirm it → queued(not_corroborated). Even confidence 10000 cannot force the send (REQ-171).
  {
    name: "injected-underweight-not-corroborated",
    email: {
      from: "Casey Doe <casey@shipper.example>",
      subject: "Rate needed",
      body: "Rate needed: from 80216 to 97203, 1500 lbs, 45x45x45, 4 pallets.",
    },
    config: SMOKE_CONFIG,
    resolutionBps: HIGH_RESOLUTION,
    composeParse: INJECTED_UNDERWEIGHT_PARSE,
    expected: {
      request: { origin_zip: "80216", dest_zip: "97203", weight_lb: 1500, dims: true },
      decision: { status: "queued", reason: "not_corroborated" },
    },
  },
];

// ── the CLI ────────────────────────────────────────────────────────────────────────────────────────────
// Vendored inputs the 50-email DoD gate needs (engagement-workspace fixtures, currently pending):
//   • emails: fixtures/concierge/parse-50/ — JSON ConciergeParityCase files (one case per file, or an array
//     per file — both accepted), exactly 50 real historical quote emails + their expected parse + decision.
//   • tenant-0 config: fixtures/tariff/ — the SAME vendored tariff the rater parity gate prices with.

const EXPECTED_REAL_CASES = 50;
const MIN_PARSED_BPS = 9000; // ≥90% parsed — the WP-07 DoD floor on the DeterministicParser's accuracy
const CONCIERGE_DIR = `${repoRoot()}/fixtures/concierge/parse-50`;
const CONFIG_DIR = `${repoRoot()}/fixtures/tariff`;
const CONFIG_FILES = {
  zone_tariff: "zone_tariff.json",
  floors: "floors.json",
  fsc: "fsc.json",
  accessorials: "accessorials.json",
  class_adapter: "class_adapter.json", // optional
} as const;
// Both rows must be vendored + hash-pinned to activate: the 50 emails AND the tenant-0 tariff they price
// against (a floor-clean-sends check against an unpinned tariff proves nothing about tenant-0 quotes).
const CONCIERGE_FIXTURE_IDS = ["concierge-parse-50", "zone-tariff-v1"] as const;

type ManifestEntry = { id: string; status: string; path: string; sha256: string | null; source: string };
type Manifest = { fixtures: ManifestEntry[] };

// The vendored-file schema (also the shape the smoke cases follow). `.strict()` so a malformed vendored
// case is rejected at parse, never half-compared.
const ExpectedRequestShape = z
  .object({
    origin_zip: z.string(),
    dest_zip: z.string(),
    weight_lb: z.number().int().optional(),
    dims: z.boolean().optional(),
    accessorials: z.array(z.string()).optional(),
  })
  .strict();

export const ConciergeParityCase = z
  .object({
    name: z.string(),
    email: z.object({ from: z.string(), subject: z.string(), body: z.string() }).strict(),
    expected: z
      .object({
        request: ExpectedRequestShape.optional(),
        decision: z
          .object({ status: z.enum(["auto_reply", "queued"]), reason: z.enum(CONCIERGE_REASONS).optional() })
          .strict(),
      })
      .strict(),
  })
  .strict()
  // A queued expectation MUST name a reason; an auto_reply MUST NOT — reject the incoherent case at parse.
  .refine((c) => c.expected.decision.status !== "queued" || c.expected.decision.reason !== undefined, {
    message: "a queued expectation must specify expected.decision.reason",
    path: ["expected", "decision", "reason"],
  })
  .refine((c) => c.expected.decision.status !== "auto_reply" || c.expected.decision.reason === undefined, {
    message: "expected.decision.reason is only meaningful when the status is \"queued\"",
    path: ["expected", "decision", "reason"],
  });
export type ConciergeParityCase = z.infer<typeof ConciergeParityCase>;

// The vendored + hash-pin gate (same anti-fabrication law as parity.ts's verifyParityPins / invoice-
// parity.ts's verifyReplayPins): a set that is PRESENT on disk may activate/green ONLY if the manifest
// marks it vendored with a non-null sha256 AND the on-disk bytes hash to that pin. Present-but-unvendored /
// unpinned / hash-mismatched ⇒ a REAL discrepancy, hard-fail — never a self-consistent false green.
export function verifyConciergePins(
  rows: readonly { id: string; status: string; path: string; sha256: string | null }[],
  hashFn: (p: string) => string = hashPath,
  existsFn: (p: string) => boolean = existsSync,
): string[] {
  const problems: string[] = [];
  for (const id of CONCIERGE_FIXTURE_IDS) {
    const row = rows.find((r) => r.id === id);
    if (row === undefined) {
      problems.push(`${id}: no manifest row (the WP-07 DoD 50-email gate requires it vendored)`);
      continue;
    }
    if (row.status !== "vendored") {
      problems.push(
        `${id} [${row.status}] — NOT vendored: a present-but-unvendored set carries no independent provenance; the hash pin is what proves the on-disk bytes are the engagement set, not self-generated`,
      );
      continue;
    }
    if (row.sha256 === null) {
      problems.push(`${id} [vendored] — no pinned sha256; a vendored fixture MUST carry the hash it was pinned at`);
      continue;
    }
    if (!existsFn(row.path)) {
      problems.push(`${id} [vendored] — pinned but the path is missing on disk: ${row.path}`);
      continue;
    }
    const actual = hashFn(row.path);
    if (actual !== row.sha256) {
      problems.push(
        `${id} [vendored] — hash mismatch (pinned ${row.sha256.slice(0, 12)}… actual ${actual.slice(0, 12)}…): the on-disk bytes are NOT the vendored set`,
      );
    }
  }
  return problems;
}

function hasJsonFiles(dir: string): boolean {
  return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".json"));
}

function configPresent(dir: string): boolean {
  const required: (keyof typeof CONFIG_FILES)[] = ["zone_tariff", "floors", "fsc", "accessorials"];
  return required.every((k) => existsSync(join(dir, CONFIG_FILES[k])));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadConfig(dir: string): TenantRatingConfig {
  return {
    zone_tariff: ZoneTariff.parse(readJson(join(dir, CONFIG_FILES.zone_tariff))),
    floors: FloorsConfig.parse(readJson(join(dir, CONFIG_FILES.floors))),
    fsc: FscConfig.parse(readJson(join(dir, CONFIG_FILES.fsc))),
    accessorials: AccessorialSchedule.parse(readJson(join(dir, CONFIG_FILES.accessorials))),
    ...(existsSync(join(dir, CONFIG_FILES.class_adapter))
      ? { class_adapter: ClassAdapter.parse(readJson(join(dir, CONFIG_FILES.class_adapter))) }
      : {}),
  };
}

function loadCases(dir: string): ConciergeParityCase[] {
  const out: ConciergeParityCase[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
    const raw = readJson(join(dir, f));
    const items = Array.isArray(raw) ? raw : [raw];
    for (const item of items) out.push(ConciergeParityCase.parse(item));
  }
  return out;
}

// Map a vendored case to a work unit: it prices against the tenant-0 tariff at a fixed high resolution
// (resolution is the resolve-step's concern — resolve.test.ts owns that gate; this gate measures the
// DETERMINISTIC parser's accuracy + that every auto-send is floor-clean and corroborated). The vendored
// emails always go through the deterministic parse (no LLM in this pure gate).
function toUnit(c: ConciergeParityCase, config: TenantRatingConfig): EvalUnit {
  const decision: ExpectedDecision =
    c.expected.decision.status === "queued"
      ? { status: "queued", reason: c.expected.decision.reason as ConciergeReason }
      : { status: "auto_reply" };
  return {
    name: c.name,
    email: c.email,
    config,
    resolutionBps: HIGH_RESOLUTION,
    expected: {
      ...(c.expected.request !== undefined ? { request: c.expected.request } : {}),
      decision,
    },
  };
}

function printMismatches(mismatches: readonly Mismatch[]): void {
  for (const m of mismatches) {
    console.error(`  MISMATCH ${m.name} · ${m.field}: expected ${JSON.stringify(m.expected)} got ${JSON.stringify(m.actual)}`);
  }
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  // ── 1. SMOKE — always runs; the harness's liveness proof. It must EXERCISE both a real send and a real
  //       hard-queue: guard that the inline set still carries ≥1 auto_reply AND ≥1 below_floor, so a future
  //       edit can never hollow the smoke into an all-green no-op.
  const expectSends = SMOKE_CASES.filter((c) => c.expected.decision.status === "auto_reply").length;
  const expectBelowFloor = SMOKE_CASES.filter(
    (c) => c.expected.decision.status === "queued" && c.expected.decision.reason === "below_floor",
  ).length;
  if (expectSends === 0 || expectBelowFloor === 0) {
    console.error(
      `CONCIERGE PARSE SMOKE FAILED — the inline smoke set must exercise at least one auto_reply (${expectSends}) AND one below_floor queue (${expectBelowFloor}); a smoke that sends nothing / never hits the floor guard proves nothing.`,
    );
    process.exit(1);
  }

  const smoke = await runConciergeParity(SMOKE_CASES);
  if (smoke.mismatches.length > 0) {
    printMismatches(smoke.mismatches);
    console.error(
      "CONCIERGE PARSE SMOKE FAILED — the parse→decide path diverges from the expectation on the vendored-in-repo smoke set (REQ-026/093/098/171). No merge.",
    );
    process.exit(1);
  }
  // A false send in the smoke is the single worst outcome — surface it explicitly even though mismatches==0
  // already caught it (defense-in-depth: the send count is the DoD's 100%-floor-clean-sends invariant).
  if (smoke.falseSends > 0) {
    console.error(`CONCIERGE PARSE SMOKE FAILED — ${smoke.falseSends} case(s) auto-sent a quote that must have queued. No merge.`);
    process.exit(1);
  }
  console.log(
    `concierge parse smoke — ${smoke.passed}/${smoke.total} in-repo synthetic cases: parse matched + decision matched (${expectSends} auto_reply, ${smoke.total - expectSends} queued; 0 false sends) — harness live; NOT the 50-email DoD`,
  );

  // ── 2. THE 50-REAL-EMAIL GATE — engagement-workspace fixtures, pending until vendored + hash-pinned.
  const manifest = JSON.parse(readFileSync(`${repoRoot()}/fixtures/manifest.json`, "utf8")) as Manifest;
  const rows = manifest.fixtures.filter((e) => (CONCIERGE_FIXTURE_IDS as readonly string[]).includes(e.id));
  const casesPresent = hasJsonFiles(CONCIERGE_DIR);
  const configOk = configPresent(CONFIG_DIR);
  const present = casesPresent && configOk;

  // HALF-VENDORED GUARD (mirrors invoice-parity.ts): email files on disk with NO tenant-0 tariff to price
  // against is a partial vendoring — the floor-clean-sends check has nothing to run, and quietly PENDING-
  // skipping would leave dropped-but-unusable email bytes invisible. Loud hard failure. The INVERSE (tariff
  // present, emails absent) is DELIBERATELY not a failure: the tariff co-vendors with the RATER parity set,
  // which legitimately activates before the concierge email set arrives — it stays pending below, with the
  // tariff's presence printed per-row, and the dormancy guard still refuses a vendored CLAIM.
  if (casesPresent && !configOk) {
    console.error(
      "CONCIERGE PARSE FAILED — email files are PRESENT at fixtures/concierge/parse-50/ but the tenant-0 tariff (fixtures/tariff/) is absent or incomplete: a half-vendored set has nothing to price the floor-clean-sends check against and must never quietly PENDING-skip.",
    );
    console.error("Vendor the tariff (layout in tools/rater/README.md) alongside the email files — or remove the stray files. No silent partial vendoring.");
    process.exit(1);
  }

  if (!present) {
    // DORMANCY GUARD (mirrors parity.ts / invoice-parity.ts): a manifest that claims the EMAIL SET is
    // vendored while the harness cannot find its files would leave this gate silently OFF — refuse.
    // (zone-tariff-v1 alone being vendored is legitimate: the rater parity gate may activate first.)
    const emailRow = rows.find((e) => e.id === "concierge-parse-50");
    if (emailRow !== undefined && emailRow.status === "vendored") {
      console.error(
        "CONCIERGE PARSE FAILED — the manifest marks concierge-parse-50 as VENDORED but the harness cannot find the files it names; the gate would be silently OFF:",
      );
      console.error(
        `  - concierge-parse-50 [vendored] path=${emailRow.path} (${existsSync(emailRow.path) ? "path exists but the expected email files are missing" : "path MISSING"}) source=${emailRow.source}`,
      );
      console.error("A vendored claim must be honorable: vendor the email files (and the tenant-0 tariff at fixtures/tariff/), or revert the manifest status. No silent dormancy.");
      process.exit(1);
    }

    // PENDING — the current reality. Loud, advisory, NEVER a false green: no DoD "GREEN" on absent data.
    console.warn(
      `CONCIERGE PARSE PENDING (${rows.length}) — the 50 real historical quote emails + tenant-0 tariff are NOT vendored in this repo; these are engagement-workspace fixtures:`,
    );
    for (const e of rows) {
      const onDisk = existsSync(e.path) ? "present on disk" : "absent on disk";
      console.warn(`  - ${e.id} [${e.status}] path=${e.path} (${onDisk}) source=${e.source}`);
    }
    console.warn(
      "CONCIERGE PARSE PENDING — vendor the engagement fixtures into fixtures/concierge/parse-50 and fixtures/tariff to activate the WP-07 DoD gate (≥90% parsed, 100% floor-clean sends). Advisory (exit 0) until then.",
    );
    // REQ-288: local stays advisory (PENDING, exit 0); merge/release BLOCKS (exit 2) on the absent
    // private email corpus — a release gate never greens on absent DoD data.
    const { status, exitCode } = unavailableStatus(mode);
    if (mode !== "local") {
      console.error(`concierge-parse: BLOCKED under --mode ${mode} — the 50-email corpus is not vendored; no promotion on absent private fixtures.`);
    }
    console.log(formatGateResult({ gate: "concierge-parse", status, executed: false, assertions: 0, detail: "engagement fixtures not vendored (fixtures/concierge/parse-50, fixtures/tariff)" }));
    process.exit(exitCode);
  }

  // PRESENT — but presence is NOT a pass: require vendored + hash-pinned, exactly like the rater gate.
  const pinProblems = verifyConciergePins(rows);
  if (pinProblems.length > 0) {
    console.error(
      "CONCIERGE PARSE FAILED — email files are PRESENT but the set is not vendored + hash-pinned; a present-but-unpinned set is a real discrepancy, never a pass:",
    );
    for (const p of pinProblems) console.error(`  - ${p}`);
    console.error('Vendor the set through the manifest: status:"vendored" with a sha256 matching the on-disk bytes. No self-consistent false green.');
    process.exit(1);
  }

  // Vendored + pinned confirmed — the real gate. A 0/short/over load is SURFACED, never blessed.
  const config = loadConfig(CONFIG_DIR);
  const cases = loadCases(CONCIERGE_DIR);
  if (cases.length !== EXPECTED_REAL_CASES) {
    console.error(
      `CONCIERGE PARSE FAILED — fixtures/concierge/parse-50/ yielded ${cases.length} cases; the WP-07 DoD pins exactly ${EXPECTED_REAL_CASES}. A short/over/empty set is a real discrepancy, not a pass. No merge.`,
    );
    process.exit(1);
  }

  const result = await runConciergeParity(cases.map((c) => toUnit(c, config)));
  const parsedBps = Math.floor((result.parsed / result.total) * 10_000);
  console.log(
    `concierge parse — ${result.parsed}/${result.total} emails parsed (${(parsedBps / 100).toFixed(1)}%), ${result.falseSends} false sends`,
  );
  if (result.mismatches.length > 0) printMismatches(result.mismatches);

  // The two DoD invariants: ≥90% parsed AND 100% floor-clean sends (zero quotes auto-sent that should have
  // queued). A false send is NEVER acceptable; a parse rate below the floor fails.
  if (result.falseSends > 0) {
    console.error(
      `CONCIERGE PARSE FAILED — ${result.falseSends} email(s) auto-sent a quote that must have queued: the WP-07 "100% floor-clean sends" invariant is broken. No merge.`,
    );
    process.exit(1);
  }
  if (parsedBps < MIN_PARSED_BPS) {
    console.error(
      `CONCIERGE PARSE FAILED — only ${(parsedBps / 100).toFixed(1)}% of emails parsed; the WP-07 DoD floor is ${MIN_PARSED_BPS / 100}%. No merge.`,
    );
    process.exit(1);
  }
  console.log(
    `CONCIERGE PARSE GREEN — WP-07 DoD reproduced: ≥${MIN_PARSED_BPS / 100}% of the ${EXPECTED_REAL_CASES} real emails parsed and 100% of auto-sends are floor-clean.`,
  );
  console.log(formatGateResult({ gate: "concierge-parse", status: "PASS", executed: true, assertions: result.total, detail: "WP-07 DoD reproduced (parse floor + floor-clean sends)" }));
}

if (process.argv[1]?.endsWith("parse-parity.ts")) void main();
