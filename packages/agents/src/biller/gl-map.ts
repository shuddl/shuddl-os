// REQ-031/REQ-020 — the Biller's FROZEN, TOTAL map from a quote line `kind` to the AR revenue account
// its invoice line posts to. The account STRINGS come from the ONE canonical chart-of-accounts
// (@shuddl/contracts gl-accounts) so the compose path, the ledger money projection, and the gl-netting
// fixture can never diverge (the gl-accounts parity test guards it; Task-3 QB reconcile depends on it).
// This map stays the source of truth for the kind→account MAPPING; the strings are byte-identical to
// what real invoice.issued events already carry — a rename would orphan them (append-only). PURE data:
// no LLM, no I/O, no ledger import (REQ-024) — contracts is the schema boundary, not the ledger.
import { GL_FREIGHT_AR, GL_FSC_AR, GL_ACCESSORIAL_AR } from "@shuddl/contracts";

export const GL_MAP = Object.freeze({
  freight: GL_FREIGHT_AR,
  fsc: GL_FSC_AR,
  accessorial: GL_ACCESSORIAL_AR,
} as const);

export type BillableLineKind = keyof typeof GL_MAP;

/**
 * glMap — resolve a quote line kind to its GL account. A kind not in the map THROWS, never silently
 * defaults: a mis-mapped account would post revenue to the wrong ledger line and QB export reconciles
 * to the penny (CLAUDE.md rule 6). Object.hasOwn (not a bare index read) so prototype-chain keys like
 * "toString" THROW as unmapped rather than resolving to a Function off Object.prototype.
 */
export function glMap(kind: string): string {
  const account = Object.hasOwn(GL_MAP, kind) ? GL_MAP[kind as BillableLineKind] : undefined;
  if (account === undefined) {
    throw new Error(
      `glMap: no GL account mapped for quote line kind "${kind}" — a kind must be mapped explicitly, never defaulted (REQ-031)`,
    );
  }
  return account;
}
