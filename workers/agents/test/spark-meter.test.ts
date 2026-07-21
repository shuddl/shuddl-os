import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { DeterministicParser, RecordingSender } from "@shuddl/agents";
import type { ConciergeParser, InboundEmail, ParseResult } from "@shuddl/agents";
import { handleMessageReceived } from "../src/concierge.js";
import type { ConciergeDeps } from "../src/concierge.js";
import { handlePodSigned } from "../src/biller.js";
import type { BillerDeps, SeqStubLike } from "../src/biller.js";
import { currentPeriod, resolveSparkPlan, sparkGateFor, UNCAPPED_SPARK_GATE } from "../src/spark-caps.js";
import type { SparkGate } from "../src/spark-caps.js";
import { applyAll, applyControl, seedControlTenant, seedEvent } from "./helpers.js";

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// WP-14 Task 8 (REQ-122/125) — SPARK CAPS with the TRUTH-PATH CARVE-OUT.
//
// THE INVERSION (the headline): a Spark tenant over its monthly AI-credit allotment loses the LLM-powered
// CONVENIENCE (Concierge auto-quote) — that ONE seam fails CLOSED. It NEVER loses the physical-truth append
// path or invoicing: pod.signed still records + the Biller still invoices, uncapped, forever. "Credits
// throttle conveniences, not truth" (genesis/04:15). Proven here two ways: the convenience is REFUSED, and
// the SAME over-cap tenant's Biller path STILL issues invoice.issued AND never touches the SparkMeter.
//
// The per-tenant SparkMeter is a REAL Durable Object (SPARK_METER) provisioned by the pool from wrangler.toml
// — atomic checkAndReserve, keyed by idFromName(tenant). CONTROL_DB carries tenants.plan (the Spark flag) +
// tenants.policy (the allotment). Distinct tenant/slug names per case so DO tallies + control rows never bleed.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

interface SparkMeterStub {
  checkAndReserve(req: { period: string; allotment: number; actionId: string }): Promise<{ ok: boolean; count: number; allotment: number }>;
  peek(period: string): Promise<{ count: number }>;
}
function meter(tenant: string): SparkMeterStub {
  return env.SPARK_METER.get(env.SPARK_METER.idFromName(tenant)) as unknown as SparkMeterStub;
}
const PERIOD = currentPeriod(Date.UTC(2026, 6, 17)); // a fixed UTC month for the DO-direct cases

// A parser (the LLM seam) that records whether it ran — the load-bearing "the convenience did / did not run".
class SpyParser implements ConciergeParser {
  called = 0;
  constructor(private readonly inner: ConciergeParser = new DeterministicParser()) {}
  async parse(email: InboundEmail): Promise<ParseResult> {
    this.called += 1;
    return this.inner.parse(email);
  }
}

// A recording fake sequencer — the ONLY write path the consumers use; here it just records the appends and
// echoes the deterministic id back (no DO, no D1 write). Mirrors the biller/concierge test seqStub shape.
function recordingSeq(): { seq: SeqStubLike; appends: { kind: string; tenant: string }[] } {
  const appends: { kind: string; tenant: string }[] = [];
  const seq: SeqStubLike = {
    append: async (req) => {
      const input = req.input as { id: string; kind: string };
      appends.push({ kind: input.kind, tenant: req.tenant });
      return { id: input.id };
    },
  };
  return { seq, appends };
}

function conciergeDeps(over: Partial<ConciergeDeps>): ConciergeDeps {
  const { seq } = recordingSeq();
  return {
    db: env.TENANT_A_DB,
    seq,
    sender: new RecordingSender(),
    parser: new DeterministicParser(),
    tenantFromName: "Shuddl Dispatch",
    ...over,
  };
}

// Seed a fresh, not-yet-handled message.received on this tenant's D1 (GUARD 1 needs the event to exist; no
// prior quote.requested/message.sent so the redelivery guards pass through to the Spark cap check).
let streamCounter = 0;
async function seedInbound(): Promise<string> {
  streamCounter += 1;
  const shp = `spark-in-${streamCounter}`;
  const e = await seedEvent(env.TENANT_A_DB, "message.received", {
    stream_id: `s:${shp}`, // events CHECK: stream_id = 's:' || shipment_id
    shipment_id: shp,
    seq: 1,
    payload: { channel: "email", from_ref: "shipper@example.com", body_ref: "r2://msg/in", subject: "Rate please", body: "Please quote from 97201 to 80012, 1000 lbs, 48x40x48, 2 pallets." },
  } as never);
  return e.id;
}

