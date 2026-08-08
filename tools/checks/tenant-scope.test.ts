import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { stripComments } from "./source-corpus.js";

// REQ-025 §572 — EVERY TENANT-SCOPED STORAGE ENTRY POINT TAKES ITS TENANT FROM AN AUTHENTICATED IDENTITY.
//
// §571 proved this for `resolveTenantDb` — all 35 call sites — and stated its own limit: *"resolveTenantDb
// gains an overload or a wrapper → the regex finds the direct call only."* That limit was real and already
// reached. `GET /v1/anchors/:day` (registry row 6) never calls `resolveTenantDb`; it calls
// `readAnchorManifest(c.env.EVIDENCE, session.tenant, day)`. §571's guard could not see it.
//
// R2 is why this matters more than the D1 case. Per-tenant D1 is PHYSICAL isolation — a wrong slug resolves
// to a different database or throws. R2 is ONE SHARED BUCKET partitioned by a string prefix, so a tenant
// argument sourced from the request reads another tenant's objects with no error anywhere.
//
// The function list is hand-kept (a wrapper nobody adds here is still unguarded), but the TENANT POSITION is
// not: it is read from each declaration, so a signature that reorders its parameters cannot silently move the
// check onto the wrong argument. That is the one part that would fail SILENTLY if it were hand-maintained —
// a wrong index lands on an argument that happens to be allowlisted, and the guard reports clean forever.

/** Storage entry points whose tenant argument decides which tenant's data is reached. */
const GUARDED_FNS = [
  "resolveTenantDb", // D1 handle (the §571 subject, folded in so ONE mechanism owns this invariant)
  "readAnchorManifest", // R2: anchors/<tenant>/<day>/manifest.json
  "anchorManifestKey",
  "anchorReceiptKey",
  "evidenceKey", // R2: evidence/<tenant>/<shipment>/<hash>
  "evidenceTenantPrefix",
  "isTenantEvidenceKey",
  "computeTenantStorageBytes",
  "deviceOwnedBy", // control-plane device ownership
  // §700 — the key-derivation siblings. `snapshotKey` builds an R2 key from a tenant exactly as
  // `anchorManifestKey` and `evidenceKey` do; the roster listed two of the three families and stopped.
  // Derived by asking which exported functions take a `tenant` AND touch storage — 19 matched, and these
  // three are the ones whose shape is identical to something already guarded. Adding them was safe: every
  // existing call site already passes an authenticated identity (4/4 before and after).
  "snapshotKey", // R2: watchtower/<tenant>/<day>.json
  "watchtowerAlarmId", // deterministic alarm id folded from the tenant
  "driftFallbackEventId",
  // §701 — the remaining entry-point-shaped functions, dispositioned rather than carried. §700 derived 19
  // candidates and called them "the largest open item". The discriminator is whether the FIRST argument is
  // an already-scoped handle: ten take `db: D1Database` / `r2: R2Bucket` / `env` and are DOWNSTREAM of
  // `resolveTenantDb`, which is itself guarded — the scoping already happened, so listing them would assert
  // nothing. These six take `tenant` first, which is the shape of every function already here.
  "tenderPrefix", // R2: tender/<tenant>/…
  "tenderKey",
  "sent214Key",
  "quarantineKey",
  "unresolvableKey",
  "isPlatformCreditInvoiceIssued",
] as const;

/** Argument expressions known to carry an authenticated identity, each with what verifies it. */
const AUTHENTICATED = new Set([
  "session.tenant", // JWT claim, verified by the auth middleware
  // §701 — the translator's inbound EDI path. `tenantSlug` is `pairing.slug` from a control-plane
  // pairings⋈tenants lookup gated by an HMAC signature check, failing CLOSED (401, nothing written) on
  // missing headers, an unknown or inactive pairing, an unresolvable secret, or a signature mismatch
  // (inbound.ts). It is not request input: the partner header selects a pairing, and the signature proves
  // the caller holds that pairing's secret before the slug is used for anything.
  "tenantSlug",
  "tenant", // a parameter of an already-tenant-scoped function (the DO's re-derived identity; the
  // retention sweep's roster iteration — neither is request-derived)
  "claims.t", // MAC-verified by verifyStatusCap, fail-closed to a uniform 401
  'c.get("session"', // the same session, off the Hono context
  "this.tenant", // a DO instance pinned to one tenant by its identity check
  "slug", // cron sweeps iterating the STATIC tenant roster — no request is involved (12 sites, all in
  // scheduled workers: agents, translator, billing)
  "trigger.tenant", // a queue payload: Zod-validated (`AgentTrigger.safeParse`), then resolved through the
  // fail-closed resolver, and only a worker holding the queue binding can enqueue at all
]);

interface Site {
  file: string;
  line: number;
  fn: string;
  arg: string;
}

