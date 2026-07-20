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
// WP-10 Task 7 Copilot — the READ-ONLY, cite-or-abstain question-answerer over the ledger (REQ-038/024). A PURE
// core over an INJECTED read port (packages/agents never imports @shuddl/ledger), config-gated exactly like the
// Concierge parser: DeterministicCopilot (the CI path + auditable floor), NotConfiguredCopilot (rejects loudly),
// ClaudeCopilot (raw fetch, live only when a key+model is bound; fail-safe to ABSTAIN on garbage/ungrounded output).
export {
  DeterministicCopilot,
  NotConfiguredCopilot,
  ClaudeCopilot,
  CopilotError,
  classifyQuestion,
  selectCopilot,
  buildCopilotUserPrompt,
  COPILOT_SYSTEM_PROMPT,
} from "./copilot/answer.js";
export type { Copilot, ClaudeCopilotConfig, CopilotLlmConfig } from "./copilot/answer.js";
export type { CopilotReadPort, CopilotReadQuery, ReadEvent } from "./copilot/port.js";
// WP-11 Task 6 Collector — the PURE aging watch + tone-matched dunning DRAFT render (REQ-032). Deterministic
// + LLM-FREE: whole-days-overdue → an escalation BUCKET → a FIXED per-bucket template (never model output).
// The cron sweep (workers/agents/src/collector.ts) DRAFTS these into `messages` rows and NEVER sends; Task 7
// owns the human review-and-send. The deterministic id/body_ref keep a re-sweep idempotent (INSERT OR IGNORE).
export {
  agingBucket,
  overdueDays,
  dunningDraftId,
  dunningBodyRef,
  DUNNING_TONES,
  REMINDER_MAX_DAYS,
  FIRM_MAX_DAYS,
} from "./collector/aging.js";
export type { DunningBucket, DunningTone } from "./collector/aging.js";
export { renderDunningDraft, DunningDraftView } from "./collector/dunning.js";
export type { DunningDraftData } from "./collector/dunning.js";
// WP-14 Task 5 (REQ-127/035/024) Migrator — the LLM column-guesser for a messy onboarding spreadsheet. LLM
// ONLY here; the deterministic mapping + gap-row law live in the PURE @shuddl/adapters core. Config-gated
// exactly like the Concierge/Copilot: an unbound LLM DEGRADES to the deterministic @shuddl/adapters mapping.
export {
  DeterministicMigrator,
  NotConfiguredMigrator,
  ClaudeMigrator,
  MigratorError,
  selectMigrator,
  buildOverrides,
  MIGRATOR_SYSTEM_PROMPT,
} from "./migrator/guess.js";
export type { MigratorGuesser, ColumnGuess, ClaudeMigratorConfig, MigratorLlmConfig } from "./migrator/guess.js";
