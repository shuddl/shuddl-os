// REQ-042/182 (WP-08 T6; origin REQ-047) — PURE unit tests for the two booking gates. Like every transition
// gate, assertBookingCredit / assertBookingRecipientContact are pure decisions (no D1, no Date): the DO (Task
// 6) loads the SERVER-SOURCED context from parties (the bill_to's credit_status AND the bill_to's contacts —
// the bill_to is the party the Biller emails) and calls these before it appends booking.created.
// booking.created is the FIRST event of a fresh direct-booking stream, so NEITHER gate reads prior events —
// they read only the incoming payload + the loaded context.
//
// Both are GATE_BLOCKED (missing prerequisite), NOT the VALIDATION_FAILED the appointment gate uses (a
// booking conflict): a credit hold / an unreachable recipient is a required-evidence miss like the physical
// gates. Credit is OVERRIDABLE (REQ-049); the recipient-contact gate is deliberately NON-overridable — the
// payload opt-out is its purpose-built escape.
import { describe, expect, it } from "vitest";
import { eventFixture, type LedgerEvent } from "@shuddl/contracts";
import {
  assertBookingCredit,
  assertBookingRecipientContact,
  GateError,
  GateValidationError,
  REQUIRED_EVIDENCE,
  type Override,
} from "../src/gates/transition-gates.js";
import { plausibleEmail, hasDeliverableContact } from "../src/contacts.js";

const OK_OVERRIDE: Override = { by: "credit-manager-7", reason: "prepay wired; hold released by finance" };

// A booking.created fixture; payloadOver perturbs one field (e.g. the opt-out flag).
function booking(payloadOver: Record<string, unknown> = {}): LedgerEvent {
  return eventFixture("booking.created", {
    payload: {
      quote_event_id: "evt-quote-1",
      shipper_party_id: "party-shipper",
      consignee_party_id: "party-consignee",
      bill_to_party_id: "party-bill-to",
      division: "main",
      ...payloadOver,
    },
  });
}

const EMAIL_CONTACTS = [{ kind: "primary", email: "receiver@consignee.example" }];
const BILLING_CONTACTS = [{ kind: "billing", email: "ap@consignee.example" }];
const NO_EMAIL_CONTACTS: unknown[] = [{ kind: "primary", phone: "+15035551212" }]; // phone only — not deliverable in v1

function blockedEvidence(fn: () => void): string[] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GateError);
    return (e as GateError).required_evidence;
  }
  throw new Error("expected the gate to throw a GateError, but it passed");
}

// =====================================================================================
describe("REQ-042 assertBookingCredit — a bill_to credit HOLD blocks booking.created (overridable)", () => {
  it("credit_status 'hold' blocks with ['credit_clear']", () => {
    expect(blockedEvidence(() => assertBookingCredit("hold"))).toEqual([REQUIRED_EVIDENCE.credit_clear]);
  });

  it("'clear' passes", () => {
    expect(() => assertBookingCredit("clear")).not.toThrow();
  });

  it("'review' passes (only an explicit hold blocks)", () => {
    expect(() => assertBookingCredit("review")).not.toThrow();
  });

  it("null / undefined credit_status passes (no decision on file is not a hold)", () => {
    expect(() => assertBookingCredit(null)).not.toThrow();
    expect(() => assertBookingCredit(undefined)).not.toThrow();
  });

  it("a valid named override releases the hold (REQ-049)", () => {
    expect(() => assertBookingCredit("hold", { override: OK_OVERRIDE })).not.toThrow();
  });

  it("a blank/unaccountable override is a VALIDATION_FAILED (never a silent pass)", () => {
    expect(() => assertBookingCredit("hold", { override: { by: "  ", reason: "" } })).toThrow(GateValidationError);
    expect(() => assertBookingCredit("hold", { override: { by: "x", reason: "" } })).toThrow(/VALIDATION_FAILED/);
  });

  it("the block is a GATE_BLOCKED envelope, not the appointment gate's VALIDATION_FAILED", () => {
    let caught: unknown;
    try {
      assertBookingCredit("hold");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GateError);
    expect((caught as Error).message).toContain("GATE_BLOCKED");
    expect((caught as Error).message).not.toContain("VALIDATION_FAILED");
  });
});

