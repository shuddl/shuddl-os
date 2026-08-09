import { describe, expect, it } from "vitest";
import {
  mapSpreadsheet,
  resolveColumnMapping,
  parseSheet,
  normalizeHeader,
  CONFIDENCE_FLOOR,
} from "../src/index.js";
import brokerLoads from "../../../fixtures/migrator/broker-loads.csv?raw";
import messyShipments from "../../../fixtures/migrator/messy-shipments.csv?raw";
import tlDispatch from "../../../fixtures/migrator/tl-dispatch.csv?raw";
import collidingHeaders from "../../../fixtures/migrator/colliding-headers.csv?raw";
import laneRates from "../../../fixtures/migrator/lane-rates.csv?raw";

// REQ-127 / REQ-035 (WP-14 Task 5) — the PURE Migrator core. These tests exercise the LAW directly on the
// deterministic mapper: no worker, no D1, no ledger. THE gap-row no-silent-drop law lives here; the worker
// (import.test.ts) proves it persists exactly one anomaly per gap row and stays tenant-scoped + idempotent.

const FILES = { brokerLoads, messyShipments, tlDispatch } as const;

describe("parseSheet — a real messy CSV becomes aligned rows (BOM, quoted commas, blank cells)", () => {
  it("strips a leading BOM and honors quoted fields containing commas", () => {
    const sheet = parseSheet(tlDispatch);
    expect(sheet.headers[0]).toBe("Bill To"); // BOM stripped — not "﻿Bill To"
    // "Orion Freight, LLC" is ONE field, and "Beta Foods, Inc." is one field despite the embedded commas.
    expect(sheet.rows[0]?.[0]).toBe("Orion Freight, LLC");
    expect(sheet.rows[0]?.[2]).toBe("Beta Foods, Inc.");
    // Every row is aligned to the header width (a short/ragged row is padded — never desynced from its column).
    for (const row of sheet.rows) expect(row).toHaveLength(sheet.headers.length);
  });

  it("normalizeHeader is deterministic and collapses punctuation/case/spacing", () => {
    expect(normalizeHeader("PRO #")).toBe("pro");
    expect(normalizeHeader("Ship-To Name")).toBe("ship_to_name");
    expect(normalizeHeader("﻿Customer")).toBe("customer");
  });
});

describe("mapSpreadsheet — pure + deterministic", () => {
  it("the same (sheet, mapping) yields a byte-identical result twice", () => {
    for (const raw of Object.values(FILES)) {
      const sheet = parseSheet(raw);
      expect(mapSpreadsheet(sheet)).toEqual(mapSpreadsheet(sheet));
    }
  });

  it("all three messy files produce parties + shipments", () => {
    for (const raw of Object.values(FILES)) {
      const r = mapSpreadsheet(parseSheet(raw));
      expect(r.parties.length).toBeGreaterThan(0);
      expect(r.shipments.length).toBeGreaterThan(0);
    }
  });
});

describe("THE LAW — no silent drop: every unmapped column raises exactly one gap row", () => {
  it("broker-loads: Phone + Special Instructions + Salesperson each raise ONE unmapped gap row", () => {
    const sheet = parseSheet(brokerLoads);
    const r = mapSpreadsheet(sheet);

    // Independently compute the unmapped columns from the plan, then assert the count matches the gap rows.
    const plans = resolveColumnMapping(sheet.headers);
    const unmappedCols = plans.filter((p) => p.decision === "unmapped").map((p) => p.header);
    expect(unmappedCols.sort()).toEqual(["Phone", "Salesperson", "Special Instructions"]);

    const unmappedGaps = r.gapRows.filter((g) => g.reason === "unmapped");
    expect(unmappedGaps.map((g) => g.column).sort()).toEqual(unmappedCols.sort());
    // EXACTLY one gap row per unmapped column — no duplicates, no drops.
    expect(unmappedGaps).toHaveLength(unmappedCols.length);
    for (const g of unmappedGaps) expect(g.sample).not.toBeNull(); // every gap carries a human sample
  });
});

