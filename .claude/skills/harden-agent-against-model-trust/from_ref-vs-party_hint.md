# Identity resolution: authenticated from_ref vs. model party_hint

REQ-172 (SEC): party find-or-create keys off the AUTHENTICATED envelope sender
(`from_ref`), NEVER the model-supplied `party_hint.email`. Reference:
`packages/agents/src/concierge/resolve.ts:119-163`.

## Why
For the ClaudeParser, `party_hint` is model output over an untrusted body
(`parse.ts:35-38`). A crafted email can:
- name an **attacker** address → create a party on it, or
- name a **victim's on-file** address → earn the existing-party resolution bump
  (`resolutionConfidence`, `resolve.ts:98-103`), a confidence bypass,
while the message is actually impersonating the sender. Both are prevented only by
tying identity to the authenticated envelope, not the model's word.

## The two fields
| Field | Source | Trust | Role |
|---|---|---|---|
| `senderEmail` (from_ref) | envelope, SPF/DKIM-authenticated upstream (WP-06 inbound) | authenticated | THE identity key: find/create + party-signal gate (`resolve.ts:130,142,157`) |
| `party_hint.email` | LLM parse of body | untrusted | routing/notes only — NEVER the identity key |
| `party_hint.name` | LLM parse of body | untrusted | cosmetic display name of a newly created party only (`resolve.ts:158-159`), length-bounded at parse (`parse.ts:38`) |

## Load-bearing upstream dependency
Party-match keys off the `From` email, so sender authentication (SPF/DKIM, WP-06)
is load-bearing — a spoofed From to a known customer's address would earn the
existing-party bump. That defense lives UPSTREAM (inbound auth), not in resolve
(`resolve.ts:16-19`). When you build an agent that resolves identity from any
channel, verify the channel is authenticated before trusting its sender.

## Note: the deterministic parser already sets party_hint = from_ref
So for the deterministic path this is a no-op; REQ-172 binds the ClaudeParser
CONFIRM-gate — the moment the LLM path goes live, the authenticated-sender key is
what stops the impersonation. Sibling defenses: REQ-171 (send corroboration) and
the I2 send-recipient pin — the same never-trust-the-model doctrine at each seam.

## Checklist for a new agent
1. Identify the identity-bearing field(s) of the inbound (sender, driver id, tenant).
2. Confirm each comes from an authenticated channel, not a model extraction.
3. Any model-extracted contact is cosmetic/routing metadata only — never a match/create key.
4. Score resolution confidence on DB-verified facts (does this party already exist on
   the authenticated key?), not the model's confidence.
