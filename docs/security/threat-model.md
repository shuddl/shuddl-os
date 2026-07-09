# Threat model v1 (REQ-131 — reviewed at every WP exit; changes logged at the bottom)

## Assets, in order

1. Ledger integrity (append-only history + hash chain + external timestamps) — the product IS this.
2. Tenant isolation (per-tenant D1; the REQ-025 suite is the proof).
3. Evidence bytes (photos/signatures in R2) + their hashes.
4. Device signing keys (driver phones) and JWT secrets.
5. Money projections (invoices, GL export).
6. Tenant identity separation (REQ-167 — no tenant/person/customer/vendor names in this repo).

## Adversaries & surfaces (STRIDE per surface)

| Surface | Top threats | Standing mitigations |
|---|---|---|
| API (`/v1`, `/mcp` later) | tenant-id tampering, token forgery, replayed mutations | claim-only tenant resolution (client tenant ids hard-rejected), JWT verify + schema-parse, tenant-scoped Idempotency-Key, Zod at every boundary (REQ-133), unauthenticated paths reveal nothing (401 before routing) |
| Ledger | event mutation, back-dating, silent correction | no UPDATE/DELETE paths (I3, CI-linted in migrations), hash chain, daily Merkle→TSA (WP-02) |
| Driver PWA | stolen device, GPS spoofing, offline tampering | device keypair non-extractable (WP-05), geofence + accuracy radius disclosed (REQ-018), lockout (REQ-069), location consent as event (REQ-166) |
| Email in/out (WP-06/07) | spoofed inbound, exfil via evidence email | DKIM/SPF/DMARC, sender verification before event attribution, suppression list (REQ-092/157) |
| CI/supply chain | poisoned dep, leaked secret, identity leak | lockfile-pinned installs, gitleaks, OIDC (no static deploy tokens), REQ-167 denylist lint |

## Review log

- 2026-07-09 WP-01: initial model. Next review: WP-02 exit (adds ledger-specific spoofing/tampering rows: chain-fork attempts, seq races, TSA receipt validation).
