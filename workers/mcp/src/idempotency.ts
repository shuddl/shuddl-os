// WP-13 Task 3 (REQ-106) — THE MCP → api IDEMPOTENCY-KEY DERIVATION.
//
// REQ-106: an MCP tool call must be idempotent — a client that retries the SAME logical request (same JSON-RPC
// `id`, same pairing, same tool) must not double-apply a mutation. The api worker already enforces idempotency on
// every mutation via the `Idempotency-Key` header (workers/api/src/middleware/idempotency.ts, REQ-156): it hashes
// (tenant · method · pathname · key) into a KV scope and replays the first result for a repeated key. So the MCP
// layer's whole job is to hand the api a key that is DETERMINISTIC across a retried tool call and DISTINCT across
// unrelated ones — the api does the dedup.
//
// The key derives from THREE inputs so it collapses exactly the retries we want and nothing else:
//   · the JSON-RPC request `id` — the client's own request identity; a retry reuses it, a new call changes it;
//   · the PAIRING id — two different pairings issuing the same JSON-RPC id must NOT collide (the api folds tenant
//     into its own scope, but two pairings can share a tenant, so the pairing must ride the key too — REQ-025);
//   · the TOOL name — one id used across two tools is two distinct intents.
//
// It is SHA-256'd to hex so the result is a fixed-length, header-safe token (an `Idempotency-Key` HTTP header
// value cannot contain a NUL separator or an arbitrary client-supplied id byte). A NUL joins the fields before
// hashing so a value containing the separator char cannot forge a different tuple — the api middleware's own
// discipline, mirrored here.

/** A JSON-RPC 2.0 message id: a string, a number, or null (RFC/JSON-RPC §4). */
export type JsonRpcId = string | number | null;

const NUL = String.fromCharCode(0); // illegal in an id-as-header value; unambiguous field separator pre-hash
const KEY_PREFIX = "mcp-idem-";

/**
 * Derive the api `Idempotency-Key` header value for one MCP tool call, DETERMINISTICALLY from
 * (pairingId · toolName · jsonRpcId). Two calls with the same triple derive the SAME key (the api replays the
 * first result); any difference — a new id, a different tool, a different pairing — derives a different key.
 *
 * The id is JSON-encoded before hashing so the number `1` and the string `"1"` never collapse to one key.
 */
export async function deriveIdempotencyKey(pairingId: string, toolName: string, jsonRpcId: JsonRpcId): Promise<string> {
  const raw = [pairingId, toolName, JSON.stringify(jsonRpcId ?? null)].join(NUL);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return KEY_PREFIX + hex;
}
