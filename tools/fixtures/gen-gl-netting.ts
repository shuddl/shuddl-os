// Deterministic generator for the GL netting fixture (the WP-02 I7 DoD). NO Date.now / NO
// Math.random — event ids/hashes come from a monotonic counter, correction deltas from a SEEDED
// mulberry32. Run it twice and the bytes are identical. Output: fixtures/gl-netting/seed.json.
//
//   pnpm tsx tools/fixtures/gen-gl-netting.ts
//
// 20 shipments; shipment i has freight = 10_000 + i*137 cents plus literal fsc/accessorial lines.
// Shipments 3/7/11/15 get a round-trip pair of corrections: correct to a new freight amount, then
// correct back to the originals. The uncorrected grand total is computed here (a literal the test
// pins to the penny) — because each round-trip nets to zero, the corrected ledger must reconcile.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// REQ-020 — the fixture must replay the CANONICAL account codes the compose path emits on a real
// invoice.issued (the -AR revenue accounts), NOT its own bare codes; otherwise the Task-3 QB
// chart-of-accounts reconcile breaks. Drawn from the ONE canonical registry so the fixture cannot
// drift from the Biller GL_MAP again (the gl-accounts parity test guards it).
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

interface SeedLine {
  line_no: number;
  kind: "freight" | "fsc" | "accessorial";
  amount_cents: number;
  gl_map: string;
}
interface SeedEvent {
  id: string;
  hash: string;
  stream_id: string;
  shipment_id: string;
  seq: number;
  division: string;
  party_id: string;
  invoice_id: string;
  kind: "invoice.issued" | "invoice.corrected";
  lines?: SeedLine[];
  corrects_event_id?: string;
  reissue_lines?: SeedLine[];
}

const SEED = 0x51a5_2026;
const SHIPMENTS = 20;
const CORRECTED = new Set([3, 7, 11, 15]);
const DIVISIONS = ["north", "south", "east", "west"];
const FSC_CENTS = 2_500;
const ACCESSORIAL_CENTS = 1_500;

function build(): { uncorrected_total_cents: number; events: SeedEvent[] } {
  const rnd = mulberry32(SEED);
  let counter = 0;
  const nextIds = (): { id: string; hash: string } => {
    counter += 1;
    const hex = counter.toString(16);
    return { id: `00000000-0000-4000-8000-${hex.padStart(12, "0")}`, hash: hex.padStart(64, "0") };
  };

  const events: SeedEvent[] = [];
  let uncorrected = 0;

  for (let i = 0; i < SHIPMENTS; i++) {
    const freight = 10_000 + i * 137;
    const division = DIVISIONS[i % DIVISIONS.length] ?? "north";
    const party_id = `party-bill-${i}`;
    const shipment_id = `shp-${i}`;
    const stream_id = `s:${shipment_id}`;
    const invoice_id = `inv-${i}`;
    const originals: SeedLine[] = [
      { line_no: 1, kind: "freight", amount_cents: freight, gl_map: GL_FREIGHT_AR },
      { line_no: 2, kind: "fsc", amount_cents: FSC_CENTS, gl_map: GL_FSC_AR },
      { line_no: 3, kind: "accessorial", amount_cents: ACCESSORIAL_CENTS, gl_map: GL_ACCESSORIAL_AR },
    ];
    uncorrected += freight + FSC_CENTS + ACCESSORIAL_CENTS;

    const issue = nextIds();
    events.push({ ...issue, stream_id, shipment_id, seq: 0, division, party_id, invoice_id, kind: "invoice.issued", lines: originals });

    if (CORRECTED.has(i)) {
      const delta = 1 + Math.floor(rnd() * 5_000); // seeded, non-zero bump to the freight line
      const bumped: SeedLine[] = [
        { line_no: 1, kind: "freight", amount_cents: freight + delta, gl_map: GL_FREIGHT_AR },
        { line_no: 2, kind: "fsc", amount_cents: FSC_CENTS, gl_map: GL_FSC_AR },
        { line_no: 3, kind: "accessorial", amount_cents: ACCESSORIAL_CENTS, gl_map: GL_ACCESSORIAL_AR },
      ];
      const c1 = nextIds();
      events.push({ ...c1, stream_id, shipment_id, seq: 1, division, party_id, invoice_id, kind: "invoice.corrected", corrects_event_id: issue.id, reissue_lines: bumped });
      const c2 = nextIds();
      // Correct BACK to the originals -> the round-trip nets to zero.
      events.push({ ...c2, stream_id, shipment_id, seq: 2, division, party_id, invoice_id, kind: "invoice.corrected", corrects_event_id: c1.id, reissue_lines: originals });
    }
  }

  return { uncorrected_total_cents: uncorrected, events };
}

function main(): void {
  const { uncorrected_total_cents, events } = build();
  const seed = {
    generated_by: "tools/fixtures/gen-gl-netting.ts",
    note: "WP-02 I7 DoD. Deterministic (mulberry32, fixed ids). Do not hand-edit — regenerate.",
    seed: SEED,
    uncorrected_total_cents,
    corrected_shipments: [...CORRECTED],
    divisions: DIVISIONS,
    events,
  };
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const outPath = join(root, "fixtures", "gl-netting", "seed.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(seed, null, 2) + "\n");
  process.stdout.write(`wrote ${outPath}\n  events=${events.length} uncorrected_total_cents=${uncorrected_total_cents}\n`);
}

main();
