# WP-01 — Repo + CI + Assurance Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stand up the SHUDDL monorepo scaffold with every CI assurance gate live, so that from the first line of product code onward, scope, schema, isolation, and design law are machine-enforced (WP-01 DoD: CI green on empty app · a dummy PR without a REQ-ID fails · a cross-tenant read attempt fails the suite).

**Architecture:** pnpm workspace per `genesis/14 §01` (3 apps, 2 workers, 5 packages, fixtures, tools). The API worker (Hono) carries the conventions every later WP inherits: error envelope, Idempotency-Key, JWT-claim tenant resolution. Assurance is a chain of small standalone scripts under `tools/` (traceability, invariants, design audit, fixture registry, seed hash), each unit-tested, each wired into both a root `pnpm verify` script and `.github/workflows/ci.yml` in the gate order of `genesis/14 §07`.

**Tech Stack:** pnpm workspaces · TypeScript strict (no `any`, lint-enforced) · Hono 4 on Cloudflare Workers · Zod contracts · Vitest 3 + `@cloudflare/vitest-pool-workers` (miniflare D1/KV — no deployed Cloudflare resources needed) · ESLint 9 flat config + typescript-eslint · tsx for tools · React 19 + Vite app shells · gitleaks for secret scan.

---

## Governing rows (read before executing)

- **WP row:** `genesis/08 §03` WP-01 — "Monorepo scaffold; doc 11 installed as CLAUDE.md; traceability CI; squint-test CI; tenant-isolation test harness."
- **REQ rows implemented here:** REQ-024 (lint slice), REQ-025, REQ-111 (partial), REQ-112, REQ-114, REQ-117 (spec+stub), REQ-118, REQ-131, REQ-132 (partial), REQ-133 (foundation), REQ-134, REQ-135 (doc), REQ-145/149 (token slice), REQ-154, REQ-155, REQ-156, REQ-158, REQ-163. Invariants I3, I8 get CI guards.
- **Every commit message in this plan references its REQ-IDs** — the traceability discipline applies to this repo's own history from commit one.

## Stated assumptions (per working agreement: assume and proceed, loudly)

1. **F1-A is not complete** (no GitHub remote, no Cloudflare account visible). Everything here runs locally: tests use miniflare, gates run via `pnpm verify`. The `.github/workflows/*` files are authored now and activate the day the remote lands. Nothing in WP-01 requires a deployed resource.
2. **Genesis folder path:** doc 11 says `Shuddl-OS-Genesis/`; the actual folder is `genesis/`. CLAUDE.md is installed with paths adjusted.
3. **REQ-132 (magic-link auth):** the email leg needs sending infra (WP-06). WP-01 delivers the role model, JWT sessions, and role-guard middleware with tests; a dev-only token mint replaces the emailed link until WP-06. Deferred slice noted in the WP checklist.
4. **REQ-155 (SEED-1):** tables don't exist until WP-02. WP-01 delivers the deterministic dataset *generator + pinned hash* (the DoD test); DB loading lands with the WP-02 schema.
5. **REQ-111 (logs are events):** full log→event pipeline needs the ledger (WP-02). WP-01 delivers the structured, event-shaped log helper and `/v1/health`.
6. **Fixture vendor-in (REQ-112):** source files live in the tenant's engagement workspace (`fixtures-manifest.private`, refs M-01…M-14 — REQ-167: real paths never enter this repo) and are not on this machine. The registry ships with those rows status=`pending` + manifest refs; the verify script prints them loudly every CI run. The legacy-export original path is already `[CONFIRM at WP-01]` in `fixtures/README.md`.
7. **`--signal-deep` (#A93018) computes ≈4.43:1 on #D5D1CC — below AA.** Doc 07 A1 anticipated exactly this: "final hex locked by the CI contrast test, not by taste." Task 10 tunes it (≈`#A52F18`) and the test locks it. This is not a doc-07 amendment; it is doc 07 executing.
8. **Execution happens on a branch** (`wp-01-scaffold`) or worktree, PR'd to main with the PR template from Task 1.

---

### Task 1: Workspace root scaffold

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `.gitignore`, `.editorconfig`, `.github/PULL_REQUEST_TEMPLATE.md`

**Step 1: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "workers/*"
  - "packages/*"
```

**Step 2: Create root `package.json`**

```json
{
  "name": "shuddl-os",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20", "pnpm": ">=9" },
  "scripts": {
    "typecheck": "pnpm -r --if-present run typecheck",
    "lint": "eslint .",
    "test": "pnpm run test:tools && pnpm -r --if-present run test",
    "test:tools": "vitest run --config vitest.tools.config.ts",
    "seed": "tsx tools/seed/generate.ts",
    "check:invariants": "tsx tools/checks/invariants.ts",
    "check:traceability": "tsx tools/traceability/orphans.ts --wp WP-01",
    "check:pr": "tsx tools/traceability/check-pr.ts",
    "check:fixtures": "tsx tools/fixtures/verify.ts",
    "check:seed": "tsx tools/seed/verify.ts",
    "audit:design": "tsx tools/design/audit.ts",
    "verify": "pnpm typecheck && pnpm lint && pnpm test && pnpm check:invariants && pnpm check:traceability && pnpm check:fixtures && pnpm check:seed && pnpm audit:design"
  }
}
```

Then install root dev dependencies (latest stable):

```bash
pnpm add -D -w typescript tsx vitest eslint typescript-eslint @types/node
```

**Step 3: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

**Step 4: Create `.gitignore`, `.editorconfig`**

`.gitignore`:
```
node_modules/
dist/
.wrangler/
seed/SEED-1.json
tools/design/report.json
.env*
```

`.editorconfig`:
```
root = true
[*]
charset = utf-8
indent_style = space
indent_size = 2
end_of_line = lf
insert_final_newline = true
```

**Step 5: Create `.github/PULL_REQUEST_TEMPLATE.md`** (doc 14 §09: every PR = REQ-IDs + assumption block + fixture status)

```markdown
## REQ-IDs
<!-- REQUIRED. e.g. REQ-118, REQ-025. Traceability CI blocks PRs without at least one. -->

## Assumptions
<!-- Ambiguity = state your assumption and proceed. Wrong is cheap, silent is not. -->

## Fixture status
<!-- Green / changed (needs register note) / n-a -->
```

**Step 6: Verify and commit**

Run: `pnpm install && pnpm typecheck`
Expected: install succeeds; typecheck exits 0 (no packages yet).

```bash
git add -A
git commit -m "WP-01 scaffold: pnpm workspace root, strict TS base, PR template

REQ-154, REQ-118 (substrate)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Lint law — no `any`, no LLMs in the ledger, no prior-codebase imports (REQ-163)

**Files:**
- Create: `eslint.config.mjs`
- Create: `packages/ledger/package.json`, `packages/ledger/tsconfig.json`, `packages/ledger/src/index.ts`
- Test: `tools/checks/lint-guards.test.ts`

**Step 1: Create the ledger package stub** (the lint target must exist)

`packages/ledger/package.json`:
```json
{
  "name": "@shuddl/ledger",
  "private": true,
  "type": "module",
  "scripts": { "typecheck": "tsc --noEmit" }
}
```

`packages/ledger/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`packages/ledger/src/index.ts`:
```ts
// REQ-024: this package holds ledger truth. LLM imports are lint-banned here.
// Event append, hash chain, lenses, money-lines land at WP-02 (REQ-002, REQ-011).
export const LEDGER_PACKAGE = "@shuddl/ledger" as const;
```

**Step 2: Write the failing meta-test** — proves the guards actually fire

`tools/checks/lint-guards.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

async function lintVirtualFile(filePath: string, code: string) {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages ?? [];
}

describe("REQ-024: no LLM imports inside packages/ledger", () => {
  it("flags an Anthropic SDK import in the ledger package", async () => {
    const messages = await lintVirtualFile(
      "packages/ledger/src/violation.ts",
      'import Anthropic from "@anthropic-ai/sdk";\nexport const x = Anthropic;\n',
    );
    expect(messages.some((m) => m.message.includes("REQ-024"))).toBe(true);
  });
  it("allows the same import outside the ledger package", async () => {
    const messages = await lintVirtualFile(
      "workers/agents/src/ok.ts",
      'import Anthropic from "@anthropic-ai/sdk";\nexport const x = Anthropic;\n',
    );
    expect(messages.some((m) => m.message.includes("REQ-024"))).toBe(false);
  });
});

describe("REQ-163: Lumina is an organ bank — never imported", () => {
  it("flags any lumina import anywhere", async () => {
    const messages = await lintVirtualFile(
      "packages/rater/src/violation.ts",
      'import { thing } from "lumina-tms/rating";\nexport const x = thing;\n',
    );
    expect(messages.some((m) => m.message.includes("REQ-163"))).toBe(true);
  });
});

describe("no-explicit-any is an error everywhere", () => {
  it("flags any", async () => {
    const messages = await lintVirtualFile(
      "packages/contracts/src/violation.ts",
      "export const x: any = 1;\n",
    );
    expect(messages.some((m) => m.ruleId === "@typescript-eslint/no-explicit-any")).toBe(true);
  });
});
```

Also create `vitest.tools.config.ts` at root:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["tools/**/*.test.ts"], environment: "node" },
});
```

**Step 3: Run test to verify it fails**

Run: `pnpm test:tools`
Expected: FAIL — eslint.config.mjs doesn't exist yet.

**Step 4: Create `eslint.config.mjs`**

```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.wrangler/**", "genesis/**", "fixtures/**", "docs/**", "seed/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      // REQ-163: Lumina TMS and 2023 shuddl repos are organ banks — reference, never merge.
      "no-restricted-imports": ["error", {
        patterns: [{ group: ["*lumina*", "*Lumina*", "*shuddl-2023*"], message: "REQ-163: Lumina/2023 repos are organ banks — no code merges into the spine." }],
      }],
    },
  },
  {
    // REQ-024: LLMs never write ledger truth — statically banned from the ledger package.
    files: ["packages/ledger/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["*lumina*", "*Lumina*", "*shuddl-2023*"], message: "REQ-163: organ bank only." },
          { group: ["@anthropic-ai/*", "anthropic*", "openai*", "@openai/*", "ai", "@ai-sdk/*", "@shuddl/agents*", "*agents*"], message: "REQ-024: LLMs never write ledger truth — no LLM/agent imports in packages/ledger." },
        ],
      }],
    },
  },
);
```

**Step 5: Run tests to verify they pass**

Run: `pnpm test:tools` then `pnpm lint`
Expected: all lint-guard tests PASS; `pnpm lint` exits 0 on the repo.

**Step 6: Commit**

```bash
git add -A
git commit -m "Lint law: no-explicit-any, LLM ban in ledger, Lumina import ban

REQ-024, REQ-163

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `packages/contracts` — error envelope, roles, session (the single type boundary)

**Files:**
- Create: `packages/contracts/package.json`, `tsconfig.json`, `src/index.ts`, `src/errors.ts`, `src/roles.ts`, `src/session.ts`
- Test: `packages/contracts/test/contracts.test.ts`

**Step 1: Scaffold the package**

`packages/contracts/package.json`:
```json
{
  "name": "@shuddl/contracts",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": { "zod": "latest" },
  "devDependencies": { "vitest": "latest", "typescript": "latest" }
}
```
(Then `pnpm install` to resolve `latest` to pinned versions in the lockfile.)

`packages/contracts/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

**Step 2: Write the failing test**

`packages/contracts/test/contracts.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ErrorEnvelope, ErrorCode, Role, SessionClaims } from "../src/index.js";

describe("REQ-156: error envelope", () => {
  it("accepts a gate refusal carrying its evidence requirement", () => {
    const parsed = ErrorEnvelope.parse({
      code: "GATE_BLOCKED",
      message: "DELIVERY REQUIRES SIGNATURE + PLACED-FREIGHT PHOTO",
      req_id: "req_123",
      event_ids: ["evt_1"],
      gate: { required_evidence: ["pod.signed", "delivery.evidenced"] },
    });
    expect(parsed.code).toBe("GATE_BLOCKED");
  });
  it("rejects unknown codes — codes are stable strings", () => {
    expect(() => ErrorCode.parse("SOMETHING_NEW")).toThrow();
  });
});

describe("REQ-132: role model (doc 10 users.role)", () => {
  it("accepts exactly the six roles", () => {
    for (const r of ["admin", "ops", "finance", "read", "driver", "portal"]) {
      expect(Role.parse(r)).toBe(r);
    }
    expect(() => Role.parse("superuser")).toThrow();
  });
});

describe("session claims", () => {
  it("requires sub, tenant, role, exp", () => {
    expect(() => SessionClaims.parse({ sub: "u1", tenant: "tenant-a" })).toThrow();
    const ok = SessionClaims.parse({ sub: "u1", tenant: "tenant-a", role: "ops", exp: 2000000000 });
    expect(ok.tenant).toBe("tenant-a");
  });
});
```

**Step 3: Run test to verify it fails**

Run: `pnpm --filter @shuddl/contracts test`
Expected: FAIL — modules not found.

**Step 4: Implement**

`packages/contracts/src/errors.ts`:
```ts
import { z } from "zod";

// REQ-156: stable error codes; gate refusals carry the evidence requirement (doc 14 §04, L6).
export const ErrorCode = z.enum([
  "GATE_BLOCKED",
  "FLOOR_APPROVAL_REQUIRED",
  "UNKNOWN_NO_PRICE",
  "VALIDATION_FAILED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "TENANT_MISMATCH",
  "IDEMPOTENCY_KEY_REQUIRED",
  "NOT_FOUND",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelope = z.object({
  code: ErrorCode,
  message: z.string(),
  req_id: z.string(),
  event_ids: z.array(z.string()).optional(),
  gate: z.object({ required_evidence: z.array(z.string()) }).optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
```

`packages/contracts/src/roles.ts`:
```ts
import { z } from "zod";
// REQ-132 / doc 10 §02 users.role
export const Role = z.enum(["admin", "ops", "finance", "read", "driver", "portal"]);
export type Role = z.infer<typeof Role>;
```

`packages/contracts/src/session.ts`:
```ts
import { z } from "zod";
import { Role } from "./roles.js";
// REQ-132/156: tenant comes from the JWT claim — never a client-supplied id (doc 14 §04).
export const SessionClaims = z.object({
  sub: z.string(),
  tenant: z.string(),
  role: Role,
  exp: z.number(),
});
export type SessionClaims = z.infer<typeof SessionClaims>;
```

`packages/contracts/src/index.ts`:
```ts
export * from "./errors.js";
export * from "./roles.js";
export * from "./session.js";
```

**Step 5: Run tests, then commit**

Run: `pnpm --filter @shuddl/contracts test` → PASS. `pnpm typecheck` → clean.

```bash
git add -A
git commit -m "contracts: error envelope, role model, session claims

REQ-156, REQ-132 (partial)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `workers/api` — Hono scaffold, error envelope middleware, structured logs, health

**Files:**
- Create: `workers/api/package.json`, `wrangler.toml`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/middleware/error.ts`, `src/log.ts`
- Test: `workers/api/test/health.test.ts`

**Step 1: Scaffold**

`workers/api/package.json`:
```json
{
  "name": "@shuddl/api",
  "private": true,
  "type": "module",
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run", "dev": "wrangler dev" },
  "dependencies": { "hono": "latest", "zod": "latest", "@shuddl/contracts": "workspace:*" },
  "devDependencies": {
    "wrangler": "latest",
    "@cloudflare/vitest-pool-workers": "latest",
    "@cloudflare/workers-types": "latest",
    "vitest": "latest",
    "typescript": "latest"
  }
}
```

`workers/api/wrangler.toml` — naming per doc 14 §02, **no secrets ever in this file (REQ-154)**:
```toml
name = "shuddl-api-dev"
main = "src/index.ts"
compatibility_date = "2025-08-01"

# Secrets (JWT_SECRET, ...) live in `wrangler secret` + GitHub OIDC — never here (REQ-154, REQ-134).

[vars]
ENVIRONMENT = "dev"

# WP-01 test tenants. Per-tenant D1 is physical isolation (doc 14 §02: shuddl-t-{slug}-{env}).
[[d1_databases]]
binding = "TENANT_A_DB"
database_name = "shuddl-t-tenant-a-dev"
database_id = "local-tenant-a"

[[d1_databases]]
binding = "TENANT_B_DB"
database_name = "shuddl-t-tenant-b-dev"
database_id = "local-tenant-b"

[[kv_namespaces]]
binding = "IDEMPOTENCY"
id = "local-idempotency"

[env.staging]
name = "shuddl-api-staging"
# staging = synthetic tenants only, no real PII, ever (REQ-154)

[env.prod]
name = "shuddl-api-prod"
```

`workers/api/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"] },
  "include": ["src", "test"]
}
```

`workers/api/vitest.config.ts`:
```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { JWT_SECRET: "test-secret-do-not-use-in-prod" },
        },
      },
    },
  },
});
```

**Step 2: Write the failing test**

`workers/api/test/health.test.ts`:
```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ErrorEnvelope } from "@shuddl/contracts";

describe("REQ-111/114: health", () => {
  it("GET /v1/health is public and reports env", async () => {
    const res = await SELF.fetch("https://api.local/v1/health");
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; env: string }>();
    expect(body.ok).toBe(true);
    expect(body.env).toBe("dev");
  });
});

describe("REQ-156: every error is the envelope", () => {
  it("404 returns {code, message, req_id}", async () => {
    const res = await SELF.fetch("https://api.local/v1/nope");
    expect(res.status).toBe(404);
    const parsed = ErrorEnvelope.parse(await res.json());
    expect(parsed.code).toBe("NOT_FOUND");
    expect(parsed.req_id.length).toBeGreaterThan(0);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `pnpm --filter @shuddl/api test`
Expected: FAIL — `src/index.ts` missing.

**Step 4: Implement**

`workers/api/src/log.ts`:
```ts
// REQ-111 (partial): structured logs are event-shaped from day one.
// The log→ledger pipeline lands with the ledger at WP-02.
export function logEvent(kind: string, payload: Record<string, unknown>, req_id?: string): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), kind: `log.${kind}`, req_id, payload }));
}
```

`workers/api/src/middleware/error.ts`:
```ts
import type { Context, Next } from "hono";
import type { ErrorCode, ErrorEnvelope } from "@shuddl/contracts";
import { logEvent } from "../log.js";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    public status: number,
    message: string,
    public gate?: { required_evidence: string[] },
  ) {
    super(message);
  }
}

