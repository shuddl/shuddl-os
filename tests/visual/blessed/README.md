# Blessed screenshot references — the five canonical screens (WP-03 DoD, audit #6)

These are the reference PNGs the Playwright screenshot diff compares against
(`tests/visual/screens.spec.ts`, driven by the repo-root `playwright.config.ts`). One
per canonical surface:

| File | Screen | Route |
|---|---|---|
| `command.png` | Command board — full-viewport map, KPI strip, queues, ⌘K bar | command app `/` |
| `portal.png` | Client portal — scoped map, name hero, quote→book, ruled docs | portal app `/?screen=portal` |
| `status.png` | Public status — one shipment, city-generalized position | portal app `/?screen=status` |
| `driver.png` | Driver gate — `--ink-dark` ground, gated-stop question, teal progress | driver app `/` |
| `evidence-email.png` | Evidence email — greige "DELIVERED", POD photos, red rules | portal app `/?screen=email` |

## How the refs get here

**THE FIVE REFS ARE COMMITTED (since `7b45707`, 2026-07-25 — corrected 2026-08-13, audit §1398).** The text
below said *"the refs are not committed yet"* and stayed after they landed; this README was last touched
2026-08-05, ten days later. **Do not run `--update-snapshots` to "create" them.** That command re-blesses all
five against whatever the UI renders today, which silently replaces the reference the gate diffs against — a
visual gate can be neutered while still reporting `5 passed`.

Regenerate a ref only when a screen has DELIBERATELY changed, one file at a time, and say so in the audit.

~~Blessed PNGs are generated on the first run of a browser-capable machine — this sandbox has no Playwright
browser (and no network to the map/font CDNs), so the refs are not committed yet.~~ On a machine with a browser
the generating command is:

```sh
pnpm exec playwright install chromium   # once
pnpm exec playwright test -c playwright.config.ts --update-snapshots
```

That writes `command.png` … `evidence-email.png` into this directory. Commit
them, and every later `pnpm test:visual` diffs against them.

## Advisory (REQ-158)

**CORRECTED 2026-08-13 (audit §1398): NOT advisory any more.** CLAUDE.md rule 7 records the design CI as
**BLOCKING as of WP-10 exit** (verified 2026-08-05, audit §258), and `visual` runs in the merge roster under
`--mode merge`. The paragraph below describes the pre-WP-10 world and is kept struck rather than deleted
because its *mechanism* still holds — a missing browser is still a clean SKIP, which is why the gate is
mode-aware rather than unconditional.

~~The diff is report-only until WP-10 exits.~~ `pnpm test:visual` runs the guard
(`tools/harness/playwright-guard.ts`): a missing browser ⇒ clean SKIP (exit 0); a
real drift ⇒ a printed report + a diff written to `test-results/`, still exit 0.
Only `pnpm test:visual --strict` turns drift into a non-zero exit. `pnpm verify`
never depends on any of this.
