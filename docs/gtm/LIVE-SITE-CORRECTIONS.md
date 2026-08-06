# Live-site corrections — ready to apply, NOT applied
**Status: AWAITING OWNER APPROVAL.** Nothing in `marketing-site/` has been edited and nothing has been deployed. Outward-facing copy is the owner's voice, and the deploy sits in the marketing Cloudflare account behind the account split.
**Target:** `marketing-site/public/index.html` (+ `main.js`, `demo.js` for two strings) · **Verified against the live file 2026-08-02** · **Authority:** [A1-messaging.md](A1-messaging.md) claims law · [C3](C3-founding-carrier-program.md) offer · [F1](F1-icp.md) ICP · [A4-landing-page-v2.md](A4-landing-page-v2.md) §0

> **How to use this:** each row below is an exact find/replace against the current file. Apply, review in a local preview, then deploy from the marketing account. Or hand it to me with a word of approval and I'll prepare the edited file for your review — I still won't deploy it.

---

## C1 — The false customer claim (do this one first, alone if you like)

**Line 147**, inside the comparison row "Driver gets a signature":

- **FIND:** `POD rides the cab for days; invoice next week — or never (a real carrier found ~$402K unbilled)`
- **REPLACE:** `POD rides the cab for days; invoice next week — or never`

**Why:** there are zero tenants and zero carriers ([research doc 01 §1](../research/2026-08-01-coordination-layer/01-system-readiness.md)). The parenthetical states a customer outcome that does not exist. Deleting it costs nothing — the sentence before it is the actual argument, and it stands on its own.

## C2 — Unlabeled staging timing

**Line 147** (same row), and the same `&lt;5 s` / "5 seconds" string at **lines 7, 86, 91, 129, 148** and in `public/demo.js:2`:

- **FIND:** `Invoice + signed photo in the client's inbox in &lt;5 s`
- **REPLACE:** `Invoice + signed photo in the client's inbox the moment it's signed`

**Why:** the sub-5-second figure is staging-measured, not a production fact ([doc 01 §5](../research/2026-08-01-coordination-layer/01-system-readiness.md)). "The moment it's signed" is the honest and frankly stronger claim — it describes the mechanism rather than a stopwatch we can't yet defend in production. If you'd rather keep a number anywhere, it must read "measured on staging" on the same line.

## C3 — The offer contradicts the approved program

**Lines 31, 203** (section label, appears twice) · **204** (headline) · **205** (body) · and `public/main.js:231`:

| Find | Replace |
|---|---|
| `Founding 50` | `Founding Carriers` |
| `First 50 carriers: 80% off months 3–6.` | `Eight founding carriers. Founding price locked for 24 months.` |
| `Locked at signup. Your first two months are on us while the overlay proves parity against your TMS.` | `Locked at signup. We run in parallel with your current system and prove parity before anything switches over.` |

**Why:** [C-3](C3-founding-carrier-program.md) is 8 slots with a $2,500 refundable deposit and a 24-month price lock — not 50 carriers at 80% off. Two incompatible offers in market is worse than either one alone: the first founding carrier who saw the old page will reasonably expect its terms.

## C4 — Manufactured scarcity

**Line 206** — the `data-founding` counter fed by `/api/founding-count`:

- **ACTION:** remove the counter element from the page, and stop rendering the endpoint's value.

**Why:** the endpoint counts **waitlist signups** and presents them as founding-slot consumption. That is a fabricated scarcity signal — the kind of thing that reads as ordinary growth-hacking right up until someone checks. Real scarcity here is genuine (8 slots, each a 14–20-week hands-on onboarding); it doesn't need help. If you want a counter later, it reads **cleared deposits**, or it doesn't exist.

## C5 — "Design partner" contradicts anonymity-by-default

**Line 216:**

- **FIND:** `Apply as a design partner →`
- **REPLACE:** `Apply to be a Founding Carrier →`

**Why:** "design partner" carries an implied case-study/logo expectation. [C-3](C3-founding-carrier-program.md) promises the opposite — anonymity by default, no name or logo without separate written consent. That promise is a genuine differentiator with fraud-wary operators; don't undercut it in the CTA.

## C6 — ICP band mismatch

**Line 89:**

- **FIND:** `For US LTL &amp; final-mile carriers, 10–150 trucks`
- **REPLACE:** `For US regional carriers and carrier-brokerage hybrids, 10–100 trucks`

**Why:** [F-1](F1-icp.md) is 10–100 power units, and the primary ICP is the regional asset carrier with a brokerage arm — not final-mile. The old line invites exactly the leads we'd disqualify on the call, which wastes their time and ours.

## C7 — Unbacked quote-speed claim

Wherever `under 15 seconds` appears in the comparison table:

- **ACTION:** remove that row, or replace the claim with `A price you can book, from an emailed request`.

**Why:** the quote path exists in the API but has **no signup UI**, and public signup is counsel-blocked ([doc 01 §5, demo 2](../research/2026-08-01-coordination-layer/01-system-readiness.md)). A visitor cannot experience this today at any speed.

---

## What stays exactly as it is

The mechanism claims are all backed and should not be softened: POD → invoice + evidence email, server-side gates, the offline/airplane-mode driver flow, append-only hash-chained records, GL export, the migrator. Each traces to [doc 01 §4–§5](../research/2026-08-01-coordination-layer/01-system-readiness.md). **The site's problem is not that it over-describes the product — it's that it claims a customer, a timing, and an offer it doesn't have.**

## Verification after applying

```
grep -nE "402|Founding 50|80% off|design partner|10.150|15 seconds|founding-count" marketing-site/public/index.html marketing-site/public/*.js
```
Expect **zero matches**. That command is also worth adding to the marketing repo's CI as a standing claims lint, so a retired claim cannot quietly return — the same mechanism [A-4](A4-landing-page-v2.md) specifies for the deposit gate.
