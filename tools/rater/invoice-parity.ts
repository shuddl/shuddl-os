import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// `z` and the config/payload schemas come from @shuddl/contracts — the repo's single zod boundary
// (tools never take a direct zod dependency; see the re-export note in contracts/index).
import {
  z,
  ZoneTariff,
  FloorsConfig,
  FscConfig,
  AccessorialSchedule,
  ClassAdapter,
  QuotePricedPayload,
} from "@shuddl/contracts";
// Consumed by SOURCE module path (not package name) for the same reason parity.ts does: root only
// links the workspace packages it declares, and the tools chain must not add package deps for a CLI.
import { priceShipment } from "../../packages/rater/src/price.js";
import type { RateRequest, TenantRatingConfig, QuoteResult } from "../../packages/rater/src/price.js";
import { composeInvoice } from "../../packages/agents/src/biller/compose.js";
import { GL_MAP } from "../../packages/agents/src/biller/gl-map.js";
// hashPath is the SAME path+bytes hash tools/fixtures/verify.ts pins fixtures by — the pin check is
// only meaningful if it hashes exactly the way the manifest recorded it.
import { hashPath } from "../fixtures/verify.js";
// V1 remediation Task 3 (REQ-288): merge/release turns the advisory PENDING skip into a non-promotable
// BLOCKED. run-gate consumes the structured GateResult, never this file's prose.
import { parseMode, unavailableStatus, formatGateResult } from "../release/evidence.js";

// REQ-031 — WP-06 DoD: "Invoice math matches Rater to the penny on 500-fixture replay."
//
// THE HONEST CONTRACT (mirrors tools/rater/parity.ts, the WP-04 lesson): the 500-quote replay set is
// ENGAGEMENT-WORKSPACE material — it is NOT in this repo today (fixtures/manifest.json lists
// `invoice-500-replay` as status:"pending", alongside the tenant-0 tariff `zone-tariff-v1` it prices
// against). So the DoD row CANNOT be closed from inside this repo. This harness therefore:
//   • runs a VENDORED-IN-REPO SMOKE SET on every invocation (below) — 5 synthetic cases, including a
//     min-charge case and an interline split — so the harness itself is proven LIVE today: each case
//     prices through the REAL rater (priceShipment), records the quote payload EXACTLY as the /rate
//     route does, composes through the REAL Biller core (composeInvoice), and asserts Σ invoice lines
//     === sell, per-line kind/amount equality, and gl_map account totals reconciling to the penny. A
//     smoke mismatch is a hard failure (exit 1) — the harness must FAIL loudly if the composition
//     drifts, never sit green while broken. The smoke line NEVER prints as the DoD green.
//   • activates the REAL 500-replay gate the moment the fixtures are vendored AND hash-pinned (the
//     manifest rows status:"vendored" with a non-null sha256 matching the on-disk bytes) — exit 1 on
//     any divergence. A set PRESENT on disk but NOT vendored/pinned is a REAL discrepancy (the exact
//     self-consistent false green the WP-04 pattern exists to prevent) and hard-fails.
//   • until then LOUD-SKIPS the 500-set — prints `INVOICE PARITY PENDING (…)` naming the pending rows
//     and exits 0 (advisory). It must NEVER print a false green: no DoD "GREEN" on synthetic or
//     absent data. The runner below is PURE (no I/O) so it is unit-testable without masquerading.
//
// WHAT "matches Rater to the penny" MEANS HERE: the invoice is a PROJECTION of the recorded quote
// (REQ-003) — the comparison is invoice.issued lines vs the priced quote's own lines, penny for
// penny, per line, plus the GL mapping totals. The rater's own absolute correctness (engine vs the
// audited legacy engine) is tools/rater/parity.ts's gate (REQ-027/165) — not re-litigated here.

// ── The pure runner ────────────────────────────────────────────────────────────────────────────────────

// Same request shape parity.ts accepts (`.passthrough()` keeps a vendored file's extra keys — e.g. a
// source-line ref — forward-compatible with the engagement export format; extras are ignored).
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

const LegShape = z
  .object({
    kind: z.enum(["pickup", "linehaul", "interline", "cartage", "delivery", "dray"]),
    executor: z.string().min(1),
    split_bps: z.number().int().min(0).max(10_000),
  })
  .strict();

