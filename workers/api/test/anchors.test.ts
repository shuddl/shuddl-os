import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { eventFixture, type LedgerEvent } from "@shuddl/contracts";
import { eventToRow } from "@shuddl/ledger/lens";
import { bytesToHex, hexToBytes, merkleRoot, verifyInclusion } from "@shuddl/ledger/merkle";
import { ensureSchema, token, TENANT_SLUG } from "./helpers.js";

// REQ-014 — the anchors read/verify routes. Shared D1 across files (isolatedStorage:false), so every
// id is scoped to this file and a FAR-FUTURE day (2999-...) no other file or the backfill touches.

const DAY = "2999-01-15";
const RECEIPT_KEY = `anchors/${TENANT_SLUG}/${DAY}/tsr.der`;
const noon = Date.parse(`${DAY}T12:00:00Z`);
const H1 = "aa".repeat(32);
const H2 = "bb".repeat(32);
const H3 = "ee".repeat(32);

const EVENT_COLUMNS = [
  "stream_id", "seq", "id", "shipment_id", "ts", "recorded_at", "kind",
  "actor_party_id", "actor_user_id", "actor_device_id", "party_refs", "payload",
  "evidence", "prev_hash", "hash", "sig", "visibility", "source", "confidence",
  "device_id", "device_seq", "captured_ts",
] as const;

async function insertEvent(e: LedgerEvent): Promise<void> {
  const row = eventToRow(e);
  await env.TENANT_A_DB
    .prepare(`INSERT OR IGNORE INTO events (${EVENT_COLUMNS.join(",")}) VALUES (${EVENT_COLUMNS.map(() => "?").join(",")})`)
    .bind(...EVENT_COLUMNS.map((c) => row[c] ?? null))
    .run();
}

const opsTok = (): Promise<string> => token({ sub: "anch-ops", tenant: TENANT_SLUG, role: "ops" });
const adminTok = (): Promise<string> => token({ sub: "anch-admin", tenant: TENANT_SLUG, role: "admin" });
const portalTok = (): Promise<string> => token({ sub: "anch-portal", tenant: TENANT_SLUG, role: "portal", party_id: "anch-party" });
const bearer = (t: string): { Authorization: string } => ({ Authorization: `Bearer ${t}` });

let root: string;

beforeAll(async () => {
  await ensureSchema(env);
  const e1 = eventFixture("stop.arrived", { id: "00000000-0000-4000-8000-0000000a0001", hash: H1, stream_id: "s:anch-1", shipment_id: "anch-1", seq: 0, recorded_at: noon });
  const e2 = eventFixture("pod.signed", { id: "00000000-0000-4000-8000-0000000a0002", hash: H2, stream_id: "s:anch-2", shipment_id: "anch-2", seq: 0, recorded_at: noon });
  await insertEvent(e1);
  await insertEvent(e2);
  // One event on a PAST day, so POST /v1/anchors/run always has something to backfill no matter where
  // this file lands in the suite order. Without it the run can return empty — the fixtures above sit in
  // 2999, so if no other file has yet written an older row, MIN(recorded_at) is in the future and the
  // backfill returns before the day loop, which would make the `failed` assertion below vacuous.
  await insertEvent(
    eventFixture("stop.arrived", {
      id: "00000000-0000-4000-8000-0000000a0003",
      hash: H3,
      stream_id: "s:anch-3",
      shipment_id: "anch-3",
      seq: 0,
      recorded_at: Date.parse("2026-01-05T12:00:00Z"),
    }),
  );
  // events order by (stream_id, seq): s:anch-1 then s:anch-2
  root = bytesToHex(await merkleRoot([hexToBytes(H1), hexToBytes(H2)]));

  await env.TENANT_A_DB
    .prepare("INSERT OR IGNORE INTO documents (id, shipment_id, party_id, kind, r2_key, hash, lifecycle_class, visibility) VALUES (?,?,?,?,?,?,?,?)")
    .bind(`anchor:${DAY}`, null, null, "tsa_receipt", RECEIPT_KEY, root, "default", "internal")
    .run();
  await env.EVIDENCE.put(
    `anchors/${TENANT_SLUG}/${DAY}/manifest.json`,
    JSON.stringify({
      version: "shuddl-anchor-v1",
      tenant: TENANT_SLUG,
      day: DAY,
      root,
      leaf_count: 2,
      event_count: 2,
      position_count: 0,
      imprint: "cc".repeat(32),
      imprint_message: `shuddl-anchor-v1:${TENANT_SLUG}:${DAY}:${root}:2`,
      receipt_key: RECEIPT_KEY,
      created_at: "2999-01-16T01:00:00Z",
    }),
  );
});

