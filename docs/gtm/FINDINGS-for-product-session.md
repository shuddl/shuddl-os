# Findings for the product session — from the demand-program lane
**Raised:** 2026-08-02 (tick 7) · **Raised by:** the Pre-GTM Demand Program loop (REQ-289), while planning demo films read-only
**Handling:** these are **product-code issues in the coding session's territory**. The demand lane did NOT and will NOT touch them — this file is the handoff. Triage, dismiss, or fix as you see fit; nothing here is a request with authority behind it.

---

## 1. A seed-loaded tenant renders an empty board/map — VERIFIED
**Severity:** high for demos and plausibly for tenant onboarding.

`GET /v1/board` inner-joins positions:

```
FROM shipments s
JOIN positions p ON p.shipment_id = s.id AND p.ts = (SELECT MAX(...))
```
— [workers/api/src/routes/board.ts:107-110](../../workers/api/src/routes/board.ts#L107-L110)

The seed loader inserts `parties`, `shipments`, and `events` — **no `positions` rows** ([tools/seed/load.ts:51-60](../../tools/seed/load.ts#L51-L60)); the staging smoke doesn't write them either. Any shipment without a position row is silently dropped from the board, so a freshly seeded tenant shows an empty map even though the data loaded correctly.

**Why it matters beyond filming:** the first thing a new tenant (or a demo audience, or you) sees after seeding is a blank map that looks like a broken product. It fails silently — no error, just absence, which is the hardest class of bug to notice.

**Options (yours to choose):** have the seed emit a position per shipment; or make the board `LEFT JOIN` and render position-less shipments in a defined way; or document it as expected and have the seed print a warning.

## 2. The Command board never polls — VERIFIED
An exception raised while the board is open does not appear until a manual reload ([apps/command/src/App.tsx:54-79](../../apps/command/src/App.tsx#L54-L79)). The portal *does* poll on a 20-second interval ([apps/portal/src/api/board.ts:31](../../apps/portal/src/api/board.ts#L31)), so the two surfaces behave differently.

Not necessarily wrong — a deliberate choice is fine — but the acceptance demo "the exception pulse dimming the map while everything else stays quiet" reads as a *live* moment, and today it isn't one on Command. The demand lane's film plan handles this honestly by filming the reload rather than faking a push.

## 3. Two hardcoded strings put real-world facts on screen — VERIFIED
- The driver day sheet renders a fixed header string containing a specific date and place name ([apps/driver/src/App.tsx](../../apps/driver/src/App.tsx) / `DaySheet.tsx:22`).
- The stop "address" line renders the device's actual latitude/longitude ([apps/driver/src/App.tsx:41-47](../../apps/driver/src/App.tsx#L41-L47)).

Consequence for us: anything filmed or screenshotted leaks a real location unless framed around it. Consequence for you: possibly just placeholder debt, but the lat/lon-as-address may be a UX gap worth a real address lookup or a neutral label.

## 4. Context you may want anyway
While auditing deployability the demand lane's research (2026-08-01) recorded two items that are **not in any ops doc**: the map `perf` gate fails on CI hardware while passing locally on the same commit, and the nightly backup job is staging-scoped with unbound credentials, so **production is never backed up on a schedule**. Full detail with citations: [docs/research/2026-08-01-coordination-layer/raw/readiness-audit.md](../research/2026-08-01-coordination-layer/raw/readiness-audit.md) §2.

---

**Contract reminder:** the demand lane owns `docs/gtm/**`, `docs/plans/2026-08-02-*`, `docs/research/`, `.claude/plugins/`, and the claimed register row REQ-289. It does not edit `packages/`, `workers/`, `apps/`, `db/`, `tools/`, `fixtures/`, `tests/`, or CI. Next free register row for the product session: **REQ-290**.
