// Deterministic generator for the qb-journal-month fixture (the WP-11 Task-3 / REQ-020 DoD: "Export
// reconciles a fixture month to the penny"). NO Date.now / NO Math.random — event ids/hashes come from
// a monotonic counter, every amount from a SEEDED mulberry32 + integer arithmetic. Run it twice and the
// bytes are identical. Output: fixtures/qb/seed.json.
//
//   pnpm tsx tools/fixtures/gen-qb-journal-month.ts
//
// A realistic synthetic MONTH for ONE tenant: dozens of invoices (freight/fsc/accessorial AR lines on
// the CANONICAL -AR chart-of-accounts), settling ACH payments (flip an invoice to paid; post NO journal
// line), COD collects (negative AR to the 1300 clearing account), interline splits (AP), and settlement
// fees (AP). A spread of divisions (REQ-057). The derived control totals are computed HERE as literals
// the test pins to the penny; because the money projection + exportJournal are balanced by construction,
// the corrected ledger reconciles: AR control ↔ revenue+clearing, AP control ↔ interline+settle.
//
// REQ-020 — the fixture replays the CANONICAL account codes the compose path emits on a real
// invoice.issued (the -AR revenue accounts), drawn from the ONE canonical registry so the fixture cannot
// drift from the Biller GL_MAP / money projection. REQ-167 — synthetic party ids / invoice ids only.
// NOTE: settlement.executed is a CONFIRM-gated (do-not-build) feature; these fee events exist ONLY to
// exercise the money projection's already-shipped settle_fee branch in this in-repo test (no live flow).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GL_FREIGHT_AR, GL_FSC_AR, GL_ACCESSORIAL_AR } from "@shuddl/contracts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SeedInvoiceLine {
  line_no: number;
  kind: "freight" | "fsc" | "accessorial";
  amount_cents: number;
  gl_map: string;
}
interface SeedAllocation {
  party_id: string;
  share_bps: number;
}
interface SeedEvent {
  id: string;
  hash: string;
  stream_id: string;
  shipment_id: string;
  seq: number;
  division: string;
  ts: number;
  recorded_at: number;
  kind: "invoice.issued" | "payment.received" | "split.computed" | "settlement.executed";
  invoice_id?: string;
  party_id?: string;
  lines?: SeedInvoiceLine[];
  method?: "cod" | "ach";
  amount_cents?: number;
  settles_invoice_id?: string;
  total_cents?: number;
  allocations?: SeedAllocation[];
  fee_cents?: number;
}

const SEED = 0x5148_2026;
const DIVISIONS = ["north", "south", "east", "west"];
const DAY_MS = 86_400_000;
// An arbitrary FIXED synthetic month start (deterministic — the wall-clock date is irrelevant; only that
// it never moves). Every event's recorded_at lands inside [MONTH_START, MONTH_START + 30 days).
const MONTH_START = 1_748_736_000_000;
const INVOICES = 36; // dozens of invoices across the month (REQ-057: a spread of divisions)
const COD_COLLECTS = 8;
const SPLITS = 10;
const SETTLE_FEES = 6;
const ACCESSORIAL_MENU = [7_500, 5_500, 12_000, 9_000]; // liftgate / residential / detention / inside

interface Built {
  ar_revenue_cents: number;
  cod_collect_cents: number;
  ar_control_net_cents: number;
  ap_total_cents: number;
  invoice_count: number;
  settled_count: number;
  cod_count: number;
  split_count: number;
  settle_fee_count: number;
  range_from: number;
  range_to: number;
  divisions: string[];
  events: SeedEvent[];
}

