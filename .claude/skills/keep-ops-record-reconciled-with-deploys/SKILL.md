---
name: keep-ops-record-reconciled-with-deploys
description: Use immediately after any world-changing operator action (provisioning, deploy, secret binding, backup, DNS/routing change) and when reviewing ANY tracked markdown for currency — docs/ops/*, but also README.md and any root-level file, which is where the most-read and least-swept claims live (audit §173). Symptoms — a "read first" section asserting a state the evidence record contradicts, a hold row still BLOCKED while a reconciliation table in the same file says PROVISIONED, "not deployed / nothing is deployed / nothing is live / not provisioned / no backup exists / prod pending" older than the latest deploy commit, wrangler comments calling real ids placeholders.
---

> **Grounding note (added 2026-08-07, audit §639):** this skill's examples describe observations FROZEN
> as-of its writing. Unlike its siblings it cites no `path:line`, so nothing mechanical can tell you when
> its claims go stale — which makes this warning MORE load-bearing here, not less. The LAW it states is
> current; the examples are provenance, not proof. Verify against HEAD before treating any described
> defect as live.

# Keep The Ops Record Reconciled With Deploys

## Overview
The ops record must never assert a state the evidence record contradicts. Every world-changing
action (provision, deploy, bind, backup) gets a SAME-SESSION supersession sweep across every
document that asserted the old world — because ops docs restate one fact in many places, and the
places you didn't edit become the record for whoever lands there first. Drift in the
UNDER-WARNING direction is the dangerous kind: a reader told nothing is live treats prod-targeting
actions (seed, replay, redeploy, secret rotation) as inert while the environment is answering.

## When to Use
- You just provisioned, deployed, bound a secret, took a backup, or changed routing — sweep now.
- Reviewing any `docs/ops/*` claim about environments; at every WP exit / close-out.
- Editing a wrangler.toml id whose comment describes it ("placeholder", "does not exist").
- NOT a license to delete history: supersede IN PLACE (~~strikethrough~~ + dated note), never rewrite.

## The RED this closes (five confirmed Highs, 2026-08-01 audit D1-D5)
Prod was provisioned 2026-07-30, five workers + three surfaces deployed, preflight **PASS 72
checks** recorded in `RELEASE-EVIDENCE.md` on 2026-07-31 — while at HEAD the next day:
- `PROJECT-STATE.md` "Safety posture (**read first**)": "There is no live production… Prod is not
  provisioned" — contradicted by the RESOLVED banner DIRECTLY ABOVE it and by §6 of the same file.
- Its five-states table and all of §4: "not provisioned, not deployable, every id all-zero,
  BLOCKED 26."
- `DEPLOYMENT.md` header: "prod = not stood up"; "evidence sending OFF" against its own Sending
  section saying LIVE.
- `LAUNCH-RUNBOOK.md`: "There is no tools/deploy/backup.ts … no way to back up production today" —
  the file existed and a prod backup had run.
- `GO-LIVE-CHECKLIST.md` hold row: BLOCKED/"all-zero placeholder" seventeen lines above its own
  reconciliation table reading "PROVISIONED + DEPLOYED 2026-07-30/31".
- Wrangler comments instructing maintainers to PRESERVE the falsehood: "placeholder id is
  intentional… the gate must keep saying so" above real provisioned ids.
The mechanism: the deploying session updated the evidence record and one table, then stopped. Every
other restatement stood.

## The sweep (do all of it, same session)
1. `git grep -il 'not provisioned\|not deployed\|nothing is deployed\|nothing is live\|not stood up\|no backup\|placeholder' -- '*.md' 'workers/*/wrangler.toml'`
   — then judge each hit against the action just taken.

   > **Widened 2026-08-04 (audit §173) after this sweep missed a real instance.** It previously scanned
   > `docs/ops` and the wrangler files only, matching `not deployed`. `README.md` — the repo's most-read
   > file — carried *"Nothing is deployed, armed, or sending"* for five days after production was
   > provisioned, and the sweep could not see it on EITHER axis: wrong directory (the README is at the
   > root, not under `docs/ops`) and wrong phrasing (`Nothing is deployed` does not contain
   > `not deployed`). Both are now covered. The general lesson, which cost audit §172 to learn: **scope a
   > record sweep by DOCUMENT CLASS (all tracked `*.md`), never by directory — the highest-read file in a
   > repo is usually at the root, and every directory-scoped sweep misses it.**
2. Supersede in place: `~~old claim~~ **superseded <date>:** <new fact> (<evidence pointer>)`. Keep
   what REMAINS true and restate it as the real hold (email dark, no tenant, credentials unbound).
3. Hold-row hygiene: flip Status with the proof COMMAND + verdict; adjust Blocks-grade; never delete.
4. Comments above config values are part of the record — a comment that says "placeholder" above a
   real id instructs the next maintainer to break prod.
5. Prove the sweep: REQ-id set-diff on ledger files must be empty; citation/traceability/coverage
   gates green.

## Red flags
- "§N below supersedes anything above" doing the work a strikethrough should — a reader of the top
  never learns.
- A doc datelined today carrying yesterday's world.
- Updating the evidence record without sweeping the narrative docs that cite the old state.
- "It's just a comment in the toml."
