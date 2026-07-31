import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MARKETING_WORKER,
  PROD_SCOPE,
  STAGING_SENTINEL,
  assessAccount,
  derivePlan,
  isOverwritable,
  kvNamespaceTitle,
  patchProdIds,
  planPatches,
  probeNames,
  provision,
  wranglerGateway,
  type AccountInventory,
  type CloudflareGateway,
  type ConfigEdit,
  type PlannedResource,
  type RunOptions,
} from "./provision-prod.js";
import { WORKER_CONFIGS, checkDeployTarget, parseWranglerToml, placeholderReason, targetFromWrangler } from "./preflight.js";

// THE PRODUCTION PROVISIONER.
//
// provision-prod.ts is the command that creates the [env.prod] resources and writes their real ids back
// into the configs. Two properties carry the whole file:
//
//   1. ONE logical resource gets ONE id in EVERY worker that binds it. Four workers bind TENANT_A_DB; if
//      their ids diverge, four workers read four databases and every test still passes.
//   2. It cannot provision into the wrong Cloudflare account. The default-reachable account hosts the
//      MARKETING site; putting the ledger's production databases there is unrecoverable from a config file.
//
// Both are proven against a SYNTHETIC repo, with Cloudflare behind a fake gateway — no network, no
// account, no file read, no resource created by a test run.
//
// WHY SYNTHETIC. This suite used to run against the committed workers/*/wrangler.toml, which meant every
// property was expressed as an assertion about the contents of five files that exist precisely in order
// to change: it asserted that production was UNPROVISIONED. That was true the day it was written and
// false the hour an operator ran the command — thirteen tests went red on a successful provisioning run,
// with nothing wrong in the code they cover. Idempotency, derivation, patching and plan-clearing are
// properties of the TOOL; what they need is an unprovisioned INPUT, not an unprovisioned production. So
// the pure core gets a fixture tree, exactly as tools/traceability/coverage.test.ts and
// tools/checks/citation-links.test.ts give theirs one, and the single thing the real files must satisfy
// forever — in any state of provisioning — gets its own test at the bottom of this file.

// ── an UNPROVISIONED repo, synthesised ────────────────────────────────────────────────────────────────
//
// The fixture MIRRORS the real topology (five workers, six databases, seventeen D1 binding sites, two KV
// namespaces, one bucket) because that shape is what makes the property visible: four workers binding
// TENANT_A_DB is the case where a divergent id would be silent. It does NOT track the committed files and
// must not be edited to match them — the real files are guarded by their own invariant, not by
// resemblance to this. Nothing here is a Cloudflare resource: the paths are `fixture/`, and every prod id
// is the sentinel an unprovisioned scope carries.

type FixtureEnv = "dev" | "staging" | "prod";
type DbBinding = "TENANT_A_DB" | "TENANT_B_DB" | "CONTROL_DB" | "PLATFORM_TENANT_DB" | "TENANT_POOL_01_DB" | "TENANT_POOL_02_DB";
type KvBindingName = "IDEMPOTENCY" | "GRANTS";

/** Six logical databases. The prod id is an all-zero placeholder UUID and is IDENTICAL in every worker
 * that binds the database — one logical resource, one id, even before the resource exists. */
const FIXTURE_D1: Record<DbBinding, { slug: string; prod: string; staging: string }> = {
  TENANT_A_DB: { slug: "t-tenant-a", prod: "00000000-0000-4000-8000-000000000301", staging: "8e238970-2ed3-494d-960f-e4af082c1e01" },
  TENANT_B_DB: { slug: "t-tenant-b", prod: "00000000-0000-4000-8000-000000000302", staging: "8e238970-2ed3-494d-960f-e4af082c1e02" },
  CONTROL_DB: { slug: "control", prod: "00000000-0000-4000-8000-000000000303", staging: "8e238970-2ed3-494d-960f-e4af082c1e03" },
  PLATFORM_TENANT_DB: { slug: "t-platform", prod: "00000000-0000-4000-8000-000000000304", staging: "8e238970-2ed3-494d-960f-e4af082c1e04" },
  TENANT_POOL_01_DB: { slug: "t-pool-01", prod: "00000000-0000-4000-8000-000000000305", staging: "8e238970-2ed3-494d-960f-e4af082c1e05" },
  TENANT_POOL_02_DB: { slug: "t-pool-02", prod: "00000000-0000-4000-8000-000000000306", staging: "8e238970-2ed3-494d-960f-e4af082c1e06" },
};

/** Two KV namespaces. The prod id is 32 characters and deliberately NOT hex: a KV id is only checked for
 * shape, so an all-zero 32-HEX string would pass that check and read as provisioned. */
const FIXTURE_KV: Record<KvBindingName, { prod: string; staging: string }> = {
  IDEMPOTENCY: { prod: "0000000000000000000000000000prod", staging: "aa1180a9442c4b8cae8383183a280001" },
  GRANTS: { prod: "0000000000000000000000000000prod", staging: "aa1180a9442c4b8cae8383183a280002" },
};

type FixtureWorker = { path: string; role: string; d1: DbBinding[]; kv: KvBindingName[]; r2: boolean };

const FIXTURE_WORKERS: FixtureWorker[] = [
  { path: "fixture/api/wrangler.toml", role: "api", d1: ["TENANT_A_DB", "TENANT_B_DB", "CONTROL_DB", "PLATFORM_TENANT_DB", "TENANT_POOL_01_DB", "TENANT_POOL_02_DB"], kv: ["IDEMPOTENCY"], r2: true },
  { path: "fixture/agents/wrangler.toml", role: "agents", d1: ["TENANT_A_DB", "TENANT_B_DB", "CONTROL_DB"], kv: [], r2: true },
  { path: "fixture/billing/wrangler.toml", role: "billing", d1: ["TENANT_A_DB", "TENANT_B_DB", "CONTROL_DB", "PLATFORM_TENANT_DB"], kv: [], r2: false },
  { path: "fixture/mcp/wrangler.toml", role: "mcp", d1: ["CONTROL_DB"], kv: ["GRANTS"], r2: false },
  { path: "fixture/translator/wrangler.toml", role: "translator", d1: ["TENANT_A_DB", "TENANT_B_DB", "CONTROL_DB"], kv: [], r2: true },
];

