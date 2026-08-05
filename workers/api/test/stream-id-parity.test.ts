import { describe, expect, it } from "vitest";
import sequencerSrc from "../src/do/sequencer.ts?raw";
import contractsEventsSrc from "../../../packages/contracts/src/events.ts?raw";

// THE DUPLICATED REGEX (audit §228). sequencer.ts declares STREAM_ID_RE with an explicit obligation —
// "MUST stay byte-identical to LedgerEvent's stream_id regex (contracts/events.ts)" — so that a malformed
// streamId is a clean VALIDATION_FAILED rather than a raw ZodError leaked through the parse. Nothing
// enforced it: widening the DO's copy to accept an `x:` prefix the contract rejects left all 752 api
// tests green.
//
// Drift hurts in BOTH directions, which is why this asserts equality rather than a subset. More permissive
// and the DO waves through a stream the ledger then rejects — the exact leaked-ZodError the guard exists to
// prevent. More restrictive and it refuses stream ids the contract considers valid, breaking real appends.
//
// Extracted from the raw sources (§223's mechanism): the contract's copy is inline in a Zod schema, so
// there is nothing to import.
function streamIdRe(src: string, pattern: RegExp): string {
  const m = pattern.exec(src);
  if (m === null) throw new Error("stream_id regex not found — its shape changed; re-read this test");
  return m[1]!;
}

describe("REQ-030/I3 — the sequencer's stream_id regex matches the contract's", () => {
  it("STREAM_ID_RE is character-identical to LedgerEvent's stream_id pattern", () => {
    const fromDo = streamIdRe(sequencerSrc, /const STREAM_ID_RE = \/(.+?)\/;/);
    const fromContract = streamIdRe(contractsEventsSrc, /stream_id: z\.string\(\)\.regex\(\/(.+?)\/\)/);
    expect(fromDo.length).toBeGreaterThan(0);
    expect(fromDo).toBe(fromContract);
  });

  it("that pattern still admits the three real stream shapes and nothing else", () => {
    const re = new RegExp(streamIdRe(contractsEventsSrc, /stream_id: z\.string\(\)\.regex\(\/(.+?)\/\)/));
    expect(re.test("s:shp-1")).toBe(true);
    expect(re.test("q:quote-1")).toBe(true);
    expect(re.test("t:root")).toBe(true);
    expect(re.test("x:rogue")).toBe(false);
    expect(re.test("s:bad id")).toBe(false);
  });
});
