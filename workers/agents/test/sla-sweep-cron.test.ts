import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker, { runSlaSweep } from "../src/index.js";
import { sweepTenantOverdueInbound } from "../src/sla-sweep.js";
import { applyAll } from "./helpers.js";

// REQ-095 / REQ-025 — the SLA sweep's CRON WRAPPER contract (the per-tenant BEHAVIOR is proven end-to-end
// in workers/api/test/sla-sweep.test.ts, the harness with the real ShipmentSequencer DO + migrated D1). This
// file pins that the wrapper iterates the tenant allowlist and that scheduled() drives it. With no overdue
// rows the sweep records nothing — it never calls the DO append (this package binds only a STUB sequencer),
// so it must complete cleanly across BOTH allowlisted tenants.

const FIRE_MS = Date.parse("2026-07-15T01:00:00Z");
function controller(scheduledTime = FIRE_MS): ScheduledController {
  return { scheduledTime, cron: "0 1 * * *", noRetry() {} };
}
function ctx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

beforeAll(async () => {
  // runSlaSweep iterates the WHOLE allowlist — both tenant DBs need the `messages`/`events` schema so the
  // per-tenant SELECT does not crash (tenant-b has no overdue rows and must be a clean no-op).
  await applyAll(env.TENANT_A_DB);
  await applyAll(env.TENANT_B_DB);
});

