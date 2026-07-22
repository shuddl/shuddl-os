// WP-15 Task 2 (REQ-030 / REQ-008, Ten Laws L8) — the api worker's LOCAL seam sibling of gate-context.ts.
// The seam IMPLEMENTATION is shared in @shuddl/ledger/authority because it is consulted from BOTH this worker
// AND the agents worker (which cannot import @shuddl/api — no dependency edge). This module re-exports it so
// the rate / quote / dunning routes import a LOCAL `../authority.js` next to gate-context.ts, while the single
// implementation stays in ledger (no drift, no parity test needed). See packages/ledger/src/authority.ts for
// the fail-closed contract and the authoritativeSource truth table.
export { resolveAuthority, authoritativeSource } from "@shuddl/ledger/authority";
export type { AuthorityModule, AuthorityLevel } from "@shuddl/ledger/authority";
