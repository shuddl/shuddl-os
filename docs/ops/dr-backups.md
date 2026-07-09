# DR, backups, snapshots (REQ-117, REQ-135)

**Objectives:** RPO 24h · RTO 4h (v1). Full-tenant export = REQ-010 (WP-11 job).

## Nightly ledger snapshots (REQ-117)

- Nightly job exports every tenant D1 (sqlite dump) + the control plane to R2 `shuddl-backups-{env}/` with a date prefix and a sha256 manifest; retained 35 days, monthly snapshots kept 7 years (matches POD lifecycle, REQ-116).
- The workflow stub ships in `.github/workflows/nightly.yml` and activates when F1-A provides Cloudflare credentials via OIDC and WP-02 creates the databases.

## Restore drill (quarterly; first due the quarter after WP-02 lands real data)

1. Pick yesterday's snapshot; restore into a scratch D1.
2. Run chain verification over restored events; row-count parity vs source.
3. Log the drill (date, duration vs RTO, discrepancies) below.

## Drill log

- (none yet — schema lands WP-02)
