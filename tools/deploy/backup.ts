import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "@shuddl/ledger/canonical";
import {
  BACKUP_RETENTION_DAYS,
  DEPLOYABLE_SCOPES,
  WORKER_CONFIGS,
  parseWranglerToml,
  targetFromWrangler,
} from "./preflight.js";
import { snapshotDigest } from "./restore-verify.js";
import {
  EVIDENCE_EXIT,
  formatGateResult,
  parseMode,
  unavailableStatus,
  type GateMode,
  type GateResult,
} from "../release/evidence.js";

// THE BACKUP (REQ-117 / REQ-288) — the one command that exports every D1 in an environment and blesses
// the result with a manifest.
//
// It exists because `preflight --env prod` reports exactly one BLOCK — `no-backup` — and the only backup
// implementation was an inline shell loop in the nightly workflow over FOUR hardcoded staging database
// names. Production has SIX databases. Staging also has six: the hardcoded list had already drifted from
// the configs it claimed to describe and was silently skipping the two pool planes in the environment it
// was actually pointed at. A hand-typed list of databases is the same artifact as a hand-typed list of
// resource ids in tools/deploy/provision-prod.ts, and it rots the same way — except that this one rots
// invisibly, because a backup that skips a database still produces a green job and a plausible manifest.
// You discover the omission on the day you need it.
//
// So THE SET IS DERIVED, never written down: every `[env.<scope>]` scope of every committed wrangler
// config is read, and its d1 bindings are grouped by `database_name` — the logical identity, exactly as
// provision-prod.ts groups its binding→resource map. Adding a tenant plane to a config adds it to the
// backup with no edit here, and a config whose scope is missing or whose binding names two databases is
// a LOUD failure, not a quiet omission.
//
// Everything that decides is PURE (deriveBackupSet / buildManifest / runBackup over an injected seam), so
// the whole decision surface is provable offline with no account and no export — the same discipline as
// preflight.ts, provision-prod.ts and restore-verify.ts. Cloudflare lives behind BackupIo.
//
// This is an OPERATOR/CI command. It is not wired into verify:*: nothing in a local pipeline should reach
// out and export production.

// ── The set ───────────────────────────────────────────────────────────────────────────────────────────

/** One logical database and every binding site that names it. Grouped by `database_name` because the
 * name IS the database: four workers that say `shuddl-t-tenant-a-prod` are describing one file to
 * export once, not four. */
export type BackupDatabase = {
  databaseName: string;
  sites: { config: string; worker: string; binding: string }[];
};

export type BackupSetProblem = { code: string; resource: string; detail: string };

export type BackupSet = {
  environment: string;
  databases: BackupDatabase[];
  problems: BackupSetProblem[];
};

/**
 * Derive every D1 an environment must export, from the committed configs.
 *
 * The approach is provision-prod.ts's `derivePlan`, narrowed to the one question a backup asks: which
 * NAMES exist in this scope. It reads the same configs through the same shared reader
 * (preflight.ts `parseWranglerToml` / `targetFromWrangler`), so the backup set and the provisioning plan
 * cannot disagree about what a scope contains — backup.test.ts pins that equality against the real files.
 *
 * Every disagreement inside the configs is a PROBLEM, and every problem is fatal upstream. A backup is
 * the one job where "carry on with what we could work out" is the worst available behaviour.
 */
