import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveRecipient } from "../src/biller.js";
import { applyAll } from "./helpers.js";

// REQ-031/182 §785 — WHO THE EVIDENCE EMAIL GOES TO.
//
// `resolveRecipient` decides the single most consequential field of anything this system sends: the address
// that receives a customer's proof-of-delivery and their invoice. It has two rules — read ONLY the named
// party's contacts, and prefer the `billing` contact — and they were not equally defended.
//
// MEASURED (§785): dropping the `WHERE id = ?` binding so ANY party's contacts are returned — the
// cross-party leak shape — fails FOUR tests in `workers/api` and leaves `workers/agents` at 122/122 green.
// That is the id-determinism situation on this file again (see id-determinism.test.ts): the OUTCOME is
// asserted on the far side of a worker seam, because proving "one email, to this address" needs the real
// Biller consumer. Good — that half is covered, and this file does not duplicate it.
//
// What NOTHING covered is the second rule. Deleting the `billing` preference left BOTH suites green —
// `workers/agents` 122/122 AND `workers/api` 803/803. So a party carrying a dispatch contact and a billing
// contact would have had its invoice and signed POD delivered to DISPATCH, silently, with every test green.
// That is not a cross-party leak; it is the wrong human inside the right company, which is quieter and
// therefore likelier to survive.
//
// These are pure-ish assertions over one D1 read, exactly the half that is testable in this package.

const CONTACTS_DISPATCH_FIRST = JSON.stringify([
  { kind: "dispatch", email: "dispatch@acme.example" },
  { kind: "billing", email: "ap@acme.example" },
]);

async function seedParty(id: string, contacts: string): Promise<void> {
  await env.TENANT_A_DB.prepare("INSERT OR REPLACE INTO parties (id, kind, names, contacts) VALUES (?,?,?,?)")
    .bind(id, "broker", "{}", contacts)
    .run();
}

beforeAll(async () => {
  await applyAll(env.TENANT_A_DB);
});

describe("REQ-031/182 §785 — the evidence email's recipient", () => {
  it("prefers the BILLING contact even when another contact comes first", async () => {
    // THE DISCRIMINATING FIXTURE (§772): the non-billing contact is FIRST, so a resolver that merely took
    // the first plausible email would pass a fixture where billing happened to lead. Order is the whole test.
    await seedParty("party-785-order", CONTACTS_DISPATCH_FIRST);
    expect(
      await resolveRecipient(env.TENANT_A_DB, "party-785-order"),
      "an invoice + signed POD addressed to dispatch instead of AP — the wrong human at the right company",
    ).toBe("ap@acme.example");
  });

  it("falls back to any plausible email when the party has NO billing contact", async () => {
    // The fallback is deliberate: a party with only an ops address should still receive its proof, rather
    // than the send being HELD. Pinned so a future "billing-only" tightening is a decision, not a drift.
    await seedParty("party-785-fallback", JSON.stringify([{ kind: "dispatch", email: "ops@beta.example" }]));
    expect(await resolveRecipient(env.TENANT_A_DB, "party-785-fallback")).toBe("ops@beta.example");
  });

  it("returns undefined when no contact carries an email — the HELD path, never a guess", async () => {
    // The Biller turns this into `issued_send_pending` with a loud log: the invoice stands, the email is held.
    // The failure that matters is a resolver that INVENTS a recipient rather than admitting it has none.
    await seedParty("party-785-none", JSON.stringify([{ kind: "billing", phone: "+15035550100" }]));
    expect(await resolveRecipient(env.TENANT_A_DB, "party-785-none")).toBeUndefined();
  });

  it("reads ONLY the named party's contacts (belt for the cross-party binding proven in workers/api)", async () => {
    // The leak shape is asserted behaviourally in `workers/api`; this is the cheap local guard so an edit to
    // THIS file can fail in THIS package. Two parties exist and the wrong one has the alphabetically-first id,
    // so a resolver that dropped its WHERE clause would return the other address rather than nothing.
    await seedParty("party-785-aaa-other", JSON.stringify([{ kind: "billing", email: "leak@other.example" }]));
    await seedParty("party-785-zzz-target", JSON.stringify([{ kind: "billing", email: "correct@target.example" }]));
    expect(await resolveRecipient(env.TENANT_A_DB, "party-785-zzz-target")).toBe("correct@target.example");
  });

  it("a malformed contacts column is undefined, never a throw (the send is held, the invoice stands)", async () => {
    await seedParty("party-785-bad", "not-json-at-all");
    expect(await resolveRecipient(env.TENANT_A_DB, "party-785-bad")).toBeUndefined();
    await seedParty("party-785-obj", JSON.stringify({ kind: "billing", email: "x@y.example" })); // object, not array
    expect(await resolveRecipient(env.TENANT_A_DB, "party-785-obj")).toBeUndefined();
  });
});
