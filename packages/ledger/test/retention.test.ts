import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrate.js";
import {
  POD_RETAINED_KINDS,
  RETENTION_CLASS_DEFAULT,
  RETENTION_CLASS_POD_7YR,
  computeTenantStorageBytes,
  estimateStorageCostCents,
  evidenceTenantPrefix,
  isTenantEvidenceKey,
  retentionClassFor,
  retentionMsFor,
  sweepTenantExpiredDocuments,
  tenantStorageReading,
} from "../src/documents/retention.js";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";
import partyRefsGuard from "../../../db/tenant/migrations/0004_party_refs_guard.sql?raw";
import documentsRetention from "../../../db/tenant/migrations/0007_documents_retention.sql?raw";

// WP-11 Task 12 (REQ-116) — R2 lifecycle per document kind (7yr POD, shorter others) + the retention SWEEP +
// the storage-cost metric. vitest-pool-workers isolates storage PER TEST (each it's D1 + R2 writes roll back),
// so every test seeds its own rows/objects. A = tenant-a's D1, B = tenant-b's D1, ONE shared R2 (EVIDENCE) —
// tenant separation is the KEY NAMESPACE (`evidence/<tenant>/…`), which is exactly what the sweep must honor.

const A = env.TENANT_A_DB;
const B = env.TENANT_B_DB;
const R2 = env.EVIDENCE;

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;
const NOW = Date.parse("2026-07-18T00:00:00Z");

const MIGRATIONS = [
  { path: "0001_ledger_core.sql", sql: ledgerCore },
  { path: "0002_domain.sql", sql: domain },
  { path: "0003_insert_guards.sql", sql: insertGuards },
  { path: "0004_party_refs_guard.sql", sql: partyRefsGuard },
  { path: "0007_documents_retention.sql", sql: documentsRetention },
];

let seedN = 0;
function bytesOf(size: number): Uint8Array {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (seedN + i) & 0xff;
  seedN += 1;
  return b;
}

interface SeedDoc {
  db: D1Database;
  tenant: string;
  id: string;
  kind: string;
  shipment: string;
  hash: string;
  lifecycleClass: string;
  createdTs: number;
  size?: number;
  key?: string; // override the r2_key (for the foreign-key defense case); default = the tenant evidence key
}

// Seed a documents row AND its R2 object together (the row-iff-bytes invariant at rest). Returns the r2_key.
async function seedDoc(d: SeedDoc): Promise<string> {
  const key = d.key ?? `${evidenceTenantPrefix(d.tenant)}${d.shipment}/${d.hash}`;
  await R2.put(key, bytesOf(d.size ?? 32));
  await d.db
    .prepare(
      "INSERT INTO documents (id, shipment_id, party_id, kind, r2_key, hash, lifecycle_class, visibility, created_ts, retention_status) " +
        "VALUES (?,?,?,?,?,?,?,?,?, 'active')",
    )
    .bind(d.id, d.shipment, null, d.kind, key, d.hash, d.lifecycleClass, "counterparty", d.createdTs)
    .run();
  return key;
}

async function retentionStatus(db: D1Database, id: string): Promise<string | null> {
  const row = await db.prepare("SELECT retention_status FROM documents WHERE id = ?").bind(id).first<{ retention_status: string }>();
  return row?.retention_status ?? null;
}

beforeAll(async () => {
  await applyMigrations(A, MIGRATIONS);
  await applyMigrations(B, MIGRATIONS);
});

