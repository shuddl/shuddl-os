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
pnpm exec tsx tools/deploy/snapshot-ledger.ts --db <source-db>   --tenant <t> --manifest ./backup/manifest.json --out ./backup/src.json
pnpm exec tsx tools/deploy/snapshot-ledger.ts --db <restored-db> --tenant <t> --manifest ./backup/manifest.json --out ./backup/dst.json --rows-out ./backup/rows.json
pnpm restore:verify -- --source ./backup/src.json --restored ./backup/dst.json --mode release
# --rows re-walks the chain but assumes ONE stream, so it fails on any real tenant — see the drill log.

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

### 2026-07-31 — first drill ever run. Verdict: **PASS on 10 dimensions, FAIL on the chain re-walk.**

**Run on STAGING, deliberately.** Production's ledger is empty — `shuddl-t-tenant-a-prod` holds
`events=0, invoices=0, money_lines=0`. A drill there reconciles 0 against 0 with no hash chain to walk and
no money to compare: eleven green checks that inspected nothing. `shuddl-t-tenant-a-staging` carries a real
chain (40 events across 5 streams), 5 invoices, 10 money lines and 17 anchor days, so it is the only
database in the account on which this gate can currently say anything. Repeat on prod once it has freight.

| | |
|---|---|
| Repo | HEAD `1e63d27` |
| Backup | `pnpm backup -- --env staging --out /tmp/restore-drill --mode release` → **PASS**, 6 databases, manifest digest `7b04573777ec…`, `takenAt 2026-07-31T13:26:03.116Z`, retention 30d |
| Source | `shuddl-t-tenant-a-staging` → `shuddl-t-tenant-a-staging.sql`, 63,442 bytes, sha256 `6341cf424252…` |
| Restored into | `shuddl-restore-drill` (scratch D1, created for the drill, **deleted afterwards** — confirmed absent from `wrangler d1 list`); 18 tables, 533 rows written |
| Snapshots | `tools/deploy/snapshot-ledger.ts --db … --tenant tenant-a --manifest … --out …` (new; nothing produced a `LedgerSnapshot` before it, which is why this gate had never run) |
| Elapsed | ~17 min end to end, against a 4h RTO |

Reconciled numbers — **identical on both sides, byte for byte, apart from `capturedAt`**:

| Dimension | Value |
|---|---|
| events | 40, head `2c504f982d24…` (5 streams × 8) |
| invoices | 5 / **279,000¢** |
| money_lines | 10 / **279,000¢** |
| anchors | 17 days; `2026-07-14` root `375e8c8cbbc2…` over 32 leaves, the other 16 days anchored empty (0 leaves) |
| manifest digest | `7b04573777ec…` on both sides |

`restore-verify --source … --restored …` → `PASS — the restored ledger is the same ledger`, 11 checks,
0 problems (`##SHUDDL-GATE## {"gate":"restore-verify","status":"PASS","executed":true,"assertions":11}`).

**And then, with `--rows`, it FAILED — and the failure is in the checker, not the data:**

```text
MISMATCH  chain-broken   chain — restored chain fails at seq 0: seq_gap
```

`verifyChainOfRows` walks every supplied row as ONE chain: `verifyChain` expects `seq` dense from 0 and a
single `prev_hash` walk from genesis. SHUDDL chains **per stream** (`PRIMARY KEY (stream_id, seq)`), so at
the second stream's `seq 0` the walker is expecting `seq 8` and reports `seq_gap`. Every real tenant
database has more than one stream, so **`restore-verify --rows` cannot pass on any of them** — the one
dimension that re-derives the chain from the rows is the one dimension that cannot execute. That is worse
than a check that fails: it is a check that cries data loss where there is none, which is how an operator
learns to skip it. Recorded as a finding; NOT worked around by editing a snapshot or loosening the checker.

The chain was re-walked anyway, correctly: `snapshot-ledger.ts --rows-out` groups by `stream_id` and walks
each stream through the ledger's own `verifyChain` before it will write anything —

```text
snapshot-ledger: hash chain re-walked — 5 stream(s), 40 event(s), all intact.
  s:SMK-6x24q9g6jc   8 events  head a6542bf593d1…      s:SMK-vb5te0wmkd   8 events  head f8164c55a88c…
  s:SMK-ikr326on5l   8 events  head dc370feabaf2…      s:SMK-zhab5mmi3x   8 events  head 2c504f982d24…
  s:SMK-pd3coz6lz5   8 events  head e2b5f519f37b…
```

40 of 40 events verified, and the last stream's head is the snapshot's head hash. So the restore is sound;
the gate's own chain path is not.

### The chain path, fixed the same day (2026-07-31)

`verifyChainOfRows` now groups rows by `stream_id`, orders each group by `seq`, and walks each group
through the ledger's own `verifyChain`. `packages/ledger/src/chain.ts` is untouched and still knows nothing
about streams — it remains the single authority on what a valid chain is, and this function only groups,
orders, and aggregates. Caller order is not trusted: rows supplied `seq`-descending with streams
interleaved produce a byte-identical verdict.

The aggregate head is the head of the lexicographically-last stream — the last event under
`(stream_id, seq)`, which is exactly what `snapshot-ledger.ts` captures
(`ORDER BY stream_id DESC, seq DESC LIMIT 1`). The two definitions had to reconcile or the fix would have
traded a false `chain-broken` for a false `chain-head-mismatch`; they do, and it was proven on the drill's
real data rather than in principle — the walked head equals the snapshot's `headHash` character for
character. A failure now names its stream (`at seq 5 of stream s:SMK-…`), because a bare `seq 0` is
ambiguous across streams to an operator reading it mid-incident.

Re-run against the same real staging artifacts:

```text
restore-verify: chain re-walked per stream from 40 restored row(s) — 40 event(s) intact, head 2c504f982d24…
restore-verify: PASS — the restored ledger is the same ledger.   (11 checks, 0 problems)
```

And the negative controls on that same real data, which are what make the PASS mean anything:

| tamper | verdict |
|---|---|
| drop one row | `chain fails at seq 5 of stream s:SMK-ikr326on5l: seq_gap` |
| flip a byte in `hash` | `seq 6 of stream s:SMK-zhab5mmi3x: hash_mismatch` |
| flip a byte in `prev_hash` | `seq 2 of stream s:SMK-pd3coz6lz5: prev_hash_mismatch` |

An empty walk returns `{ok, head: GENESIS_HASH, count: 0}` rather than failing — prod's ledgers are empty
today, and a gate permanently red on a true fact trains the same "skip it" reflex this fix removes. It is
not a silent pass: the tool prints that an empty walk proves nothing, and an empty walk against a snapshot
claiming events still fails `chain-count-mismatch` and `chain-head-mismatch`.
