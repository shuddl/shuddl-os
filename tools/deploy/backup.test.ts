import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  BACKUP_MANIFEST_VERSION,
  deriveBackupSet,
  exportConfigPath,
  exportFileName,
  manifestDigest,
  runBackup,
  unsignManifest,
  verifyManifestDigest,
  wranglerIo,
  type BackupIo,
  type BackupOptions,
  type SignedBackupManifest,
} from "./backup.js";
import { WORKER_CONFIGS } from "./preflight.js";
import { derivePlan } from "./provision-prod.js";
import { reconcileRestore, snapshotDigest, type ChainVerdict, type LedgerSnapshot } from "./restore-verify.js";
import { gateResultProblem, EVIDENCE_EXIT } from "../release/evidence.js";

// THE BACKUP.
//
// `preflight --env prod` blocks on exactly one thing — `no-backup` — and the only implementation was an
// inline loop in the nightly workflow over four HARDCODED staging database names. Production has six
// databases; staging has six too, so the hardcoded list was already skipping two pool planes in the
// environment it was pointed at. A backup that silently skips a database is discovered on the day it is
// needed, so the properties proven here are:
//
//   1. THE SET IS DERIVED, from the REAL committed configs, and it is complete — six for prod, six for
//      staging, each scope-pure, and identical to the d1 half of the provisioner's own derived plan.
//   2. A PARTIAL EXPORT NEVER GETS A MANIFEST. A database that fails in the middle fails the whole run;
//      an export that "succeeds" and produces nothing, or produces zero bytes, is a failure too.
//   3. THE DIGEST IS THE ONE THE RESTORE READS — restore-verify's own snapshotDigest over the canonical
//      bytes, round-tripping from the written file.
//   4. ABSENT CREDENTIALS ARE BLOCKED, NEVER A PASS, and nothing is exported before they are checked.
//
// Cloudflare lives behind BackupIo, replaced here by a fake: no network, no account, no export. Same
// discipline as preflight.test.ts and provision-prod.test.ts.

const realConfigs = (): { path: string; text: string }[] =>
  WORKER_CONFIGS.map((path) => ({ path: path as string, text: readFileSync(path, "utf8") }));

const PROD_DATABASES = [
  "shuddl-control-prod",
  "shuddl-t-platform-prod",
  "shuddl-t-pool-01-prod",
  "shuddl-t-pool-02-prod",
  "shuddl-t-tenant-a-prod",
  "shuddl-t-tenant-b-prod",
];

// ── a fake account ────────────────────────────────────────────────────────────────────────────────────

type FakeIo = {
  io: BackupIo;
  calls: string[];
  files: Map<string, string>;
  /** databases the fake account refuses to export, and why */
  broken: Map<string, string>;
  /** databases whose export "succeeds" but writes nothing */
  vanishing: Set<string>;
  /** databases whose export writes an empty file */
  empty: Set<string>;
};

function fakeIo(over: Partial<Pick<FakeIo, "broken" | "vanishing" | "empty">> = {}): FakeIo {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const broken = over.broken ?? new Map<string, string>();
  const vanishing = over.vanishing ?? new Set<string>();
  const empty = over.empty ?? new Set<string>();
  return {
    calls,
    files,
    broken,
    vanishing,
    empty,
    io: {
      ensureDir: (path) => void calls.push(`ensureDir ${path}`),
      exportDatabase: (db, out) => {
        calls.push(`export ${db}`);
        const why = broken.get(db);
        if (why !== undefined) return { ok: false, detail: why };
        if (vanishing.has(db)) return { ok: true }; // reported success, wrote nothing
        files.set(out, empty.has(db) ? "" : `-- export of ${db}\nCREATE TABLE events (seq INTEGER);\n`);
        return { ok: true };
      },
      readArtifact: (out) => {
        const text = files.get(out);
        if (text === undefined) throw new Error(`ENOENT: no such file ${out}`);
        return new TextEncoder().encode(text);
      },
      writeFile: (path, text) => void files.set(path, text),
    },
  };
}