/** One synthetic wrangler.toml: a dev scope on local aliases, a staging scope on real ids, and a prod
 * scope on placeholders — the three-scope shape the patcher has to navigate, comments and all. */
function fixtureToml(w: FixtureWorker): string {
  const lines: string[] = [
    `# SYNTHETIC fixture — ${w.role}. Not a copy of any committed config and not maintained against one.`,
    `name = "shuddl-${w.role}-dev"`,
    'main = "src/index.ts"',
    "",
    "[vars]",
    'ENVIRONMENT = "dev"',
    "",
  ];

  const d1Id = (b: DbBinding, env: FixtureEnv): string =>
    env === "prod" ? FIXTURE_D1[b].prod : env === "staging" ? FIXTURE_D1[b].staging : `local-${FIXTURE_D1[b].slug}`;
  const kvId = (b: KvBindingName, env: FixtureEnv): string =>
    env === "prod" ? FIXTURE_KV[b].prod : env === "staging" ? FIXTURE_KV[b].staging : `local-${b.toLowerCase()}`;

  const emit = (env: FixtureEnv): void => {
    const p = env === "dev" ? "" : `env.${env}.`;
    if (env !== "dev") {
      lines.push(`# ── ${env.toUpperCase()} ${"─".repeat(40)}`);
      if (env === "prod") lines.push("# Every id below is a placeholder, deliberately: declared, not provisioned.");
      lines.push(`[env.${env}]`, `name = "shuddl-${w.role}-${env}"`, "", `[env.${env}.vars]`, `ENVIRONMENT = "${env}"`, "");
    }
    for (const b of w.d1) {
      lines.push(
        `# ${b} — one logical database, however many workers bind it.`,
        `[[${p}d1_databases]]`,
        `binding = "${b}"`,
        `database_name = "shuddl-${FIXTURE_D1[b].slug}-${env}"`,
        `database_id = "${d1Id(b, env)}"`,
        "",
      );
    }
    for (const b of w.kv) {
      lines.push(
        "# A kv_namespaces entry records only an id, so its title has to be derived.",
        `[[${p}kv_namespaces]]`,
        `binding = "${b}"`,
        `id = "${kvId(b, env)}"`,
        "",
      );
    }
    if (w.r2) {
      lines.push("# Bound by NAME: there is no id here for the provisioner to write.", `[[${p}r2_buckets]]`, 'binding = "EVIDENCE"', `bucket_name = "shuddl-evidence-${env}"`, "");
    }
  };

  emit("dev");
  emit("staging");
  emit("prod");
  return lines.join("\n");
}

const fixtureConfigs = (): { path: string; text: string }[] =>
  FIXTURE_WORKERS.map((w) => ({ path: w.path, text: fixtureToml(w) }));

/** The committed configs. Read by exactly ONE test in this file — the invariant at the bottom. */
const realConfigs = (): { path: string; text: string }[] =>
  WORKER_CONFIGS.map((path) => ({ path: path as string, text: readFileSync(path, "utf8") }));

// ── a fake account ────────────────────────────────────────────────────────────────────────────────────

type FakeState = {
  d1: { name: string; id: string }[];
  kv: { title: string; id: string }[];
  buckets: string[];
  workers: string[];
  /** the token cannot read R2 at all — the state the first real dry-run actually ran into */
  r2Unreadable?: boolean;
};

type Fake = { gateway: CloudflareGateway; state: FakeState; calls: string[] };

const uuidFor = (n: number): string => `1742fef3-f7bf-4d1a-9aaa-bf93669945${String(n).padStart(2, "0")}`;
const kvIdFor = (n: number): string => `119880a9442c4b8cae8383183a28${String(n).padStart(4, "0")}`;

function fakeAccount(initial: Partial<FakeState> = {}): Fake {
  const state: FakeState = { d1: [], kv: [], buckets: [], workers: [], ...initial };
  const calls: string[] = [];
  let n = state.d1.length + state.kv.length + 40;
  return {
    state,
    calls,
    gateway: {
      listD1: () => {
        calls.push("listD1");
        return state.d1.map((d) => ({ ...d }));
      },
      createD1: (name) => {
        calls.push(`createD1 ${name}`);
        n += 1;
        state.d1.push({ name, id: uuidFor(n) });
      },
      listKv: () => {
        calls.push("listKv");
        return state.kv.map((k) => ({ ...k }));
      },
      createKv: (title) => {
        calls.push(`createKv ${title}`);
        n += 1;
        state.kv.push({ title, id: kvIdFor(n) });
      },
      listBuckets: () => {
        calls.push("listBuckets");
        return state.r2Unreadable === true ? null : [...state.buckets];
      },
      bucketExists: (name) => state.buckets.includes(name),
      createBucket: (name) => {
        calls.push(`createBucket ${name}`);
        state.buckets.push(name);
      },
      workerExists: (name) => state.workers.includes(name),
    },
  };
}

/** The product account, fully unprovisioned: staging is deployed, prod resources do not exist yet. */
const productAccount = (): Fake => fakeAccount({ workers: [STAGING_SENTINEL] });

function run(over: Partial<RunOptions> & { gateway: CloudflareGateway }): {
  result: ReturnType<typeof provision>;
  written: Map<string, string>;
  output: string;
} {
  const written = new Map<string, string>();
  const lines: string[] = [];
  const result = provision({
    mode: "dry-run",
    accountId: "acct-product-0000",
    force: false,
    overrideAccountWarning: false,
    configs: fixtureConfigs(),
    confirm: () => "acct-product-0000",
    write: (p, t) => void written.set(p, t),
    log: (l) => void lines.push(l),
    ...over,
  });
  return { result, written, output: lines.join("\n") };
}

// ── 1. the derived map ────────────────────────────────────────────────────────────────────────────────

