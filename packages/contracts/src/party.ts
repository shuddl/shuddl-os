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
