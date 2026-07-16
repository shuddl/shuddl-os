import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { EVENT_KINDS, eventFixture, type EventKind, type LedgerEvent, type SessionClaims } from "@shuddl/contracts";
import { buildChain, hashEvent } from "../src/chain.js";
import { eventToRow, lensFor, lensWhere, readEvents, rowToEvent } from "../src/lens.js";
import { applyMigrations } from "../src/migrate.js";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";
import partyRefsGuard from "../../../db/tenant/migrations/0004_party_refs_guard.sql?raw";
import eventsOverride from "../../../db/tenant/migrations/0005_events_override.sql?raw";
import booking from "../../../db/tenant/migrations/0006_booking.sql?raw";

const DB = env.TENANT_A_DB;

// ---- lensFor -------------------------------------------------------------
describe("lensFor: JWT role -> lens scope (party_id comes ONLY from the claim)", () => {
  const base: Omit<SessionClaims, "role"> = { sub: "u1", tenant: "t", exp: 2_000_000_000 };
  it("admin/ops/finance/read -> tenant scope", () => {
    for (const role of ["admin", "ops", "finance", "read"] as const) {
      expect(lensFor({ ...base, role })).toEqual({ scope: "tenant" });
    }
  });
  it("driver -> driver scope keyed by the token subject", () => {
    expect(lensFor({ ...base, role: "driver" })).toEqual({ scope: "driver", userId: "u1" });
  });
  it("portal with party_id -> party scope", () => {
    expect(lensFor({ ...base, role: "portal", party_id: "party-acme" })).toEqual({
      scope: "party",
      partyId: "party-acme",
    });
  });
  it("portal WITHOUT party_id throws LENS_UNRESOLVED", () => {
    expect(() => lensFor({ ...base, role: "portal" })).toThrow(/LENS_UNRESOLVED/);
  });
});

// ---- lensWhere goldens + injection ---------------------------------------
describe("lensWhere: SQL goldens (a WHERE regression is a visible diff)", () => {
  it("tenant fragment", () => expect(lensWhere({ scope: "tenant" })).toMatchSnapshot());
  it("party fragment", () => expect(lensWhere({ scope: "party", partyId: "party-acme" })).toMatchSnapshot());
  it("driver fragment", () => expect(lensWhere({ scope: "driver", userId: "u-driver" })).toMatchSnapshot());

  it("driver kinds are a fixed compile-time allowlist BOUND as params — never interpolated", () => {
    const f = lensWhere({ scope: "driver", userId: "u'; DROP TABLE events;--" });
    // the malicious userId never touches the SQL string; it is the last bound param.
    expect(f.sql).not.toContain("DROP TABLE");
    expect(f.params[f.params.length - 1]).toBe("u'; DROP TABLE events;--");
    // no kind literal is interpolated — the allowlist is 17 '?' placeholders.
    expect(f.sql).not.toContain("pod.signed");
    expect(f.sql).not.toContain("dispatch.assigned");
    expect(f.params).toHaveLength(18); // 17 kinds + userId
  });
});

