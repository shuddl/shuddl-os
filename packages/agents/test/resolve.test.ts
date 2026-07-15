import { describe, expect, it } from "vitest";
import { resolveConcierge } from "../src/index.js";
import type { ParseResult, ResolvePort, ResolveResult } from "../src/index.js";

// ============================================================================================
// WP-07 — the Concierge RESOLVE step (REQ-093). A parsed inbound (Task 3's ParseResult) must be
// tied to a Party + Shipment before anything can quote it. Resolution is PURE logic over a small
// tenant-scoped DB PORT (Task 6 binds the D1-backed implementation) and gates on STRUCTURAL facts
// we can verify + a computed confidence — never the model's self-reported `parse.confidence`
// (that field is model-supplied and prompt-injectable; see the Task-3 "C1" review). Below the bar
// → `unresolved` (a human handles it; we NEVER auto-create/auto-quote a shaky tie).
//
// TENANT ISOLATION: the port is the ONLY I/O channel. The consumer binds it to exactly one
// tenant's D1, so nothing in resolveConcierge can reach another tenant (REQ-025). Every test below
// drives a FAKE in-memory port — the sole collaborator — which also proves that isolation seam.
// ============================================================================================

/** `confidence` on a ParseResult is a branded Bps; brand a plain number for these literals. */
function bps(n: number): ParseResult["confidence"] {
  return n as ParseResult["confidence"];
}

/** The source `message.received` event id — resolveConcierge threads it into the shipment's refs
 *  (provenance + the consumer's redelivery dedup key). */
const SRC = "evt-msg-received-1";

/**
 * Call resolveConcierge with the REQ-172 `senderEmail` (the AUTHENTICATED envelope sender = from_ref). For
 * the DeterministicParser `party_hint.email === from_ref`, so defaulting the sender to the parse's own hint
 * email preserves EXACTLY the pre-REQ-172 resolutions these tests pin (identity/matching still ties to the
 * same address). The REQ-172 DIVERGENCE (a model hint ≠ the authenticated sender) is proven separately in
 * the identity-source test below and in the consumer integration suite (workers/api/test/concierge.test.ts).
 */
function resolve(
  parse: ParseResult,
  port: ResolvePort,
  src: string = SRC,
  senderEmail: string = parse.party_hint?.email ?? "",
): Promise<ResolveResult> {
  return resolveConcierge(parse, port, src, senderEmail);
}

/**
 * A FAKE in-memory ResolvePort. It records call ORDER (calls[]) so we can assert the FK invariant
 * (createParty BEFORE createShipment), and captures the exact arguments handed to each write. It is
 * the ONLY collaborator resolveConcierge is given — mirroring the per-tenant binding of the real port.
 */
class FakePort implements ResolvePort {
  readonly calls: string[] = [];
  readonly createdParties: { kind: string; email: string; name?: string; id: string }[] = [];
  readonly createdShipments: {
    shipper_party_id: string;
    consignee_party_id: string;
    bill_to_party_id: string;
    refs: string;
    id: string;
  }[] = [];
  private readonly existing: Map<string, { id: string }>;
  private nextParty = 1;
  private nextShipment = 1;

  constructor(existingByEmail: Record<string, string> = {}) {
    this.existing = new Map(Object.entries(existingByEmail).map(([email, id]) => [email, { id }]));
  }

  async findPartyByEmail(email: string): Promise<{ id: string } | null> {
    this.calls.push("findPartyByEmail");
    return this.existing.get(email) ?? null;
  }

  async createParty(p: { kind: string; email: string; name?: string }): Promise<{ id: string }> {
    this.calls.push("createParty");
    const id = `party-new-${this.nextParty++}`;
    this.createdParties.push({ ...p, id });
    return { id };
  }

  async createShipment(s: {
    shipper_party_id: string;
    consignee_party_id: string;
    bill_to_party_id: string;
    refs: string;
  }): Promise<{ id: string }> {
    this.calls.push("createShipment");
    const id = `ship-${this.nextShipment++}`;
    this.createdShipments.push({ ...s, id });
    return { id };
  }
}

// ── ParseResult builders (explicit literals; exactOptionalPropertyTypes forbids undefined keys) ──

/** A full, priceable quote parse: quote intent, a party email+name, both zips + a weight. */
function fullQuoteParse(): ParseResult {
  return {
    intent: "quote",
    confidence: bps(9500),
    party_hint: { email: "ops@acme.test", name: "Acme Ops" },
    request: { origin_zip: "94105", dest_zip: "07030", weight_lb: 1200 },
  };
}

// ── 1. Intent gate ───────────────────────────────────────────────────────────────────────────