// A replay case: a rate request (+ optional bill terms / interline legs) and the expected COMPOSE
// outcome. The penny-parity expectation itself is STRUCTURAL (invoice lines vs the quote's lines) and
// runs on every "issue" case regardless of pins; `expect.sell_cents` optionally pins the absolute
// figure so a vendored case also anchors the engine's output.
export const InvoiceReplayCase = z
  .object({
    name: z.string(),
    request: RequestShape,
    bill: z
      .object({
        party_id: z.string().min(1).optional(),
        terms: z.enum(["prepaid", "collect", "third_party"]).optional(),
        third_party_id: z.string().min(1).optional(),
        division: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    legs: z.array(LegShape).optional(),
    tenant_party: z.string().min(1).optional(),
    approval_granted: z.enum(["single", "dual"]).optional(),
    expect: z
      .object({
        outcome: z.enum(["issue", "hold"]),
        hold_reason: z.enum(["anomaly", "below_floor"]).optional(),
        sell_cents: z.number().int().optional(),
      })
      .strict(),
  })
  .strict()
  // A hold expectation with a pinned sell is incoherent (a hold composes no lines), as is a
  // hold_reason on an issue — reject the malformed case at parse, never half-compare it.
  .refine((c) => c.expect.outcome === "hold" || c.expect.hold_reason === undefined, {
    message: "expect.hold_reason is only meaningful when expect.outcome is \"hold\"",
    path: ["expect", "hold_reason"],
  })
  .refine((c) => c.expect.outcome === "issue" || c.expect.sell_cents === undefined, {
    message: "expect.sell_cents is only meaningful when expect.outcome is \"issue\" (a hold composes no lines)",
    path: ["expect", "sell_cents"],
  });
export type InvoiceReplayCase = z.infer<typeof InvoiceReplayCase>;

export interface ReplayMismatch {
  name: string;
  field: string;
  expected: unknown;
  actual: unknown;
}
export interface ReplayResult {
  total: number;
  passed: number;
  mismatches: ReplayMismatch[];
}

// Optional fields spread in ONLY when present (exactOptionalPropertyTypes; mirrors parity.ts).
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
 * runInvoiceParity — the pure comparison. Per case:
 *   1. price via the REAL rater (priceShipment). A non-PRICED quote is a mismatch — there is no
 *      invoice math to check on air (an UNKNOWN case belongs to the rater parity set, not this one).
 *   2. record the quote payload EXACTLY as workers/api/src/routes/rate.ts appends it (sell + verbatim
 *      lines + floors + versions + basis carrying the anomaly) through QuotePricedPayload.parse — the
 *      same Zod boundary the ledger enforces.
 *   3. compose through the REAL Biller core (composeInvoice) with the case's bill terms (default
 *      prepaid → party-bill-to) and any interline legs. A PARTIAL interline signal is passed through
 *      verbatim so compose's fail-closed guard THROWS — surfaced as a case failure, never skipped.
 *   4. compare: outcome (issue/hold + hold reason); on issue — Σ invoice lines === the quote's sell
 *      (independent integer re-sum), per-line kind/amount/line_no/gl_map equality against the quote's
 *      own lines, gl_map ACCOUNT TOTALS reconciling (grouped per account, and their sum === sell),
 *      and the optional pinned sell_cents.
 * Any throw inside a case (engine, payload parse, compose guard) is recorded as that case's mismatch —
 * one bad case never hides the rest of the run. Deterministic, no I/O.
 */
export function runInvoiceParity(
  cases: readonly InvoiceReplayCase[],
  config: TenantRatingConfig,
  priceFn: PriceFn = priceShipment,
): ReplayResult {
  const mismatches: ReplayMismatch[] = [];
  let passed = 0;

  for (const c of cases) {
    const before = mismatches.length;
    try {
      compareCase(c, config, priceFn, mismatches);
    } catch (err) {
      mismatches.push({
        name: c.name,
        field: "exception",
        expected: `outcome ${c.expect.outcome}`,
        actual: err instanceof Error ? err.message : String(err),
      });
    }
    if (mismatches.length === before) passed += 1;
  }

  return { total: cases.length, passed, mismatches };
}

function compareCase(
  c: InvoiceReplayCase,
  config: TenantRatingConfig,
  priceFn: PriceFn,
  mismatches: ReplayMismatch[],
): void {
  // 1. The REAL rater.
  const quote = priceFn(toRateRequest(c.request), config);
  if (quote.status !== "PRICED") {
    mismatches.push({ name: c.name, field: "quote.status", expected: "PRICED", actual: `UNKNOWN (${quote.reason})` });
    return;
  }

  // 2. The recorded quote.priced payload, built EXACTLY as rate.ts builds it (the wire shape the
  //    Biller projects from), through the same contracts Zod boundary.
  const recorded = QuotePricedPayload.parse({
    sell: quote.sell_cents,
    lines: quote.lines.map((l) => ({ kind: l.kind, code: l.code, amount_cents: l.amount_cents })),
    floors: quote.floors,
    versions: quote.versions,
    basis: { ...quote.basis, anomaly: quote.anomaly },
  });

  // 3. The REAL Biller composition. legs/tenant_party pass through verbatim (both, either, or
  //    neither) — compose's own fail-closed guards judge a partial signal, never this harness.
  const composed = composeInvoice({
    pod: { event_id: `pod-${c.name}`, shipment_id: `shp-${c.name}` },
    acceptedQuote: recorded,
    bill: {
      party_id: c.bill?.party_id ?? "party-bill-to",
      terms: c.bill?.terms ?? "prepaid",
      ...(c.bill?.third_party_id !== undefined ? { third_party_id: c.bill.third_party_id } : {}),
      ...(c.bill?.division !== undefined ? { division: c.bill.division } : {}),
    },
    invoiceId: `inv-${c.name}`,
    ...(c.legs !== undefined ? { legs: c.legs } : {}),
    ...(c.tenant_party !== undefined ? { tenantParty: c.tenant_party } : {}),
    ...(c.approval_granted !== undefined ? { approvalGranted: c.approval_granted } : {}),
  });

  // 4a. Outcome.
  const actualOutcome = composed.status === "issue" ? "issue" : "hold";
  if (actualOutcome !== c.expect.outcome) {
    mismatches.push({
      name: c.name,
      field: "outcome",
      expected: c.expect.outcome,
      actual: composed.status === "hold" ? `hold (${composed.reason})` : "issue",
    });
    return; // outcome diverged — the downstream fields are incomparable
  }
  if (composed.status === "hold") {
    if (c.expect.hold_reason !== undefined && composed.reason !== c.expect.hold_reason) {
      mismatches.push({ name: c.name, field: "hold_reason", expected: c.expect.hold_reason, actual: composed.reason });
    }
    return; // a hold composes no lines — nothing else to compare
  }

  // 4b. PENNY PARITY — the DoD line. Independent integer re-sum of the composed invoice lines against
  //     the quote's sell (defense-in-depth over compose's own postcondition: an exported runner must
  //     never depend on the thing under test to police itself).
  const lines = composed.payload.lines;
  const total = lines.reduce((sum, l) => sum + l.amount_cents, 0);
  if (total !== quote.sell_cents) {
    mismatches.push({ name: c.name, field: "sum(lines)", expected: quote.sell_cents, actual: total });
  }

  // 4c. PER-LINE equality: the invoice is the quote's VERBATIM projection — same count, same order,
  //     same kind, same amount, dense line_no, and the frozen GL account for its kind.
  if (lines.length !== quote.lines.length) {
    mismatches.push({ name: c.name, field: "lines.length", expected: quote.lines.length, actual: lines.length });
  } else {
    for (let i = 0; i < lines.length; i++) {
      const inv = lines[i]!;
      const q = quote.lines[i]!;
      if (inv.kind !== q.kind) {
        mismatches.push({ name: c.name, field: `lines[${i}].kind`, expected: q.kind, actual: inv.kind });
      }
      if (inv.amount_cents !== q.amount_cents) {
        mismatches.push({ name: c.name, field: `lines[${i}].amount_cents`, expected: q.amount_cents, actual: inv.amount_cents });
      }
      if (inv.line_no !== i + 1) {
        mismatches.push({ name: c.name, field: `lines[${i}].line_no`, expected: i + 1, actual: inv.line_no });
      }
      const expectedAccount = Object.hasOwn(GL_MAP, q.kind) ? GL_MAP[q.kind as keyof typeof GL_MAP] : undefined;
      if (inv.gl_map !== expectedAccount) {
        mismatches.push({ name: c.name, field: `lines[${i}].gl_map`, expected: expectedAccount, actual: inv.gl_map });
      }
    }
  }

  // 4d. GL RECONCILIATION: group both sides by GL account; every account's total must match, and the
  //     account totals must sum back to the sell — the same to-the-penny law the QB export lives under.
  const actualByAccount = new Map<string, number>();
  for (const l of lines) actualByAccount.set(l.gl_map, (actualByAccount.get(l.gl_map) ?? 0) + l.amount_cents);
  const expectedByAccount = new Map<string, number>();
  for (const q of quote.lines) {
    const account = GL_MAP[q.kind as keyof typeof GL_MAP];
    expectedByAccount.set(account, (expectedByAccount.get(account) ?? 0) + q.amount_cents);
  }
  for (const [account, expectedCents] of expectedByAccount) {
    if (actualByAccount.get(account) !== expectedCents) {
      mismatches.push({ name: c.name, field: `gl[${account}]`, expected: expectedCents, actual: actualByAccount.get(account) ?? 0 });
    }
  }
  for (const account of actualByAccount.keys()) {
    if (!expectedByAccount.has(account)) {
      mismatches.push({ name: c.name, field: `gl[${account}]`, expected: 0, actual: actualByAccount.get(account) });
    }
  }
  const glTotal = [...actualByAccount.values()].reduce((s, v) => s + v, 0);
  if (glTotal !== quote.sell_cents) {
    mismatches.push({ name: c.name, field: "sum(gl accounts)", expected: quote.sell_cents, actual: glTotal });
  }

  // 4e. The optional absolute anchor.
  if (c.expect.sell_cents !== undefined && quote.sell_cents !== c.expect.sell_cents) {
    mismatches.push({ name: c.name, field: "sell_cents", expected: c.expect.sell_cents, actual: quote.sell_cents });
  }
}

// ── The vendored-in-repo SMOKE SET — the harness's own liveness proof ─────────────────────────────────
// Synthetic, engagement-free (REQ-167): the numbers mirror the shape of the api test harness's
// TEST_RATE_CONFIG. Runs on EVERY invocation; a mismatch here is a hard failure of the composition
// path itself (rater → recorded payload → composeInvoice), independent of the pending 500-set.
// Hand-computed expectations: dest 800xx → Z5 → rg-far; dest 970xx → Z1 → rg-near.

export const SMOKE_CONFIG: TenantRatingConfig = {
  zone_tariff: ZoneTariff.parse({
    kind: "zone_tariff",
    id: "zt-invoice-smoke",
    version: "v1",
    zip_to_zone: { "800": "Z5", "970": "Z1" },
    rate_groups: [
      { id: "rg-near", zones: ["Z1"], breaks: [{ min_lb: 0, cwt_cents: 3800 }, { min_lb: 500, cwt_cents: 3200 }], min_charge_cents: 9500 },
      { id: "rg-far", zones: ["Z5"], breaks: [{ min_lb: 0, cwt_cents: 5200 }, { min_lb: 500, cwt_cents: 4500 }], min_charge_cents: 11500 },
    ],
  }),
  floors: FloorsConfig.parse({ kind: "floors", id: "fl-invoice-smoke", version: "v1", target_or_bps: 9800, full_cost_bps: 9200, contribution_bps: 8500 }),
  fsc: FscConfig.parse({ kind: "fsc", id: "fsc-invoice-smoke", version: "v1", pct_bps: 2400 }),
  accessorials: AccessorialSchedule.parse({
    kind: "accessorials",
    id: "acc-invoice-smoke",
    version: "v1",
    items: { liftgate: 3500, residential: 2500 },
  }),
};

const SMOKE_DIMS = { l_in: 48, w_in: 40, h_in: 48, pieces: 2 };

export const SMOKE_CASES: InvoiceReplayCase[] = [
  // freight 45_000 (1000 lb deficit-rated at the 500-lb break: 1000 × 4500/cwt) + fsc 10_800 (24%).
  {
    name: "direct-freight-fsc",
    request: { origin_zip: "97201", dest_zip: "80012", weight_lb: 1000, dims: SMOKE_DIMS },
    expect: { outcome: "issue", sell_cents: 55_800 },
  },
  // freight 27_000 (600 × 4500) + fsc 6_480 + liftgate 3_500 + residential 2_500 — a four-line
  // invoice whose gl reconciliation exercises the per-account GROUPING (two accessorial lines).
  {
    name: "multi-line-accessorials",
    request: { origin_zip: "97201", dest_zip: "80012", weight_lb: 600, dims: SMOKE_DIMS, accessorials: ["residential", "liftgate"] },
    expect: { outcome: "issue", sell_cents: 39_480 },
  },
  // MIN CHARGE: 100 lb as-rates to 3_800 (< the 9_500 group minimum) → freight floors at 9_500;
  // fsc 2_280. The min-charge path must project penny-exact like any other.
  {
    name: "min-charge-floors-the-freight",
    request: { origin_zip: "97201", dest_zip: "97035", weight_lb: 100, dims: SMOKE_DIMS },
    expect: { outcome: "issue", sell_cents: 11_780 },
  },
  // INTERLINE SPLIT, executing share CLEARS the floors (REQ-040 judged on the SHARE, never gross):
  // tenant executes 9000 bps of 55_800 = 50_220 ≥ target 44_100 (98% of cost 45_000) → issues, and the
  // invoice still projects the GROSS lines verbatim (the split is settlement's concern, not billing's).
  {
    name: "interline-executing-share-clears",
    request: { origin_zip: "97201", dest_zip: "80012", weight_lb: 1000, dims: SMOKE_DIMS },
    legs: [
      { kind: "delivery", executor: "party-carrier", split_bps: 9000 },
      { kind: "interline", executor: "party-partner", split_bps: 1000 },
    ],
    tenant_party: "party-carrier",
    expect: { outcome: "issue", sell_cents: 55_800 },
  },
  // INTERLINE BELOW FLOOR: the same gross clears every floor, but the tenant executes only 1000 bps
  // (5_580 < contribution 38_250) → HOLD below_floor. The Law-5 control case: the harness must see the
  // SHARE judged, never the gross — and a hold must never be blessed as an issue.
  {
    name: "interline-below-floor-holds",
    request: { origin_zip: "97201", dest_zip: "80012", weight_lb: 1000, dims: SMOKE_DIMS },
    legs: [
      { kind: "delivery", executor: "party-carrier", split_bps: 1000 },
      { kind: "interline", executor: "party-partner", split_bps: 9000 },
    ],
    tenant_party: "party-carrier",
    expect: { outcome: "hold", hold_reason: "below_floor" },
  },
].map((c) => InvoiceReplayCase.parse(c));

// ── The CLI ────────────────────────────────────────────────────────────────────────────────────────────
// Vendored inputs the 500-replay gate needs (engagement-workspace fixtures, currently pending):
//   • cases: fixtures/invoice-replay/ — JSON InvoiceReplayCase files (one case per file, or an array
//     per file — both accepted), exactly 500 cases total.
//   • tenant-0 config: fixtures/tariff/ — the SAME vendored tariff the rater parity gate prices with
//     (one JSON per rate_config kind; see tools/rater/README.md).

const EXPECTED_REPLAY_CASES = 500; // the WP-06 DoD pins the set's size: a short/over/empty set never greens
const REPLAY_DIR = "fixtures/invoice-replay";
const CONFIG_DIR = "fixtures/tariff";
const CONFIG_FILES = {
  zone_tariff: "zone_tariff.json",
  floors: "floors.json",
  fsc: "fsc.json",
  accessorials: "accessorials.json",
  class_adapter: "class_adapter.json", // optional
} as const;
// Both rows must be vendored + hash-pinned to activate: the replay cases AND the tenant-0 tariff they
// price against (a replay against an unpinned tariff proves nothing about tenant-0 invoices).
const REPLAY_FIXTURE_IDS = ["invoice-500-replay", "zone-tariff-v1"] as const;

type ManifestEntry = { id: string; status: string; path: string; sha256: string | null; source: string };
type Manifest = { fixtures: ManifestEntry[] };

// The vendored + hash-pin gate (same anti-fabrication law as parity.ts's verifyParityPins): a set that
// is PRESENT on disk may activate/green ONLY if the manifest marks it vendored with a non-null sha256
// AND the on-disk bytes hash to that pin. Present-but-unvendored/unpinned/mismatched ⇒ REAL discrepancy.
export function verifyReplayPins(
  rows: readonly { id: string; status: string; path: string; sha256: string | null }[],
  hashFn: (p: string) => string = hashPath,
  existsFn: (p: string) => boolean = existsSync,
): string[] {
  const problems: string[] = [];
  for (const id of REPLAY_FIXTURE_IDS) {
    const row = rows.find((r) => r.id === id);
    if (row === undefined) {
      problems.push(`${id}: no manifest row (the WP-06 DoD replay requires it vendored)`);
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

function loadCases(dir: string): InvoiceReplayCase[] {
  const out: InvoiceReplayCase[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
    const raw = readJson(join(dir, f));
    const items = Array.isArray(raw) ? raw : [raw];
    for (const item of items) out.push(InvoiceReplayCase.parse(item));
  }
  return out;
}

function printMismatches(mismatches: readonly ReplayMismatch[]): void {
  for (const m of mismatches) {
    console.error(`  MISMATCH ${m.name} · ${m.field}: expected ${JSON.stringify(m.expected)} got ${JSON.stringify(m.actual)}`);
  }
}

function main(): void {
  const mode = parseMode(process.argv.slice(2));
  // ── 1. SMOKE — always runs; the harness's liveness proof. A failure here is the composition path
  //       itself drifting (rater → recorded payload → composeInvoice) and blocks regardless of the
  //       pending 500-set. Its green line is worded as SMOKE — it is never the DoD claim.
  const smoke = runInvoiceParity(SMOKE_CASES, SMOKE_CONFIG);
  if (smoke.mismatches.length > 0) {
    printMismatches(smoke.mismatches);
    console.error(
      "INVOICE PARITY SMOKE FAILED — the invoice composition diverges from the rater on the vendored-in-repo smoke set (REQ-031). No merge.",
    );
    process.exit(1);
  }
  console.log(
    `invoice parity smoke — ${smoke.passed}/${smoke.total} in-repo synthetic cases: invoice === rater, penny for penny (harness live; NOT the 500-replay DoD)`,
  );

  // ── 2. THE 500-REPLAY GATE — engagement-workspace fixtures, pending until vendored + hash-pinned.
  const manifest = JSON.parse(readFileSync("fixtures/manifest.json", "utf8")) as Manifest;
  const rows = manifest.fixtures.filter((e) => (REPLAY_FIXTURE_IDS as readonly string[]).includes(e.id));
  const casesPresent = hasJsonFiles(REPLAY_DIR);
  const configOk = configPresent(CONFIG_DIR);
  const present = casesPresent && configOk;

  // HALF-VENDORED GUARD: replay case files on disk with NO tenant-0 tariff to price against is a
  // partial vendoring — the harness has nothing honest to run them through, and quietly PENDING-
  // skipping would leave dropped-but-unusable case bytes invisible. Loud hard failure (exit 1).
  // The INVERSE (tariff present, replay cases absent) is DELIBERATELY not a failure: the tariff
  // co-vendors with the RATER parity set, which legitimately activates before the invoice replay
  // set arrives — hard-failing that state would turn the verify chain red the day the rater
  // fixtures land, on nothing wrong. It stays pending below, with the tariff's on-disk presence
  // printed per-row so the lag is visible, and the dormancy guard still refuses a vendored CLAIM.
  if (casesPresent && !configOk) {
    console.error(
      "INVOICE PARITY FAILED — replay case files are PRESENT at fixtures/invoice-replay/ but the tenant-0 tariff (fixtures/tariff/) is absent or incomplete: a half-vendored set has nothing to price against and must never quietly PENDING-skip.",
    );
    console.error(
      "Vendor the tariff (layout in tools/rater/README.md) alongside the case files — or remove the stray case files. No silent partial vendoring.",
    );
    process.exit(1);
  }

  if (!present) {
    // DORMANCY GUARD (mirrors parity.ts): a manifest that claims the REPLAY SET is vendored while the
    // harness cannot find its files would leave this gate silently OFF — refuse. (zone-tariff-v1 alone
    // being vendored is legitimate: the rater parity gate may activate before the invoice replay does.)
    const replayRow = rows.find((e) => e.id === "invoice-500-replay");
    if (replayRow !== undefined && replayRow.status === "vendored") {
      console.error(
        "INVOICE PARITY FAILED — the manifest marks invoice-500-replay as VENDORED but the harness cannot find the files it names; the gate would be silently OFF:",
      );
      console.error(
        `  - invoice-500-replay [vendored] path=${replayRow.path} (${existsSync(replayRow.path) ? "path exists but the expected case/config files are missing" : "path MISSING"}) source=${replayRow.source}`,
      );
      console.error(
        "A vendored claim must be honorable: vendor the case files (and the tenant-0 tariff at fixtures/tariff/), or revert the manifest status. No silent dormancy.",
      );
      process.exit(1);
    }

    // PENDING — the current reality. Loud, advisory, NEVER a false green.
    console.warn(
      `INVOICE PARITY PENDING (${rows.length}) — the 500-quote invoice replay set + tenant-0 tariff are NOT vendored in this repo; these are engagement-workspace fixtures:`,
    );
    for (const e of rows) {
      const onDisk = existsSync(e.path) ? "present on disk" : "absent on disk";
      console.warn(`  - ${e.id} [${e.status}] path=${e.path} (${onDisk}) source=${e.source}`);
    }
    console.warn(
      "INVOICE PARITY PENDING — vendor the engagement fixtures into fixtures/invoice-replay and fixtures/tariff to activate the WP-06 DoD gate (invoice math matches Rater to the penny on 500-fixture replay). Advisory (exit 0) until then.",
    );
    // REQ-288: local stays advisory (PENDING, exit 0); merge/release BLOCKS (exit 2) on the absent
    // private replay set — a release gate never greens on absent DoD data.
    const { status, exitCode } = unavailableStatus(mode);
    if (mode !== "local") {
      console.error(`invoice-parity: BLOCKED under --mode ${mode} — the 500-quote replay set is not vendored; no promotion on absent private fixtures.`);
    }
    console.log(formatGateResult({ gate: "invoice-parity", status, executed: false, assertions: 0, detail: "engagement fixtures not vendored (fixtures/invoice-replay, fixtures/tariff)" }));
    process.exit(exitCode);
  }

  // PRESENT — but presence is NOT a pass: require vendored + hash-pinned, exactly like the rater gate.
  const pinProblems = verifyReplayPins(rows);
  if (pinProblems.length > 0) {
    console.error(
      "INVOICE PARITY FAILED — replay case files are PRESENT but the set is not vendored + hash-pinned; a present-but-unpinned set is a real discrepancy, never a pass:",
    );
    for (const p of pinProblems) console.error(`  - ${p}`);
    console.error(
      'Vendor the set through the manifest: status:"vendored" with a sha256 matching the on-disk bytes. No self-consistent false green.',
    );
    process.exit(1);
  }

  // Vendored + pinned confirmed — the real gate. A 0/short/over load is SURFACED, never blessed.
  const config = loadConfig(CONFIG_DIR);
  const cases = loadCases(REPLAY_DIR);
  if (cases.length !== EXPECTED_REPLAY_CASES) {
    console.error(
      `INVOICE PARITY FAILED — fixtures/invoice-replay/ yielded ${cases.length} cases; the WP-06 DoD pins exactly ${EXPECTED_REPLAY_CASES}. A short/over/empty set is a real discrepancy, not a pass. No merge.`,
    );
    process.exit(1);
  }

  const result = runInvoiceParity(cases, config);
  console.log(`invoice parity — ${result.passed}/${result.total} replay cases: invoice === rater, penny for penny`);
  if (result.mismatches.length > 0) {
    printMismatches(result.mismatches);
    console.error("INVOICE PARITY FAILED — the invoice diverges from the rater on the 500-fixture replay (REQ-031 / WP-06 DoD). No merge.");
    console.log(formatGateResult({ gate: "invoice-parity", status: "FAIL", executed: true, assertions: result.total, detail: `${result.mismatches.length} mismatch(es) vs the rater` }));
    process.exit(1);
  }
  console.log(
    `INVOICE PARITY GREEN — WP-06 DoD reproduced: invoice math matches the Rater to the penny on the ${EXPECTED_REPLAY_CASES}-fixture replay.`,
  );
  console.log(formatGateResult({ gate: "invoice-parity", status: "PASS", executed: true, assertions: result.total, detail: "WP-06 DoD reproduced penny-for-penny" }));
}

if (process.argv[1]?.endsWith("invoice-parity.ts")) main();
