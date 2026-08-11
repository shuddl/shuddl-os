import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { scanCorpus } from "./scan-corpus.js";
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
  // §702 — surfaced when the derivation stopped treating `env: AgentsEnv` as an already-scoped handle. It
  // is not one: Env is the ambient bindings, so (env, tenant) IS an entry point — the same shape as
  // resolveTenantDb, which sits at the top of this list.
  "sparkGateFor",
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
    "workers/*/src/*.ts",
    "workers/*/src/**/*.ts",
    "packages/*/src/*.ts",
    "packages/*/src/**/*.ts",
    // §696 — the .tsx half, exactly as §120 added it to the append chokepoint: "a React component is an
    // ordinary place to put a helper, and the file extension must not decide whether that is caught."
    // packages/agents, design and map all ship .tsx today, and none calls a guarded function yet — so this
    // closes a LATENT hole. REQ-025 is a build-failure law, which is the argument for closing it before it
    // is live rather than after.
    "packages/*/src/*.tsx",
    "packages/*/src/**/*.tsx",
    "apps/*/src/*.tsx",
    "apps/*/src/**/*.tsx",
    // §698 — and the .ts half of apps/. §696 added the surfaces' COMPONENTS and stopped there, leaving 49
    // .ts modules in a tree it had just started covering — an asymmetry introduced while closing a gap.
    "apps/*/src/*.ts",
    "apps/*/src/**/*.ts",
  ];
  // §1044 — per-glob non-vacuity, via the bundled scanner rather than a hand-rolled corpus floor.
  // §1041 measured the gap this closes: blinding ONE of these ten globs removed 48 files from a 316-file
  // corpus and the `> 180` floor absorbed it, so the suite stayed GREEN with all nested workers source —
  // the sequencer DO's subtree included — silently outside REQ-025's scan. A union floor detects a
  // COLLAPSE and cannot detect an AMPUTATION. `scanCorpus` throws `EmptyGlobError` the moment any single
  // glob matches nothing, which needs no calibration and cannot drift as the corpus grows.
  // No `mayBeEmpty` set: all ten globs match files today (measured §1044 — 99/48/116/35/8/4/59/47/53/38).
  // If one legitimately empties later, DECLARE it here rather than deleting the glob — the declaration is
  // the record that its emptiness was decided rather than suffered.
  // `excludeTests` is byte-identical to the filter this replaced (`f.includes(".test.")`).
  return scanCorpus(globs, root, { excludeTests: true });
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

  it("§702: GUARDED_FNS names every derivable tenant entry point (completeness, not just staleness)", () => {
    // §700 derived 19 candidates and could not decide them; §701 found the discriminator — is the FIRST
    // argument an already-SCOPED handle? A `db: D1Database` or `r2: R2Bucket` was scoped upstream by
    // resolveTenantDb (itself guarded), so the tenant argument is a label on data already fetched from the
    // right place. `env: AgentsEnv` is NOT such a handle: it is the ambient bindings, so `(env, tenant)` is
    // an entry point — that correction is what surfaced `sparkGateFor`.
    //
    // The assertion above this one is STALENESS (every listed function still exists). This is COMPLETENESS
    // (every derivable entry point is listed) — the direction §700 found missing on a build-failure law.
    //
    // BLIND SPOT, stated because it is real: this sees `export function` declarations only. A tenant entry
    // point written as `export const f = (tenant: string, …) => …` is invisible here, and five currently
    // listed functions are invisible for exactly that reason — they are in the roster because a human put
    // them there, which is why the roster stays hand-written and this is a FLOOR under it, not a generator.
    const SCOPED_HANDLE = /:\s*(D1Database|R2Bucket|DurableObjectState|Queue)\b/;
    const DECL = /export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/gs;
    const derived = new Set<string>();
    for (const f of sourceFiles(repoRoot())) {
      const src = readFileSync(`${repoRoot()}/${f}`, "utf8");
      for (const m of src.matchAll(DECL)) {
        const [, name, args] = m;
        if (!/\btenant(Slug)?\s*[:,)]/.test(args!)) continue;
        const body = src.slice(m.index! + m[0].length, m.index! + m[0].length + 1400);
        if (!/\.(prepare|get|put|list|delete)\(|DB\b|R2|bucket/.test(body)) continue;
        if (SCOPED_HANDLE.test(args!.split(",")[0]!)) continue;
        derived.add(name!);
      }
    }
    expect(derived.size, "no tenant entry points derived — the scan broke, the code did not").toBeGreaterThan(8);
    const unguarded = [...derived].filter((n) => !(GUARDED_FNS as readonly string[]).includes(n)).sort();
    expect(
      unguarded,
      "a function takes a tenant as its scoping input and reaches storage, but GUARDED_FNS does not name it " +
        "— so no call site of it is checked for an authenticated identity (REQ-025). Add it, or if its first " +
        "argument is an already-scoped handle the discriminator above should have excluded it:\n  " +
        unguarded.join("\n  "),
    ).toEqual([]);
  });

  // ── §826 — THE ALLOWLIST IS THE GATE'S WEAK POINT, AND IT WAS UNGUARDED ────────────────────────────
  //
  // This gate is the strongest in the repo and it is strong for a structural reason: `AUTHENTICATED` is an
  // ALLOWLIST, so a tenant argument fails unless it is a known-verified form. Measured (§826): a cross-tenant
  // read laundered through a local, through a header, through a JSON body, and through a helper FUNCTION is
  // caught in every case — because none of those expressions is on the list. Fail-closed by construction,
  // which is why denylist-shaped gates elsewhere in this repo keep needing evasion probes and this one does
  // not.
  //
  // The whole guarantee therefore rests on the LIST. Measured: adding one line to `AUTHENTICATED` and
  // pointing a route's tenant at a request-derived local left this suite GREEN. One line, and a cross-tenant
  // read is legitimate — on REQ-025, where the register says a cross-tenant read anywhere is a build failure.
  // The failure message even invites the edit ("add it to AUTHENTICATED with a note on what verifies it"),
  // which is right for a real new source and is exactly the door.
  //
  // So the list is pinned to its exact membership. Growth is now a TWO-place change — the entry, and this
  // assertion — which is the property that matters: it cannot happen as a side effect of making a test pass.
  //
  // WHAT THIS CANNOT DO, stated because the pin could be read as more than it is: it makes an addition
  // DELIBERATE, not CORRECT. A reviewer still has to judge whether a new source is genuinely authenticated;
  // no assertion here can. What it removes is the silent path.
  const AUTHENTICATED_MEMBERS = [
    'c.get("session"',
    "claims.t",
    "session.tenant",
    "slug",
    "tenant",
    "tenantSlug",
    "this.tenant",
    "trigger.tenant",
  ] as const;

  it("§826: AUTHENTICATED has EXACTLY its reviewed membership — it cannot grow silently", () => {
    expect(
      [...AUTHENTICATED].sort(),
      "the AUTHENTICATED allowlist changed. Every entry is a claim that some mechanism VERIFIES that value " +
        "before it selects a tenant's data — read the note beside it. Adding one legitimises a cross-tenant " +
        "read repo-wide (REQ-025: a cross-tenant read anywhere is a build failure), so the addition must be " +
        "deliberate and reviewed on its own merits, not a side effect of making this suite pass.",
    ).toEqual([...AUTHENTICATED_MEMBERS].sort());
  });

  it("§826: no allowlist entry names request input outright", () => {
    // The mechanical half. It cannot catch a laundered local (`badTenant` names nothing), which is why the
    // exact-set pin above is the real guard — but it makes the blatant form impossible to add by accident.
    for (const entry of AUTHENTICATED) {
      expect(
        /c\.req|\breq\.|\.query\(|\.header\(|\.param\(|body\./.test(entry),
        `AUTHENTICATED contains ${JSON.stringify(entry)}, which reads a tenant straight off the request. ` +
          "Request input is the one thing this gate exists to refuse.",
      ).toBe(false);
    }
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
