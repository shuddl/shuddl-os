import { describe, expect, it } from "vitest";
import { EVENT_KINDS, LedgerEvent, AgentActedPayload, eventFixture } from "../src/index.js";

describe("REQ-011: the 35-kind catalog", () => {
  it("exactly 35 kinds, matching doc 10 §01", () => expect(EVENT_KINDS.length).toBe(35));
  it("every kind has a parseable fixture (round-trip owner is packages/ledger)", () => {
    for (const kind of EVENT_KINDS) expect(LedgerEvent.parse(eventFixture(kind)).kind).toBe(kind);
  });
});
describe("REQ-005: agent.acted requires basis links", () => {
  it("rejects empty basis", () => {
    expect(() => AgentActedPayload.parse({ agent: "biller", action: "draft", basis: [], confidence_bps: 9000 })).toThrow();
  });
});
describe("I4: custody kinds need a device or the unwitnessed flag", () => {
  it("pod.signed without device and without unwitnessed is rejected", () => {
    const f = eventFixture("pod.signed");
    const bad = { ...f, actor: { party: f.actor.party } };
    expect(() => LedgerEvent.parse(bad)).toThrow(/unwitnessed|device/);
  });
  it("unwitnessed flag admits it", () => {
    const f = eventFixture("pod.signed");
    const ok = { ...f, actor: { party: f.actor.party }, payload: { ...f.payload, unwitnessed: true } };
    expect(LedgerEvent.parse(ok).kind).toBe("pod.signed");
  });
});
describe("I5: quotes pin rate_config versions", () => {
  it("quote.priced with empty rate_config_ids (or versions absent) is rejected", () => {
    const f = eventFixture("quote.priced");
    const p = f.payload as { versions: { rate_config_ids: string[] } };
    expect(() => LedgerEvent.parse({ ...f, payload: { ...p, versions: { rate_config_ids: [] } } })).toThrow();
    const rest: Record<string, unknown> = { ...p };
    delete rest.versions;
    expect(() => LedgerEvent.parse({ ...f, payload: rest })).toThrow();
  });
});
describe("I4 mirror: custody.transferred", () => {
  it("no device + no unwitnessed rejected; unwitnessed admits", () => {
    const f = eventFixture("custody.transferred");
    const bare = { ...f, actor: { party: f.actor.party } };
    expect(() => LedgerEvent.parse(bare)).toThrow(/unwitnessed|device/);
    expect(LedgerEvent.parse({ ...bare, payload: { ...f.payload, unwitnessed: true } }).kind).toBe("custody.transferred");
  });
});
describe("integer-only law", () => {
  it("float ts / confidence rejected", () => {
    const f = eventFixture("quote.requested");
    expect(() => LedgerEvent.parse({ ...f, ts: 1.5 })).toThrow();
    expect(() => LedgerEvent.parse({ ...f, confidence: 0.9 })).toThrow();
  });
});