describe("the binding→resource map is derived from the configs, and shares one id across workers", () => {
  it("groups TENANT_A_DB's four binding sites onto ONE logical database", () => {
    const { resources, conflicts } = derivePlan(fixtureConfigs());
    expect(conflicts).toEqual([]);
    const tenantA = resources.find((r) => r.kind === "d1" && r.resourceName === "shuddl-t-tenant-a-prod");
    expect(tenantA).toBeDefined();
    expect(tenantA?.sites.map((s) => s.worker).sort()).toEqual([
      "shuddl-agents-prod",
      "shuddl-api-prod",
      "shuddl-billing-prod",
      "shuddl-translator-prod",
    ]);
    // Every one of those sites is the SAME binding name — that is what makes them one resource.
    expect(new Set(tenantA?.sites.map((s) => s.binding))).toEqual(new Set(["TENANT_A_DB"]));
  });

  it("covers exactly the resources the prod scopes declare — 6 databases, 2 KV namespaces, 1 bucket", () => {
    const { resources } = derivePlan(fixtureConfigs());
    const kinds = (k: string): string[] => resources.filter((r) => r.kind === k).map((r) => r.resourceName).sort();
    expect(kinds("d1")).toEqual([
      "shuddl-control-prod",
      "shuddl-t-platform-prod",
      "shuddl-t-pool-01-prod",
      "shuddl-t-pool-02-prod",
      "shuddl-t-tenant-a-prod",
      "shuddl-t-tenant-b-prod",
    ]);
    expect(kinds("kv")).toEqual(["shuddl-api-prod-idempotency", "shuddl-mcp-prod-grants"]);
    expect(kinds("r2")).toEqual(["shuddl-evidence-prod"]);
  });

  it("accounts for all 17 D1 binding sites — every database_id an unprovisioned prod blocks on", () => {
    const { resources } = derivePlan(fixtureConfigs());
    const sites = resources.filter((r) => r.kind === "d1").reduce((n, r) => n + r.sites.length, 0);
    expect(sites).toBe(17);
    // 17 sites, 6 databases: the whole point is that 11 of those sites SHARE an id with another.
    expect(resources.filter((r) => r.kind === "d1")).toHaveLength(6);
  });

  it("is derived, not hand-typed: a database renamed in one config splits into two resources and CONFLICTS", () => {
    const configs = fixtureConfigs().map((c) =>
      c.path === "fixture/billing/wrangler.toml"
        ? { ...c, text: c.text.replaceAll('database_name = "shuddl-control-prod"', 'database_name = "shuddl-control-prod-2"') }
        : c,
    );
    const { conflicts } = derivePlan(configs);
    expect(conflicts.map((c) => c.code)).toContain("binding-drift");
    expect(conflicts.find((c) => c.code === "binding-drift")?.detail).toContain("CONTROL_DB");
  });

  it("REFUSES a plan where one logical resource already carries two different real ids", () => {
    const configs = fixtureConfigs().map((c) =>
      c.path === "fixture/agents/wrangler.toml"
        ? { ...c, text: c.text.replaceAll(FIXTURE_D1.TENANT_A_DB.prod, uuidFor(7)) }
        : c.path === "fixture/billing/wrangler.toml"
          ? { ...c, text: c.text.replaceAll(FIXTURE_D1.TENANT_A_DB.prod, uuidFor(8)) }
          : c,
    );
    const { conflicts } = derivePlan(configs);
    expect(conflicts.map((c) => c.code)).toContain("id-divergence");
  });

  it("derives KV titles the way wrangler names its own auto-provisioned resources", () => {
    expect(kvNamespaceTitle("shuddl-api-prod", "IDEMPOTENCY")).toBe("shuddl-api-prod-idempotency");
    expect(kvNamespaceTitle("shuddl-mcp-prod", "GRANTS")).toBe("shuddl-mcp-prod-grants");
  });

  it("shares the preflight's placeholder law rather than re-deciding what 'real' means", () => {
    // If these ever disagreed, the provisioner would overwrite an id the preflight considers real.
    expect(isOverwritable("d1", "00000000-0000-4000-8000-000000000301")).toBe(true);
    expect(isOverwritable("d1", "local-tenant-a")).toBe(true);
    expect(isOverwritable("d1", uuidFor(1))).toBe(false);
    expect(isOverwritable("kv", "0000000000000000000000000000prod")).toBe(true);
    expect(isOverwritable("kv", kvIdFor(1))).toBe(false);
    expect(isOverwritable("r2", "anything")).toBe(false);
  });
});

// ── 2. dry-run mutates nothing ────────────────────────────────────────────────────────────────────────

