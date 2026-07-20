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
