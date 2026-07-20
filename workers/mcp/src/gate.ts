// WP-13 Task 3 (REQ-101/102) — THE MUTATION CHOKEPOINT (server-side, MCP-caller-facing).
//
// Every MUTATING MCP tool call passes through beforeMutation() BEFORE its handler runs. This is the ONE place an
// MCP-originated write is inspected on the MCP side — the twin discipline to the api's server-side Gatekeeper
// (REQ-030): the api still runs its own gates on the callApi round-trip (there is no bypass), but caps + confirm
// are POLICY the MCP layer owns over the OAuth principal, so they are enforced here, once, ahead of the write.
//
// This task ships the PLUMBING only: an ordered, registrable chain that is EMPTY today. Later tasks add checks —
// Task 8 registers the spend/velocity/lane CAPS check (REQ-105), Task 9 the human-CONFIRM check (REQ-102) — each
// via registerMutationCheck, in registration order. A check throws MutationBlocked to refuse the write; the
// dispatcher maps that to a JSON-RPC error and the handler never runs (nothing is sent to the api).
//
// The chain is a module-level singleton so a later task's `registerMutationCheck(...)` at import time wires into
// the same gate the composition root passes to dispatch(). Tests inject their own beforeMutation (or register a
// spy + resetMutationChecks) — mirroring the OAuth module's injected-deps discipline.
import type { ToolCtx, ToolDef } from "./tools/registry.js";

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

// The ordered chain. Empty in this task; Task 8/9 push their checks. Module-level so registrations at import time
// (a later task's side-effecting `registerMutationCheck`) land in the gate the composition root actually runs.
const mutationChecks: MutationCheck[] = [];

/** Append a check to the chokepoint chain (runs in registration order). Later tasks call this at module load. */
export function registerMutationCheck(check: MutationCheck): void {
  mutationChecks.push(check);
}

/** Test-only: clear the chain so a suite that registers a spy check does not leak it into another suite. */
export function resetMutationChecks(): void {
  mutationChecks.length = 0;
}

/**
 * THE CHOKEPOINT. Run every registered check IN ORDER for a mutating tool call; the first to throw MutationBlocked
 * refuses the write (short-circuits — the remaining checks and the tool handler never run). Resolves (allows the
 * write) when every check passes — and trivially resolves today, since the chain is empty until Task 8/9.
 */
export async function beforeMutation(ctx: ToolCtx, tool: ToolDef, args: unknown): Promise<void> {
  for (const c of mutationChecks) {
    await c.check(ctx, tool, args);
  }
}
