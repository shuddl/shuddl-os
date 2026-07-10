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
| Ledger | event mutation, back-dating, silent correction, chain fork, seq races | no UPDATE/DELETE paths + BEFORE INSERT guards (I3, CI-linted in migrations), server-assigned hash chain, daily Merkle→TSA (WP-02), DO-per-stream seq mutex — see the WP-02 review below |
| Driver PWA | stolen device, GPS spoofing, offline tampering | device keypair non-extractable (WP-05), geofence + accuracy radius disclosed (REQ-018), lockout (REQ-069), location consent as event (REQ-166) |
| Email in/out (WP-06/07) | spoofed inbound, exfil via evidence email | DKIM/SPF/DMARC, sender verification before event attribution, suppression list (REQ-092/157) |
| CI/supply chain | poisoned dep, leaked secret, identity leak | lockfile-pinned installs, gitleaks, OIDC (no static deploy tokens), REQ-167 denylist lint |

## WP-02 review — ledger tampering & timestamping (new)

| Threat | Vector | Mitigation / status |
|---|---|---|
| Chain fork | A client supplies its own `seq`/`prev_hash`/`hash` to branch history | The sequencer parses request bodies as `EventInput` (which carries NO `seq`/`prev_hash`/`hash`/`stream_id`) and assigns them server-side; `LedgerEvent.parse` is a `.strict()` backstop. `hash` is computed, never client-supplied. CLOSED. |
| Seq race | Two concurrent appends read the same tail and assign the same `seq` | DO-per-stream serialization mutex. LOAD-BEARING because a Cloudflare DO input gate closes only during the DO's OWN `ctx.storage` ops (and `blockConcurrencyWhile`) — it does NOT span a plain D1 subrequest await, and this sequencer reads its tail + writes its batch via D1. Deleting the mutex turns the 100-concurrent test red with `SQLITE_CONSTRAINT` on the duplicate `(stream_id, seq)`. CLOSED. |
| Silent REPLACE | `INSERT OR REPLACE` under D1's `PRAGMA recursive_triggers=0` skips the BEFORE DELETE guard and rewrites a row | BEFORE INSERT guards on events/positions/money_lines fire while the old row still exists (migration 0003); the load path uses plain INSERTs only. Regression-tested in schema-core.test.ts. CLOSED. |
| TSA receipt validation | A forged/replayed RFC 3161 timestamp response | Structural DER parse + genTime/imprint checks now; **CMS signature + cert-chain verification is DEFERRED to WP-16** (the raw `.tsr` bytes are retained in R2, so a receipt is verifiable offline forever — deferral does not lose evidence). Real-endpoint smoke is blocked on the F1 [CONFIRM]; `HttpTsaClient` is fake-tested only. OPEN (tracked). |
| Anchor day-bucket skew | An airplane-mode upload back-dates `ts` to mutate an already-anchored day | Merkle day-bucketing keys on `recorded_at` (server clock at append), never actor `ts`. CLOSED. |
| Lens / geo leakage | A counterparty/driver lens reveals events, positions, or precise geo outside its scope | Server-side lens filtering + per-event visibility + redaction; the adversarial cross-lens suite (workers/api/test/lens-adversarial.test.ts) has INDEPENDENT guards on the geo/city sweep (case 9b), so a scoping regression makes it fail rather than pass silently. CLOSED. |

## Review log

- 2026-07-09 WP-01: initial model. Next review: WP-02 exit (adds ledger-specific spoofing/tampering rows: chain-fork attempts, seq races, TSA receipt validation).
- 2026-07-10 WP-02: added the ledger tampering & timestamping review above (chain-fork, seq races, silent REPLACE, TSA receipt validation, anchor day-bucket skew, lens/geo leakage). Only TSA CMS/cert-chain verification remains open (deferred to WP-16; raw receipts retained). Next review: WP-03 exit (board-DO fan-out + live map subscription scoping).
