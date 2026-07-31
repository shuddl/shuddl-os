import { readFileSync } from "node:fs";
import { EVIDENCE_EXIT, formatGateResult, parseMode, type GateResult } from "../release/evidence.js";

// V1 remediation Task 15 (REQ-288 / REQ-114 / REQ-117 / REQ-284) — THE ENVIRONMENT PREFLIGHT.
//
// Every binding the code dereferences, every secret it reads, every cross-script Durable Object and
// service target, the environment's own identity, the sender, the TSA, and the backup posture are checked
// BEFORE a deploy is promotable. Anything unprovable comes back as a structured BLOCK — never a warning,
// never a green. The checker is PURE (no network, no wrangler, no account) exactly like
// tools/checks/runtime-contract.ts, so the whole decision surface is unit-testable; `main()` reads the
// real configuration and feeds it in.
//
// This exists because the committed configuration already contains deploy-time defects that no test could
// previously see: workers/api `[env.prod]` declares a name and ZERO bindings, several staging resource ids
// are placeholders, and PLATFORM_TENANT_DB resolves to two different databases depending on which worker
// you ask. A preflight that cannot see those is decoration.

export type Severity = "BLOCK" | "WARN";
export type PreflightProblem = { code: string; resource: string; detail: string; severity: Severity };
export type PreflightReport = { ok: boolean; environment: string; problems: PreflightProblem[]; checked: number };

export type D1Binding = { binding: string; databaseName: string; databaseId: string };
export type R2Binding = { binding: string; bucketName: string };
export type KvBinding = { binding: string; id: string };
export type QueueProducer = { binding: string; queue: string };
export type QueueConsumer = { queue: string; deadLetterQueue?: string };
export type DoBinding = { binding: string; className: string; scriptName?: string };
export type ServiceBinding = { binding: string; service: string };

export type WorkerTarget = {
  worker: string; // the deployed script name, e.g. shuddl-api-staging
  environment: string;
  d1: D1Binding[];
  r2: R2Binding[];
  kv: KvBinding[];
  queueProducers: QueueProducer[];
  queueConsumers: QueueConsumer[];
  durableObjects: DoBinding[];
  services: ServiceBinding[];
  vars: Record<string, string>;
  routes: string[];
  crons: string[];
  workersDev?: boolean;
};

export type DeployTarget = {
  environment: string;
  workers: WorkerTarget[];
  // Secret NAMES known to be bound in the target account (from `wrangler secret list`), with an optional
  // value only ever supplied by a test/canary check. Values are never logged.
  secrets: Record<string, string | undefined>;
  corsOrigins: string[];
  sender?: { from?: string; domainVerified?: boolean };
  tsa?: { url?: string };
  backups?: { lastManifestAt?: string; retentionDays?: number };
  now: string;
};

// ── The contract ──────────────────────────────────────────────────────────────────────────────────────
// What each worker role MUST have bound for its code to run. Derived from the Env types each worker
// dereferences; a binding missing here is a runtime crash on the first request that touches it.

export const REQUIRED_BINDINGS = {
  api: {
    d1: ["TENANT_A_DB", "TENANT_B_DB", "CONTROL_DB", "PLATFORM_TENANT_DB", "TENANT_POOL_01_DB", "TENANT_POOL_02_DB"],
    kv: ["IDEMPOTENCY"],
    r2: ["EVIDENCE"],
    do: ["SHIPMENT_SEQ"],
    queueProducers: ["AGENT_QUEUE"],
    services: [] as string[],
    secrets: ["JWT_SECRET"],
  },
  agents: {
    d1: ["TENANT_A_DB", "TENANT_B_DB", "CONTROL_DB"],
    kv: [] as string[],
    r2: ["EVIDENCE"],
    do: ["SHIPMENT_SEQ", "SPARK_METER"],
    queueProducers: ["AGENT_QUEUE"],
    services: [] as string[],
    // Without it evidenceSender() is a NotConfiguredSender: the POD email — the whole money-follows-
    // physics demo — silently never sends (docs/ops/DEPLOYMENT.md).
    secrets: ["RESEND_API_KEY"],
  },
  billing: {
    d1: ["TENANT_A_DB", "TENANT_B_DB", "CONTROL_DB", "PLATFORM_TENANT_DB"],
    kv: [] as string[],
    r2: [] as string[],
    do: [] as string[],
    queueProducers: [] as string[],
    services: ["API"],
    // Without these billing cannot verify a Stripe webhook signature, nor authenticate itself to the
    // api's internal surface — it would accept forged callbacks or fail every internal call
    // (docs/ops/DEPLOYMENT.md).
    secrets: ["STRIPE_WEBHOOK_SECRET", "PLATFORM_INTERNAL_SECRET"],
  },
  mcp: {
    d1: ["CONTROL_DB"],
    kv: ["GRANTS"],
    r2: [] as string[],
    do: ["CAPS_METER"],
    queueProducers: [] as string[],
    services: ["API"],
    secrets: ["JWT_SECRET"],
  },
  translator: {
    d1: ["TENANT_A_DB", "TENANT_B_DB", "CONTROL_DB"],
    kv: [] as string[],
    r2: ["EVIDENCE"],
    do: ["SHIPMENT_SEQ"],
    queueProducers: [] as string[],
    services: [] as string[],
    secrets: [] as string[],
  },
} as const;

