// REQ-024: this package holds ledger truth. LLM imports are lint-banned here.
// Event append, hash chain, lenses, money-lines land at WP-02 (REQ-002, REQ-011).
export const LEDGER_PACKAGE = "@shuddl/ledger" as const;

// Task 6 (REQ-042/183) — the shared credit projection-gap reconciler. Re-exported here so both consumers (the
// api sequencer DO's booking gate and the agents credit-recon cron) resolve the ONE implementation.
export { reconcileCreditForParty, type CreditReconResult } from "./reconcile/credit.js";