beforeAll(async () => {
  await applyAll(env.TENANT_A_DB);
  await applyControl(env.CONTROL_DB);
});

// ─── A. THE SparkMeter DO — atomic, idempotent, ZERO-default ────────────────────────────────────────
describe("SparkMeter DO — checkAndReserve (atomic, idempotency-keyed, UTC-month)", () => {
  it("NO-CAPS-DEFAULT = ZERO: an allotment of 0 refuses the FIRST convenience (a floor, never infinite)", async () => {
    const m = meter("spark-do-zero");
    const r = await m.checkAndReserve({ period: PERIOD, allotment: 0, actionId: "a1" });
    expect(r.ok).toBe(false);
    expect(r.count).toBe(0);
    expect(await m.peek(PERIOD)).toEqual({ count: 0 }); // no reserve on a refusal
  });

  it("a MALFORMED allotment (negative / non-integer) clamps to ZERO — fail-closed, never infinite", async () => {
    const m = meter("spark-do-bad");
    expect((await m.checkAndReserve({ period: PERIOD, allotment: -5, actionId: "a1" })).ok).toBe(false);
    expect((await m.checkAndReserve({ period: PERIOD, allotment: 2.5, actionId: "a2" })).ok).toBe(false);
    expect((await m.checkAndReserve({ period: PERIOD, allotment: Number.NaN, actionId: "a3" })).ok).toBe(false);
    expect(await m.peek(PERIOD)).toEqual({ count: 0 });
  });

  it("distinct actions each count; the N+1 is refused (the tally never advances past the allotment)", async () => {
    const m = meter("spark-do-count");
    expect((await m.checkAndReserve({ period: PERIOD, allotment: 2, actionId: "a1" })).ok).toBe(true);
    expect((await m.checkAndReserve({ period: PERIOD, allotment: 2, actionId: "a2" })).ok).toBe(true);
    const third = await m.checkAndReserve({ period: PERIOD, allotment: 2, actionId: "a3" });
    expect(third.ok).toBe(false);
    expect(third.count).toBe(2);
    expect(await m.peek(PERIOD)).toEqual({ count: 2 });
  });

  it("IDEMPOTENT: the SAME actionId re-reserves to the SAME slot — a redelivery counts ONCE, not twice", async () => {
    const m = meter("spark-do-idem");
    const first = await m.checkAndReserve({ period: PERIOD, allotment: 1, actionId: "same" });
    const retry = await m.checkAndReserve({ period: PERIOD, allotment: 1, actionId: "same" });
    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true); // still ok — the marker replays its reserve
    expect(retry.count).toBe(1);
    expect(await m.peek(PERIOD)).toEqual({ count: 1 }); // ONE booking, not two
  });

  it("a NEW period starts fresh (the tally is per UTC month, keyed tally:<period>)", async () => {
    const m = meter("spark-do-period");
    expect((await m.checkAndReserve({ period: "2026-01", allotment: 1, actionId: "x" })).ok).toBe(true);
    expect((await m.checkAndReserve({ period: "2026-01", allotment: 1, actionId: "y" })).ok).toBe(false); // month full
    expect((await m.checkAndReserve({ period: "2026-02", allotment: 1, actionId: "z" })).ok).toBe(true); // next month fresh
  });

  it("CONCURRENCY (the DO mutex): a Promise.all race of allotment+K distinct reserves admits EXACTLY the allotment", async () => {
    const m = meter("spark-do-race");
    const ALLOT = 3;
    const ATTEMPTS = 10;
    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, (_, i) => m.checkAndReserve({ period: PERIOD, allotment: ALLOT, actionId: `race-${i}` })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(ALLOT); // exactly the allotment succeed — no over-reserve
    expect(results.filter((r) => !r.ok)).toHaveLength(ATTEMPTS - ALLOT);
    expect(await m.peek(PERIOD)).toEqual({ count: ALLOT });
  });
});