describe("REQ-095 — SLA sweep cron wrapper", () => {
  it("runSlaSweep resolves across every allowlisted tenant when nothing is overdue (no DO append)", async () => {
    await expect(runSlaSweep(env, () => FIRE_MS)).resolves.toBeUndefined();
  });

  it("scheduled() ACTUALLY drives the sweep (per-tenant sweep log emitted) — non-tautological", async () => {
    // Spy the per-tenant sweep log so deleting the runSlaSweep call from scheduled() fails this test (not a
    // did-not-throw tautology). runSlaSweep logs `concierge sla-sweep: tenant <slug> → …` for every tenant.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await worker.scheduled(controller(), env, ctx());
      const sweepLogged = logSpy.mock.calls.some((call) => call.some((a) => typeof a === "string" && a.includes("concierge sla-sweep: tenant")));
      expect(sweepLogged, "scheduled() must invoke runSlaSweep").toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ── §1792 — THE ANTI-JOIN THAT PREVENTS RE-APPEND, ASSERTED WHERE IT NEEDS NO DO ────────────────────────
//
// §1788 measured this module twice and found its load-bearing seam is NOT the note's event id (starving that
// reds 0 here and 0 in `workers/api`) but the note's **body_ref** — the key `OVERDUE_SQL`'s `NOT EXISTS`
// anti-join uses. Starving the body_ref red **0 of 155 here** and **1 of 908 in `workers/api`**.
//
// §1791 closed the watchtower's equivalent gap on the grounds that its dedupe is D1-only. The same is true
// here: the anti-join is pure SQL over `events`, so a test can seed the note row DIRECTLY and never touch the
// stubbed sequencer. That is what these cases do — the seq double below throws if it is ever called, which is
// itself the assertion that the SECOND sweep appends nothing.
/**
 * A MINIMAL raw `events` insert. `seedEvent` builds a validated fixture, and these two kinds need payload
 * shapes the anti-join does not care about — so this writes only the columns `OVERDUE_SQL` actually reads
 * (kind, stream_id, source, payload) plus the NOT NULL envelope. Narrower than the helper on purpose: a
 * fixture that satisfies a schema this query never consults would obscure what the test is about.
 */
async function insertEventRow(kind: string, streamId: string, seq: number, payload: unknown): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "INSERT INTO events (stream_id, seq, id, shipment_id, ts, recorded_at, kind, actor_party_id, " +
      "party_refs, payload, evidence, prev_hash, hash, visibility, source, confidence) " +
      "VALUES (?,?,?,?,?,?,?,?,'[]',?,'[]',?,?,'internal','native',10000)",
  )
    .bind(streamId, seq, `${streamId}:${seq}`, "sla-antijoin", 0, 0, kind, "p:test", JSON.stringify(payload), "", `h${seq}`)
    .run();
}

describe("§1792 REQ-095 — an already-noted inbound drops out of the sweep (the body_ref anti-join, in this package)", () => {
  const MSG_EVENT_ID = "11111111-1111-4111-8111-111111111111";
  const STREAM = "s:sla-antijoin";
  const DUE = 1_000;
  const NOW = 9_000;

  /** A seq that FAILS the test if the sweep tries to append — the second sweep must not. */
  const refusingSeq = { append: () => { throw new Error("the sweep appended when the anti-join should have excluded the row"); } };

  it("with the note ABSENT the row is overdue (the non-vacuity floor — otherwise the next case proves nothing)", async () => {
    await env.TENANT_A_DB.prepare(
      "INSERT OR IGNORE INTO messages (id, channel, direction, body_ref, sla_due_ts) VALUES (?,?,?,?,?)",
    ).bind(`msg:${MSG_EVENT_ID}`, "email", "in", "inbound/1", DUE).run();
    await insertEventRow("quote.requested", STREAM, 0, { source_message_event_id: MSG_EVENT_ID });

    // DIAGNOSTIC FIRST (a fixed point before believing a count): does the join itself match?
    const joined = await env.TENANT_A_DB.prepare(
      "SELECT COUNT(*) AS n FROM messages m JOIN events e ON e.kind = 'quote.requested' " +
        "AND json_extract(e.payload, '$.source_message_event_id') = substr(m.id, 5) " +
        "WHERE m.direction = 'in' AND m.sla_due_ts IS NOT NULL AND m.sla_due_ts < ?1",
    ).bind(NOW).first<{ n: number }>();
    expect(joined?.n, "the messages↔quote.requested join must match, or nothing downstream can").toBe(1);

    let appended = 0;
    const countingSeq = { append: async () => { appended += 1; return { id: "x" }; } };
    await sweepTenantOverdueInbound(env.TENANT_A_DB, countingSeq as never, "tenant-a", NOW);
    expect(appended, "the fixture must make the row OVERDUE, or the anti-join case below is vacuous").toBe(1);
  });

  it("the note the sweep WRITES satisfies the anti-join on the NEXT sweep (round-trip, not a restated string)", async () => {
    await env.TENANT_A_DB.prepare(
      "INSERT OR IGNORE INTO messages (id, channel, direction, body_ref, sla_due_ts) VALUES (?,?,?,?,?)",
    ).bind(`msg:${MSG_EVENT_ID}`, "email", "in", "inbound/1", DUE).run();
    await insertEventRow("quote.requested", STREAM, 0, { source_message_event_id: MSG_EVENT_ID });

    // FIRST sweep: capture the body_ref the PRODUCER actually wrote. Restating the string here instead was
    // the first version of this test, and it passed with the producer starved — it asserted the query
    // against a hand-written key rather than asserting that producer and query AGREE (§912's rule).
    const written: string[] = [];
    const capturingSeq = {
      append: async (req: { input: { payload: { body_ref: string } } }) => {
        written.push(req.input.payload.body_ref);
        return { id: "captured" };
      },
    };
    await sweepTenantOverdueInbound(env.TENANT_A_DB, capturingSeq as never, "tenant-a", NOW);
    expect(written.length, "the first sweep must append a note, or the round-trip below is vacuous").toBe(1);

    // Seed exactly that note, then re-sweep: the anti-join must now exclude the row.
    await insertEventRow("message.received", STREAM, 1, { channel: "note", from_ref: "agent:concierge", body_ref: written[0] });
    await expect(
      sweepTenantOverdueInbound(env.TENANT_A_DB, refusingSeq as never, "tenant-a", NOW),
      "the note the producer wrote does not satisfy the query's anti-join — producer and query have drifted",
    ).resolves.toBeDefined();
  });
});
