import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { EventKind, LedgerEvent } from "@shuddl/contracts";
import { applyMigrations } from "../src/migrate.js";
import {
  anchorManifestKey,
  anchorProof,
  anchorReceiptKey,
  canonicalPositionBytes,
  dayOf,
  runDailyAnchor,
  type PositionRow,
} from "../src/anchor.js";
import { bytesToHex, hexToBytes, merkleRoot, verifyInclusion } from "../src/merkle.js";
import { parseTimeStampResp } from "../src/tsa/der.js";
import { FakeTsaClient, type TsaClient } from "../src/tsa/client.js";
import { sha256Hex } from "../src/canonical.js";
import { eventInsertStmt, mkEvent, resetEventCounter } from "./helpers.js";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";
import partyRefsGuard from "../../../db/tenant/migrations/0004_party_refs_guard.sql?raw";

// REQ-014 — the daily Merkle -> TSA anchor. vitest-pool-workers isolates storage PER TEST (each it's
// D1 + R2 writes roll back at its end), so every test seeds its own day-scoped rows.

const DB = env.TENANT_A_DB;
const R2 = env.EVIDENCE;
const TENANT = "tenant-a";
const FIRE = (): Date => new Date("2026-07-10T01:00:00Z"); // anchors up to 2026-07-09
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const noon = (day: string): number => Date.parse(`${day}T12:00:00.000Z`);

async function seed(kind: EventKind, over: Partial<LedgerEvent>): Promise<LedgerEvent> {
  const e = mkEvent(kind, over);
  await eventInsertStmt(DB, e).run();
  return e;
}

