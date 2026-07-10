# Blessed screenshot references — the five canonical screens (WP-03 DoD, audit #6)

These are the reference PNGs the Playwright screenshot diff compares against
(`tests/visual/screens.spec.ts`, driven by `../../playwright.config.ts`). One
per canonical surface:

| File | Screen | Route |
|---|---|---|
| `command.png` | Command board — full-viewport map, KPI strip, queues, ⌘K bar | command app `/` |
| `portal.png` | Client portal — scoped map, name hero, quote→book, ruled docs | portal app `/?screen=portal` |
| `status.png` | Public status — one shipment, city-generalized position | portal app `/?screen=status` |
| `driver.png` | Driver gate — `--ink-dark` ground, gated-stop question, teal progress | driver app `/` |
| `evidence-email.png` | Evidence email — greige "DELIVERED", POD photos, red rules | portal app `/?screen=email` |

## How the refs get here

Blessed PNGs are **generated on the first run of a browser-capable machine** —
this sandbox has no Playwright browser (and no network to the map/font CDNs), so
the refs are not committed yet. On a machine with a browser:

```sh
pnpm exec playwright install chromium   # once
pnpm exec playwright test -c playwright.config.ts --update-snapshots
```

That writes `command.png` … `evidence-email.png` into this directory. Commit
them, and every later `pnpm test:visual` diffs against them.

## Advisory (REQ-158)

The diff is **report-only until WP-10 exits**. `pnpm test:visual` runs the guard
(`tools/harness/playwright-guard.ts`): a missing browser ⇒ clean SKIP (exit 0); a
real drift ⇒ a printed report + a diff written to `test-results/`, still exit 0.
Only `pnpm test:visual --strict` turns drift into a non-zero exit. `pnpm verify`
never depends on any of this.