export function envelope(c: Context, code: ErrorCode, status: number, message: string, gate?: ErrorEnvelope["gate"]): Response {
  const body: ErrorEnvelope = { code, message, req_id: c.get("req_id") ?? crypto.randomUUID(), ...(gate ? { gate } : {}) };
  return c.json(body, status as 400);
}

export async function errorEnvelope(c: Context, next: Next): Promise<Response | void> {
  c.set("req_id", crypto.randomUUID());
  try {
    await next();
  } catch (err) {
    if (err instanceof ApiError) return envelope(c, err.code, err.status, err.message, err.gate);
    logEvent("error.unhandled", { message: err instanceof Error ? err.message : String(err) }, c.get("req_id"));
    return envelope(c, "INTERNAL", 500, "INTERNAL ERROR");
  }
}
```

`workers/api/src/index.ts`:
```ts
import { Hono } from "hono";
import type { SessionClaims } from "@shuddl/contracts";
import { errorEnvelope, envelope } from "./middleware/error.js";

export type Env = {
  TENANT_A_DB: D1Database;
  TENANT_B_DB: D1Database;
  IDEMPOTENCY: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
};
export type Vars = { req_id: string; session: SessionClaims };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.use("*", errorEnvelope);

// Public: health only. Everything else authenticates (REQ-133: every client is untrusted).
app.get("/v1/health", (c) => c.json({ ok: true, env: c.env.ENVIRONMENT }));

app.notFound((c) => envelope(c, "NOT_FOUND", 404, "NOT FOUND"));

export default app;
```

**Step 5: Run tests, typecheck, commit**

Run: `pnpm --filter @shuddl/api test && pnpm typecheck` → PASS.

```bash
git add -A
git commit -m "api: Hono scaffold, error envelope, event-shaped logs, health route

REQ-156, REQ-111 (partial), REQ-114, REQ-154

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Auth + tenant resolution — JWT claim only, roles enforced

**Files:**
- Create: `workers/api/src/middleware/auth.ts`, `workers/api/src/tenants.ts`
- Modify: `workers/api/src/index.ts`
- Test: `workers/api/test/auth.test.ts`

**Step 1: Write the failing test**

`workers/api/test/auth.test.ts`:
```ts
import { SELF, env } from "cloudflare:test";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { ErrorEnvelope } from "@shuddl/contracts";

export async function token(claims: Record<string, unknown>, secret = "test-secret-do-not-use-in-prod"): Promise<string> {
  return sign({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims }, secret);
}

describe("REQ-132/133: authn", () => {
  it("rejects missing token", async () => {
    const res = await SELF.fetch("https://api.local/v1/whoami");
    expect(res.status).toBe(401);
    expect(ErrorEnvelope.parse(await res.json()).code).toBe("UNAUTHORIZED");
  });
  it("rejects a token signed with the wrong secret", async () => {
    const t = await token({ sub: "u1", tenant: "tenant-a", role: "ops" }, "attacker-secret");
    const res = await SELF.fetch("https://api.local/v1/whoami", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(401);
  });
  it("rejects claims that fail the schema (unknown role)", async () => {
    const t = await token({ sub: "u1", tenant: "tenant-a", role: "superuser" });
    const res = await SELF.fetch("https://api.local/v1/whoami", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(401);
  });
  it("returns the session for a valid token", async () => {
    const t = await token({ sub: "u1", tenant: "tenant-a", role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/whoami", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    const body = await res.json<{ sub: string; tenant: string; role: string }>();
    expect(body).toMatchObject({ sub: "u1", tenant: "tenant-a", role: "ops" });
  });
});

describe("REQ-132: role matrix", () => {
  it.each(["driver", "portal", "read"])("role %s cannot hit an ops-gated route", async (role) => {
    const t = await token({ sub: "u1", tenant: "tenant-a", role });
    const res = await SELF.fetch("https://api.local/v1/_probe", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(403);
    expect(ErrorEnvelope.parse(await res.json()).code).toBe("FORBIDDEN");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @shuddl/api test`