// ─── B. resolveSparkPlan — the plan-flag gate off tenants.plan (control plane) ───────────────────────
describe("resolveSparkPlan — Spark iff tenants.plan === 'spark'; allotment from tenants.policy, ZERO default", () => {
  it("a NON-Spark tenant (plan='pilot') is UNCAPPED (capped:false)", async () => {
    await seedControlTenant(env.CONTROL_DB, { id: "t-pilot", slug: "slug-pilot", plan: "pilot", policy: JSON.stringify({ spark_ai_allotment: 999 }) });
    expect(await resolveSparkPlan(env.CONTROL_DB, "slug-pilot")).toEqual({ capped: false, allotment: 0 });
  });

  it("a Spark tenant with a configured allotment is CAPPED at that allotment", async () => {
    await seedControlTenant(env.CONTROL_DB, { id: "t-spark", slug: "slug-spark", plan: "spark", policy: JSON.stringify({ spark_ai_allotment: 25 }) });
    expect(await resolveSparkPlan(env.CONTROL_DB, "slug-spark")).toEqual({ capped: true, allotment: 25 });
  });

  it("a Spark tenant with NO allotment in policy is CAPPED at ZERO (the fail-closed floor, never infinite)", async () => {
    await seedControlTenant(env.CONTROL_DB, { id: "t-spark0", slug: "slug-spark0", plan: "spark", policy: "{}" });
    expect(await resolveSparkPlan(env.CONTROL_DB, "slug-spark0")).toEqual({ capped: true, allotment: 0 });
  });

  it("a Spark tenant with a MALFORMED policy is CAPPED at ZERO (never silently infinite)", async () => {
    await seedControlTenant(env.CONTROL_DB, { id: "t-sparkbad", slug: "slug-sparkbad", plan: "spark", policy: "{not json" });
    expect(await resolveSparkPlan(env.CONTROL_DB, "slug-sparkbad")).toEqual({ capped: true, allotment: 0 });
  });

  it("an UNKNOWN tenant (no control row) is UNCAPPED — only a CONFIRMED Spark tenant is throttled", async () => {
    expect(await resolveSparkPlan(env.CONTROL_DB, "slug-does-not-exist")).toEqual({ capped: false, allotment: 0 });
  });
});

// ─── C. THE AGENT-ACTION CHOKEPOINT — the cap gates the LLM convenience, keyed off the server tenant ──
describe("Concierge chokepoint — the Spark cap gates the LLM parse (the convenience), server-tenant-keyed", () => {
  it("OVER ALLOTMENT (Spark, allotment 0): the agent AI action is REFUSED — parser NEVER runs, nothing sent/appended", async () => {
    await seedControlTenant(env.CONTROL_DB, { id: "t-cap", slug: "cap-over", plan: "spark", policy: "{}" }); // allotment 0
    const gate = await sparkGateFor(env, "cap-over");
    const spy = new SpyParser();
    const { seq, appends } = recordingSeq();
    const sender = new RecordingSender();
    const msgId = await seedInbound();

    const outcome = await handleMessageReceived(
      { kind: "message.received", tenant: "cap-over", event_id: msgId },
      conciergeDeps({ seq, sender, parser: spy, sparkGate: gate }),
    );
    expect(outcome.status, JSON.stringify(outcome)).toBe("capped");
    expect(spy.called).toBe(0); // the LLM convenience NEVER ran
    expect(appends).toHaveLength(0); // nothing appended
    expect(sender.messages).toHaveLength(0); // nothing sent
  });

  it("UNCAPPED (a non-Spark tenant): the agent AI action RUNS (the injected gate no-ops)", async () => {
    await seedControlTenant(env.CONTROL_DB, { id: "t-unc", slug: "unc-run", plan: "pro", policy: "{}" });
    const gate = await sparkGateFor(env, "unc-run");
    const spy = new SpyParser();
    const msgId = await seedInbound();

    const outcome = await handleMessageReceived(
      { kind: "message.received", tenant: "unc-run", event_id: msgId },
      conciergeDeps({ parser: spy, sparkGate: gate }),
    );
    expect(spy.called).toBe(1); // the convenience RAN (uncapped)
    expect(outcome.status).not.toBe("capped");
  });

  it("the cap keys off the SERVER tenant (idFromName), not a client field — a Spark tenant's second convenience is refused after its 1-slot allotment", async () => {
    await seedControlTenant(env.CONTROL_DB, { id: "t-one", slug: "cap-one", plan: "spark", policy: JSON.stringify({ spark_ai_allotment: 1 }) });
    const gate = await sparkGateFor(env, "cap-one");
    const first = new SpyParser();
    const second = new SpyParser();
    const firstId = await seedInbound();
    const secondId = await seedInbound();

    const a = await handleMessageReceived({ kind: "message.received", tenant: "cap-one", event_id: firstId }, conciergeDeps({ parser: first, sparkGate: gate }));
    expect(a.status).not.toBe("capped"); // slot 1 spent
    expect(first.called).toBe(1);
    const b = await handleMessageReceived({ kind: "message.received", tenant: "cap-one", event_id: secondId }, conciergeDeps({ parser: second, sparkGate: gate }));
    expect(b.status).toBe("capped"); // allotment exhausted → throttled
    expect(second.called).toBe(0);
  });

  it("an injected {ok:false} SparkGate → capped; {ok:true} → runs (the pure chokepoint contract)", async () => {
    const refuse: SparkGate = { reserve: async () => ({ ok: false, reason: "over_allotment", count: 0, allotment: 0 }) };
    const spy1 = new SpyParser();
    const capped = await handleMessageReceived({ kind: "message.received", tenant: "t", event_id: await seedInbound() }, conciergeDeps({ parser: spy1, sparkGate: refuse }));
    expect(capped.status).toBe("capped");
    expect(spy1.called).toBe(0);

    const spy2 = new SpyParser();
    const ran = await handleMessageReceived({ kind: "message.received", tenant: "t", event_id: await seedInbound() }, conciergeDeps({ parser: spy2, sparkGate: UNCAPPED_SPARK_GATE }));
    expect(ran.status).not.toBe("capped");
    expect(spy2.called).toBe(1);
  });
});

