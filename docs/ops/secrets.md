# Secrets & key rotation (REQ-134, REQ-154)

## Rules

1. No secret ever enters the repo, `wrangler.toml`, or CI logs. `gitleaks` runs in CI on every PR.
2. Worker secrets: `wrangler secret put <NAME> --env <env>`. CI deploys authenticate via GitHub Actions OIDC — no long-lived Cloudflare tokens in repo secrets.
3. Per-env API tokens, scoped per env (dev/staging/prod). Staging carries synthetic data only (REQ-154, REQ-155's SEED-1 is the staging dataset).
4. The REQ-167 identity denylist is also a secret-shaped artifact: `IDENTITY_DENYLIST` CI secret or `.identity-denylist.local` (gitignored) — never committed.

## Inventory (grows; every addition lands here)

| Secret | Where | Rotation |
|---|---|---|
| JWT_SECRET | wrangler secret, per env | 90 days or on suspicion |
| IDENTITY_DENYLIST | GitHub Actions secret | on tenant onboarding/offboarding |
| (WP-02+) device signing root | control plane | per drill below |
| RESEND_API_KEY | wrangler secret (`shuddl-agents-*`), per env | on suspicion; use a domain-scoped key |
| TEST_SEND_TOKEN | wrangler secret (`shuddl-agents-*`) | per use of the diagnostic probe |

`EVIDENCE_FROM` (the evidence-email `from`, e.g. `SHUDDL <pod@shuddl.tech>`) is a non-secret var, but the domain must be a **verified** Resend sending domain or Resend 403s.

## Evidence-email go-live (WP-06 CONFIRM-gated tail)

Live send is OFF until both `RESEND_API_KEY` and `EVIDENCE_FROM` are present in the agents worker's env; absent either, the Biller uses `NotConfiguredSender` (no network). To go live: verify `shuddl.tech` in Resend + add its DKIM/SPF/DMARC records (REQ-092), `wrangler secret put RESEND_API_KEY --env <env>`, set `EVIDENCE_FROM`; the Biller's `ResendSender` activates with no code change. Warm the domain first (REQ-157); real consignee volume is milestone-gated (REQ-159, M-H). To *test* the wiring without a verified domain or real recipient, use the guarded `/_dev/evidence-test-send` probe — see `docs/ops/PROJECT-STATE.md` for the exact `.dev.vars` recipe.

## Device-key rotation drill (REQ-134 DoD)

1. Issue new device keypair on device; register the new public key to `users.device_keys[]` (append — the old key stays for verification of already-signed events).
2. New events sign with the new key; ledger verification uses key-at-time-of-event.
3. Revoke the old key for future use; run chain verification over a device's history spanning the rotation.

The drill is executable once device signing lands (WP-05); the procedure is law now so WP-05 builds to it.
