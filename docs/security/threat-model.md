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
| TSA receipt validation | A forged/replayed RFC 3161 timestamp response | Structural DER parse + genTime/imprint/nonce checks (`assertGrantedReceipt`) PLUS, as of WP-16, cryptographic verification (`verifyTsaSignature`, `packages/ledger/src/tsa/cms.ts`, REQ-014): the CMS SignerInfo signature over the DER of `signedAttrs` is verified via Web Crypto (RSASSA-PKCS1-v1_5 or ECDSA-P256, both SHA-256), the `messageDigest` attr is confirmed = SHA-256(TSTInfo) and `contentType` = id-ct-TSTInfo, and the signer cert is chained (issuer/signature) to a CONFIGURED trust anchor, time-valid at genTime, carrying the id-kp-timeStamping EKU. Fail-CLOSED on every failure (invalid sig, digest mismatch, no chain, expired, missing EKU, unsupported alg). It is an OPT-IN seam: with no `trustAnchors` supplied it returns an explicit `chain-not-configured` state (never a silent pass), and the protocol verify stands. CLOSED. Remaining as DEPLOYMENT concerns (NOT offline-verification gaps): (a) revocation (OCSP/CRL) — needs network, checked at stamping time, out of scope for archival replay; (b) the real TSA's trust-anchor certs are config supplied at deploy (out-of-repo F1 [CONFIRM]; `HttpTsaClient` is fake-tested only; the in-repo verifier is tested against a SELF-GENERATED synthetic test CA). |
| Anchor day-bucket skew | An airplane-mode upload back-dates `ts` to mutate an already-anchored day | Merkle day-bucketing keys on `recorded_at` (server clock at append), never actor `ts`. CLOSED. |
| Lens / geo leakage | A counterparty/driver lens reveals events, positions, or precise geo outside its scope | Server-side lens filtering + per-event visibility + redaction; the adversarial cross-lens suite (workers/api/test/lens-adversarial.test.ts) has INDEPENDENT guards on the geo/city sweep (case 9b), so a scoping regression makes it fail rather than pass silently. CLOSED. |

## Review log

- 2026-07-09 WP-01: initial model. Next review: WP-02 exit (adds ledger-specific spoofing/tampering rows: chain-fork attempts, seq races, TSA receipt validation).
- 2026-07-10 WP-02: added the ledger tampering & timestamping review above (chain-fork, seq races, silent REPLACE, TSA receipt validation, anchor day-bucket skew, lens/geo leakage). Only TSA CMS/cert-chain verification remains open (deferred to WP-16; raw receipts retained). Next review: WP-03 exit (board-DO fan-out + live map subscription scoping).
- 2026-07-22 WP-16: CLOSED the last WP-02 open item — TSA CMS SignerInfo signature + X.509 cert-chain verification landed (`verifyTsaSignature`, REQ-014). The archival `.tsr` bytes in R2 are now cryptographically verifiable offline (signature over signedAttrs, messageDigest binds TSTInfo, chain to a configured trust anchor, validity, timestamping EKU), fail-closed, opt-in on configured anchors. Revocation (OCSP/CRL) and the real trust-anchor certs stay deployment concerns, documented in the TSA row above.
- 2026-07-22 WP-16: VERIFIED the REQ-074 server-side geo-privacy boundary (the WP-03 open concern that `generalizePosition` was "client-consumed"). It IS the server-side lens: `redactEvent` (`packages/ledger/src/redact.ts`) coarsens a PARTY lens's positions to ~11 km + drops accuracy until out-for-delivery — a STRUCTURAL walk (top-level `lat_e6`/`lon_e6` AND nested `geo`); DRIVER/TENANT keep exact geo. Every party-reachable read goes through the lens (`readEvents`→`applyLens`) or `/pub/status` (which generalizes server-side, coarse even at OFD — the forwardable-cap law); `GET /v1/board` is TENANT-only (exact ops geo is correct) and the portal party fleet still consumes a SYNTHETIC source (the live board-DO fan-out to a party lens is unbuilt). Proven by `redact.test.ts` (party-coarsen / driver+tenant-exact / OFD-unlock / nested-geo). Remaining: hold this before public status-page HOSTING stands up (a deploy gap, GO-LIVE §2) and when a real party-scoped live feed lands.
- 2026-07-10 WP-03: map surface. New rows — **tile provenance** (self-hosted vectors only; no third-party branding/telemetry, REQ-075; a CDN tile leak exposes fleet geography to a third party). **Status-page geo-privacy** (public no-auth one-shipment pages must serve server-generalized ~city coords until out-for-delivery; exact coords on a public page is a REQ-074 breach — `generalizePosition` enforces it client-consumed, but the true boundary is server-side scoping, WP-02 lens). **Cross-lens map leakage** (the entity source must be lens-scoped server-side, never a client filter of the full fleet). Live board-DO fan-out lands WP-10 — until then the map consumes a synthetic source. Next review: WP-05 exit (Driver PWA offline map + GPS consent).