export const RPO_HOURS = 24; // design §5 WP7 — recovery point objective
export const RTO_HOURS = 4; // recorded here so the runbook and the gate cite one number
export const BACKUP_RETENTION_DAYS = 30;
export const TEST_JWT_CANARY = "test-secret-do-not-use-in-prod"; // workers/api/vitest.config.ts
// Affordances that exist for local/dev probing and must never be bound in production.
const TEST_ONLY_VARS = ["ALLOW_TEST_SEND", "TEST_SEND_TO", "TEST_SEND_TOKEN"];

type Role = keyof typeof REQUIRED_BINDINGS;

function roleOf(worker: string): Role | null {
  const m = /^shuddl-([a-z]+)-[a-z0-9]+$/.exec(worker);
  const role = m?.[1];
  return role !== undefined && role in REQUIRED_BINDINGS ? (role as Role) : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KV_ID = /^[0-9a-f]{32}$/i;

// A resource id that cannot be real in a deployed environment: a local dev alias, an all-zero placeholder
// UUID, or anything that is not the shape Cloudflare issues.
//
// EXPORTED because the provisioner (tools/deploy/provision-prod.ts) must decide "is this id a placeholder
// I may overwrite, or a real id I must refuse to clobber?" using EXACTLY this law. Two copies would
// eventually disagree, and the disagreement that matters is the one where the provisioner overwrites an id
// the preflight considers real — a live database silently orphaned (share-lint-matchers: one rule, one
// implementation).
export function placeholderReason(kind: "d1" | "kv", id: string, environment: string): string | null {
  if (environment === "dev") return null; // local-* ids are the whole point of dev
  if (id.startsWith("local-")) return "a local dev alias";
  if (kind === "kv") return KV_ID.test(id) ? null : "not a 32-hex KV namespace id";
  if (!UUID.test(id)) return "not a UUID";
  if (/^0{8}-/.test(id)) return "an all-zero placeholder UUID";
  return null;
}

// ── The decision ──────────────────────────────────────────────────────────────────────────────────────

export function checkDeployTarget(target: DeployTarget): PreflightReport {
  const problems: PreflightProblem[] = [];
  let checked = 0;
  const add = (code: string, resource: string, detail: string, severity: Severity = "BLOCK"): void => {
    problems.push({ code, resource, detail, severity });
  };

  const env = target.environment;
  const names = new Set(target.workers.map((w) => w.worker));

  for (const w of target.workers) {
    // ── environment identity ──
    checked += 1;
    if (!w.worker.endsWith(`-${env}`)) {
      add("environment-identity", w.worker, `deployed name does not carry the target environment suffix -${env}`);
    }
    const declared = w.vars["ENVIRONMENT"];
    if (declared !== env) {
      add("environment-identity", w.worker, `[vars] ENVIRONMENT is ${declared ?? "unset"}, target environment is ${env}`);
    }
    if (env === "prod") {
      for (const v of TEST_ONLY_VARS) {
        if (w.vars[v] !== undefined) add("test-affordance-in-prod", w.worker, `${v} is bound in production`);
      }
    }

    // ── binding completeness (only for workers this repo owns) ──
    const role = roleOf(w.worker);
    if (role !== null) {
      const req = REQUIRED_BINDINGS[role];
      const missing = (kind: string, required: readonly string[], present: string[]): void => {
        const gone = required.filter((b) => !present.includes(b));
        checked += required.length;
        if (gone.length > 0) add(`missing-${kind}`, w.worker, `${role} requires ${kind.replace(/-/g, " ")} ${gone.join(", ")}`);
      };
      missing("d1-binding", req.d1, w.d1.map((b) => b.binding));
      missing("kv-binding", req.kv, w.kv.map((b) => b.binding));
      missing("r2-binding", req.r2, w.r2.map((b) => b.binding));
      missing("do-binding", req.do, w.durableObjects.map((b) => b.binding));
      missing("queue-producer", req.queueProducers, w.queueProducers.map((b) => b.binding));
      missing("service-binding", req.services, w.services.map((b) => b.binding));
    }

    // ── resource ids ──
    for (const d of w.d1) {
      checked += 1;
      const why = placeholderReason("d1", d.databaseId, env);
      if (why !== null) add("placeholder-resource-id", `${w.worker}.${d.binding}`, `database_id for ${d.databaseName} is ${why}`);
    }
    for (const k of w.kv) {
      checked += 1;
      const why = placeholderReason("kv", k.id, env);
      if (why !== null) add("placeholder-resource-id", `${w.worker}.${k.binding}`, `kv namespace id is ${why}`);
    }

    // ── cross-worker references ──
    for (const d of w.durableObjects) {
      if (d.scriptName === undefined) continue;
      checked += 1;
      if (!names.has(d.scriptName)) {
        add("unresolved-cross-script", `${w.worker}.${d.binding}`, `script_name ${d.scriptName} is not part of this deploy`);
      }
    }
    for (const s of w.services) {
      checked += 1;
      if (!names.has(s.service)) add("unresolved-service", `${w.worker}.${s.binding}`, `service ${s.service} is not part of this deploy`);
    }

    // ── a consumer without a dead-letter queue loops a poison message forever (REQ-114) ──
    for (const c of w.queueConsumers) {
      checked += 1;
      if (c.deadLetterQueue === undefined || c.deadLetterQueue.length === 0) {
        add("queue-without-dlq", `${w.worker}:${c.queue}`, "queue consumer declares no dead_letter_queue");
      }
    }
  }

  // ── one logical binding must resolve to one physical resource across every worker ──
  const byBinding = new Map<string, { worker: string; name: string; id: string }[]>();
  for (const w of target.workers) {
    for (const d of w.d1) {
      const list = byBinding.get(d.binding) ?? [];
      list.push({ worker: w.worker, name: d.databaseName, id: d.databaseId });
      byBinding.set(d.binding, list);
    }
  }
  for (const [binding, uses] of byBinding) {
    if (uses.length < 2) continue;
    checked += 1;
    // The NAME is the logical database and must always agree. The ID is compared only between REAL
    // ids: a `local-` id is a per-worker alias for the same logical database — wrangler gives every
    // worker its own local store — so two differing aliases are the design, not a divergence. Treating
    // them as drift made `--env dev` report three false positives, and a check that cries wolf is the
    // one nobody reads on the day it is right. A `local-` id somewhere it cannot be real is still
    // caught, by placeholder-resource-id above.
    const names = new Set(uses.map((u) => u.name));
    const realIds = new Set(uses.filter((u) => !u.id.startsWith("local-")).map((u) => u.id));
    if (names.size > 1 || realIds.size > 1) {
      const what = names.size > 1 ? `${names.size} different databases` : `${realIds.size} different ids for one name`;
      add("binding-drift", binding, `${binding} resolves to ${what}: ${uses.map((u) => `${u.worker}→${u.name}`).join(", ")}`);
    }
  }

  // ── secrets (names only; a value is never echoed) ──
  const requiredSecrets = new Set<string>();
  for (const w of target.workers) {
    const role = roleOf(w.worker);
    if (role !== null) for (const s of REQUIRED_BINDINGS[role].secrets) requiredSecrets.add(s);
  }
  for (const s of requiredSecrets) {
    checked += 1;
    if (!(s in target.secrets)) {
      add("missing-secret", s, `${s} is not bound in ${env} (wrangler secret put ${s} --env ${env})`);
      continue;
    }
    if (target.secrets[s] === TEST_JWT_CANARY) {
      add("test-secret-deployed", s, `${s} is the in-repo test canary value — a forged token would be accepted`);
    }
  }

  // ── origins ──
  checked += 1;
  if (target.corsOrigins.length === 0) {
    add("no-origins", "cors", `no origin allowlist is configured for ${env}; every browser surface would be refused`);
  }
  for (const o of target.corsOrigins) {
    if (o === "*") add("wildcard-origin", "cors", "a wildcard origin defeats the tenant-scoped browser surface");
    else if (/\.example(\.|$)|example\.com/i.test(o)) add("placeholder-origin", "cors", `${o} is a placeholder origin`);
  }

  // ── sender ──
  if (target.sender?.from !== undefined && target.sender.from.length > 0) {
    checked += 1;
    if (target.sender.domainVerified !== true) {
      add("sender-unverified", "sender", `${target.sender.from} is configured but its domain is not verified — evidence email would silently fail`);
    }
  }

  // ── TSA (REQ-014 anchors cannot be timestamped without it) ──
  checked += 1;
  if (target.tsa?.url === undefined || target.tsa.url.length === 0) {
    add("tsa-unconfigured", "tsa", "no RFC 3161 timestamp authority endpoint is configured");
  }

  // ── backups (REQ-117) ──
  checked += 1;
  if (target.backups?.lastManifestAt === undefined) {
    add("no-backup", "backups", "no backup manifest exists for this environment");
  } else {
    const age = Date.parse(target.now) - Date.parse(target.backups.lastManifestAt);
    if (Number.isNaN(age)) add("no-backup", "backups", "backup manifest timestamp is unparseable");
    else if (age > RPO_HOURS * 3600_000) {
      add("backup-stale", "backups", `newest backup is ${(age / 3600_000).toFixed(1)}h old, RPO is ${RPO_HOURS}h`);
    }
    const retention = target.backups.retentionDays ?? 0;
    if (retention < BACKUP_RETENTION_DAYS) {
      add("retention-too-short", "backups", `retention is ${retention}d, policy is ${BACKUP_RETENTION_DAYS}d`);
    }
  }

  return { ok: problems.every((p) => p.severity !== "BLOCK"), environment: env, problems, checked };
}

// ── A wrangler-scoped TOML reader ─────────────────────────────────────────────────────────────────────
// Deliberately narrow: the subset wrangler configs actually use ([table], [[array of tables]], string /
// number / bool / inline string array). Reading the committed configs is the whole point — a preflight
// fed by hand-maintained JSON would drift away from what is actually deployed.

export type TomlTable = { [k: string]: unknown };
export type WranglerDoc = { root: TomlTable };

function parseValue(raw: string): unknown {
  const v = raw.trim();
  if (v.startsWith('"')) return v.slice(1, v.lastIndexOf('"'));
  if (v.startsWith("'")) return v.slice(1, v.lastIndexOf("'"));
  if (v.startsWith("[")) {
    const inner = v.slice(1, v.lastIndexOf("]"));
    return inner
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => parseValue(s));
  }
  if (v === "true") return true;
  if (v === "false") return false;
  const n = Number(v);
  return Number.isFinite(n) && v.length > 0 ? n : v;
}

