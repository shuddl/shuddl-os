import { readFileSync, readSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { EVIDENCE_EXIT } from "../release/evidence.js";
import { WORKER_CONFIGS, parseWranglerToml, placeholderReason, targetFromWrangler } from "./preflight.js";

// THE PRODUCTION PROVISIONER — the one command that turns `[env.prod]` from a shape into an environment.
//
// The prod scopes of all five workers are structurally complete and every resource id in them is an
// all-zero placeholder, so `preflight --env prod` blocks on 19 unprovisioned resources. Turning that into a
// deployable environment was a research project: read four TOMLs, work out which ids are shared, create
// seventeen databases and two KV namespaces by hand, paste twenty-six ids into five files without
// transposing one. That is a procedure a human performs once, badly. This is the script.
//
// THE PROPERTY THAT MATTERS MOST is not convenience, it is that ONE logical resource gets ONE id in EVERY
// worker that binds it. TENANT_A_DB is bound by api, agents, billing and translator; if those four ids
// diverge the four workers read four different databases while every test still passes, and the ledger's
// events are silently split across them. So the binding→resource map is DERIVED from the committed configs
// (grouped by database_name, the logical identity) and never hand-typed — a hand-typed list is exactly the
// artifact that drifts from the file it describes.
//
// THE SECOND PROPERTY is account safety. At least two Cloudflare accounts are in play and the one reachable
// by default hosts the MARKETING site, not the product. Provisioning the freight ledger's production
// databases into the marketing account is the worst outcome this file can produce, so: an explicit
// --account-id is mandatory, the account's inventory is printed before anything is created, the operator
// must retype the account id, and an account that looks like the marketing one aborts the run outright.
//
// Everything that decides is PURE and unit-tested (derivePlan / assessAccount / planPatches /
// patchProdIds). Cloudflare lives behind CloudflareGateway, a seam the tests replace with a fake, so the
// whole decision surface is provable offline — the same discipline as preflight.ts and restore-verify.ts.
//
// This is an OPERATOR command. It is deliberately NOT wired into verify:* or any CI profile: nothing in a
// pipeline should be able to create production infrastructure.

// ── The plan ──────────────────────────────────────────────────────────────────────────────────────────

/** The prod scope is the only scope this tool may touch. Named once so no code path can widen it. */
export const PROD_SCOPE = "prod";

export type ResourceKind = "d1" | "kv" | "r2";

/** One place a resource id is written down: a config file, a worker, a binding, and what is there now. */
export type BindingSite = {
  config: string; // workers/api/wrangler.toml
  worker: string; // shuddl-api-prod
  binding: string; // TENANT_A_DB
  currentId: string; // "" for r2, which is bound by name and has no id
};

/** One logical Cloudflare resource and every binding site that must carry its id. */
export type PlannedResource = {
  kind: ResourceKind;
  /** The name to look up / create in the account. For d1 the database_name, for r2 the bucket_name, for
   * kv a derived title (see kvNamespaceTitle) because a kv binding records only an id. */
  resourceName: string;
  sites: BindingSite[];
};

export type PlanConflict = { code: string; resource: string; detail: string };

/** Wrangler's OWN naming convention for a resource it auto-provisions for a binding
 * (`autoProvisionedResourceName` in wrangler's cli bundle): `${scriptName}-${binding}` lowercased with
 * underscores hyphenated. A kv_namespaces entry records only an `id`, so a title has to be derived from
 * something; deriving it the way wrangler would means an operator who later runs wrangler's own
 * provisioning lands on the same names instead of a second, parallel set. */
export function kvNamespaceTitle(worker: string, binding: string): string {
  return `${worker}-${binding.toLowerCase().replaceAll("_", "-")}`;
}

/**
 * Derive the whole provisioning plan from the committed configs — the binding→resource map included.
 *
 * D1 and R2 are grouped by the NAME in the config, because the name is the logical resource: four workers
 * that all say `database_name = "shuddl-t-tenant-a-prod"` are describing one database and must end up
 * sharing one id. KV is grouped per (worker, binding) because a kv_namespaces entry carries no name to
 * share by — nothing in the configs claims two workers' KV bindings are the same namespace, so nothing
 * here may assume it.
 */
export function derivePlan(configs: { path: string; text: string }[]): {
  resources: PlannedResource[];
  conflicts: PlanConflict[];
} {
  const byKey = new Map<string, PlannedResource>();
  const conflicts: PlanConflict[] = [];
  // binding name → the resource names it maps to, for the drift check below.
  const namesPerBinding = new Map<string, Set<string>>();

  const site = (resource: PlannedResource, s: BindingSite): void => {
    resource.sites.push(s);
  };
  const resource = (kind: ResourceKind, resourceName: string): PlannedResource => {
    const key = `${kind}:${resourceName}`;
    const found = byKey.get(key);
    if (found !== undefined) return found;
    const fresh: PlannedResource = { kind, resourceName, sites: [] };
    byKey.set(key, fresh);
    return fresh;
  };

  for (const { path, text } of configs) {
    const target = targetFromWrangler(parseWranglerToml(text), PROD_SCOPE);
    if (target.worker.length === 0) {
      conflicts.push({ code: "no-prod-scope", resource: path, detail: `declares no [env.${PROD_SCOPE}] scope` });
      continue;
    }
    const worker = target.worker;

    for (const d of target.d1) {
      if (d.databaseName.length === 0) {
        conflicts.push({ code: "unnamed-resource", resource: `${worker}.${d.binding}`, detail: "d1 binding declares no database_name, so there is nothing to look up or create" });
        continue;
      }
      site(resource("d1", d.databaseName), { config: path, worker, binding: d.binding, currentId: d.databaseId });
      const seen = namesPerBinding.get(d.binding) ?? new Set<string>();
      seen.add(d.databaseName);
      namesPerBinding.set(d.binding, seen);
    }

    for (const k of target.kv) {
      site(resource("kv", kvNamespaceTitle(worker, k.binding)), { config: path, worker, binding: k.binding, currentId: k.id });
    }

    for (const r of target.r2) {
      if (r.bucketName.length === 0) {
        conflicts.push({ code: "unnamed-resource", resource: `${worker}.${r.binding}`, detail: "r2 binding declares no bucket_name" });
        continue;
      }
      site(resource("r2", r.bucketName), { config: path, worker, binding: r.binding, currentId: "" });
    }
  }

  // One binding name resolving to two database NAMES is the `binding-drift` the preflight reports. The
  // provisioner cannot guess which of the two was intended, and provisioning both would make the drift
  // permanent and real instead of merely written down, so it refuses.
  for (const [binding, names] of namesPerBinding) {
    if (names.size > 1) {
      conflicts.push({ code: "binding-drift", resource: binding, detail: `${binding} names ${names.size} different databases across the prod scopes (${[...names].sort().join(", ")}); fix the configs before provisioning` });
    }
  }

  // Two REAL ids already written down for one logical resource: somebody provisioned by hand twice. Which
  // one is the live database is not a question this tool may answer by picking one.
  for (const r of byKey.values()) {
    const real = new Set(r.sites.map((s) => s.currentId).filter((id) => id.length > 0 && placeholderReason(r.kind === "kv" ? "kv" : "d1", id, PROD_SCOPE) === null));
    if (r.kind !== "r2" && real.size > 1) {
      conflicts.push({ code: "id-divergence", resource: r.resourceName, detail: `${r.sites.length} binding sites already carry ${real.size} different real ids (${[...real].sort().join(", ")}); one of them is orphaned and this tool will not choose` });
    }
  }

  return { resources: [...byKey.values()], conflicts };
}

/** True when the id in the config is a placeholder this tool may overwrite. Delegates to the preflight's
 * law so "real" means the same thing to the checker and the writer. */
export function isOverwritable(kind: ResourceKind, id: string): boolean {
  if (kind === "r2") return false; // no id to write
  if (id.length === 0) return true;
  return placeholderReason(kind === "kv" ? "kv" : "d1", id, PROD_SCOPE) !== null;
}

// ── The patch ─────────────────────────────────────────────────────────────────────────────────────────

export type ConfigEdit = {
  config: string;
  header: string; // the [[env.prod.*]] table the edit lands in — proof the scope was respected
  binding: string;
  key: "database_id" | "id";
  from: string;
  to: string;
  resourceName: string;
};

export type Refusal = { config: string; binding: string; resourceName: string; currentId: string; wouldBecome: string; why: string };

/** The exact `[[env.prod.*]]` tables an id may be written into. Anything else — dev, staging, a
 * database_name, a binding name — is out of bounds by construction, not by care. */
const PATCHABLE = new Map<string, "database_id" | "id">([
  [`[[env.${PROD_SCOPE}.d1_databases]]`, "database_id"],
  [`[[env.${PROD_SCOPE}.kv_namespaces]]`, "id"],
]);

const headerOf = (line: string): string | null => (/^\s*\[\[?[^\]]+\]\]?\s*$/.test(line) ? line.trim() : null);

