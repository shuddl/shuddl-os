import { describe, expect, it } from "vitest";
import { eventFixture, type LedgerEvent } from "@shuddl/contracts";
import { redactEvent, INTERNAL_NESTED } from "../src/redact.js";

// REQ-179 / I6 — NESTED counterparty redaction of invoice.issued / invoice.corrected. The portal is the
// FIRST counterparty surface to read these kinds; `division` (top-level) and every `lines[].gl_map`
// (nested inside an array) are MARGIN / chart-of-accounts internals that must NEVER reach a counterparty,
// while the sell/totals/line amounts legitimately stay (a party sees exactly what it owes). The strip is
// STRUCTURAL — it walks arrays + objects at any depth — so it fails closed on an unexpected shape.

describe("redactEvent: nested strip of invoice.issued internals (REQ-179)", () => {
  it("party/driver lens: NO division, NO lines[].gl_map — but amounts/totals remain", () => {
    const e = eventFixture("invoice.issued", { visibility: "counterparty" });
    // sanity: the STORED event carries the internals (else the assertion proves nothing).
    const stored = e.payload as Record<string, unknown>;
    expect(stored.division).toBe("main");
    expect((stored.lines as Array<Record<string, unknown>>)[0]!.gl_map).toBe("4000-REV");

    for (const lens of [{ scope: "party" as const }, { scope: "driver" as const }]) {
      const red = redactEvent(lens, e).payload as Record<string, unknown>;
      // internals gone at every depth
      expect(red.division).toBeUndefined();
      const lines = red.lines as Array<Record<string, unknown>>;
      expect(lines).toHaveLength(1);
      for (const l of lines) expect("gl_map" in l).toBe(false);
      // the sell/totals/line amounts a counterparty legitimately sees are KEPT
      expect(lines[0]!.amount_cents).toBe(120_000);
      expect(lines[0]!.line_no).toBe(1);
      expect(lines[0]!.kind).toBe("freight");
      expect(red.invoice_id).toBeDefined();
      expect(red.party_id).toBeDefined();
      // no trace of the gl_map VALUE anywhere in the projected payload
      expect(JSON.stringify(red)).not.toContain("4000-REV");
    }
    // redaction is a READ projection — the stored event is never mutated.
    expect((e.payload as Record<string, unknown>).division).toBe("main");
    expect(((e.payload as Record<string, unknown>).lines as Array<Record<string, unknown>>)[0]!.gl_map).toBe("4000-REV");
  });

  it("tenant (ops) lens sees the internals UNREDACTED (redaction is per-lens)", () => {
    const e = eventFixture("invoice.issued", { visibility: "counterparty" });
    const red = redactEvent({ scope: "tenant" }, e).payload as Record<string, unknown>;
    expect(red.division).toBe("main");
    expect((red.lines as Array<Record<string, unknown>>)[0]!.gl_map).toBe("4000-REV");
  });

  it("invoice.corrected: reissue_lines[].gl_map stripped for a party lens; reason/amounts kept", () => {
    const e = eventFixture("invoice.corrected", {
      visibility: "counterparty",
      payload: {
        invoice_id: "inv-1",
        corrects_event_id: "evt-orig",
        reason: "reweigh correction",
        reissue_lines: [{ line_no: 1, kind: "freight", amount_cents: 90_000, gl_map: "4000-REV" }],
      },
    });
    const red = redactEvent({ scope: "party" as const }, e).payload as Record<string, unknown>;
    const lines = red.reissue_lines as Array<Record<string, unknown>>;
    for (const l of lines) expect("gl_map" in l).toBe(false);
    expect(lines[0]!.amount_cents).toBe(90_000);
    expect(red.reason).toBe("reweigh correction"); // the correction reason is counterparty-visible
    expect(JSON.stringify(red)).not.toContain("4000-REV");
  });

  it("FAILS CLOSED: strips division/gl_map at ANY depth, even an off-contract nested shape", () => {
    // Hand-built envelope (bypasses the .strict() contract) with the internal keys buried two arrays
    // deep. redactEvent structurally walks the whole payload, so the buried keys are still removed —
    // strip MORE on an unexpected shape, never less.
    const raw = {
      id: "e1",
      stream_id: "s:1",
      shipment_id: "shp-1",
      seq: 0,
      ts: 1,
      recorded_at: 1,
      kind: "invoice.issued",
      actor: { party: "p1" },
      party_refs: ["p2"],
      evidence: [],
      prev_hash: "0".repeat(64),
      hash: "1".repeat(64),
      visibility: "counterparty",
      source: "native",
      confidence: 10_000,
      payload: {
        invoice_id: "inv-x",
        party_id: "p2",
        division: "top-level-div",
        lines: [{ line_no: 1, kind: "freight", amount_cents: 5, gl_map: "L1-GL" }],
        weird: [{ deep: [{ gl_map: "BURIED-GL", division: "BURIED-DIV" }] }],
      },
    } as unknown as LedgerEvent;

    const red = redactEvent({ scope: "party" as const }, raw).payload as Record<string, unknown>;
    const dumped = JSON.stringify(red);
    expect(dumped).not.toContain("gl_map");
    expect(dumped).not.toContain("division");
    expect(dumped).not.toContain("BURIED"); // buried two arrays deep — still stripped
    expect(dumped).not.toContain("L1-GL");
    // the line amount survives the walk
    expect((red.lines as Array<Record<string, unknown>>)[0]!.amount_cents).toBe(5);
  });

  it("INTERNAL_NESTED registers both invoice kinds with division + gl_map (completeness)", () => {
    expect(INTERNAL_NESTED["invoice.issued"]).toEqual(["division", "gl_map"]);
    expect(INTERNAL_NESTED["invoice.corrected"]).toEqual(["division", "gl_map"]);
  });
});