describe("REQ-014 — GET /v1/anchors/:day", () => {
  it("tenant role gets the full manifest (with volume counts)", async () => {
    const res = await SELF.fetch(`https://x/v1/anchors/${DAY}`, { headers: bearer(await opsTok()) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.root).toBe(root);
    expect(body.event_count).toBe(2);
    expect(body.leaf_count).toBe(2);
  });

  it("portal role gets ONLY {day, root} — no activity-volume signal (Decision 14)", async () => {
    const res = await SELF.fetch(`https://x/v1/anchors/${DAY}`, { headers: bearer(await portalTok()) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ day: DAY, root });
    expect(body.event_count).toBeUndefined();
    expect(body.leaf_count).toBeUndefined();
  });

  it("a day with no manifest is 404", async () => {
    const res = await SELF.fetch(`https://x/v1/anchors/2999-02-02`, { headers: bearer(await opsTok()) });
    expect(res.status).toBe(404);
  });

  it("a malformed day is a 400", async () => {
    const res = await SELF.fetch(`https://x/v1/anchors/not-a-day`, { headers: bearer(await opsTok()) });
    expect(res.status).toBe(400);
  });
});

describe("REQ-014 — GET /v1/anchors/:day/proof", () => {
  it("any authenticated role can verify a leaf it holds against the anchored root", async () => {
    for (const tok of [opsTok, portalTok]) {
      const res = await SELF.fetch(`https://x/v1/anchors/${DAY}/proof?leaf=${H2}`, { headers: bearer(await tok()) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { day: string; root: string; proof: { side: "L" | "R"; hash: string }[]; receipt_doc_id: string };
      expect(body.root).toBe(root);
      expect(body.receipt_doc_id).toBe(`anchor:${DAY}`);
      expect(await verifyInclusion(hexToBytes(H2), body.proof, hexToBytes(body.root))).toBe(true);
    }
  });

  it("a leaf not in the day is 404", async () => {
    const res = await SELF.fetch(`https://x/v1/anchors/${DAY}/proof?leaf=${"dd".repeat(32)}`, { headers: bearer(await opsTok()) });
    expect(res.status).toBe(404);
  });

  it("a non-hex leaf is 400", async () => {
    const res = await SELF.fetch(`https://x/v1/anchors/${DAY}/proof?leaf=zzzz`, { headers: bearer(await opsTok()) });
    expect(res.status).toBe(400);
  });
});

describe("REQ-014 — POST /v1/anchors/run (admin only)", () => {
  it("ops is forbidden", async () => {
    const res = await SELF.fetch(`https://x/v1/anchors/run`, { method: "POST", headers: { ...bearer(await opsTok()), "Idempotency-Key": "anch-run-ops" } });
    expect(res.status).toBe(403);
  });

  it("admin runs the backfill and gets the three-arrays result", async () => {
    const res = await SELF.fetch(`https://x/v1/anchors/run`, { method: "POST", headers: { ...bearer(await adminTok()), "Idempotency-Key": "anch-run-admin" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { anchored: string[]; skipped: string[]; failed: string[] };
    expect(Array.isArray(body.anchored)).toBe(true);
    expect(Array.isArray(body.skipped)).toBe(true);
    // NOT merely arrays: the backfill walks every unanchored day in the tenant DB, which under
    // isolatedStorage:false holds whatever every other test file wrote. The run used to 500 here, and a
    // shape-only assertion could not tell "backfilled everything" from "gave up on everything". These
    // two together can: the beforeAll seeds a past day, so the loop ALWAYS runs (never a vacuous pass
    // on an empty result), and no day may end in `failed`.
    expect(body.anchored.length + body.skipped.length).toBeGreaterThan(0);
    expect(body.failed).toEqual([]);
  });
});
