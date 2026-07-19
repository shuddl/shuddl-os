import { describe, expect, it } from "vitest";
import { quarantineDescriptor } from "../src/core/quarantine.js";

// WP-12 Task 6 · REQ-202 — the malformed-doc QUARANTINE descriptor core. A 204/214/990 that fails to parse is
// never silently dropped: it becomes an `anomalies` row the exceptions queue surfaces. The anomaly id is
// DETERMINISTIC per (partnerId, isaControl) so a redelivered malformed doc yields the SAME id and the worker's
// INSERT OR IGNORE is a no-op (idempotent). PURE — a stable hash, no Date/random.
describe("quarantineDescriptor — malformed-doc anomaly (REQ-202)", () => {
  const input = {
    partnerId: "partner_acme",
    isaControl: "000000042",
    docType: "204",
    parseError: "unexpected segment terminator at offset 118",
    r2Key: "edi/partner_acme/inbound/000000042.x12",
  };

  it("maps to a warn-level edi_malformed anomaly over an edi_doc object", () => {
    const d = quarantineDescriptor(input);
    expect(d.rule).toBe("edi_malformed");
    expect(d.objectKind).toBe("edi_doc");
    expect(d.severity).toBe("warn");
    expect(typeof d.anomalyId).toBe("string");
    expect(d.anomalyId.length).toBeGreaterThan(0);
    expect(d.objectId).toBe("partner_acme:000000042");
  });

  it("detail carries the parse_error, r2_key, doc_type and partner_id", () => {
    const d = quarantineDescriptor(input);
    expect(d.detail).toEqual({
      parse_error: "unexpected segment terminator at offset 118",
      r2_key: "edi/partner_acme/inbound/000000042.x12",
      doc_type: "204",
      partner_id: "partner_acme",
    });
  });

  it("the anomaly id is deterministic per (partnerId, isaControl) — a redelivered doc collapses under IGNORE", () => {
    const a = quarantineDescriptor(input);
    // A redelivery with a DIFFERENT r2 key / parse error still yields the SAME id (keyed only on partner+isa).
    const b = quarantineDescriptor({ ...input, r2Key: "edi/partner_acme/inbound/000000042-retry.x12", parseError: "different message" });
    expect(a.anomalyId).toBe(b.anomalyId);
  });

  it("a different partner or ISA control yields a different anomaly id", () => {
    const base = quarantineDescriptor(input);
    expect(quarantineDescriptor({ ...input, partnerId: "partner_other" }).anomalyId).not.toBe(base.anomalyId);
    expect(quarantineDescriptor({ ...input, isaControl: "000000099" }).anomalyId).not.toBe(base.anomalyId);
  });
});
