import { env } from "cloudflare:test";
import { decode } from "hono/jwt";
import { beforeAll, describe, expect, it } from "vitest";
import { callApi } from "../src/index.js";
import {
  mintPrincipalJwt,
  pairingIdFromSub,
  subForPairing,
  PrincipalMintError,
  MCP_PRINCIPAL_ROLE,
} from "../src/principal.js";
import { applyControl, seedPairing, seedTenant } from "./helpers.js";

// WP-13 Task 2 (REQ-102) — THE FAIL-CLOSED pairing→SessionClaims MINT (the security core).
//
// mintPrincipalJwt resolves an ACTIVE `mcp` pairing from CONTROL_DB and mints an HS256 SessionClaims JWT the
// api worker's auth middleware accepts. tenant comes ONLY from the pairing row; role is the BOUNDED `ops`
// (never admin/finance/driver); the pairing id rides in the EXISTING `sub` claim as "mcp:<id>" so nothing
// downstream needs a new claim and @shuddl/contracts session.ts is untouched. The minted JWT drives callApi
// (the api service-binding reuse seam) and is NEVER returned to an OAuth client.

const ACTIVE = "prn-active";
const INACTIVE = "prn-inactive";
const NON_MCP = "prn-api";
const TENANT_ID = "t-mcp";
const TENANT_SLUG = "tenant-mcp";

beforeAll(async () => {
  await applyControl(env.CONTROL_DB);
  await seedTenant(env.CONTROL_DB, TENANT_ID, TENANT_SLUG);
  await seedPairing(env.CONTROL_DB, { id: ACTIVE, tenantId: TENANT_ID, kind: "mcp", status: "active" });
  await seedPairing(env.CONTROL_DB, { id: INACTIVE, tenantId: TENANT_ID, kind: "mcp", status: "revoked" });
  await seedPairing(env.CONTROL_DB, { id: NON_MCP, tenantId: TENANT_ID, kind: "api", status: "active" });
});

describe("mintPrincipalJwt — the fail-closed pairing→SessionClaims mint", () => {
  it("an ACTIVE mcp pairing mints a JWT the api auxiliary ACCEPTS (200 at /v1/whoami)", async () => {
    const jwt = await mintPrincipalJwt(env, ACTIVE);

    const res = await callApi(env, { method: "GET", path: "/v1/whoami", jwt });
    expect(res.status).toBe(200);

    // whoami echoes the api-VERIFIED session — proof tenant/role/sub survived a real HS256 verify + Zod parse.
    const session = (await res.json()) as { sub: string; tenant: string; role: string };
    expect(session.tenant).toBe(TENANT_ID); // tenant is the PAIRING's tenant_id — never client-supplied
    expect(session.role).toBe("ops"); // bounded principal — structurally cannot be admin/finance/driver
    expect(session.sub.startsWith("mcp:")).toBe(true);
    expect(session.sub).toBe(`mcp:${ACTIVE}`);
  });

  it("the minted role is the BOUNDED `ops` sentinel (never a finance/admin/driver principal)", async () => {
    expect(MCP_PRINCIPAL_ROLE).toBe("ops");
    const jwt = await mintPrincipalJwt(env, ACTIVE);
    const { payload } = decode(jwt);
    expect((payload as { role: string }).role).toBe("ops");
    expect((payload as { tenant: string }).tenant).toBe(TENANT_ID);
  });

  it("a short exp is set (≤ 5 min out) — the principal JWT is ephemeral", async () => {
    const nowMs = 1_760_000_000_000;
    const jwt = await mintPrincipalJwt(env, ACTIVE, () => nowMs);
    const { payload } = decode(jwt);
    const exp = (payload as { exp: number }).exp;
    expect(exp).toBeGreaterThan(Math.floor(nowMs / 1000));
    expect(exp).toBeLessThanOrEqual(Math.floor(nowMs / 1000) + 300);
  });

  it("an INACTIVE pairing throws (fail-closed) — nothing is minted", async () => {
    await expect(mintPrincipalJwt(env, INACTIVE)).rejects.toBeInstanceOf(PrincipalMintError);
  });

  it("a NON-mcp (kind='api') pairing throws — the mint is mcp-only", async () => {
    await expect(mintPrincipalJwt(env, NON_MCP)).rejects.toBeInstanceOf(PrincipalMintError);
  });

  it("an UNKNOWN pairing id throws — nothing is minted", async () => {
    await expect(mintPrincipalJwt(env, "prn-does-not-exist")).rejects.toBeInstanceOf(PrincipalMintError);
  });
});