// ---- rowToEvent / eventToRow round-trip against a REAL D1 (hash-critical) --
describe("rowToEvent: SQL NULL -> omitted key (undefined), never null (hash-critical)", () => {
  beforeAll(async () => {
    await applyMigrations(DB, [
      { path: "0001_ledger_core.sql", sql: ledgerCore },
      { path: "0002_domain.sql", sql: domain },
      { path: "0003_insert_guards.sql", sql: insertGuards },
      { path: "0004_party_refs_guard.sql", sql: partyRefsGuard },
      { path: "0005_events_override.sql", sql: eventsOverride },
      { path: "0006_booking.sql", sql: booking },
    ]);
  });

  async function insertRow(row: Record<string, string | number | null>): Promise<void> {
    const cols = Object.keys(row);
    await DB.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .bind(...cols.map((c) => row[c]))
      .run();
  }

  it("0004 guard: a scalar (non-array) party_refs is rejected at write time (I6 defense-in-depth)", async () => {
    const [e] = await buildChain([
      eventFixture("quote.requested", { id: crypto.randomUUID(), stream_id: "t:root", shipment_id: undefined }),
    ]);
    const row = eventToRow(e!);
    row.party_refs = '"party-acme"'; // a JSON scalar, not an array — would make json_each match then Zod throw
    await expect(insertRow(row)).rejects.toThrow(/party_refs must be a JSON array/);
  });

  it("a NULL-heavy event: hashEvent(rowToEvent(row)) === stored hash, and the inverse round-trips", async () => {
    // shipment_id, actor.user, actor.device, device_id, device_seq, captured_ts, sig all absent.
    const [e] = await buildChain([
      eventFixture("quote.requested", {
        id: "00000000-0000-4000-8000-000000000010",
        stream_id: "t:root",
        shipment_id: undefined,
        actor: { party: "party-shipper" },
      }),
    ]);
    await insertRow(eventToRow(e!));
    const row = (await DB.prepare("SELECT * FROM events WHERE id = ?")
      .bind(e!.id)
      .first<Record<string, string | number | null>>())!;

    // The columns are genuinely NULL in the database.
    for (const col of ["shipment_id", "actor_user_id", "actor_device_id", "device_id", "device_seq", "captured_ts", "sig"]) {
      expect(row[col]).toBeNull();
    }

    const rebuilt = rowToEvent(row);
    // NULL mapped to an OMITTED key, not a null — the hash law depends on it.
    expect("shipment_id" in rebuilt).toBe(false);
    expect("user" in rebuilt.actor).toBe(false);
    expect("device" in rebuilt.actor).toBe(false);
    expect("sig" in rebuilt).toBe(false);

    // Hash-critical: the recomputed hash matches the stored one (would drift if NULL -> null).
    expect(await hashEvent(rebuilt)).toBe(e!.hash);
    expect(row.hash).toBe(e!.hash);

    // Inverse: eventToRow(rowToEvent(row)) deep-equals the original DB row.
    expect(eventToRow(rebuilt)).toEqual(row);
  });

  it("a fully-populated event (actor.user/device, device cols, sig) also round-trips to its hash", async () => {
    // WP-05 exit audit (REQ-016): a device-namespaced event MUST be co-signed BY that device, so
    // device_id === actor.device (the pod.signed fixture's actor.device is "device-1") AND it carries a
    // signature. `sig` is excluded from the hash-view, so it does not move the hash.
    const [e] = await buildChain([
      eventFixture("pod.signed", {
        id: "00000000-0000-4000-8000-000000000011",
        device_id: "device-1",
        device_seq: 3,
        captured_ts: 1_720_000_000_100,
        sig: "AAAA",
      }),
    ]);
    await insertRow(eventToRow(e!));
    const row = (await DB.prepare("SELECT * FROM events WHERE id = ?")
      .bind(e!.id)
      .first<Record<string, string | number | null>>())!;

    const rebuilt = rowToEvent(row);
    expect(rebuilt.actor.user).toBe("user-driver");
    expect(rebuilt.actor.device).toBe("device-1");
    expect(rebuilt.device_id).toBe("device-1");
    expect(rebuilt.device_seq).toBe(3);
    expect(rebuilt.captured_ts).toBe(1_720_000_000_100);
    expect(rebuilt.sig).toBe("AAAA");
    expect(await hashEvent(rebuilt)).toBe(e!.hash);
    expect(eventToRow(rebuilt)).toEqual(row);
  });

  it("every one of the 35 kinds survives eventToRow -> rowToEvent with an identical hash", async () => {
    let n = 100;
    for (const kind of EVENT_KINDS) {
      n += 1;
      const [e] = await buildChain([
        eventFixture(kind, { id: `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}` }),
      ]);
      // route each kind onto its own stream so (stream_id, seq) never collides across kinds
      const onStream = { ...e!, stream_id: `s:k${n}`, shipment_id: `k${n}` } as LedgerEvent;
      const [rebuiltChain] = await buildChain([onStream]);
      await insertRow(eventToRow(rebuiltChain!));
      const row = (await DB.prepare("SELECT * FROM events WHERE id = ?")
        .bind(rebuiltChain!.id)
        .first<Record<string, string | number | null>>())!;
      expect(await hashEvent(rowToEvent(row))).toBe(rebuiltChain!.hash);
    }
  });
});