/** The key/value of a bare `key = "value"` line, comment-tolerant, or null. */
function keyValue(line: string): { key: string; value: string } | null {
  const m = /^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/.exec(line);
  return m?.[1] !== undefined && m[2] !== undefined ? { key: m[1], value: m[2] } : null;
}

/**
 * Write the resolved ids into one config's `[env.prod]` scope, and nothing else.
 *
 * A line-scoped rewrite, not a TOML round-trip: re-emitting a parsed document would silently drop every
 * comment in these files, and those comments are the record of WHY prod is shaped the way it is (the
 * deliberately-absent EVIDENCE_FROM, the not-32-hex KV placeholder). Only the quoted value of the id line
 * inside a patchable table whose `binding` matches an edit is replaced; the rest of the file, whitespace
 * and trailing comments included, is untouched.
 */
export function patchProdIds(text: string, edits: ConfigEdit[]): { text: string; applied: ConfigEdit[]; unapplied: ConfigEdit[] } {
  for (const e of edits) {
    // A belt against the whole class of "wrote a sentinel into production": whatever lands in a config
    // must be an id the preflight would accept as real.
    if (placeholderReason(e.key === "id" ? "kv" : "d1", e.to, PROD_SCOPE) !== null) {
      throw new Error(`provision-prod: refusing to write ${e.to} for ${e.binding} — it is not a real Cloudflare id`);
    }
  }

  const lines = text.split("\n");
  const applied: ConfigEdit[] = [];

  // Walk table by table. A table runs from its header to the line before the next header.
  let i = 0;
  let header = "";
  while (i < lines.length) {
    const h = headerOf(lines[i] ?? "");
    if (h !== null) {
      header = h;
      i += 1;
      continue;
    }
    const idKey = PATCHABLE.get(header);
    if (idKey === undefined) {
      i += 1;
      continue;
    }

    // Collect this table's line span.
    const start = i;
    let end = i;
    while (end < lines.length && headerOf(lines[end] ?? "") === null) end += 1;

    let binding: string | null = null;
    for (let j = start; j < end; j += 1) {
      const kv = keyValue(lines[j] ?? "");
      if (kv?.key === "binding" || kv?.key === "name") binding = kv.value;
    }
    const edit = binding === null ? undefined : edits.find((e) => e.binding === binding && e.key === idKey && e.header === header);
    if (edit !== undefined) {
      for (let j = start; j < end; j += 1) {
        const line = lines[j] ?? "";
        const kv = keyValue(line);
        if (kv?.key !== idKey) continue;
        if (kv.value !== edit.from) {
          throw new Error(`provision-prod: ${edit.binding} ${idKey} reads ${kv.value} but the plan was built from ${edit.from} — the file changed underneath this run`);
        }
        lines[j] = line.replace(`"${kv.value}"`, `"${edit.to}"`);
        applied.push(edit);
        break;
      }
    }
    i = end;
  }

  const unapplied = edits.filter((e) => !applied.includes(e));
  return { text: lines.join("\n"), applied, unapplied };
}