function options(over: Partial<BackupOptions> & { io: BackupIo }): BackupOptions {
  return {
    environment: "prod",
    outDir: "artifacts/backup",
    configs: realConfigs(),
    credentialsPresent: true,
    mode: "release",
    commit: "c0ffee0000000000000000000000000000000000",
    takenAt: "2026-07-29T08:00:00.000Z",
    retentionDays: 30,
    dryRun: false,
    log: () => {},
    ...over,
  };
}

async function run(over: Partial<BackupOptions> & { io: BackupIo }): Promise<{ result: Awaited<ReturnType<typeof runBackup>>; output: string }> {
  const lines: string[] = [];
  const result = await runBackup({ ...options(over), log: (l) => void lines.push(l) });
  return { result, output: lines.join("\n") };
}

/** A config text with one d1 binding, for the malformed-config cases. */
function tinyConfig(scope: string, body: string): string {
  return `name = "shuddl-api-dev"\n\n[env.${scope}]\nname = "shuddl-api-${scope}"\n\n${body}\n`;
}

// ── 1. the derived set ────────────────────────────────────────────────────────────────────────────────

describe("the set of databases is derived from the committed configs, never listed", () => {
  it("derives EXACTLY the six production databases", () => {
    const set = deriveBackupSet(realConfigs(), "prod");
    expect(set.problems).toEqual([]);
    expect(set.databases.map((d) => d.databaseName)).toEqual(PROD_DATABASES);
    expect(set.databases).toHaveLength(6);
  });

  it("derives staging's OWN set — including the two pool planes the hardcoded nightly list omitted", () => {
    const set = deriveBackupSet(realConfigs(), "staging");
    expect(set.problems).toEqual([]);
    const names = set.databases.map((d) => d.databaseName);
    // The list that used to be hardcoded in .github/workflows/nightly.yml, for reference:
    const hardcoded = ["shuddl-control-staging", "shuddl-t-tenant-a-staging", "shuddl-t-tenant-b-staging", "shuddl-t-platform-staging"];
    for (const db of hardcoded) expect(names).toContain(db);
    expect(names).toContain("shuddl-t-pool-01-staging");
    expect(names).toContain("shuddl-t-pool-02-staging");
    expect(names).toHaveLength(6);
  });

  it("keeps the two environments disjoint — no scope can leak a database into the other's backup", () => {
    const prod = deriveBackupSet(realConfigs(), "prod").databases.map((d) => d.databaseName);
    const staging = deriveBackupSet(realConfigs(), "staging").databases.map((d) => d.databaseName);
    for (const n of prod) expect(n.endsWith("-prod")).toBe(true);
    for (const n of staging) expect(n.endsWith("-staging")).toBe(true);
    expect(prod.filter((n) => staging.includes(n))).toEqual([]);
  });

  it("groups by database_name, so a database bound by four workers is exported ONCE", () => {
    const set = deriveBackupSet(realConfigs(), "prod");
    const tenantA = set.databases.find((d) => d.databaseName === "shuddl-t-tenant-a-prod");
    expect(tenantA?.sites.length).toBeGreaterThan(1); // api, agents, billing, translator
    expect(new Set(set.databases.map((d) => d.databaseName)).size).toBe(set.databases.length);
  });

  it("agrees with the provisioner's own derived plan — two derivations of one fact cannot drift", () => {
    // provision-prod.ts derives the [env.prod] binding→resource map to CREATE the databases. This derives
    // the same scope to EXPORT them. If they ever disagree, something was created that is not backed up.
    const provisioned = derivePlan(realConfigs())
      .resources.filter((r) => r.kind === "d1")
      .map((r) => r.resourceName)
      .sort();
    expect(deriveBackupSet(realConfigs(), "prod").databases.map((d) => d.databaseName)).toEqual(provisioned);
  });
});

