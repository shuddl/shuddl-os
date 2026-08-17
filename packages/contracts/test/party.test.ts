import { describe, expect, it } from "vitest";
import { normalizePartyEmail, partyIdForEmail, partyIdForName } from "../src/index.js";

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

// §1717 (REQ-118/119/196) — THE SIBLING THE BYTE LAW STOPPED ONE FUNCTION SHORT OF.
//
// `partyIdForEmail` above has a golden, introduced as "pins the byte law". `partyIdForName` — declared eight
// lines below it, in the same file, under a comment stating the HARSHER version of the same law —
//
//     "THE `intake:` PREFIX IS LEGACY AND DELIBERATE … re-namespacing it would orphan every name-keyed party
//      ever created and split each one in two. Byte-exactness is the point, not symmetry — do not 'tidy' this
//      prefix."
//
// — had NO assertion of any kind. Measured, not inferred: changing that seed to `intake:party:nam:` left
// `packages/contracts` at 349/349, `workers/api` at 891/891 and `workers/agents` at 148/148 — 1,388 tests,
// all green, while every name-keyed party id in the product changed. The same mutation on the EMAIL seed reds
// exactly one test: the golden.
//
// A comment that names the wrong edit and forbids it by name is the strongest possible evidence someone will
// eventually make it. That is precisely when prose is not enough.

describe("§1717 partyIdForName — the byte law, asserted rather than described", () => {
  it("matches the hand-computed expected id (sha256('intake:party:name:'+trim(lower(name)))[:16])", async () => {
    expect(
      await partyIdForName("Acme Freight"),
      "a name-keyed party id byte moved. Every `parties.id` ever written from a NAME keeps its old value, so " +
        "the next find-or-create MISSES it and creates a second row for the same party — split billing, and a " +
        "credit hold on one half. This is not a snapshot to regenerate; read the comment above the function.",
    ).toBe("party_1e4f1100cfc8ec6b");
    expect(await partyIdForName("Bob Smith")).toBe("party_08810473b967735c");
  });

  it("is case- AND whitespace-insensitive, like its sibling (one party, not two)", async () => {
    const canonical = await partyIdForName("acme freight");
    for (const variant of ["Acme Freight", "ACME FREIGHT", "  ACME Freight  ", "\tAcme Freight\n"]) {
      expect(await partyIdForName(variant), variant).toBe(canonical);
    }
  });

  it("the two namespaces are DELIBERATELY different — the same string keys two different parties", async () => {
    // `shuddl:party:email:` vs the legacy `intake:party:name:`. The asymmetry is load-bearing, not an
    // oversight, so it is pinned here: a well-meaning "make these consistent" change fails BOTH goldens and
    // this assertion, instead of silently re-keying one half of the parties table.
    expect(await partyIdForName("bob@acme.com")).toBe("party_81f99224a4e4766a");
    expect(await partyIdForEmail("bob@acme.com")).toBe("party_a9b0c970d9ce8041");
    expect(await partyIdForName("bob@acme.com"), "a name that LOOKS like an email must not collide with the email key").not.toBe(
      await partyIdForEmail("bob@acme.com"),
    );
  });

  it("distinct names derive distinct ids (no accidental collision)", async () => {
    expect(await partyIdForName("Acme Freight")).not.toBe(await partyIdForName("Acme Freight Co"));
  });
});