/**
 * Turn resolved ids into edits — and into refusals where the config already holds a real id.
 *
 * An operator who provisioned by hand must not lose their ids to a careless run, so a real id that
 * disagrees with the resolved one is a REFUSAL naming both, never a silent overwrite. `--force` converts
 * refusals into edits; nothing else does.
 */
export function planPatches(
  resources: PlannedResource[],
  resolved: Map<string, string>,
  opts: { force: boolean },
): { edits: ConfigEdit[]; refusals: Refusal[]; alreadyCorrect: BindingSite[] } {
  const edits: ConfigEdit[] = [];
  const refusals: Refusal[] = [];
  const alreadyCorrect: BindingSite[] = [];

  for (const r of resources) {
    if (r.kind === "r2") continue; // bound by name; there is no id to write
    const id = resolved.get(`${r.kind}:${r.resourceName}`);
    if (id === undefined) continue;
    const key = r.kind === "kv" ? "id" : "database_id";
    const header = r.kind === "kv" ? `[[env.${PROD_SCOPE}.kv_namespaces]]` : `[[env.${PROD_SCOPE}.d1_databases]]`;

    for (const s of r.sites) {
      if (s.currentId === id) {
        alreadyCorrect.push(s);
        continue;
      }
      if (!isOverwritable(r.kind, s.currentId) && !opts.force) {
        refusals.push({
          config: s.config,
          binding: s.binding,
          resourceName: r.resourceName,
          currentId: s.currentId,
          wouldBecome: id,
          why: "the config already holds a real Cloudflare id; overwriting it would orphan whatever it points at (pass --force if that is genuinely intended)",
        });
        continue;
      }
      edits.push({ config: s.config, header, binding: s.binding, key, from: s.currentId, to: id, resourceName: r.resourceName });
    }
  }

  return { edits, refusals, alreadyCorrect };
}

/**
 * The refusals knowable BEFORE a single resource is created — the other half of the same law.
 *
 * `planPatches` can only refuse over a RESOLVED id, so it says nothing about a resource the account does
 * not have yet: in an empty account it has nothing to compare a config id against and reports no refusal at
 * all. But a config that already carries a real id for a resource this account is MISSING is the loudest
 * possible signal that the account is the wrong one — the resource exists somewhere, just not here — and
 * creating it here would both orphan a resource and overwrite that id.
 *
 * Same law, one source: `isOverwritable` → the preflight's `placeholderReason`. Nothing is re-decided here.
 */
export function planCreateRefusals(missing: PlannedResource[], opts: { force: boolean }): Refusal[] {
  if (opts.force) return [];
  const refusals: Refusal[] = [];
  for (const r of missing) {
    if (r.kind === "r2") continue; // bound by name; there is no id to clobber
    for (const s of r.sites) {
      if (isOverwritable(r.kind, s.currentId)) continue;
      refusals.push({
        config: s.config,
        binding: s.binding,
        resourceName: r.resourceName,
        currentId: s.currentId,
        wouldBecome: "(whatever id a create would assign here)",
        why: `${r.resourceName} does not exist in this account, yet the config already holds a real Cloudflare id for it — either this is the wrong account or the resource lives in another one. Creating it here would leave an orphan behind and overwrite that id (pass --force if that is genuinely intended)`,
      });
    }
  }
  return refusals;
}

// ── Account safety ────────────────────────────────────────────────────────────────────────────────────

/** The marketing site's worker. Its presence is the strongest available signal that an account is the
 * wrong one for the product's production data. */