// ---- readEvents scoping against a seeded D1 ------------------------------
describe("readEvents: lens-scoped reads (I6, adversarial visibility)", () => {
  const B = env.TENANT_B_DB;
  let hashN = 0;
  const nextHash = (): string => (++hashN).toString(16).padStart(64, "0");

  async function insertRowB(row: Record<string, string | number | null>): Promise<void> {
    const cols = Object.keys(row);
    await B.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .bind(...cols.map((c) => row[c]))
      .run();
  }
  async function seed(kind: EventKind, over: Partial<LedgerEvent>): Promise<void> {
    const e = eventFixture(kind, { id: crypto.randomUUID(), ...over });
    const row = eventToRow(e);
    row.hash = nextHash();
    await insertRowB(row);
  }

  beforeAll(async () => {
    await applyMigrations(B, [
      { path: "0001_ledger_core.sql", sql: ledgerCore },
      { path: "0002_domain.sql", sql: domain },
      { path: "0003_insert_guards.sql", sql: insertGuards },
      { path: "0004_party_refs_guard.sql", sql: partyRefsGuard },
      { path: "0005_events_override.sql", sql: eventsOverride },
      { path: "0006_booking.sql", sql: booking },
    ]);
    await B.prepare(
      "INSERT INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, created_ts, status_cache) VALUES ('shpA','p','p','p',0,?)",
    )
      .bind(JSON.stringify({ assigned_driver: "drv-1", out_for_delivery: false }))
      .run();
    await B.prepare(
      "INSERT INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, created_ts, status_cache) VALUES ('shpB','p','p','p',0,?)",
    )
      .bind(JSON.stringify({ assigned_driver: "drv-2" }))
      .run();

    const acme = ["party-acme"];
    await seed("dispatch.assigned", { stream_id: "s:shpA", shipment_id: "shpA", seq: 0, visibility: "counterparty", party_refs: acme });
    await seed("quote.priced", { stream_id: "s:shpA", shipment_id: "shpA", seq: 1, visibility: "counterparty", party_refs: acme });
    await seed("credit.checked", { stream_id: "s:shpA", shipment_id: "shpA", seq: 2, visibility: "internal", party_refs: acme });
    await seed("position.updated", {
      stream_id: "s:shpA",
      shipment_id: "shpA",
      seq: 3,
      visibility: "counterparty",
      party_refs: acme,
      payload: { lat_e6: 37_421_777, lon_e6: -122_084_333, accuracy_m: 5, speed_cms: 1_500 },
    });
    await seed("pod.signed", { stream_id: "s:shpB", shipment_id: "shpB", seq: 0, visibility: "counterparty", party_refs: ["party-other"] });

    // Driver-visibility fixtures (I6). shipment id "aShpC" sorts BEFORE "s:shpA" so it never
    // perturbs the shpA/shpB after_seq + composite-cursor assertions below. drv-3 owns it.
    await B.prepare(
      "INSERT INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, created_ts, status_cache) VALUES ('aShpC','p','p','p',0,?)",
    )
      .bind(JSON.stringify({ assigned_driver: "drv-3" }))
      .run();
    const px = ["party-x"];
    // Two internal driver-kind events + one counterparty driver-kind event, all on drv-3's shipment.
    await seed("pod.signed", { stream_id: "s:aShpC", shipment_id: "aShpC", seq: 0, visibility: "internal", party_refs: px });
    await seed("exception.raised", { stream_id: "s:aShpC", shipment_id: "aShpC", seq: 1, visibility: "internal", party_refs: px });
    await seed("pod.signed", { stream_id: "s:aShpC", shipment_id: "aShpC", seq: 2, visibility: "counterparty", party_refs: px });
  });

  it("tenant lens sees every seeded event, unredacted", async () => {
    const res = await readEvents(B, { scope: "tenant" }, {});
    expect(res).toHaveLength(8);
    const priced = res.find((e) => e.kind === "quote.priced")!;
    expect((priced.payload as Record<string, unknown>).floors).toBeDefined();
  });

  it("driver lens RESPECTS visibility — an internal event on the driver's own shipment is invisible (I6)", async () => {
    const res = await readEvents(B, { scope: "driver", userId: "drv-3" }, {});
    // Only the counterparty pod.signed survives; the two internal driver-kind events are filtered.
    expect(res).toHaveLength(1);
    expect(res.every((e) => e.visibility !== "internal")).toBe(true);
    expect(res[0]!.kind).toBe("pod.signed");
    expect(res[0]!.visibility).toBe("counterparty");
  });

  it("party lens sees only non-internal events referencing the party — internal is invisible (I6)", async () => {
    const res = await readEvents(B, { scope: "party", partyId: "party-acme" }, {});
    const kinds = res.map((e) => e.kind).sort();
    expect(kinds).toEqual(["dispatch.assigned", "position.updated", "quote.priced"]);
    expect(res.some((e) => e.kind === "credit.checked")).toBe(false); // internal filtered
    expect(res.some((e) => e.shipment_id === "shpB")).toBe(false); // other party's shipment
  });

  it("party lens redacts quote internals and generalizes position pre-OFD", async () => {
    const res = await readEvents(B, { scope: "party", partyId: "party-acme" }, {});
    const priced = res.find((e) => e.kind === "quote.priced")!;
    expect((priced.payload as Record<string, unknown>).floors).toBeUndefined();
    expect((priced.payload as Record<string, unknown>).sell).toBeDefined();
    const pos = res.find((e) => e.kind === "position.updated")!;
    expect((pos.payload as Record<string, unknown>).lat_e6).toBe(37_400_000);
    expect((pos.payload as Record<string, unknown>).accuracy_m).toBeUndefined();
  });

  it("driver lens sees only allowlisted kinds on shipments assigned to that driver", async () => {
    const res = await readEvents(B, { scope: "driver", userId: "drv-1" }, {});
    expect(res.map((e) => e.kind)).toEqual(["dispatch.assigned"]); // pod.signed is on drv-2's shpB
  });

  it("after_seq WITHOUT a shipment_id scope throws (a bare across-stream cursor silently drops rows)", async () => {
    await expect(readEvents(B, { scope: "tenant" }, { after_seq: 0 })).rejects.toThrow(/shipment_id|INVALID_CURSOR/);
  });

  it("after_seq and cursor together is rejected (two conflicting pagination modes)", async () => {
    await expect(
      readEvents(B, { scope: "tenant" }, { shipment_id: "shpA", after_seq: 0, cursor: { stream_id: "s:shpA", seq: 0 } }),
    ).rejects.toThrow(/INVALID_CURSOR|mutually exclusive/);
  });

  it("after_seq is valid inside a shipment_id scope", async () => {
    const res = await readEvents(B, { scope: "tenant" }, { shipment_id: "shpA", after_seq: 1 });
    expect(res.every((e) => e.shipment_id === "shpA" && e.seq > 1)).toBe(true);
    expect(res).toHaveLength(2); // seq 2 (credit.checked) + seq 3 (position.updated)
  });

  it("composite cursor keysets across streams", async () => {
    const res = await readEvents(B, { scope: "tenant" }, { cursor: { stream_id: "s:shpA", seq: 3 } });
    expect(res.map((e) => e.stream_id)).toEqual(["s:shpB"]);
  });

  it("limit is honored (and capped at 1000 internally)", async () => {
    const res = await readEvents(B, { scope: "tenant" }, { limit: 2 });
    expect(res).toHaveLength(2);
  });

  // ---- REQ-082/083: the kind filter (command queues + KPI click-through) ---------------------------
  // The filter ANDs an `e.kind IN (...)` on top of the lens WHERE + cursor — it can only NARROW a lens,
  // never widen it. Proven here against the party/driver visibility scopes (an internal kind stays hidden
  // even when explicitly requested).
  it("kind filter (single) narrows a tenant read to just that kind", async () => {
    const res = await readEvents(B, { scope: "tenant" }, { kind: "pod.signed" });
    // pod.signed: shpB seq0 (counterparty) + aShpC seq0 (internal) + aShpC seq2 (counterparty). Tenant sees all.
    expect(res).toHaveLength(3);
    expect(res.every((e) => e.kind === "pod.signed")).toBe(true);
  });

  it("kind filter (set) narrows to the union of the requested kinds", async () => {
    const res = await readEvents(B, { scope: "tenant" }, { kind: ["dispatch.assigned", "quote.priced"] });
    expect(res.map((e) => e.kind).sort()).toEqual(["dispatch.assigned", "quote.priced"]); // both on shpA
  });

  it("kind filter composes with the party lens and NEVER widens it — an internal kind stays invisible", async () => {
    // credit.checked EXISTS on party-acme's shipment but is internal; requesting it explicitly returns nothing.
    const res = await readEvents(B, { scope: "party", partyId: "party-acme" }, { kind: "credit.checked" });
    expect(res).toEqual([]);
  });

  it("kind filter within a party lens narrows to the requested VISIBLE kind only", async () => {
    const res = await readEvents(B, { scope: "party", partyId: "party-acme" }, { kind: ["quote.priced", "credit.checked"] });
    // credit.checked is filtered by the lens (internal); only the visible quote.priced survives.
    expect(res.map((e) => e.kind)).toEqual(["quote.priced"]);
  });

  it("kind filter composes with the driver allowlist (intersection) — a non-matching kind is empty", async () => {
    const dispatch = await readEvents(B, { scope: "driver", userId: "drv-1" }, { kind: "dispatch.assigned" });
    expect(dispatch.map((e) => e.kind)).toEqual(["dispatch.assigned"]);
    // pod.signed lives on OTHER drivers' shipments — drv-1's assignment scope + the kind IN yield nothing.
    const none = await readEvents(B, { scope: "driver", userId: "drv-1" }, { kind: "pod.signed" });
    expect(none).toEqual([]);
  });

  it("kind filter composes with a shipment scope + after_seq cursor (all three AND together)", async () => {
    const res = await readEvents(B, { scope: "tenant" }, { shipment_id: "shpA", after_seq: 0, kind: "position.updated" });
    // shpA seq>0 AND kind=position.updated -> only seq 3.
    expect(res.map((e) => e.seq)).toEqual([3]);
    expect(res.every((e) => e.kind === "position.updated")).toBe(true);
  });
});
