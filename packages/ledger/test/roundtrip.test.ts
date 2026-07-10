import { describe, expect, it } from "vitest";
import { EVENT_KINDS, LedgerEvent, eventFixture } from "@shuddl/contracts";
import { canonicalize } from "../src/canonical.js";
import { hashEvent, buildChain } from "../src/chain.js";

describe("REQ-011 DoD: all 35 kinds round-trip", () => {
  it.each(EVENT_KINDS.map((k) => [k]))("%s: parse -> canonicalize -> reparse -> identical hash", async (kind) => {
    const [e] = await buildChain([eventFixture(kind)]);
    const parsed = LedgerEvent.parse(JSON.parse(JSON.stringify(e)));
    expect(await hashEvent(parsed)).toBe(await hashEvent(e!));
    expect(parsed).toEqual(e);
  });
  it("canonical strings + hashes are pinned (a diff here = a broken chain format)", async () => {
    const pins: Record<string, { canonical: string; hash: string }> = {};
    for (const kind of EVENT_KINDS) {
      const [e] = await buildChain([eventFixture(kind)]);
      pins[kind] = { canonical: canonicalize({ ...e, sig: undefined, hash: undefined }), hash: await hashEvent(e!) };
    }
    expect(pins).toMatchSnapshot();
  });
});