export const MARKETING_WORKER = "shuddl-tech";
/** The product account has had a staging deploy since 2026-07-14. Its ABSENCE alongside the marketing
 * worker is the discriminator: the marketing account has one and not the other. */
export const STAGING_SENTINEL = "shuddl-api-staging";

/** Worker names probed by name, because wrangler exposes no "list every worker" command — only
 * `deployments list --name <n>`, which fails for a name that does not exist. */
export function probeNames(resources: PlannedResource[]): string[] {
  const workers = new Set<string>([MARKETING_WORKER, STAGING_SENTINEL]);
  for (const r of resources) for (const s of r.sites) workers.add(s.worker);
  return [...workers].sort();
}

export type AccountInventory = {
  accountId: string;
  workersProbed: string[];
  workersPresent: string[];
  d1: { name: string; id: string }[];
  kv: { title: string; id: string }[];
  /** null = the R2 store could not be read (see CloudflareGateway.listBuckets). */
  buckets: string[] | null;
};

export type AccountVerdict = { looksLikeMarketing: boolean; unrecognized: boolean; warnings: string[] };

/**
 * Does this account look like the product account, or the marketing one?
 *
 * Deliberately a heuristic that ABORTS rather than one that guesses forward: a false alarm costs the
 * operator one flag, and a miss costs the freight ledger's production data a home in the wrong account.
 */
export function assessAccount(inv: AccountInventory): AccountVerdict {
  const present = new Set(inv.workersPresent);
  const warnings: string[] = [];

  const looksLikeMarketing = present.has(MARKETING_WORKER) && !present.has(STAGING_SENTINEL);
  if (looksLikeMarketing) {
    warnings.push(`account ${inv.accountId} hosts the ${MARKETING_WORKER} worker but has no ${STAGING_SENTINEL} — this is almost certainly the MARKETING account, not the product account`);
  }

  const productShaped = inv.workersPresent.some((w) => w.startsWith("shuddl-") && w !== MARKETING_WORKER) || inv.d1.some((d) => d.name.startsWith("shuddl-"));
  const unrecognized = !productShaped;
  if (unrecognized) {
    warnings.push(`account ${inv.accountId} contains no shuddl-* worker and no shuddl-* D1 database — nothing here identifies it as the product account`);
  }
  if (!looksLikeMarketing && !present.has(STAGING_SENTINEL)) {
    warnings.push(`${STAGING_SENTINEL} is not deployed in this account, so the usual proof that this is the product account is missing`);
  }
  return { looksLikeMarketing, unrecognized, warnings };
}

// ── The Cloudflare seam ───────────────────────────────────────────────────────────────────────────────

/** Every account-mutating and account-reading operation, in one injectable interface. Synchronous
 * because wrangler is a subprocess and the tests want to be boring. */
export type CloudflareGateway = {
  listD1(): { name: string; id: string }[];
  createD1(name: string): void;
  listKv(): { title: string; id: string }[];
  createKv(title: string): void;
  /** null when the bucket list could not be READ at all — an unreadable store is not an empty one. The
   * distinction is not academic: the first token this was run with had no `r2` scope, so a swallowed
   * failure would have reported "no buckets", concluded the evidence bucket was missing, and discovered
   * the truth only from a create that failed after eight databases already existed. */
  listBuckets(): string[] | null;
  bucketExists(name: string): boolean;
  createBucket(name: string): void;
  workerExists(name: string): boolean;
};

type Runner = (args: string[]) => { status: number; stdout: string; stderr: string };

/**
 * The real gateway.
 *
 * NOTE ON `--account-id`: wrangler 4.63 and 4.107 accept NO such flag — `d1`, `kv` and `r2` take only the
 * global `--config/--cwd/--env/--env-file` set, and account selection is the `CLOUDFLARE_ACCOUNT_ID`
 * environment variable. The CLI still REQUIRES `--account-id` from the operator (making the target account
 * an explicit, auditable argument rather than whatever `wrangler whoami` happens to resolve); it is passed
 * to every child process through the environment, which is where this wrangler reads it.
 */