// =====================================================================================
describe("REQ-182 assertBookingRecipientContact — no deliverable bill_to contact blocks unless opted out", () => {
  it("a recipient with a deliverable email passes", () => {
    expect(() => assertBookingRecipientContact(booking(), EMAIL_CONTACTS)).not.toThrow();
  });

  it("a billing-kind email also passes (any deliverable email suffices)", () => {
    expect(() => assertBookingRecipientContact(booking(), BILLING_CONTACTS)).not.toThrow();
  });

  it("no email + no opt-out blocks with ['evidence_recipient']", () => {
    expect(blockedEvidence(() => assertBookingRecipientContact(booking(), NO_EMAIL_CONTACTS)))
      .toEqual([REQUIRED_EVIDENCE.evidence_recipient]);
  });

  it("an empty contacts array blocks with ['evidence_recipient']", () => {
    expect(blockedEvidence(() => assertBookingRecipientContact(booking(), []))).toEqual([REQUIRED_EVIDENCE.evidence_recipient]);
  });

  it("a non-array (parse failure / null) blocks — fail-closed, never a fabricated pass", () => {
    expect(blockedEvidence(() => assertBookingRecipientContact(booking(), null))).toEqual([REQUIRED_EVIDENCE.evidence_recipient]);
  });

  it("the payload opt-out flag passes even with NO contact (the deliberate escape)", () => {
    expect(() => assertBookingRecipientContact(booking({ evidence_contact_opt_out: true }), [])).not.toThrow();
  });

  it("opt-out:false is NOT an escape — still blocks when there is no contact", () => {
    expect(blockedEvidence(() => assertBookingRecipientContact(booking({ evidence_contact_opt_out: false }), [])))
      .toEqual([REQUIRED_EVIDENCE.evidence_recipient]);
  });

  it("the block is a GATE_BLOCKED envelope, not VALIDATION_FAILED", () => {
    let caught: unknown;
    try {
      assertBookingRecipientContact(booking(), []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GateError);
    expect((caught as Error).message).toContain("GATE_BLOCKED");
    expect((caught as Error).message).not.toContain("VALIDATION_FAILED");
  });
});

// =====================================================================================
// The shared deliverable-contact predicate (REQ-182 / REQ-031) — the SAME logic the Biller's
// resolveRecipient applies to the SAME party (the bill_to), so a gate-passing booking is one the Biller can
// reach: the party checked == the party emailed.
describe("shared contacts predicate — plausibleEmail / hasDeliverableContact", () => {
  it("plausibleEmail returns the address for a well-formed email contact", () => {
    expect(plausibleEmail({ kind: "billing", email: "ap@x.example" })).toBe("ap@x.example");
  });
  it("rejects a non-email, a CR/LF-poisoned value, a non-object", () => {
    expect(plausibleEmail({ kind: "primary", phone: "555" })).toBeUndefined();
    expect(plausibleEmail({ email: "a@b\r\nBCC: evil@x" })).toBeUndefined();
    expect(plausibleEmail("ap@x.example")).toBeUndefined();
    expect(plausibleEmail(null)).toBeUndefined();
  });
  it("hasDeliverableContact is true iff some entry is a deliverable email", () => {
    expect(hasDeliverableContact([{ phone: "1" }, { email: "a@b.example" }])).toBe(true);
    expect(hasDeliverableContact([{ phone: "1" }])).toBe(false);
    expect(hasDeliverableContact([])).toBe(false);
    expect(hasDeliverableContact(null)).toBe(false);
    expect(hasDeliverableContact("not-an-array")).toBe(false);
  });
});