export function deriveBackupSet(configs: { path: string; text: string }[], environment: string): BackupSet {
  const byName = new Map<string, BackupDatabase>();
  const problems: BackupSetProblem[] = [];
  const namesPerBinding = new Map<string, Set<string>>();

  for (const { path, text } of configs) {
    const target = targetFromWrangler(parseWranglerToml(text), environment);
    if (target.worker.length === 0) {
      // A config with no scope here contributes no databases. Left unsaid, that reads as "this worker
      // has nothing to back up" — indistinguishable from a deleted scope, and wrong in the same silent
      // way the hardcoded list was.
      problems.push({ code: "no-env-scope", resource: path, detail: `declares no [env.${environment}] scope, so its databases cannot be enumerated` });
      continue;
    }

    for (const d of target.d1) {
      if (d.databaseName.length === 0) {
        problems.push({ code: "unnamed-database", resource: `${target.worker}.${d.binding}`, detail: "d1 binding declares no database_name, so there is nothing to export" });
        continue;
      }
      const found = byName.get(d.databaseName) ?? { databaseName: d.databaseName, sites: [] };
      found.sites.push({ config: path, worker: target.worker, binding: d.binding });
      byName.set(d.databaseName, found);

      const seen = namesPerBinding.get(d.binding) ?? new Set<string>();
      seen.add(d.databaseName);
      namesPerBinding.set(d.binding, seen);
    }
  }

  // One binding name resolving to two database NAMES is the preflight's `binding-drift`. For a backup it
  // is worse than ambiguous: the two databases are both real, both carry ledger rows, and no operator
  // reading a manifest afterwards could tell which one the restore is missing.
  for (const [binding, names] of namesPerBinding) {
    if (names.size > 1) {
      problems.push({ code: "binding-drift", resource: binding, detail: `${binding} names ${names.size} different databases in the ${environment} scopes (${[...names].sort().join(", ")}); fix the configs before backing up` });
    }
  }

  if (byName.size === 0 && problems.length === 0) {
    problems.push({ code: "empty-backup-set", resource: environment, detail: `no d1 binding is declared in any [env.${environment}] scope; there is nothing to export and that cannot be right` });
  }

  const databases = [...byName.values()].sort((a, b) => a.databaseName.localeCompare(b.databaseName));
  return { environment, databases, problems };
}

// ── The manifest ──────────────────────────────────────────────────────────────────────────────────────

/** Frozen: a restore reads this to know how to read the rest. */
export const BACKUP_MANIFEST_VERSION = "shuddl-backup-v1";

export type BackupEntry = { file: string; database: string; bytes: number; sha256: string };

/** The manifest as it is DIGESTED — every field that describes the backup, and nothing that describes
 * the digest. A digest cannot cover itself. */
export type BackupManifest = {
  version: string;
  environment: string;
  commit: string;
  takenAt: string;
  retentionDays: number;
  entries: BackupEntry[];
};

/** The manifest as it is WRITTEN: the digested body plus the digest of that body. */
export type SignedBackupManifest = BackupManifest & { digest: string };

/**
 * The digest tools/deploy/restore-verify.ts consumes.
 *
 * `LedgerSnapshot.manifestDigest` is documented there as "sha256 over the canonicalized export manifest —
 * computed identically on both sides by snapshotDigest", and it is compared byte-for-byte between the
 * source and the restored snapshot (`manifest-digest-mismatch`). So this calls THAT function rather than
 * re-deriving the bytes: canonical JSON is the repo's frozen byte law, and a second hashing recipe here
 * would eventually disagree with the restore's — which is the one comparison in the whole reconciliation
 * that no operator can sanity-check by eye.
 *
 * The predecessor (the inline node script in the nightly workflow) hashed `JSON.stringify(manifest)`
 * instead. That is insertion-order-dependent, so the same backup described by two writers digests
 * differently and the restore reports tamper.
 */
export async function manifestDigest(manifest: BackupManifest): Promise<string> {
  return snapshotDigest(manifest);
}

/** Strip the digest back off a written manifest, so a verifier recomputes over exactly the bytes the
 * writer digested. */
export function unsignManifest(signed: SignedBackupManifest): BackupManifest {
  const { digest: _digest, ...body } = signed;
  return body;
}

/** Does a written manifest still describe itself? The round-trip the restore depends on. */
export async function verifyManifestDigest(signed: SignedBackupManifest): Promise<boolean> {
  return (await manifestDigest(unsignManifest(signed))) === signed.digest;
}

