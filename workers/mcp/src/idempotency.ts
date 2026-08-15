// WP-13 Task 3 (REQ-106) — THE MCP → api IDEMPOTENCY-KEY DERIVATION.
//
// REQ-106: an MCP tool call must be idempotent — a client that retries the SAME logical operation must not
// double-apply a mutation. The api worker already enforces idempotency on every mutation via the `Idempotency-Key`
// header (workers/api/src/middleware/idempotency.ts, REQ-156): it hashes (tenant · method · pathname · key) into a
// KV scope and replays the first result for a repeated key within a 24h window. So the MCP layer's whole job is to
// hand the api a key that is the SAME across a retried operation and DISTINCT across unrelated ones.
//
// THE KEY MUST IDENTIFY THE SEMANTIC OPERATION — NOT THE JSON-RPC ENVELOPE ID. A JSON-RPC `id` is a per-connection
// correlation counter: a client may reuse `id:1` for a totally different booking (→ the api would replay the first
// booking's response inside the 24h window: a SILENT DROP), and a client that retries after a dropped connection
// picks a FRESH id for the same booking (→ a DOUBLE-APPLY). Both are wrong. So the material is the operation's own
// identity:
//   · a CLIENT-SUPPLIED `idempotency_key` in the tool arguments when present (the client's explicit "this is one
//     operation" token — authoritative, so two calls with the same token collapse regardless of other args), else
//   · the CANONICAL JSON of the arguments (stable key order) — the ASSUMPTION being that identical semantic
//     arguments denote the same operation. A tool whose repeat with identical args is legitimately distinct must
//     carry a client `idempotency_key`.
// Folded with the PAIRING id (two pairings' identical args must never collide — the api folds tenant, but a tenant
// can hold two pairings, REQ-025) and the TOOL name (same args across two tools are two intents). SHA-256'd to a
// fixed-length, header-safe token (an `Idempotency-Key` HTTP header value cannot carry a NUL or arbitrary bytes).

import { isRecord } from "./is-record.js";

const NUL = String.fromCharCode(0); // illegal in a header value; unambiguous field separator pre-hash
const KEY_PREFIX = "mcp-idem-";

// Deterministic JSON: object keys sorted recursively so {a,b} and {b,a} canonicalize identically. (Mirrors the
// ledger's canonical-hash discipline in spirit; a self-contained copy — mcp keeps its own hash, F6.)
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeys(src[k]);
    return out;
  }
  return value;
}

/**
 * Derive the api `Idempotency-Key` header value for one MCP tool call, DETERMINISTICALLY from the SEMANTIC
 * operation — (pairingId · toolName · operation-material). The operation material is a client-supplied
 * `arguments.idempotency_key` when present, else the canonical JSON of the arguments. Two calls that denote the
 * same operation (same client key, or identical args in any key order) derive the SAME key (the api replays the
 * first result); differing args — or a differing pairing/tool — derive a different key. Never keyed off the
 * JSON-RPC envelope id.
 */
export async function deriveIdempotencyKey(pairingId: string, toolName: string, args: unknown): Promise<string> {
  const clientKey = isRecord(args) && typeof args.idempotency_key === "string" && args.idempotency_key !== "" ? args.idempotency_key : null;
  const material = clientKey ?? canonicalJson(args);
  const raw = [pairingId, toolName, material].join(NUL);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return KEY_PREFIX + hex;
}
