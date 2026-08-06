import { describe, expect, it } from "vitest";
import type { TenderDoc } from "@shuddl/edi";
import { partyIdForName } from "@shuddl/contracts";
import { mapTenderToBooking } from "../src/core/map-204.js";

// Local hash, used ONLY by the negative control below — it must compute a scheme that is deliberately WRONG
// (`edi:party:name:`), which no shared function will ever produce. Every POSITIVE assertion in this file
// calls `partyIdForName` itself; re-deriving the real scheme here is what made the old lock one-sided.
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// REQ-196 name axis — the parity lock, now pinned to the SHARED derivation (audit §433).
//
// HISTORY, because it is the lesson. This started as a WP-12 "ZERO-TOUCH parity LOCK": map-204 and
// intake-core each INLINED the name-keyed scheme, and extracting a shared helper would have touched a
// shipped file, which that WP forbade. So the lock recomputed the formula HERE and compared the translator
// to it. That pins one side. Measured at the time of the fix: changing intake-core's domain prefix left this
// file 6/6 GREEN while the two surfaces derived different ids — the drift into duplicate broker parties
// (split-billing / credit-hold evasion) that the lock's own header named as the risk it existed to prevent.
//
// WP-12 is closed, so the refactor its header prescribed has been done: `partyIdForName` now lives in
// @shuddl/contracts and BOTH surfaces call it. `canonical` below is that function — not a copy of it — so
// this file now fails if EITHER side stops using it. A local re-implementation would restore the blind spot.


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

// THE SCHEME IS FROZEN, and this is the only assertion that can prove it (audit §433).
//
// Every other test here compares map-204's output to `partyIdForName(...)`. That proves map-204 USES the
// shared derivation — which is what stops it being re-inlined — but it cannot prove the derivation still
// produces the SAME BYTES, because a change to `partyIdForName` moves both sides together and they keep
// agreeing. That is the one-sided lock's failure mode wearing a new hat: sharing removed the drift between
// two surfaces, and would have hidden a drift of the scheme ITSELF.
//
// These ids are PERSISTED in `parties.id`. Re-namespacing or re-normalizing the scheme does not migrate
// them — it makes every existing name-keyed party unreachable and mints a second row for the same firm on
// the next tender, which is the duplicate-broker/split-billing outcome by a different route. Frozen
// literals, computed once and never recomputed from the code under test.
describe("REQ-196: the name-keyed scheme is BYTE-FROZEN (persisted ids cannot be re-derived)", () => {
  it("partyIdForName produces the exact stored bytes for known names", async () => {
    expect(await partyIdForName("acme brokerage")).toBe("party_94d5d053eef3c59f");
    expect(await partyIdForName("origin warehouse")).toBe("party_57536bbb80656810");
  });

  it("normalization is part of the frozen contract — messy input lands on the same stored id", async () => {
    expect(await partyIdForName("  ACME Brokerage  ")).toBe("party_94d5d053eef3c59f");
  });
});

describe("no-email party id parity (REQ-196, name axis) — map-204 ⇄ intake-core.ts:64", () => {
  it("derives the SAME name-keyed id intake.ts uses: party_<first16 sha256('intake:party:name:'+lower(name))>", async () => {
    const plan = await mapTenderToBooking(tender("Acme Brokerage"), ctx);
    const canonical = await partyIdForName("acme brokerage");
    expect(plan.party.id).toBe(canonical);
  });

  it("normalizes the name (trim + lowercase) before hashing, exactly as intake.ts does", async () => {
    const plan = await mapTenderToBooking(tender("  ACME Brokerage  "), ctx);
    const canonical = await partyIdForName("acme brokerage");
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
    const canonical = await partyIdForName("origin warehouse");
    expect(plan.party.id).toBe(canonical);
  });

  it("normalizes the shipper name identically (trim + lowercase)", async () => {
    const plan = await mapTenderToBooking(noBillTo("  ORIGIN Warehouse  "), ctx);
    const canonical = await partyIdForName("origin warehouse");
    expect(plan.party.id).toBe(canonical);
  });

  it("CONVERGENCE: the same name yields the same id whether it arrives as bill-to or as shipper", async () => {
    const asBillTo = await mapTenderToBooking(tender("Convergent Co"), ctx);
    const asShipper = await mapTenderToBooking(noBillTo("Convergent Co"), ctx);
    expect(asShipper.party.id).toBe(asBillTo.party.id);
  });
});