/** The file an export lands in. One place, so the exporter and the manifest cannot disagree. */
export function exportFileName(databaseName: string): string {
  return `${databaseName}.sql`;
}

/**
 * Which committed config wrangler is pointed at (`--config`).
 *
 * `wrangler d1 export` resolves a database by NAME against the account, but it still wants a config file
 * to sit in — the inline job it replaces got one by running from `workers/api`. Rather than re-typing
 * that directory, the config is DERIVED as the one that names the most databases in this set: it is the
 * config with the most complete view of the environment, and it moves if the configs do. Ties break
 * alphabetically so the choice is deterministic.
 */
export function exportConfigPath(set: BackupSet): string | null {
  const perConfig = new Map<string, number>();
  for (const db of set.databases) {
    for (const path of new Set(db.sites.map((s) => s.config))) perConfig.set(path, (perConfig.get(path) ?? 0) + 1);
  }
  const ranked = [...perConfig.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked[0]?.[0] ?? null;
}

// ── The Cloudflare seam ───────────────────────────────────────────────────────────────────────────────

export type ExportOutcome = { ok: true } | { ok: false; detail: string };

/** Every effect a backup performs, in one injectable interface — so the tests are pure and offline and
 * no test run can reach an account. */
export type BackupIo = {
  ensureDir: (path: string) => void;
  /** Export one database to one file. Returns a failure rather than throwing so the run can report
   * EVERY database that failed, not just the first. */
  exportDatabase: (databaseName: string, outputPath: string) => ExportOutcome;
  /** The bytes wrangler actually wrote. MUST throw when the file is absent — an export that reported
   * success and produced nothing is the failure mode this whole file exists to catch. */
  readArtifact: (outputPath: string) => Uint8Array;
  writeFile: (path: string, text: string) => void;
};

type Runner = (args: string[]) => { status: number; stdout: string; stderr: string };

/** The real seam. `wrangler d1 export <db> --remote --output <file>` — the same invocation the nightly
 * workflow ran inline, now in one place with a checked exit code and a checked artifact. */
export function wranglerIo(run: Runner, configPath?: string): BackupIo {
  return {
    ensureDir: (path) => void mkdirSync(path, { recursive: true }),
    exportDatabase: (databaseName, outputPath) => {
      const r = run([
        "d1",
        "export",
        databaseName,
        "--remote",
        "--output",
        outputPath,
        ...(configPath === undefined ? [] : ["--config", configPath]),
      ]);
      if (r.status !== 0) return { ok: false, detail: `wrangler d1 export exited ${r.status}: ${(r.stderr.trim() || r.stdout.trim()).slice(0, 400)}` };
      return { ok: true };
    },
    readArtifact: (outputPath) => readFileSync(outputPath),
    writeFile: (path, text) => writeFileSync(path, text, "utf8"),
  };
}

// ── The run ───────────────────────────────────────────────────────────────────────────────────────────

export type BackupOptions = {
  environment: string;
  outDir: string;
  configs: { path: string; text: string }[];
  /** Whether the account credentials are bound. FALSE is BLOCKED, never a pass: a backup job that goes
   * green without producing a backup is how you discover, on the day you need it, that there is nothing
   * to restore. */
  credentialsPresent: boolean;
  mode: GateMode;
  commit: string;
  takenAt: string;
  retentionDays: number;
  dryRun: boolean;
  io: BackupIo;
  log: (line: string) => void;
};

export type BackupFailure = { database: string; detail: string };

export type BackupRun = {
  ok: boolean;
  exitCode: number;
  gate: GateResult;
  /** The derived set, in export order — the answer to "which databases would this back up?" */
  databases: string[];
  problems: BackupSetProblem[];
  failures: BackupFailure[];
  exported: string[];
  manifest: SignedBackupManifest | null;
  manifestPath: string | null;
};

const GATE = "backup-manifest"; // the name run-gate and the nightly workflow already use

export async function runBackup(opts: BackupOptions): Promise<BackupRun> {
  const { log } = opts;
  const set = deriveBackupSet(opts.configs, opts.environment);
  const databases = set.databases.map((d) => d.databaseName);

  const result: BackupRun = {
    ok: false,
    exitCode: EVIDENCE_EXIT.ASSERTIONS_FAILED,
    gate: { gate: GATE, status: "FAIL", executed: false, assertions: 0, detail: "" },
    databases,
    problems: set.problems,
    failures: [],
    exported: [],
    manifest: null,
    manifestPath: null,
  };

  log(`backup: environment=${opts.environment} configs=${opts.configs.length} databases=${databases.length}`);
  log("");
  log(`the databases to export, derived from the committed [env.${opts.environment}] scopes:`);
  for (const d of set.databases) {
    log(`  ${d.databaseName.padEnd(28)} ${d.sites.map((s) => `${s.worker}.${s.binding}`).join(", ")}`);
  }
  log("");

  // ── the configs must agree with themselves before anything is exported ──
  if (set.problems.length > 0) {
    for (const p of set.problems) log(`  PROBLEM  ${p.code.padEnd(18)} ${p.resource} — ${p.detail}`);
    log("");
    log("backup: FAILED — the set of databases to export cannot be determined from the configs. Nothing was exported.");
    result.gate = { gate: GATE, status: "FAIL", executed: true, assertions: set.problems.length, detail: `backup set undecidable: ${[...new Set(set.problems.map((p) => p.code))].join(", ")}` };
    return result;
  }

  if (opts.dryRun) {
    // A dry run proves the SET and nothing else. It must never read as a backup, so under merge/release
    // it is BLOCKED — the same disposition as absent credentials, for the same reason.
    log("backup: DRY RUN — no database was exported and no manifest was written.");
    const detail = "dry run — no export was taken";
    result.gate = { gate: GATE, status: opts.mode === "local" ? "NOT_APPLICABLE" : "BLOCKED", executed: false, assertions: 0, detail };
    result.exitCode = opts.mode === "local" ? EVIDENCE_EXIT.OK : EVIDENCE_EXIT.PREREQ_BLOCKED;
    result.ok = opts.mode === "local";
    return result;
  }

  // ── credentials ──
  if (!opts.credentialsPresent) {
    const detail = "Cloudflare credentials absent (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID)";
    const disposition = unavailableStatus(opts.mode);
    log(`backup: ${disposition.status} — ${detail}.`);
    log("backup: no export was taken. This is a named external hold (docs/ops/dr-backups.md), not a pass.");
    result.gate = { gate: GATE, status: disposition.status, executed: false, assertions: 0, detail };
    result.exitCode = disposition.exitCode;
    result.ok = false; // never a pass, in any mode
    return result;
  }

  // ── export ──
  opts.io.ensureDir(opts.outDir);
  const entries: BackupEntry[] = [];
  for (const db of set.databases) {
    const file = exportFileName(db.databaseName);
    const path = join(opts.outDir, file);
    const outcome = opts.io.exportDatabase(db.databaseName, path);
    if (!outcome.ok) {
      log(`  FAILED   ${db.databaseName} — ${outcome.detail}`);
      result.failures.push({ database: db.databaseName, detail: outcome.detail });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = opts.io.readArtifact(path);
    } catch (e) {
      const detail = `export reported success but ${file} could not be read: ${e instanceof Error ? e.message : String(e)}`;
      log(`  FAILED   ${db.databaseName} — ${detail}`);
      result.failures.push({ database: db.databaseName, detail });
      continue;
    }
    if (bytes.length === 0) {
      // Every D1 in this repo carries schema, so an empty export is a failed export wearing a file name.
      const detail = `export produced an EMPTY ${file}; a database with tables cannot export to zero bytes`;
      log(`  FAILED   ${db.databaseName} — ${detail}`);
      result.failures.push({ database: db.databaseName, detail });
      continue;
    }
    // The ledger's hash, not a second one — one hashing implementation across the whole backup path,
    // the same one the manifest digest and every event in the chain use.
    const sha256 = await sha256Hex(bytes);
    entries.push({ file, database: db.databaseName, bytes: bytes.length, sha256 });
    result.exported.push(db.databaseName);
    log(`  exported ${db.databaseName.padEnd(28)} ${String(bytes.length).padStart(10)} bytes  ${sha256.slice(0, 12)}…`);
  }

  // ── a partial backup is not a backup ──
  //
  // The completeness test is over the DERIVED SET, not over the failure list: a database is in this
  // backup only if it produced an entry. Asking "did anything report a failure?" would let a seam that
  // reported NEITHER outcome pass through as a shorter manifest — the same silent omission the hardcoded
  // name list produced, arrived at by a different road. Unaccounted is missing.
  const missing = databases.filter((d) => !result.exported.includes(d));
  if (missing.length > 0) {
    const why = new Map(result.failures.map((f) => [f.database, f.detail]));
    log("");
    for (const db of missing) log(`  MISSING  ${db} — ${why.get(db) ?? "no outcome was recorded for this database"}`);
    log("");
    log(`backup: FAILED — ${missing.length} of ${databases.length} database(s) are not in the export. NO manifest was written:`);
    log("        a manifest over a partial export is a backup that looks complete and is not.");
    result.gate = { gate: GATE, status: "FAIL", executed: true, assertions: result.exported.length, detail: `${missing.length}/${databases.length} database(s) missing: ${missing.join(", ")}` };
    return result;
  }

  // ── the manifest ──
  const body: BackupManifest = {
    version: BACKUP_MANIFEST_VERSION,
    environment: opts.environment,
    commit: opts.commit,
    takenAt: opts.takenAt,
    retentionDays: opts.retentionDays,
    entries,
  };
  const digest = await manifestDigest(body);
  const signed: SignedBackupManifest = { ...body, digest };
  const manifestPath = join(opts.outDir, "manifest.json");
  opts.io.writeFile(manifestPath, `${JSON.stringify(signed, null, 2)}\n`);
  result.manifest = signed;
  result.manifestPath = manifestPath;

  log("");
  log(`backup: ${entries.length} database(s) exported, manifest digest ${digest}`);
  log(`backup: PASS — every database declared in [env.${opts.environment}] is in the manifest.`);
  log("");
  log("next: record the backup in the preflight's account-side state file —");
  log(`      {"backups":{"lastManifestAt":"${opts.takenAt}","retentionDays":${opts.retentionDays}}}`);
  log(`      then: pnpm exec tsx tools/deploy/preflight.ts --env ${opts.environment} --state <file>`);

  result.ok = true;
  result.exitCode = EVIDENCE_EXIT.OK;
  result.gate = { gate: GATE, status: "PASS", executed: true, assertions: entries.length, detail: `${entries.length} database export(s) with a sha256 manifest` };
  return result;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function gitHead(): string {
  const supplied = process.env["GITHUB_SHA"];
  if (supplied !== undefined && supplied.length > 0) return supplied;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown-commit";
  }
}

const USAGE = `usage: pnpm backup -- --env <${DEPLOYABLE_SCOPES.join("|")}> [--out <dir>] [--dry-run] [--mode merge|release]

  --env <env>          REQUIRED. Which environment's databases to export. The SET IS DERIVED from the
                       committed [env.<env>] scopes of every workers/*/wrangler.toml — never a list.
  --out <dir>          where the .sql exports and manifest.json land (default: artifacts/backup).
  --dry-run            print the derived set and exit. Exports nothing, writes nothing. Under
                       --mode merge/release this is BLOCKED, because it is not a backup.
  --mode <m>           local (default) | merge | release. Under merge/release a missing prerequisite is
                       BLOCKED (exit 2) and a structured ##SHUDDL-GATE## line is printed.
  --wrangler "<cmd>"   the wrangler invocation (default: "pnpm exec wrangler").
  --wrangler-config    the config wrangler is pointed at. Derived from the set by default (the config
                       that names the most of its databases); override only to debug.

Credentials (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID) come from the environment. When they are absent
nothing is exported and the gate is BLOCKED — never a pass.`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(EVIDENCE_EXIT.OK);
  }

  const mode = parseMode(argv);
  const environment = flag(argv, "--env") ?? process.env["RELEASE_ENVIRONMENT"] ?? "";
  if (!(DEPLOYABLE_SCOPES as readonly string[]).includes(environment)) {
    console.error(`backup: --env must be one of ${DEPLOYABLE_SCOPES.join(", ")} (got ${environment.length === 0 ? "nothing" : environment}).`);
    console.error("There is no backup of a local dev environment, and guessing an environment is how you back up the wrong one.\n");
    console.error(USAGE);
    process.exit(EVIDENCE_EXIT.MALFORMED);
  }

  const outDir = flag(argv, "--out") ?? join("artifacts", "backup");
  const wranglerCmd = (flag(argv, "--wrangler") ?? "pnpm exec wrangler").split(/\s+/).filter((s) => s.length > 0);
  const bin = wranglerCmd[0];
  if (bin === undefined) {
    console.error("backup: --wrangler is empty");
    process.exit(EVIDENCE_EXIT.MALFORMED);
  }

  const run: Runner = (args) => {
    const r = spawnSync(bin, [...wranglerCmd.slice(1), ...args], {
      encoding: "utf8",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    if (r.error) return { status: 127, stdout: "", stderr: r.error.message };
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

  let configs: { path: string; text: string }[];
  try {
    configs = WORKER_CONFIGS.map((path) => ({ path: path as string, text: readFileSync(path, "utf8") }));
  } catch (e) {
    console.error(`backup: could not read a wrangler config: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(EVIDENCE_EXIT.MALFORMED);
  }

  // Derived, not typed: the config wrangler runs against. `?? undefined` keeps the flag off entirely for
  // a set that yielded none (which can only be an undecidable set, and runBackup fails that before any
  // export is attempted).
  const wranglerConfig = flag(argv, "--wrangler-config") ?? exportConfigPath(deriveBackupSet(configs, environment)) ?? undefined;

  // The manifest must state the retention that is actually in force, not the policy anyone wishes were.
  // A shorter window is recorded truthfully and the preflight then BLOCKS on `retention-too-short`.
  const declared = Number(process.env["BACKUP_RETENTION_DAYS"] ?? BACKUP_RETENTION_DAYS);
  const retentionDays = Number.isSafeInteger(declared) && declared > 0 ? declared : BACKUP_RETENTION_DAYS;
  if (retentionDays < BACKUP_RETENTION_DAYS) {
    console.warn(`backup: WARNING — retention is ${retentionDays}d but policy is ${BACKUP_RETENTION_DAYS}d; the preflight will block on retention-too-short.`);
  }

  const result = await runBackup({
    environment,
    outDir,
    configs,
    credentialsPresent: (process.env["CLOUDFLARE_API_TOKEN"] ?? "").length > 0 && (process.env["CLOUDFLARE_ACCOUNT_ID"] ?? "").length > 0,
    mode,
    commit: gitHead(),
    takenAt: new Date().toISOString(),
    retentionDays,
    dryRun: argv.includes("--dry-run"),
    io: wranglerIo(run, wranglerConfig),
    log: (line) => console.log(line),
  });

  if (mode !== "local") console.log(formatGateResult(result.gate));
  process.exit(result.exitCode);
}

if (process.argv[1] !== undefined && /backup\.ts$/.test(process.argv[1])) void main();
