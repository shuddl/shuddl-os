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
  // §1462 — the SYNCHRONOUS sibling of `resolveTenantDb`, exported by all four workers and returning the same
  // `D1Database`. It is not a wrapper: `resolveTenantDb` is the claimed-pool-aware superset, and `tenantDb` is
  // an independent static-allowlist path. It went unrostered because the completeness derivation matched
  // storage CONSUMERS and this one is a PROVIDER (corrected in the same section). One live call site —
  // `pub/quote.ts`, the UNAUTHENTICATED guest-quote surface — and it is safe: the tenant comes from the
  // CF-routed hostname via HOST_TENANTS, never the client-forgeable Host header, with a module-load assertion
  // that every mapped slug is a real TENANT_BINDINGS key. Safe, but until now nothing ENFORCED it.
  "tenantDb",
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
  // retention sweep's roster iteration — neither is request-derived).
  // §1462 — a THIRD provenance now rides this same entry, and the justification above was written before it
  // existed: `pub/quote.ts` binds a LOCAL named `tenant` from `HOST_TENANTS[new URL(c.req.url).hostname]`.
  // That IS request-derived, so the parenthetical above would have been false for it. It is nonetheless
  // authenticated-equivalent: the CF-routed hostname is decided by routing, not by the caller (the forgeable
  // `Host` header is never consulted), the map is a static allowlist, and a module-load loop throws unless
  // every mapped slug is a TENANT_BINDINGS key — so an unknown host 404s before any handle exists. Recorded
  // rather than split into a new entry because the pinned AUTHENTICATED_MEMBERS list is the deliberate
  // two-place change (§826); what must not happen is the entry silently covering a provenance nobody vetted.
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

  // §1052 — EXPLICIT TIMEOUT, BECAUSE THIS TEST SAT EXACTLY ON THE DEFAULT.
  //
  // Filed at §998 as an undiagnosed intermittent (checklist L431) and observed four times without ever
  // being captured. §1052 reproduced it ON DEMAND — the trigger is the first full `test:tools` run after
  // `git add` of a NEW test file — and the captured failure is not a race at all:
  //
  //     Error: Test timed out in 5000ms.   ← this assertion, measured at 5080ms
  //
  // In isolation it takes ~3.5s of vitest's 5000ms default. It derives every tenant entry point from the
  // whole source corpus, so that cost is INHERENT, not accidental — measured: the 11 `git ls-files` spawns
  // `scanCorpus` makes account for 69ms of it (2%), so §1045's per-glob switch is not the cause.
  // Under full-suite load the same work crosses 5000ms, which is why it looked load-dependent and random.
  //
  // 30s, not a raised GLOBAL testTimeout: the default is a good bound for every other test in this repo,
  // and weakening it everywhere to accommodate one expensive completeness derivation would trade a real
  // hang-detector for a flake fix. A test whose runtime is a known 3.5s should say so where it is written.
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
    // §1462 — THE DERIVATION MATCHED STORAGE CONSUMERS AND MISSED STORAGE PROVIDERS.
    //
    // The body test below asks whether a function USES a handle (`.prepare(`, `.get(`, `R2`). A function that
    // RETURNS one uses nothing — `tenantDb(env, tenantSlug): D1Database` is four lines of allowlist lookup —
    // so it was never derived, and it is not a lesser case: it is the canonical entry point, the thing every
    // consumer gets its handle FROM. `resolveTenantDb` passed only because its body happens to contain a
    // matching token; its synchronous sibling `tenantDb` did not, and sat unrostered with a live call site on
    // the PUBLIC quote surface. Same shape, same file, opposite verdicts — an accident, not a rule.
    //
    // So provider-ness is now derived from the RETURN TYPE, which is what actually makes a function an entry
    // point. `Promise<D1Database>` counts: an async resolver hands out the same handle.
    const SCOPED_HANDLE = /:\s*(D1Database|R2Bucket|DurableObjectState|Queue)\b/;
    const DECL = /export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*:?\s*([^{]*)\{/gs;
    const RETURNS_HANDLE = /^\s*(?:Promise\s*<\s*)?(D1Database|R2Bucket)\b/;
    const derived = new Set<string>();
    for (const f of sourceFiles(repoRoot())) {
      const src = readFileSync(`${repoRoot()}/${f}`, "utf8");
      for (const m of src.matchAll(DECL)) {
        const [, name, args, ret] = m;
        if (!/\btenant(Slug)?\s*[:,)]/.test(args!)) continue;
        const body = src.slice(m.index! + m[0].length, m.index! + m[0].length + 1400);
        const usesStorage = /\.(prepare|get|put|list|delete)\(|DB\b|R2|bucket/.test(body);
        const providesStorage = RETURNS_HANDLE.test(ret ?? "");
        if (!usesStorage && !providesStorage) continue;
        // A provider is an entry point even when its first argument is a scoped handle — it is HANDING OUT
        // scope, not consuming it — so the downstream discriminator applies only to consumers.
        if (!providesStorage && SCOPED_HANDLE.test(args!.split(",")[0]!)) continue;
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
  }, 30_000);

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
  // ── §1462 — THE ONE LAUNDERING SHAPE THE ALLOWLIST CANNOT SEE ─────────────────────────────────────────
  //
  // §826 measured that a cross-tenant read laundered through a local, a header, a body or a helper is caught
  // "in every case", and re-measuring confirms it for three of four shapes. There is a fourth it does not
  // cover, and the difference is one word: the local has to have a NON-allowlisted name. REBIND the
  // allowlisted name itself —
  //
  //     const tenant = c.req.query("t") ?? HOST_TENANTS[host];   // §1462, measured: suite stays GREEN
  //
  // — and every downstream `f(env, tenant)` still reads as authenticated, because this gate matches the
  // argument EXPRESSION and has no way to know what the identifier was bound to. Fixing that in general is
  // dataflow analysis, which a regex gate cannot do. The DIRECT case is closable, and it is the one someone
  // reaches for: bind the allowlisted name straight from request input.
  //
  // Measured before asserting: 3 bindings of an allowlisted name exist in shipped source and NONE takes
  // request input, so this is a tripwire at zero cost, not a cleanup. It does not close the transitive case
  // (`const h = c.req.query("t"); const tenant = h;`) and does not pretend to — stated so the next reader
  // knows exactly which half is guarded.
  it("§1462: an allowlisted tenant name is never bound DIRECTLY from request input", () => {
    const NAMES = "(?:tenant|tenantSlug|slug)";
    const BIND = new RegExp(String.raw`\b(?:const|let|var)\s+${NAMES}\s*(?::[^=]+)?=\s*(.+)`);
    const REQUESTY = /c\.req\.|\breq\.|\bbody\.|\.query\(|\.header\(|\.param\(|searchParams/;
    const laundered: string[] = [];
    let bindings = 0;
    for (const f of sourceFiles(root)) {
      stripComments(readFileSync(`${root}/${f}`, "utf8"))
        .split("\n")
        .forEach((l, i) => {
          const m = BIND.exec(l);
          if (m === null) return;
          bindings += 1;
          if (REQUESTY.test(m[1]!)) laundered.push(`${f}:${i + 1}  ${l.trim().slice(0, 100)}`);
        });
    }
    // Non-vacuity is carried by the synthetic control below rather than by a count: the live population is
    // THREE, far too small to floor without the floor becoming the thing that breaks (§1437).
    expect(bindings, "no binding of an allowlisted tenant name found at all — the pattern broke").toBeGreaterThanOrEqual(1);
    expect(BIND.test('const tenant = c.req.query("t") ?? "a";'), "the binding pattern does not match its own example").toBe(true);
    expect(REQUESTY.test('c.req.query("t") ?? "a"'), "the request-input pattern does not match its own example").toBe(true);
    expect(REQUESTY.test("HOST_TENANTS[host]"), "the request-input pattern fires on the routing-authoritative map").toBe(false);
    expect(
      laundered,
      "an identifier the AUTHENTICATED allowlist trusts by NAME is bound directly from request input, so every " +
        "downstream call reads as authenticated while carrying a caller-chosen tenant (REQ-025: a cross-tenant " +
        "read anywhere is a build failure). Bind request input to a DIFFERENT name — the allowlist will then " +
        "reject it at the call site, which is the check working:\n  " + laundered.join("\n  "),
    ).toEqual([]);
  });

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
