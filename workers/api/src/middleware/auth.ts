import type { Context, Next } from "hono";
import { verify } from "hono/jwt";
import { SessionClaims, type Role } from "@shuddl/contracts";
import { ApiError } from "./error.js";
import type { Env, Vars } from "../index.js";

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

export async function auth(c: Ctx, next: Next): Promise<void> {
  // REQ-156 / genesis/14 §04: tenant is resolved from the JWT claim — a client-supplied
  // tenant id anywhere in the request is rejected outright, not ignored.
  if (c.req.header("X-Tenant-Id") || c.req.query("tenant")) {
    throw new ApiError("TENANT_MISMATCH", 403, "TENANT IS RESOLVED SERVER-SIDE, NEVER CLIENT-SUPPLIED");
  }
  const header = c.req.header("Authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!bearer) throw new ApiError("UNAUTHORIZED", 401, "MISSING BEARER TOKEN");
  let payload: unknown;
  try {
    payload = await verify(bearer, c.env.JWT_SECRET, "HS256");
  } catch {
    throw new ApiError("UNAUTHORIZED", 401, "INVALID TOKEN");
  }
  const claims = SessionClaims.safeParse(payload);
  if (!claims.success) throw new ApiError("UNAUTHORIZED", 401, "INVALID SESSION CLAIMS");
  c.set("session", claims.data);
  await next();
}

export function requireRole(...roles: Role[]) {
  return async (c: Ctx, next: Next): Promise<void> => {
    if (!roles.includes(c.get("session").role)) throw new ApiError("FORBIDDEN", 403, "ROLE NOT PERMITTED");
    await next();
  };
}
