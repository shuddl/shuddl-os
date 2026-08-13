import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ClaudeParser, NotConfiguredParser } from "@shuddl/agents";
import { conciergeParser } from "../src/index.js";

// REQ-024/098 — WHICH CONCIERGE PARSER PRODUCTION SELECTS, PINNED IN BOTH DIRECTIONS (audit §1363).
//
// `conciergeParser` is the ninth composition root that can return a `NotConfigured*` stub and was the last one
// no test could reach — not exported, and named in zero test files. Its sibling `selectCopilot` has carried this
// exact test for a long time (`packages/agents/test/copilot.test.ts`: three negative combinations plus the one
// positive); the Concierge's equivalent was never written.
//
// WHY IT MATTERS IN THIS DIRECTION AND THAT ONE. Choosing `ClaudeParser` is the single change that turns the
// Concierge from deterministic into a path that reaches the Anthropic API per inbound message — the agent the
// GO-LIVE-CHECKLIST row *"The one agent with variable cost has no COST/LATENCY metering"* is about. Choosing
// `NotConfiguredParser` when a key IS bound silently degrades every inbound to no parse. Both directions are
// asserted, because a selector test that only proves the floor certifies a permanently-dark agent as correct.
//
// THE EMPTY-STRING CASES ARE THE POINT, not padding. The guard is `apiKey !== undefined && apiKey !== ""`, and
// an empty-string binding is the realistic failure: `wrangler secret put` with an empty value, or a `[vars]`
// entry left blank, both produce a BOUND but useless credential. A presence-only test cannot reach that
// distinction — omitting a field proves only that the field is read.

const parserFor = (over: Record<string, unknown>): ReturnType<typeof conciergeParser> =>
  conciergeParser({ ...env, ...over } as unknown as Parameters<typeof conciergeParser>[0]);

describe("REQ-024/098: the Concierge parser selection", () => {
  it("neither key nor model bound → the NotConfigured floor (no network path exists)", () => {
    expect(parserFor({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_MODEL: undefined })).toBeInstanceOf(NotConfiguredParser);
  });

  it("only one of the two bound → still the floor, in EITHER direction", () => {
    expect(parserFor({ ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_MODEL: undefined })).toBeInstanceOf(NotConfiguredParser);
    expect(parserFor({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_MODEL: "claude-test" })).toBeInstanceOf(NotConfiguredParser);
  });

  it("BOUND BUT EMPTY is not bound — an empty secret must not select the live parser", () => {
    // The realistic misconfiguration, and the one a presence-only test cannot see: the binding exists, so any
    // `!== undefined` check passes, and a live parser would be constructed around a credential that cannot
    // authenticate. Every inbound would then fail at the API rather than degrade to the deterministic floor.
    expect(parserFor({ ANTHROPIC_API_KEY: "", ANTHROPIC_MODEL: "" })).toBeInstanceOf(NotConfiguredParser);
    expect(parserFor({ ANTHROPIC_API_KEY: "", ANTHROPIC_MODEL: "claude-test" })).toBeInstanceOf(NotConfiguredParser);
    expect(parserFor({ ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_MODEL: "" })).toBeInstanceOf(NotConfiguredParser);
  });

  it("BOTH bound and non-empty → ClaudeParser, the only path that reaches the network", () => {
    // The positive half. Without it this file would pass on a selector hard-wired to the stub, certifying a
    // Concierge that can never parse — the failure direction §1352 insists a parity/selection test must name.
    expect(parserFor({ ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_MODEL: "claude-test" })).toBeInstanceOf(ClaudeParser);
  });
});
