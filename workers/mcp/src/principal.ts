// WP-13 Task 2 (REQ-102) — THE FAIL-CLOSED pairing→SessionClaims MINT (the security core).
//
// An OAuth-authorized MCP client never speaks to freight reality with its own credentials; it acts as a
// BOUNDED api principal. mintPrincipalJwt resolves an ACTIVE `mcp` pairing from the control plane and mints a
// short-lived HS256 SessionClaims JWT that the api worker's auth middleware verifies EXACTLY as it verifies a
// browser session (verify(bearer, JWT_SECRET, "HS256") → SessionClaims.safeParse). Three invariants make this
// principal safe by construction:
//
//   · TENANT IS PAIRING-DERIVED. `tenant` is the pairing row's tenant_id and nothing else — never a client
//     field, header, or query. A client cannot name a tenant it was not paired to (REQ-025/132/156).
//   · ROLE IS BOUNDED to `ops`. NEVER admin/finance/driver — so the principal structurally cannot emit a
//     finance-only event (e.g. credit.checked) nor satisfy a finance-required approval (REQ-102/105).
//   · THE PAIRING ID RIDES THE EXISTING `sub` CLAIM as "mcp:<id>". This encodes the grant subject inside the
//     already-signed claim set, so nothing downstream needs a new claim and @shuddl/contracts session.ts is
//     UNTOUCHED. pairingIdFromSub recovers it for the MCP session→pairing mapping.
//
// The minted JWT is used ONLY to drive callApi (the api service-binding reuse seam). It is NEVER returned to an
// OAuth client — the client only ever holds the opaque OAuth access token (see oauth.ts).
import { sign } from "hono/jwt";
import type { SessionClaims } from "@shuddl/contracts";
import type { Env } from "./index.js";

// The pairing id is carried in `sub` behind this prefix (the sub-encoding trick that avoids a new claim).
const MCP_SUB_PREFIX = "mcp:";

// The BOUNDED role every MCP principal runs as. A const so tests + call sites reference one source of truth;
// it is NEVER widened to admin/finance/driver (that would let an intern-bot escalate past the CFO caps, REQ-102).
export const MCP_PRINCIPAL_ROLE = "ops" as const;

// A minted principal is ephemeral: a 5-minute lifetime is ample for a single MCP tool round-trip and bounds the
// blast radius of a leaked JWT (it also cannot be minted at all without an active pairing, below).
const PRINCIPAL_TTL_SECONDS = 300;

// Thrown when no ACTIVE `mcp` pairing backs the requested id — the mint FAILS CLOSED (nothing is issued). A
// distinct type so the OAuth token endpoint (and tests) can tell "no principal" apart from a transport error.
export class PrincipalMintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrincipalMintError";
  }
}

/** Encode a pairing id into the SessionClaims `sub` (the inverse of pairingIdFromSub). */
export function subForPairing(pairingId: string): string {
  return MCP_SUB_PREFIX + pairingId;
}

/**
 * Recover the pairing id from a SessionClaims `sub`, or null if this is not an MCP principal (a human/portal
 * session sub). Used by the MCP session→pairing mapping; NEVER trusts a bare sub as a pairing id.
 */
export function pairingIdFromSub(sub: string): string | null {
  return sub.startsWith(MCP_SUB_PREFIX) ? sub.slice(MCP_SUB_PREFIX.length) : null;
}

// ── the fail-closed client-secret resolver (the twin of the translator's NotConfiguredSecretResolver) ─────────
// The OAuth token endpoint authenticates the confidential client by resolving the PAIRING'S `secret_ref` to the
// client-secret bytes through this port. The composition-root DEFAULT is NotConfigured (no secret store bound ⇒
// every resolve returns null ⇒ every token exchange 401s). Binding a real store is the CONFIRM-gated live flip
// (secrets never in the toml, REQ-154); the ceremony ships fully tested via an injected static resolver.

export interface SecretResolver {
  /** Resolve a pairing's `secret_ref` → the client-secret bytes, or null when unresolvable (⇒ fail-closed 401). */
  resolve(secretRef: string): Promise<string | null>;
}

/** Fail-closed default: resolves NOTHING, so no environment can complete a token exchange until the CONFIRM-gated
 *  secret store is wired. The symmetric twin of the translator's NotConfiguredSecretResolver. */
export class NotConfiguredSecretResolver implements SecretResolver {
  async resolve(_secretRef: string): Promise<string | null> {
    void _secretRef;
    return null;
  }
}