describe("dry-run", () => {
  it("creates nothing, writes nothing, and is the DEFAULT", () => {
    const fake = productAccount();
    const { result, written, output } = run({ gateway: fake.gateway });
    expect(result.ok).toBe(true);
    expect(result.created).toEqual([]);
    expect(written.size).toBe(0);
    expect(fake.state.d1).toEqual([]);
    expect(fake.state.kv).toEqual([]);
    expect(fake.state.buckets).toEqual([]);
    expect(fake.calls.filter((c) => c.startsWith("create"))).toEqual([]);
    expect(output).toContain("DRY RUN");
  });

  it("names every resource it would create and every config line it would change", () => {
    const { result, output } = run({ gateway: productAccount().gateway });
    expect(result.wouldCreate).toEqual([
      "d1:shuddl-control-prod",
      "d1:shuddl-t-platform-prod",
      "d1:shuddl-t-pool-01-prod",
      "d1:shuddl-t-pool-02-prod",
      "d1:shuddl-t-tenant-a-prod",
      "d1:shuddl-t-tenant-b-prod",
      "kv:shuddl-api-prod-idempotency",
      "kv:shuddl-mcp-prod-grants",
      "r2:shuddl-evidence-prod",
    ]);
    expect(output).toContain("wrangler d1 create shuddl-t-tenant-a-prod");
    expect(output).toContain("wrangler kv namespace create shuddl-mcp-prod-grants");
    expect(output).toContain("wrangler r2 bucket create shuddl-evidence-prod");
    // 19 patch lines: the 17 database_id sites + 2 KV ids.
    expect(output.split("\n").filter((l) => / → "/.test(l)).length).toBe(19);
  });

  it("never prompts the operator, because there is nothing to confirm", () => {
    let asked = 0;
    run({
      gateway: productAccount().gateway,
      confirm: () => {
        asked += 1;
        return "acct-product-0000";
      },
    });
    expect(asked).toBe(0);
  });

  it("prints the account inventory it is judging, so the operator can see the account for themselves", () => {
    const fake = fakeAccount({ workers: [STAGING_SENTINEL, "shuddl-api-prod"], d1: [{ name: "shuddl-control-staging", id: uuidFor(3) }] });
    const { output } = run({ gateway: fake.gateway });
    expect(output).toContain("account acct-product-0000 inventory");
    expect(output).toContain("shuddl-control-staging");
    expect(output).toContain("shuddl-api-prod");
  });

  it("ends by naming the exact next command", () => {
    const { output } = run({ gateway: productAccount().gateway });
    expect(output).toContain(`pnpm exec tsx tools/deploy/preflight.ts --env ${PROD_SCOPE}`);
  });
});

// ── 3. idempotency ────────────────────────────────────────────────────────────────────────────────────

describe("idempotency", () => {
  it("adopts existing resources by name instead of creating a second one", () => {
    const fake = fakeAccount({
      workers: [STAGING_SENTINEL],
      d1: [{ name: "shuddl-t-tenant-a-prod", id: uuidFor(11) }, { name: "shuddl-control-prod", id: uuidFor(12) }],
      kv: [{ title: "shuddl-api-prod-idempotency", id: kvIdFor(13) }],
      buckets: ["shuddl-evidence-prod"],
    });
    const { result } = run({ gateway: fake.gateway, mode: "apply" });
    expect(result.adopted.sort()).toEqual([
      "d1:shuddl-control-prod",
      "d1:shuddl-t-tenant-a-prod",
      "kv:shuddl-api-prod-idempotency",
      "r2:shuddl-evidence-prod",
    ]);
    expect(fake.calls.filter((c) => c.startsWith("createD1"))).toEqual([
      "createD1 shuddl-t-tenant-b-prod",
      "createD1 shuddl-t-platform-prod",
      "createD1 shuddl-t-pool-01-prod",
      "createD1 shuddl-t-pool-02-prod",
    ]);
    expect(fake.calls).not.toContain("createBucket shuddl-evidence-prod");
    // The adopted database keeps its real id in every one of its four workers.
    for (const e of result.edits.filter((x) => x.resourceName === "shuddl-t-tenant-a-prod")) expect(e.to).toBe(uuidFor(11));
  });

  it("a second --apply is a NO-OP: nothing created, nothing written", () => {
    const fake = productAccount();
    const first = run({ gateway: fake.gateway, mode: "apply" });
    expect(first.result.ok).toBe(true);
    expect(first.result.created).toHaveLength(9);
    expect(first.written.size).toBe(5);

    // Re-run against the same account with the configs the first run produced.
    const patched = fixtureConfigs().map((c) => ({ path: c.path, text: first.written.get(c.path) ?? c.text }));
    fake.calls.length = 0;
    const second = run({ gateway: fake.gateway, mode: "apply", configs: patched });
    expect(second.result.noop).toBe(true);
    expect(second.result.ok).toBe(true);
    expect(second.result.created).toEqual([]);
    expect(second.written.size).toBe(0);
    expect(fake.calls.filter((c) => c.startsWith("create"))).toEqual([]);
    expect(second.output).toContain("NO-OP");
  });

  it("does not prompt on a no-op run — there is nothing to confirm", () => {
    const fake = productAccount();
    const first = run({ gateway: fake.gateway, mode: "apply" });
    const patched = fixtureConfigs().map((c) => ({ path: c.path, text: first.written.get(c.path) ?? c.text }));
    let asked = 0;
    run({
      gateway: fake.gateway,
      mode: "apply",
      configs: patched,
      confirm: () => {
        asked += 1;
        return "acct-product-0000";
      },
    });
    expect(asked).toBe(0);
  });

  it("gives every one of the 17 D1 sites the id its logical database actually got", () => {
    const fake = productAccount();
    const { result, written } = run({ gateway: fake.gateway, mode: "apply" });
    expect(result.edits).toHaveLength(19);

    const byName = new Map(fake.state.d1.map((d) => [d.name, d.id]));
    const seen = new Map<string, Set<string>>();
    for (const { path } of fixtureConfigs()) {
      const text = written.get(path);
      if (text === undefined) continue;
      const prod = targetFromWrangler(parseWranglerToml(text), PROD_SCOPE);
      for (const d of prod.d1) {
        expect(d.databaseId, `${path} ${d.binding}`).toBe(byName.get(d.databaseName));
        const ids = seen.get(d.binding) ?? new Set<string>();
        ids.add(d.databaseId);
        seen.set(d.binding, ids);
      }
    }
    // The property, stated directly: one binding, one id, across every worker that binds it.
    for (const [binding, ids] of seen) expect(ids.size, `${binding} resolves to ${ids.size} ids`).toBe(1);
  });

  it("clears every placeholder-resource-id and binding-drift BLOCK the preflight reports for prod", () => {
    const report = (configs: { path: string; text: string }[]) =>
      checkDeployTarget({
        environment: PROD_SCOPE,
        workers: configs.map((c) => targetFromWrangler(parseWranglerToml(c.text), PROD_SCOPE)),
        secrets: {},
        corsOrigins: [],
        now: "2026-07-29T12:00:00.000Z",
      });

    // 19 ids the preflight will not accept: 17 database_id sites + 2 KV namespaces.
    const before = report(fixtureConfigs());
    expect(before.problems.filter((p) => p.code === "placeholder-resource-id")).toHaveLength(19);

    const { written } = run({ gateway: productAccount().gateway, mode: "apply" });
    const after = report(fixtureConfigs().map((c) => ({ path: c.path, text: written.get(c.path) ?? c.text })));
    expect(after.problems.filter((p) => p.code === "placeholder-resource-id")).toEqual([]);
    expect(after.problems.filter((p) => p.code === "binding-drift")).toEqual([]);
    // Still BLOCKED overall, and honestly so: every remaining problem is something this tool does not
    // claim to do — secrets, origins, TSA, backups, and the bindings a config author writes by hand.
    expect(after.ok).toBe(false);
  });
});

// ── 4. refusing to clobber ────────────────────────────────────────────────────────────────────────────

describe("refusing to clobber a real id", () => {
  const handProvisioned = (): { path: string; text: string }[] =>
    fixtureConfigs().map((c) =>
      c.path === "fixture/api/wrangler.toml"
        ? { ...c, text: c.text.replace(/(binding = "CONTROL_DB"\ndatabase_name = "shuddl-control-prod"\ndatabase_id = )"[^"]+"/, `$1"${uuidFor(21)}"`) }
        : c,
    );

  it("aborts, names the id and says why, when the account disagrees with a real id in the config", () => {
    const configs = handProvisioned();
    expect(configs.find((c) => c.path === "fixture/api/wrangler.toml")?.text).toContain(uuidFor(21));

    const fake = fakeAccount({ workers: [STAGING_SENTINEL], d1: [{ name: "shuddl-control-prod", id: uuidFor(22) }] });
    const { result, written, output } = run({ gateway: fake.gateway, mode: "apply", configs });
    expect(result.aborted).toBe("would-clobber-real-id");
    expect(result.exitCode).not.toBe(0);
    expect(written.size).toBe(0);
    expect(fake.calls.filter((c) => c.startsWith("create"))).toEqual([]);
    expect(output).toContain(uuidFor(21));
    expect(output).toContain(uuidFor(22));
    expect(output).toContain("CONTROL_DB");
    expect(output).toContain("--force");
  });

  it("refuses before creating anything when the configs carry ids it would have to clobber", () => {
    // THE ORPHAN WINDOW. The pre-create pass could only ever see resources the account ALREADY had, so in
    // an empty account it had nothing to compare a config id against: all nine resources were created and
    // only THEN did the post-create pass raise would-clobber-real-id. The abort wrote no config, but the
    // resources persisted — a wrong --account-id that happens to clear the marketing heuristic left nine
    // orphaned Cloudflare resources behind, created, billed, and referenced by nothing.
    //
    // Every CONTROL_DB site carries the same real id, so this is a coherent plan (no id-divergence), and
    // the account holds nothing at all. The only correct behaviour is to refuse with the account untouched.
    const configs = fixtureConfigs().map((c) => ({ ...c, text: c.text.replaceAll(FIXTURE_D1.CONTROL_DB.prod, uuidFor(23)) }));
    const fake = productAccount(); // the staging sentinel is deployed; not one prod resource exists
    const { result, written, output } = run({ gateway: fake.gateway, mode: "apply", configs });

    expect(fake.calls.filter((c) => c.startsWith("create"))).toEqual([]);
    expect(result.created).toEqual([]);
    expect(fake.state.d1).toEqual([]);
    expect(fake.state.kv).toEqual([]);
    expect(fake.state.buckets).toEqual([]);

    expect(result.aborted).toBe("would-clobber-real-id");
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(written.size).toBe(0);
    expect(output).toContain(uuidFor(23));
    expect(output).toContain("CONTROL_DB");
    expect(output).toContain("shuddl-control-prod");
    expect(output).toContain("--force");
  });

  it("still creates under --force, because the refusal is a guard and not a wall", () => {
    const configs = fixtureConfigs().map((c) => ({ ...c, text: c.text.replaceAll(FIXTURE_D1.CONTROL_DB.prod, uuidFor(23)) }));
    const fake = productAccount();
    const { result } = run({ gateway: fake.gateway, mode: "apply", configs, force: true });
    expect(result.aborted).toBeNull();
    expect(result.created).toHaveLength(9);
  });

  it("overwrites it only with --force", () => {
    const fake = fakeAccount({ workers: [STAGING_SENTINEL], d1: [{ name: "shuddl-control-prod", id: uuidFor(22) }] });
    const { result, written } = run({ gateway: fake.gateway, mode: "apply", configs: handProvisioned(), force: true });
    expect(result.aborted).toBeNull();
    expect(result.refusals).toEqual([]);
    const api = written.get("fixture/api/wrangler.toml") ?? "";
    expect(api).toContain(uuidFor(22));
    expect(api).not.toContain(uuidFor(21));
  });

  it("treats a real id that already MATCHES the account as done, not as a conflict", () => {
    const configs = fixtureConfigs().map((c) =>
      c.path === "fixture/api/wrangler.toml"
        ? { ...c, text: c.text.replaceAll(FIXTURE_D1.CONTROL_DB.prod, uuidFor(31)) }
        : c,
    );
    const fake = fakeAccount({ workers: [STAGING_SENTINEL], d1: [{ name: "shuddl-control-prod", id: uuidFor(31) }] });
    const { result } = run({ gateway: fake.gateway, mode: "apply", configs });
    expect(result.refusals).toEqual([]);
    // api is already correct; the other four CONTROL_DB sites still hold placeholders and get patched.
    expect(result.edits.filter((e) => e.resourceName === "shuddl-control-prod").map((e) => e.config).sort()).toEqual([
      "fixture/agents/wrangler.toml",
      "fixture/billing/wrangler.toml",
      "fixture/mcp/wrangler.toml",
      "fixture/translator/wrangler.toml",
    ]);
  });

  it("never writes a value that is not a real Cloudflare id, even if asked directly", () => {
    const edit: ConfigEdit = {
      config: "workers/api/wrangler.toml",
      header: "[[env.prod.d1_databases]]",
      binding: "CONTROL_DB",
      key: "database_id",
      from: "00000000-0000-4000-8000-000000000303",
      to: "(the id Cloudflare assigns at create)",
      resourceName: "shuddl-control-prod",
    };
    expect(() => patchProdIds("", [edit])).toThrow(/not a real Cloudflare id/);
    expect(() => patchProdIds("", [{ ...edit, to: "local-control" }])).toThrow(/not a real Cloudflare id/);
  });
});

// ── 5. the patch touches only [env.prod] ──────────────────────────────────────────────────────────────

describe("patching touches only [env.prod]", () => {
  it("leaves the dev and staging scopes byte-identical", () => {
    const { written } = run({ gateway: productAccount().gateway, mode: "apply" });
    expect(written.size).toBe(5);
    for (const { path, text } of fixtureConfigs()) {
      const after = written.get(path);
      expect(after, path).toBeDefined();
      for (const scope of [undefined, "staging"] as const) {
        const b = targetFromWrangler(parseWranglerToml(text), scope);
        const a = targetFromWrangler(parseWranglerToml(after ?? ""), scope);
        expect(a, `${path} ${scope ?? "dev"} scope changed`).toEqual(b);
      }
    }
  });

  it("changes ONLY database_id / id lines — never a name, a binding, a comment or a blank line", () => {
    const { written } = run({ gateway: productAccount().gateway, mode: "apply" });
    for (const { path, text } of fixtureConfigs()) {
      const before = text.split("\n");
      const after = (written.get(path) ?? "").split("\n");
      expect(after, path).toHaveLength(before.length);
      for (let i = 0; i < before.length; i += 1) {
        if (before[i] === after[i]) continue;
        expect(before[i], `${path} line ${i + 1}`).toMatch(/^(database_id|id) = "/);
        expect(after[i], `${path} line ${i + 1}`).toMatch(/^(database_id|id) = "/);
      }
    }
  });

  it("preserves every comment in the file", () => {
    const { written } = run({ gateway: productAccount().gateway, mode: "apply" });
    for (const { path, text } of fixtureConfigs()) {
      const comments = (s: string): string[] => s.split("\n").filter((l) => l.trimStart().startsWith("#"));
      expect(comments(written.get(path) ?? ""), path).toEqual(comments(text));
    }
  });

  it("ignores an identically-named binding in another scope", () => {
    // The staging CONTROL_DB has the same binding name and the same id KEY. A patcher that matched on the
    // binding alone would rewrite staging's live database id.
    const toml = [
      "[[d1_databases]]",
      'binding = "CONTROL_DB"',
      'database_id = "local-control"',
      "",
      "[[env.staging.d1_databases]]",
      'binding = "CONTROL_DB"',
      'database_id = "8e238970-2ed3-494d-960f-e4af082c1e8e"',
      "",
      "[[env.prod.d1_databases]]",
      'binding = "CONTROL_DB"',
      'database_name = "shuddl-control-prod" # keep me',
      'database_id = "00000000-0000-4000-8000-000000000303"',
      "",
    ].join("\n");
    const out = patchProdIds(toml, [
      {
        config: "x",
        header: "[[env.prod.d1_databases]]",
        binding: "CONTROL_DB",
        key: "database_id",
        from: "00000000-0000-4000-8000-000000000303",
        to: uuidFor(41),
        resourceName: "shuddl-control-prod",
      },
    ]);
    expect(out.applied).toHaveLength(1);
    expect(out.unapplied).toEqual([]);
    expect(out.text).toContain('database_id = "local-control"');
    expect(out.text).toContain('database_id = "8e238970-2ed3-494d-960f-e4af082c1e8e"');
    expect(out.text).toContain(`database_id = "${uuidFor(41)}"`);
    expect(out.text).toContain('database_name = "shuddl-control-prod" # keep me');
  });

  it("refuses to patch a file that changed underneath the plan", () => {
    const toml = ['[[env.prod.d1_databases]]', 'binding = "CONTROL_DB"', 'database_id = "00000000-0000-4000-8000-000000000999"'].join("\n");
    expect(() =>
      patchProdIds(toml, [
        { config: "x", header: "[[env.prod.d1_databases]]", binding: "CONTROL_DB", key: "database_id", from: "00000000-0000-4000-8000-000000000303", to: uuidFor(42), resourceName: "shuddl-control-prod" },
      ]),
    ).toThrow(/the file changed underneath this run/);
  });

  it("reports an edit it could not place rather than claiming success", () => {
    const out = patchProdIds('[[env.staging.d1_databases]]\nbinding = "CONTROL_DB"\ndatabase_id = "x"\n', [
      { config: "x", header: "[[env.prod.d1_databases]]", binding: "CONTROL_DB", key: "database_id", from: "x", to: uuidFor(43), resourceName: "shuddl-control-prod" },
    ]);
    expect(out.applied).toEqual([]);
    expect(out.unapplied).toHaveLength(1);
  });
});

// ── 6. the account guard ──────────────────────────────────────────────────────────────────────────────

describe("the marketing-account heuristic", () => {
  const inventory = (over: Partial<AccountInventory> = {}): AccountInventory => ({
    accountId: "acct-0000",
    workersProbed: [MARKETING_WORKER, STAGING_SENTINEL, "shuddl-api-prod"],
    workersPresent: [],
    d1: [],
    kv: [],
    buckets: [],
    ...over,
  });

  it("FIRES when the marketing worker is present and the staging sentinel is not", () => {
    const v = assessAccount(inventory({ workersPresent: [MARKETING_WORKER] }));
    expect(v.looksLikeMarketing).toBe(true);
    expect(v.warnings.join(" ")).toContain("MARKETING account");
  });

  it("does NOT fire on the product account, where both are present", () => {
    const v = assessAccount(inventory({ workersPresent: [MARKETING_WORKER, STAGING_SENTINEL], d1: [{ name: "shuddl-control-staging", id: uuidFor(1) }] }));
    expect(v.looksLikeMarketing).toBe(false);
    expect(v.unrecognized).toBe(false);
    expect(v.warnings).toEqual([]);
  });

  it("flags an account that looks like neither", () => {
    const v = assessAccount(inventory({ workersPresent: [], d1: [{ name: "someone-elses-db", id: uuidFor(1) }] }));
    expect(v.looksLikeMarketing).toBe(false);
    expect(v.unrecognized).toBe(true);
  });

  it("ABORTS the run before creating anything, and says how to override", () => {
    const fake = fakeAccount({ workers: [MARKETING_WORKER] });
    const { result, written, output } = run({ gateway: fake.gateway, mode: "apply" });
    expect(result.aborted).toBe("marketing-account");
    expect(result.exitCode).not.toBe(0);
    expect(fake.state.d1).toEqual([]);
    expect(fake.calls.filter((c) => c.startsWith("create"))).toEqual([]);
    expect(written.size).toBe(0);
    expect(output).toContain("MARKETING ACCOUNT");
    expect(output).toContain("--override-account-warning");
  });

  it("aborts a DRY RUN too, so the operator learns before they reach for --apply", () => {
    const { result } = run({ gateway: fakeAccount({ workers: [MARKETING_WORKER] }).gateway });
    expect(result.aborted).toBe("marketing-account");
  });

  it("proceeds with --override-account-warning", () => {
    const fake = fakeAccount({ workers: [MARKETING_WORKER] });
    const { result } = run({ gateway: fake.gateway, mode: "apply", overrideAccountWarning: true });
    expect(result.aborted).toBeNull();
    expect(result.created).toHaveLength(9);
  });

  it("probes the marketing worker, the staging sentinel and every prod worker by name", () => {
    const { resources } = derivePlan(fixtureConfigs());
    expect(probeNames(resources)).toEqual([
      "shuddl-agents-prod",
      "shuddl-api-prod",
      MARKETING_WORKER,
      "shuddl-billing-prod",
      "shuddl-mcp-prod",
      STAGING_SENTINEL,
      "shuddl-translator-prod",
    ].sort());
  });
});

describe("the confirmation gate", () => {
  it("creates nothing when the operator does not retype the account id", () => {
    const fake = productAccount();
    const { result, written } = run({ gateway: fake.gateway, mode: "apply", confirm: () => "" });
    expect(result.aborted).toBe("unconfirmed");
    expect(fake.state.d1).toEqual([]);
    expect(written.size).toBe(0);
  });

  it("creates nothing when the operator types a DIFFERENT account id", () => {
    const fake = productAccount();
    const { result } = run({ gateway: fake.gateway, mode: "apply", confirm: () => "acct-marketing-9999" });
    expect(result.aborted).toBe("unconfirmed");
    expect(fake.calls.filter((c) => c.startsWith("create"))).toEqual([]);
  });

  it("is asked exactly once, and only before any resource exists", () => {
    const fake = productAccount();
    const asks: string[] = [];
    run({
      gateway: fake.gateway,
      mode: "apply",
      confirm: (q) => {
        asks.push(q);
        expect(fake.calls.filter((c) => c.startsWith("create"))).toEqual([]);
        return "acct-product-0000";
      },
    });
    expect(asks).toHaveLength(1);
    expect(asks[0]).toContain("acct-product-0000");
  });
});

// ── 7. the wrangler seam ──────────────────────────────────────────────────────────────────────────────

describe("the wrangler gateway", () => {
  it("asks for JSON where wrangler offers it and parses what wrangler actually prints", () => {
    const seen: string[][] = [];
    const gw = wranglerGateway((args) => {
      seen.push(args);
      if (args[0] === "d1") return { status: 0, stdout: `[\n  {\n    "uuid": "${uuidFor(51)}",\n    "name": "shuddl-control-prod",\n    "version": "production"\n  }\n]`, stderr: "" };
      if (args[0] === "kv") return { status: 0, stdout: `[\n  {\n    "id": "${kvIdFor(52)}",\n    "title": "shuddl-api-prod-idempotency"\n  }\n]`, stderr: "" };
      return { status: 0, stdout: "Listing buckets...\nname: shuddl-evidence-prod\ncreation_date: 2026-07-01", stderr: "" };
    });
    // `d1 list --json` prints a JSON document in column zero; a wrangler notice above it must not be
    // mistaken for the start of that document.
    expect(
      wranglerGateway(() => ({ status: 0, stdout: `▲ [WARNING] Something\n[\n  {"uuid":"${uuidFor(53)}","name":"n"}\n]`, stderr: "" })).listD1(),
    ).toEqual([{ name: "n", id: uuidFor(53) }]);
    expect(gw.listD1()).toEqual([{ name: "shuddl-control-prod", id: uuidFor(51) }]);
    expect(gw.listKv()).toEqual([{ title: "shuddl-api-prod-idempotency", id: kvIdFor(52) }]);
    expect(gw.listBuckets()).toEqual(["shuddl-evidence-prod"]);
    expect(seen).toEqual([["d1", "list", "--json"], ["kv", "namespace", "list"], ["r2", "bucket", "list"]]);
  });

  it("passes the KV namespace TITLE as the positional, because that is verbatim what wrangler titles it", () => {
    const seen: string[][] = [];
    wranglerGateway((args) => {
      seen.push(args);
      return { status: 0, stdout: "", stderr: "" };
    }).createKv("shuddl-mcp-prod-grants");
    // No --env: wrangler computes the title as `${env ? env + "-" : ""}${positional}`, so an --env here
    // would silently produce "prod-shuddl-mcp-prod-grants".
    expect(seen).toEqual([["kv", "namespace", "create", "shuddl-mcp-prod-grants"]]);
  });

  it("throws rather than pretending an empty result when wrangler fails", () => {
    const failing = wranglerGateway(() => ({ status: 1, stdout: "", stderr: "Authentication error [code: 10000]" }));
    expect(() => failing.listD1()).toThrow(/Authentication error/);
    expect(() => failing.createD1("shuddl-control-prod")).toThrow(/failed/);
    expect(failing.bucketExists("shuddl-evidence-prod")).toBe(false);
    expect(failing.workerExists("shuddl-api-prod")).toBe(false);
    // null, not [] — an unreadable bucket list is not an empty account.
    expect(failing.listBuckets()).toBeNull();
  });

  it("throws on unparseable output instead of silently adopting nothing", () => {
    const garbage = wranglerGateway(() => ({ status: 0, stdout: "▲ [WARNING] something\n", stderr: "" }));
    expect(() => garbage.listD1()).toThrow(/printed no JSON/);
  });
});

// ── 8. the honest failure ─────────────────────────────────────────────────────────────────────────────

describe("when the account does not agree that a resource exists", () => {
  it("writes no config after a create the account does not list", () => {
    const fake = productAccount();
    const gateway: CloudflareGateway = { ...fake.gateway, createD1: () => undefined }; // create silently no-ops
    const { result, written } = run({ gateway, mode: "apply" });
    expect(result.aborted).toBe("unresolved-after-create");
    expect(written.size).toBe(0);
  });

  // The very first real dry-run hit this: the API token carried no `r2` scope, so `r2 bucket list` failed.
  // A swallowed failure would have reported "no buckets", concluded the evidence bucket was missing, and
  // found out only from a create that failed AFTER eight databases already existed.
  it("does not read an unreadable R2 store as an empty one", () => {
    const fake = fakeAccount({ workers: [STAGING_SENTINEL], r2Unreadable: true });
    const { result, output } = run({ gateway: fake.gateway });
    expect(result.inventory?.buckets).toBeNull();
    expect(output).toContain("COULD NOT READ");
    expect(output).toContain("R2 IS UNREADABLE");
  });

  it("ABORTS an --apply before creating anything when R2 cannot be read", () => {
    const fake = fakeAccount({ workers: [STAGING_SENTINEL], r2Unreadable: true });
    const { result, written } = run({ gateway: fake.gateway, mode: "apply" });
    expect(result.aborted).toBe("r2-unreadable");
    expect(result.exitCode).not.toBe(0);
    expect(fake.state.d1).toEqual([]);
    expect(fake.calls.filter((c) => c.startsWith("create"))).toEqual([]);
    expect(written.size).toBe(0);
  });

  it("aborts on a config with no prod scope rather than guessing one", () => {
    const { result, output } = run({
      gateway: productAccount().gateway,
      configs: [{ path: "workers/ghost/wrangler.toml", text: 'name = "shuddl-ghost-dev"\n' }],
    });
    expect(result.aborted).toBe("plan-conflict");
    expect(output).toContain("no-prod-scope");
  });
});

// ── 9. the plan/patch contract in isolation ───────────────────────────────────────────────────────────

describe("planPatches", () => {
  const resource = (over: Partial<PlannedResource> = {}): PlannedResource => ({
    kind: "d1",
    resourceName: "shuddl-control-prod",
    sites: [
      { config: "a.toml", worker: "shuddl-api-prod", binding: "CONTROL_DB", currentId: "00000000-0000-4000-8000-000000000303" },
      { config: "b.toml", worker: "shuddl-billing-prod", binding: "CONTROL_DB", currentId: "00000000-0000-4000-8000-000000000303" },
    ],
    ...over,
  });

  it("emits one edit per binding site, all carrying the same id", () => {
    const { edits } = planPatches([resource()], new Map([["d1:shuddl-control-prod", uuidFor(61)]]), { force: false });
    expect(edits).toHaveLength(2);
    expect(new Set(edits.map((e) => e.to))).toEqual(new Set([uuidFor(61)]));
    expect(edits.every((e) => e.header === "[[env.prod.d1_databases]]")).toBe(true);
  });

  it("emits nothing for an unresolved resource", () => {
    expect(planPatches([resource()], new Map(), { force: false }).edits).toEqual([]);
  });

  it("emits nothing for r2, which has no id to write", () => {
    const r = resource({ kind: "r2", resourceName: "shuddl-evidence-prod", sites: [{ config: "a.toml", worker: "shuddl-api-prod", binding: "EVIDENCE", currentId: "" }] });
    expect(planPatches([r], new Map([["r2:shuddl-evidence-prod", "(exists)"]]), { force: false }).edits).toEqual([]);
  });

  it("counts a matching site as already correct rather than editing it", () => {
    const r = resource({ sites: [{ config: "a.toml", worker: "shuddl-api-prod", binding: "CONTROL_DB", currentId: uuidFor(62) }] });
    const out = planPatches([r], new Map([["d1:shuddl-control-prod", uuidFor(62)]]), { force: false });
    expect(out.edits).toEqual([]);
    expect(out.alreadyCorrect).toHaveLength(1);
  });
});

// ── 10. the committed configs, in whatever state of provisioning they are in ──────────────────────────

describe("the real [env.prod] scopes", () => {
  // THE ONLY TEST IN THIS FILE THAT READS workers/*/wrangler.toml, and it asserts nothing about WHETHER
  // production is provisioned — that is a fact about an account, it changes the hour an operator runs the
  // command, and a test that pins it fails on success. It asserts that whatever state those files are in
  // is a COHERENT one. Every clause below held on the all-zero configs this tool was written against and
  // holds on the provisioned ones, which is the definition of the right thing to lock:
  //
  //   · the plan sees every id the preflight sees — no binding silently dropped from the provisioner's view
  //   · no id is a hand-typed invention: it is either the sentinel of a scope that says "not provisioned"
  //     or a well-formed Cloudflare id. A `local-` alias, a truncated uuid or a plausible-looking guess is
  //     none of those — a well-formed random UUID in billing's staging scope once made a database that did
  //     not exist read as provisioned
  //   · one logical resource carries ONE id in every worker that binds it
  //
  // The last is the one that catches a REAL mis-provisioning: a single transposed character in one of the
  // four files that bind TENANT_A_DB splits the ledger's events across two databases while every other
  // test in this repo stays green.
  it("are internally coherent, provisioned or not", () => {
    const configs = realConfigs();
    const { resources, conflicts } = derivePlan(configs);
    expect(conflicts).toEqual([]);

    const declared = configs.map((c) => targetFromWrangler(parseWranglerToml(c.text), PROD_SCOPE));
    const sitesOf = (kind: string): number => resources.filter((r) => r.kind === kind).reduce((n, r) => n + r.sites.length, 0);
    expect(sitesOf("d1")).toBe(declared.reduce((n, t) => n + t.d1.length, 0));
    expect(sitesOf("kv")).toBe(declared.reduce((n, t) => n + t.kv.length, 0));
    expect(sitesOf("r2")).toBe(declared.reduce((n, t) => n + t.r2.length, 0));

    for (const r of resources) {
      const ids = new Set(r.sites.map((s) => s.currentId));
      expect(ids.size, `${r.resourceName} carries ${ids.size} ids across ${r.sites.length} binding sites`).toBe(1);
      if (r.kind === "r2") continue; // bound by name; there is no id

      const kind = r.kind === "kv" ? "kv" : "d1";
      for (const s of r.sites) {
        const why = placeholderReason(kind, s.currentId, PROD_SCOPE);
        if (why === null) continue; // a well-formed Cloudflare id
        // Not provisioned is fine. Only the DELIBERATE sentinel is fine: pinning the exact reason keeps
        // "unprovisioned" from quietly widening to cover a malformed or invented id.
        expect(why, `${s.config} ${s.binding} = ${s.currentId}`).toBe(kind === "kv" ? "not a 32-hex KV namespace id" : "an all-zero placeholder UUID");
        expect(s.currentId, `${s.config} ${s.binding}`).toMatch(kind === "kv" ? /^.{32}$/ : /^0{8}-0000-4000-8000-[0-9a-f]{12}$/);
      }
    }
  });
});