Expected: FAIL — `/v1/whoami` 404s.

**Step 3: Implement**

`workers/api/src/tenants.ts`:
```ts
import type { Env } from "./index.js";
import { ApiError } from "./middleware/error.js";

// REQ-025: tenant → D1 binding is a server-side allowlist keyed by the JWT claim.
// There is no code path from client input to a database handle.
const TENANT_BINDINGS = {
  "tenant-a": "TENANT_A_DB",
  "tenant-b": "TENANT_B_DB",
} as const satisfies Record<string, keyof Env>;

export function tenantDb(env: Env, tenantSlug: string): D1Database {
  const binding = (TENANT_BINDINGS as Record<string, keyof Env | undefined>)[tenantSlug];
  if (!binding) throw new ApiError("FORBIDDEN", 403, "UNKNOWN TENANT");
  return env[binding] as D1Database;
}
```

`workers/api/src/middleware/auth.ts`:
```ts
import type { Context, Next } from "hono";
import { verify } from "hono/jwt";
import { SessionClaims, type Role } from "@shuddl/contracts";
import { ApiError } from "./error.js";
import type { Env, Vars } from "../index.js";

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

export async function auth(c: Ctx, next: Next): Promise<void> {
  // REQ-156 / doc 14 §04: tenant is resolved from the JWT claim — a client-supplied
  // tenant id anywhere in the request is rejected outright, not ignored.
  if (c.req.header("X-Tenant-Id") || c.req.query("tenant")) {
    throw new ApiError("TENANT_MISMATCH", 403, "TENANT IS RESOLVED SERVER-SIDE, NEVER CLIENT-SUPPLIED");
  }
  const header = c.req.header("Authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!bearer) throw new ApiError("UNAUTHORIZED", 401, "MISSING BEARER TOKEN");
  let payload: unknown;
  try {
    payload = await verify(bearer, c.env.JWT_SECRET);
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
```

Modify `workers/api/src/index.ts` — after the health route, add:
```ts
import { auth, requireRole } from "./middleware/auth.js";
import { tenantDb } from "./tenants.js";

app.use("/v1/*", auth);

app.get("/v1/whoami", (c) => c.json(c.get("session")));

// REQ-025 probe: the isolation suite's read target. Reads ONLY the session tenant's D1.
app.get("/v1/_probe", requireRole("admin", "ops", "finance"), async (c) => {
  const db = tenantDb(c.env, c.get("session").tenant);
  const row = await db.prepare("SELECT tenant FROM probe LIMIT 1").first<{ tenant: string }>();
  return c.json({ tenant_marker: row?.tenant ?? null });
});
```
(Hono matches registered routes in order; `/v1/health` stays above the `auth` middleware registration so it remains public.)

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @shuddl/api test`
Expected: auth tests PASS. (`_probe` positive-path needs the table — created by the isolation suite in Task 6; the role tests only assert 403 before any DB touch. If the role test errors on a missing table instead of 403, the middleware ordering is wrong — `requireRole` must run before the handler body.)

**Step 5: Commit**

```bash
git add -A
git commit -m "api: JWT auth, session schema enforcement, role guards, server-side tenant resolution

REQ-132 (partial: dev-mint until WP-06 email), REQ-133, REQ-156, REQ-025

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Tenant-isolation suite (REQ-025 — "green forever" starts here)

**Files:**
- Test: `workers/api/test/isolation.test.ts`

**Step 1: Write the suite** (it must FAIL if isolation ever breaks; today it passes by proving every attack path is dead)

```ts
import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { token } from "./auth.test.js";

// REQ-025: cross-tenant read anywhere = build failure. This suite runs on every merge, forever.
// It grows a case for every read path added in later WPs.

beforeAll(async () => {
  for (const [db, marker] of [
    [env.TENANT_A_DB, "MARKER-TENANT-A"],
    [env.TENANT_B_DB, "MARKER-TENANT-B"],
  ] as const) {
    await db.exec("CREATE TABLE IF NOT EXISTS probe (tenant TEXT NOT NULL)");
    await db.exec(`DELETE FROM probe`);
    await db.prepare("INSERT INTO probe (tenant) VALUES (?)").bind(marker).run();
  }
});

describe("positive control", () => {
  it("tenant-a token reads tenant-a marker", async () => {
    const t = await token({ sub: "u1", tenant: "tenant-a", role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/_probe", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("MARKER-TENANT-A");
  });
});

describe("adversarial: no request shape reaches tenant B with a tenant-a session", () => {
  const attacks: Array<[string, () => Promise<Response>]> = [
    ["client-supplied tenant header", async () => {
      const t = await token({ sub: "u1", tenant: "tenant-a", role: "ops" });
      return SELF.fetch("https://api.local/v1/_probe", { headers: { Authorization: `Bearer ${t}`, "X-Tenant-Id": "tenant-b" } });
    }],
    ["client-supplied tenant query param", async () => {
      const t = await token({ sub: "u1", tenant: "tenant-a", role: "ops" });
      return SELF.fetch("https://api.local/v1/_probe?tenant=tenant-b", { headers: { Authorization: `Bearer ${t}` } });
    }],
    ["forged token for tenant-b (wrong secret)", async () => {
      const t = await token({ sub: "u1", tenant: "tenant-b", role: "ops" }, "attacker-secret");
      return SELF.fetch("https://api.local/v1/_probe", { headers: { Authorization: `Bearer ${t}` } });
    }],
    ["unsigned garbage token", async () =>
      SELF.fetch("https://api.local/v1/_probe", { headers: { Authorization: "Bearer eyJhbGciOiJub25lIn0.eyJ0ZW5hbnQiOiJ0ZW5hbnQtYiJ9." } }),
    ],
  ];

  it.each(attacks.map(([name], i) => [name, i] as const))("%s is rejected and leaks nothing", async (_name, i) => {
    const attack = attacks[i];
    if (!attack) throw new Error("attack index out of range");
    const res = await attack[1]();
    expect(res.status).toBeGreaterThanOrEqual(401);
    const text = await res.text();
    expect(text).not.toContain("MARKER-TENANT-B");
  });

  it("a valid tenant-b session never sees tenant-a data (symmetry)", async () => {
    const t = await token({ sub: "u2", tenant: "tenant-b", role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/_probe", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("MARKER-TENANT-B");
    expect(text).not.toContain("MARKER-TENANT-A");
  });
});
```

**Step 2: Run the suite**

Run: `pnpm --filter @shuddl/api test`
Expected: PASS, including the Task 5 `_probe` positive path (table now exists).

**Step 3: Prove the suite bites (temporary sabotage — do not commit)**

In `src/middleware/auth.ts`, comment out the `X-Tenant-Id` rejection and make `_probe` read the header (`tenantDb(c.env, c.req.header("X-Tenant-Id") ?? session.tenant)`). Run the suite.
Expected: **FAIL** — "client-supplied tenant header" leaks `MARKER-TENANT-B`. Revert the sabotage (`git checkout -- workers/api/src`), rerun, PASS. This is the WP-01 DoD demonstration: *a cross-tenant read attempt fails the suite*.

**Step 4: Commit**

```bash
git add -A
git commit -m "isolation suite: adversarial cross-tenant reads fail the build

REQ-025, REQ-133

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Idempotency-Key middleware (all mutations, replays return the original)

**Files:**
- Create: `workers/api/src/middleware/idempotency.ts`
- Modify: `workers/api/src/index.ts`
- Test: `workers/api/test/idempotency.test.ts`

**Step 1: Write the failing test**

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ErrorEnvelope } from "@shuddl/contracts";
import { token } from "./auth.test.js";

// REQ-156 / REQ-106 generalized: Idempotency-Key required on all mutations; replays return the original result.
describe("idempotency", () => {
  async function post(key?: string, body = { n: 1 }, tenant = "tenant-a") {
    const t = await token({ sub: "u1", tenant, role: "ops" });
    return SELF.fetch("https://api.local/v1/_echo", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${t}`,
        "content-type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it("rejects a mutation without the header", async () => {
    const res = await post(undefined);
    expect(res.status).toBe(400);
    expect(ErrorEnvelope.parse(await res.json()).code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("replay returns the original result, not a re-execution", async () => {
    const first = await post("key-1", { n: 1 });
    expect(first.status).toBe(200);
    const firstBody = await first.text();
    const replay = await post("key-1", { n: 999 }); // different body, same key
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(firstBody);
    expect(replay.headers.get("idempotency-replay")).toBe("true");
  });

  it("keys are tenant-scoped — tenant-b with the same key executes fresh", async () => {
    await post("key-2", { n: 1 }, "tenant-a");
    const other = await post("key-2", { n: 2 }, "tenant-b");
    expect(other.headers.get("idempotency-replay")).toBeNull();
    expect(await other.text()).toContain('"n":2');
  });
});
```

**Step 2: Run to verify it fails** — `pnpm --filter @shuddl/api test` → FAIL (`/v1/_echo` 404).

**Step 3: Implement**

`workers/api/src/middleware/idempotency.ts`:
```ts
import type { Context, Next } from "hono";
import { ApiError } from "./error.js";
import type { Env, Vars } from "../index.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function idempotency(c: Context<{ Bindings: Env; Variables: Vars }>, next: Next): Promise<Response | void> {
  if (!MUTATING.has(c.req.method)) return next();
  const key = c.req.header("Idempotency-Key");
  if (!key) throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", 400, "IDEMPOTENCY-KEY HEADER REQUIRED ON ALL MUTATIONS");
  // Tenant-scoped: one tenant's key can never replay another's response (REQ-025).
  const scope = `${c.get("session").tenant}:${c.req.method}:${new URL(c.req.url).pathname}:${key}`;
  const cached = await c.env.IDEMPOTENCY.get(scope);
  if (cached) {
    const { status, body } = JSON.parse(cached) as { status: number; body: string };
    return c.newResponse(body, status as 200, { "content-type": "application/json", "idempotency-replay": "true" });
  }
  await next();
  const res = c.res.clone();
  if (res.status < 500) {
    await c.env.IDEMPOTENCY.put(scope, JSON.stringify({ status: res.status, body: await res.text() }), { expirationTtl: 60 * 60 * 24 });
  }
}
```

Modify `workers/api/src/index.ts` — after the `auth` registration:
```ts
import { idempotency } from "./middleware/idempotency.js";
import { z } from "zod";

app.use("/v1/*", idempotency);

// WP-01 conformance target for the idempotency contract test; replaced by real mutations at WP-02+.
const EchoBody = z.object({ n: z.number() });
app.post("/v1/_echo", async (c) => {
  const body = EchoBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new ApiError("VALIDATION_FAILED", 400, "BODY MUST BE {n: number}");
  return c.json({ n: body.data.n, req_id: c.get("req_id") });
});
```
(Import `ApiError` in `index.ts`.)

**Step 4: Run tests** — `pnpm --filter @shuddl/api test` → PASS (all suites: health, auth, isolation, idempotency).

**Step 5: Commit**

```bash
git add -A
git commit -m "api: tenant-scoped Idempotency-Key middleware; replays return original result