describe("a config the set cannot be derived from is loud, never quietly smaller", () => {
  it("reports a config that declares no scope for the target environment", () => {
    const configs = [...realConfigs(), { path: "workers/ghost/wrangler.toml", text: 'name = "shuddl-ghost-dev"\n' }];
    const set = deriveBackupSet(configs, "prod");
    expect(set.problems.map((p) => p.code)).toContain("no-env-scope");
    expect(set.problems.find((p) => p.code === "no-env-scope")?.resource).toBe("workers/ghost/wrangler.toml");
  });

  it("reports a d1 binding with no database_name", () => {
    const configs = [{ path: "a.toml", text: tinyConfig("prod", '[[env.prod.d1_databases]]\nbinding = "CONTROL_DB"\ndatabase_id = "x"') }];
    expect(deriveBackupSet(configs, "prod").problems.map((p) => p.code)).toContain("unnamed-database");
  });

  it("reports one binding naming two different databases — a restore could not tell which is missing", () => {
    const configs = [
      { path: "a.toml", text: tinyConfig("prod", '[[env.prod.d1_databases]]\nbinding = "CONTROL_DB"\ndatabase_name = "shuddl-control-prod"') },
      { path: "b.toml", text: tinyConfig("prod", '[[env.prod.d1_databases]]\nbinding = "CONTROL_DB"\ndatabase_name = "shuddl-control-prod-2"') },
    ];
    const set = deriveBackupSet(configs, "prod");
    expect(set.problems.map((p) => p.code)).toContain("binding-drift");
  });

  it("reports an environment with no databases at all rather than backing up nothing successfully", () => {
    const configs = [{ path: "a.toml", text: tinyConfig("prod", "") }];
    expect(deriveBackupSet(configs, "prod").problems.map((p) => p.code)).toContain("empty-backup-set");
  });

  it("refuses to export anything when the set is undecidable", async () => {
    const fake = fakeIo();
    const configs = [...realConfigs(), { path: "workers/ghost/wrangler.toml", text: 'name = "shuddl-ghost-dev"\n' }];
    const { result, output } = await run({ io: fake.io, configs });
    expect(result.ok).toBe(false);
    expect(result.gate.status).toBe("FAIL");
    expect(result.exitCode).toBe(EVIDENCE_EXIT.ASSERTIONS_FAILED);
    expect(fake.calls.filter((c) => c.startsWith("export"))).toEqual([]);
    expect(result.manifest).toBeNull();
    expect(output).toContain("no-env-scope");
  });
});

// ── 2. a partial export never becomes a manifest ──────────────────────────────────────────────────────

describe("a complete run", () => {
  it("exports every derived database exactly once and writes one manifest", async () => {
    const fake = fakeIo();
    const { result } = await run({ io: fake.io });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(EVIDENCE_EXIT.OK);
    expect(fake.calls.filter((c) => c.startsWith("export "))).toEqual(PROD_DATABASES.map((d) => `export ${d}`));
    expect(result.manifest?.entries.map((e) => e.database)).toEqual(PROD_DATABASES);
    expect(result.manifestPath).toBe("artifacts/backup/manifest.json");
  });

  it("names every file after its database and records real byte counts and hashes", async () => {
    const fake = fakeIo();
    const { result } = await run({ io: fake.io });
    for (const e of result.manifest?.entries ?? []) {
      expect(e.file).toBe(exportFileName(e.database));
      expect(e.bytes).toBeGreaterThan(0);
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.sha256).toBe(await snapshotDigestOfText(fake.files.get(`artifacts/backup/${e.file}`) ?? ""));
    }
    // Six different databases produce six different exports, so six different hashes.
    expect(new Set((result.manifest?.entries ?? []).map((e) => e.sha256)).size).toBe(6);
  });

  it("emits a PASS the evidence machinery accepts, counting the databases it actually exported", async () => {
    const { result } = await run({ io: fakeIo().io });
    expect(result.gate.gate).toBe("backup-manifest");
    expect(result.gate.status).toBe("PASS");
    expect(result.gate.executed).toBe(true);
    expect(result.gate.assertions).toBe(6);
    expect(gateResultProblem(result.gate)).toBeNull();
  });
});

