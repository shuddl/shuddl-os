// REQ-021/REQ-022/REQ-035: legacy ingest/projection adapters (171-col export,
// rate-profile CSV, EDI, QuickBooks journal) land WP-11/12/15.
export const ADAPTERS_PACKAGE = "@shuddl/adapters" as const;

// REQ-127 / REQ-035 (WP-14 Task 5) — the LIGHT self-serve Migrator: the PURE, deterministic spreadsheet→
// primitives mapper with the gap-row no-silent-drop law. No I/O, no ledger/rater import (mirrors @shuddl/edi).
export {
  mapSpreadsheet,
  resolveColumnMapping,
  normalizeHeader,
  parseSheet,
  MigratorMappingSchema,
  CANONICAL_FIELDS,
  CONFIDENCE_FLOOR,
} from "./migrator.js";
export type {
  ParsedSheet,
  MapResult,
  MappedParty,
  MappedShipment,
  GapRow,
  GapReason,
  RateSheetHint,
  ColumnPlan,
  ColumnDecision,
  CanonicalField,
  PartyRole,
  MigratorMapping,
} from "./migrator.js";

// REQ-021/REQ-022/REQ-035 (WP-15 Task 4) — the HEAVY continuous 171-col legacy-mirror: the PURE, config-driven
// mapper that turns a legacy export row into the SAME canonical event kind, tagged source:'legacy', echo-safe,
// with the continuous gap-row no-silent-drop law. The WORKER (workers/agents/src/mirror-sweep.ts) does the I/O.
export { mapLegacyExport, LegacyMirrorConfigSchema, MIRROR_KINDS, MIRROR_MODULES, stableStringify, nullMap } from "./legacy-mirror.js";
export type {
  LegacyMirrorConfig,
  LegacyRecordSpec,
  LegacyFieldSpec,
  MirrorResult,
  MirrorRecord,
  MirrorEventDraft,
  MirrorQuarantine,
  MirrorQuarantineReason,
  MirrorKind,
  MirrorModule,
  ParsedFeed,
} from "./legacy-mirror.js";

// REQ-022 (WP-15 Task 5) — the PROJECT-BACK-OUT adapter: the PURE inverse of the mirror-IN. It projects SHUDDL-held
// facts to incumbent-format rows, EMBEDDING each fact's SHUDDL event id in the SHARED echoColumn so the incumbent's
// echo is recognized + skipped (no ping-pong). Reuses the Task-4 config + stableStringify — one echo contract.
export { projectOut, serializeOutboundCsv } from "./legacy-project-out.js";
export type { ProjectableEvent, OutboundRow } from "./legacy-project-out.js";
