---
description: Render the SHUDDL Pre-GTM Demand Program board — NSM tracker, item counts by state, the full owner lane, and the last 2 heartbeat rows.
allowed-tools: Read, Bash(git rev-parse:*)
argument-hint: (no arguments)
---

# /mc:status — read the mission-control board

Read the board and report it. **This command is read-only. Do not edit any file.**

## Step 1 — read the board

Read `docs/gtm/00-mission-control.md` (path is relative to the repo root; if the
relative path fails, resolve the root with `git rev-parse --show-toplevel` and
retry). Read the whole file — it is small (~70 lines).

If the file does not exist, say exactly that and stop. Do not invent a board.

## Step 2 — parse these sections (they exist verbatim in the file)

| Heading in the file | Shape |
|---|---|
| `## NSM tracker` | table: `Metric \| Now \| Day-30 target \| Day-90 target` |
| `## Workstream board` | table: `ID \| Item \| State \| Blocked on` |
| `## 🔴 Owner lane (highest-leverage first)` | ordered list, highest-leverage first |
| `## Heartbeat log` | table: `Tick \| When \| Session \| Did` |

Two more sections exist and `/mc:status` does not render them:
`## Blast-radius contract (how two Claude sessions share one machine)`
and `## Kaizen log`.

**State vocabulary** — the `State` cell begins with a status marker, then free
text that varies per row. Bucket rows by the leading marker, not by the prose:

| Marker | Bucket | Meaning |
|---|---|---|
| `✅` | DONE | shipped / exists / running |
| `🟢` | LIVE | drafted, spec'd, or published — real artifact exists, not final |
| `🟡` | BLOCKED | blocked on an external/upstream step |
| `🔴` | OWNER | needs a human owner action; not loop-executable |
| `⚪` | QUEUED | not started, scheduled for a future tick |
| `⏸` | HELD | deliberately paused behind a gate |

If a row carries a marker not in this table, count it under `OTHER` and name the
row — never silently drop it.

## Step 3 — render

Output exactly these four blocks, in this order, in plain markdown. No preamble.

### 1. NSM tracker

Reproduce the `## NSM tracker` table as-is (all rows, all four columns). If a
`Now` cell contains `BLOCKED`, keep the blocked text verbatim — it is the signal.

### 2. Items by state

One line per bucket, `MARKER BUCKET — n: ID, ID, ID`, ordered
DONE → LIVE → BLOCKED → OWNER → QUEUED → HELD. Finish with `Total: n items`.
The total must equal the number of data rows in `## Workstream board`.

### 3. Owner lane

Reproduce **every** numbered item from the owner-lane section — its heading is
`## 🔴 Owner lane (highest-leverage first)` — in file order, full text. Do not
truncate, summarize, or reorder; it is the only thing the owner is asked to act
on.

### 4. Last 2 heartbeats

The last two data rows of `## Heartbeat log` (highest tick numbers), oldest of
the two first. Show `Tick`, `When`, `Session`, and the full `Did` text.
If the log has fewer than two rows, show what is there and say how many exist.

## Rules

- Report only what the file says. Never infer progress the board does not claim.
- Quote blocked/owner text verbatim; do not soften it.
- No edits, no git operations, no network calls.
