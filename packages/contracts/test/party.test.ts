import { describe, expect, it } from "vitest";
import { normalizePartyEmail, partyIdForEmail } from "../src/index.js";

// REQ-196 — the shared party-identity matcher. Both the CSR intake (workers/api) and the Concierge email path
// (workers/agents) derive the email-keyed party id from THIS one helper, so a case/whitespace variant of the
// same customer resolves to ONE party row. This is the parity anchor: if the derivation ever changes, both
// surfaces move together and the convergence integration test (workers/api) still holds.

describe("party identity matcher (REQ-196)", () => {
  it("normalizePartyEmail trims + lowercases", () => {
    expect(normalizePartyEmail("  Bob@Acme.COM ")).toBe("bob@acme.com");
    expect(normalizePartyEmail("already@lower.test")).toBe("already@lower.test");
  });

  it("partyIdForEmail is case- AND whitespace-insensitive — one id for one customer", async () => {
    const canonical = await partyIdForEmail("bob@acme.com");
    for (const variant of ["Bob@Acme.com", "BOB@ACME.COM", "  bob@acme.com  ", "\tBob@Acme.COM\n"]) {
      expect(await partyIdForEmail(variant), variant).toBe(canonical);
    }
  });

  it("matches the hand-computed expected id (pins the byte law: sha256('shuddl:party:email:'+norm)[:16])", async () => {
    // node -e "sha256('shuddl:party:email:bob@acme.com')" → a9b0c970d9ce8041... (first 16 hex)
    expect(await partyIdForEmail("Bob@Acme.com")).toBe("party_a9b0c970d9ce8041");
  });

  it("distinct emails derive distinct ids (no accidental collision)", async () => {
    expect(await partyIdForEmail("bob@acme.com")).not.toBe(await partyIdForEmail("bob@other.com"));
  });
});
