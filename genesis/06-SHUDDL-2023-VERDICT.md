# Verdict: the 2023 `shuddl-full-product` codebase
## Genesis doc 06 · 2026-07-09 · inspected this session — evidence, decision, and what survives

## What's in the folder (verified)
Four repos, last commits **Sep–Nov 2023** (git log confirmed): `shuddle-backend` (Laravel 10 / PHP 8.1, Sanctum+JWT, Spatie permissions, Twilio SDK — classic REST monolith), `shuddl-web-app` (Create-React-App, React 18, axios/react-router — CRA scaffold README intact), `shuddl-customer-app` and `shuddl-driver-app` (Flutter, 179 dart files, stock READMEs). Commit timezones (+0530) indicate an offshore build team. It is a competent 2023 two-sided-app MVP: accounts, shipments CRUD, driver/customer mobile shells, Twilio hooks.

## Decision: **retire the code; harvest the brand and the lessons. Do not update or build upon it.**

### Why not (each reason independently sufficient)
1. **Architecture predates the thesis.** It is a request/response CRUD system — private copies, manual entry, no event ledger, no agents, no gates, no evidence capture, no LLM surface anywhere. It is, precisely, "what is familiar today" — the failure condition doc 00 defines. You cannot retrofit L1–L3 onto a CRUD core; the ledger *is* the core.
2. **Stack mismatch with everything since.** Three years of subsequent work (the pricing engine, the overlay tooling, the import machinery, the edge deployment pattern) is Cloudflare-native TypeScript. Reviving Laravel/CRA/Flutter means owning three additional runtimes and a deprecated build tool (CRA is EOL) for zero thesis progress.
3. **Three years of dependency rot** = a security/maintenance mortgage from day one (Laravel 10 aging out, unpatched trees, app-store target-SDK churn on both mobile apps) — cost with no compounding value.
4. **Rebuilding its features is cheaper than reading it.** Its entire functional surface (auth, shipment CRUD, two mobile shells, notifications) is days on the new spine at current build velocity — and comes back gated, evidenced, and agent-native instead of keyed.

### What survives (the harvest)
- **The brand**: Shuddl — the name, domain (shuddl.io), and any entity/app-store standing. This doc set already writes under it (**[CONFIRM]** final naming + a trademark/app-store availability pass before public launch).
- **The thesis validation**: the founder already believed, in 2023, that freight needed a customer app + driver app + central brain. The 2023 build is proof of conviction; 2026 supplies the missing physics (ledger, gates, agents) and the missing distribution (PLG + MCP).
- **Requirements archaeology**: the Flutter screens enumerate a real driver/customer flow worth mining as a checklist (profile, shipment counts, password/phone flows) — an afternoon's read, not a merge.
- **Twilio patterns** as a reference for the comms layer (voice/SMS), reimplemented edge-native.

### Disposition
Mark all four repos archived/read-only with a pointer to this doc set. No code merges. The 2023 build's job is done: it named the company and proved the appetite. The 2026 build gives that name its physics.