function build(): Built {
  const rnd = mulberry32(SEED);
  let counter = 0;
  const nextIds = (): { id: string; hash: string } => {
    counter += 1;
    const hex = counter.toString(16);
    return { id: `00000000-0000-4000-8000-${hex.padStart(12, "0")}`, hash: hex.padStart(64, "0") };
  };
  let order = 0;
  // Spread events across the 30-day month deterministically; created_ts collisions are legal (the
  // event PK is stream_id+seq, not the clock), so the day bucket + a per-event nudge is all we need.
  const stamp = (): { ts: number; recorded_at: number } => {
    const o = order;
    order += 1;
    const recorded_at = MONTH_START + (o % 30) * DAY_MS + o * 1_000;
    return { recorded_at, ts: recorded_at - 500 };
  };

  const events: SeedEvent[] = [];
  let ar_revenue_cents = 0;
  let cod_collect_cents = 0;
  let ap_total_cents = 0;
  let settled_count = 0;

  // Invoices (+ a settling ACH payment on every other invoice — some open, some paid).
  for (let i = 0; i < INVOICES; i++) {
    const division = DIVISIONS[i % DIVISIONS.length] ?? "north";
    const party_id = `party-bill-${i}`;
    const shipment_id = `shp-inv-${i}`;
    const stream_id = `s:${shipment_id}`;
    const invoice_id = `inv-${i}`;
    const freight = 20_000 + Math.floor(rnd() * 180_001); // $200.00 .. $2000.01
    const fscBps = 1_800 + Math.floor(rnd() * 700); // 18.00% .. 24.99% of freight
    const fsc = Math.floor((freight * fscBps) / 10_000); // integer cents (no float)
    const lines: SeedInvoiceLine[] = [
      { line_no: 1, kind: "freight", amount_cents: freight, gl_map: GL_FREIGHT_AR },
      { line_no: 2, kind: "fsc", amount_cents: fsc, gl_map: GL_FSC_AR },
    ];
    if (rnd() < 0.66) {
      const acc = ACCESSORIAL_MENU[Math.floor(rnd() * ACCESSORIAL_MENU.length)] ?? 7_500;
      lines.push({ line_no: 3, kind: "accessorial", amount_cents: acc, gl_map: GL_ACCESSORIAL_AR });
    }
    const total = lines.reduce((s, l) => s + l.amount_cents, 0);
    ar_revenue_cents += total;

    const issue = nextIds();
    const t1 = stamp();
    events.push({ ...issue, stream_id, shipment_id, seq: 0, division, ts: t1.ts, recorded_at: t1.recorded_at, kind: "invoice.issued", invoice_id, party_id, lines });

    if (i % 2 === 0) {
      const pay = nextIds();
      const t2 = stamp();
      // An ACH payment that COVERS the invoice: the projection flips it to 'paid' and posts NO money
      // line (SHUDDL's journal has no cash account beyond COD clearing — AR settlement is read-model only).
      events.push({ ...pay, stream_id, shipment_id, seq: 1, division, ts: t2.ts, recorded_at: t2.recorded_at, kind: "payment.received", method: "ach", amount_cents: total, party_id, settles_invoice_id: invoice_id });
      settled_count += 1;
    }
  }

  // COD collects — cash at the door: a NEGATIVE AR line to the 1300-COD-CLEARING account.
  for (let j = 0; j < COD_COLLECTS; j++) {
    const division = DIVISIONS[j % DIVISIONS.length] ?? "north";
    const shipment_id = `shp-cod-${j}`;
    const stream_id = `s:${shipment_id}`;
    const party_id = `party-cod-${j}`;
    const amount = 15_000 + Math.floor(rnd() * 85_001); // $150.00 .. $1000.01
    cod_collect_cents += amount;
    const ids = nextIds();
    const t = stamp();
    events.push({ ...ids, stream_id, shipment_id, seq: 0, division, ts: t.ts, recorded_at: t.recorded_at, kind: "payment.received", method: "cod", amount_cents: amount, party_id });
  }

  // Interline splits — AP owed to executing carriers (5000-INTERLINE-AP). allocateCents is penny-exact,
  // so the AP lines of a split sum to EXACTLY total_cents (asserted in the projection postcondition).
  for (let k = 0; k < SPLITS; k++) {
    const division = DIVISIONS[k % DIVISIONS.length] ?? "north";
    const shipment_id = `shp-split-${k}`;
    const stream_id = `s:${shipment_id}`;
    const total = 30_000 + Math.floor(rnd() * 120_001); // $300.00 .. $1500.01
    ap_total_cents += total;
    const shape = k % 3;
    const allocations: SeedAllocation[] =
      shape === 0
        ? [{ party_id: `party-carrier-${k}`, share_bps: 7_000 }, { party_id: `party-interline-${k}`, share_bps: 3_000 }]
        : shape === 1
          ? [{ party_id: `party-carrier-${k}`, share_bps: 6_000 }, { party_id: `party-interline-${k}`, share_bps: 4_000 }]
          : [{ party_id: `party-carrier-${k}`, share_bps: 5_000 }, { party_id: `party-interline-${k}`, share_bps: 3_000 }, { party_id: `party-cartage-${k}`, share_bps: 2_000 }];
    const ids = nextIds();
    const t = stamp();
    events.push({ ...ids, stream_id, shipment_id, seq: 0, division, ts: t.ts, recorded_at: t.recorded_at, kind: "split.computed", total_cents: total, allocations });
  }

  // Settlement fees — AP (5100-SETTLEMENT-FEE). CONFIRM-gated projection branch, exercised synthetically.
  for (let m = 0; m < SETTLE_FEES; m++) {
    const division = DIVISIONS[m % DIVISIONS.length] ?? "north";
    const shipment_id = `shp-settle-${m}`;
    const stream_id = `s:${shipment_id}`;
    const party_id = `party-settle-${m}`;
    const fee = 2_500 + Math.floor(rnd() * 7_501); // $25.00 .. $100.01
    ap_total_cents += fee;
    const ids = nextIds();
    const t = stamp();
    events.push({ ...ids, stream_id, shipment_id, seq: 0, division, ts: t.ts, recorded_at: t.recorded_at, kind: "settlement.executed", fee_cents: fee, party_id });
  }

  return {
    ar_revenue_cents,
    cod_collect_cents,
    ar_control_net_cents: ar_revenue_cents - cod_collect_cents,
    ap_total_cents,
    invoice_count: INVOICES,
    settled_count,
    cod_count: COD_COLLECTS,
    split_count: SPLITS,
    settle_fee_count: SETTLE_FEES,
    range_from: MONTH_START,
    range_to: MONTH_START + 31 * DAY_MS,
    divisions: DIVISIONS,
    events,
  };
}

function main(): void {
  const built = build();
  const seed = {
    generated_by: "tools/fixtures/gen-qb-journal-month.ts",
    note: "WP-11 Task-3 / REQ-020 DoD (QB journal export reconciles a month to the penny). Deterministic (mulberry32, fixed ids). Do not hand-edit — regenerate.",
    seed: SEED,
    ...built,
  };
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const outPath = join(root, "fixtures", "qb", "seed.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(seed, null, 2) + "\n");
  process.stdout.write(
    `wrote ${outPath}\n  events=${built.events.length} ar_revenue_cents=${built.ar_revenue_cents} cod_collect_cents=${built.cod_collect_cents} ar_control_net_cents=${built.ar_control_net_cents} ap_total_cents=${built.ap_total_cents} settled=${built.settled_count}\n`,
  );
}

main();
