# SLO targets per surface (REQ-114)

| Surface | Availability | Latency (p95) | Notes |
|---|---|---|---|
| workers/api `/v1` | 99.9%/mo | reads 300ms · mutations 800ms | error budget burn pauses feature merges |
| Command / Portal | 99.5%/mo | first map paint < 2s desktop | static assets on CF edge |
| Driver PWA | offline-first — availability = **sync latency** | offline queue drains < 60s after signal returns | airplane mode is a supported state, not an outage (L1) |
| Evidence email (WP-06) | POD→email p95 < 5s (REQ-031) | — | the heartbeat metric; M-H exit gate |
| Status pages | 99.9%/mo | < 1s | public surface |

Monitors go live with the first deploy (F1-A provides the Cloudflare account); targets are law now so surfaces are built to them. Watchtower (WP-11) alarms on budget drift (REQ-113).

## Alert thresholds and owner (REQ-114)

| Alert | Fires when | Severity | Action |
|---|---|---|---|
| API availability | 5xx rate > 1% over 5 min | page | `wrangler tail shuddl-api-<env>`; roll back if it correlates with a deploy |
| API latency | `/v1` read p95 > 300ms or mutation p95 > 800ms, 10 min | ticket | check D1 + DO contention |
| POD→email | p95 > 5s over 15 min (REQ-031) | page | the heartbeat metric — check the Biller consumer and the sender |
| Queue depth | `shuddl-agent-triggers-<env>` backlog > 100 for 10 min | page | consumer is stalled or crash-looping |
| **DLQ non-empty** | any message on `shuddl-agent-dlq-<env>` | page | inspect + re-drive per docs/ops/dr-backups.md |
| Backup age | newest manifest > 24h (the RPO) | page | the nightly job did not run, or is BLOCKED on credentials |
| Driver sync | offline queue not drained < 60s after signal returns | ticket | airplane mode is a supported state, not an outage (L1) |

**Owner: on-call engineer.** The rota is **not yet staffed** — naming a human is a launch prerequisite and
is carried as an external hold in docs/ops/GO-LIVE-CHECKLIST.md. Until it is staffed none of these alerts
has a recipient, which is itself the reason the hold is open.

## Client performance budgets (REQ-079 / REQ-158)

Enforced by `pnpm perf:map` (`packages/map/perf/perf.spec.ts`) against a **production build**:

| Budget | Value | Enforced |
|---|---|---|
| Board interaction p95, 1,000 entities | <= 500ms | everywhere |
| Longest main-thread task, operating window | <= 100ms | wherever a hardware rasterizer is present |
| Sustained frame rate, 1,000 entities | >= 55 FPS | reference machine only (`PERF_REFERENCE_MACHINE=1`) |
| Serious/critical accessibility findings | 0 | everywhere (`pnpm test:a11y`) |

Reference machine: Apple M-series · macOS 15+ · Chromium with GPU · 1440x900 · AC power. FPS is measured
on every run but enforced only there — a GPU-less CI runner would be asserting SwiftShader, not this code.

> **Corrected 2026-07-25.** An earlier note here claimed the 1,000-entity board blocked the main thread
> for ~580ms as product behaviour. That was a mis-attribution: the block is compositor rasterization in a
> GPU-less harness (527ms of a 560ms task is `Commit`, and a zero-entity board still blocks 358ms). On a
> real GPU the same build produces zero long tasks at 87fps. The long-task budget is enforced only where
> a hardware rasterizer is present — see the enforcement column.
>
> **The real REQ-079 finding:** the board spent 58–62% of the main thread rendering a *static* picture.
> The per-frame data-driven pulse and the 30Hz full-`setData` were the two owners. Tasks 3–4 removed
> them.
>
> **Measured, 3 repeats each, same machine and GPU** (CDP `Performance.getMetrics` `TaskDuration` over
> a 5s steady-state window on the 1,000-entity `?perf=1` board, after a 3s settle):
>
> | Build | Main-thread occupancy | Script |
> |---|---|---|
> | Before (both defects present) | **58.6%** (58.4 / 58.6 / 58.8) | 34.5% |
> | After (Tasks 3 + 4) | **20.3%** (19.8 / 20.2 / 20.9) | 17.9% |
>
> A 38.3-point reduction — two thirds of the main-thread cost of drawing a static board. Note this is
> less than the ~53 points the two owners were individually estimated at: the estimates were measured
> in isolation and overlap, so they do not sum. The board still holds 0 long tasks and ~86fps.
