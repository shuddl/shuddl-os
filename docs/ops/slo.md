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
| Longest main-thread task, operating window | <= 100ms | everywhere |
| Sustained frame rate, 1,000 entities | >= 55 FPS | reference machine only (`PERF_REFERENCE_MACHINE=1`) |
| Serious/critical accessibility findings | 0 | everywhere (`pnpm test:a11y`) |

Reference machine: Apple M-series · macOS 15+ · Chromium with GPU · 1440x900 · AC power. FPS is measured
on every run but enforced only there — a GPU-less CI runner would be asserting SwiftShader, not this code.

> **Open:** the long-task budget is currently NOT met. The 1,000-entity board blocks the main thread for
> ~580ms in the operating window, reproduced identically on the production bundle, so it is product
> behaviour rather than a harness artifact. `pnpm perf:map` fails on it deliberately. Re-baselining is not
> the fix; the render path is.
