import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  checkDeployTarget,
  parseWranglerToml,
  targetFromWrangler,
  REQUIRED_BINDINGS,
  WORKER_CONFIGS,
  RPO_HOURS,
  BACKUP_RETENTION_DAYS,
  TEST_JWT_CANARY,
  type DeployTarget,
  type WorkerTarget,
} from "./preflight.js";

// V1 remediation Task 15 (REQ-288/REQ-114/REQ-117/REQ-284) — the environment preflight.
//
// A deploy is not "probably fine". Every binding the code dereferences, every secret it reads, every
// cross-script Durable Object and service target, the environment's own identity, the sender, the TSA,
// and the backup posture are checked BEFORE promotion, and anything unproven comes back as a structured
// BLOCK. The checker is PURE (no network, no wrangler, no account) so it is unit-testable; the CLI reads
// the real configuration and feeds it in. A BLOCK is never a warning and never a green.

const NOW = "2026-07-24T12:00:00.000Z";

function worker(over: Partial<WorkerTarget> & { worker: string }): WorkerTarget {
  return {
    environment: "staging",
    d1: [],
    r2: [],
    kv: [],
    queueProducers: [],
    queueConsumers: [],
    durableObjects: [],
    services: [],
    vars: { ENVIRONMENT: "staging" },
    routes: [],
    crons: [],
    ...over,
  };
}

// A fully-provisioned staging target: every required binding present with real-looking ids.
function healthyApi(env = "staging"): WorkerTarget {
  return worker({
    worker: `shuddl-api-${env}`,
    environment: env,
    vars: { ENVIRONMENT: env },
    d1: REQUIRED_BINDINGS.api.d1.map((b, i) => ({
      binding: b,
      databaseName: `shuddl-${b.toLowerCase()}-${env}`,
      databaseId: `1742fef3-f7bf-4d1a-9aaa-bf936699452${i}`,
    })),
    kv: [{ binding: "IDEMPOTENCY", id: "119880a9442c4b8cae8383183a2877e1" }],
    r2: [{ binding: "EVIDENCE", bucketName: `shuddl-evidence-${env}` }],
    durableObjects: [{ binding: "SHIPMENT_SEQ", className: "ShipmentSequencer" }],
    queueProducers: [{ binding: "AGENT_QUEUE", queue: `shuddl-agent-triggers-${env}` }],
  });
}

function healthyTarget(over: Partial<DeployTarget> = {}): DeployTarget {
  return {
    environment: "staging",
    workers: [healthyApi()],
    secrets: { JWT_SECRET: "a-real-staging-secret" },
    corsOrigins: ["https://command.staging.shuddl.tech"],
    sender: { from: "SHUDDL <pod@send.shuddl.tech>", domainVerified: true },
    tsa: { url: "https://freetsa.org/tsr" },
    backups: { lastManifestAt: "2026-07-24T06:00:00.000Z", retentionDays: BACKUP_RETENTION_DAYS },
    now: NOW,
    ...over,
  };
}

const blocks = (t: DeployTarget): string[] => checkDeployTarget(t).problems.filter((p) => p.severity === "BLOCK").map((p) => p.code);