describe("REQ-116 — the kind → retention-class map (durations)", () => {
  it("POD and its tsa_receipt witness are the 7-year class; every other kind is the shorter default", () => {
    expect(retentionClassFor("POD")).toBe(RETENTION_CLASS_POD_7YR);
    expect(retentionClassFor("tsa_receipt")).toBe(RETENTION_CLASS_POD_7YR);
    for (const k of ["photo", "ratecon", "COI", "W9", "BOL", "invoice", "claim", "WI_cert"]) {
      expect(retentionClassFor(k)).toBe(RETENTION_CLASS_DEFAULT);
    }
  });

  it("retentionMsFor: default = 1 year; pod-7yr = 7 years; an UNKNOWN class FAILS SAFE to the longest (7yr)", () => {
    expect(retentionMsFor(RETENTION_CLASS_DEFAULT)).toBe(1 * YEAR_MS);
    expect(retentionMsFor(RETENTION_CLASS_POD_7YR)).toBe(7 * YEAR_MS);
    // fail-safe: only the exact 'default' string is short — an unknown/legacy class keeps the LONGEST hold
    expect(retentionMsFor("something-unrecognized")).toBe(7 * YEAR_MS);
    expect(retentionMsFor("")).toBe(7 * YEAR_MS);
  });

  it("isTenantEvidenceKey scopes to the tenant's own evidence prefix (REQ-025)", () => {
    expect(isTenantEvidenceKey("evidence/tenant-a/shp/hash", "tenant-a")).toBe(true);
    expect(isTenantEvidenceKey("evidence/tenant-b/shp/hash", "tenant-a")).toBe(false);
    expect(isTenantEvidenceKey("anchors/tenant-a/2026-07-09/tsr.der", "tenant-a")).toBe(false);
  });
});

describe("REQ-116 — the retention sweep deletes expired non-POD bytes + tombstones the row", () => {
  it("an EXPIRED photo → bytes DELETED, row TOMBSTONED ('expired'), NOT hard-deleted (audit trail kept)", async () => {
    const key = await seedDoc({
      db: A, tenant: "tenant-a", id: "ret-photo-exp", kind: "photo", shipment: "ret-shp-1",
      hash: "a".repeat(64), lifecycleClass: RETENTION_CLASS_DEFAULT, createdTs: NOW - 2 * YEAR_MS, // 2yr > 1yr default
    });
    expect(await R2.head(key), "the object exists before the sweep").not.toBeNull();

    const res = await sweepTenantExpiredDocuments(A, R2, "tenant-a", NOW);
    expect(res.deleted).toBe(1);

    // bytes GONE, but the row SURVIVES as a tombstone (the doc existed + was retention-deleted) — row-iff-bytes:
    // no ACTIVE row claims bytes that are gone, and the deleted bytes still carry a row record (never orphaned).
    expect(await R2.head(key), "the expired object's bytes are deleted").toBeNull();
    expect(await retentionStatus(A, "ret-photo-exp")).toBe("expired");
    const row = await A.prepare("SELECT COUNT(*) AS n FROM documents WHERE id = ?").bind("ret-photo-exp").first<{ n: number }>();
    expect(row?.n, "the row is tombstoned, never hard-deleted").toBe(1);
  });

  it("a NOT-YET-EXPIRED photo is RETAINED (bytes + active row untouched)", async () => {
    const key = await seedDoc({
      db: A, tenant: "tenant-a", id: "ret-photo-fresh", kind: "photo", shipment: "ret-shp-2",
      hash: "b".repeat(64), lifecycleClass: RETENTION_CLASS_DEFAULT, createdTs: NOW, // brand new
    });
    const res = await sweepTenantExpiredDocuments(A, R2, "tenant-a", NOW);
    expect(res.deleted).toBe(0);
    expect(res.retained).toBe(1);
    expect(await R2.head(key), "a fresh doc's bytes are kept").not.toBeNull();
    expect(await retentionStatus(A, "ret-photo-fresh")).toBe("active");
  });

  it("a POD is KEPT — even 'expired' by age it is the 7-year compliance class, never swept", async () => {
    // created 10 years ago: past ANY default hold, but POD is 7yr AND excluded by kind (belt+suspenders).
    const key = await seedDoc({
      db: A, tenant: "tenant-a", id: "ret-pod", kind: "POD", shipment: "ret-shp-3",
      hash: "c".repeat(64), lifecycleClass: RETENTION_CLASS_POD_7YR, createdTs: NOW - 10 * YEAR_MS,
    });
    const res = await sweepTenantExpiredDocuments(A, R2, "tenant-a", NOW);
    expect(res.deleted).toBe(0);
    expect(await R2.head(key), "a POD's bytes are NEVER retention-deleted (7yr)").not.toBeNull();
    expect(await retentionStatus(A, "ret-pod")).toBe("active");
  });

  it("IDEMPOTENT — a re-sweep of an already-tombstoned doc is a total no-op", async () => {
    const key = await seedDoc({
      db: A, tenant: "tenant-a", id: "ret-idem", kind: "photo", shipment: "ret-shp-4",
      hash: "d".repeat(64), lifecycleClass: RETENTION_CLASS_DEFAULT, createdTs: NOW - 2 * YEAR_MS,
    });
    const first = await sweepTenantExpiredDocuments(A, R2, "tenant-a", NOW);
    expect(first.deleted).toBe(1);
    const second = await sweepTenantExpiredDocuments(A, R2, "tenant-a", NOW);
    expect(second.scanned, "a tombstoned doc is no longer a candidate").toBe(0);
    expect(second.deleted).toBe(0);
    expect(await R2.head(key)).toBeNull();
    expect(await retentionStatus(A, "ret-idem")).toBe("expired");
  });

  it("DEFENSE-IN-DEPTH — a row whose r2_key is NOT under this tenant's prefix is SKIPPED, never deleted", async () => {
    // A tenant-a row carrying a tenant-b key (corruption/foreign) must NOT be deleted by the tenant-a sweep.
    const foreignKey = "evidence/tenant-b/xshp/eeee";
    await R2.put(foreignKey, bytesOf(16));
    await A.prepare(
      "INSERT INTO documents (id, shipment_id, party_id, kind, r2_key, hash, lifecycle_class, visibility, created_ts, retention_status) VALUES (?,?,?,?,?,?,?,?,?, 'active')",
    )
      .bind("ret-foreign", "xshp", null, "photo", foreignKey, "e".repeat(64), RETENTION_CLASS_DEFAULT, "counterparty", NOW - 2 * YEAR_MS)
      .run();
    const res = await sweepTenantExpiredDocuments(A, R2, "tenant-a", NOW);
    expect(res.skipped_foreign_key).toBe(1);
    expect(res.deleted).toBe(0);
    expect(await R2.head(foreignKey), "a foreign-namespace key is never deleted by this tenant's sweep").not.toBeNull();
    expect(await retentionStatus(A, "ret-foreign")).toBe("active");
  });
});

