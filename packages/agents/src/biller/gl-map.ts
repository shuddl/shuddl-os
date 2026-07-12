// REQ-031 — the Biller's FROZEN, TOTAL map from a quote line `kind` to the AR revenue account its
// invoice line posts to. Account codes follow the journal-export convention (packages/ledger/src/gl/
// export.ts: `1200-AR`, `2000-AP` controls) — these are the revenue gl_map accounts an AR money_line
// credits in the double entry. PURE data: no LLM, no I/O, no ledger import (REQ-024).

export const GL_MAP = Object.freeze({
  freight: "4000-FREIGHT-AR",
  fsc: "4100-FSC-AR",
  accessorial: "4200-ACCESSORIAL-AR",
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
