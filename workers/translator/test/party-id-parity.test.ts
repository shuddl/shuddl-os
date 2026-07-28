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
