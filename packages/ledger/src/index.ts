// REQ-024: this package holds ledger truth. LLM imports are lint-banned here.
// Event append, hash chain, lenses, money-lines land at WP-02 (REQ-002, REQ-011).
export const LEDGER_PACKAGE = "@shuddl/ledger" as const;