describe("REQ-116/025 — the sweep is TENANT-BOUND: a tenant-a sweep never touches tenant-b bytes or rows", () => {
  it("tenant-a sweep deletes tenant-a's expired photo but leaves tenant-b's identical-age photo intact", async () => {
    const aKey = await seedDoc({
      db: A, tenant: "tenant-a", id: "iso-a-photo", kind: "photo", shipment: "iso-shp",
      hash: "1".repeat(64), lifecycleClass: RETENTION_CLASS_DEFAULT, createdTs: NOW - 2 * YEAR_MS,
    });
    const bKey = await seedDoc({
      db: B, tenant: "tenant-b", id: "iso-b-photo", kind: "photo", shipment: "iso-shp",
      hash: "2".repeat(64), lifecycleClass: RETENTION_CLASS_DEFAULT, createdTs: NOW - 2 * YEAR_MS,
    });

    // Run ONLY the tenant-a sweep (its D1 + the tenant-a key scope).
    const res = await sweepTenantExpiredDocuments(A, R2, "tenant-a", NOW);
    expect(res.deleted).toBe(1);

    // tenant-a's expired photo is deleted + tombstoned…
    expect(await R2.head(aKey)).toBeNull();
    expect(await retentionStatus(A, "iso-a-photo")).toBe("expired");
    // …but tenant-b's object AND its row are completely untouched (isolation).
    expect(await R2.head(bKey), "tenant-b's bytes must survive a tenant-a sweep").not.toBeNull();
    expect(await retentionStatus(B, "iso-b-photo"), "tenant-b's row must stay active").toBe("active");
  });
});

