import { describe, expect, it } from "vitest";
import type { TenderDoc } from "@shuddl/edi";
import { mapTenderToBooking } from "../src/core/map-204.js";

// WP-12 Task 6 review fix (Important, REQ-196 name axis) — the ZERO-TOUCH parity LOCK. map-204's no-email party
// id inlines the scheme `workers/api/src/intake-core.ts:64@intake:party:name:` uses (`party_<first16 sha256("intake:party:name:"
// +lower(name))>`). The ideal de-dup (a shared partyIdForName in @shuddl/contracts) would touch a shipped file,
// forbidden here — so this additive test PINS the two surfaces to one byte-exact scheme, so they cannot silently
// drift into duplicate broker parties (the split-billing / credit-hold-evasion risk, on the name axis). If a
// future non-WP-12 refactor extracts partyIdForName, repoint both surfaces AND this lock.
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const tender = (billToName: string): TenderDoc => ({
  partnerScac: "ACME",
  purpose: "00",
  refs: { SID: "PARITY-SID" }, // a stable business ref so the shipment id resolves (the party id is what's under test)
  stops: [
    { role: "SH", name: "ORIGIN WAREHOUSE", address: { zip: "97201" } },
    { role: "CN", name: "DEST STORE", address: { zip: "98101" } },
  ],
  billTo: { name: billToName },
});
const ctx = { partnerId: "partner_acme", receivedTs: 0 };

describe("no-email party id parity (REQ-196, name axis) — map-204 ⇄ intake-core.ts:64", () => {
  it("derives the SAME name-keyed id intake.ts uses: party_<first16 sha256('intake:party:name:'+lower(name))>", async () => {
    const plan = await mapTenderToBooking(tender("Acme Brokerage"), ctx);
    const canonical = `party_${(await sha256Hex("intake:party:name:acme brokerage")).slice(0, 16)}`;
    expect(plan.party.id).toBe(canonical);
  });

  it("normalizes the name (trim + lowercase) before hashing, exactly as intake.ts does", async () => {
    const plan = await mapTenderToBooking(tender("  ACME Brokerage  "), ctx);
    const canonical = `party_${(await sha256Hex("intake:party:name:acme brokerage")).slice(0, 16)}`;
    expect(plan.party.id).toBe(canonical);
  });

  it("uses the intake domain prefix, not a translator-local one (a prefix change would break convergence)", async () => {
    const plan = await mapTenderToBooking(tender("Acme Brokerage"), ctx);
    const wrongPrefix = `party_${(await sha256Hex("edi:party:name:acme brokerage")).slice(0, 16)}`;
    expect(plan.party.id).not.toBe(wrongPrefix);
  });
});

// THE SECOND COPY, IN THE SAME FILE (audit §225). map-204 inlines the intake scheme TWICE — once for the
// bill-to broker (the cases above) and once for the NO-BILL-TO branch, where the shipper IS the
// counterparty. Only the first was pinned: drifting the shipper-path derivation alone left all 99
// translator tests green.
//
// The risk is the one this file's own header names, on the same axis: a shipper arriving by EDI and the
// same shipper created by CSR intake would become TWO parties — split billing, and a credit hold on one
// that the other never sees. A tender without a billTo is the ordinary case for a direct shipper, so this
// is not the exotic branch.
const noBillTo = (shipperName: string): TenderDoc => ({
  partnerScac: "ACME",
  purpose: "00",
  refs: { SID: "PARITY-SID-NOBILLTO" },
  stops: [
    { role: "SH", name: shipperName, address: { zip: "97201" } },
    { role: "CN", name: "DEST STORE", address: { zip: "98101" } },
  ],
});

describe("no-email party id parity — the NO-BILL-TO branch (shipper as counterparty)", () => {
  it("derives the shipper's id under the SAME intake scheme as the bill-to path", async () => {
    const plan = await mapTenderToBooking(noBillTo("Origin Warehouse"), ctx);
    const canonical = `party_${(await sha256Hex("intake:party:name:origin warehouse")).slice(0, 16)}`;
    expect(plan.party.id).toBe(canonical);
  });

  it("normalizes the shipper name identically (trim + lowercase)", async () => {
    const plan = await mapTenderToBooking(noBillTo("  ORIGIN Warehouse  "), ctx);
    const canonical = `party_${(await sha256Hex("intake:party:name:origin warehouse")).slice(0, 16)}`;
    expect(plan.party.id).toBe(canonical);
  });

  it("CONVERGENCE: the same name yields the same id whether it arrives as bill-to or as shipper", async () => {
    const asBillTo = await mapTenderToBooking(tender("Convergent Co"), ctx);
    const asShipper = await mapTenderToBooking(noBillTo("Convergent Co"), ctx);
    expect(asShipper.party.id).toBe(asBillTo.party.id);
  });
});
