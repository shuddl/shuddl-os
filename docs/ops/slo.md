# SLO targets per surface (REQ-114)

| Surface | Availability | Latency (p95) | Notes |
|---|---|---|---|
| workers/api `/v1` | 99.9%/mo | reads 300ms · mutations 800ms | error budget burn pauses feature merges |
| Command / Portal | 99.5%/mo | first map paint < 2s desktop | static assets on CF edge |
| Driver PWA | offline-first — availability = **sync latency** | offline queue drains < 60s after signal returns | airplane mode is a supported state, not an outage (L1) |
| Evidence email (WP-06) | POD→email p95 < 5s (REQ-031) | — | the heartbeat metric; M-H exit gate |
| Status pages | 99.9%/mo | < 1s | public surface |

Monitors go live with the first deploy (F1-A provides the Cloudflare account); targets are law now so surfaces are built to them. Watchtower (WP-11) alarms on budget drift (REQ-113).
