---
description: What to do next on the SHUDDL demand program — top 3 owner-lane items and top 3 unblocked loop tasks with their blocked-on notes.
allowed-tools: Read, Bash(git rev-parse:*)
argument-hint: (no arguments)
---

# /mc:next — the next six things

Read the board and pick what moves next. **This command is read-only. Do not
edit any file.**

## Step 1 — read the board

Read `docs/gtm/00-mission-control.md` (relative to the repo root; if that fails,
resolve the root with `git rev-parse --show-toplevel` and retry).

## Step 2 — the two lanes

Two sections carry the work, and they are answered by different actors:

- `## 🔴 Owner lane (highest-leverage first)` — an ordered list. **A human does
  these.** The list is already sorted by leverage, so "top 3" means items 1, 2, 3
  in file order. Never re-rank them.
- `## Workstream board` — table `ID | Item | State | Blocked on`. **The loop does
  these.**

## Step 3 — select the top 3 unblocked loop tasks

From `## Workstream board`, a row is a **candidate** when all of these hold:

1. Its `State` marker is `⚪` (QUEUED), `🟡` (BLOCKED), `⏸` (HELD), or `🟢`
   (LIVE — drafted but not finished). Rows marked `✅` are done; skip them.
2. Its `State` marker is **not** `🔴` — those are owner actions, and they belong
   to the owner lane, not the loop lane.

A candidate is **unblocked** when its `Blocked on` cell is either `—` (em dash,
meaning nothing) or names only prerequisites that are already satisfied — a
prerequisite is satisfied when it is written with a `✅` (e.g. `F-1 ✅`) or its
own row on the board carries a `✅` marker. A cell naming an unfinished ID, an
owner action, an external step, or "needs …" is **blocked**.

Rank the unblocked candidates:
1. `🟢` LIVE first — a real artifact exists and one step finishes it.
2. Then `⚪` QUEUED, in board order.
3. Ties break by board order (top of the table first).

Take the top 3. If fewer than 3 are unblocked, return the ones that are and say
so plainly — do not pad the list with blocked work.

## Step 4 — render

Output exactly two blocks, no preamble.

### 🔴 Owner lane — top 3
Numbered 1–3, full text of each item verbatim from the file. If an item states a
time cost or a dependency ("blocks …", "critical path"), keep it.

### Loop lane — top 3 unblocked
For each, one entry:

```
<ID> · <Item>
  State:      <the State cell, verbatim>
  Blocked on: <the Blocked on cell, verbatim>
  Why now:    <one sentence — what the next concrete action is>
```

The `Blocked on` line is required even when the cell is `—`; print `—` then.
It is the reader's proof that the pick was checked, not guessed.

Then a closing line naming the single highest-leverage move across both lanes,
and whether it is the owner's or the loop's.

## Rules
- Never promote a `🔴 OWNER` row into the loop lane.
- Never mark anything done here; that is `/mc:done`.
- Report only what the file says. No edits, no git operations.