// ─── D. THE INVERSION — the truth path is NEVER capped ───────────────────────────────────────────────
describe("THE INVERSION — an EXHAUSTED Spark tenant STILL records freight reality + invoices (REQ-122)", () => {
  it("the SAME over-cap Spark tenant: Concierge convenience REFUSED, but pod.signed STILL invoices — and the Biller NEVER touches the SparkMeter", async () => {
    // A Spark tenant provisioned at ZERO allotment — every convenience is exhausted.
    await seedControlTenant(env.CONTROL_DB, { id: "t-inv", slug: "inversion", plan: "spark", policy: "{}" });
    const gate = await sparkGateFor(env, "inversion");

    // (1) THE CONVENIENCE IS THROTTLED — the Concierge auto-quote is refused (the agent doing the quoting is lost).
    const spy = new SpyParser();
    const conciergeOut = await handleMessageReceived(
      { kind: "message.received", tenant: "inversion", event_id: await seedInbound() },
      conciergeDeps({ parser: spy, sparkGate: gate }),
    );
    expect(conciergeOut.status).toBe("capped");
    expect(spy.called).toBe(0);

    // (2) THE TRUTH PATH STILL RUNS — seed a physical pod.signed + its recorded quote.priced + the shipment/bill-to,
    //     then drive the Biller. It composes + appends invoice.issued and sends the evidence email — UNCAPPED. The
    //     Biller carries NO SparkGate (BillerDeps has no such field) — the carve-out is STRUCTURAL, not a flag.
    const shp = "spark-inv-shp-1";
    const stream = `s:${shp}`;
    await seedEvent(env.TENANT_A_DB, "quote.priced", { stream_id: stream, seq: 1, shipment_id: shp } as never);
    const pod = await seedEvent(env.TENANT_A_DB, "pod.signed", { stream_id: stream, seq: 2, shipment_id: shp } as never);
    await env.TENANT_A_DB
      .prepare("INSERT OR IGNORE INTO shipments (id, division, refs, shipper_party_id, consignee_party_id, bill_to_party_id, bill_terms, created_ts) VALUES (?,?,?,?,?,?,?,?)")
      .bind(shp, "main", "{}", "party-shipper", "party-consignee", "party-bill-to", "prepaid", 0)
      .run();
    await env.TENANT_A_DB
      .prepare("INSERT OR IGNORE INTO parties (id, kind, names, contacts) VALUES (?,?,?,?)")
      .bind("party-bill-to", "shipper", "{}", JSON.stringify([{ kind: "billing", email: "billing@example.com" }]))
      .run();

    const { seq, appends } = recordingSeq();
    const sender = new RecordingSender();
    const billerDeps: BillerDeps = { db: env.TENANT_A_DB, seq, sender, referralBase: "https://shuddl.tech" };
    const billerOut = await handlePodSigned({ kind: "pod.signed", tenant: "inversion", shipment_id: shp, event_id: pod.id }, billerDeps);

    expect(billerOut.status, JSON.stringify(billerOut)).toBe("issued_sent"); // the invoice issued
    expect(appends.map((a) => a.kind)).toContain("invoice.issued"); // the truth-path append ran (uncapped)
    expect(sender.messages).toHaveLength(1); // the evidence email went — invoicing was NEVER throttled

    // THE INVERSION, proven: the Biller (truth + money) NEVER consulted the Spark meter for this over-cap tenant.
    expect((await meter("inversion").peek(currentPeriod(Date.now()))).count).toBe(0);
  });
});