// Strip a trailing comment without cutting a `#` that lives inside a quoted string.
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

function descend(root: TomlTable, path: string[]): TomlTable {
  let node = root;
  for (const key of path) {
    const next = node[key];
    if (Array.isArray(next)) {
      const last = next[next.length - 1];
      node = (typeof last === "object" && last !== null ? last : {}) as TomlTable;
    } else if (typeof next === "object" && next !== null) {
      node = next as TomlTable;
    } else {
      const fresh: TomlTable = {};
      node[key] = fresh;
      node = fresh;
    }
  }
  return node;
}

export function parseWranglerToml(text: string): WranglerDoc {
  const root: TomlTable = {};
  let current: TomlTable = root;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line.length === 0) continue;

    const arrayTable = /^\[\[([^\]]+)\]\]$/.exec(line);
    if (arrayTable?.[1] !== undefined) {
      const path = arrayTable[1].split(".").map((s) => s.trim());
      const key = path[path.length - 1] as string;
      const parent = descend(root, path.slice(0, -1));
      const list = Array.isArray(parent[key]) ? (parent[key] as TomlTable[]) : [];
      const entry: TomlTable = {};
      list.push(entry);
      parent[key] = list;
      current = entry;
      continue;
    }

    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table?.[1] !== undefined) {
      current = descend(root, table[1].split(".").map((s) => s.trim()));
      continue;
    }

    const eq = line.indexOf("=");
    if (eq > 0) current[line.slice(0, eq).trim()] = parseValue(line.slice(eq + 1));
  }

  return { root };
}