describe("THE LAW — a below-floor mapping is routed to review, NEVER silently applied", () => {
  it("messy-shipments: Zip + Reference (0.5) become low_confidence gaps and are NOT applied to their fields", () => {
    const sheet = parseSheet(messyShipments);
    const r = mapSpreadsheet(sheet);

    const low = r.gapRows.filter((g) => g.reason === "low_confidence");
    expect(low.map((g) => g.column).sort()).toEqual(["Reference", "Zip"]);
    for (const g of low) expect(g.confidence).toBeLessThan(CONFIDENCE_FLOOR);
    // Zip suspected origin_zip, Reference suspected pro — but NEITHER canonical field was applied.
    expect(r.fieldConfidence["origin_zip"]).toBeUndefined();
    expect(r.fieldConfidence["pro"]).toBeUndefined();
    // The high-confidence columns DID apply.
    expect(r.fieldConfidence["dest_zip"]).toBe(1);
    expect(r.fieldConfidence["bill_to_name"]).toBeGreaterThanOrEqual(CONFIDENCE_FLOOR);

    // Commodity is a genuinely unmapped column → an unmapped gap (distinct from the two low-confidence gaps).
    expect(r.gapRows.filter((g) => g.reason === "unmapped").map((g) => g.column)).toEqual(["Commodity"]);
  });
});

describe("nothing lost — retained values ride refs (shipment) / external_refs (party)", () => {
  it("broker-loads: unmapped shipment values ride refs; a party-scoped Phone rides the bill_to external_refs", () => {
    const r = mapSpreadsheet(parseSheet(brokerLoads));
    const row0 = r.shipments[0]!;
    // The canonical refs are applied…
    expect(row0.refs["pro"]).toBe("PRO123456");
    expect(row0.refs["bol"]).toBe("BOL9987");
    expect(row0.refs["weight_lb"]).toBe("1200");
    // …and the UNMAPPED column values are retained under their original header (never dropped).
    expect(row0.refs["Special Instructions"]).toBe("Liftgate, call ahead");
    expect(row0.refs["Salesperson"]).toBe("Dana");
    // Mode normalized to a valid enum value.
    expect(row0.mode).toBe("LTL");
    expect(r.shipments[1]?.mode).toBe("TL"); // "Truckload" → TL

    // The party-scoped Phone rode the bill_to party's external_refs, NOT the shipment refs.
    expect(row0.refs["Phone"]).toBeUndefined();
    const acme = r.parties.find((p) => p.name === "Acme Distributing");
    expect(acme?.role).toBe("bill_to");
    expect(acme?.external_refs["Phone"]).toBe("555-0100");
    expect(acme?.email).toBe("ops@acme.example");
  });

  it("an unrecognized mode VALUE is retained on refs (never lost) and the shipment stays mode-less", () => {
    const sheet = parseSheet("Customer,Mode\nAcme,SPRINTER VAN\n");
    const r = mapSpreadsheet(sheet);
    expect(r.shipments[0]?.mode).toBeUndefined();
    expect(r.shipments[0]?.refs["mode_raw"]).toBe("SPRINTER VAN");
  });
});

describe("dedup + party roles", () => {
  it("tl-dispatch: distinct shipper/consignee/bill_to parties; a repeated shipper dedupes to one", () => {
    const r = mapSpreadsheet(parseSheet(tlDispatch));
    expect(r.shipments).toHaveLength(2);
    // 5 unique parties across 2 rows (Acme Plant is the shipper in BOTH rows → one party).
    expect(r.parties).toHaveLength(5);
    const acme = r.parties.filter((p) => p.name === "Acme Plant");
    expect(acme).toHaveLength(1);
    expect(acme[0]?.role).toBe("shipper");
    expect(acme[0]?.kind).toBe("shipper");
  });
});