describe("resolveConcierge — intent gate", () => {
  it("non-quote intent → unresolved(not_quote_intent) and NEVER touches the port", async () => {
    const port = new FakePort();
    const parse: ParseResult = {
      intent: "status",
      confidence: bps(9500),
      party_hint: { email: "ops@acme.test" },
      request: { origin_zip: "94105", dest_zip: "07030", weight_lb: 1200 },
    };
    const result = await resolve(parse, port, SRC);
    expect(result).toEqual<ResolveResult>({ status: "unresolved", reason: "not_quote_intent" });
    // No read, no write — status/claim/unknown route elsewhere; resolution does zero I/O.
    expect(port.calls).toEqual([]);
  });
});

// ── 2. Party signal ──────────────────────────────────────────────────────────────────────────

describe("resolveConcierge — party signal gate", () => {
  it("quote with NO party_hint.email → unresolved(no_party_signal), port untouched", async () => {
    const port = new FakePort();
    const parse: ParseResult = {
      intent: "quote",
      confidence: bps(9500),
      request: { origin_zip: "94105", dest_zip: "07030", weight_lb: 1200 },
    };
    const result = await resolve(parse, port, SRC);
    expect(result).toEqual<ResolveResult>({ status: "unresolved", reason: "no_party_signal" });
    expect(port.calls).toEqual([]);
  });

  it("quote with an EMPTY party_hint.email → unresolved(no_party_signal) (empty can't tie a party)", async () => {
    const port = new FakePort();
    const parse: ParseResult = {
      intent: "quote",
      confidence: bps(9500),
      party_hint: { email: "" },
      request: { origin_zip: "94105", dest_zip: "07030", weight_lb: 1200 },
    };
    const result = await resolve(parse, port, SRC);
    expect(result).toEqual<ResolveResult>({ status: "unresolved", reason: "no_party_signal" });
    expect(port.calls).toEqual([]);
  });
});

// ── 3. Priceable request ─────────────────────────────────────────────────────────────────────

describe("resolveConcierge — priceable-request gate", () => {
  it("quote, email, but request missing a zip → unresolved(no_request), port untouched", async () => {
    const port = new FakePort();
    const parse: ParseResult = {
      intent: "quote",
      confidence: bps(9500),
      party_hint: { email: "ops@acme.test" },
      request: { origin_zip: "94105", dest_zip: "" }, // dest_zip absent (empty) → not priceable
    };
    const result = await resolve(parse, port, SRC);
    expect(result).toEqual<ResolveResult>({ status: "unresolved", reason: "no_request" });
    expect(port.calls).toEqual([]);
  });

  it("quote, email, but NO request at all → unresolved(no_request), port untouched", async () => {
    const port = new FakePort();
    const parse: ParseResult = {
      intent: "quote",
      confidence: bps(9500),
      party_hint: { email: "ops@acme.test" },
    };
    const result = await resolve(parse, port, SRC);
    expect(result).toEqual<ResolveResult>({ status: "unresolved", reason: "no_request" });
    expect(port.calls).toEqual([]);
  });
});

// ── 4. Resolve against an EXISTING party ──────────────────────────────────────────────────────

describe("resolveConcierge — existing party", () => {
  it("full quote whose email matches an existing party → resolved, party_created:false", async () => {
    const port = new FakePort({ "ops@acme.test": "party-existing-1" });
    const result = await resolve(fullQuoteParse(), port, SRC);

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(result.party_created).toBe(false);
    expect(result.party_id).toBe("party-existing-1");
    expect(result.resolution_confidence).toBeGreaterThanOrEqual(9000);
    // existing party + both zips + weight → 6000 + 3000 + 1500, clamped to the 10000 ceiling.
    expect(result.resolution_confidence).toBe(10000);

    // No party was created; a shipment was — with ALL THREE party FKs = the existing party
    // (a quote-stage self-reference: consignee/payer firm up at booking, WP-08).
    expect(port.createdParties).toHaveLength(0);
    expect(port.createdShipments).toHaveLength(1);
    const ship = port.createdShipments[0]!;
    expect(ship.shipper_party_id).toBe("party-existing-1");
    expect(ship.consignee_party_id).toBe("party-existing-1");
    expect(ship.bill_to_party_id).toBe("party-existing-1");
    expect(result.shipment_id).toBe(ship.id);
    // refs carries the source message event id — the provenance + redelivery dedup key.
    expect(JSON.parse(ship.refs)).toEqual({ source: "concierge", source_message_event_id: SRC });
  });

  it("existing party + both zips but NO weight → resolved at exactly the 9000 threshold (inclusive)", async () => {
    const port = new FakePort({ "ops@acme.test": "party-existing-1" });
    const parse: ParseResult = {
      intent: "quote",
      confidence: bps(4000), // deliberately LOW: the model's word must not drag resolution down
      party_hint: { email: "ops@acme.test" },
      request: { origin_zip: "94105", dest_zip: "07030" }, // no weight
    };
    const result = await resolve(parse, port, SRC);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("unreachable");
    // 6000 (both zips) + 3000 (existing party) = 9000 → resolves (threshold is inclusive).
    expect(result.resolution_confidence).toBe(9000);
    expect(result.party_created).toBe(false);
  });
});