function tables(scope: TomlTable, path: string[]): TomlTable[] {
  let node: unknown = scope;
  for (const k of path) {
    if (typeof node !== "object" || node === null) return [];
    node = (node as TomlTable)[k];
  }
  return Array.isArray(node) ? (node as TomlTable[]) : [];
}

const str = (t: TomlTable, k: string): string | undefined => (typeof t[k] === "string" ? (t[k] as string) : undefined);

// Read one deployable scope. Wrangler does NOT inherit top-level bindings into a named [env.X]; a scope
// that declares none really has none, which is precisely the api [env.prod] defect.
export function targetFromWrangler(doc: WranglerDoc, environment: string | undefined): WorkerTarget {
  const envs = (doc.root["env"] ?? {}) as TomlTable;
  const scope = environment === undefined ? doc.root : ((envs[environment] ?? {}) as TomlTable);
  const vars: Record<string, string> = {};
  const varsTable = (scope["vars"] ?? {}) as TomlTable;
  for (const [k, v] of Object.entries(varsTable)) if (typeof v === "string") vars[k] = v;

  // Wrangler accepts THREE route spellings and this reader must understand all of them, because a route
  // it cannot see reads as "this worker is unrouted" — which is indistinguishable from a worker that is
  // genuinely unreachable. That silence is the dangerous direction: a future route check would pass a
  // deployment it never actually inspected.
  //   routes = ["host/*"]                                  — bare strings
  //   routes = [{ pattern = "host/*", zone_name = "..." }] — inline tables
  //   [[env.prod.routes]] pattern = "…"                    — array of tables (what the prod scopes use)
  // The last two are the same shape once parsed; only `pattern` identifies the route.
  const routesRaw = scope["routes"];
  const routes = Array.isArray(routesRaw)
    ? routesRaw.flatMap((r): string[] => {
        if (typeof r === "string") {
          // This reader's TOML subset does not implement INLINE tables, so `routes = [{ pattern = "x" }]`
          // arrives here as comma-split fragments (`{ pattern = "x"`, `zone_name = "y" }`) rather than as
          // objects. Accepting those would register a syntactically impossible route pattern and report a
          // worker as routed when nothing parsed — the precise silence this function exists to prevent.
          // Fail loudly and name the supported form instead.
          if (r.includes("=") || r.trimStart().startsWith("{")) {
            throw new Error(
              `unsupported inline-table route ${JSON.stringify(r)} — this reader does not implement inline tables; ` +
                `use a [[env.<scope>.routes]] block with a \`pattern\` key, or a bare string route`,
            );
          }
          return [r];
        }
        if (r !== null && typeof r === "object") {
          const pattern = (r as TomlTable)["pattern"];
          if (typeof pattern === "string" && pattern.length > 0) return [pattern];
        }
        return [];
      })
    : [];
  const single = str(scope, "route");
  if (single !== undefined) routes.push(single);

  const cronsRaw = ((scope["triggers"] ?? {}) as TomlTable)["crons"];

  return {
    worker: str(scope, "name") ?? "",
    environment: vars["ENVIRONMENT"] ?? environment ?? "",
    d1: tables(scope, ["d1_databases"]).map((t) => ({
      binding: str(t, "binding") ?? "",
      databaseName: str(t, "database_name") ?? "",
      databaseId: str(t, "database_id") ?? "",
    })),
    r2: tables(scope, ["r2_buckets"]).map((t) => ({ binding: str(t, "binding") ?? "", bucketName: str(t, "bucket_name") ?? "" })),
    kv: tables(scope, ["kv_namespaces"]).map((t) => ({ binding: str(t, "binding") ?? "", id: str(t, "id") ?? "" })),
    queueProducers: tables(scope, ["queues", "producers"]).map((t) => ({ binding: str(t, "binding") ?? "", queue: str(t, "queue") ?? "" })),
    queueConsumers: tables(scope, ["queues", "consumers"]).map((t) => {
      const dlq = str(t, "dead_letter_queue");
      return dlq === undefined ? { queue: str(t, "queue") ?? "" } : { queue: str(t, "queue") ?? "", deadLetterQueue: dlq };
    }),
    durableObjects: tables(scope, ["durable_objects", "bindings"]).map((t) => {
      const scriptName = str(t, "script_name");
      const base = { binding: str(t, "name") ?? str(t, "binding") ?? "", className: str(t, "class_name") ?? "" };
      return scriptName === undefined ? base : { ...base, scriptName };
    }),
    services: tables(scope, ["services"]).map((t) => ({ binding: str(t, "binding") ?? "", service: str(t, "service") ?? "" })),
    vars,
    routes,
    crons: Array.isArray(cronsRaw) ? cronsRaw.filter((c): c is string => typeof c === "string") : [],
    ...(typeof scope["workers_dev"] === "boolean" ? { workersDev: scope["workers_dev"] as boolean } : {}),
  };
}