describe("a fully-provisioned target", () => {
  it("passes with no BLOCK", () => {
    const report = checkDeployTarget(healthyTarget());
    expect(report.problems.filter((p) => p.severity === "BLOCK")).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("reports ok=false whenever any BLOCK exists, in every case", () => {
    const broken: DeployTarget[] = [
      healthyTarget({ workers: [worker({ worker: "shuddl-api-staging" })] }),
      healthyTarget({ secrets: {} }),
      healthyTarget({ backups: undefined }),
      healthyTarget({ tsa: {} }),
    ];
    for (const t of broken) {
      const r = checkDeployTarget(t);
      expect(r.problems.some((p) => p.severity === "BLOCK")).toBe(true);
      expect(r.ok).toBe(false);
    }
  });
});

describe("binding completeness", () => {
  it("BLOCKS a worker deployed with no bindings at all (the [env.prod] shape)", () => {
    const t = healthyTarget({ environment: "prod", workers: [worker({ worker: "shuddl-api-prod", environment: "prod", vars: { ENVIRONMENT: "prod" } })] });
    const codes = blocks(t);
    expect(codes).toContain("missing-d1-binding");
    expect(codes).toContain("missing-kv-binding");
    expect(codes).toContain("missing-r2-binding");
    expect(codes).toContain("missing-do-binding");
    expect(codes).toContain("missing-queue-producer");
  });

  it("names the exact missing binding so the operator can provision it", () => {
    const api = healthyApi();
    const t = healthyTarget({ workers: [{ ...api, d1: api.d1.filter((d) => d.binding !== "CONTROL_DB") }] });
    const problem = checkDeployTarget(t).problems.find((p) => p.code === "missing-d1-binding");
    expect(problem?.detail).toContain("CONTROL_DB");
    expect(problem?.severity).toBe("BLOCK");
  });

  it("ignores unknown workers rather than inventing requirements for them", () => {
    const t = healthyTarget({ workers: [healthyApi(), worker({ worker: "shuddl-experiment-staging" })] });
    expect(blocks(t)).toEqual([]);
  });
});

describe("placeholder and local resource ids", () => {
  it("BLOCKS an all-zero placeholder D1 id outside dev", () => {
    const api = healthyApi();
    const t = healthyTarget({
      workers: [{ ...api, d1: api.d1.map((d) => (d.binding === "PLATFORM_TENANT_DB" ? { ...d, databaseId: "00000000-0000-4000-8000-000000000014" } : d)) }],
    });
    expect(blocks(t)).toContain("placeholder-resource-id");
  });

  it("BLOCKS a malformed KV namespace id", () => {
    const api = healthyApi();
    const t = healthyTarget({ workers: [{ ...api, kv: [{ binding: "IDEMPOTENCY", id: "0000000000000000000000000000staging" }] }] });
    expect(blocks(t)).toContain("placeholder-resource-id");
  });

  it("BLOCKS a local-* dev id used in staging or prod", () => {
    const api = healthyApi();
    const t = healthyTarget({ workers: [{ ...api, d1: api.d1.map((d) => (d.binding === "CONTROL_DB" ? { ...d, databaseId: "local-control" } : d)) }] });
    expect(blocks(t)).toContain("placeholder-resource-id");
  });

  it("permits local-* ids in dev, where they are the point", () => {
    const api = healthyApi("dev");
    const t = healthyTarget({
      environment: "dev",
      workers: [{ ...api, d1: api.d1.map((d) => ({ ...d, databaseId: `local-${d.binding.toLowerCase()}` })) }],
    });
    expect(blocks(t)).not.toContain("placeholder-resource-id");
  });
});

describe("environment identity", () => {
  it("BLOCKS a worker whose ENVIRONMENT var disagrees with the target", () => {
    const t = healthyTarget({ workers: [{ ...healthyApi(), vars: { ENVIRONMENT: "dev" } }] });
    expect(blocks(t)).toContain("environment-identity");
  });

  it("BLOCKS a worker whose deployed name does not carry the target environment suffix", () => {
    const t = healthyTarget({ workers: [{ ...healthyApi(), worker: "shuddl-api-dev" }] });
    expect(blocks(t)).toContain("environment-identity");
  });

  it("BLOCKS a staging-only sending var leaking into prod", () => {
    const api = healthyApi("prod");
    const t = healthyTarget({
      environment: "prod",
      workers: [{ ...api, vars: { ENVIRONMENT: "prod", ALLOW_TEST_SEND: "1" } }],
      corsOrigins: ["https://command.shuddl.tech"],
    });
    expect(blocks(t)).toContain("test-affordance-in-prod");
  });
});

describe("cross-worker references", () => {
  it("BLOCKS a cross-script Durable Object whose target worker is not in this deploy", () => {
    const t = healthyTarget({
      workers: [
        healthyApi(),
        worker({
          worker: "shuddl-agents-staging",
          d1: REQUIRED_BINDINGS.agents.d1.map((b) => ({ binding: b, databaseName: `db-${b}`, databaseId: `id-${b}-aaaa-4000-8000-abcdefabcdef` })),
          r2: [{ binding: "EVIDENCE", bucketName: "shuddl-evidence-staging" }],
          queueProducers: [{ binding: "AGENT_QUEUE", queue: "shuddl-agent-triggers-staging" }],
          queueConsumers: [{ queue: "shuddl-agent-triggers-staging", deadLetterQueue: "shuddl-agent-dlq-staging" }],
          durableObjects: [
            { binding: "SHIPMENT_SEQ", className: "ShipmentSequencer", scriptName: "shuddl-api-prod" },
            { binding: "SPARK_METER", className: "SparkMeter" },
          ],
        }),
      ],
    });
    expect(blocks(t)).toContain("unresolved-cross-script");
  });

  it("BLOCKS a service binding pointing at a worker absent from this deploy", () => {
    const t = healthyTarget({
      workers: [healthyApi(), worker({ worker: "shuddl-mcp-staging", services: [{ binding: "API", service: "shuddl-api-nowhere" }] })],
    });
    expect(blocks(t)).toContain("unresolved-service");
  });

  it("BLOCKS a queue consumer with no dead-letter queue (a poison message would loop forever)", () => {
    const t = healthyTarget({
      workers: [healthyApi(), worker({ worker: "shuddl-agents-staging", queueConsumers: [{ queue: "shuddl-agent-triggers-staging" }] })],
    });
    expect(blocks(t)).toContain("queue-without-dlq");
  });

  // A local-* id is a PER-WORKER alias for the same logical database — that is how wrangler's local
  // dev works, and every worker having its own is the design, not a divergence. Reporting it as drift
  // trained the reader to skim past `binding-drift`, which is the one line that must never be noise.
  it("does NOT report drift when one database name carries per-worker local-* aliases in dev", () => {
    const t: DeployTarget = {
      environment: "dev",
      workers: [
        worker({
          worker: "shuddl-api-dev",
          environment: "dev",
          vars: { ENVIRONMENT: "dev" },
          d1: [{ binding: "CONTROL_DB", databaseName: "shuddl-control-dev", databaseId: "local-control" }],
        }),
        worker({
          worker: "shuddl-billing-dev",
          environment: "dev",
          vars: { ENVIRONMENT: "dev" },
          d1: [{ binding: "CONTROL_DB", databaseName: "shuddl-control-dev", databaseId: "local-billing-control" }],
        }),
      ],
      secrets: {},
      corsOrigins: [],
      now: NOW,
    };
    expect(checkDeployTarget(t).problems.map((p) => p.code)).not.toContain("binding-drift");
  });

  it("STILL reports drift when the same binding name maps to two different NAMES, aliases or not", () => {
    const t: DeployTarget = {
      environment: "dev",
      workers: [
        worker({
          worker: "shuddl-api-dev",
          environment: "dev",
          vars: { ENVIRONMENT: "dev" },
          d1: [{ binding: "CONTROL_DB", databaseName: "shuddl-control-dev", databaseId: "local-control" }],
        }),
        worker({
          worker: "shuddl-billing-dev",
          environment: "dev",
          vars: { ENVIRONMENT: "dev" },
          d1: [{ binding: "CONTROL_DB", databaseName: "shuddl-_control-dev", databaseId: "local-control" }],
        }),
      ],
      secrets: {},
      corsOrigins: [],
      now: NOW,
    };
    expect(checkDeployTarget(t).problems.map((p) => p.code)).toContain("binding-drift");
  });

  it("STILL reports drift when two REAL ids diverge under one name", () => {
    const t = healthyTarget({
      workers: [
        worker({
          worker: "shuddl-api-staging",
          d1: [{ binding: "CONTROL_DB", databaseName: "shuddl-control-staging", databaseId: "1742fef3-f7bf-4d1a-9aaa-bf9366994520" }],
        }),
        worker({
          worker: "shuddl-billing-staging",
          d1: [{ binding: "CONTROL_DB", databaseName: "shuddl-control-staging", databaseId: "99999999-f7bf-4d1a-9aaa-bf9366994520" }],
        }),
      ],
    });
    expect(blocks(t)).toContain("binding-drift");
  });

  it("BLOCKS the same logical binding resolving to different databases across workers", () => {
    // The real drift: api PLATFORM_TENANT_DB -> shuddl-t-platform-staging, billing -> shuddl-t-_platform-staging.
    const t = healthyTarget({
      workers: [
        healthyApi(),
        worker({
          worker: "shuddl-billing-staging",
          d1: [{ binding: "PLATFORM_TENANT_DB", databaseName: "shuddl-t-_platform-staging", databaseId: "b7c1f2a4-9d3e-4c8a-b1f6-2e5a7c9d0f13" }],
        }),
      ],
    });
    const problem = checkDeployTarget(t).problems.find((p) => p.code === "binding-drift");
    expect(problem?.severity).toBe("BLOCK");
    expect(problem?.detail).toContain("PLATFORM_TENANT_DB");
  });
});

describe("secrets", () => {
  // The contract is the checker's copy of docs/ops/DEPLOYMENT.md. Where it was EMPTY, the preflight
  // reported a clean bill of health for a worker that cannot do its job: billing cannot verify a Stripe
  // webhook signature and agents cannot send a single evidence email. An unasserted requirement is not
  // a requirement.
  it("requires the secrets billing genuinely cannot run without", () => {
    expect(REQUIRED_BINDINGS.billing.secrets).toContain("STRIPE_WEBHOOK_SECRET");
    expect(REQUIRED_BINDINGS.billing.secrets).toContain("PLATFORM_INTERNAL_SECRET");
  });

  it("requires the sender key agents cannot send without", () => {
    expect(REQUIRED_BINDINGS.agents.secrets).toContain("RESEND_API_KEY");
  });

  it("names those secrets as BLOCKs when they are absent from a real deploy target", () => {
    const t = healthyTarget({
      workers: [worker({ worker: "shuddl-billing-staging" }), worker({ worker: "shuddl-agents-staging" })],
      secrets: {},
    });
    const missing = checkDeployTarget(t).problems.filter((p) => p.code === "missing-secret").map((p) => p.resource);
    expect(missing).toContain("STRIPE_WEBHOOK_SECRET");
    expect(missing).toContain("PLATFORM_INTERNAL_SECRET");
    expect(missing).toContain("RESEND_API_KEY");
  });

  it("BLOCKS a missing required secret", () => {
    expect(blocks(healthyTarget({ secrets: {} }))).toContain("missing-secret");
  });

  it("BLOCKS the in-repo test JWT canary reaching a deployed environment", () => {
    expect(blocks(healthyTarget({ secrets: { JWT_SECRET: TEST_JWT_CANARY } }))).toContain("test-secret-deployed");
  });

  it("never echoes a secret value into a problem detail", () => {
    const report = checkDeployTarget(healthyTarget({ secrets: { JWT_SECRET: TEST_JWT_CANARY } }));
    for (const p of report.problems) expect(p.detail).not.toContain(TEST_JWT_CANARY);
  });
});

describe("origins and public exposure", () => {
  it("BLOCKS a placeholder .example origin in a deployed environment", () => {
    expect(blocks(healthyTarget({ corsOrigins: ["https://command.example.com"] }))).toContain("placeholder-origin");
  });

  it("BLOCKS a wildcard origin", () => {
    expect(blocks(healthyTarget({ corsOrigins: ["*"] }))).toContain("wildcard-origin");
  });

  it("BLOCKS an empty origin allowlist in a deployed environment", () => {
    expect(blocks(healthyTarget({ corsOrigins: [] }))).toContain("no-origins");
  });
});

describe("sender, TSA, and backup posture", () => {
  it("BLOCKS a configured sender whose domain is unverified", () => {
    expect(blocks(healthyTarget({ sender: { from: "SHUDDL <pod@send.shuddl.tech>", domainVerified: false }}))).toContain("sender-unverified");
  });

  it("BLOCKS a missing TSA endpoint (anchors could not be timestamped)", () => {
    expect(blocks(healthyTarget({ tsa: {} }))).toContain("tsa-unconfigured");
  });

  it("BLOCKS when no backup manifest exists at all", () => {
    expect(blocks(healthyTarget({ backups: undefined }))).toContain("no-backup");
  });

  it(`BLOCKS a backup older than the ${RPO_HOURS}h RPO`, () => {
    const stale = new Date(Date.parse(NOW) - (RPO_HOURS + 1) * 3600_000).toISOString();
    const codes = blocks(healthyTarget({ backups: { lastManifestAt: stale, retentionDays: BACKUP_RETENTION_DAYS } }));
    expect(codes).toContain("backup-stale");
  });

  it("accepts a backup inside the RPO window", () => {
    const fresh = new Date(Date.parse(NOW) - 3600_000).toISOString();
    expect(blocks(healthyTarget({ backups: { lastManifestAt: fresh, retentionDays: BACKUP_RETENTION_DAYS } }))).not.toContain("backup-stale");
  });

  it("BLOCKS retention shorter than policy", () => {
    expect(blocks(healthyTarget({ backups: { lastManifestAt: NOW, retentionDays: 3 } }))).toContain("retention-too-short");
  });
});

describe("the wrangler TOML reader", () => {
  const SAMPLE = `
name = "shuddl-api-dev"
main = "src/index.ts"

[vars]
ENVIRONMENT = "dev"

[[d1_databases]]
binding = "CONTROL_DB"
database_name = "shuddl-control-dev"
database_id = "local-control"

[[r2_buckets]]
binding = "EVIDENCE"
bucket_name = "shuddl-evidence-dev"

[[durable_objects.bindings]]
name = "SHIPMENT_SEQ"
class_name = "ShipmentSequencer"

[env.staging]
name = "shuddl-api-staging"

[env.staging.vars]
ENVIRONMENT = "staging"

[[env.staging.d1_databases]]
binding = "CONTROL_DB"
database_name = "shuddl-control-staging"
database_id = "8e238970-2ed3-494d-960f-e4af082c1e8e"
`;

  it("reads the top-level (dev) scope", () => {
    const t = targetFromWrangler(parseWranglerToml(SAMPLE), undefined);
    expect(t.worker).toBe("shuddl-api-dev");
    expect(t.vars["ENVIRONMENT"]).toBe("dev");
    expect(t.d1).toEqual([{ binding: "CONTROL_DB", databaseName: "shuddl-control-dev", databaseId: "local-control" }]);
    expect(t.r2).toEqual([{ binding: "EVIDENCE", bucketName: "shuddl-evidence-dev" }]);
    expect(t.durableObjects).toEqual([{ binding: "SHIPMENT_SEQ", className: "ShipmentSequencer" }]);
  });

  it("reads a named [env.X] scope without inheriting the dev bindings", () => {
    const t = targetFromWrangler(parseWranglerToml(SAMPLE), "staging");
    expect(t.worker).toBe("shuddl-api-staging");
    expect(t.vars["ENVIRONMENT"]).toBe("staging");
    expect(t.d1).toEqual([{ binding: "CONTROL_DB", databaseName: "shuddl-control-staging", databaseId: "8e238970-2ed3-494d-960f-e4af082c1e8e" }]);
    // Wrangler does NOT inherit top-level bindings into a named environment — a scope that declares none
    // really has none, which is exactly the [env.prod] defect this preflight exists to catch.
    expect(t.r2).toEqual([]);
    expect(t.durableObjects).toEqual([]);
  });

  it("ignores comments and blank lines", () => {
    const parsed = parseWranglerToml('# comment\nname = "x" # trailing\n\n[vars]\nA = "b"\n');
    expect(parsed.root["name"]).toBe("x");
  });
});

describe("the real repository configuration", () => {
  // A dry-run against the committed configs. This pinned a known defect — api's [env.prod] declaring a
  // name and nothing else, so `wrangler deploy --env prod` would ship a worker with zero bindings. The
  // scope is now structurally complete, so the lock is INVERTED: it asserts the bindings exist AND that
  // no configuration this repo can commit is by itself enough to call prod deployable. Those are two
  // different claims and both must hold.
  it("declares a COMPLETE api [env.prod] scope that the committed config alone can never make deployable", () => {
    const doc = parseWranglerToml(readFileSync("workers/api/wrangler.toml", "utf8"));
    const prod = targetFromWrangler(doc, "prod");
    expect(prod.worker).toBe("shuddl-api-prod");
    expect(prod.d1.map((d) => d.binding).sort()).toEqual([...REQUIRED_BINDINGS.api.d1].sort());
    expect(prod.kv.map((k) => k.binding)).toEqual(REQUIRED_BINDINGS.api.kv);
    expect(prod.r2.map((r) => r.binding)).toEqual(REQUIRED_BINDINGS.api.r2);
    expect(prod.vars["ENVIRONMENT"]).toBe("prod");

    const report = checkDeployTarget({
      environment: "prod",
      workers: [prod],
      secrets: {},
      corsOrigins: [],
      now: NOW,
    });
    // RETIRED ASSERTION. "Still not deployable" used to be proved by requiring a `placeholder-resource-id`
    // BLOCK — the all-zero ids that stood in [env.prod] until an operator provisioned the account. Those
    // ids are real now, so that proof expired with the state it described, and it was never the durable
    // claim anyway: it said "nobody has provisioned yet", not "this repo cannot certify a deploy on its
    // own". (The old `not.toContain("missing-binding")` line went with it: no check ever emits that code —
    // they are `missing-d1-binding`, `missing-kv-binding` and so on — so it could not have failed.)
    //
    // What replaces it is true in EITHER world. Supplied with no account-side facts — no bound secret
    // names, no origin allowlist, no TSA, no backup manifest — the preflight must still refuse, because
    // an unproven prerequisite is never a green. And every BLOCK it raises must be an account-side fact
    // or an unprovisioned id, NEVER an absent declaration: an absent declaration is the defect this scope
    // was rebuilt to remove, and it would be a merge-time regression rather than a provisioning hold.
    expect(report.ok).toBe(false);
    const codes = report.problems.filter((p) => p.severity === "BLOCK").map((p) => p.code);
    expect(codes).toEqual(expect.arrayContaining(["missing-secret", "no-origins", "tsa-unconfigured", "no-backup"]));
    const accountSideOrUnprovisioned = new Set(["missing-secret", "no-origins", "tsa-unconfigured", "no-backup", "placeholder-resource-id"]);
    expect(codes.filter((c) => !accountSideOrUnprovisioned.has(c))).toEqual([]);
  });

  it("binds no test-only affordance anywhere in prod", () => {
    // ALLOW_TEST_SEND / TEST_SEND_* in a production scope is a live send path with the safety off. The
    // preflight blocks it; this fails at merge, before anyone runs the preflight.
    for (const path of WORKER_CONFIGS) {
      const prod = targetFromWrangler(parseWranglerToml(readFileSync(path, "utf8")), "prod");
      for (const [name] of Object.entries(prod.vars)) {
        expect(name, `${path} binds ${name} in prod`).not.toMatch(/^(ALLOW_TEST_SEND|TEST_SEND_)/);
      }
    }
  });

  it("keeps the CONFIRM-gated and fail-closed omissions OUT of prod", () => {
    // These absences are load-bearing, not oversights, and an absence is exactly what a later "make the
    // scopes symmetrical" edit would helpfully fill in.
    const agents = targetFromWrangler(parseWranglerToml(readFileSync("workers/agents/wrangler.toml", "utf8")), "prod");
    expect(agents.vars["EVIDENCE_FROM"], "agents prod must stay a NotConfiguredSender").toBeUndefined();

    const translator = targetFromWrangler(parseWranglerToml(readFileSync("workers/translator/wrangler.toml", "utf8")), "prod");
    expect(translator.vars["EDI_TRANSPORT_URL"], "the EDI transport is CONFIRM-gated (REQ-154)").toBeUndefined();
    expect(translator.vars["EDI_TRANSPORT_TOKEN"]).toBeUndefined();
  });

  // A route this reader cannot see is reported as "unrouted", which is indistinguishable from a worker
  // that is genuinely unreachable — so a future route check would pass a deployment it never inspected.
  // This bit for real: the prod scopes were routed with `[[env.prod.routes]]` (array of tables) while the
  // reader only accepted bare strings, so all three routed workers parsed as `routes: []` even though
  // wrangler deployed them correctly.
  it("reads every route spelling wrangler accepts, not just bare strings", () => {
    const scope = (body: string): string[] =>
      targetFromWrangler(parseWranglerToml(`name = "w-prod"\n[env.prod]\nname = "w-prod"\n${body}`), "prod").routes;

    expect(scope('routes = ["a.example/*"]')).toEqual(["a.example/*"]);
    expect(scope('[[env.prod.routes]]\npattern = "c.example/*"\nzone_name = "example"')).toEqual(["c.example/*"]);
    expect(scope('route = "d.example/*"')).toEqual(["d.example/*"]);
    expect(scope("")).toEqual([]);
    // A route table with no `pattern` contributes nothing rather than throwing — it is a malformed entry,
    // not an unsupported syntax, and the surrounding scope may still be valid.
    expect(scope("[[env.prod.routes]]\nzone_name = \"example\"")).toEqual([]);

    // INLINE tables are NOT supported by this reader's TOML subset: `routes = [{ pattern = "…" }]` would
    // arrive as comma-split fragments. Silently keeping those would report a worker as routed on a
    // pattern that never parsed, so it throws and names the form to use instead.
    expect(() => scope('routes = [{ pattern = "b.example/*", zone_name = "example" }]')).toThrow(
      /unsupported inline-table route/,
    );
  });

  it("sees the routes the committed prod scopes actually declare", () => {
    // The three workers with a public surface are routed; the two fail-closed ones deliberately are not.
    // agents exposes only handleTestSend (ALLOW_TEST_SEND is banned in prod) and translator only the
    // CONFIRM-gated EDI inbound, so an empty list is the CORRECT answer for those two — which is exactly
    // why the reader has to be able to tell "no route" from "a route I could not parse".
    const routesOf = (w: string): string[] =>
      targetFromWrangler(parseWranglerToml(readFileSync(`workers/${w}/wrangler.toml`, "utf8")), "prod").routes;

    expect(routesOf("api")).toEqual(["api.shuddl.tech/*"]);
    expect(routesOf("mcp")).toEqual(["mcp.shuddl.tech/*"]);
    expect(routesOf("billing")).toEqual(["billing.shuddl.tech/*"]);
    expect(routesOf("agents")).toEqual([]);
    expect(routesOf("translator")).toEqual([]);
  });

  it("parses every committed wrangler config without throwing", () => {
    // WORKER_CONFIGS, not a second hand-typed copy of it: a worker added to the deployable surface must
    // become visible to this check automatically, or the check silently stops covering the repo.
    for (const f of WORKER_CONFIGS) {
      const doc = parseWranglerToml(readFileSync(f, "utf8"));
      expect(targetFromWrangler(doc, undefined).worker, f).toMatch(/^shuddl-/);
      expect(targetFromWrangler(doc, "staging").worker, f).toMatch(/-staging$/);
    }
  });

  it("confirms the staging PLATFORM_TENANT_DB drift between api and billing is CLOSED", () => {
    const api = targetFromWrangler(parseWranglerToml(readFileSync("workers/api/wrangler.toml", "utf8")), "staging");
    const billing = targetFromWrangler(parseWranglerToml(readFileSync("workers/billing/wrangler.toml", "utf8")), "staging");
    const report = checkDeployTarget({ environment: "staging", workers: [api, billing], secrets: {}, corsOrigins: [], now: NOW });
    expect(report.problems.map((p) => p.code)).not.toContain("binding-drift");
  });

  it("never reports the converged platform database as provisioned in one worker and not the other", () => {
    // ORIGINAL INTENT (2026-07-25): closing the api/billing PLATFORM_TENANT_DB drift must not quietly
    // promote a database that did not exist. Billing's old id was a well-formed random UUID that PASSED
    // the placeholder check; converging it onto the api placeholder made both workers block, which was the
    // honest outcome. That version asserted both were placeholders.
    //
    // RETIRED 2026-07-31: `shuddl-t-platform-staging` was created and migrated, so the placeholder
    // assertion now fails for the right reason — the database exists. The intent survives as the property
    // that never expires: whatever the id is, BOTH workers must agree on it, and the preflight must reach
    // the SAME verdict for both. A per-worker divergence is the actual defect, and it is invisible to a
    // test that only checks for placeholders.
    const api = targetFromWrangler(parseWranglerToml(readFileSync("workers/api/wrangler.toml", "utf8")), "staging");
    const billing = targetFromWrangler(parseWranglerToml(readFileSync("workers/billing/wrangler.toml", "utf8")), "staging");
    const idOf = (t: typeof api): string => {
      const d = t.d1.find((x) => x.binding === "PLATFORM_TENANT_DB");
      if (!d) throw new Error(`${t.worker} declares no PLATFORM_TENANT_DB in staging`);
      return `${d.databaseName}|${d.databaseId}`;
    };
    expect(idOf(billing)).toBe(idOf(api));

    const report = checkDeployTarget({ environment: "staging", workers: [api, billing], secrets: {}, corsOrigins: [], now: NOW });
    expect(report.problems.map((p) => p.code)).not.toContain("binding-drift");
    // One resource, one verdict: it is either flagged for BOTH workers or for neither, never for one.
    const flagged = report.problems
      .filter((p) => p.code === "placeholder-resource-id" && p.resource.endsWith(".PLATFORM_TENANT_DB"))
      .map((p) => p.resource);
    expect(flagged.length === 0 || flagged.length === 2, `one-sided verdict: ${flagged.join(", ")}`).toBe(true);
  });

  it("resolves PLATFORM_TENANT_DB to ONE database in every deployable scope", () => {
    // The drift was invisible until someone diffed two files by hand. Pinned as an equality over the
    // parsed configs so a future edit to either side re-opens it here, not in staging.
    for (const scope of ["staging"] as const) {
      const api = targetFromWrangler(parseWranglerToml(readFileSync("workers/api/wrangler.toml", "utf8")), scope);
      const billing = targetFromWrangler(parseWranglerToml(readFileSync("workers/billing/wrangler.toml", "utf8")), scope);
      const platform = (t: typeof api): string => {
        const d = t.d1.find((x) => x.binding === "PLATFORM_TENANT_DB");
        if (!d) throw new Error(`${t.worker} declares no PLATFORM_TENANT_DB in ${scope}`);
        return `${d.databaseName}|${d.databaseId}`;
      };
      expect(platform(billing), `PLATFORM_TENANT_DB diverges in ${scope}`).toBe(platform(api));
    }
  });
});
