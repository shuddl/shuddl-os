// @shuddl/agents — the 13 agents' PURE, DETERMINISTIC cores. WP-06 Task 2 ships the Biller's
// composition (composeInvoice). LLM calls are permitted ONLY in this package family (REQ-024) —
// but the Biller composition itself is deterministic and LLM-free, and this package must NEVER
// depend on @shuddl/ledger (agents read records and compose payloads; the ledger writes truth).
export { composeInvoice } from "./biller/compose.js";
export type { ComposeInput, ComposeResult } from "./biller/compose.js";
export { glMap, GL_MAP } from "./biller/gl-map.js";
export type { BillableLineKind } from "./biller/gl-map.js";
export { EvidenceEmailView, formatCents } from "./biller/evidence-email-view.js";
export type { EvidenceEmailData } from "./biller/evidence-email-view.js";
export { renderEvidenceEmail } from "./biller/evidence-email.js";