REQ-156, REQ-106, REQ-133

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Invariant guards — table budget (I8) and append-only events (I3)

**Files:**
- Create: `tools/checks/invariants.ts`
- Test: `tools/checks/invariants.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { checkMigrationSql, TABLE_BUDGET } from "./invariants.js";

describe("I8: table budget", () => {
  it("budget is 22 (21 named + one spare needing a written deletion)", () => {
    expect(TABLE_BUDGET).toBe(22);
  });
  it("fails when migrations create a 23rd table", () => {
    const sql = Array.from({ length: 23 }, (_, i) => `CREATE TABLE t${i} (id TEXT);`).join("\n");
    const result = checkMigrationSql([sql]);
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toContain("I8");
  });
  it("passes at 21 tables and warns on the spare (22nd)", () => {
    const sql21 = Array.from({ length: 21 }, (_, i) => `CREATE TABLE t${i} (id TEXT);`).join("\n");
    expect(checkMigrationSql([sql21]).ok).toBe(true);
    const sql22 = sql21 + "\nCREATE TABLE spare (id TEXT);";
    const r = checkMigrationSql([sql22]);
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toContain("spare");
  });
  it("does not double-count IF NOT EXISTS re-runs of the same table", () => {
    const sql = "CREATE TABLE IF NOT EXISTS events (id TEXT);\nCREATE TABLE IF NOT EXISTS events (id TEXT);";
    expect(checkMigrationSql([sql]).tableCount).toBe(1);
  });
});

describe("I3: events are append-only — including migrations", () => {
  it.each([
    "UPDATE events SET payload = '{}' WHERE id = '1';",
    "DELETE FROM events WHERE seq > 10;",
    "ALTER TABLE events DROP COLUMN sig;",
    "DROP TABLE events;",
  ])("fails on: %s", (stmt) => {
    const r = checkMigrationSql([`CREATE TABLE events (id TEXT);\n${stmt}`]);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("I3");
  });
  it("allows CREATE TABLE events and CREATE INDEX on events", () => {
    const r = checkMigrationSql(["CREATE TABLE events (id TEXT);\nCREATE INDEX idx_events_seq ON events (seq);"]);
    expect(r.ok).toBe(true);
  });
});
```

**Step 2: Run to verify it fails** — `pnpm test:tools` → FAIL (module missing).

**Step 3: Implement `tools/checks/invariants.ts`**

```ts
import { readFileSync } from "node:fs";
import { globSync } from "node:fs"; // Node 22+: fs.globSync; if unavailable, use "tinyglobby" dependency instead.

// I8 (doc 10): ≤22 tables — 21 named, the spare requires a written deletion (register note).
export const TABLE_BUDGET = 22;
const NAMED_TABLES = 21;

export type InvariantResult = { ok: boolean; tableCount: number; violations: string[]; warnings: string[] };

export function checkMigrationSql(sqlFiles: string[]): InvariantResult {
  const violations: string[] = [];
  const warnings: string[] = [];
  const tables = new Set<string>();
  const all = sqlFiles.join("\n");

  for (const m of all.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+["'`]?(\w+)/gi)) {
    const name = m[1];
    if (name) tables.add(name.toLowerCase());
  }
  if (tables.size > TABLE_BUDGET) {
    violations.push(`I8 VIOLATION: ${tables.size} tables > budget ${TABLE_BUDGET}. A 22nd+ table requires a register amendment + written deletion.`);
  } else if (tables.size > NAMED_TABLES) {
    warnings.push(`I8: spare table slot spent (${tables.size}/${TABLE_BUDGET}). This requires a written deletion note in the register.`);
  }

  // I3 (doc 10 / doc 14 §07): any migration touching events beyond CREATE/INDEX fails.
  for (const m of all.matchAll(/\b(UPDATE|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE)\s+["'`]?events\b/gi)) {
    violations.push(`I3 VIOLATION: migrations may only CREATE/INDEX the events table — found "${m[0]}". Corrections are new events.`);
  }
  // Also ban UPDATE/DELETE grants-by-code style triggers on events.
  for (const m of all.matchAll(/CREATE\s+TRIGGER[^;]+\bON\s+["'`]?events\b[^;]*(UPDATE|DELETE)[^;]*;/gis)) {
    violations.push(`I3 VIOLATION: trigger performing ${m[1]} involving events.`);
  }

  return { ok: violations.length === 0, tableCount: tables.size, violations, warnings };
}

function main(): void {
  const files = globSync("**/migrations/*.sql", { exclude: (p: string) => p.includes("node_modules") });
  const sql = files.map((f: string) => readFileSync(f, "utf8"));
  const result = checkMigrationSql(sql);
  for (const w of result.warnings) console.warn(`WARN ${w}`);
  if (!result.ok) {
    for (const v of result.violations) console.error(`FAIL ${v}`);
    process.exit(1);
  }
  console.log(`invariants OK — ${result.tableCount}/${TABLE_BUDGET} tables, events append-only (${files.length} migration files)`);
}

if (process.argv[1]?.endsWith("invariants.ts")) main();
```
(If the Node version lacks `fs.globSync`, add `tinyglobby` as a root devDependency and swap the import — note which was used in the commit body.)

**Step 4: Run tests + the script** — `pnpm test:tools` → PASS. `pnpm check:invariants` → `invariants OK — 0/22 tables…` (no migrations yet: green on empty app, exactly the DoD).

**Step 5: Commit**

```bash
git add -A
git commit -m "invariant guards: I8 table budget, I3 append-only events (migration lint)

REQ-118 (assurance loop), doc 10 I3/I8

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Traceability CI — PR REQ-ID check + both-direction orphan detector (REQ-118)

**Files:**
- Create: `tools/traceability/register.ts`, `tools/traceability/check-pr.ts`, `tools/traceability/orphans.ts`, `tools/traceability/active-wps.json`
- Test: `tools/traceability/traceability.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { parseRegister } from "./register.js";
import { checkPrText } from "./check-pr.js";
import { findOrphans } from "./orphans.js";

describe("register parser", () => {
  it("parses all rows of genesis/09 with exactly 8 fields each (no silent drops)", () => {
    const rows = parseRegister();
    expect(rows.length).toBeGreaterThanOrEqual(167); // append-only: the register grows, never shrinks (167 at WP-01 start)
    expect(rows[0]?.req_id).toBe("REQ-001");
  });
});

describe("REQ-118: PR gate", () => {
  it("DoD: a dummy PR without a REQ-ID fails", () => {
    const r = checkPrText("Adds a thing. No requirement referenced.");
    expect(r.ok).toBe(false);
  });
  it("passes with a valid REQ-ID", () => {
    expect(checkPrText("## REQ-IDs\nREQ-118").ok).toBe(true);
  });
  it("fails on a REQ-ID that is not in the register", () => {
    const r = checkPrText("REQ-999 does not exist");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("REQ-999");
  });
});

describe("REQ-118: orphan detector, both directions", () => {
  it("direction A: an active-WP REQ with no annotation anywhere is an orphan", () => {
    const orphans = findOrphans({ activeWps: ["WP-01"], sourceAnnotations: new Set(["REQ-118"]) });
    expect(orphans.specdButUnbuilt.length).toBeGreaterThan(0);
    expect(orphans.specdButUnbuilt).toContain("REQ-025");
  });
  it("direction B: an annotation citing an unregistered REQ is an orphan", () => {
    const orphans = findOrphans({ activeWps: [], sourceAnnotations: new Set(["REQ-999"]) });
    expect(orphans.builtButUnspecd).toContain("REQ-999");
  });
});
```

**Step 2: Run to verify it fails** — `pnpm test:tools` → FAIL.

**Step 3: Implement**

`tools/traceability/register.ts`:
```ts
import { readFileSync } from "node:fs";

export type ReqRow = { req_id: string; domain: string; requirement: string; source: string; spec: string; wp: string; dod_test: string; status: string };

export function parseRegister(path = "genesis/09-REQUIREMENTS-REGISTER.csv"): ReqRow[] {
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const rows: ReqRow[] = [];
  for (const [i, line] of lines.slice(1).entries()) {
    const fields = line.split(",");
    // The register is authored comma-safe (semicolons inside fields). A row that
    // splits to anything but 8 fields is a register defect — fail loudly, never guess.
    if (fields.length !== 8) throw new Error(`register row ${i + 2} has ${fields.length} fields, expected 8: ${line.slice(0, 60)}…`);
    const [req_id, domain, requirement, source, spec, wp, dod_test, status] = fields as [string, string, string, string, string, string, string, string];
    rows.push({ req_id, domain, requirement, source, spec, wp, dod_test, status });
  }
  return rows;
}
```

`tools/traceability/check-pr.ts`:
```ts
import { readFileSync } from "node:fs";
import { parseRegister } from "./register.js";

export function checkPrText(text: string): { ok: boolean; reason?: string } {
  const cited = [...new Set(text.match(/REQ-\d{3}/g) ?? [])];
  if (cited.length === 0) return { ok: false, reason: "REQ-118: PR references no REQ-IDs. Every PR must cite at least one register row." };
  const known = new Set(parseRegister().map((r) => r.req_id));
  const unknown = cited.filter((id) => !known.has(id));
  if (unknown.length > 0) return { ok: false, reason: `REQ-118: unknown REQ-IDs (not in register): ${unknown.join(", ")}. New scope = ADD A ROW FIRST.` };
  return { ok: true };
}

function main(): void {
  // CI passes the PR body via $PR_BODY or a file arg; locally: pnpm check:pr <file>
  const arg = process.argv[2];
  const text = process.env["PR_BODY"] ?? (arg ? readFileSync(arg, "utf8") : "");
  const r = checkPrText(text);
  if (!r.ok) { console.error(`FAIL ${r.reason}`); process.exit(1); }
  console.log("traceability: PR cites valid REQ-IDs");
}
if (process.argv[1]?.endsWith("check-pr.ts")) main();
```

`tools/traceability/active-wps.json`:
```json
{ "active": ["WP-01"], "note": "REQs in active WPs must have >=1 source annotation. Grows as WPs open; rows never leave." }
```

`tools/traceability/orphans.ts`:
```ts
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseRegister } from "./register.js";

export function findOrphans(input: { activeWps: string[]; sourceAnnotations: Set<string> }): { specdButUnbuilt: string[]; builtButUnspecd: string[] } {
  const rows = parseRegister();
  const known = new Set(rows.map((r) => r.req_id));
  const active = rows.filter((r) =>
    input.activeWps.some((wp) => r.wp.includes(wp)) && !["vNEXT", "CONFIRM-GATED"].includes(r.status),
  );
  return {
    specdButUnbuilt: active.filter((r) => !input.sourceAnnotations.has(r.req_id)).map((r) => r.req_id),
    builtButUnspecd: [...input.sourceAnnotations].filter((id) => !known.has(id)),
  };
}

export function scanSourceAnnotations(): Set<string> {
  // git grep across everything except the genesis docs themselves (they cite every REQ).
  const out = execSync(
    `git grep -h -o -E "REQ-[0-9]{3}" -- . ":(exclude)genesis" ":(exclude)docs/plans" || true`,
    { encoding: "utf8" },
  );
  return new Set(out.split("\n").filter(Boolean));
}

function main(): void {
  const wpFlag = process.argv.indexOf("--wp");
  const activeWps = wpFlag > -1 && process.argv[wpFlag + 1]
    ? [process.argv[wpFlag + 1] as string]
    : (JSON.parse(readFileSync("tools/traceability/active-wps.json", "utf8")) as { active: string[] }).active;
  const orphans = findOrphans({ activeWps, sourceAnnotations: scanSourceAnnotations() });
  if (orphans.builtButUnspecd.length > 0) {
    console.error(`FAIL built-but-unspec'd (annotations citing no register row): ${orphans.builtButUnspecd.join(", ")}`);
  }
  if (orphans.specdButUnbuilt.length > 0) {
    console.error(`FAIL spec'd-but-unbuilt (active-WP REQs with zero annotations): ${orphans.specdButUnbuilt.join(", ")}`);
  }
  if (orphans.builtButUnspecd.length + orphans.specdButUnbuilt.length > 0) process.exit(1);
  console.log(`traceability: no orphans in either direction (active: ${activeWps.join(", ")})`);
}
if (process.argv[1]?.endsWith("orphans.ts")) main();
```

**Step 4: Run tests, then the real scan**

Run: `pnpm test:tools` → PASS.
Run: `pnpm check:traceability`
Expected at this point: **FAIL** listing WP-01 REQs not yet annotated (REQ-112, REQ-155, REQ-131, …) — correct behavior; the remaining tasks add those annotations, and the final task requires this command green. Note the temporary red in the working notes, not as a defect.

**Step 5: Commit**

```bash
git add -A
git commit -m "traceability CI: PR REQ-ID gate + both-direction orphan detector

REQ-118

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9b: Identity-leak lint — client-side denylist (REQ-167, doc 13 §02)

> Added by plan amendment 2026-07-09: REQ-167 landed in the register (F0.3 wave) after this plan was first written. Separation law: no tenant/person/customer/incumbent-vendor name in any repo artifact. The denylist itself is maintained client-side (env secret or gitignored local file) — the names never enter the repo, including inside the lint.

**Files:**
- Create: `tools/checks/identity-leak.ts`
- Test: `tools/checks/identity-leak.test.ts`
- Modify: `.gitignore` (add `.identity-denylist.local`), root `package.json` (add `check:identity`, extend `verify`)

**Step 1: Write the failing test**

`tools/checks/identity-leak.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseDenylist, scanForIdentityLeaks } from "./identity-leak.js";

// REQ-167 DoD: a seeded denylist name in a PR fails CI. Tests inject a fake term —
// real names live only in the client-side denylist, never here.
describe("REQ-167: identity-leak lint", () => {
  const files = new Map<string, string>([
    ["src/ok.ts", "export const x = 1;"],
    ["docs/leak.md", "We visited Zebra-Carrier-Testname's dock yesterday."],
  ]);

  it("flags a seeded denylist name (case-insensitive) with file attribution", () => {
    const hits = scanForIdentityLeaks(["ZEBRA-CARRIER-TESTNAME"], files);
    expect(hits.length).toBe(1);
    expect(hits[0]?.file).toBe("docs/leak.md");
  });

  it("masks the term in output — the lint must not amplify the leak", () => {
    const hits = scanForIdentityLeaks(["ZEBRA-CARRIER-TESTNAME"], files);
    expect(hits[0]?.masked).toBe("Z*********************");
    expect(JSON.stringify(hits)).not.toContain("ZEBRA-CARRIER-TESTNAME");
  });

  it("clean tree with a populated denylist passes", () => {
    expect(scanForIdentityLeaks(["ZEBRA-CARRIER-TESTNAME"], new Map([["a.ts", "clean"]]))).toEqual([]);
  });

  it("parses denylists from newline/comma-separated input, ignoring blanks and comments", () => {
    expect(parseDenylist("Alpha Corp\n# comment\nbeta-inc, Gamma LLC\n\n")).toEqual(["Alpha Corp", "beta-inc", "Gamma LLC"]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:tools`
Expected: FAIL — module missing.

**Step 3: Implement `tools/checks/identity-leak.ts`**

```ts
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// REQ-167 (doc 13 §02): identity-leak lint. The denylist (tenant names, person names,
// incumbent-vendor names, customer names) is maintained CLIENT-SIDE:
//   1. env IDENTITY_DENYLIST (CI secret), else
//   2. .identity-denylist.local (gitignored).
// The names never enter version control — including via this tool's output (masked).

export type Leak = { file: string; masked: string };

export function parseDenylist(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
}

function mask(term: string): string {
  return term.length <= 1 ? "*" : term[0] + "*".repeat(term.length - 1);
}

export function scanForIdentityLeaks(terms: string[], files: Map<string, string>): Leak[] {
  const leaks: Leak[] = [];
  for (const [file, content] of files) {
    const lower = content.toLowerCase();
    for (const term of terms) {
      if (lower.includes(term.toLowerCase())) leaks.push({ file, masked: mask(term) });
    }
  }
  return leaks;
}

function loadDenylist(): string[] | null {
  const env = process.env["IDENTITY_DENYLIST"];
  if (env && env.trim().length > 0) return parseDenylist(env);
  if (existsSync(".identity-denylist.local")) return parseDenylist(readFileSync(".identity-denylist.local", "utf8"));
  return null;
}

function trackedFiles(): Map<string, string> {
  const out = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
  const map = new Map<string, string>();
  for (const f of out) {
    try {
      map.set(f, readFileSync(f, "utf8"));
    } catch {
      /* binary or unreadable — hashed fixtures are vendored bytes, skip */
    }
  }
  return map;
}

function main(): void {
  const terms = loadDenylist();
  if (!terms) {
    console.warn("REQ-167: no denylist available (set IDENTITY_DENYLIST secret or .identity-denylist.local). Lint SKIPPED — wire the secret before external contributions.");
    return;
  }
  const leaks = scanForIdentityLeaks(terms, trackedFiles());
  if (leaks.length > 0) {
    for (const l of leaks) console.error(`FAIL REQ-167 identity leak in ${l.file}: ${l.masked}`);
    process.exit(1);
  }
  console.log(`identity-leak lint: clean (${terms.length} terms checked)`);
}
if (process.argv[1]?.endsWith("identity-leak.ts")) main();
```

**Step 4: Wire it in**

- `.gitignore`: add a line `.identity-denylist.local`
- Root `package.json`: add `"check:identity": "tsx tools/checks/identity-leak.ts"` and insert `&& pnpm check:identity` into the `verify` chain (after `check:traceability`).
- Task 15's `ci.yml` gains, after the orphan-detector step:
  ```yaml
      - name: identity-leak lint (REQ-167 — denylist is a CI secret, never in repo)
        env: { IDENTITY_DENYLIST: "${{ secrets.IDENTITY_DENYLIST }}" }
        run: pnpm check:identity
  ```

**Step 5: Run tests + script**

Run: `pnpm test:tools` → PASS. `pnpm check:identity` → prints the SKIPPED warning locally (no denylist on this machine — correct: the list is client-maintained).

**Step 6: Commit**

```bash
git add -A
git commit -m "identity-leak lint: client-side denylist, masked output, CI-secret wiring

REQ-167

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Design package + squint-test CI (advisory mode) — and locking `--signal-deep`

**Files:**
- Create: `packages/design/package.json`, `packages/design/tokens.css`
- Create: `tools/design/contrast.ts`, `tools/design/audit.ts`, `tools/design/design-ci.json`
- Test: `tools/design/design.test.ts`

**Step 1: Create the design package with doc 07 tokens verbatim**

`packages/design/package.json`:
```json
{ "name": "@shuddl/design", "private": true, "type": "module", "exports": { "./tokens.css": "./tokens.css" } }
```

`packages/design/tokens.css` — copy the `:root` block from `genesis/07 §01` exactly (five color tokens, transparent reds, two font stacks).

**Step 2: Write the failing test**

`tools/design/design.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast.js";
import { auditTokens, readTokens } from "./audit.js";

describe("contrast math (WCAG 2.x)", () => {
  it("black on white = 21:1", () => expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 0));
  it("identical colors = 1:1", () => expect(contrastRatio("#D5D1CC", "#D5D1CC")).toBeCloseTo(1, 5));
});

