import { describe, expect, it } from "vitest";
import { EVENT_KINDS, LedgerEvent, eventFixture } from "@shuddl/contracts";
import { canonicalize } from "../src/canonical.js";
import { hashEvent, buildChain } from "../src/chain.js";
import { eventToRow, rowToEvent } from "../src/lens.js";

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

// REQ-049 — the OPTIONAL override field must NOT move a non-override event's frozen bytes (the pinned
// snapshot above proves that across all 35 kinds), and when PRESENT it must ride the hashed, chained
// envelope AND round-trip through the row mapping so a stored override event still verifies.
describe("REQ-049: the override envelope field is omitted-when-absent (frozen-byte law) and hashed when present", () => {
  it("a no-override event carries no 'override' key in its canonical bytes", async () => {
    const [e] = await buildChain([eventFixture("stop.arrived")]);
    expect(canonicalize({ ...e, sig: undefined, hash: undefined })).not.toContain("override");
  });

  it("adding an override CHANGES the hash (it is inside the hashed envelope)", async () => {
    const [plain] = await buildChain([eventFixture("stop.departed")]);
    const [overridden] = await buildChain([eventFixture("stop.departed", { override: { by: "dispatcher-x", reason: "receiver waiting" } })]);
    expect(await hashEvent(overridden!)).not.toBe(await hashEvent(plain!));
  });

  it("an override event round-trips through eventToRow/rowToEvent and its hash reproduces", async () => {
    const [e] = await buildChain([eventFixture("stop.departed", { override: { by: "dispatcher-x", reason: "receiver waiting" } })]);
    const row = eventToRow(e!);
    expect(JSON.parse(String(row.override_json))).toEqual({ by: "dispatcher-x", reason: "receiver waiting" });
    expect(await hashEvent(rowToEvent(row))).toBe(e!.hash); // the override is inside the verified hash
  });

  it("a no-override event stores override_json = NULL and restores to an ABSENT key (never null)", async () => {
    const [e] = await buildChain([eventFixture("quote.requested")]);
    const row = eventToRow(e!);
    expect(row.override_json).toBeNull();
    expect(rowToEvent(row)).not.toHaveProperty("override");
    expect(await hashEvent(rowToEvent(row))).toBe(e!.hash);
  });

  it("a PRE-0005 row — no override_json key AT ALL — rehydrates and reproduces its hash (audit §431)", async () => {
    // The `?? null` in rowToEvent claims to collapse BOTH SQL NULL and "a row missing the column". Only the
    // NULL half is exercised above, because every row `eventToRow` produces HAS the key. A row written
    // before migration 0005 added the column — or any read that omits it — arrives with the key ABSENT,
    // which is `undefined`, and `undefined !== null` passes the guard below it. Drop the `??` and
    // JSON.parse(undefined) THROWS: such a row becomes unreadable rather than merely unverified, which is
    // the worse failure for an append-only ledger whose whole promise is that old bytes stay legible.
    const [e] = await buildChain([eventFixture("quote.requested")]);
    const row = eventToRow(e!);
    delete row.override_json;
    expect(row).not.toHaveProperty("override_json"); // non-vacuity: this really is the absent case
    expect(rowToEvent(row)).not.toHaveProperty("override");
    expect(await hashEvent(rowToEvent(row))).toBe(e!.hash);
  });
});