async function insertPosition(row: PositionRow, recordedAt: number): Promise<void> {
  const hash = await sha256Hex(canonicalPositionBytes(row));
  await DB.prepare(
    "INSERT INTO positions (shipment_id, device_id, ts, recorded_at, lat_e6, lon_e6, accuracy_m, speed_cms, hash) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(row.shipment_id, row.device_id, row.ts, recordedAt, row.lat_e6, row.lon_e6, row.accuracy_m, row.speed_cms, hash)
    .run();
}

async function anchorHash(day: string): Promise<string | null> {
  const r = await DB.prepare("SELECT hash FROM documents WHERE id = ?").bind(`anchor:${day}`).first<{ hash: string }>();
  return r?.hash ?? null;
}

async function failureRow(prefix: "anchor-tsa" | "anchor-build", day: string): Promise<{ rule: string; severity: string; detail: string } | null> {
  return DB.prepare("SELECT rule, severity, detail FROM anomalies WHERE id = ?")
    .bind(`${prefix}:${TENANT}:${day}`)
    .first<{ rule: string; severity: string; detail: string }>();
}

const failingTsa: TsaClient = { timestamp: () => Promise.reject(new Error("TSA_DOWN")) };
// An R2 whose put ALWAYS throws — a build fault that is transient (unlike a poisoned row, the day
// becomes anchorable again once R2 recovers), so it can prove both escalation and the clear-on-success.
const failingR2 = { put: () => Promise.reject(new Error("R2_DOWN")) } as unknown as R2Bucket;

// ── the D1 fault seam ─────────────────────────────────────────────────────────────────────────────
// A façade over the real D1 that faults SELECTED statements and passes everything else through. Two
// properties are load-bearing, and the `sql.includes("anomalies")` version of this seam had neither:
//
//  1. It discriminates on a statement's ROLE — verb AND table, anchored at the head of the statement —
//     never on a floating substring. A substring also matches the word in a comment, in a column name,
//     or in a statement that merely joins the table, so it can fault a write nobody meant to fault and
//     never say so.
//  2. It COUNTS what it did, and every test asserts those counts. That is what stops a green for the
//     wrong reason: a seam that quietly stops matching leaves the guard under test unexercised, and
//     every assertion about "the day is still contained" passes vacuously. THREE counters, because they
//     catch three different ways this goes wrong:
//       · `faults > 0`   — the seam matched something at all.
//       · `unbound === 0` — no statement carrying `?` placeholders was executed without binding them.
//         The old stub implemented ONLY `.bind()`, so such a statement called `undefined()` — a TypeError
//         the production guards swallow exactly like a D1 rejection, leaving the suite green while the
//         seam tested nothing. Every statement here implements the full surface, so it rejects like any
//         other fault instead, AND is counted: real D1 refuses an unbound parameterised statement too
//         ("wrong number of parameter bindings"), so a non-zero count is a genuine caller bug, not a
//         property of the seam. Parameterless statements are exempt — they are correct unbound.
//       · `unmatched === 0` — the TRIPWIRE. A statement that names a targeted table but matches NO role
//         at all (it was rewritten, aliased, or schema-qualified to `main.anomalies`) passes straight
//         through to the real DB, so `faults` can stay non-zero on the OTHER roles and hide the miss. The
//         loose substring that used to be the discriminator is exactly the right instrument for this job —
//         demoted from deciding the fault to reporting a role matcher that has gone blind. Matching a role
//         this seam did not target is NOT a miss: that is the seam being selective, which is the point.
type StatementRole = "anomalies_read" | "anomalies_write" | "anomalies_clear" | "scan_first_day" | "scan_anchored_days";

// `tripwire` names the table whose MENTION means "a statement of this role should have matched". It is
// null for the two scan roles on purpose: their absence is DIRECTLY observable (a scan the seam failed to
// fault produces a run with no `scan_failed`, which the assertions state exactly), whereas an anomalies
// fault's effect is the ABSENCE of a row — indistinguishable from a seam that never matched, which is why
// those three need the tripwire.
const ROLES: Record<StatementRole, { match: RegExp; tripwire: string | null }> = {
  anomalies_read: { match: /^\s*SELECT\b[\s\S]*\bFROM\s+anomalies\b/i, tripwire: "anomalies" },
  anomalies_write: { match: /^\s*INSERT\s+INTO\s+anomalies\b/i, tripwire: "anomalies" },
  anomalies_clear: { match: /^\s*DELETE\s+FROM\s+anomalies\b/i, tripwire: "anomalies" },
  scan_first_day: { match: /^\s*SELECT\s+MIN\(recorded_at\)/i, tripwire: null },
  scan_anchored_days: { match: /^\s*SELECT\s+id\s+FROM\s+documents\b/i, tripwire: null },
};

interface FaultSeam {
  /** The D1 façade to inject. */
  db: D1Database;
  /** Statement executions this seam faulted. Assert `> 0`: a seam that matched nothing proves nothing. */
  faults: () => number;
  /** Faulted executions that arrived with NO bound parameters. Assert `0` — see (2) above. */
  unbound: () => number;
  /** Statements naming a targeted table that matched no role. Assert `0` — the tripwire above. */
  unmatched: () => number;
}

function faultSeam(roles: StatementRole[], when?: (args: unknown[]) => boolean): FaultSeam {
  let faults = 0;
  let unbound = 0;
  let unmatched = 0;
  const tripwires = [...new Set(roles.map((r) => ROLES[r].tripwire).filter((t): t is string => t !== null))].map(
    (t) => new RegExp(String.raw`\b${t}\b`, "i"),
  );
  const knownRoles = Object.values(ROLES);
  const exec = (parameterised: boolean, bound: boolean): Record<string, () => Promise<never>> => {
    const reject = (): Promise<never> => {
      faults += 1;
      if (parameterised && !bound) unbound += 1;
      return Promise.reject(new Error("D1_DOWN"));
    };
    return { first: reject, all: reject, run: reject, raw: reject };
  };
  const faulty = (sql: string, bound: boolean): D1PreparedStatement =>
    ({ bind: () => faulty(sql, true), ...exec(sql.includes("?"), bound) }) as unknown as D1PreparedStatement;
  const db = {
    prepare: (sql: string): D1PreparedStatement => {
      if (!roles.some((r) => ROLES[r].match.test(sql))) {
        // A statement naming a targeted table that NO role recognises: the matchers have gone blind.
        if (tripwires.some((t) => t.test(sql)) && !knownRoles.some((r) => r.match.test(sql))) unmatched += 1;
        return DB.prepare(sql);
      }
      if (!when) return faulty(sql, false);
      // An argument-scoped fault can only be decided at bind, so an unbound execution cannot be
      // classified: it faults AND is counted, rather than slipping through to the real DB unnoticed.
      const real = DB.prepare(sql);
      return {
        ...exec(sql.includes("?"), false),
        bind: (...args: unknown[]) => (when(args) ? faulty(sql, true) : real.bind(...args)),
      } as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
  return { db, faults: () => faults, unbound: () => unbound, unmatched: () => unmatched };
}

// Every `anomalies` statement rejects. This is the CORRELATED fault the guards exist for: the failure
// recorder and the day itself are both D1 writes, so whatever breaks one is the likeliest thing to
// break the other.
const anomaliesBrokenDb = (): FaultSeam => faultSeam(["anomalies_read", "anomalies_write", "anomalies_clear"]);

// Only the anomalies statements carrying the TSA marker id reject; the build marker is written for
// real. A blanket fault cannot tell a guarded TSA recorder from an unguarded one — both leave the day
// `failed` — so the discriminator has to be which anomaly ends up on the table.
const tsaMarkerBrokenDb = (): FaultSeam =>
  faultSeam(["anomalies_read", "anomalies_write"], (args) => args.some((a) => typeof a === "string" && a.startsWith("anchor-tsa:")));

beforeAll(async () => {
  resetEventCounter();
  await applyMigrations(DB, [
    { path: "0001_ledger_core.sql", sql: ledgerCore },
    { path: "0002_domain.sql", sql: domain },
    { path: "0003_insert_guards.sql", sql: insertGuards },
    { path: "0004_party_refs_guard.sql", sql: partyRefsGuard },
  ]);
});

describe("REQ-014 DoD — a POD hash verifies against a TSA receipt", () => {
  it("REQ-014 DoD: a pod.signed hash verifies against the day's TSA-stamped root, and the receipt imprint binds that root", async () => {
    const day = "2026-07-09";
    await seed("stop.arrived", { stream_id: "s:dod", shipment_id: "dod", seq: 0, recorded_at: noon(day) });
    await seed("freight.counted", { stream_id: "s:dod", shipment_id: "dod", seq: 1, recorded_at: noon(day) });
    const pod = await seed("pod.signed", { stream_id: "s:dod", shipment_id: "dod", seq: 2, recorded_at: noon(day) });

    const res = await runDailyAnchor({ db: DB, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect(res.anchored).toContain(day);

    // 1) the POD hash is provably in the anchored root
    const proof = await anchorProof(DB, day, pod.hash!);
    expect(await verifyInclusion(hexToBytes(pod.hash!), proof.steps, hexToBytes(proof.root))).toBe(true);

    // 2) the TSA receipt in R2 stamped the imprint that binds exactly this root + leaf count
    const obj = await R2.get(`anchors/${TENANT}/${day}/tsr.der`);
    expect(obj).not.toBeNull();
    const receipt = parseTimeStampResp(await obj!.arrayBuffer());
    expect(receipt.granted).toBe(true);
    const expectedImprint = await sha256Hex(utf8(`shuddl-anchor-v1:${TENANT}:${day}:${proof.root}:${proof.leafCount}`));
    expect(receipt.imprintDigestHex).toBe(expectedImprint);
  });
});

describe("REQ-014 — determinism, bucketing, gaps, failures, positions", () => {
  it("determinism: two runs -> identical root; the re-run is a no-op (INSERT OR IGNORE doc row)", async () => {
    const day = "2026-07-09";
    await seed("stop.arrived", { stream_id: "s:det", shipment_id: "det", seq: 0, recorded_at: noon(day) });

    const res1 = await runDailyAnchor({ db: DB, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect(res1.anchored).toContain(day);
    const root1 = await anchorHash(day);

    const res2 = await runDailyAnchor({ db: DB, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect(res2.anchored).not.toContain(day);
    expect(res2.skipped).toContain(day);
    expect(await anchorHash(day)).toBe(root1); // unchanged
  });

  it("late upload: yesterday's ts but today's recorded_at lands in TODAY's tree; yesterday's root excludes it", async () => {
    const inDay = await seed("stop.arrived", { stream_id: "s:late-in", shipment_id: "late-in", seq: 0, recorded_at: noon("2026-07-09"), ts: Date.parse("2026-07-09T09:00:00Z") });
    // a late/airplane-mode upload: physical ts on 07-09, but recorded_at (server clock) is 07-10 (today)
    await seed("pod.signed", { stream_id: "s:late-up", shipment_id: "late-up", seq: 0, recorded_at: noon("2026-07-10"), ts: Date.parse("2026-07-09T23:00:00Z") });

    const res = await runDailyAnchor({ db: DB, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect(res.anchored).toContain("2026-07-09");
    expect(res.anchored).not.toContain("2026-07-10"); // today is never anchored

    // 07-09's root is JUST the in-day event — the late upload (recorded_at 07-10) is excluded
    const expected = bytesToHex(await merkleRoot([hexToBytes(inDay.hash!)]));
    expect(await anchorHash("2026-07-09")).toBe(expected);
    expect(await anchorHash("2026-07-10")).toBeNull();
  });

  it("empty day still anchors (gap-free day chain): the empty tree = SHA-256(\"\")", async () => {
    await seed("stop.arrived", { stream_id: "s:gap-7", shipment_id: "gap-7", seq: 0, recorded_at: noon("2026-07-07") });
    await seed("stop.arrived", { stream_id: "s:gap-9", shipment_id: "gap-9", seq: 0, recorded_at: noon("2026-07-09") });

    const res = await runDailyAnchor({ db: DB, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect(res.anchored).toEqual(["2026-07-07", "2026-07-08", "2026-07-09"]); // 07-08 has NO rows, still anchored
    expect(await anchorHash("2026-07-08")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("TSA failure leaves the day unanchored + retried; 3 consecutive failures escalate to a critical anomaly, cleared on success", async () => {
    const day = "2026-07-09";
    await seed("stop.arrived", { stream_id: "s:fail", shipment_id: "fail", seq: 0, recorded_at: noon(day) });

    for (let i = 1; i <= 3; i++) {
      const res = await runDailyAnchor({ db: DB, r2: R2, tsa: failingTsa, tenant: TENANT, now: FIRE });
      expect(res.failed).toContain(day);
      expect(await anchorHash(day)).toBeNull(); // never anchored on failure
    }
    const anomaly = await DB.prepare("SELECT severity, detail FROM anomalies WHERE id = ?").bind(`anchor-tsa:${TENANT}:${day}`).first<{ severity: string; detail: string }>();
    expect(anomaly?.severity).toBe("critical");
    expect((JSON.parse(anomaly!.detail) as { consecutive: number }).consecutive).toBe(3);

    // recovery: a working TSA anchors the day and clears the failure marker
    const ok = await runDailyAnchor({ db: DB, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect(ok.anchored).toContain(day);
    expect(await anchorHash(day)).not.toBeNull();
    const cleared = await DB.prepare("SELECT 1 AS x FROM anomalies WHERE id = ?").bind(`anchor-tsa:${TENANT}:${day}`).first();
    expect(cleared).toBeNull();
  });

  it("a day that THROWS lands in failed[] — one unreadable day never sinks the rest of the backfill", async () => {
    // The backfill walks every unanchored day, so it is only as robust as its worst day. anchorDay owns
    // its own failure modes (the boundary race, a TSA refusal); anything ELSE — here a row whose `hash`
    // is not hex, which the events schema permits (TEXT, no format constraint) and which dayLeaves feeds
    // straight to hexToBytes — used to escape runDailyAnchor entirely and fail the whole request, losing
    // every good day with the bad one.
    const poisoned = "2026-07-08";
    const clean = "2026-07-09";
    const bad = mkEvent("stop.arrived", { stream_id: "s:poison", shipment_id: "poison", seq: 0, recorded_at: noon(poisoned) });
    await eventInsertStmt(DB, { ...bad, hash: "x".repeat(64) }).run();
    await seed("stop.arrived", { stream_id: "s:clean", shipment_id: "clean", seq: 0, recorded_at: noon(clean) });

    const res = await runDailyAnchor({ db: DB, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });

    expect(res.failed).toContain(poisoned);
    expect(res.anchored).toContain(clean); // the good day still anchors

    // the failed day leaves NO partial anchor behind: no documents row, no R2 receipt, no manifest
    expect(await anchorHash(poisoned)).toBeNull();
    expect(await R2.get(`anchors/${TENANT}/${poisoned}/tsr.der`)).toBeNull();
    expect(await R2.get(`anchors/${TENANT}/${poisoned}/manifest.json`)).toBeNull();

    // ...and it is DURABLY recorded. The cron (workers/agents runAllTenants) discards the run result,
    // so on the scheduled path the anomalies row is the only thing that outlives the run — a day that
    // can never be witnessed must not depend on someone reading a log line. Its own rule, not the TSA
    // one, so the alert names the real condition.
    const rec = await failureRow("anchor-build", poisoned);
    expect(rec?.rule).toBe("anchor.build_failed");
    expect(rec?.severity).toBe("warn"); // first failure
    const detail = JSON.parse(rec!.detail) as { day: string; consecutive: number; last_error: string };
    expect(detail).toMatchObject({ day: poisoned, consecutive: 1 });
    expect(detail.last_error).toContain("non-hex");
    // the TSA seam is NOT co-opted for a non-TSA cause
    expect(await failureRow("anchor-tsa", poisoned)).toBeNull();
  });

  it("a build failure escalates like a TSA failure and clears when the day finally anchors", async () => {
    const day = "2026-07-09";
    await seed("stop.arrived", { stream_id: "s:r2-fault", shipment_id: "r2-fault", seq: 0, recorded_at: noon(day) });

    // three consecutive runs against a dead R2 — same accounting the TSA seam already does
    for (let i = 1; i <= 3; i++) {
      const res = await runDailyAnchor({ db: DB, r2: failingR2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
      expect(res.failed).toContain(day);
      expect(await anchorHash(day)).toBeNull(); // the documents row is written LAST — never on a failure
    }
    const escalated = await failureRow("anchor-build", day);
    expect(escalated?.severity).toBe("critical");
    const detail = JSON.parse(escalated!.detail) as { consecutive: number; last_error: string };
    expect(detail.consecutive).toBe(3);
    expect(detail.last_error).toBe("R2_DOWN");

    // recovery: a working R2 anchors the day and clears the marker (an anomaly nobody can close is debt)
    const ok = await runDailyAnchor({ db: DB, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect(ok.anchored).toContain(day);
    expect(await anchorHash(day)).not.toBeNull();
    expect(await failureRow("anchor-build", day)).toBeNull();
  });

  it("a D1 fault in the failure bookkeeping changes no verdict and never re-raises", async () => {
    // Two of the three guards, under one fault. The build recorder runs inside the contained catch:
    // unguarded, its rejection escapes runDailyAnchor and the 500 is back. The marker clear runs inside
    // anchorDay AFTER the documents row: unguarded, its rejection reports a fully anchored, witnessed,
    // verifiable day as `failed` — a verdict nothing can ever correct, because the next run sees that
    // documents row, marks the day `skipped`, and never calls anchorDay again. (The third guard, on the
    // TSA recorder, needs a sharper fault to observe — the test below.)
    const poisoned = "2026-07-08";
    const clean = "2026-07-09";
    const bad = mkEvent("stop.arrived", { stream_id: "s:d1-poison", shipment_id: "d1-poison", seq: 0, recorded_at: noon(poisoned) });
    await eventInsertStmt(DB, { ...bad, hash: "y".repeat(64) }).run();
    await seed("stop.arrived", { stream_id: "s:d1-clean", shipment_id: "d1-clean", seq: 0, recorded_at: noon(clean) });

    const seam = anomaliesBrokenDb();
    const res = await runDailyAnchor({ db: seam.db, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });

    expect(res.failed).toContain(poisoned); // the unrecordable failure is still contained
    expect(res.anchored).toContain(clean); // the unclearable success is still reported as success
    expect(await anchorHash(clean)).not.toBeNull(); // ...and the day really is anchored
    expect(seam.faults()).toBeGreaterThan(0); // the seam really did fault the bookkeeping (not a vacuous pass)
    expect(seam.unbound()).toBe(0); // ...and every faulted statement was bound — no swallowed TypeError
    expect(seam.unmatched()).toBe(0); // ...and no anomalies statement slipped past the role matchers
  });

  it("a TSA outage whose marker cannot be written is never relabelled a build failure", async () => {
    // The third guard. recordAnchorFailure(TSA_UNAVAILABLE) is itself a D1 write; unguarded, its
    // rejection escapes anchorDay into the per-day containment, which records the day under
    // `anchor.build_failed` — sending ops after an unreadable ledger when the truth is that the
    // timestamping authority refused. Both paths leave the day `failed`, so the anomaly IS the assertion.
    const day = "2026-07-09";
    await seed("stop.arrived", { stream_id: "s:tsa-guard", shipment_id: "tsa-guard", seq: 0, recorded_at: noon(day) });

    const seam = tsaMarkerBrokenDb();
    const res = await runDailyAnchor({ db: seam.db, r2: R2, tsa: failingTsa, tenant: TENANT, now: FIRE });

    expect(res.failed).toContain(day); // contained — the run still resolves
    expect(await anchorHash(day)).toBeNull();
    expect(await failureRow("anchor-tsa", day)).toBeNull(); // the marker genuinely could not be written
    expect(await failureRow("anchor-build", day)).toBeNull(); // ...and the outage was NOT relabelled
    expect(seam.faults()).toBeGreaterThan(0); // the TSA-marker statements really were faulted
    expect(seam.unbound()).toBe(0); // ...all of them bound, so nothing was a TypeError in disguise
    expect(seam.unmatched()).toBe(0); // ...and no anomalies statement slipped past the role matchers
  });

  it("a day can carry BOTH markers at once, and anchoring clears both", async () => {
    const day = "2026-07-09";
    await seed("stop.arrived", { stream_id: "s:both", shipment_id: "both", seq: 0, recorded_at: noon(day) });

    // the TSA refuses -> anchor-tsa; then the TSA is fine but the write fails -> anchor-build beside it
    await runDailyAnchor({ db: DB, r2: R2, tsa: failingTsa, tenant: TENANT, now: FIRE });
    await runDailyAnchor({ db: DB, r2: failingR2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect(await failureRow("anchor-tsa", day)).not.toBeNull();
    expect(await failureRow("anchor-build", day)).not.toBeNull();

    // the day anchors: EVERY reason it previously could not is resolved, so both markers go
    const ok = await runDailyAnchor({ db: DB, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect(ok.anchored).toContain(day);
    expect(await failureRow("anchor-tsa", day)).toBeNull();
    expect(await failureRow("anchor-build", day)).toBeNull();
  });

  it("a D1 fault while DETERMINING the work is contained and NAMED — not an empty result that reads like success", async () => {
    // The two pre-loop queries decide WHAT this run has to do, so a fault in either is not a day failing:
    // there is no day to put in `failed[]`. Returning the bare three empty arrays would state "nothing to
    // anchor", which is a different fact and a false one — hence `scan_failed`, which says the run never
    // got as far as looking at a day.
    const day = "2026-07-09";
    await seed("stop.arrived", { stream_id: "s:scan1", shipment_id: "scan1", seq: 0, recorded_at: noon(day) });

    const seam = faultSeam(["scan_first_day"]);
    const res = await runDailyAnchor({ db: seam.db, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });

    expect(res).toEqual({ anchored: [], skipped: [], failed: [], scan_failed: { stage: "first_day", error: "D1_DOWN" } });
    expect(seam.faults()).toBeGreaterThan(0);
    expect(seam.unbound()).toBe(0);
    expect(await anchorHash(day)).toBeNull(); // a day that WOULD have anchored is untouched, not lost

    // DURABLE, for the same reason a failed day is: the cron (runAllTenants) discards the result, so on
    // the scheduled path the anomalies row is all that outlives the run — and this row means the tenant
    // anchored NOTHING, which is strictly louder than one day failing.
    const rec = await DB.prepare("SELECT rule, severity, detail, status FROM anomalies WHERE id = ?")
      .bind(`anchor-scan:${TENANT}:first_day`)
      .first<{ rule: string; severity: string; detail: string; status: string }>();
    expect(rec?.rule).toBe("anchor.scan_failed");
    expect(rec?.severity).toBe("warn");
    expect(rec?.status).toBe("open");
    expect(JSON.parse(rec!.detail) as Record<string, unknown>).toMatchObject({ stage: "first_day", consecutive: 1, last_error: "D1_DOWN" });
  });

  it("the anchored-days query is contained too, and a run that cannot read it anchors NOTHING", async () => {
    // Proceeding without the anchored-day set would re-run anchorDay for days that are already anchored,
    // and anchorDay puts the receipt to R2 before its INSERT OR IGNORE — so it would overwrite a stored
    // TSA receipt with a freshly stamped one, replacing the witness time that IS the evidence. The run
    // stops instead: not knowing which days are done is not a licence to redo them.
    const day = "2026-07-09";
    await seed("stop.arrived", { stream_id: "s:scan2", shipment_id: "scan2", seq: 0, recorded_at: noon(day) });

    const seam = faultSeam(["scan_anchored_days"]);
    const res = await runDailyAnchor({ db: seam.db, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });

    expect(res.scan_failed).toEqual({ stage: "anchored_days", error: "D1_DOWN" });
    expect(res.anchored).toEqual([]); // no day was examined...
    expect(res.skipped).toEqual([]);
    expect(res.failed).toEqual([]);
    expect(await anchorHash(day)).toBeNull(); // ...and none was anchored
    expect(await R2.get(`anchors/${TENANT}/${day}/tsr.der`)).toBeNull();
  });

  it("consecutive scan failures escalate; a run that CAN determine its work clears the marker", async () => {
    // No seeded rows at all, so the clearing run takes the "nothing recorded yet" early exit — the path
    // that would otherwise strand a critical alarm forever: it returns before the day loop, so if the
    // clear lived with the day work, every later run would exit early and never reach it.
    for (let i = 1; i <= 3; i++) {
      const seam = faultSeam(["scan_first_day"]);
      const res = await runDailyAnchor({ db: seam.db, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
      expect(res.scan_failed?.stage).toBe("first_day");
    }
    const escalated = await DB.prepare("SELECT severity, detail FROM anomalies WHERE id = ?")
      .bind(`anchor-scan:${TENANT}:first_day`)
      .first<{ severity: string; detail: string }>();
    expect(escalated?.severity).toBe("critical");
    expect((JSON.parse(escalated!.detail) as { consecutive: number }).consecutive).toBe(3);

    const ok = await runDailyAnchor({ db: DB, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect(ok.scan_failed).toBeUndefined(); // the scan succeeded — there was simply nothing to anchor
    expect(ok).toEqual({ anchored: [], skipped: [], failed: [] });
    expect(await DB.prepare("SELECT 1 AS x FROM anomalies WHERE id = ?").bind(`anchor-scan:${TENANT}:first_day`).first()).toBeNull();
  });

  it("a marker that OUTLIVES its clear is swept on a later run — a day that is anchored never keeps an anomaly", async () => {
    // The one hazard the guard on clearAnchorFailures leaves behind. Clearing is recovery bookkeeping,
    // so it must never gate anchoring (a persistent anomalies fault would otherwise stop a witnessable
    // day from being witnessed) — which means a clear that rejects AFTER the documents row commits
    // leaves the markers standing while the day is genuinely anchored. From then on the day is `skipped`
    // every run, anchorDay is never called again, and nothing could clear or escalate the markers: a
    // permanent open alarm for a day that is witnessed and verifiable. The backstop is a run-level sweep
    // that keys on the anchored-ness of the day itself, so it does not care which run left the marker.
    const day = "2026-07-09";
    await seed("stop.arrived", { stream_id: "s:stale", shipment_id: "stale", seq: 0, recorded_at: noon(day) });

    // 1. the TSA refuses — the day carries a marker
    await runDailyAnchor({ db: DB, r2: R2, tsa: failingTsa, tenant: TENANT, now: FIRE });
    expect(await failureRow("anchor-tsa", day)).not.toBeNull();

    // 2. the day anchors, but every anomalies DELETE faults: the day is correctly reported `anchored`
    //    (the guard holds) and the marker outlives it
    const seam = faultSeam(["anomalies_clear"]);
    const anchored = await runDailyAnchor({ db: seam.db, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect(anchored.anchored).toContain(day);
    expect(await anchorHash(day)).not.toBeNull(); // the day IS witnessed
    expect(seam.faults()).toBeGreaterThan(0);
    expect(seam.unbound()).toBe(0);
    expect(seam.unmatched()).toBe(0);
    expect(await failureRow("anchor-tsa", day)).not.toBeNull(); // ...and the stale marker is standing

    // 3. the next healthy run SKIPS the day (it has its documents row) and sweeps the marker anyway
    const next = await runDailyAnchor({ db: DB, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect(next.skipped).toContain(day);
    expect(next.anchored).not.toContain(day); // anchorDay is NOT called again — the sweep is what clears
    expect(await failureRow("anchor-tsa", day)).toBeNull();
    expect(await failureRow("anchor-build", day)).toBeNull();
  });

  it("the sweep clears ONLY markers for days that are anchored — a still-failing day keeps its alarm", async () => {
    // The sweep must not become a blanket "delete the anchor alarms": a day that is still unanchored is
    // exactly the day whose alarm has to survive to escalate.
    const anchoredDay = "2026-07-08";
    const failingDay = "2026-07-09";
    await seed("stop.arrived", { stream_id: "s:sw-a", shipment_id: "sw-a", seq: 0, recorded_at: noon(anchoredDay) });
    await seed("stop.arrived", { stream_id: "s:sw-f", shipment_id: "sw-f", seq: 0, recorded_at: noon(failingDay) });

    // both days fail against a dead TSA
    await runDailyAnchor({ db: DB, r2: R2, tsa: failingTsa, tenant: TENANT, now: FIRE });
    expect(await failureRow("anchor-tsa", anchoredDay)).not.toBeNull();
    expect(await failureRow("anchor-tsa", failingDay)).not.toBeNull();

    // now the earlier day anchors while the later one is still refused: a TSA that stamps once, then dies
    let stamps = 0;
    const fake = new FakeTsaClient();
    const flakyTsa: TsaClient = { timestamp: (m) => (stamps++ === 0 ? fake.timestamp(m) : Promise.reject(new Error("TSA_DOWN"))) };
    const res = await runDailyAnchor({ db: DB, r2: R2, tsa: flakyTsa, tenant: TENANT, now: FIRE });
    expect(res.anchored).toEqual([anchoredDay]);
    expect(res.failed).toEqual([failingDay]);

    expect(await failureRow("anchor-tsa", anchoredDay)).toBeNull(); // cleared: the day is witnessed
    const alive = await failureRow("anchor-tsa", failingDay);
    expect(alive).not.toBeNull(); // NOT swept: still unanchored, and its count must keep climbing
    expect((JSON.parse(alive!.detail) as { consecutive: number }).consecutive).toBe(2);
  });

  it("a marker an operator RESOLVED re-opens when its condition re-fails — only the kind that re-failed", async () => {
    // An anchor marker is a watchtower alarm: the default lens is GET /v1/watchtower?status=open
    // (workers/api/src/routes/watchtower.ts). If a re-failing condition refreshes severity + detail but
    // leaves status = 'resolved', the row keeps re-failing while reading resolved — the alarm hides
    // itself from the only lens ops look at. workers/agents raiseAlarm already re-opens on re-raise and
    // calls itself a mirror of this UPSERT; this test is what makes that claim true.
    const day = "2026-07-09";
    await seed("stop.arrived", { stream_id: "s:reopen", shipment_id: "reopen", seq: 0, recorded_at: noon(day) });
    const statusOf = async (prefix: "anchor-tsa" | "anchor-build"): Promise<{ status: string; detail: string } | null> =>
      DB.prepare("SELECT status, detail FROM anomalies WHERE id = ?").bind(`${prefix}:${TENANT}:${day}`).first<{ status: string; detail: string }>();

    // both kinds fire once: the TSA refuses, then the TSA is fine but the write fails
    await runDailyAnchor({ db: DB, r2: R2, tsa: failingTsa, tenant: TENANT, now: FIRE });
    await runDailyAnchor({ db: DB, r2: failingR2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect((await statusOf("anchor-tsa"))?.status).toBe("open");
    expect((await statusOf("anchor-build"))?.status).toBe("open");

    // an operator resolves BOTH (what workers/agents clearAlarm does, and what an ops UI offers)
    await DB.prepare("UPDATE anomalies SET status = 'resolved' WHERE id IN (?,?)")
      .bind(`anchor-tsa:${TENANT}:${day}`, `anchor-build:${TENANT}:${day}`)
      .run();

    // the TSA refuses AGAIN: its marker must come back to 'open' and keep counting
    await runDailyAnchor({ db: DB, r2: R2, tsa: failingTsa, tenant: TENANT, now: FIRE });
    const tsa = await statusOf("anchor-tsa");
    expect(tsa?.status).toBe("open"); // visible to the DEFAULT ?status=open lens again
    expect((JSON.parse(tsa!.detail) as { consecutive: number }).consecutive).toBe(2);
    // ...and the kind that did NOT re-fail stays resolved — a re-raise is not a blanket un-resolve
    expect((await statusOf("anchor-build"))?.status).toBe("resolved");

    // the build kind behaves the same way when IT re-fails
    await runDailyAnchor({ db: DB, r2: failingR2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    const build = await statusOf("anchor-build");
    expect(build?.status).toBe("open");
    expect((JSON.parse(build!.detail) as { consecutive: number }).consecutive).toBe(2);
  });

  it("positions participate: a day with ONLY positions produces a stable root (positions hash in like everything else)", async () => {
    const day = "2026-07-09";
    const row: PositionRow = { shipment_id: "pos-ship", device_id: "dev-1", ts: 1_720_000_000_000, lat_e6: 37_421_000, lon_e6: -122_084_000, accuracy_m: 5, speed_cms: null };
    await insertPosition(row, noon(day));

    const res = await runDailyAnchor({ db: DB, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect(res.anchored).toContain(day);
    const expected = bytesToHex(await merkleRoot([canonicalPositionBytes(row)]));
    expect(await anchorHash(day)).toBe(expected);

    // the position's own canonical-bytes leaf verifies against the anchored root
    const leafHex = bytesToHex(canonicalPositionBytes(row));
    const proof = await anchorProof(DB, day, leafHex);
    expect(await verifyInclusion(canonicalPositionBytes(row), proof.steps, hexToBytes(proof.root))).toBe(true);
  });

  it("dayOf buckets on the UTC calendar day", () => {
    expect(dayOf(Date.parse("2026-07-09T23:59:59.999Z"))).toBe("2026-07-09");
    expect(dayOf(Date.parse("2026-07-10T00:00:00.000Z"))).toBe("2026-07-10");
  });
});

// Audit §174. The anchor routes (/v1/anchors/:day, /proof, /run) read R2 under keys built from
// `session.tenant`, so tenant separation on those routes IS the key builder. Dropping `${tenant}`
// from either template is already caught — but only INCIDENTALLY, and never in this package:
// the receipt key by the REQ-014 DoD test above (it reads the hardcoded literal
// `anchors/${TENANT}/${day}/tsr.der`), the manifest key by two cases in
// workers/api/test/anchors.test.ts (they SEED a hardcoded literal, then read through the route).
// Both catches depend on a test-side literal sitting opposite the builder. The obvious cleanup —
// replacing those literals with calls to the builder — would move seed and read together and
// blind every one of them at once, with no test failing to announce it. This assertion is the
// one that survives that refactor, because asserting the literal shape IS its purpose.
// Measured, not assumed: mutating each builder alone, then re-running both suites (audit §174).
describe("REQ-025 — anchor R2 keys are tenant-partitioned", () => {
  it("both builders embed the tenant, so no two tenants can address the same object", () => {
    expect(anchorManifestKey("tenant-a", "2026-07-15")).toBe("anchors/tenant-a/2026-07-15/manifest.json");
    expect(anchorReceiptKey("tenant-a", "2026-07-15")).toBe("anchors/tenant-a/2026-07-15/tsr.der");

    // the property that matters: same day, different tenant → disjoint keys
    for (const key of [anchorManifestKey, anchorReceiptKey]) {
      expect(key("tenant-a", "2026-07-15")).not.toBe(key("tenant-b", "2026-07-15"));
      expect(key("tenant-a", "2026-07-15").startsWith("anchors/tenant-a/")).toBe(true);
    }
  });
});
