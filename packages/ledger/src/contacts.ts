// REQ-182 / REQ-031 (origin REQ-047) — the ONE deliverable-contact predicate, shared by BOTH the booking
// evidence-recipient gate (packages/ledger/src/gates/transition-gates.ts assertBookingRecipientContact) AND
// the Biller's recipient resolution (workers/agents/src/biller.ts resolveRecipient). The gate checks the
// SAME party the Biller emails — the bill_to — with this SAME predicate, so a booking that passes the gate
// is one whose bill_to resolveRecipient can actually reach: the party CHECKED equals the party EMAILED,
// which is what makes "a gate-passing booking yields a resolvable evidence recipient" true. Sharing the
// per-entry predicate is the anti-drift guarantee: if the two ever diverged, a booking could pass the gate
// yet the same party fail resolution.
//
// parties.contacts is a JSON array of `{kind?, email?, ...}` objects (doc 10 §03; the tenant plane's only
// email-bearing column). A DELIVERABLE email is a string containing "@" with no CR/LF (header-safe — a
// CR/LF value would otherwise ride into a mail header). SMS/phone is a REQ-097 follow-up: no SMS sender
// exists yet, so v1 counts ONLY a plausible email — the fail-closed choice that keeps the guarantee true
// (an SMS-only consignee that passed the gate could not receive today's email-only evidence, breaking GA-6).
// When REQ-097 lands an SMS channel, broaden hasDeliverableContact to also accept an SMS contact.
//
// PURE: no D1, no Date, no random (REQ-024-safe — this is imported by the ledger gate).

/**
 * The single per-contact-entry email predicate. Returns the deliverable email string, or undefined when
 * the entry is not an object, has no string `email`, the value lacks "@", or it carries a CR/LF (unsafe).
 * Byte-identical to the check the Biller applies; workers/agents/src/biller.ts imports THIS to stay in sync.
 */
export function plausibleEmail(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const email = (entry as Record<string, unknown>)["email"];
  return typeof email === "string" && email.includes("@") && !/[\r\n]/.test(email) ? email : undefined;
}

/**
 * True iff a parsed parties.contacts value (an array of contact entries) carries at least one deliverable
 * email contact. Defensive: a non-array (null, a parse failure the caller passes through, an object) yields
 * false → the consignee gate blocks (fail-closed), never a fabricated pass.
 */
export function hasDeliverableContact(contacts: unknown): boolean {
  if (!Array.isArray(contacts)) return false;
  return contacts.some((entry) => plausibleEmail(entry) !== undefined);
}