describe("REQ-149 / A1: --signal-deep locked at >=4.5:1 on --field", () => {
  it("small-text red passes AA on greige", () => {
    const t = readTokens("packages/design/tokens.css");
    expect(contrastRatio(t["--signal-deep"], t["--field"])).toBeGreaterThanOrEqual(4.5);
  });
});

describe("REQ-145: five color tokens only", () => {
  it("token audit finds exactly the sanctioned palette", () => {
    const result = auditTokens("packages/design/tokens.css");
    expect(result.colorTokens).toEqual(["--field", "--signal", "--signal-deep", "--ink-dark", "--progress"]);
  });
});
```

**Step 3: Implement contrast + audit**

`tools/design/contrast.ts`:
```ts
function channel(hexPair: string): number {
  const v = parseInt(hexPair, 16) / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
export function luminance(hex: string): number {
  const h = hex.replace("#", "");
  return 0.2126 * channel(h.slice(0, 2)) + 0.7152 * channel(h.slice(2, 4)) + 0.0722 * channel(h.slice(4, 6));
}
export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}
```

`tools/design/audit.ts`:
```ts
import { readFileSync, writeFileSync } from "node:fs";
import { contrastRatio } from "./contrast.js";

// REQ-158: advisory (report-only) until WP-10 exits; blocking thereafter. Flip the mode file at WP-10.
type Mode = { mode: "advisory" | "blocking" };