function sourceFiles(root: string): string[] {
  // BOTH levels. `workers/*/src/**/*.ts` requires at least one subdirectory, so it silently skips every file
  // sitting directly under `src/` — 132 of 215 files (§572). §571 shipped with that glob and a `> 20` floor,
  // which passed because 35 sites lived in the 39% it did scan. A floor on HITS cannot detect a scan collapse;
  // the corpus floor below is what catches it.
  const globs = [
    '"workers/*/src/*.ts"',
    '"workers/*/src/**/*.ts"',
    '"packages/*/src/*.ts"',
    '"packages/*/src/**/*.ts"',
    // §696 — the .tsx half, exactly as §120 added it to the append chokepoint: "a React component is an
    // ordinary place to put a helper, and the file extension must not decide whether that is caught."
    // packages/agents, design and map all ship .tsx today, and none calls a guarded function yet — so this
    // closes a LATENT hole. REQ-025 is a build-failure law, which is the argument for closing it before it
    // is live rather than after.
    '"packages/*/src/*.tsx"',
    '"packages/*/src/**/*.tsx"',
    '"apps/*/src/*.tsx"',
    '"apps/*/src/**/*.tsx"',
    // §698 — and the .ts half of apps/. §696 added the surfaces' COMPONENTS and stopped there, leaving 49
    // .ts modules in a tree it had just started covering — an asymmetry introduced while closing a gap.
    '"apps/*/src/*.ts"',
    '"apps/*/src/**/*.ts"',
  ].join(" ");
  return execSync(`git ls-files ${globs}`, { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((f) => f && !f.includes(".test."));
}

/** Split a call's argument list on top-level commas (a nested `f(a, b)` must not split its parent). */
function splitArgs(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of raw) {
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/**
 * The 0-based index of each function's tenant parameter, READ FROM ITS DECLARATION.
 *
 * Deriving this is the whole point: a hand-kept map goes wrong silently (a wrong index checks an argument
 * that happens to be allowlisted), whereas a declaration that stops having a tenant parameter fails the
 * non-vacuity test below.
 */
function tenantPositions(root: string): Map<string, number> {
  const positions = new Map<string, number>();
  for (const f of sourceFiles(root)) {
    const text = stripComments(readFileSync(`${root}/${f}`, "utf8"));
    for (const fn of GUARDED_FNS) {
      const decl = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${fn}\\s*\\(([^)]*)\\)`, "s").exec(text);
      if (decl === null) continue;
      const idx = splitArgs(decl[1]!).findIndex((p) => /^tenant\b|tenantSlug\b/.test(p));
      if (idx >= 0) positions.set(fn, idx);
    }
  }
  return positions;
}

function callSites(root: string, positions: Map<string, number>): Site[] {
  const out: Site[] = [];
  for (const f of sourceFiles(root)) {
    const lines = stripComments(readFileSync(`${root}/${f}`, "utf8")).split("\n");
    lines.forEach((text, i) => {
      for (const [fn, pos] of positions) {
        const m = new RegExp(`(?<!function\\s)\\b${fn}\\s*\\(([^)]*)`).exec(text);
        if (m === null) continue;
        if (/\bfunction\s+\w+\s*\(/.test(text)) continue; // the declaration itself
        const args = splitArgs(m[1]!);
        const arg = args[pos];
        if (arg === undefined) continue; // a multi-line call — the non-vacuity floor bounds how many
        out.push({ file: f, line: i + 1, fn, arg });
      }
    });
  }
  return out;
}

describe("REQ-025 §572: every tenant-scoped storage entry point is fed an authenticated identity", () => {
  const root = repoRoot();
  const positions = tenantPositions(root);

  it("derives a tenant position for the guarded functions (non-vacuity)", () => {
    // If a declaration is renamed or loses its tenant parameter, this fails HERE rather than quietly
    // dropping the function from the sweep below — the §487/§554 class, which this repo met in four gates.
    const missing = GUARDED_FNS.filter((fn) => !positions.has(fn));
    expect(missing, `no tenant parameter found for: ${missing.join(", ")} — the declaration moved, or the name is stale`).toEqual([]);
  });

  it("scans the whole source corpus, not a subdirectory of it (non-vacuity)", () => {
    // THE floor that matters. §571's guard floored the number of HITS, found 35, and reported clean while
    // reading 39% of the tree. A hit-count floor cannot distinguish "few violations" from "few files".
    expect(sourceFiles(root).length, "the source glob collapsed — a scan gap reports clean").toBeGreaterThan(180);
  });

  it("finds call sites at all (non-vacuity)", () => {
    expect(callSites(root, positions).length, "no guarded call sites found — the scan is broken, not the tree").toBeGreaterThan(40);
  });

  it("no call site sources its tenant from request input", () => {
    const stray = callSites(root, positions).filter((s) => !AUTHENTICATED.has(s.arg));
    expect(
      stray,
      "a tenant-scoped storage call whose tenant is not a known authenticated source. R2 is ONE SHARED " +
        "BUCKET partitioned by prefix, so a request-derived tenant here reads another tenant's objects with " +
        "no error anywhere (CLAUDE.md rule 8 / REQ-025 makes that a build failure). If this is a new " +
        "authenticated form, add it to AUTHENTICATED with a note on what verifies it:\n  " +
        stray.map((s) => `${s.file}:${s.line} → ${s.fn}(… ${s.arg} …)`).join("\n  "),
    ).toEqual([]);
  });
});