describe("REQ-116 — the storage-cost metric (a metric, NOT a money_line)", () => {
  it("computeTenantStorageBytes sums ONLY the tenant's evidence-prefix objects; cost is integer cents", async () => {
    await seedDoc({ db: A, tenant: "tenant-a", id: "sc-a1", kind: "photo", shipment: "sc-shp", hash: "10".padEnd(64, "0"), lifecycleClass: RETENTION_CLASS_DEFAULT, createdTs: NOW, size: 100 });
    await seedDoc({ db: A, tenant: "tenant-a", id: "sc-a2", kind: "photo", shipment: "sc-shp", hash: "11".padEnd(64, "0"), lifecycleClass: RETENTION_CLASS_DEFAULT, createdTs: NOW, size: 250 });
    // a tenant-b object in the SAME R2 must NOT count toward tenant-a's storage (REQ-025).
    await seedDoc({ db: B, tenant: "tenant-b", id: "sc-b1", kind: "photo", shipment: "sc-shp", hash: "12".padEnd(64, "0"), lifecycleClass: RETENTION_CLASS_DEFAULT, createdTs: NOW, size: 9000 });

    const bytes = await computeTenantStorageBytes(R2, "tenant-a");
    expect(bytes, "only tenant-a's 100 + 250 bytes are summed").toBe(350);

    const reading = await tenantStorageReading(R2, "tenant-a");
    expect(reading.bytes).toBe(350);
    expect(Number.isInteger(reading.cost_cents)).toBe(true);
    expect(reading.cost_cents).toBeGreaterThanOrEqual(0);
  });

  it("estimateStorageCostCents scales with bytes at the documented rate (integer cents, never negative)", () => {
    expect(estimateStorageCostCents(0)).toBe(0);
    // 100 GB * 1.5¢/GB-month = 150¢
    expect(estimateStorageCostCents(100 * 1_000_000_000)).toBe(150);
    // a few KB rounds honestly to ~0¢ (the raw byte count carries the meaning at small scale)
    expect(estimateStorageCostCents(2048)).toBe(0);
  });
});

// Audit §95 — the ORDERING, which is the invariant the whole design rests on and which nothing asserted.
//
// `sweepTenantExpiredDocuments` deletes R2 bytes BEFORE tombstoning the row, and the source reasons about why:
// a crash between the two leaves the row 'active' with bytes already gone, so the next tick re-selects and
// completes it (self-healing), and the only torn state is the graceful miss the bytes proxy already 404s on.
// Reverse the two statements and the end state is IDENTICAL — every existing case still passes — but the torn
// state inverts to "row says EXPIRED, bytes still present", which the resolve path does not filter on
// (`routes/documents.ts` selects r2_key without `retention_status`). The safety comes from the ORDER, not a
// guard, so the order needs its own case.
describe("retention sweep ordering — bytes first, tombstone second (audit §95)", () => {
  it("a FAILING tombstone leaves the row ACTIVE with bytes already gone — never 'expired' with bytes present", async () => {
    const key = await seedDoc({
      db: A, tenant: "tenant-a", id: "ret-order-1", kind: "photo", shipment: "ret-shp-ord",
      hash: "d".repeat(64), lifecycleClass: RETENTION_CLASS_DEFAULT, createdTs: NOW - 2 * YEAR_MS,
    });
    // Make ONLY the tombstone UPDATE fail, simulating a crash between the two steps.
    const realPrepare = A.prepare.bind(A);
    const patched = Object.create(A) as D1Database;
    (patched as unknown as { prepare: typeof realPrepare }).prepare = ((sql: string) =>
      /UPDATE documents SET retention_status/i.test(sql)
        ? { bind: () => ({ run: async () => { throw new Error("simulated crash after byte delete"); } }) }
        : realPrepare(sql)) as typeof realPrepare;

    await sweepTenantExpiredDocuments(patched, R2, "tenant-a", NOW).catch(() => undefined);

    // The ONLY acceptable torn state: bytes gone, row still ACTIVE (so the next tick finishes the job).
    expect(await R2.head(key), "bytes are deleted FIRST").toBeNull();
    expect(await retentionStatus(A, "ret-order-1"), "row stays ACTIVE so the sweep self-heals").toBe("active");

    // And the next tick completes it against the real db — proving the self-healing claim, not just the order.
    const res = await sweepTenantExpiredDocuments(A, R2, "tenant-a", NOW);
    expect(res.deleted).toBe(1);
    expect(await retentionStatus(A, "ret-order-1")).toBe("expired");
  });
});

