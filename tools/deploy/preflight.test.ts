import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  checkDeployTarget,
  parseWranglerToml,
  targetFromWrangler,
  REQUIRED_BINDINGS,
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
  // A dry-run against the committed configs. This is a REGRESSION LOCK on a known, documented defect:
  // workers/api/wrangler.toml declares [env.prod] with a name and nothing else, so `wrangler deploy
  // --env prod` would ship a worker with zero bindings. Task 15 records it; it is not silently fixed here
  // because provisioning prod resources is an external hold (no account, no ids).
  it("finds the api [env.prod] scope declaring no bindings", () => {
    const doc = parseWranglerToml(readFileSync("workers/api/wrangler.toml", "utf8"));
    const prod = targetFromWrangler(doc, "prod");
    expect(prod.worker).toBe("shuddl-api-prod");
    expect(prod.d1).toEqual([]);
    expect(prod.kv).toEqual([]);
    expect(prod.r2).toEqual([]);

    const report = checkDeployTarget({
      environment: "prod",
      workers: [prod],
      secrets: {},
      corsOrigins: [],
      now: NOW,
    });
    expect(report.ok).toBe(false);
    expect(report.problems.filter((p) => p.severity === "BLOCK").length).toBeGreaterThan(3);
  });

  it("parses every committed wrangler config without throwing", () => {
    for (const f of [
      "workers/api/wrangler.toml",
      "workers/agents/wrangler.toml",
      "workers/billing/wrangler.toml",
      "workers/mcp/wrangler.toml",
      "workers/translator/wrangler.toml",
    ]) {
      const doc = parseWranglerToml(readFileSync(f, "utf8"));
      expect(targetFromWrangler(doc, undefined).worker, f).toMatch(/^shuddl-/);
      expect(targetFromWrangler(doc, "staging").worker, f).toMatch(/-staging$/);
    }
  });

  it("confirms the staging PLATFORM_TENANT_DB drift between api and billing is still present", () => {
    const api = targetFromWrangler(parseWranglerToml(readFileSync("workers/api/wrangler.toml", "utf8")), "staging");
    const billing = targetFromWrangler(parseWranglerToml(readFileSync("workers/billing/wrangler.toml", "utf8")), "staging");
    const report = checkDeployTarget({ environment: "staging", workers: [api, billing], secrets: {}, corsOrigins: [], now: NOW });
    expect(report.problems.map((p) => p.code)).toContain("binding-drift");
  });
});