describe("rate sheet detection (→ the Task-4 tariff path)", () => {
  it("a rate/margin sheet with NO party columns yields a rateConfig hint, not parties/shipments", () => {
    const sheet = parseSheet("Market Rate Cents Per Cwt,Margin Bps\n3600,1900\n");
    const r = mapSpreadsheet(sheet);
    expect(r.rateConfig).toEqual({ marketRateCentsPerCwt: 3600, marginBps: 1900 });
    expect(r.parties).toHaveLength(0);
    expect(r.shipments).toHaveLength(0);
  });

  it("a normal import (has party columns) is NEVER mistaken for a rate sheet", () => {
    expect(mapSpreadsheet(parseSheet(brokerLoads)).rateConfig).toBeUndefined();
  });

  it("THE LAW — a rate sheet flags EVERY non-rate column + the unconsumed rows (no silent drop)", () => {
    const sheet = parseSheet(laneRates);
    const r = mapSpreadsheet(sheet);
    // The intentional single-flat-rate seed is preserved.
    expect(r.rateConfig).toEqual({ marketRateCentsPerCwt: 3600, marginBps: 1900 });
    // Consumed: market_rate + margin_bps (2 cols). Flagged: the other 5 columns + 1 unconsumed-rows gap.
    const consumed = ["market_rate", "margin_bps"];
    const nonRate = sheet.headers.filter((h) => !consumed.includes(h));
    expect(nonRate).toHaveLength(5);
    expect(r.gapRows).toHaveLength(nonRate.length + 1);
    const flagged = new Set(r.gapRows.map((g) => g.column));
    for (const h of nonRate) expect(flagged.has(h), `missing gap for ${h}`).toBe(true);
    // The consumed rate/margin headers are NOT flagged (they seeded the tariff, not dropped).
    for (const h of consumed) expect(flagged.has(h)).toBe(false);
    // Exactly one "rows beyond the first" gap, carried on a synthetic ordinal past the real columns.
    expect(r.gapRows.filter((g) => g.columnOrdinal >= sheet.headers.length)).toHaveLength(1);
    // Every gap is reason 'unmapped' (the flat seed consumed neither the lane columns nor the extra rows).
    for (const g of r.gapRows) expect(g.reason).toBe("unmapped");
  });
});

describe("THE LAW — prototype-safe retention (a __proto__ column keeps its value)", () => {
  it("a __proto__-headed column emits a gap AND retains its value (no silent drop, no pollution)", () => {
    const r = mapSpreadsheet(parseSheet("Customer,__proto__\nAcme,danger\n"));
    // The gap row still fires (the column is unmapped)…
    const gap = r.gapRows.find((g) => g.column === "__proto__");
    expect(gap?.reason).toBe("unmapped");
    // …AND the value is RETAINED as an own property under the __proto__ key (not swallowed by the prototype setter).
    const refs = r.shipments[0]!.refs;
    expect(Object.prototype.hasOwnProperty.call(refs, "__proto__")).toBe(true);
    expect((refs as Record<string, string>)["__proto__"]).toBe("danger");
    // No prototype pollution: a fresh object is unaffected.
    expect(({} as Record<string, unknown>)["danger"]).toBeUndefined();
  });
});

// Every value present in the sheet must be present SOMEWHERE in the mapped output — as a party name/email, a
// canonical or retained shipment ref, or a party external_ref. Nothing may vanish (CLAUDE.md rule 10 / REQ-035).
function allRetainedValues(r: ReturnType<typeof mapSpreadsheet>): Set<string> {
  const vals = new Set<string>();
  for (const p of r.parties) {
    vals.add(p.name);
    if (p.email !== undefined) vals.add(p.email);
    for (const v of Object.values(p.external_refs)) vals.add(v);
  }
  for (const s of r.shipments) {
    for (const v of Object.values(s.refs)) vals.add(v);
    if (s.mode !== undefined) vals.add(s.mode);
    if (s.division !== undefined) vals.add(s.division);
  }
  return vals;
}

