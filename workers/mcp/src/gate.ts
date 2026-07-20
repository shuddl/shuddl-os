// WP-13 Task 3 (REQ-101/102) — THE MUTATION CHOKEPOINT (server-side, MCP-caller-facing).
//
// Every MUTATING MCP tool call passes through beforeMutation() BEFORE its handler runs. This is the ONE place an
// MCP-originated write is inspected on the MCP side — the twin discipline to the api's server-side Gatekeeper
// (REQ-030): the api still runs its own gates on the callApi round-trip (there is no bypass), but caps + confirm
// are POLICY the MCP layer owns over the OAuth principal, so they are enforced here, once, ahead of the write.
//
// THE CHAIN IS COMPOSED EXPLICITLY, NEVER BY IMPORT SIDE EFFECT. `DEFAULT_MUTATION_CHECKS` below is the SINGLE
// production source of truth: a check runs iff it appears in this array. We deliberately do NOT populate the chain
// via a module-global `registerMutationCheck` at import time — that pattern fails OPEN (a forgotten import, or a
// bundler treating a "side-effect-free" check module as dead code, silently leaves caps+confirm unenforced while
// everything still compiles and passes). With the explicit array, Task 8 (caps, REQ-105) and Task 9 (confirm,
// REQ-102) ADD their check by an EXPLICIT code edit at the marker below, and the identity test proves the live
// dispatch chain IS this array (a declared-but-not-composed check fails loudly). `registerMutationCheck` survives
// as a TEST-ONLY spy utility, decoupled from production; tests also inject `beforeMutation` via dispatch deps.
import type { ToolCtx, ToolDef } from "./tools/registry.js";
import { capsCheck } from "./caps.js";
import { confirmCheck } from "./confirm.js";

/**
 * Thrown by a mutation check to REFUSE a write. `code` is a stable machine token (e.g. "caps_exceeded",
 * "confirm_required") the dispatcher surfaces in the JSON-RPC error `data`; `message` is human-facing. A distinct
 * type so dispatch tells a policy refusal apart from an internal/transport error (which is -32603, not a refusal).
 */
export class MutationBlocked extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MutationBlocked";
  }
}

/** One link in the chokepoint chain. `check` resolves to allow the write, or throws MutationBlocked to refuse it. */
export interface MutationCheck {
  /** A stable name for ordering/debugging (e.g. "caps", "confirm"). */
  name: string;
  check(ctx: ToolCtx, tool: ToolDef, args: unknown): Promise<void>;
}

/** A composed chokepoint function that also exposes, by identity, the exact `checks` array it runs — so a test can
 *  assert the live production chain IS the explicit source array (not some mutable, side-effect-populated global). */
export interface ComposedMutationGate {
  (ctx: ToolCtx, tool: ToolDef, args: unknown): Promise<void>;
  readonly checks: readonly MutationCheck[];
}

/**
 * THE PRODUCTION MUTATION-CHECK CHAIN — the single, explicit source of truth. A check is enforced ONLY if it is
 * listed here. EMPTY today; later tasks ADD their check at the marker (an explicit code edit, never an import
 * side effect), so a check that is written but not listed here is simply, verifiably, not run.
 */
export const DEFAULT_MUTATION_CHECKS: MutationCheck[] = [
  // ↓↓↓ ADD PRODUCTION CHECKS HERE, IN ORDER (an explicit edit — no import-side-effect registration) ↓↓↓
  // Task 8 (REQ-105): capsCheck — spend / velocity / lane caps over the OAuth principal (keyed off ctx.pairingId).
  // It runs FIRST: it owns the accepted-quote fetch (memoized on ctx) + the fail-closed quote-read codes.
  capsCheck,
  // Task 9 (REQ-108): confirmCheck — the human-CONFIRM-before-money gate on book_shipment. Runs after caps and
  // REUSES the memoized sell (no double-fetch). A refusal from EITHER check blocks the money-moving write.
  confirmCheck,
  // ↑↑↑ ADD PRODUCTION CHECKS HERE ↑↑↑
];

/**
 * Compose an ORDERED chain into a chokepoint function. The first check to throw MutationBlocked refuses the write
 * (short-circuits — the remaining checks and the tool handler never run). The composed function carries its source
 * `checks` array by identity for the anti-regression identity test.
 */
export function composeMutationChecks(checks: readonly MutationCheck[]): ComposedMutationGate {
  const gate = async (ctx: ToolCtx, tool: ToolDef, args: unknown): Promise<void> => {
    for (const c of checks) await c.check(ctx, tool, args);
  };
  return Object.assign(gate, { checks });
}

/**
 * THE CHOKEPOINT the composition root passes to dispatch — composed from the EXPLICIT DEFAULT_MUTATION_CHECKS.
 * Trivially resolves today (the chain is empty until Task 8/9 add checks EXPLICITLY to the array above).
 */
export const beforeMutation: ComposedMutationGate = composeMutationChecks(DEFAULT_MUTATION_CHECKS);

// ── TEST-ONLY spy utilities (NOT a production registration path) ──────────────────────────────────────────────
// A separate, mutable array a test may register a spy into to PROVE the production chain ignores it (there is no
// import-side-effect backdoor into `beforeMutation`). Production never reads this; only `composeTestChain` does.
const testChecks: MutationCheck[] = [];

/** Test-only: register a spy check into the test chain (NEVER the production chain). */
export function registerMutationCheck(check: MutationCheck): void {
  testChecks.push(check);
}
/** Test-only: clear the test chain between suites. */
export function resetMutationChecks(): void {
  testChecks.length = 0;
}