export function wranglerGateway(run: Runner): CloudflareGateway {
  const json = <T>(args: string[], what: string): T => {
    const r = run(args);
    if (r.status !== 0) throw new Error(`wrangler ${args.join(" ")} failed (${r.status}): ${r.stderr.trim() || r.stdout.trim()}`);
    // `kv namespace list` and `d1 list --json` both print `JSON.stringify(x, null, 2)` with the banner
    // suppressed, so the document starts a line with `[`/`{` in column zero. Anchoring to column zero is
    // load-bearing: wrangler emits notices like `▲ [WARNING] …` on stdout, and slicing from the first
    // bracket ANYWHERE would slice from inside that notice and parse a warning as the resource list.
    const start = r.stdout.search(/^[[{]/m);
    if (start < 0) throw new Error(`wrangler ${args.join(" ")} printed no JSON for ${what}: ${r.stdout.trim()}`);
    try {
      return JSON.parse(r.stdout.slice(start)) as T;
    } catch (e) {
      throw new Error(`wrangler ${args.join(" ")} printed unparseable JSON for ${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return {
    listD1: () =>
      json<{ uuid?: string; name?: string }[]>(["d1", "list", "--json"], "d1 databases")
        .map((d) => ({ name: d.name ?? "", id: d.uuid ?? "" }))
        .filter((d) => d.name.length > 0 && d.id.length > 0),
    createD1: (name) => {
      const r = run(["d1", "create", name]);
      if (r.status !== 0) throw new Error(`wrangler d1 create ${name} failed (${r.status}): ${r.stderr.trim() || r.stdout.trim()}`);
    },
    listKv: () =>
      json<{ id?: string; title?: string }[]>(["kv", "namespace", "list"], "kv namespaces")
        .map((k) => ({ title: k.title ?? "", id: k.id ?? "" }))
        .filter((k) => k.title.length > 0 && k.id.length > 0),
    createKv: (title) => {
      // `kv namespace create <namespace>` sets the title to the positional VERBATIM when no --env is
      // passed (wrangler computes `${env ? env + "-" : ""}${namespace}`), so the full desired title goes
      // in as the argument and no --env is given. Verified against the installed 4.63/4.107 bundles.
      const r = run(["kv", "namespace", "create", title]);
      if (r.status !== 0) throw new Error(`wrangler kv namespace create ${title} failed (${r.status}): ${r.stderr.trim() || r.stdout.trim()}`);
    },
    // `r2 bucket list` prints labelled values, not JSON — parsed best-effort for the inventory display
    // only. Existence is decided by bucketExists, which has an exit code to trust.
    listBuckets: () => {
      const r = run(["r2", "bucket", "list"]);
      if (r.status !== 0) return null;
      return [...r.stdout.matchAll(/^name:\s*(\S+)/gm)].map((m) => m[1] ?? "").filter((n) => n.length > 0);
    },
    bucketExists: (name) => run(["r2", "bucket", "info", name, "--json"]).status === 0,
    createBucket: (name) => {
      const r = run(["r2", "bucket", "create", name]);
      if (r.status !== 0) throw new Error(`wrangler r2 bucket create ${name} failed (${r.status}): ${r.stderr.trim() || r.stdout.trim()}`);
    },
    workerExists: (name) => run(["deployments", "list", "--name", name, "--json"]).status === 0,
  };
}

// ── The run ───────────────────────────────────────────────────────────────────────────────────────────

export type RunOptions = {
  mode: "dry-run" | "apply";
  accountId: string;
  force: boolean;
  overrideAccountWarning: boolean;
  configs: { path: string; text: string }[];
  gateway: CloudflareGateway;
  /** Asked exactly once, only under --apply, only when there is real work, and only before any create. */
  confirm: (question: string) => string;
  write: (path: string, text: string) => void;
  log: (line: string) => void;
};

export type RunResult = {
  ok: boolean;
  exitCode: number;
  aborted: string | null;
  resources: PlannedResource[];
  conflicts: PlanConflict[];
  inventory: AccountInventory | null;
  verdict: AccountVerdict | null;
  adopted: string[]; // "d1:shuddl-control-prod" that already existed
  created: string[]; // ...that this run created
  wouldCreate: string[]; // dry-run only
  edits: ConfigEdit[];
  refusals: Refusal[];
  filesPatched: string[];
  noop: boolean;
};

const label = (r: PlannedResource): string => `${r.kind}:${r.resourceName}`;

export function provision(opts: RunOptions): RunResult {
  const { log } = opts;
  const result: RunResult = {
    ok: false,
    exitCode: EVIDENCE_EXIT.OK,
    aborted: null,
    resources: [],
    conflicts: [],
    inventory: null,
    verdict: null,
    adopted: [],
    created: [],
    wouldCreate: [],
    edits: [],
    refusals: [],
    filesPatched: [],
    noop: false,
  };

  const { resources, conflicts } = derivePlan(opts.configs);
  result.resources = resources;
  result.conflicts = conflicts;

  log(`provision-prod: mode=${opts.mode} account=${opts.accountId} configs=${opts.configs.length} logical resources=${resources.length}`);
  log("");
  log("the binding→resource map, derived from the committed [env.prod] scopes:");
  for (const r of [...resources].sort((a, b) => label(a).localeCompare(label(b)))) {
    const shared = r.sites.length > 1 ? `  ← ONE id shared by ${r.sites.length} bindings` : "";
    log(`  ${r.kind.padEnd(3)} ${r.resourceName.padEnd(28)} ${r.sites.map((s) => `${s.worker}.${s.binding}`).join(", ")}${shared}`);
  }
  log("");

  if (conflicts.length > 0) {
    for (const c of conflicts) log(`  CONFLICT  ${c.code.padEnd(18)} ${c.resource} — ${c.detail}`);
    log("");
    log("provision-prod: ABORTED — the configs disagree with themselves. Provisioning would make the disagreement physical.");
    result.aborted = "plan-conflict";
    result.exitCode = EVIDENCE_EXIT.ASSERTIONS_FAILED;
    return result;
  }

  // ── read-only: what is actually in the account ──
  const d1 = opts.gateway.listD1();
  const kv = opts.gateway.listKv();
  const buckets = opts.gateway.listBuckets();
  const workersProbed = probeNames(resources);
  const workersPresent = workersProbed.filter((w) => opts.gateway.workerExists(w));
  const inventory: AccountInventory = { accountId: opts.accountId, workersProbed, workersPresent, d1, kv, buckets };
  const verdict = assessAccount(inventory);
  result.inventory = inventory;
  result.verdict = verdict;

  log(`account ${opts.accountId} inventory:`);
  log(`  workers present   ${workersPresent.length === 0 ? "(none of the probed names)" : workersPresent.join(", ")}`);
  log(`  workers absent    ${workersProbed.filter((w) => !workersPresent.includes(w)).join(", ") || "(none)"}`);
  log(`  d1 databases      ${d1.length === 0 ? "(none)" : d1.map((x) => x.name).sort().join(", ")}`);
  log(`  kv namespaces     ${kv.length === 0 ? "(none)" : kv.map((x) => x.title).sort().join(", ")}`);
  log(`  r2 buckets        ${buckets === null ? "COULD NOT READ — the API token appears to lack an r2 scope" : buckets.length === 0 ? "(none)" : [...buckets].sort().join(", ")}`);
  log("");
  for (const w of verdict.warnings) log(`  WARNING  ${w}`);
  if (verdict.warnings.length > 0) log("");

  if (verdict.looksLikeMarketing && !opts.overrideAccountWarning) {
    const rule = "═".repeat(96);
    log(rule);
    log("  STOP — THIS LOOKS LIKE THE MARKETING ACCOUNT, NOT THE PRODUCT ACCOUNT.");
    log(`  ${MARKETING_WORKER} is deployed in account ${opts.accountId}; ${STAGING_SENTINEL} is not.`);
    log("  Creating the freight ledger's PRODUCTION databases here is the worst thing this command can do,");
    log("  and it is not undoable from a config file. Re-run with the product account's --account-id.");
    log("  If this genuinely is the right account, pass --override-account-warning and run it again.");
    log(rule);
    result.aborted = "marketing-account";
    result.exitCode = EVIDENCE_EXIT.PREREQ_BLOCKED;
    return result;
  }

  // An unreadable R2 store makes `bucketExists` indistinguishable from "absent", which would send the run
  // into a create it has no permission to perform — after the databases already exist. Caught here, before
  // anything is created, rather than as a half-finished environment.
  if (buckets === null && resources.some((r) => r.kind === "r2")) {
    log("  R2 IS UNREADABLE in this account, so whether shuddl-evidence-prod exists cannot be determined.");
    log("  Grant the API token an r2 scope (Workers R2 Storage: Edit) and re-run.");
    if (opts.mode === "apply") {
      log("");
      log("provision-prod: ABORTED — nothing created, nothing written.");
      result.aborted = "r2-unreadable";
      result.exitCode = EVIDENCE_EXIT.PREREQ_BLOCKED;
      return result;
    }
    log("");
  }

  // ── adopt by name; only the remainder is missing ──
  const d1ByName = new Map(d1.map((x) => [x.name, x.id]));
  const kvByTitle = new Map(kv.map((x) => [x.title, x.id]));
  const resolved = new Map<string, string>();
  const missing: PlannedResource[] = [];

  for (const r of resources) {
    const found = r.kind === "d1" ? d1ByName.get(r.resourceName) : r.kind === "kv" ? kvByTitle.get(r.resourceName) : opts.gateway.bucketExists(r.resourceName) ? "(exists)" : undefined;
    if (found === undefined) {
      missing.push(r);
      continue;
    }
    result.adopted.push(label(r));
    if (r.kind !== "r2") resolved.set(label(r), found);
  }

  // Edits knowable before any create: the resources that already exist.
  const pre = planPatches(resources, resolved, { force: opts.force });
  const needsWork = missing.length > 0 || pre.edits.length > 0;

  log(`already provisioned: ${result.adopted.length}/${resources.length}${result.adopted.length > 0 ? ` (${result.adopted.sort().join(", ")})` : ""}`);
  log(`to create:           ${missing.length}${missing.length > 0 ? ` (${missing.map(label).sort().join(", ")})` : ""}`);
  log("");

  // THE CLOBBER CHECK RUNS AGAINST THE PLANNED SET, HERE, BEFORE THE CREATE LOOP — not only after it.
  //
  // The post-create pass below is a real check but it is useless as a GUARD: it can only refuse over ids
  // the account has resolved, so in an empty account there is nothing to compare against until the nine
  // resources exist, and by the time it fires the orphans are already created and billed. It aborts before
  // writing a config, which protects the repo and nothing else. An operator who passes a wrong
  // --account-id that happens to clear the marketing heuristic is exactly the person this must catch, and
  // the only moment the catch is worth anything is before the first create.
  const createRefusals = planCreateRefusals(missing, { force: opts.force });
  const refusals = [...pre.refusals, ...createRefusals];

  if (refusals.length > 0) {
    for (const f of pre.refusals) {
      log(`  REFUSED  ${f.config} ${f.binding} holds ${f.currentId}, the account says ${f.wouldBecome}`);
      log(`           ${f.why}`);
    }
    for (const f of createRefusals) {
      log(`  REFUSED  ${f.config} ${f.binding} holds ${f.currentId}, and ${f.resourceName} is not in account ${opts.accountId}`);
      log(`           ${f.why}`);
    }
    log("");
    result.refusals = refusals;
    result.aborted = "would-clobber-real-id";
    result.exitCode = EVIDENCE_EXIT.ASSERTIONS_FAILED;
    log("provision-prod: ABORTED — nothing created, nothing written.");
    return result;
  }

  if (!needsWork) {
    result.noop = true;
    result.ok = true;
    log("provision-prod: NO-OP — every resource exists and every [env.prod] id already matches it.");
    log("");
    log(`next: pnpm exec tsx tools/deploy/preflight.ts --env ${PROD_SCOPE}`);
    return result;
  }

  if (opts.mode === "dry-run") {
    result.wouldCreate = missing.map(label).sort();
    result.edits = pre.edits;
    log("WOULD CREATE:");
    const creates = missing
      .map((r) => (r.kind === "d1" ? `wrangler d1 create ${r.resourceName}` : r.kind === "kv" ? `wrangler kv namespace create ${r.resourceName}` : `wrangler r2 bucket create ${r.resourceName}`))
      .sort();
    for (const c of creates) log(`  ${c}`);
    log("");
    log("WOULD PATCH:");
    const lines: string[] = [];
    for (const r of resources) {
      if (r.kind === "r2") continue;
      const id = resolved.get(label(r));
      const key = r.kind === "kv" ? "id" : "database_id";
      for (const s of r.sites) {
        if (id !== undefined && s.currentId === id) continue;
        lines.push(`  ${s.config} ${r.kind === "kv" ? "[[env.prod.kv_namespaces]]" : "[[env.prod.d1_databases]]"} ${s.binding}: ${key} = "${s.currentId}" → "${id ?? "(the id Cloudflare assigns at create)"}"`);
      }
    }
    for (const l of lines.sort()) log(l);
    log("");
    log("provision-prod: DRY RUN — nothing was created and no file was written. Re-run with --apply.");
    log(`then: pnpm exec tsx tools/deploy/preflight.ts --env ${PROD_SCOPE}`);
    result.ok = true;
    return result;
  }

  // ── apply: confirm the account, out loud, before anything exists ──
  const what = missing.length > 0
    ? `Create ${missing.length} resource(s) in Cloudflare account ${opts.accountId} and write their ids into 5 configs?`
    : `Write ${pre.edits.length} id(s) from Cloudflare account ${opts.accountId} into the [env.${PROD_SCOPE}] configs?`;
  const answer = opts.confirm(`${what} Retype the account id to confirm: `);
  if (answer.trim() !== opts.accountId) {
    log(`provision-prod: ABORTED — confirmation did not match ${opts.accountId}. Nothing created, nothing written.`);
    result.aborted = "unconfirmed";
    result.exitCode = EVIDENCE_EXIT.PREREQ_BLOCKED;
    return result;
  }

  for (const r of missing) {
    if (r.kind === "d1") opts.gateway.createD1(r.resourceName);
    else if (r.kind === "kv") opts.gateway.createKv(r.resourceName);
    else opts.gateway.createBucket(r.resourceName);
    result.created.push(label(r));
    log(`  created  ${label(r)}`);
  }

  // Re-read rather than trust the create output: the account is the authority on what its ids are, and a
  // re-read is also what makes a second --apply a no-op instead of a second create.
  const d1After = new Map(opts.gateway.listD1().map((x) => [x.name, x.id]));
  const kvAfter = new Map(opts.gateway.listKv().map((x) => [x.title, x.id]));
  const unresolved: string[] = [];
  for (const r of resources) {
    if (r.kind === "r2") continue;
    const id = r.kind === "d1" ? d1After.get(r.resourceName) : kvAfter.get(r.resourceName);
    if (id === undefined) unresolved.push(label(r));
    else resolved.set(label(r), id);
  }
  if (unresolved.length > 0) {
    log(`provision-prod: FAILED — created, but the account does not list ${unresolved.join(", ")}. No config was written; re-run to adopt.`);
    result.aborted = "unresolved-after-create";
    result.exitCode = EVIDENCE_EXIT.ASSERTIONS_FAILED;
    return result;
  }

  // Belt and braces to the pre-create check above: a resource can appear in the account between the two
  // passes (a concurrent operator, a wrangler that created what a list had not yet shown), and an id the
  // account resolves late must still never be written over a real one.
  const post = planPatches(resources, resolved, { force: opts.force });
  result.edits = post.edits;
  result.refusals = post.refusals;
  if (post.refusals.length > 0) {
    for (const f of post.refusals) log(`  REFUSED  ${f.config} ${f.binding} holds ${f.currentId}, the account says ${f.wouldBecome} — ${f.why}`);
    log("provision-prod: resources exist but the configs were NOT written.");
    result.aborted = "would-clobber-real-id";
    result.exitCode = EVIDENCE_EXIT.ASSERTIONS_FAILED;
    return result;
  }

  const byConfig = new Map<string, ConfigEdit[]>();
  for (const e of post.edits) byConfig.set(e.config, [...(byConfig.get(e.config) ?? []), e]);
  for (const { path, text } of opts.configs) {
    const edits = byConfig.get(path);
    if (edits === undefined || edits.length === 0) continue;
    const patched = patchProdIds(text, edits);
    if (patched.unapplied.length > 0) {
      log(`provision-prod: FAILED — could not place ${patched.unapplied.map((e) => `${e.binding}.${e.key}`).join(", ")} in ${path}. ${path} left untouched.`);
      result.aborted = "unplaceable-edit";
      result.exitCode = EVIDENCE_EXIT.ASSERTIONS_FAILED;
      return result;
    }
    opts.write(path, patched.text);
    result.filesPatched.push(path);
    log(`  patched  ${path} (${patched.applied.length} id${patched.applied.length === 1 ? "" : "s"})`);
  }

  result.ok = true;
  log("");
  log(`provision-prod: DONE — adopted ${result.adopted.length}, created ${result.created.length}, patched ${result.edits.length} id(s) across ${result.filesPatched.length} config(s).`);
  log(`next: pnpm exec tsx tools/deploy/preflight.ts --env ${PROD_SCOPE}`);
  return result;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** A synchronous sleep, so the stdin wait below does not spin a core. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** One line off stdin, synchronously, byte at a time — so the confirmation is a genuine blocking question
 * and not an async promise something could resolve on the operator's behalf. Any read failure other than
 * "nothing typed yet" returns "", which fails the account-id comparison and aborts: fail closed. */
function readLineSync(): string {
  const byte = Buffer.alloc(1);
  let line = "";
  let waited = 0;
  const WAIT_MS = 50;
  const WAIT_LIMIT = (10 * 60 * 1000) / WAIT_MS; // ten minutes to answer, then fail closed
  while (line.length < 128) {
    let n = 0;
    try {
      n = readSync(0, byte, 0, 1, null);
    } catch (e) {
      // A tty left in non-blocking mode answers EAGAIN until the operator actually types. "Not yet" is
      // not "no", so wait — this is the one prompt the operator has to be able to answer.
      if ((e as { code?: string }).code === "EAGAIN" && waited < WAIT_LIMIT) {
        waited += 1;
        sleepSync(WAIT_MS);
        continue;
      }
      return "";
    }
    if (n === 0) break;
    const c = byte.toString("utf8");
    if (c === "\n") break;
    if (c !== "\r") line += c;
  }
  return line;
}

const USAGE = `usage: pnpm provision:prod --account-id <cloudflare-account-id> [--apply] [--force] [--override-account-warning]

  --dry-run                    (DEFAULT) print what would be created and which config lines would change.
                               Creates nothing, writes nothing.
  --apply                      create the missing resources and write the real ids into the five
                               workers/*/wrangler.toml [env.prod] scopes.
  --account-id <id>            REQUIRED. The Cloudflare account to provision into, passed to wrangler as
                               CLOUDFLARE_ACCOUNT_ID (this wrangler has no --account-id flag). There is
                               more than one account; the default-reachable one hosts the marketing site.
  --force                      overwrite an [env.prod] id that is already a REAL Cloudflare id. Without
                               this, such an id is a refusal, named, and the run aborts.
  --override-account-warning   proceed even though the account looks like the marketing account.
  --wrangler "<command>"       the wrangler invocation (default: "pnpm exec wrangler").`;

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(EVIDENCE_EXIT.OK);
  }

  const accountId = flag(argv, "--account-id");
  if (accountId === undefined || accountId.length === 0 || accountId.startsWith("--")) {
    console.error("provision-prod: --account-id is REQUIRED. There is more than one Cloudflare account in play and the");
    console.error("one reachable by default hosts the MARKETING site, not the product. Name the account explicitly.\n");
    console.error(USAGE);
    process.exit(EVIDENCE_EXIT.PREREQ_BLOCKED);
  }

  const apply = argv.includes("--apply");
  const wranglerCmd = (flag(argv, "--wrangler") ?? "pnpm exec wrangler").split(/\s+/).filter((s) => s.length > 0);
  const bin = wranglerCmd[0];
  if (bin === undefined) {
    console.error("provision-prod: --wrangler is empty");
    process.exit(EVIDENCE_EXIT.MALFORMED);
  }

  const run = (args: string[]): { status: number; stdout: string; stderr: string } => {
    const r = spawnSync(bin, [...wranglerCmd.slice(1), ...args], {
      encoding: "utf8",
      // wrangler 4.63/4.107 have no --account-id flag on d1/kv/r2; CLOUDFLARE_ACCOUNT_ID is the knob.
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: "false" },
    });
    if (r.error) return { status: 127, stdout: "", stderr: r.error.message };
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

  const configs = WORKER_CONFIGS.map((path) => ({ path: path as string, text: readFileSync(path, "utf8") }));

  const result = provision({
    mode: apply ? "apply" : "dry-run",
    accountId,
    force: argv.includes("--force"),
    overrideAccountWarning: argv.includes("--override-account-warning"),
    configs,
    gateway: wranglerGateway(run),
    confirm: (question) => {
      process.stdout.write(question);
      return readLineSync();
    },
    write: (path, text) => writeFileSync(path, text, "utf8"),
    log: (line) => console.log(line),
  });

  process.exit(result.exitCode);
}

if (process.argv[1] !== undefined && /provision-prod\.ts$/.test(process.argv[1])) main();
