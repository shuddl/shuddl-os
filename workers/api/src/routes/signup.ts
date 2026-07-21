import type { Context, Hono } from "hono";
import { sign } from "hono/jwt";
import { z } from "@shuddl/contracts";
import { envelope } from "../middleware/error.js";
import { provisionTenant, provisioningEnabled, ProvisionError } from "../provision.js";
import type { Env, Vars } from "../index.js";

// REQ-121/025 (WP-14 Task 3) — the PRE-AUTH, DARK self-serve signup route.
//
// POST /pub/signup is a PEER of the /pub/* no-auth surface (routes/public.ts): it is mounted OUTSIDE
// app.use("/v1/*", auth) + idempotency, so NO session middleware runs — a stranger has no token yet. The whole
// path is DARK behind the server-side PROVISIONING_ENABLED flag (OFF by default, absent from every
// wrangler.toml): the route 404s until R4 flips it, so it does not even exist to a client (no oracle). When ON,
// it CLAIMS a pre-provisioned pool slot (provisionTenant) and mints the new tenant's ADMIN session so the
// customer can immediately read their own workspace (the resolveTenantDb claimed-fallback in tenants.ts).
//
// FAIL-CLOSED ERROR MAPPING: provisionTenant / assertNotPlatformTenant throw plain Error / ProvisionError. A
// `_platform` claim or bad input must surface as a CLEAN 4xx, never a 500, and NO internal reason (SQL, slot id,
// the reserved-tenant message) may leak into the response — every branch returns a fixed, generic message.

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

const SESSION_TTL_SECONDS = 60 * 60 * 8; // an 8h admin workspace session

// .strict() body: the company display name, the admin's email, and the desired workspace slug (subdomain). The
// slug's FULL law is ProvisionInput's DNS_LABEL regex downstream (which structurally rejects every `_`-prefixed
// sentinel); this is only the coarse shape. The plan is NOT client-chosen — it is fixed server-side to "pilot"
// so a caller can never request a reserved/privileged plan.
const SignupBody = z
  .object({
    company: z.string().min(1).max(200),
    email: z.string().email(),
    slug: z.string().min(1).max(63),
  })
  .strict();

export function mountSignupRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  app.post("/pub/signup", async (c) => {
    // DARK (REQ-121): the flag is OFF by default → the route does not exist to a client (404, no oracle). The
    // outermost gate, before parsing the body, so a dark deployment reveals nothing.
    if (!provisioningEnabled(c.env)) return envelope(c, "NOT_FOUND", 404, "NOT FOUND");

    const parsed = SignupBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return envelope(c, "VALIDATION_FAILED", 400, "INVALID SIGNUP REQUEST");
    const { company, email, slug } = parsed.data;

    let provisioned;
    try {
      // plan fixed server-side; provisionTenant re-runs the flag + assertNotPlatformTenant + DNS-label + reserved
      // -plan guards, so a `_platform`/`_pool_0N`/reserved-plan slug can never be claimed here.
      provisioned = await provisionTenant(c.env, { slug, name: company, plan: "pilot", admin: { email } });
    } catch (e) {
      return signupError(c, e);
    }

    // Mint the NEW tenant's admin session — mirrors middleware/auth.ts (HS256 over JWT_SECRET) and the
    // SessionClaims shape ({sub, tenant, role, exp}). sub matches the admin `users` row id provisionTenant seeds
    // (`u-admin-<slug>`); tenant is the freshly-claimed slug; role is admin.
    const now = Math.floor(Date.now() / 1000);
    const session = await sign(
      { sub: `u-admin-${provisioned.slug}`, tenant: provisioned.slug, role: "admin", exp: now + SESSION_TTL_SECONDS },
      c.env.JWT_SECRET,
    );

    // Workspace bootstrap — the session + the entry point ONLY. NO internal leak: the pool binding key, the
    // `_pool_0N` slot id (provisioned.tenant_id), the D1 handle, and the JWT secret are all withheld.
    return c.json(
      { session, workspace: { slug: provisioned.slug, plan: provisioned.plan, entry: "/v1/whoami" } },
      201,
    );
  });
}

// Map a provisioning failure to a CLEAN response — a `_platform`/bad-input claim is a 4xx, never a 500, and no
// internal reason (the underlying Error.message) is ever forwarded to the client.
function signupError(c: Ctx, e: unknown): Response {
  // assertNotPlatformTenant throws a PLAIN Error ("PLATFORM_TENANT_FORBIDDEN: …") — a reserved-id claim is bad
  // input, mapped to a clean 400 with a GENERIC message (the reserved-tenant reason never reaches the wire).
  if (e instanceof Error && e.message.includes("PLATFORM_TENANT_FORBIDDEN")) {
    return envelope(c, "VALIDATION_FAILED", 400, "INVALID SIGNUP REQUEST");
  }
  if (e instanceof ProvisionError) {
    switch (e.code) {
      case "PROVISIONING_DISABLED":
        return envelope(c, "NOT_FOUND", 404, "NOT FOUND"); // stay DARK even on this path
      case "INVALID_INPUT":
      case "RESERVED_PLAN":
        return envelope(c, "VALIDATION_FAILED", 400, "INVALID SIGNUP REQUEST");
      case "SLUG_TAKEN":
        // A taken workspace slug is a CLIENT collision, not a fault: 409 Conflict, generic message (no D1
        // detail / secret), so the user picks another slug instead of a 5xx page.
        return envelope(c, "VALIDATION_FAILED", 409, "THAT WORKSPACE NAME IS ALREADY TAKEN");
      case "EMAIL_TAKEN":
        return envelope(c, "VALIDATION_FAILED", 409, "THAT EMAIL IS ALREADY REGISTERED");
      case "POOL_EXHAUSTED":
        return envelope(c, "INTERNAL", 503, "SIGNUP CAPACITY UNAVAILABLE"); // ops must pre-provision more slots
      default: // PROVISION_FAILED / NOT_CLAIMED — never leak the underlying reason
        return envelope(c, "INTERNAL", 500, "SIGNUP COULD NOT COMPLETE");
    }
  }
  return envelope(c, "INTERNAL", 500, "SIGNUP COULD NOT COMPLETE");
}