// ── 5. Resolve by CREATING a new party ────────────────────────────────────────────────────────

describe("resolveConcierge — new party", () => {
  it("full quote with NO existing party → resolved, party_created:true, createParty then createShipment", async () => {
    const port = new FakePort(); // no existing parties
    const result = await resolve(fullQuoteParse(), port, SRC);

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(result.party_created).toBe(true);
    // new party + both zips + weight → 6000 + 1500 + 1500 = 9000.
    expect(result.resolution_confidence).toBe(9000);

    // The quote REQUESTER is created as a shipper, carrying the email + name.
    expect(port.createdParties).toHaveLength(1);
    const party = port.createdParties[0]!;
    expect(party.kind).toBe("shipper");
    expect(party.email).toBe("ops@acme.test");
    expect(party.name).toBe("Acme Ops");
    expect(result.party_id).toBe(party.id);

    // The shipment's three FKs all point at the freshly-created requester party.
    expect(port.createdShipments).toHaveLength(1);
    const ship = port.createdShipments[0]!;
    expect(ship.shipper_party_id).toBe(party.id);
    expect(ship.consignee_party_id).toBe(party.id);
    expect(ship.bill_to_party_id).toBe(party.id);
    expect(result.shipment_id).toBe(ship.id);
  });

  it("new party with no name in party_hint → createParty omits name (no empty-string key)", async () => {
    const port = new FakePort();
    const parse: ParseResult = {
      intent: "quote",
      confidence: bps(9500),
      party_hint: { email: "solo@acme.test" },
      request: { origin_zip: "94105", dest_zip: "07030", weight_lb: 500 },
    };
    const result = await resolve(parse, port, SRC);
    expect(result.status).toBe("resolved");
    const party = port.createdParties[0]!;
    expect(party.kind).toBe("shipper");
    expect(party.email).toBe("solo@acme.test");
    expect(party.name).toBeUndefined();
  });
});

// ── 6. Low computed confidence → queue, never auto-create the shipment ─────────────────────────

describe("resolveConcierge — low confidence", () => {
  it("new party + both zips but NO weight (7500 < 9000) → unresolved(low_confidence), NOTHING created", async () => {
    const port = new FakePort(); // no existing party → a shaky, brand-new tie
    const parse: ParseResult = {
      intent: "quote",
      confidence: bps(9900), // the model is very sure — irrelevant; we gate on structure, not its word
      party_hint: { email: "stranger@acme.test", name: "Stranger" },
      request: { origin_zip: "94105", dest_zip: "07030" }, // no weight
    };
    const result = await resolve(parse, port, SRC);
    expect(result).toEqual<ResolveResult>({ status: "unresolved", reason: "low_confidence" });
    // A read to score the tie is fine; the WRITES must not have happened.
    expect(port.createdParties).toEqual([]);
    expect(port.createdShipments).toEqual([]);
    expect(port.calls).not.toContain("createParty");
    expect(port.calls).not.toContain("createShipment");
  });
});

// ── 7. Determinism ────────────────────────────────────────────────────────────────────────────

describe("resolveConcierge — determinism", () => {
  it("same parse + same port responses → byte-identical result", async () => {
    const parse = fullQuoteParse();
    const a = await resolve(parse, new FakePort({ "ops@acme.test": "party-existing-1" }), SRC);
    const b = await resolve(parse, new FakePort({ "ops@acme.test": "party-existing-1" }), SRC);
    expect(a).toEqual(b);
  });
});

// ── 8. FK order (createParty strictly before createShipment) ──────────────────────────────────

describe("resolveConcierge — FK order", () => {
  it("on the create path, createParty is invoked BEFORE createShipment", async () => {
    const port = new FakePort();
    await resolve(fullQuoteParse(), port, SRC);
    const partyIdx = port.calls.indexOf("createParty");
    const shipIdx = port.calls.indexOf("createShipment");
    expect(partyIdx).toBeGreaterThanOrEqual(0);
    expect(shipIdx).toBeGreaterThanOrEqual(0);
    expect(partyIdx).toBeLessThan(shipIdx);
  });
});

// ── 9. Tenant isolation — the port is the only I/O ────────────────────────────────────────────

describe("resolveConcierge — tenant isolation", () => {
  it("performs I/O ONLY through the injected (per-tenant) port — no other collaborator exists", async () => {
    // The consumer binds ResolvePort to ONE tenant's D1 (REQ-025). resolveConcierge holds no D1
    // handle, no global, no fetch — so every call it makes lands on this fake and nowhere else.
    const port = new FakePort({ "ops@acme.test": "party-existing-1" });
    await resolve(fullQuoteParse(), port, SRC);
    const known = new Set(["findPartyByEmail", "createParty", "createShipment"]);
    for (const call of port.calls) expect(known.has(call)).toBe(true);
  });
});

