# shuddl-mission-control

A Claude Code plugin that reads and steers the SHUDDL Pre-GTM Demand Program
board. The board is one file — `docs/gtm/00-mission-control.md` — and this
plugin is the command line for it. No database, no daemon, no build step.

Workstream **M-3** of the Pre-GTM Demand Program. Authority: REQ-289.

## Commands

| Command | Does |
|---|---|
| `/mc:status` | Renders the NSM tracker, a count of workstream items by state, the full owner lane, and the last 2 heartbeat rows. Read-only. |
| `/mc:next` | Returns the top 3 owner-lane items and the top 3 unblocked loop tasks, each with its verbatim `Blocked on` note. Read-only. |
| `/mc:done <item-id> [note]` | Marks that workstream row `✅ DONE` and appends a heartbeat row. The only file it may edit is the board. |

Fully-qualified forms (`/shuddl-mission-control:mc:status`, …) also work if a
short name ever collides.

## The board schema these commands target

`docs/gtm/00-mission-control.md`, sections verbatim:

- `## NSM tracker` — table `Metric | Now | Day-30 target | Day-90 target`
- `## Blast-radius contract (how two Claude sessions share one machine)` — bullets
- `## Workstream board` — table `ID | Item | State | Blocked on`
- `## 🔴 Owner lane (highest-leverage first)` — ordered list, leverage-sorted
- `## Heartbeat log` — table `Tick | When | Session | Did`
- `## Kaizen log` — ordered list

`State` cells lead with a marker: `✅` done · `🟢` live/draft · `🟡` blocked ·
`🔴` owner action · `⚪` queued · `⏸` held. The prose after the marker varies per
row, so the commands bucket on the marker, never on the words.

## Install (local dev)

```
/plugin marketplace add /Users/spencerpro/Desktop/shuddl-os/.claude/plugins/shuddl-mission-control
/plugin install shuddl-mission-control@shuddl-mission-control-dev
```

Restart Claude Code, then run `/mc:status`.

## Blast radius

`/mc:done` writes to `docs/gtm/00-mission-control.md` and nothing else. No
command in this plugin runs git, touches product paths (`packages/`, `workers/`,
`apps/`, `db/`, `tools/`), or reaches the network. Files are left in the working
tree; the owner commits.

## Layout

```
shuddl-mission-control/
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── commands/
│   ├── mc:status.md
│   ├── mc:next.md
│   └── mc:done.md
└── README.md
```
