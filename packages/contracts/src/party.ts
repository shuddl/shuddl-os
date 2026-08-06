// The ONE shared party-identity matcher (REQ-196). The CSR intake (workers/api) AND the Concierge email path
// (workers/agents) both derive the email-keyed party id and both FIND parties through THIS helper, so a
// CSR-created `Bob@Acme.com` and a later Concierge inbound `bob@acme.com` converge on ONE party row — closing
// the split-billing / credit-hold-evasion duplicate the two divergent (case-sensitive vs case-insensitive,
// `concierge:party:` vs `intake:party:`) implementations opened. Per the share-lint-matchers-with-parity-tests
// rule: extract the rule ONCE, both surfaces consume it, and a contracts parity test pins the derivation.
//
// REQ-024: a PURE crypto util — no ledger/agent import, no zod. `crypto.subtle` SHA-256 is available in both
// Node and Cloudflare Workers, so contracts stays the shared, dependency-light boundary both workers import.

/**
 * The canonical normalization of an email used as a party KEY: trim + lowercase. Callers still STORE the
 * original-case email (for display/deliverability) — only the match key and the derived id are normalized.
 */
export function normalizePartyEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The email-keyed party id both surfaces derive: `party_<first 16 hex of sha-256('shuddl:party:email:' +
 * normalizePartyEmail(email))>`. Domain-separated so it never collides with other id namespaces, and computed
 * over the NORMALIZED email so `Bob@Acme.com` and `bob@acme.com` yield the SAME id (one party, not two).
 */
export async function partyIdForEmail(email: string): Promise<string> {
  return `party_${(await sha256Hex(`shuddl:party:email:${normalizePartyEmail(email)}`)).slice(0, 16)}`;
}

/**
 * The NAME-keyed party id both surfaces derive when the party carries no email: `party_<first 16 hex of
 * sha-256('intake:party:name:' + trim(lower(name)))>`.
 *
 * THE `intake:` PREFIX IS LEGACY AND DELIBERATE. It does not match `partyIdForEmail`'s `shuddl:` namespace
 * because this scheme predates the extraction and is already persisted in `parties.id`; re-namespacing it
 * would orphan every name-keyed party ever created and split each one in two. Byte-exactness is the point,
 * not symmetry — do not "tidy" this prefix.
 *
 * Extracted (audit §433) per the note BOTH call sites carried. It had been inlined three times — once in
 * `workers/api/src/intake-core.ts` and twice in `workers/translator/src/core/map-204.ts` — under a comment
 * reading "MUST byte-match … pinned by test/party-id-parity.test.ts". That lock pinned only the translator
 * copy against a formula the test itself recomputed, so changing intake-core's scheme left it GREEN (6/6,
 * measured) while the two surfaces drifted into DUPLICATE broker parties: the split-billing and
 * credit-hold-evasion risk on the name axis (REQ-196). One function, three callers, no lock required.
 */
export async function partyIdForName(name: string): Promise<string> {
  return `party_${(await sha256Hex(`intake:party:name:${name.trim().toLowerCase()}`)).slice(0, 16)}`;
}
