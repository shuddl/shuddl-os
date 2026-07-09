# SHUDDL — Gap Audit · Assurance System · Build Roadmap with DoD
## Genesis doc 08 · 2026-07-09 · the honest audit of docs 00–07, the machine that catches misses, and the exact work packages Claude Code will execute

---

## (01) GAP AUDIT — what the set was missing (each gap now has a home)

Audited: docs 00–07, the TP replacement brief, RepDesk v1.1, PricingOS pack, import packs, parity register, this conversation's full requirement language.

| # | Gap found | Severity | Disposition |
|---|---|---|---|
| GA-1 | No design system | Blocker for build | **CLOSED — doc 07** (incl. map spec, contrast amendment, CI squint test) |
| GA-2 | No requirement traceability — vision prose ≠ buildable register; misses were unmeasurable | Blocker | **CLOSED — doc 09** (machine-readable REQ register, 149 rows) + §02 assurance system |
| GA-3 | Event taxonomy + concrete data model never enumerated (≤22 tables was a budget, not a schema) | Blocker | **CLOSED — doc 10** (35 event kinds, 21 tables with fields) |
| GA-4 | No repo governance file for the builder (budgets, laws, gates, commands, do-nots) | Blocker | **CLOSED — doc 11** (drop-in CLAUDE.md) |
| GA-5 | Position/telemetry source unspecified (where do map dots come from?) | High | Spec'd: driver-PWA GPS 30s cadence + gate stamps v1; ELD/telematics adapters v1.5 (REQ-071/072) |
| GA-6 | Consignee contact capture never gated — heartbeat email would silently fail | High | New gate rule: booking requires consignee email/SMS or named opt-out (REQ-047) |
| GA-7 | Map tile sourcing/licensing (no third-party branding, offline) | High | Self-hosted vectors (Protomaps/OpenFreeMap on R2), style per doc 07 (REQ-075) |
| GA-8 | Metering/billing infra for Spark/credits unnamed | High | Stripe Billing + usage records; credits ledger = Money events on the platform tenant (REQ-121…124) |
| GA-9 | Email deliverability (per-shipment addresses, DKIM/SPF/DMARC, bounce handling) unspecified | High | WP-06 scope + REQ-091…094; tenant subdomains on our sending domain v1 |
| GA-10 | Security/threat model + tenant-isolation proof absent | High | WP-01 DoD: isolation test suite (cross-tenant read = CI failure); threat model doc in repo (REQ-131…136) |
| GA-11 | Legal/compliance register scattered ([CONFIRM]s existed but unowned): recording consent, broker authority/insurance for Direct, ToS/privacy, photo retention, DOT/FMCSA touchpoints | High | Consolidated REQ-137…144, each with owner=counsel and a blocking flag on the features they gate (Direct v1.5 blocked until cleared) |
| GA-12 | Test-fixture manifest never centralized (which goldens exist, where) | Med | §02.4 fixture registry: 062226 export (9,314 bills) · 4,405-bill re-rate fixture · 3,100 synthetic blitz · 504-quote monotonic sweep · RepDesk 48-test suite · import-pack CSVs · CLI corpus checklists |
| GA-13 | Agent cost/observability (per-agent $ and latency budgets) unspecified | Med | events carry `agent_cost`; Watchtower budget alarms (REQ-113) |
| GA-14 | Offline CRDT merge — design stated, test plan absent | Med | WP-05 DoD includes airplane-mode soak: 50 events captured offline across 2 devices merge with zero loss/dupes |
| GA-15 | Appointment/dock-capacity model (Scheduler needs an object to schedule against) | Med | `facility_hours` config + capacity slots in doc 10 (REQ-052) |
| GA-16 | Photo/evidence storage lifecycle + cost ceiling | Med | R2 lifecycle per document kind (7yr POD default); cost line in Watchtower (REQ-116) |
| GA-17 | Abuse/rate-limiting on $5 tier (LLM cost attack surface) | Med | Credit caps hard-stop conveniences, never gates/truth; per-IP/workspace velocity limits (REQ-125) |
| GA-18 | Naming/trademark still open | Med | Standing [CONFIRM-1]; folder stays SHUDDL until cleared |
| GA-19 | DR/backup/export mechanics (L10 promised, not spec'd) | Med | Nightly ledger snapshots + one-click export job spec (REQ-135) |
| GA-20 | Support model undefined | Low | Copilot-first + founder escalation v1; formal SLA at Scale tier only (REQ-126) |
Also caught by audit: doc-04 pricing numbers marked hypotheses (kept, labeled); driver-pay explicitly deferred (kept out, stated); GL never native (restated in doc 11's do-nots).

---

## (02) THE ASSURANCE SYSTEM — "how nothing gets missed," stated honestly

**No large system gets a literal guarantee — anyone selling one is lying. What we build instead is a closed loop where every miss is *detectable, attributable, and convergent to zero*.** Five interlocking mechanisms:

1. **One register to rule scope (doc 09).** Every requirement has an ID, source quote, spec home, work package, and DoD test. New scope enters ONLY as a new REQ row (append-only, like the ledger). If it isn't in the register, it isn't in the product; if it is, it cannot be silently dropped — CI (§2) makes orphans loud.
2. **Traceability CI.** Every PR must reference REQ-IDs; every REQ in an active WP must map to ≥1 test; a nightly job diffs register ↔ tests ↔ code annotations and files "ORPHAN" issues automatically, in both directions (spec'd, unbuilt / built, unspec'd). Coverage is a dashboard number the owner reads weekly.
3. **Adversarial audit swarms, institutionalized.** The 50-agent audit pattern (which found 42 real defects in a module we believed finished) runs at every WP exit: independent agents attack the module against its REQ rows, the Laws (doc 00), and the fixtures — findings become REQ rows or defects, never Slack messages. A WP cannot close with an open Critical.
4. **External ground truth.** The 171-column legacy export is the final parity exam (any unmapped column = a new gap row, not a silent drop); the 15-module CLI corpus is the functional checklist; the fixture registry (§01 GA-12) gates every engine change (aggregate ±2%, routes ±10%, monotonicity, the $222K anomaly regression forever).
5. **The gates themselves.** Because the product refuses to advance without evidence (L7), operational misses surface as blocked transitions in front of a human — the architecture is its own last-line auditor. Watchtower alarms on the metagaps (unbilled ≠ 0, FSC stale, budget drift).
Weekly ritual (30 min, owner: Spencer): register delta review → coverage % → open Criticals → new [CONFIRM]s. That cadence, plus the five mechanisms, is the strongest honest version of "guaranteed."

---

## (03) ROADMAP — work packages with DoD (Claude Code executes; humans own gates)

**F0 is complete as of this delivery** (docs 00–11: vision, spec, ledger, MCP, model, v1 plan, verdict, design, audit, register, taxonomy, repo governance). Remaining foundation before code: **F1 — Spencer: [CONFIRM-1] name/trademark pass · [CONFIRM-2] counsel review list (§01 GA-11) · [CONFIRM-3] pick tenant-#0 pilot terminal · create empty GitHub repo + Cloudflare account handles.** Everything below assumes F1 done; order is dependency-true; ~12 weeks to v1-complete per doc 05 §5.

| WP | Weeks | Deliverable & exact direction | Definition of Done |
|---|---|---|---|
| **WP-01 Repo + CI + assurance loop** | 1 | Monorepo scaffold (workers/, app/, driver/, portal/, packages/ledger, packages/rater, packages/design); doc 11 installed as CLAUDE.md; traceability CI (§02.2), squint-test CI (doc 07 §06), tenant-isolation test harness | CI green on empty app; a dummy PR without REQ-ID fails; cross-tenant read attempt fails the suite |
| **WP-02 Ledger core** | 1–3 | Tables per doc 10; event append API w/ hash chain + device signing; lenses (role-scoped queries); money-lines; authority map flags; TSA timestamp batching | 35 event kinds round-trip; chain verifies after 10K events; correction semantics net to zero in GL export fixture; lens tests prove scoping |
| **WP-03 Design system pkg + map shell** | 2–4 | Tokens/components per doc 07; MapLibre greige style; entity layer w/ scoped subscriptions; reveal/count-up primitives | 5 canonical screens match blessed refs; squint CI passes; map renders 1K entities at 60fps desktop / 30fps mid-phone |
| **WP-04 Rater service** | 3–4 | Port the audited engine (48 tests + 504-sweep travel with it) behind `/rate`; tenant-config surfaces (zones/tariffs/floors from config, zero hardcodes); floors+approvals per matrix | All existing tests pass in service form; TP config reproduces RepDesk quotes exactly; below-floor emits approval event |
| **WP-05 Driver PWA + Gatekeeper (THE HEARTBEAT)** | 3–5 | Gated stop flow per doc 01 §4; offline event capture (signed, sequenced); forced photos; signature; geofence stamps; POD event | **Real freight demo: signature at door → invoice event + consignee photo email <5s** ; airplane-mode soak (GA-14) passes; zero-instruction driver test (L6) passes with a real driver |
| **WP-06 Biller + email infra** | 4–6 | POD→invoice projection; evidence email (design per doc 07 §03); tenant sending domains, DKIM/bounce handling; statement runs | Invoice math matches Rater to the penny on 500-fixture replay; deliverability >98% on seed list; anomaly rules block the $222K case |
| **WP-07 Concierge (email-in quoting)** | 5–7 | Inbound parse → Rater → auto-reply drafts (auto-send above confidence, queue below); Message resolution to Party+Shipment | 50 real historical quote emails: ≥90% parsed correctly, 100% of sends floor-clean; every message lands on a timeline |
| **WP-08 Scheduler** | 6–7 | Facility hours/capacity model; pickup windows; confirmations + calendar artifacts | Double-book impossible in test; reschedule flows emit events; consignee-contact gate (GA-6) enforced at booking |
| **WP-09 Portal + status pages** | 6–8 | Scoped map home; quote→book panel; docs/invoices; claims w/ custody chain; public status page | Guest quote in <60s stopwatch test; portal shows only lens-scoped data under adversarial user tests |
| **WP-10 Command surface** | 7–9 | Map home + queues + command bar + KPI strip (OR, DSO, unbilled=0 alarm, OTD, dwell, lane P&L) | 10-minute CSR acceptance (L6) passes with a non-freight tester; every KPI clicks through to its ledger events |
| **WP-11 Collector + QuickBooks export + Watchtower** | 8–10 | Aging/dunning drafts; cash-app suggestions; journal export; anomaly/budget/unbilled alarms | Export reconciles a fixture month to the penny in QB sandbox; unbilled alarm fires on seeded $0-revenue bill |
| **WP-12 EDI lite (Translator)** | 9–10 | 214-out + 204-in against replay harness; partner cert flow | R&L-format fixtures round-trip clean; malformed docs quarantine with evidence |
| **WP-13 MCP v1** | 10–11 | quote/book/track/document/approve tools, paired-company OAuth, spend caps | Live booking from Claude on tenant-#0 sandbox; caps enforced server-side under hostile-prompt tests |
| **WP-14 PLG + metering** | 10–12 | Signup→workspace→Migrator drag-drop; Stripe + credits ledger; Spark caps (GA-17) | Stranger completes signup→first quote unassisted <10 min; metering matches event counts exactly |
| **WP-15 Overlay/authority tooling** | 11–12 | Mirror ingest (171-col adapter), shadow dashboards, per-module authority flips + fallback | TP mirror runs 3 days unattended; parity dashboard live; a forced-drift test triggers auto-fallback |
| **WP-16 Audit swarm + launch gate** | 12 | Full adversarial pass on every module; register coverage 100%; pen-test basics | Zero Critical; coverage report 100%; the five doc-00 acceptance tests pass on video |
Post-v1 (sequenced, not forgotten): voice comms · Direct guest checkout + credit line (counsel-gated) · cartage mesh · ELD adapters · anchoring upgrade · route-cycle cost mode — all already in the register as vNEXT rows.

**Proceeding now** per your instruction: F0 artifacts are being placed in this folder (docs 09–11 accompany this one). The build starts the day F1's three [CONFIRM]s land.
