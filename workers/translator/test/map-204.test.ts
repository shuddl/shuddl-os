import { describe, expect, it } from "vitest";
import { partyIdForEmail, EventInput } from "@shuddl/contracts";
import type { TenderDoc } from "@shuddl/edi";
import { mapTenderToBooking, LOAD_UNIQUE_REF_KEYS, ORDER_LEVEL_REF_KEYS, STABLE_REF_KEYS } from "../src/core/map-204.js";

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
const ctx = { partnerId: "partner_acme", receivedTs: 1_720_000_000_000 };

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

  it("with no SID the shipment id falls back to the next STABLE ref (BOL), NEVER the per-interchange ISA13", async () => {
    const tender: TenderDoc = { ...baseTender, refs: { BM: "BOL-77" } };
    const a = await mapTenderToBooking(tender, ctx);
    const b = await mapTenderToBooking(tender, ctx);
    expect(a.shipment.id).toBe(b.shipment.id); // deterministic in the BOL, not the interchange
    // Different from the SID-keyed id (the resolved business ref differs).
    const sidPlan = await mapTenderToBooking(baseTender, ctx);
    expect(a.shipment.id).not.toBe(sidPlan.shipment.id);
  });

  it("a tender with NO stable business ref (no SID/BOL/PRO/PO) throws MAP204_NO_SHIPMENT_REF (worker quarantines it)", async () => {
    // A per-interchange ISA13-derived id would duplicate a no-SID load under a second interchange — so a tender
    // with no stable identifier is refused here rather than minting a dup-prone id.
    const tender: TenderDoc = { ...baseTender, refs: {} };
    await expect(mapTenderToBooking(tender, ctx)).rejects.toThrow(/MAP204_NO_SHIPMENT_REF/);
  });

  it("threads a COMPLETE inch-dims set (l/w/h + pieces) into the quote.requested pricing request", async () => {
    const tender: TenderDoc = { ...baseTender, dims: { lengthIn: 48, widthIn: 40, heightIn: 60, pieces: 12 } };
    const plan = await mapTenderToBooking(tender, ctx);
    const append = plan.appends[0]!;
    if (append.kind === "quote.requested") {
      expect(append.payload.request.dims).toEqual({ l_in: 48, w_in: 40, h_in: 60, pieces: 12 });
    }
  });

  it("an INCOMPLETE dims set (pieces but no l/w/h) is NOT threaded — the rater stays UNKNOWN (no price on air)", async () => {
    const tender: TenderDoc = { ...baseTender, dims: { pieces: 12 } };
    const plan = await mapTenderToBooking(tender, ctx);
    const append = plan.appends[0]!;
    if (append.kind === "quote.requested") {
      expect(append.payload.request.dims).toBeUndefined();
    }
  });

  // ── EXIT-AUDIT F-1 (corrected): the ref taxonomy. PO is ORDER-LEVEL (one PO spans many truckloads), so it is
  //    NEVER a convergence key — converging on a shared PO would silently merge two distinct loads. It stays in the
  //    SEED priority (deterministic id) but out of the load-unique set. This pins the root-cause invariant. ──
  it("PO is a SEED ref but NOT a load-unique (convergence) ref — the taxonomy that prevents the PO over-merge", () => {
    expect(LOAD_UNIQUE_REF_KEYS).toEqual(["SID", "BM", "PRO"]);
    expect(LOAD_UNIQUE_REF_KEYS as readonly string[]).not.toContain("PO");
    expect(ORDER_LEVEL_REF_KEYS).toEqual(["PO"]);
    // The seed priority is the concatenation (load-unique first, order-level last) — value unchanged: SID→BM→PRO→PO.
    expect(STABLE_REF_KEYS).toEqual(["SID", "BM", "PRO", "PO"]);
  });

  // ── EXIT-AUDIT F-2: the id is QUALIFIER-NAMESPACED, so the SAME bare value under DIFFERENT qualifiers is TWO
  //    distinct loads (SID:5000 ≠ PO:5000) — a bare-value seed would collide them onto one stream. ──
  it("qualifier-namespaces the id: SID:5000 and PO:5000 map to DIFFERENT shipment ids (no bare-value collision)", async () => {
    const sidPlan = await mapTenderToBooking({ ...baseTender, refs: { SID: "5000" } }, ctx);
    const poPlan = await mapTenderToBooking({ ...baseTender, refs: { PO: "5000" } }, ctx);
    expect(sidPlan.shipment.id).not.toBe(poPlan.shipment.id);
    // still deterministic per (qualifier,value): a redelivery reproduces the same id.
    const sidAgain = await mapTenderToBooking({ ...baseTender, refs: { SID: "5000" } }, ctx);
    expect(sidPlan.shipment.id).toBe(sidAgain.shipment.id);
  });

  // ── EXIT-AUDIT F-1: shipmentIdOverride threads the CANONICAL id (a prior converged shipment) through so ALL
  //    deterministic append ids + the stream compute against it — never a post-hoc id swap under built appends. ──
  it("shipmentIdOverride forces the canonical id onto the shipment AND every append (stream↔shipment_id intact)", async () => {
    const plan = await mapTenderToBooking(baseTender, { ...ctx, shipmentIdOverride: "shp_canonical01" });
    expect(plan.shipment.id).toBe("shp_canonical01");
    const append = plan.appends[0]!;
    expect(append.shipment_id).toBe("shp_canonical01");
    if (append.kind === "quote.requested") {
      // the quote.requested event id is derived from the (canonical) shipment id, so it, too, tracks the override.
      expect(append.id).not.toBe((await mapTenderToBooking(baseTender, ctx)).appends[0]!.id);
    }
  });
});