describe("THE LAW — colliding / duplicate columns are RETAINED and flagged, NEVER silently dropped", () => {
  it("Customer,Account (both → bill_to_name): Account's value is retained AND a gap row is emitted", () => {
    const r = mapSpreadsheet(parseSheet("Customer,Account\nAcme,Beta Holdings\n"));
    // Customer wins bill_to_name; Account is a DUPLICATE-field column → NOT dropped.
    const gap = r.gapRows.find((g) => g.column === "Account");
    expect(gap).toBeDefined();
    expect(gap?.reason).toBe("duplicate_field");
    expect(gap?.suspectedField).toBe("bill_to_name");
    // Account's value survives somewhere (a retained ref) — it is not lost.
    expect(allRetainedValues(r).has("Beta Holdings")).toBe(true);
  });

  it("Customer,Notes,Notes (duplicate UNMAPPED header): BOTH note values survive under DISTINCT keys", () => {
    const r = mapSpreadsheet(parseSheet("Customer,Notes,Notes\nAcme,First,Second\n"));
    // Two gap rows for the two Notes columns (distinguished by ordinal), not one.
    const noteGaps = r.gapRows.filter((g) => g.column === "Notes");
    expect(noteGaps).toHaveLength(2);
    expect(noteGaps.map((g) => g.columnOrdinal).sort()).toEqual([1, 2]);
    // Both values present — the second Notes did not overwrite the first.
    const vals = allRetainedValues(r);
    expect(vals.has("First")).toBe(true);
    expect(vals.has("Second")).toBe(true);
    // …under DISTINCT retention keys on the shipment refs.
    const refs = r.shipments[0]!.refs;
    const noteKeys = Object.entries(refs).filter(([, v]) => v === "First" || v === "Second").map(([k]) => k);
    expect(new Set(noteKeys).size).toBe(2);
  });

  it("Customer,PRO,PRO and Customer,Weight,Gross Weight: the duplicate canonical column is retained + flagged", () => {
    const pro = mapSpreadsheet(parseSheet("Customer,PRO,PRO\nAcme,P1,P2\n"));
    expect(pro.shipments[0]!.refs["pro"]).toBe("P1"); // first wins the canonical slot
    expect(allRetainedValues(pro).has("P2")).toBe(true); // second NOT dropped
    expect(pro.gapRows.some((g) => g.reason === "duplicate_field")).toBe(true);

    const wt = mapSpreadsheet(parseSheet("Customer,Weight,Gross Weight\nAcme,1000,1005\n"));
    expect(wt.shipments[0]!.refs["weight_lb"]).toBe("1000");
    expect(allRetainedValues(wt).has("1005")).toBe(true);
    expect(wt.gapRows.some((g) => g.column === "Gross Weight" && g.reason === "duplicate_field")).toBe(true);
  });

  it("colliding-headers.csv: EVERY source cell survives and column↔gap-row count is airtight", () => {
    const sheet = parseSheet(collidingHeaders);
    const r = mapSpreadsheet(sheet);
    // 5 gap columns: Account + PRO#2 + Gross Weight (duplicate_field) and Notes + Notes (unmapped).
    const nonApplied = resolveColumnMapping(sheet.headers); // baseline plan (pre-collision) for the header list
    expect(nonApplied).toHaveLength(8);
    expect(r.gapRows).toHaveLength(5);
    expect(r.gapRows.filter((g) => g.reason === "duplicate_field")).toHaveLength(3);
    expect(r.gapRows.filter((g) => g.reason === "unmapped")).toHaveLength(2);
    // No source cell value is absent.
    const vals = allRetainedValues(r);
    for (const cell of ["Acme Distributing", "Beta Holdings", "First note", "Second note", "PRO900", "PRO901", "1000", "1005"]) {
      expect(vals.has(cell), `missing ${cell}`).toBe(true);
    }
  });
});

// ── §818 — THE LAW AS A PROPERTY, NOT AS FIVE CSVs ────────────────────────────────────────────────────────
//
// CLAUDE.md rule 10: "any legacy column that doesn't map raises a gap row — NEVER disappears." Five `THE LAW`
// blocks above prove that, each against a fixture someone wrote. So the law is proven for the header shapes
// we thought of, which is not the same claim.
//
// MEASURED (§818): planting a real silent drop — `if (p.header.trim() === "") continue;` in the gap emitter —
// left the fixture suite **19/19 GREEN**, because no fixture has a blank header. This property REDs on it.
// A blank header is not exotic: one trailing comma in a legacy export produces a column with no name, and
// under that mutation its values would vanish with no gap row and no anomaly — precisely the silent drop the
// rule exists to forbid.
//
// The generator uses a seeded LCG rather than Math.random — not merely for determinism: `Math.random` is
// BANNED across `packages/adapters/**` by the determinism selectors in eslint.config.mjs (see §815).
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Canonical, unmapped, collision-prone and DEGENERATE headers in one pool — the last group is the one no
// fixture covers, and the reason this test exists.
const HEADER_POOL = [
  "Customer", "PRO", "Weight", "Origin City", "Destination City", // map cleanly
  "Notes", "Phone", "Salesperson", "Special Instructions", // unmapped
  "Bill To", "bill_to", "Gross Weight", "PRO", "Customer", // collide / duplicate
  "", "   ", "---", "123", "Ünïcødé", // degenerate — unfixtured
] as const;

