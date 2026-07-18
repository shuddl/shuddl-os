import { describe, expect, it } from "vitest";
import type { EventKind } from "@shuddl/contracts";
import {
  DeterministicCopilot,
  NotConfiguredCopilot,
  ClaudeCopilot,
  CopilotError,
  selectCopilot,
} from "../src/index.js";
import type { CopilotReadPort, CopilotReadQuery, ReadEvent } from "../src/index.js";

// ============================================================================================
// WP-10 Task 7 — the COPILOT core (REQ-038/024). A READ-ONLY, cite-or-abstain answerer over an
// INJECTED read port. The core never imports @shuddl/ledger; the LLM is NEVER hit in CI (every
// fetch below is a local stub). The honesty law: every non-abstained answer is grounded on a REAL
// retrieved event id; anything ungroundable/malformed ABSTAINS — never a fabricated fact or citation.
// ============================================================================================

function ev(event_id: string, kind: EventKind, shipment_id: string | undefined, ts: number, payload: unknown = {}): ReadEvent {
  const e: ReadEvent = { event_id, kind, ts, payload };
  if (shipment_id !== undefined) e.shipment_id = shipment_id;
  return e;
}

/** An in-memory read port mirroring readEvents(): honors shipment_id + kind filters + limit. Records calls. */
class FakeReadPort implements CopilotReadPort {
  public readonly calls: CopilotReadQuery[] = [];
  constructor(private readonly events: readonly ReadEvent[]) {}
  async readEvents(query: CopilotReadQuery): Promise<ReadEvent[]> {
    this.calls.push(query);
    let out = [...this.events];
    if (query.shipment_id !== undefined) out = out.filter((e) => e.shipment_id === query.shipment_id);
    if (query.kind !== undefined) {
      const set = new Set<EventKind>(query.kind);
      out = out.filter((e) => set.has(e.kind));
    }
    if (query.limit !== undefined) out = out.slice(0, query.limit);
    return out;
  }
}

async function captureRejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

// ── DeterministicCopilot — the CI path + auditable floor ─────────────────────────────────────