describe("a partial export is a failure, not a smaller backup", () => {
  it("fails loudly when a database in the MIDDLE of the set cannot be exported, and writes no manifest", async () => {
    const fake = fakeIo({ broken: new Map([["shuddl-t-pool-01-prod", "D1_ERROR: no such database"]]) });
    const { result, output } = await run({ io: fake.io });
    expect(result.ok).toBe(false);
    expect(result.gate.status).toBe("FAIL");
    expect(result.exitCode).toBe(EVIDENCE_EXIT.ASSERTIONS_FAILED);
    expect(result.failures.map((f) => f.database)).toEqual(["shuddl-t-pool-01-prod"]);
    expect(result.manifest).toBeNull();
    expect(fake.files.has("artifacts/backup/manifest.json")).toBe(false);
    expect(output).toContain("shuddl-t-pool-01-prod");
    expect(result.gate.detail).toContain("shuddl-t-pool-01-prod");
  });

  it("still attempts every remaining database, so one run names EVERY missing one", async () => {
    const fake = fakeIo({
      broken: new Map([
        ["shuddl-control-prod", "no such database"],
        ["shuddl-t-tenant-b-prod", "no such database"],
      ]),
    });
    const { result } = await run({ io: fake.io });
    expect(fake.calls.filter((c) => c.startsWith("export "))).toHaveLength(6);
    expect(result.failures.map((f) => f.database)).toEqual(["shuddl-control-prod", "shuddl-t-tenant-b-prod"]);
    expect(result.manifest).toBeNull();
  });

  it("fails an export that reports success but produced no file", async () => {
    const fake = fakeIo({ vanishing: new Set(["shuddl-t-platform-prod"]) });
    const { result } = await run({ io: fake.io });
    expect(result.manifest).toBeNull();
    expect(result.failures[0]?.database).toBe("shuddl-t-platform-prod");
    expect(result.failures[0]?.detail).toContain("could not be read");
  });

  it("fails an export that produced an EMPTY file — a database with tables cannot export to zero bytes", async () => {
    const fake = fakeIo({ empty: new Set(["shuddl-t-tenant-a-prod"]) });
    const { result } = await run({ io: fake.io });
    expect(result.manifest).toBeNull();
    expect(result.failures[0]?.detail).toContain("EMPTY");
  });

  it("never writes a manifest whose entries are a subset of the derived set", async () => {
    for (const victim of PROD_DATABASES) {
      const fake = fakeIo({ broken: new Map([[victim, "boom"]]) });
      const { result } = await run({ io: fake.io });
      expect(result.manifest, victim).toBeNull();
      expect(fake.files.has("artifacts/backup/manifest.json"), victim).toBe(false);
    }
  });
});

// ── 3. the digest the restore reads ───────────────────────────────────────────────────────────────────