describe("pairingIdFromSub / subForPairing round-trip", () => {
  it("pairingIdFromSub('mcp:P123') === 'P123'", () => {
    expect(pairingIdFromSub("mcp:P123")).toBe("P123");
  });
  it("subForPairing is the inverse", () => {
    expect(subForPairing("P123")).toBe("mcp:P123");
    expect(pairingIdFromSub(subForPairing("abc"))).toBe("abc");
  });
  it("a non-mcp sub (a human user/session sub) yields null — never a mis-attributed pairing id", () => {
    expect(pairingIdFromSub("u-human")).toBeNull();
    expect(pairingIdFromSub("portal:party-1")).toBeNull();
  });
});

// 2026-08-01 convergence audit — a NARROWED pairing allowlist must bite the NEXT call, not after the
// token's full hour. Scope was validated once at /authorize and never re-read; status-based revocation
// was already honored at this same seam, so the scope half now rides it too.
describe("mint re-checks the grant's scope against the pairing's CURRENT allowlist", () => {
  const PN = "prn-scope-narrow";
  const TN = "t-scope-narrow";

  it("mints while the grant scope is still within the allowlist, and REFUSES once it is narrowed", async () => {
    await seedTenant(env.CONTROL_DB, TN, "tenant-scope-narrow");
    await seedPairing(env.CONTROL_DB, { id: PN, tenantId: TN, kind: "mcp", scopes: '["mcp"]', caps: "{}" });
    // In-allowlist: mints exactly as before.
    await expect(mintPrincipalJwt(env, PN, () => Date.now(), "mcp")).resolves.toBeTypeOf("string");
    // The operator narrows the pairing's scopes; the already-issued grant still says "mcp".
    await env.CONTROL_DB.prepare("UPDATE pairings SET scopes = ?1 WHERE id = ?2").bind("[]", PN).run();
    await expect(mintPrincipalJwt(env, PN, () => Date.now(), "mcp")).rejects.toThrow(/scope no longer/);
    // A mint with no recorded scope (an internal caller) is unchanged.
    await expect(mintPrincipalJwt(env, PN)).resolves.toBeTypeOf("string");
  });
});

// §1559 (REQ-102/118) — THE FIRST REFUSAL BRANCH NAMES ITSELF; THE SECOND ALREADY DID.
//
// `mintPrincipalJwt` has two refusal branches and both throw `PrincipalMintError`. The scope branch was already
// covered — and covered WELL, by the block above: it mints, has the operator narrow the pairing, re-mints, and
// asserts `/scope no longer/`, which is the message discriminator §1558 argues for. What the FIRST branch's
// three cases (inactive, non-mcp, unknown id) assert is only the error CLASS, which cannot tell the branches
// apart. That matters for the same reason it did at §1558: deleting the `pairing === null` guard makes the next
// line read `pairing.scopes` and throw a **TypeError**, so those cases are pinned by a crash rather than by the
// refusal moving — and the day the code becomes null-tolerant they go green with the guard gone.
describe("§1559 the pairing-lookup refusal names itself, so the two branches are distinguishable", () => {
  it("an unknown pairing names the LOOKUP branch, not merely PrincipalMintError", async () => {
    await expect(mintPrincipalJwt(env, "prn-nope")).rejects.toThrow(/no active mcp pairing/i);
  });
});
