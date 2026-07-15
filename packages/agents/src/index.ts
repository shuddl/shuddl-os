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
export {
  EvidenceMessageSchema,
  SendError,
  RecordingSender,
  NotConfiguredSender,
  ResendSender,
  wrapFragment,
} from "./biller/sender.js";
export type { EvidenceMessage, SendReceipt, EvidenceSender, ResendConfig } from "./biller/sender.js";
// WP-07 Concierge — the parse port (REQ-024/026/098): freeform inbound email → a structured ParseResult.
// The FIRST LLM usage in the codebase, config-gated exactly like the sender (Deterministic/NotConfigured/Claude).
export {
  ParseResultSchema,
  ParseError,
  DeterministicParser,
  NotConfiguredParser,
  ClaudeParser,
  CONCIERGE_SYSTEM_PROMPT,
  buildUserPrompt,
} from "./concierge/parse.js";
export type { ParseResult, InboundEmail, ConciergeParser, ClaudeParserConfig } from "./concierge/parse.js";
// WP-07 Concierge — the RESOLVE step (REQ-093): a parsed inbound is tied to a Party + Shipment on
// verifiable STRUCTURAL signals (never the model's confidence); <0.9 computed confidence queues.
export { resolveConcierge } from "./concierge/resolve.js";
export type { ResolvePort, ResolveResult, PartyKind } from "./concierge/resolve.js";
// WP-07 Concierge — the tenant-voice QUOTE REPLY render (REQ-098): a design-law-clean, deterministic
// quote email (tokens inlined to literals; the SENT body is bounded, never model output).
export { renderQuoteReply, QuoteReplyView } from "./concierge/quote-reply.js";
export type { QuoteReplyData } from "./concierge/quote-reply.js";
// WP-07 Concierge — the PURE PRICE→DRAFT→DECIDE core (REQ-026/093/098): auto-reply only when floor-clean
// AND independently corroborated AND resolution-confident; else queue. (ComposeInput aliased to avoid the
// biller's ComposeInput.)
export { composeConcierge } from "./concierge/compose.js";
export type { ComposeInput as ConciergeComposeInput, ConciergeDecision } from "./concierge/compose.js";
