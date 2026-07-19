import { describe, expect, it } from "vitest";
import { partyIdForEmail, EventInput } from "@shuddl/contracts";
import type { TenderDoc } from "@shuddl/edi";
import { mapTenderToBooking } from "../src/core/map-204.js";

// WP-12 Task 6 · REQ-201/196 — the 204→booking-plan core. A parsed X12 204 load tender maps to a deterministic
// BookingPlan the worker (Task 7/8) INSERT-OR-IGNOREs: the bill-to party id converges with the CSR/Concierge
// via the SHARED @shuddl/contracts matcher (a mixed-case email → the SAME party), the shipment id is
// idempotent under redelivery, the N1/N3/N4 addresses are never dropped, and the append is a valid edi-source
// quote.requested EventInput. PURE — returns the plan, writes nothing.
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const baseTender: TenderDoc = {
  partnerScac: "ACME",
  purpose: "00",
  refs: { SID: "SID-1001", BM: "BOL-77" },
  stops: [
    { role: "SH", name: "ORIGIN WAREHOUSE", address: { street: "1 Dock St", city: "PORTLAND", state: "OR", zip: "97201" } },
    { role: "CN", name: "DEST STORE", address: { street: "9 Bay Ave", city: "SEATTLE", state: "WA", zip: "98101" } },
  ],
  billTo: { name: "Acme Brokerage", email: "Bob@Acme.com", address: { street: "500 Billing Rd", city: "BOISE", state: "ID", zip: "83702" } },
  weightLb: 1200,
};
const ctx = { partnerId: "partner_acme", isaControl: "000000042", receivedTs: 1_720_000_000_000 };

describe("mapTenderToBooking — 204 → booking plan (REQ-201/196)", () => {
  it("bill-to email resolves to the SHARED party id (mixed case → the same party as CSR/Concierge)", async () => {
    const plan = await mapTenderToBooking(baseTender, ctx);
    expect(plan.party.id).toBe(await partyIdForEmail("bob@acme.com"));
    expect(plan.party.id).toBe(await partyIdForEmail("Bob@Acme.com")); // case-insensitive convergence
    expect(plan.party.name).toBe("Acme Brokerage");
    expect(plan.party.email).toBe("bob@acme.com"); // stored NORMALIZED (trim+lower) — no stray case/whitespace
  });

  it("stores the bill-to contact email normalized (trim + lowercase) even from a messy wire value", async () => {
    const tender: TenderDoc = { ...baseTender, billTo: { name: "Acme Brokerage", email: "  Bob@Acme.com  " } };
    const plan = await mapTenderToBooking(tender, ctx);
    expect(plan.party.email).toBe("bob@acme.com");
    expect(plan.party.id).toBe(await partyIdForEmail("bob@acme.com")); // id still converges regardless of raw form
  });

  it("carries the 204 stop firm IDENTITIES (N102 names + addresses) — never dropped (Migrator rule 10)", async () => {
    const plan = await mapTenderToBooking(baseTender, ctx);
    expect(plan.stops.shipper?.name).toBe("ORIGIN WAREHOUSE");
    expect(plan.stops.consignee?.name).toBe("DEST STORE");
    expect(plan.stops.shipper?.address.zip).toBe("97201");
    expect(plan.stops.consignee?.address.city).toBe("SEATTLE");
  });

  it("the append is a valid edi-source quote.requested carrying the lane + weight", async () => {
    const plan = await mapTenderToBooking(baseTender, ctx);
    expect(plan.appends).toHaveLength(1);
    const append = plan.appends[0]!;
    expect(append.kind).toBe("quote.requested");
    expect(append.source).toBe("edi");
    // It parses as a real EventInput (shaped exactly to events.ts).
    expect(() => EventInput.parse(append)).not.toThrow();
    if (append.kind === "quote.requested") {
      expect(append.payload.request.origin_zip).toBe("97201");
      expect(append.payload.request.dest_zip).toBe("98101");
      expect(append.payload.request.weight_lb).toBe(1200);
    }
  });

  it("the N1/N3/N4 addresses are carried, never dropped (Migrator rule)", async () => {
    const plan = await mapTenderToBooking(baseTender, ctx);
    expect(plan.addresses.billTo?.street).toBe("500 Billing Rd");
    expect(plan.addresses.shipper?.zip).toBe("97201");
    expect(plan.addresses.consignee?.city).toBe("SEATTLE");
  });

  it("the shipment id is deterministic — a redelivered SAME tender maps to the SAME id (idempotent)", async () => {
    const a = await mapTenderToBooking(baseTender, ctx);
    const b = await mapTenderToBooking(baseTender, ctx);
    expect(a.shipment.id).toBe(b.shipment.id);
    expect(a.shipment.id.startsWith("shp_")).toBe(true);
    expect(a.shipment.partnerScac).toBe("ACME");
    // The whole plan is deterministic (incl. the append id) so redelivery collapses under INSERT OR IGNORE.
    expect(a).toEqual(b);
  });

  it("a no-email bill-to derives the party id EXACTLY as intake.ts does (name-keyed convergence)", async () => {
    const tender: TenderDoc = { ...baseTender, billTo: { name: "Acme Brokerage" } };
    const plan = await mapTenderToBooking(tender, ctx);
    const expected = `party_${(await sha256Hex("intake:party:name:acme brokerage")).slice(0, 16)}`;
    expect(plan.party.id).toBe(expected);
    expect(plan.party.email).toBeUndefined();
  });

  it("an unsafe-integer (absurd) AT8 weight routes to undefined, not an opaque EventInput.parse throw", async () => {
    // A weight beyond Number.MAX_SAFE_INTEGER fails SafeInt — it must OMIT weight_lb (UNKNOWN price, no lane
    // fabrication), never throw at the schema boundary.
    const tender: TenderDoc = { ...baseTender, weightLb: Number.MAX_SAFE_INTEGER + 2 };
    const plan = await mapTenderToBooking(tender, ctx);
    const append = plan.appends[0]!;
    if (append.kind === "quote.requested") expect(append.payload.request.weight_lb).toBeUndefined();
  });

  it("a fractional AT8 weight routes to undefined (no fabricated rounding)", async () => {
    const tender: TenderDoc = { ...baseTender, weightLb: 1200.5 };
    const plan = await mapTenderToBooking(tender, ctx);
    const append = plan.appends[0]!;
    if (append.kind === "quote.requested") expect(append.payload.request.weight_lb).toBeUndefined();
  });

  it("with no SID the shipment id falls back to the threaded ISA control (still deterministic)", async () => {
    const tender: TenderDoc = { ...baseTender, refs: { BM: "BOL-77" } };
    const a = await mapTenderToBooking(tender, ctx);
    const b = await mapTenderToBooking(tender, ctx);
    expect(a.shipment.id).toBe(b.shipment.id);
    // Different from the SID-keyed id (the fallback key differs).
    const sidPlan = await mapTenderToBooking(baseTender, ctx);
    expect(a.shipment.id).not.toBe(sidPlan.shipment.id);
  });
});