describe("§818 THE LAW as a property — no column disappears, for header shapes nobody fixtured", () => {
  const SEEDS = 300;
  const corpus = Array.from({ length: SEEDS }, (_, i) => {
    const r = lcg(i + 1);
    const n = 2 + Math.floor(r() * 8);
    return Array.from({ length: n }, () => HEADER_POOL[Math.floor(r() * HEADER_POOL.length)]!);
  });

  it("every column is either APPLIED or carries exactly ONE gap row", () => {
    const violations: string[] = [];
    for (const headers of corpus) {
      const csv = `${headers.join(",")}\n${headers.map((_, i) => `v${i}`).join(",")}\n`;
      const sheet = parseSheet(csv);
      const res = mapSpreadsheet(sheet);
      const plans = resolveColumnMapping(sheet.headers);
      const applied = new Set(plans.flatMap((p, i) => (p.decision === "apply" ? [i] : [])));
      const ordinals = res.gapRows.map((g) => g.columnOrdinal);

      for (let c = 0; c < sheet.headers.length; c++) {
        const gapped = ordinals.filter((o) => o === c).length;
        if (!applied.has(c) && gapped === 0) {
          violations.push(`SILENT DROP: col ${c} ${JSON.stringify(headers[c])} in ${JSON.stringify(headers)}`);
        }
        // Exactly one, not merely at least one: two gap rows for one column mint two anomalies for one
        // problem, which is how a review queue becomes noise the operator learns to ignore.
        if (gapped > 1) {
          violations.push(`DOUBLE-COUNTED: col ${c} ${JSON.stringify(headers[c])} → ${gapped} gap rows`);
        }
      }
    }
    expect(violations.slice(0, 5), `${violations.length} violation(s) of the no-silent-drop law`).toEqual([]);
  });

  it("the corpus actually contains the shapes it claims to (NON-VACUITY)", () => {
    // Without this, narrowing the pool or the seed count would quietly turn the property above into a test
    // of five ordinary headers — passing, and proving nothing. The §796 lesson: a green scan is only worth
    // what its corpus is worth, so the corpus is asserted, not assumed.
    const flat = corpus.flat();
    expect(corpus.length).toBe(SEEDS);
    for (const shape of ["", "   ", "---", "123", "Ünïcødé"]) {
      expect(flat, `the generated corpus never produced ${JSON.stringify(shape)}`).toContain(shape);
    }
    // and at least one set with a repeated header, which is the collision path
    expect(
      corpus.some((h) => new Set(h).size < h.length),
      "no generated header set contains a duplicate — the collision path is untested",
    ).toBe(true);
  });
});


describe("the LLM-overridable seam (resolveColumnMapping)", () => {
  it("an override places an otherwise-unmapped header (confidence ≥ floor ⇒ applied)", () => {
    const sheet = parseSheet(brokerLoads);
    const r = mapSpreadsheet(sheet, { overrides: { Salesperson: { field: "division", confidence: 0.9 } } });
    // Salesperson is now applied to division → no longer an unmapped gap, and division is populated.
    expect(r.gapRows.find((g) => g.column === "Salesperson")).toBeUndefined();
    expect(r.shipments[0]?.division).toBe("Dana");
    expect(r.fieldConfidence["division"]).toBe(0.9);
  });

  it("an override to an UNKNOWN field is a hard reject (schema-validated boundary)", () => {
    expect(() => resolveColumnMapping(["X"], { overrides: { X: { field: "not_a_field", confidence: 1 } } })).toThrow();
  });
});