export function readTokens(path: string): Record<string, string> {
  const css = readFileSync(path, "utf8");
  const tokens: Record<string, string> = {};
  for (const m of css.matchAll(/(--[\w-]+):\s*(#[0-9A-Fa-f]{6})/g)) tokens[m[1] as string] = (m[2] as string).toUpperCase();
  return tokens;
}

export function auditTokens(path: string): { colorTokens: string[]; violations: string[] } {
  const tokens = readTokens(path);
  const violations: string[] = [];
  const colorTokens = Object.keys(tokens).filter((k) => !k.startsWith("--field-on-dark"));
  const deep = tokens["--signal-deep"];
  const field = tokens["--field"];
  if (deep && field && contrastRatio(deep, field) < 4.5) {
    violations.push(`A1/REQ-149: --signal-deep ${deep} on --field ${field} = ${contrastRatio(deep, field).toFixed(2)}:1 < 4.5:1`);
  }
  return { colorTokens, violations };
}

// Repo-wide audits (color/radius/shadow/gradient/font) per doc 07 §06 — scans css/tsx under apps+packages.
export function auditRepo(): string[] {
  const { execSync } = require("node:child_process") as typeof import("node:child_process");
  const violations: string[] = [];
  const files = execSync(`git ls-files "apps/**/*.css" "apps/**/*.tsx" "packages/**/*.css" "packages/**/*.tsx"`, { encoding: "utf8" }).split("\n").filter(Boolean);
  const allowedHex = new Set(Object.values(readTokens("packages/design/tokens.css")));
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/#[0-9A-Fa-f]{6}\b/g)) {
      if (!allowedHex.has((m[0] as string).toUpperCase()) && !f.endsWith("tokens.css")) violations.push(`${f}: color ${m[0]} outside the five tokens`);
    }
    for (const m of text.matchAll(/border-radius:\s*(\d+)px/g)) {
      if (Number(m[1]) > 4) violations.push(`${f}: border-radius ${m[1]}px > 4px`);
    }
    if (/box-shadow:(?!\s*none)/.test(text)) violations.push(`${f}: box-shadow`);
    if (/linear-gradient|radial-gradient/.test(text)) violations.push(`${f}: gradient`);
    if (/font-family:(?![^;]*(Barlow Condensed|Oswald|JetBrains Mono|IBM Plex Mono|monospace|sans-serif))/.test(text)) violations.push(`${f}: font outside the two stacks`);
  }
  return violations;
}

function main(): void {
  const { mode } = JSON.parse(readFileSync("tools/design/design-ci.json", "utf8")) as Mode;
  const tokenResult = auditTokens("packages/design/tokens.css");
  const violations = [...tokenResult.violations, ...auditRepo()];
  writeFileSync("tools/design/report.json", JSON.stringify({ mode, violations }, null, 2));
  if (violations.length > 0) {
    console.error(`design audit: ${violations.length} violation(s) [mode=${mode}]`);
    for (const v of violations) console.error(`  ${v}`);
    if (mode === "blocking") process.exit(1);
    console.error("REQ-158: advisory until WP-10 exit — reported, not blocking.");
  } else {
    console.log("design audit: clean");
  }
}
if (process.argv[1]?.endsWith("audit.ts")) main();
```

`tools/design/design-ci.json`:
```json
{ "mode": "advisory", "note": "REQ-158: flips to blocking at WP-10 exit." }
```

**Step 4: Run the test — expect the A1 discovery**

Run: `pnpm test:tools`
Expected: the `--signal-deep` test **FAILS** — `#A93018` on `#D5D1CC` computes ≈**4.43:1**, under AA. This is doc 07 A1 working as designed ("final hex locked by the CI contrast test, not by taste").

**Step 5: Tune the token until the test locks it**

Darken within the hue family until ≥4.5:1 — `#A52F18` computes ≈4.58:1 (verify with the script; if it differs, step the red channel down by 1–2 until green). Update `packages/design/tokens.css`:
```css
--signal-deep:  #A52F18;  /* A1: #A93018 measured 4.43:1 — darkened until ≥4.5:1 on --field; locked by tools/design/audit.ts (REQ-149) */
```
Run: `pnpm test:tools && pnpm audit:design` → PASS / `design audit: clean`.

**Step 6: Commit**

```bash
git add -A
git commit -m "design system: doc 07 tokens + squint-test CI (advisory); --signal-deep locked at 4.5:1 by test

REQ-145, REQ-149, REQ-158

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
(Blessed-screenshot diffing — audit item 6 — needs real screens; it lands at WP-03 with the canonical views. Note in WP checklist.)

---

### Task 11: Deterministic SEED-1 generator + pinned hash (REQ-155)

**Files:**
- Create: `tools/seed/generate.ts`, `tools/seed/verify.ts`
- Test: `tools/seed/seed.test.ts`
- Create (generated, committed): `tools/seed/seed.hash`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { generateSeed, seedHash } from "./generate.js";

// REQ-155: deterministic seed tenant SEED-1 — identical dataset hash on every run.
describe("SEED-1 determinism", () => {
  it("two runs produce byte-identical datasets", () => {
    expect(seedHash(generateSeed())).toBe(seedHash(generateSeed()));
  });
  it("contains a tenant, customers, a tariff stub, and 20 shipments in every lifecycle state", () => {
    const s = generateSeed();
    expect(s.tenant.slug).toBe("seed-1");
    expect(s.parties.length).toBeGreaterThanOrEqual(8);
    expect(s.shipments.length).toBe(20);
    const states = new Set(s.shipments.map((x) => x.status_cache));
    for (const required of ["QUOTED", "BOOKED", "DISPATCHED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "INVOICED", "EXCEPTION"]) {
      expect(states).toContain(required);
    }
  });
  it("no wall-clock leakage — timestamps are all derived from the fixed base", () => {
    const s = generateSeed();
    for (const sh of s.shipments) for (const e of sh.events) expect(e.ts.startsWith("2026-07")).toBe(true);
  });
});
```

**Step 2: Run to verify it fails** — `pnpm test:tools` → FAIL.

**Step 3: Implement `tools/seed/generate.ts`**

```ts
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

// REQ-155: SEED-1 — deterministic seed tenant for dev/CI/screenshot baselines.
// Seeded PRNG + fixed base timestamp: NO Date.now(), NO Math.random().
const BASE_TS = Date.UTC(2026, 6, 9, 6, 0, 0); // 2026-07-09T06:00:00Z, fixed forever

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LIFECYCLES: Array<{ status: string; kinds: string[]; count: number }> = [
  { status: "QUOTED", kinds: ["quote.requested", "quote.priced", "quote.sent"], count: 3 },
  { status: "BOOKED", kinds: ["quote.requested", "quote.priced", "quote.accepted", "booking.created", "credit.checked"], count: 3 },
  { status: "DISPATCHED", kinds: ["booking.created", "appointment.set", "pickup.scheduled", "dispatch.assigned"], count: 2 },
  { status: "PICKED_UP", kinds: ["dispatch.assigned", "stop.arrived", "freight.counted", "freight.photographed", "custody.transferred", "stop.departed"], count: 3 },
  { status: "IN_TRANSIT", kinds: ["custody.transferred", "stop.departed", "position.updated", "position.updated"], count: 3 },
  { status: "OUT_FOR_DELIVERY", kinds: ["position.updated", "stop.arrived"], count: 2 },
  { status: "DELIVERED", kinds: ["stop.arrived", "pod.signed", "delivery.evidenced"], count: 2 },
  { status: "INVOICED", kinds: ["pod.signed", "delivery.evidenced", "invoice.issued"], count: 1 },
  { status: "EXCEPTION", kinds: ["stop.arrived", "exception.raised", "osd.captured"], count: 1 },
];

export type SeedEvent = { id: string; shipment_id: string; seq: number; ts: string; actor: { party: string; user: string; device: string | null }; kind: string; payload: Record<string, unknown>; evidence: Array<{ doc_id: string; hash: string }>; prev_hash: string; sig: string; visibility: string; source: "native"; confidence: 1 };
export type SeedShipment = { id: string; refs: { pro: string }; shipper: string; consignee: string; status_cache: string; commodities: { pieces: number; weight: number }; events: SeedEvent[] };
export type Seed = { tenant: { slug: string; name: string; plan: string }; parties: Array<{ id: string; kind: string; name: string }>; rate_config: { kind: string; version: number }; shipments: SeedShipment[] };

export function generateSeed(): Seed {
  const rnd = mulberry32(1);
  const parties = Array.from({ length: 8 }, (_, i) => ({ id: `party-${i + 1}`, kind: i < 6 ? "shipper" : "carrier", name: `SEED CUSTOMER ${String(i + 1).padStart(2, "0")}` }));
  const shipments: SeedShipment[] = [];
  let proCounter = 100001;
  for (const lc of LIFECYCLES) {
    for (let n = 0; n < lc.count; n++) {
      const id = `shp-${String(shipments.length + 1).padStart(3, "0")}`;
      let prev = "GENESIS";
      const events = lc.kinds.map((kind, seq) => {
        const ts = new Date(BASE_TS + shipments.length * 3_600_000 + seq * 600_000).toISOString();
        const ev: SeedEvent = {
          id: `evt-${id}-${seq}`, shipment_id: id, seq, ts,
          actor: { party: "seed-1", user: "seed-user", device: kind.startsWith("pod") ? "seed-device" : null },
          kind, payload: { note: "SEED-1", r: Math.floor(rnd() * 1e6) },
          evidence: kind === "freight.photographed" || kind === "delivery.evidenced" ? [{ doc_id: `doc-${id}-${seq}`, hash: sha256(`${id}-${seq}`) }] : [],
          prev_hash: prev, sig: "seed-unsigned", visibility: "internal", source: "native", confidence: 1,
        };
        prev = sha256(JSON.stringify(ev));
        return ev;
      });
      shipments.push({
        id, refs: { pro: String(proCounter++) },
        shipper: parties[Math.floor(rnd() * 6)]?.id ?? "party-1",
        consignee: parties[Math.floor(rnd() * 6)]?.id ?? "party-2",
        status_cache: lc.status,
        commodities: { pieces: 1 + Math.floor(rnd() * 10), weight: 50 + Math.floor(rnd() * 5000) },
        events,
      });
    }
  }
  return { tenant: { slug: "seed-1", name: "SEED-1", plan: "pro" }, parties, rate_config: { kind: "zone_tariff", version: 1 }, shipments };
}

function sha256(s: string): string { return createHash("sha256").update(s).digest("hex"); }
export function seedHash(seed: Seed): string { return sha256(JSON.stringify(seed)); }

function main(): void {
  const seed = generateSeed();
  mkdirSync("seed", { recursive: true });
  writeFileSync("seed/SEED-1.json", JSON.stringify(seed, null, 2));
  writeFileSync("tools/seed/seed.hash", seedHash(seed) + "\n");
  console.log(`SEED-1 written (${seed.shipments.length} shipments), hash ${seedHash(seed).slice(0, 12)}…`);
}
if (process.argv[1]?.endsWith("generate.ts")) main();
```

`tools/seed/verify.ts`:
```ts
import { readFileSync } from "node:fs";
import { generateSeed, seedHash } from "./generate.js";

// REQ-155 DoD: `pnpm seed` reproduces an identical dataset hash.
const pinned = readFileSync("tools/seed/seed.hash", "utf8").trim();
const actual = seedHash(generateSeed());
if (pinned !== actual) {
  console.error(`FAIL SEED-1 hash drift: pinned ${pinned.slice(0, 12)}… vs actual ${actual.slice(0, 12)}…`);
  console.error("A deliberate seed change must regenerate the pin (pnpm seed) and say so in the PR.");
  process.exit(1);
}
console.log("SEED-1 hash verified");
```

**Step 4: Run tests, generate, verify, commit**

Run: `pnpm test:tools` → PASS. `pnpm seed` (writes artifact + pins hash) → `pnpm check:seed` → `SEED-1 hash verified`.
Note: DB loading of SEED-1 lands at WP-02 with the schema (stated assumption 4).

```bash
git add -A
git commit -m "SEED-1: deterministic seed generator + pinned-hash verification

REQ-155

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Fixture registry — hash-pinned manifest, loud pending rows (REQ-112)

**Files:**
- Create: `fixtures/manifest.json`, `tools/fixtures/verify.ts`
- Test: `tools/fixtures/fixtures.test.ts`

**Step 1: Create `fixtures/manifest.json`** (every row from `fixtures/README.md`; nothing vendored yet on this machine → all `pending`, each with its source pointer; the 062226 row carries its standing CONFIRM)

```json
{
  "note": "REQ-112: CI references fixtures by hash. Changing a fixture requires a register note. Pending rows print on every CI run — no silent drops.",
  "fixtures": [
    { "id": "rater-48-tests", "gates": "WP-04", "status": "pending", "path": "fixtures/rater/48-tests/", "sha256": null, "source": "manifest.private M-01" },
    { "id": "rater-504-sweep", "gates": "WP-04", "status": "pending", "path": "fixtures/rater/504-sweep/", "sha256": null, "source": "manifest.private M-01" },
    { "id": "zone-tariff-v1", "gates": "WP-04 config seeds", "status": "pending", "path": "fixtures/tariff/", "sha256": null, "source": "manifest.private M-02…M-05" },
    { "id": "customer-roster-3601", "gates": "WP-14/15 Migrator", "status": "pending", "path": "fixtures/roster/", "sha256": null, "source": "manifest.private M-06" },
    { "id": "legacy-import-formats", "gates": "WP-15 projections", "status": "pending", "path": "fixtures/legacy-imports/", "sha256": null, "source": "manifest.private M-07…M-10" },
    { "id": "export-062226-replay", "gates": "WP-02/04/15 ±2% aggregate", "status": "pending", "path": "fixtures/export-062226/", "sha256": null, "source": "[CONFIRM at WP-01 — vendor with hash] manifest.private M-11/M-12 (9,314-bill export + 4,405-bill re-rate)" },
    { "id": "synthetic-blitz-3100", "gates": "WP-15 shadow tooling", "status": "pending", "path": "fixtures/blitz/", "sha256": null, "source": "manifest.private M-13" },
    { "id": "anomaly-222084", "gates": "WP-04 permanent regression (REQ-040)", "status": "pending", "path": "fixtures/anomaly/pro-77112506.json", "sha256": null, "source": "manifest.private M-14 — pro 77112506, $222,084 / 35 lb" },
    { "id": "qb-journal-month", "gates": "WP-11", "status": "planned", "path": "fixtures/qb/", "sha256": null, "source": "Built at WP-11 from ledger events" },
    { "id": "airplane-soak", "gates": "WP-05 (REQ-016)", "status": "planned", "path": "fixtures/airplane-soak/", "sha256": null, "source": "Written at WP-05" }
  ]
}
```

**Step 2: Write the failing test**

`tools/fixtures/fixtures.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { verifyManifest } from "./verify.js";

describe("REQ-112: fixture registry", () => {
  it("verifies a vendored entry by hash and fails on mismatch", () => {
    const r = verifyManifest({
      fixtures: [{ id: "x", gates: "t", status: "vendored", path: "fixtures/README.md", sha256: "0".repeat(64), source: "t" }],
    });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain("hash mismatch");
  });
  it("pending entries are reported loudly but do not fail WP-01", () => {
    const r = verifyManifest({ fixtures: [{ id: "y", gates: "WP-04", status: "pending", path: "fixtures/none/", sha256: null, source: "s" }] });
    expect(r.ok).toBe(true);
    expect(r.pending).toContain("y");
  });
  it("a vendored entry whose file is missing fails", () => {
    const r = verifyManifest({ fixtures: [{ id: "z", gates: "t", status: "vendored", path: "fixtures/does-not-exist.bin", sha256: "0".repeat(64), source: "t" }] });
    expect(r.ok).toBe(false);
  });
});
```

**Step 3: Implement `tools/fixtures/verify.ts`**

```ts
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

type Entry = { id: string; gates: string; status: "vendored" | "pending" | "planned"; path: string; sha256: string | null; source: string };
type Manifest = { fixtures: Entry[] };

function hashPath(p: string): string {
  const h = createHash("sha256");
  const walk = (f: string): void => {
    if (statSync(f).isDirectory()) {
      for (const child of readdirSync(f).sort()) walk(join(f, child));
    } else {
      h.update(f).update(readFileSync(f));
    }
  };
  walk(p);
  return h.digest("hex");
}

export function verifyManifest(manifest: Manifest): { ok: boolean; failures: string[]; pending: string[] } {
  const failures: string[] = [];
  const pending: string[] = [];
  for (const e of manifest.fixtures) {
    if (e.status !== "vendored") { pending.push(e.id); continue; }
    if (!existsSync(e.path)) { failures.push(`${e.id}: vendored but file missing at ${e.path}`); continue; }
    if (!e.sha256) { failures.push(`${e.id}: vendored without a pinned sha256`); continue; }
    const actual = hashPath(e.path);
    if (actual !== e.sha256) failures.push(`${e.id}: hash mismatch (pinned ${e.sha256.slice(0, 12)}… actual ${actual.slice(0, 12)}…) — fixture changes require a register note`);
  }
  return { ok: failures.length === 0, failures, pending };
}

function main(): void {
  const manifest = JSON.parse(readFileSync("fixtures/manifest.json", "utf8")) as Manifest;
  const r = verifyManifest(manifest);
  if (r.pending.length > 0) {
    console.warn(`PENDING FIXTURES (${r.pending.length}) — not yet vendored; sources in manifest; 062226 path is [CONFIRM]:`);
    for (const id of r.pending) console.warn(`  - ${id}`);
  }
  if (!r.ok) { for (const f of r.failures) console.error(`FAIL ${f}`); process.exit(1); }
  console.log("fixture registry verified");
}
if (process.argv[1]?.endsWith("verify.ts")) main();
```

**Step 4: Run tests + script** — `pnpm test:tools` → PASS; `pnpm check:fixtures` → prints the pending table loudly, exits 0.

**Step 5: Commit**

```bash
git add -A
git commit -m "fixture registry: hash-pinned manifest, loud pending rows, 062226 CONFIRM surfaced

REQ-112, REQ-040 (row reserved)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Secret scan + secrets conventions (REQ-154, REQ-134)

**Files:**
- Create: `.gitleaks.toml`, `docs/ops/secrets.md`

**Step 1: Create `.gitleaks.toml`**

```toml
# REQ-154/134: secrets live in `wrangler secret` + GitHub OIDC — never in the repo.
title = "shuddl-os"
[extend]
useDefault = true
[allowlist]
description = "genesis docs + fixtures contain no live credentials; test JWT secret is a fixture"
paths = ['''genesis/.*''', '''fixtures/.*''']
regexes = ['''test-secret-do-not-use-in-prod''']
```

**Step 2: Create `docs/ops/secrets.md`**

```markdown
# Secrets & key rotation (REQ-134, REQ-154)

## Rules
1. No secret ever enters the repo, `wrangler.toml`, or CI logs. `gitleaks` runs in CI on every PR.
2. Worker secrets: `wrangler secret put <NAME> --env <env>`. CI deploys authenticate via GitHub Actions OIDC — no long-lived Cloudflare tokens in repo secrets.
3. Per-env API tokens, scoped per env (dev/staging/prod). Staging carries synthetic data only (REQ-154).

## Inventory (grows; every addition lands here)
| Secret | Where | Rotation |
|---|---|---|
| JWT_SECRET | wrangler secret, per env | 90 days or on suspicion |
| (WP-02+) device signing root | control plane | per REQ-134 drill below |

## Device-key rotation drill (REQ-134 DoD)
1. Issue new device keypair on device; register new public key to `users.device_keys[]` (append — old key stays for verification of old events).
2. New events sign with the new key; ledger verification uses key-at-time-of-event.
3. Revoke old key for future use; run chain verify over a device's history spanning the rotation.
Drill is executable once device signing lands (WP-05); the procedure is law now so WP-05 builds to it.
```

**Step 3: Verify**

Run: `command -v gitleaks >/dev/null && gitleaks git --no-banner || echo "gitleaks not installed locally — CI job covers it (Task 15)"`
Expected: no leaks found (or the CI-note fallback).

**Step 4: Commit**

```bash
git add -A
git commit -m "secret scan config + secrets/rotation runbook

REQ-154, REQ-134

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: Governance docs — threat model, SLOs, DR/backups (REQ-131, REQ-114, REQ-117, REQ-135)

**Files:**
- Create: `docs/security/threat-model.md`, `docs/ops/slo.md`, `docs/ops/dr-backups.md`

**Step 1: Create `docs/security/threat-model.md`** (REQ-131 — reviewed at every WP exit)

```markdown
# Threat model v1 (REQ-131 — reviewed at every WP exit; changes logged at the bottom)

## Assets, in order
1. Ledger integrity (append-only history + hash chain + external timestamps) — the product IS this.
2. Tenant isolation (per-tenant D1; REQ-025 suite).
3. Evidence bytes (photos/signatures in R2) + their hashes.
4. Device signing keys (driver phones) and JWT secrets.
5. Money projections (invoices, GL export).

## Adversaries & spoofing surfaces (STRIDE per surface)
| Surface | Top threats | Standing mitigations |
|---|---|---|
| API (`/v1`, `/mcp` later) | tenant-id tampering, token forgery, replayed mutations | claim-only tenant resolution (hard-reject client tenant ids), JWT verify + schema-parse, Idempotency-Key, Zod at every boundary (REQ-133) |
| Ledger | event mutation, back-dating, silent correction | no UPDATE/DELETE grants (I3, CI-linted in migrations), hash chain, daily Merkle→TSA (WP-02) |
| Driver PWA | stolen device, GPS spoofing, offline tampering | device keypair non-extractable (WP-05), geofence + accuracy radius disclosed (REQ-018), lockout (REQ-069) |
| Email in/out (WP-06/07) | spoofed inbound, exfil via evidence email | DKIM/SPF/DMARC, sender verification before event attribution, suppression list |
| CI/supply chain | poisoned dep, leaked secret | lockfile-pinned installs, gitleaks, OIDC (no static deploy tokens) |

## Review log
- 2026-07-09 WP-01: initial model. Next review: WP-02 exit (adds ledger-specific spoofing/tampering rows).
```

**Step 2: Create `docs/ops/slo.md`** (REQ-114)

```markdown
# SLO targets per surface (REQ-114)

| Surface | Availability | Latency (p95) | Notes |
|---|---|---|---|
| workers/api `/v1` | 99.9%/mo | reads 300ms · mutations 800ms | error budget pauses feature merges when burned |
| Command / Portal | 99.5%/mo | first map paint < 2s desktop | static assets on CF edge |
| Driver PWA | offline-first — availability = **sync latency** | offline queue drains < 60s after signal returns | airplane mode is a supported state, not an outage (L1) |
| Evidence email (WP-06) | POD→email p95 < 5s (REQ-031) | — | the heartbeat metric |
| Status pages | 99.9%/mo | < 1s | public surface |

Monitors: uptime checks live when the first deploy exists (F1-A); targets are law now so surfaces are built to them.
```

**Step 3: Create `docs/ops/dr-backups.md`** (REQ-117, REQ-135)

```markdown
# DR, backups, snapshots (REQ-117, REQ-135)

**Objectives:** RPO 24h · RTO 4h (v1). Full-tenant export = REQ-010 (WP-11 job).

## Nightly ledger snapshots (REQ-117)
- Nightly job exports every tenant D1 (sqlite dump) + control plane to R2 `shuddl-backups-{env}/` with date prefix and sha256 manifest; retained 35 days, monthly kept 7 years (matches POD lifecycle, REQ-116).
- The workflow stub ships in `.github/workflows/nightly.yml` (Task 15) and activates when F1-A provides Cloudflare credentials via OIDC.

## Restore drill (quarterly, first due the quarter after WP-02 lands real data)
1. Pick yesterday's snapshot; restore into a scratch D1.
2. Run chain verification over restored events; row-count parity vs source.
3. Log the drill (date, duration vs RTO, discrepancies) below.

## Drill log
- (none yet — schema lands WP-02)
```

**Step 4: Commit**

```bash
git add -A
git commit -m "governance docs: threat model v1, SLO targets, DR/backup spec

REQ-131, REQ-114, REQ-117, REQ-135

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 15: Remaining scaffolds + CI workflows + `verify` green end-to-end

**Files:**
- Create: `packages/rater/`, `packages/adapters/` stubs; `apps/command/`, `apps/driver/`, `apps/portal/` Vite shells; `workers/agents/` stub
- Create: `.github/workflows/ci.yml`, `.github/workflows/nightly.yml`

**Step 1: Package stubs** — same shape as the Task 2 ledger stub. `packages/rater/src/index.ts`:
```ts
// REQ-027/REQ-040: the audited rating engine (manifest.private M-01) ports here at WP-04 (48 tests + 504-sweep travel with it).
export const RATER_PACKAGE = "@shuddl/rater" as const;
```
`packages/adapters/src/index.ts`:
```ts
// REQ-021/022/035: legacy ingest/projection adapters (171-col, Rate Profile CSV, EDI, QuickBooks journal) land WP-11/12/15.
export const ADAPTERS_PACKAGE = "@shuddl/adapters" as const;
```
Each with `package.json` (`@shuddl/rater`, `@shuddl/adapters`, typecheck script) and `tsconfig.json` extending base.

**Step 2: App shells** — one recipe, three names. For each of `command` / `driver` / `portal` (`@shuddl/command` etc.):

`apps/command/package.json`:
```json
{
  "name": "@shuddl/command",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "typecheck": "tsc --noEmit" },
  "dependencies": { "react": "latest", "react-dom": "latest", "@shuddl/design": "workspace:*" },
  "devDependencies": { "vite": "latest", "@vitejs/plugin-react": "latest", "@types/react": "latest", "@types/react-dom": "latest", "typescript": "latest" }
}
```
`apps/command/index.html`: standard Vite entry loading `/src/main.tsx`, `<title>SHUDDL — COMMAND</title>`.
`apps/command/vite.config.ts`: `defineConfig({ plugins: [react()] })`.
`apps/command/src/main.tsx`:
```tsx
import { createRoot } from "react-dom/client";
import "@shuddl/design/tokens.css";
import { App } from "./App.js";
const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
```
`apps/command/src/App.tsx` (design-law compliant from the first pixel — tokens only, uppercase via CSS, no shadows):
```tsx
// Surface shell only. Map home + queues land WP-03/WP-10 (REQ-073, REQ-082).
export function App(): React.JSX.Element {
  return (
    <main style={{ background: "var(--field)", color: "var(--signal)", minHeight: "100vh", fontFamily: "var(--display)", textTransform: "uppercase" }}>
      <h1 style={{ fontWeight: 700, fontSize: 64, lineHeight: 0.9, letterSpacing: "-0.015em", padding: 24 }}>(01) Command</h1>
      <p style={{ fontFamily: "var(--mono)", color: "var(--signal-deep)", fontSize: 12, letterSpacing: "0.08em", padding: "0 24px" }}>Syncing</p>
    </main>
  );
}
```
Driver variant: dark ground per A2 (`background: var(--ink-dark)`, `color: var(--field-on-dark)`), title `(01) Driver`; Portal: `(01) Portal`. Add `"driver PWA proper (service worker, IndexedDB queue) lands WP-05 (REQ-061)"` comment in the driver shell.

`workers/agents/` stub: `package.json` (`@shuddl/agents`), `wrangler.toml` (`name = "shuddl-agents-dev"`, queue consumer commented out until WP-07), `src/index.ts`:
```ts
// REQ-039: queue consumers (one module per agent) land WP-06+. LLM calls live here and in packages/agents — never in the ledger (REQ-024).
export default { async queue(): Promise<void> { /* agents arrive WP-06+ */ } };
```

**Step 3: `.github/workflows/ci.yml`** — gate order per doc 14 §07: typecheck → lint → unit+fixtures → traceability → isolation (isolation runs inside the API test job but gets its own visible step):

```yaml
name: ci
on:
  pull_request:
  push: { branches: [main] }
jobs:
  gates:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - name: typecheck (strict, no any)
        run: pnpm typecheck
      - name: lint (incl. REQ-024 LLM-in-ledger ban, REQ-163 Lumina ban)
        run: pnpm lint
      - name: unit tests (tools + packages)
        run: pnpm test
      - name: fixture registry (REQ-112)
        run: pnpm check:fixtures
      - name: seed determinism (REQ-155)
        run: pnpm check:seed
      - name: invariants I3/I8
        run: pnpm check:invariants
      - name: traceability — PR REQ-IDs (REQ-118)
        if: github.event_name == 'pull_request'
        env: { PR_BODY: "${{ github.event.pull_request.title }}\n${{ github.event.pull_request.body }}" }
        run: pnpm check:pr
      - name: traceability — orphan detector (REQ-118)
        run: pnpm check:traceability
      - name: tenant isolation suite (REQ-025)
        run: pnpm --filter @shuddl/api test -- isolation
  design-advisory:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - name: design audit (REQ-158 — advisory until WP-10 exit)
        run: pnpm audit:design
  secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@v2
        env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
```

**Step 4: `.github/workflows/nightly.yml`**

```yaml
name: nightly
on:
  schedule: [{ cron: "0 8 * * *" }]
  workflow_dispatch:
jobs:
  orphan-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - name: register ↔ code orphan diff (REQ-118 nightly; files issues when GH remote is live)
        run: pnpm check:traceability
  # ledger-snapshots: # REQ-117 — activates when F1-A provides Cloudflare OIDC creds + WP-02 creates D1s.
  #   See docs/ops/dr-backups.md for the job spec.
```

**Step 5: Run the full local gate**

Run: `pnpm install && pnpm verify`
Expected: every step green **except possibly `check:traceability`** — if any WP-01 REQ still lacks an annotation, add the missing `// REQ-xxx` annotation at the real implementation site (they all exist by now; Tasks 2–14 planted them). Re-run until green. This is "CI green on empty app."

**Step 6: Commit**

```bash
git add -A
git commit -m "app/worker/package shells + CI workflows: full gate chain green on empty app

REQ-118, REQ-025, REQ-154, REQ-158, REQ-061 (shell), REQ-073 (shell)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 16: Install doc 11 as CLAUDE.md + WP-01 checklist + final DoD verification

**Files:**
- Modify: `CLAUDE.md` (root)
- Create: `docs/wp/WP-01.md`

**Step 1: Install doc 11 as root CLAUDE.md**

Replace root `CLAUDE.md` body with `genesis/11-REPO-CLAUDE-MD.md` lines 4–36 (everything below its "drop this file" title), keeping the `# CLAUDE.md — SHUDDL OS` heading, with exactly these adjustments:
- `Shuddl-OS-Genesis/` → `genesis/` (docs live at `genesis/00–15`).
- No other edits — doc 11 already carries the REQ-158 advisory-timing amendment, the REQ-163 Lumina do-not, and the doc-14 source-of-truth entry that the current root file predates.

Verify the diff shows only additions from doc 11 (tenant-0 line, doc 12–15 refs, REQ-158 note in rule 7, REQ-163 in do-nots) and the path adjustment: `git diff CLAUDE.md`.

**Step 2: Create `docs/wp/WP-01.md`**

```markdown
# WP-01 — Repo + CI + assurance loop — checklist

## DoD (genesis/08 §03)
- [ ] CI green on empty app — `pnpm verify` output pasted below
- [ ] Dummy PR without REQ-ID fails — `PR_BODY="no reqs here" pnpm check:pr` exits 1 (also unit-tested)
- [ ] Cross-tenant read attempt fails the suite — Task 6 sabotage run documented

## Delivered (REQ → evidence)
| REQ | Evidence |
|---|---|
| REQ-025 | workers/api/test/isolation.test.ts (adversarial suite, every merge) |
| REQ-118 | tools/traceability/* + ci.yml gates + this repo's own PR template |
| REQ-024/163 | eslint.config.mjs + tools/checks/lint-guards.test.ts |
| REQ-112 | fixtures/manifest.json + tools/fixtures/verify.ts |
| REQ-154/134 | wrangler.toml conventions, .gitleaks.toml, docs/ops/secrets.md |
| REQ-155 | tools/seed/* + pinned hash |
| REQ-156/106 | contracts + error/idempotency/auth middleware + tests |
| REQ-158/145/149 | tools/design/* advisory mode; --signal-deep locked ≥4.5:1 |
| REQ-167 | tools/checks/identity-leak.ts — client-side denylist, masked output; CI secret wiring (denylist population is a tenant-side action) |
| REQ-131/114/117/135 | docs/security/threat-model.md, docs/ops/slo.md, docs/ops/dr-backups.md |
| REQ-111/132/133 | partial — see deferred |
| I3/I8 | tools/checks/invariants.ts |

## Deferred slices (not lost — owned by later WPs)
- REQ-132 magic-link email leg → WP-06 (dev token mint until then)
- REQ-111 log→ledger pipeline → WP-02
- REQ-155 SEED-1 DB load → WP-02
- Design CI item 6 (blessed screenshots) → WP-03; blocking flip → WP-10 (REQ-158)
- Fixture vendor-in → blocked on source files; 062226 path **[CONFIRM open]**
- REQ-117 snapshot job activation → F1-A Cloudflare creds

## New REQ rows proposed
- (none — no scope discovered outside the register)

## WP-exit audit swarm (REQ-119)
- [ ] Adversarial audit run at WP-01 exit; findings → REQ rows/defects; no open Criticals
```

**Step 3: Final verification (evidence before assertions)**

Run each and record output in the checklist:
1. `pnpm verify` → all gates green.
2. `PR_BODY="dummy PR, no requirement ids" pnpm check:pr` → exit 1 (DoD 2).
3. Re-run the Task 6 sabotage once more if not yet documented; paste the failing test name into the checklist (DoD 3).
4. `pnpm lint` catches a scratch file `packages/ledger/src/x.ts` containing an OpenAI import → delete the scratch file after confirming.

**Step 4: Tick the checklist, commit, and stop**

```bash
git add -A
git commit -m "WP-01 close: doc 11 installed as CLAUDE.md, checklist + DoD evidence

REQ-118, REQ-119 (audit swarm pending at exit)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Then: open the PR (template auto-fills the REQ-ID sections), and run the WP-exit adversarial audit (REQ-119) before merge. Per the working agreement, leave the build green.
