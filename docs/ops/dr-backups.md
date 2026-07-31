# DR, backups, snapshots (REQ-117, REQ-135)

**Objectives: RPO ≤ 24h · RTO ≤ 4h.** Both numbers are enforced, not aspirational:
`tools/deploy/preflight.ts` BLOCKS a promotion when the newest backup manifest is older than
`RPO_HOURS` (24) or retention is shorter than `BACKUP_RETENTION_DAYS` (30). Full-tenant export = REQ-010.

## Nightly backup (REQ-117)

`.github/workflows/nightly.yml` → job `backup`, 08:00 UTC daily.

1. Runs `pnpm backup -- --env <env> --mode release` (`tools/deploy/backup.ts`), which DERIVES the
   database set from the committed `[env.<env>]` scopes — six for staging, six for production, never a
   list — and exports each with `wrangler d1 export <db> --remote`. One failed export fails the run.
2. Writes `manifest.json` — per-file sha256 + byte size, the environment, the commit, `takenAt`, the
   retention window, and a `digest` (canonical-JSON sha256 over the manifest body). That digest is what
   `tools/deploy/restore-verify.ts` reconciles against a restored database. Never over a partial export.
3. Retains the artifact for 30 days.

**When `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` are unbound the job exits 2 (BLOCKED) and takes
no backup.** It does not pass. A green backup job that produced no backup is how you find out, on the day
you need it, that there is nothing to restore.

> Monthly snapshots kept 7 years (matching the POD lifecycle, REQ-116) are **not yet implemented** — the
> nightly artifact retention is 30 days. Owner: infrastructure. Named hold in GO-LIVE-CHECKLIST.

## Restore procedure (RTO ≤ 4h)

```bash
# 1. Fetch the backup artifact for the target date, then restore into a scratch database.
wrangler d1 create shuddl-restore-drill
wrangler d1 execute shuddl-restore-drill --remote --file ./shuddl-t-tenant-a-staging.sql

# 2. Reconcile the restored ledger against the source snapshot. Any mismatch fails.
pnpm restore:verify -- \
  --source   ./backup/snapshot-source.json \
  --restored ./backup/snapshot-restored.json \
  --rows     ./backup/restored-events.json      # optional: re-walks the full hash chain

# 3. Re-point and smoke, only after the reconcile passes.
SMOKE_API_BASE=https://<deployed> SMOKE_JWT_SECRET_FILE=./jwt.txt pnpm smoke:staging -- --mode release
```

`restore:verify` reconciles 11 dimensions and fails on any one of them: tenant identity, event count,
head hash, chain validity (walked through the ledger's own `verifyChain`), chain count/head agreement,
invoice count and total cents, money-line count and sum, every anchor day's merkle root and leaf count,
and the manifest digest. A restore that "mostly" matches is silent data loss — and on an append-only
ledger there is no later diff that can tell you which rows went missing.

## Rollback and forward-repair

The `events` table is **forward-only by design** (I3/I7): there is no rollback of ledger data, ever. A bad
append is corrected by a new correcting event, never by deleting or editing the original.

| Failure | Action |
|---|---|
| Bad worker deploy | `wrangler rollback --name shuddl-api-<env>` — code only, no data implication |
| Bad domain/control migration | Forward-repair migration (`db/tenant/migrations/NNNN_*.sql`). Never edit a pinned migration; `pnpm db:lock` updates `db/migrations.lock.json` |
| Bad projection state | Re-derive the read model from the ledger; the ledger is the authority |
| Bad ledger append | New correcting event (`invoice.corrected`, etc.). Never `UPDATE`/`DELETE` on `events` |
| Data loss suspected | Restore drill above into a scratch DB, reconcile, then decide — do not restore over a live tenant |

## DLQ inspection and re-drive (REQ-114)

The agents queue consumer declares `dead_letter_queue = shuddl-agent-dlq-<env>` with `max_retries = 5`.

```bash
wrangler queues consumer list shuddl-agent-dlq-staging      # is anything parked?
wrangler tail shuddl-agents-staging --format pretty         # why did it park?
```

Re-drive is **idempotent by construction** — every agent keys off the event id, so replaying a parked
message cannot double-append (I1). Re-drive by re-enqueueing the trigger payload onto
`shuddl-agent-triggers-<env>`. Before re-driving, confirm the poison message is not a permanent hold: a
Biller hold emits a durable internal note rather than looping (REQ-169).

**Owner: on-call engineer** (rota not yet staffed — named hold, see GO-LIVE-CHECKLIST).

## Restore drill (quarterly)

1. Pick yesterday's backup; restore into a scratch D1.
2. Run `pnpm restore:verify` with both snapshots; capture the report.
3. Log the drill below: date, duration vs the 4h RTO, and every discrepancy.

## Drill log

- (none yet — the first drill is due the quarter after the nightly `backup` job has credentials bound.)
