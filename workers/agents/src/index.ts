// REQ-039: queue consumers (one module per agent) land WP-06+. LLM calls live
// here and in packages/agents — never in the ledger (REQ-024).
export default {
  async queue(): Promise<void> {
    /* agents arrive WP-06+ */
  },
};