describe("the manifest digest is the one tools/deploy/restore-verify.ts consumes", () => {
  it("round-trips from the WRITTEN file: strip the digest, recompute, and it matches", async () => {
    const fake = fakeIo();
    const { result } = await run({ io: fake.io });
    const onDisk = JSON.parse(fake.files.get("artifacts/backup/manifest.json") ?? "") as SignedBackupManifest;
    expect(onDisk.digest).toBe(result.manifest?.digest);
    expect(await verifyManifestDigest(onDisk)).toBe(true);
    // The recipe, spelled out: restore-verify's own snapshotDigest over the manifest body.
    expect(await snapshotDigest(unsignManifest(onDisk))).toBe(onDisk.digest);
    expect(onDisk.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is independent of key order, because the two sides compute it separately", async () => {
    const fake = fakeIo();
    const { result } = await run({ io: fake.io });
    const body = unsignManifest(result.manifest as SignedBackupManifest);
    const reordered = { entries: body.entries, retentionDays: body.retentionDays, takenAt: body.takenAt, commit: body.commit, environment: body.environment, version: body.version };
    expect(await manifestDigest(reordered)).toBe(result.manifest?.digest);
  });

  it("feeds LedgerSnapshot.manifestDigest — an untampered pair reconciles, a tampered one does not", async () => {
    const fake = fakeIo();
    const { result } = await run({ io: fake.io });
    const digest = result.manifest?.digest ?? "";
    const chain: ChainVerdict = { ok: true, head: "a".repeat(64), count: 3 };
    const snap = (manifestDigest_: string): LedgerSnapshot => ({
      tenant: "tenant-a",
      capturedAt: "2026-07-29T08:00:00.000Z",
      events: { count: 3, headHash: "a".repeat(64) },
      invoices: { count: 0, totalCents: 0 },
      moneyLines: { count: 0, sumCents: 0 },
      anchors: [],
      manifestDigest: manifestDigest_,
    });
    expect(reconcileRestore(snap(digest), snap(digest), chain).ok).toBe(true);
    const tampered = await manifestDigest({ ...unsignManifest(result.manifest as SignedBackupManifest), entries: [] });
    expect(reconcileRestore(snap(digest), snap(tampered), chain).problems.map((p) => p.code)).toContain("manifest-digest-mismatch");
  });

  it("changes when ANY byte of any export changes", async () => {
    const a = await run({ io: fakeIo().io });
    const fakeB = fakeIo();
    const b = await run({ io: fakeB.io });
    expect(b.result.manifest?.digest).toBe(a.result.manifest?.digest); // same inputs, same digest
    const mutated = await manifestDigest({
      ...unsignManifest(b.result.manifest as SignedBackupManifest),
      entries: (b.result.manifest?.entries ?? []).map((e, i) => (i === 2 ? { ...e, sha256: "0".repeat(64) } : e)),
    });
    expect(mutated).not.toBe(a.result.manifest?.digest);
  });

  it("records the environment, the commit, the capture time and the retention window", async () => {
    const { result } = await run({ io: fakeIo().io, environment: "staging" });
    expect(result.manifest?.version).toBe(BACKUP_MANIFEST_VERSION);
    expect(result.manifest?.environment).toBe("staging");
    expect(result.manifest?.commit).toBe("c0ffee0000000000000000000000000000000000");
    expect(result.manifest?.takenAt).toBe("2026-07-29T08:00:00.000Z");
    expect(result.manifest?.retentionDays).toBe(30);
  });
});

// ── 4. absent credentials ─────────────────────────────────────────────────────────────────────────────

describe("absent credentials are BLOCKED, never a pass", () => {
  for (const mode of ["merge", "release"] as const) {
    it(`is BLOCKED and exits 2 under --mode ${mode}`, async () => {
      const fake = fakeIo();
      const { result, output } = await run({ io: fake.io, mode, credentialsPresent: false });
      expect(result.gate.status).toBe("BLOCKED");
      expect(result.gate.executed).toBe(false);
      expect(result.gate.assertions).toBe(0);
      expect(result.exitCode).toBe(EVIDENCE_EXIT.PREREQ_BLOCKED);
      expect(result.ok).toBe(false);
      expect(output).toContain("not a pass");
    });
  }

  it("is never a PASS locally either — a developer convenience, not a green", async () => {
    const { result } = await run({ io: fakeIo().io, mode: "local", credentialsPresent: false });
    expect(result.gate.status).toBe("PENDING");
    expect(result.gate.status).not.toBe("PASS");
    expect(result.ok).toBe(false);
    expect(result.manifest).toBeNull();
  });

  it("checks credentials BEFORE it exports anything, so a blocked run cannot half-run", async () => {
    const fake = fakeIo();
    await run({ io: fake.io, credentialsPresent: false });
    expect(fake.calls).toEqual([]);
    expect(fake.files.size).toBe(0);
  });

  it("still reports the derived set, so the operator sees what WOULD have been exported", async () => {
    const { result, output } = await run({ io: fakeIo().io, credentialsPresent: false });
    expect(result.databases).toEqual(PROD_DATABASES);
    for (const db of PROD_DATABASES) expect(output).toContain(db);
  });
});

describe("a dry run proves the set and nothing else", () => {
  it("exports nothing and writes nothing", async () => {
    const fake = fakeIo();
    const { result } = await run({ io: fake.io, dryRun: true, mode: "local" });
    expect(fake.calls).toEqual([]);
    expect(result.manifest).toBeNull();
    expect(result.databases).toEqual(PROD_DATABASES);
  });

  it("is BLOCKED under merge/release — a dry run must never read as a backup", async () => {
    const { result } = await run({ io: fakeIo().io, dryRun: true, mode: "release" });
    expect(result.gate.status).toBe("BLOCKED");
    expect(result.exitCode).toBe(EVIDENCE_EXIT.PREREQ_BLOCKED);
    expect(result.gate.status).not.toBe("PASS");
  });
});

// ── 5. the real wrangler seam ─────────────────────────────────────────────────────────────────────────

describe("the wrangler seam", () => {
  it("invokes the remote export with an output path, and reports a non-zero exit as a failure", () => {
    const seen: string[][] = [];
    const io = wranglerIo((args) => {
      seen.push(args);
      return { status: 1, stdout: "", stderr: "Authentication error [code: 10000]" };
    });
    const outcome = io.exportDatabase("shuddl-control-prod", "artifacts/backup/shuddl-control-prod.sql");
    expect(seen[0]).toEqual(["d1", "export", "shuddl-control-prod", "--remote", "--output", "artifacts/backup/shuddl-control-prod.sql"]);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.detail).toContain("10000");
  });

  it("treats exit 0 as a successful export (the artifact is checked separately)", () => {
    const io = wranglerIo(() => ({ status: 0, stdout: "", stderr: "" }));
    expect(io.exportDatabase("shuddl-control-prod", "/dev/null").ok).toBe(true);
  });

  it("points wrangler at a config, derived from the set rather than typed", () => {
    const seen: string[][] = [];
    const io = wranglerIo((args) => {
      seen.push(args);
      return { status: 0, stdout: "", stderr: "" };
    }, exportConfigPath(deriveBackupSet(realConfigs(), "prod")) ?? undefined);
    io.exportDatabase("shuddl-control-prod", "out.sql");
    expect(seen[0]).toContain("--config");
    // The api config is the one that names all six; if that ever stops being true the derivation moves.
    expect(seen[0]?.[seen[0].indexOf("--config") + 1]).toBe("workers/api/wrangler.toml");
  });

  it("derives the config with the most complete view of the environment, ties broken deterministically", () => {
    for (const env of ["prod", "staging"] as const) {
      const set = deriveBackupSet(realConfigs(), env);
      const chosen = exportConfigPath(set) as string;
      const covered = set.databases.filter((d) => d.sites.some((s) => s.config === chosen)).length;
      expect(covered, env).toBe(set.databases.length); // it names EVERY database in the set
      expect(WORKER_CONFIGS as readonly string[], env).toContain(chosen);
    }
  });

  it("has no config to derive from an empty set, and never invents one", () => {
    expect(exportConfigPath({ environment: "prod", databases: [], problems: [] })).toBeNull();
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────

async function snapshotDigestOfText(text: string): Promise<string> {
  const { sha256Hex } = await import("@shuddl/ledger/canonical");
  return sha256Hex(new TextEncoder().encode(text));
}