// ── The deployable surface, published ─────────────────────────────────────────────────────────────────

/** Every wrangler config this repo deploys. EXPORTED because more than one check has to walk exactly
 * this list, and a check that re-types it drifts from the one that matters (share-lint-matchers: one
 * rule, one implementation). A worker added here is a worker every check sees. */
export const WORKER_CONFIGS = [
  "workers/api/wrangler.toml",
  "workers/agents/wrangler.toml",
  "workers/billing/wrangler.toml",
  "workers/mcp/wrangler.toml",
  "workers/translator/wrangler.toml",
] as const;

/** The named environments a deploy can target. The top-level (unnamed) scope is dev. */
export const DEPLOYABLE_SCOPES = ["staging", "prod"] as const;

/** The six binding-name sets a scope declares. Names only — ids are a provisioning question, and this
 * is the SHAPE question: whether a scope binds the same things its siblings do. Wrangler does NOT
 * inherit top-level bindings into a named environment, so a scope that omits a set genuinely has none
 * at runtime, and `wrangler deploy --env prod` would ship a worker that dereferences undefined. */
export function bindingSets(t: WorkerTarget): Record<string, string[]> {
  return {
    d1: t.d1.map((b) => b.binding).sort(),
    kv: t.kv.map((b) => b.binding).sort(),
    r2: t.r2.map((b) => b.binding).sort(),
    durableObjects: t.durableObjects.map((b) => b.binding).sort(),
    queueProducers: t.queueProducers.map((b) => b.binding).sort(),
    services: t.services.map((b) => b.binding).sort(),
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────

// The account-side facts this repo cannot read: bound secret names, the CORS allowlist actually served,
// sender-domain verification, the TSA endpoint, and the newest backup manifest. An operator (or the
// nightly job) supplies them as JSON via --state or PREFLIGHT_STATE. Without it they are UNPROVEN, and
// unproven is BLOCKED — the preflight never assumes an absent fact is a satisfied one.
type StateFile = Partial<Pick<DeployTarget, "secrets" | "corsOrigins" | "sender" | "tsa" | "backups">>;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Where the state file comes from: `--state <path>` if given, else the PREFLIGHT_STATE environment
 * variable, else nowhere.
 *
 * THE ENV VAR IS LOAD-BEARING — do not "simplify" it away. The release gate spawns this tool as
 * `pnpm -s preflight -- --mode <profile>` (tools/release/run-gate.ts, the deploy-preflight GateSpec) and
 * has no channel for a path argument. With a flag-only reader the account-side facts were unreadable from
 * inside a release run, so `deploy-preflight` was structurally incapable of reporting PASS no matter how
 * completely the account satisfied it — and a gate that cannot express the truth teaches the reader to
 * discount it. The env var is inherited by the spawn; the flag is not.
 *
 * An explicit flag still wins: an operator naming a path on the command line means that path. Absent both,
 * the answer is undefined, and undefined keeps the account-side facts UNPROVEN — which stays BLOCKED. */
export type StateSource = { path: string; channel: "--state" | "PREFLIGHT_STATE" };

export function resolveStatePath(argv: string[], env: NodeJS.ProcessEnv): StateSource | undefined {
  const fromFlag = flag(argv, "--state");
  if (fromFlag !== undefined && fromFlag !== "") return { path: fromFlag, channel: "--state" };
  const fromEnv = env["PREFLIGHT_STATE"];
  return fromEnv !== undefined && fromEnv !== "" ? { path: fromEnv, channel: "PREFLIGHT_STATE" } : undefined;
}

function main(): void {
  const argv = process.argv.slice(2);
  const mode = parseMode(argv);
  const environment = flag(argv, "--env") ?? process.env["RELEASE_ENVIRONMENT"] ?? "staging";
  const stateSource = resolveStatePath(argv, process.env);
  const statePath = stateSource?.path;

  let state: StateFile = {};
  if (stateSource !== undefined) {
    // Report WHICH channel supplied the path. `flag()` reads only the space-separated form, so a typo'd
    // `--state=/path/to.json` is not seen as a flag at all and the run silently falls back to whatever
    // PREFLIGHT_STATE happens to be exported in the operator's shell — possibly stale facts reported as a
    // PASS. Naming the channel on every run makes that substitution visible instead of silent.
    console.log(`preflight: state file ${stateSource.path} (via ${stateSource.channel})`);
    try {
      state = JSON.parse(readFileSync(stateSource.path, "utf8")) as StateFile;
    } catch (e) {
      console.error(`preflight: could not read state file ${stateSource.path}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(EVIDENCE_EXIT.MALFORMED);
    }
  }

  const workers: WorkerTarget[] = [];
  for (const path of WORKER_CONFIGS) {
    try {
      const doc = parseWranglerToml(readFileSync(path, "utf8"));
      const scope = environment === "dev" ? undefined : environment;
      const target = targetFromWrangler(doc, scope);
      if (target.worker.length > 0) workers.push(target);
      else console.warn(`preflight: ${path} declares no [env.${environment}] scope — nothing to deploy there`);
    } catch (e) {
      console.error(`preflight: could not read ${path}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(EVIDENCE_EXIT.MALFORMED);
    }
  }

  const target: DeployTarget = {
    environment,
    workers,
    secrets: state.secrets ?? {},
    corsOrigins: state.corsOrigins ?? [],
    ...(state.sender ? { sender: state.sender } : {}),
    ...(state.tsa ? { tsa: state.tsa } : {}),
    ...(state.backups ? { backups: state.backups } : {}),
    now: new Date().toISOString(),
  };

  const report = checkDeployTarget(target);
  const blocking = report.problems.filter((p) => p.severity === "BLOCK");

  console.log(`preflight: environment=${environment} workers=${workers.length} checks=${report.checked}`);
  if (statePath === undefined) {
    console.log("preflight: no state file supplied (--state <path> or PREFLIGHT_STATE=<path>) — account-side facts (secrets, origins, sender, TSA, backups) are UNPROVEN and therefore blocked.");
  }
  for (const p of report.problems) console.log(`  ${p.severity.padEnd(5)} ${p.code.padEnd(24)} ${p.resource} — ${p.detail}`);
  if (blocking.length === 0) console.log("\npreflight: PASS — every declared binding, reference, secret, origin, and backup obligation is satisfied.");
  else console.error(`\npreflight: BLOCKED — ${blocking.length} unsatisfied prerequisite${blocking.length === 1 ? "" : "s"}. This is not a green.`);

  const result: GateResult = blocking.length === 0
    ? { gate: "deploy-preflight", status: "PASS", executed: true, assertions: report.checked, detail: `${report.checked} checks passed for ${environment}` }
    : { gate: "deploy-preflight", status: "BLOCKED", executed: true, assertions: report.checked, detail: `${blocking.length} blocked: ${[...new Set(blocking.map((p) => p.code))].join(", ")}` };
  if (mode !== "local") console.log(formatGateResult(result));

  process.exit(blocking.length === 0 ? EVIDENCE_EXIT.OK : EVIDENCE_EXIT.PREREQ_BLOCKED);
}

if (process.argv[1] !== undefined && /preflight\.ts$/.test(process.argv[1])) main();