// REQ-015/025 §580 — ONE FAILING ROW ABORTS THE PASS. Pinned as CURRENT behaviour, not endorsed as correct.
//
// §579 found a guard whose discriminating input was a multi-item queue, untested because every case used one
// item. Sweeping the codebase for that shape reached this loop: `sweepTenantExpiredDocuments` iterates rows
// and does `await r2.delete(...)` with NO per-row try — so a row that fails deterministically strands every
// row behind it, on every tick, forever.
//
// The §95 ordering test above covers ONE document and `.catch()`es the throw, which is why the multi-row
// consequence was invisible: with a single row there is nothing behind it to strand.
//
// TWO DEFENSIBLE DESIGNS, and this test does not pick one:
//   • FAIL-FAST (today): the sweep throws, the scheduled run errors, and an operator sees it. A systemic R2
//     fault surfaces immediately instead of being counted and swallowed.
//   • FAIL-SOFT: per-row try/catch with a `skipped_error` counter, as `mirror-sweep.ts` does ("LAW: retain,
//     never drop"). Later rows make progress; the failure becomes a number someone must notice.
//
// The direction is safe either way — evidence is RETAINED too long, never deleted wrongly — so this is not a
// defect to fix on audit initiative. It is a design choice that was never written down, and pinning it means
// a future change to fail-soft is DELIBERATE rather than accidental.
describe("REQ-015 §580: a failing row and the rows behind it", () => {
  it("a deterministic failure on the FIRST expired row leaves the SECOND unprocessed (fail-fast, by design)", async () => {
    const keyA = await seedDoc({
      db: A, tenant: "tenant-a", id: "ret-strand-1", kind: "photo", shipment: "ret-shp-strand",
      hash: "e".repeat(64), lifecycleClass: RETENTION_CLASS_DEFAULT, createdTs: NOW - 2 * YEAR_MS,
    });
    const keyB = await seedDoc({
      db: A, tenant: "tenant-a", id: "ret-strand-2", kind: "photo", shipment: "ret-shp-strand",
      hash: "f".repeat(64), lifecycleClass: RETENTION_CLASS_DEFAULT, createdTs: NOW - 2 * YEAR_MS,
    });

    // Fail the FIRST delete only. Everything else is real.
    const realDelete = R2.delete.bind(R2);
    const patched = Object.create(R2) as R2Bucket;
    (patched as unknown as { delete: typeof realDelete }).delete = (async (k: string) => {
      if (k === keyA) throw new Error("simulated persistent R2 fault");
      return realDelete(k as never);
    }) as typeof realDelete;

    await expect(
      sweepTenantExpiredDocuments(A, patched, "tenant-a", NOW),
      "the sweep propagates the fault rather than counting it",
    ).rejects.toThrow(/simulated persistent R2 fault/);

    // THE POINT: the second row never got its turn. Both are still active, and B's bytes are still present.
    expect(await retentionStatus(A, "ret-strand-2"), "row behind the fault is untouched").toBe("active");
    expect(await R2.head(keyB), "and its bytes are still stored").not.toBeNull();

    // Once the fault clears, the next tick drains BOTH — the stall is a stall, never a loss.
    const res = await sweepTenantExpiredDocuments(A, R2, "tenant-a", NOW);
    expect(res.deleted).toBe(2);
  });
});

// §915 — retention_status IS GUARDED BY THE DB AND BY NOTHING ELSE.
//
// Neutralising its CHECK left the ledger suite green. Unlike `events.visibility`/`source`, this column has
// NO Zod schema anywhere in the repo — every write is a hardcoded SQL literal ('active' / 'expired') in
// retention.ts and the evidence route. So the CHECK is the SOLE enforcement of the tombstone marker's
// domain, and a typo'd literal in a future writer would persist a document in a state the sweep's
// `WHERE retention_status = 'active'` silently skips: bytes that never expire, or a row that never tombstones.
describe("§915: retention_status is constrained by the DB, which is its only guard", () => {
  it("accepts the two legal states and refuses a third", async () => {
    const doc = (id: string, status: string): Promise<D1Result> =>
      A.prepare(
        "INSERT INTO documents (id, shipment_id, kind, r2_key, hash, created_ts, retention_status) VALUES (?, 'S-ret', 'POD', ?, ?, 1000, ?)",
      )
        .bind(id, `evidence/t/${id}`, id.padEnd(64, "0"), status)
        .run();
    await doc("ret-active", "active"); // controls: both legal states insert cleanly…
    await doc("ret-expired", "expired");
    await expect(doc("ret-bad", "archived")).rejects.toThrow(/CHECK/i); // …so this refusal is the domain
  });
});