describe("DeterministicCopilot — answers structured questions with REAL citations, no LLM", () => {
  const SHP = "shp-copilot-1";
  const events: ReadEvent[] = [
    ev("evt-booking", "booking.created", SHP, 1_000),
    ev("evt-arrived", "stop.arrived", SHP, 2_000),
    ev("evt-pod", "pod.signed", SHP, 3_000), // the freshest — the status answer must cite THIS one
    ev("evt-other-shp", "pod.signed", "shp-other", 9_999), // a different shipment — never leaks into shp-1's answer
  ];

  it("a shipment-status question → answer citing the FRESHEST real event of that shipment", async () => {
    const copilot = new DeterministicCopilot(new FakeReadPort(events));
    const a = await copilot.answer("what's the status of shipment shp-copilot-1?");
    expect(a.abstained).toBe(false);
    expect(a.citations).toHaveLength(1);
    expect(a.citations[0]?.event_id).toBe("evt-pod"); // freshest ts wins
    expect(a.citations[0]?.shipment_id).toBe(SHP);
    expect(a.text).toContain(SHP);
    expect(a.text).toContain("pod.signed");
  });

  it("scopes the read to the named shipment (the port is asked ONLY for that shipment)", async () => {
    const port = new FakeReadPort(events);
    await new DeterministicCopilot(port).answer("status of shipment shp-copilot-1");
    expect(port.calls[0]?.shipment_id).toBe(SHP); // the read is shipment-scoped — never a whole-tenant scan
  });

  it("'which shipments have open exceptions?' → cites the exception events, lists their shipments", async () => {
    const exEvents: ReadEvent[] = [
      ev("evt-exc-a", "exception.raised", "shp-a", 10, { reason_code: "damage" }),
      ev("evt-osd-b", "osd.captured", "shp-b", 20, { reason_code: "shortage" }),
      ev("evt-pod-c", "pod.signed", "shp-c", 30), // NOT an exception — must never be cited
    ];
    const copilot = new DeterministicCopilot(new FakeReadPort(exEvents));
    const a = await copilot.answer("which shipments have open exceptions?");
    expect(a.abstained).toBe(false);
    const citedIds = a.citations.map((c) => c.event_id).sort();
    expect(citedIds).toEqual(["evt-exc-a", "evt-osd-b"]); // only the two real exception events
    expect(a.text).toContain("shp-a");
    expect(a.text).toContain("shp-b");
    expect(a.text).not.toContain("shp-c");
  });

  it("an UNANSWERABLE question → ABSTAIN, zero citations, no fabrication", async () => {
    const copilot = new DeterministicCopilot(new FakeReadPort(events));
    const a = await copilot.answer("what is the meaning of freight?");
    expect(a.abstained).toBe(true);
    expect(a.citations).toEqual([]);
    expect(a.text).toContain("can't answer");
  });

  it("a shipment with NO events → ABSTAIN (never a fabricated status)", async () => {
    const copilot = new DeterministicCopilot(new FakeReadPort(events));
    const a = await copilot.answer("status of shipment shp-does-not-exist");
    expect(a.abstained).toBe(true);
    expect(a.citations).toEqual([]);
  });

  it("'open exceptions' with NO exception events → ABSTAIN (a non-abstained answer would need a citation)", async () => {
    const copilot = new DeterministicCopilot(new FakeReadPort([ev("evt-pod", "pod.signed", "shp-x", 1)]));
    const a = await copilot.answer("which shipments have open exceptions?");
    expect(a.abstained).toBe(true);
    expect(a.citations).toEqual([]);
  });

  it("is DETERMINISTIC — the same question over the same ledger yields the byte-identical answer", async () => {
    const copilot = new DeterministicCopilot(new FakeReadPort(events));
    const a = await copilot.answer("status of shipment shp-copilot-1");
    const b = await copilot.answer("status of shipment shp-copilot-1");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ── the grounding gate via ClaudeCopilot (stubbed fetch — ZERO network) ───────────────────────

interface CapturedCall {
  url: string;
  init: RequestInit;
}

/** A local fetch stub answering with an Anthropic Messages envelope wrapping `modelText`. No network, ever. */
function stubFetch(modelText: string, status = 200): { calls: CapturedCall[]; fetchImpl: typeof fetch } {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    const body = status === 200 ? JSON.stringify({ content: [{ type: "text", text: modelText }] }) : modelText;
    return Promise.resolve(new Response(body, { status, headers: { "content-type": "application/json" } }));
  };
  return { calls, fetchImpl };
}

describe("ClaudeCopilot — grounding is the gate; the model's word is not (stubbed fetch)", () => {
  const SHP = "shp-claude-1";
  const port = () => new FakeReadPort([ev("evt-real", "pod.signed", SHP, 100), ev("evt-real-2", "stop.arrived", SHP, 50)]);

  it("a model answer citing a REAL retrieved event → grounded answer with that citation", async () => {
    const { fetchImpl } = stubFetch(JSON.stringify({ text: "It was delivered.", citations: [{ event_id: "evt-real" }], abstained: false }));
    const copilot = new ClaudeCopilot(port(), { apiKey: "sk-test", model: "claude-test", fetchImpl });
    const a = await copilot.answer("status of shipment shp-claude-1");
    expect(a.abstained).toBe(false);
    expect(a.citations).toHaveLength(1);
    expect(a.citations[0]?.event_id).toBe("evt-real");
    expect(a.citations[0]?.kind).toBe("pod.signed"); // kind is rebuilt from the REAL event, not the model's claim
  });

  it("a model answer citing an event NOT in the retrieved set → REJECTED → ABSTAIN (no fabricated citation)", async () => {
    const { fetchImpl } = stubFetch(
      JSON.stringify({ text: "The invoice was paid in full.", citations: [{ event_id: "evt-HALLUCINATED" }], abstained: false }),
    );
    const copilot = new ClaudeCopilot(port(), { apiKey: "sk-test", model: "claude-test", fetchImpl });
    const a = await copilot.answer("status of shipment shp-claude-1");
    expect(a.abstained).toBe(true); // the ungroundable citation abstains the WHOLE answer
    expect(a.citations).toEqual([]);
    expect(a.text).not.toContain("invoice"); // the ungrounded prose never ships
  });

  it("a model answer with ZERO citations (abstained:false) → ABSTAIN (a claim needs a citation)", async () => {
    const { fetchImpl } = stubFetch(JSON.stringify({ text: "Everything is fine.", citations: [], abstained: false }));
    const copilot = new ClaudeCopilot(port(), { apiKey: "sk-test", model: "claude-test", fetchImpl });
    const a = await copilot.answer("status of shipment shp-claude-1");
    expect(a.abstained).toBe(true);
  });

  it("GARBAGE model output (non-JSON) → fail-safe ABSTAIN, never a throw", async () => {
    const { fetchImpl } = stubFetch("I am a chatty model and forgot the JSON entirely.");
    const copilot = new ClaudeCopilot(port(), { apiKey: "sk-test", model: "claude-test", fetchImpl });
    const a = await copilot.answer("status of shipment shp-claude-1");
    expect(a.abstained).toBe(true);
    expect(a.citations).toEqual([]);
  });

  it("the model self-reporting abstained:true is honored (the safe direction)", async () => {
    const { fetchImpl } = stubFetch(JSON.stringify({ text: "no idea", citations: [{ event_id: "evt-real" }], abstained: true }));
    const copilot = new ClaudeCopilot(port(), { apiKey: "sk-test", model: "claude-test", fetchImpl });
    const a = await copilot.answer("status of shipment shp-claude-1");
    expect(a.abstained).toBe(true);
    expect(a.citations).toEqual([]);
  });

  it("a 5xx from the provider throws a RETRIABLE CopilotError (transport fault ≠ fabricated answer)", async () => {
    const { fetchImpl } = stubFetch("upstream boom", 503);
    const copilot = new ClaudeCopilot(port(), { apiKey: "sk-test", model: "claude-test", fetchImpl });
    const err = await captureRejection(copilot.answer("status of shipment shp-claude-1"));
    expect(err).toBeInstanceOf(CopilotError);
    expect((err as CopilotError).retriable).toBe(true);
  });

  it("does NOT call the model when there are zero events to ground on (abstains first)", async () => {
    const { calls, fetchImpl } = stubFetch(JSON.stringify({ text: "x", citations: [{ event_id: "evt-real" }], abstained: false }));
    const copilot = new ClaudeCopilot(new FakeReadPort([]), { apiKey: "sk-test", model: "claude-test", fetchImpl });
    const a = await copilot.answer("status of shipment shp-empty");
    expect(a.abstained).toBe(true);
    expect(calls).toHaveLength(0); // no network call — nothing to ground on
  });
});

// ── NotConfiguredCopilot + the composition selector ───────────────────────────────────────────

describe("NotConfiguredCopilot — rejects loudly", () => {
  it("throws a retriable CopilotError, never a silent/fabricated answer", async () => {
    const err = await captureRejection(new NotConfiguredCopilot().answer("status of shipment x"));
    expect(err).toBeInstanceOf(CopilotError);
    expect((err as CopilotError).retriable).toBe(true);
  });
});

describe("selectCopilot — the composition gate (LLM NEVER reachable in CI)", () => {
  const port = new FakeReadPort([]);

  it("no key bound → the DeterministicCopilot floor", () => {
    expect(selectCopilot(port)).toBeInstanceOf(DeterministicCopilot);
    expect(selectCopilot(port, { model: "claude-test" })).toBeInstanceOf(DeterministicCopilot); // model without key
    expect(selectCopilot(port, { apiKey: "sk-test" })).toBeInstanceOf(DeterministicCopilot); // key without model
  });

  it("BOTH key AND model bound → ClaudeCopilot (the only path that would ever hit the network)", () => {
    expect(selectCopilot(port, { apiKey: "sk-test", model: "claude-test" })).toBeInstanceOf(ClaudeCopilot);
  });
});
