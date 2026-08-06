---
description: Mark a workstream item done on the mission-control board and append a heartbeat note.
allowed-tools: Read, Edit, Bash(date:*), Bash(git rev-parse:*)
argument-hint: <item-id> [what shipped]
---

# /mc:done — close a workstream row

Mark item **`$1`** done on the board and record it in the heartbeat log.

Arguments: `$ARGUMENTS` — the first token is the item ID (e.g. `A-1`, `F-4b`,
`M-3`); everything after it, if present, is the note to record.

## Step 0 — refuse a bad call

If `$1` is empty, say so and stop. Do not guess which row was meant.

## Step 1 — read the board

Read `docs/gtm/00-mission-control.md` (relative to the repo root; if that fails,
resolve the root with `git rev-parse --show-toplevel` and retry). Read the whole
file before editing — you need the exact current text of the row.

## Step 2 — find the row

In `## Workstream board` (table `ID | Item | State | Blocked on`), find the row
whose **`ID` cell matches `$1` exactly** (case-insensitive; `f-4b` matches
`F-4b`). IDs are of the form `<letter>-<number>[letter]`.

- No match → list the IDs that do exist and stop. Do not create a new row.
- More than one match → stop and report the ambiguity.
- Already `✅` → say it is already done, show the row, and skip Step 3. Still
  offer to add the heartbeat note if the user supplied one.

## Step 3 — edit the `State` cell (and only that cell)

Use **Edit** with the full table row as `old_string`, so the match is unique and
nothing else in the file moves. Change only the `State` cell.

New `State` value: `✅ DONE` followed by the shortest true evidence — the same
shape the neighbouring done rows already use:

- `✅ DONE — [F1-icp.md](F1-icp.md), owner-approved`
- `✅ DONE — REQ-289 appended, owner-signed`
- `✅ DONE (this file)`

If the note in `$ARGUMENTS` names an artifact (a file in `docs/gtm/`, a URL, a
REQ id), put it in the cell as a relative markdown link or bare id. If it names
nothing, write `✅ DONE` plus a five-word-or-less summary. Never write evidence
you did not verify exists.

Then fix the `Blocked on` cell for that row: if it named a prerequisite that is
now moot, set it to `—`. Leave it alone otherwise.

**Do not** touch any other row, any other section, or the file's link header.

## Step 4 — append a heartbeat note

In `## Heartbeat log` (table `Tick | When | Session | Did`):

- Read the last row's `Tick` number. If a row for the **current tick** already
  exists (same tick this session has been writing), append a sentence to its
  `Did` cell rather than opening a new tick.
- Otherwise append a **new row** at the bottom of the table:
  - `Tick` — last tick + 1
  - `When` — today's date as `YYYY-MM-DD` (get it from `date +%F`)
  - `Session` — `demand-loop` unless the caller says otherwise
  - `Did` — one sentence: what closed and the evidence, e.g.
    `A-3 ROI calculator shipped (marketing-site) → A-3 ✅.`

Append only. Never rewrite or renumber an existing heartbeat row.

## Step 5 — report

Show the before/after of the `State` cell and the heartbeat row you wrote. Then
name what that unblocks: scan `## Workstream board` for rows whose `Blocked on`
cell references `$1`, and list them — they may now be candidates for `/mc:next`.

## Rules — blast radius
- **The only file you may edit is `docs/gtm/00-mission-control.md`.** Nothing in
  `packages/`, `workers/`, `apps/`, `db/`, `tools/`, `genesis/`, or the other
  `docs/gtm/*.md` files.
- **Never run git.** No `add`, no `commit`, no `push`. This program leaves files
  in the working tree; the owner commits.
- Never mark a `🔴 OWNER` row done on the owner's behalf without the caller
  saying the owner did it — and record who, in the heartbeat `Did` cell.
- If the board changed under you between Step 1 and Step 3 (the Edit fails to
  match), re-read the file and retry once. Do not force a fuzzy match.