// §1536 (REQ-116/023/118) — THE EXCLUSION LIST IS THE SOLE GUARD FOR A created_ts OF 0.
//
// `anchor.ts` inserts the daily merkle receipt WITHOUT created_ts, taking 0007's column DEFAULT of 0 — and it
// says so, calling the retention clock "moot" because a tsa_receipt is never swept. That is true, and it is
// true because of a STRING IN ANOTHER FILE. Every retention decision is `created_ts + window`, so a start of 0
// puts EVERY finite window in the past: the 7-year compliance class does NOT protect this row. CANDIDATES_SQL's
// exclusion is the only thing standing between the bytes that make the ledger verifiable and a DELETE.
//
// The comment above that query claimed the exclusion was a redundant "belt … independent of retentionMsFor
// (suspenders)". Measured at §1536: deleting 'tsa_receipt' from the list left 734/734 GREEN, and the receipt's
// bytes were silently swept. The claim is true for a POD (real created_ts + 7yr) and false for the one row that
// needs it. Two guards are only redundant where BOTH can fire.
//
// This derives its subject from POD_RETAINED_KINDS rather than naming the kinds, so a kind added to the
// constant is covered here on the same commit — which is also the drift the fix closed (the SQL was a
// hand-written second copy of that constant, in the same file as the constant).
describe("§1536 REQ-116: the retained-kind exclusion, not the duration, is what saves a created_ts of 0", () => {
  it("every POD_RETAINED_KIND survives a sweep at created_ts 0 — including anchor's receipt", async () => {
    expect(POD_RETAINED_KINDS.length, "an empty retained list would make this pass over nothing").toBeGreaterThanOrEqual(2);
    const keys: string[] = [];
    for (const [i, kind] of POD_RETAINED_KINDS.entries()) {
      keys.push(
        await seedDoc({
          db: A, tenant: "tenant-a", id: `ret-zero-${i}`, kind, shipment: "ret-shp-zero",
          hash: String(i).repeat(64).slice(0, 64),
          // COMPUTED from the same map the writers call — not a hardcoded class, so a re-classified kind
          // cannot make this case quietly stop describing what production stores.
          lifecycleClass: retentionClassFor(kind), createdTs: 0, // the 0007 column DEFAULT anchor.ts relies on
        }),
      );
    }
    // A sweep a century after the epoch: every finite retention window has long since elapsed from 0.
    const res = await sweepTenantExpiredDocuments(A, R2, "tenant-a", 100 * YEAR_MS);
    expect(res.deleted, "a retained kind was swept — the exclusion list no longer covers POD_RETAINED_KINDS").toBe(0);
    for (const [i, key] of keys.entries()) {
      expect(await R2.head(key), `${POD_RETAINED_KINDS[i]} bytes were deleted — for tsa_receipt that is the ledger's own witness`).not.toBeNull();
      expect(await retentionStatus(A, `ret-zero-${i}`)).toBe("active");
    }
  });

  it("CONTROL: the SAME row with a non-retained kind IS swept at created_ts 0 — so 0 really is born-expired", async () => {
    // Without this the case above proves only that a sweep ran and deleted nothing, which is also what a
    // broken sweep looks like. This is the same fixture minus the hostile part (§1534): identical tenant,
    // shipment and created_ts, one field changed — and it must DIE where the retained kinds live.
    const key = await seedDoc({
      db: A, tenant: "tenant-a", id: "ret-zero-control", kind: "photo", shipment: "ret-shp-zero",
      hash: "c".repeat(64), lifecycleClass: retentionClassFor("photo"), createdTs: 0,
    });
    expect(POD_RETAINED_KINDS.includes("photo"), "the control must NOT be a retained kind, or it proves nothing").toBe(false);
    const res = await sweepTenantExpiredDocuments(A, R2, "tenant-a", 100 * YEAR_MS);
    expect(res.deleted, "created_ts 0 did NOT expire — then the case above is not testing what it claims").toBe(1);
    expect(await R2.head(key)).toBeNull();
  });
});