/** The tests/dev resolver: an explicit secret_ref → secret map. Never a real credential. */
export class StaticSecretResolver implements SecretResolver {
  constructor(private readonly secrets: Record<string, string>) {}
  async resolve(secretRef: string): Promise<string | null> {
    return this.secrets[secretRef] ?? null;
  }
}

/** The subset of a `pairings` row the MCP layer reads. tenant_id is the ONLY tenant source for a principal. */
export interface McpPairing {
  id: string;
  tenant_id: string;
  scopes: string; // JSON array text (REQ-105 scope allowlist — read by later tasks)
  caps: string; // JSON object text (REQ-105 spend/velocity/lane caps — read by later tasks)
}

/**
 * Resolve an ACTIVE `mcp` pairing by id, or null. The kind='mcp' + status='active' predicate is the fail-closed
 * gate: an unknown id, a non-mcp pairing (api/webhook/edi), or a revoked/suspended one all resolve to null. The
 * control plane is auth-resolution only — never a tenant data path (REQ-025).
 */
export async function resolveActiveMcpPairing(db: D1Database, pairingId: string): Promise<McpPairing | null> {
  const row = await db
    .prepare("SELECT id, tenant_id, scopes, caps, status FROM pairings WHERE id = ?1 AND kind = 'mcp' LIMIT 1")
    .bind(pairingId)
    .first<{ id: string; tenant_id: string; scopes: string; caps: string; status: string }>();
  if (row === null || row.status !== "active") return null;
  return { id: row.id, tenant_id: row.tenant_id, scopes: row.scopes, caps: row.caps };
}

/** Every token of a recorded grant scope must still sit in the pairing's CURRENT allowlist. Fail-closed on
 *  an empty scope, an empty allowlist, or a malformed allowlist JSON — the same posture the /authorize-time
 *  check takes (oauth.ts scopeWithinAllowlist); duplicated here rather than imported to avoid a cycle, and
 *  pinned against it by the parity test in principal.test.ts. */
function scopeStillAllowed(grantScope: string, pairingScopesJson: string): boolean {
  const tokens = grantScope.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  let allowed: unknown;
  try {
    allowed = JSON.parse(pairingScopesJson);
  } catch {
    return false;
  }
  if (!Array.isArray(allowed)) return false;
  const set = new Set(allowed.filter((s): s is string => typeof s === "string"));
  return tokens.every((t) => set.has(t));
}

/**
 * Mint the api-facing SessionClaims JWT for an authorized MCP pairing. FAILS CLOSED: a missing / inactive /
 * non-mcp pairing throws PrincipalMintError (nothing is issued). tenant comes ONLY from the pairing row; role is
 * the bounded `ops`; sub is "mcp:<pairingId>"; exp is 5 minutes out. HS256 over env.JWT_SECRET — the same secret
 * the api auxiliary verifies against, so the token this mints is accepted at /v1/*.
 *
 * `now` is injectable purely for deterministic exp assertions in tests; production passes the default clock.
 */
export async function mintPrincipalJwt(
  env: Pick<Env, "CONTROL_DB" | "JWT_SECRET">,
  pairingId: string,
  now: () => number = () => Date.now(),
  /** The scope recorded on the OAuth grant, re-checked against the pairing's CURRENT allowlist
   *  (2026-08-01 convergence audit): scope was validated once at /authorize and never again, so
   *  NARROWING a pairing's scopes left an already-issued token acting for its full hour. Status-based
   *  revocation was already honored here; this closes the scope half at the same seam. Omitted ⇒ no
   *  scope claim to re-check (an internal mint), which is unchanged behavior. */
  grantScope?: string,
): Promise<string> {
  const pairing = await resolveActiveMcpPairing(env.CONTROL_DB, pairingId);
  if (pairing === null) throw new PrincipalMintError(`no active mcp pairing: ${pairingId}`);
  if (grantScope !== undefined && !scopeStillAllowed(grantScope, pairing.scopes)) {
    throw new PrincipalMintError(`grant scope no longer within the pairing allowlist: ${pairingId}`);
  }

  const claims: SessionClaims = {
    sub: subForPairing(pairingId),
    tenant: pairing.tenant_id, // ONLY the pairing's tenant — never client-supplied
    role: MCP_PRINCIPAL_ROLE, // bounded — never admin/finance/driver
    exp: Math.floor(now() / 1000) + PRINCIPAL_TTL_SECONDS,
  };
  return sign(claims, env.JWT_SECRET); // hono/jwt defaults to HS256 — matches the api's verify(...,"HS256")
}
