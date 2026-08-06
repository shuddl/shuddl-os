import { describe, expect, it } from "vitest";
import { TENANT_POLICY_MALFORMED_REASON, UNKNOWN_TENANT_PREFIX, isUnknownTenant, isTenantPolicyRefusal } from "../src/errors.js";

// THE TWO CLASSIFIERS THAT DECIDE "RETRY OR QUARANTINE" (audit §461). Both had ZERO test references of any
// kind, and one of them is load-bearing for freight, not just for logs.
//
// `isUnknownTenant` gates `workers/translator/src/inbound.ts`: `if (!isUnknownTenant(err)) throw err;`. A
// rethrow becomes a 5xx the VAN retries — correct for a transient fault. Only a DETERMINISTIC non-resolution
// is quarantined instead. So a FALSE POSITIVE (a transient D1 fault read as unknown-tenant) quarantines a
// tender that a retry would have delivered: a LOST FREIGHT TENDER, the failure CLAUDE.md #10 and that
// module's own header name as the worse of the two. Its docstring states the contract exactly — "True ONLY
// for a deterministic non-resolution. A transient D1 fault is NOT this, and must stay retriable" — and
// nothing held it.
//
// `isTenantPolicyRefusal` is the milder sibling: both branches of the agents consumer call `message.retry()`,
// so a misclassification changes the DIAGNOSIS, not the delivery. It is pinned here anyway because its
// implementation encodes a specific, hard-won reason (§36) that a future "simplification" would undo.
describe("isUnknownTenant — retriable vs deterministic, on the path where it costs a tender (REQ-025)", () => {
  it("TRUE for the deterministic marker, including under arbitrary RPC wrapping", () => {
    expect(isUnknownTenant(new Error(`${UNKNOWN_TENANT_PREFIX} acme`))).toBe(true);
    // `includes`, not `startsWith`, precisely so the marker survives a wrapping hop.
    expect(isUnknownTenant(new Error(`RPC failed: ${UNKNOWN_TENANT_PREFIX} acme`))).toBe(true);
  });

  it("FALSE for a transient D1 fault — the case that must stay retriable or the tender is lost", () => {
    expect(isUnknownTenant(new Error("D1_ERROR: network connection lost"))).toBe(false);
    expect(isUnknownTenant(new Error("Internal error"))).toBe(false);
  });

  it("FALSE for a non-Error value — a thrown string must not be read as a deterministic refusal", () => {
    // The `err instanceof Error` guard. Without it, `String(err).includes(...)` on a thrown object or a
    // rejected non-Error would decide quarantine-vs-retry on stringification luck.
    expect(isUnknownTenant(`${UNKNOWN_TENANT_PREFIX} acme`)).toBe(false);
    expect(isUnknownTenant(null)).toBe(false);
    expect(isUnknownTenant(undefined)).toBe(false);
  });
});

describe("isTenantPolicyRefusal — the structured field, never the prose (audit §36)", () => {
  it("TRUE for the producer's structured reason, through wrapping", () => {
    // The reason string is IMPORTED, not restated — §433's rule: an expectation must not be a second copy
    // of the value under test, or the pair drifts together and the assertion stops meaning anything.
    const structured = `"reason":"${TENANT_POLICY_MALFORMED_REASON}"`;
    expect(isTenantPolicyRefusal(new Error(`{${structured}}`))).toBe(true);
    expect(isTenantPolicyRefusal(new Error(`RPC hop: {${structured}} at seq 4`))).toBe(true);
  });

  it("FALSE for the BARE PHRASE — the whole reason the loose form was replaced", () => {
    // §36's case: this catch also wraps the Concierge LLM path and Resend sends, whose messages can embed
    // inbound EMAIL text. A shipper writing "tenant policy malformed" in an email — or a model echoing it —
    // must not turn a genuinely retriable failure into a deterministic one that skips its 429 backoff.
    expect(isTenantPolicyRefusal(new Error(`shipper wrote: ${TENANT_POLICY_MALFORMED_REASON}, please advise`))).toBe(false);
    expect(isTenantPolicyRefusal(new Error(TENANT_POLICY_MALFORMED_REASON))).toBe(false);
  });

  it("FALSE for a non-Error value", () => {
    expect(isTenantPolicyRefusal(`{"reason":"${TENANT_POLICY_MALFORMED_REASON}"}`)).toBe(false);
    expect(isTenantPolicyRefusal(null)).toBe(false);
  });
});