// ── 10. Non-idempotency is a KNOWN, deferred property (the Task-6 consumer guards redelivery) ──

describe("resolveConcierge — non-idempotency (documented; consumer owns redelivery)", () => {
  it("resolving the SAME parse + source id twice creates TWO shipments (this fn has no dedup key of its own)", async () => {
    // resolveConcierge is a pure tie step with no ledger to check — every resolvable call creates a
    // NEW shipment. Cloudflare Queues is at-least-once, so the Task-6 consumer MUST guard redelivery
    // (skip if a quote.requested carrying this source_message_event_id already exists). This test PINS
    // the current behavior so the deferral is explicit and a future accidental "dedup here" is caught.
    const port = new FakePort({ "ops@acme.test": "party-existing-1" });
    const a = await resolve(fullQuoteParse(), port, SRC);
    const b = await resolve(fullQuoteParse(), port, SRC);
    expect(a.status).toBe("resolved");
    expect(b.status).toBe("resolved");
    expect(port.createdShipments).toHaveLength(2); // two shipments, same source id — not deduped here
    if (a.status !== "resolved" || b.status !== "resolved") throw new Error("unreachable");
    expect(a.shipment_id).not.toBe(b.shipment_id);
  });
});

// ── 11. Gate ORDER (party-signal decided before priceable-request) ────────────────────────────

describe("resolveConcierge — gate order", () => {
  it("with BOTH party_hint.email and request absent, no_party_signal wins (pins the gate order)", async () => {
    const port = new FakePort();
    const parse: ParseResult = { intent: "quote", confidence: bps(9500) }; // no email AND no request
    const result = await resolve(parse, port, SRC);
    expect(result).toEqual<ResolveResult>({ status: "unresolved", reason: "no_party_signal" });
    expect(port.calls).toEqual([]);
  });
});

// ── 12. IDENTITY is the authenticated sender, NEVER party_hint.email (REQ-172) ─────────────────

describe("resolveConcierge — identity keys off the authenticated senderEmail (REQ-172)", () => {
  it("a model party_hint.email that DIFFERS from senderEmail neither matches a victim nor creates on the attacker address", async () => {
    // A VICTIM party is on file at the address the model names in party_hint (the crafted body's attempt to
    // earn the existing-party resolution bump / impersonate). The authenticated sender is a BRAND-NEW address.
    const port = new FakePort({ "victim@bigco.test": "party-victim" });
    const parse: ParseResult = {
      intent: "quote",
      confidence: bps(10000),
      party_hint: { email: "victim@bigco.test", name: "Totally The Victim" }, // model output — MUST NOT drive identity
      request: { origin_zip: "94105", dest_zip: "07030", weight_lb: 1200 },
    };
    // senderEmail is the AUTHENTICATED from_ref — a new address, no party on file.
    const result = await resolveConcierge(parse, port, SRC, "stranger@shipper.test");

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("unreachable");
    // No victim match (find keyed off the authenticated sender, which is NOT on file) → a NEW party is created.
    expect(result.party_created).toBe(true);
    expect(result.party_id).not.toBe("party-victim");
    // The find was performed on the AUTHENTICATED sender, never the model's party_hint.email.
    expect(port.createdParties).toHaveLength(1);
    const created = port.createdParties[0]!;
    expect(created.email).toBe("stranger@shipper.test"); // identity = from_ref
    expect(created.email).not.toBe("victim@bigco.test");
    // party_hint.name is retained as the COSMETIC display name only (identity is the authenticated email).
    expect(created.name).toBe("Totally The Victim");
    // Structural confidence used the NEW-party path (no existing-party bump the spoof tried to buy):
    // 6000 (both zips) + 1500 (new party) + 1500 (weight) = 9000, NOT 10000.
    expect(result.resolution_confidence).toBe(9000);
  });

  it("an authenticated sender ON FILE matches that party even when party_hint.email is absent", async () => {
    // The deterministic-parity case, made explicit: identity ties to the authenticated sender with NO hint.
    const port = new FakePort({ "known@shipper.test": "party-known" });
    const parse: ParseResult = {
      intent: "quote",
      confidence: bps(4000),
      request: { origin_zip: "94105", dest_zip: "07030", weight_lb: 1200 },
    };
    const result = await resolveConcierge(parse, port, SRC, "known@shipper.test");
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(result.party_created).toBe(false);
    expect(result.party_id).toBe("party-known");
    expect(result.resolution_confidence).toBe(10000); // existing + weight, clamped
  });
});
