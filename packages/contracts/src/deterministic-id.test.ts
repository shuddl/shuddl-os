import { describe, expect, it } from "vitest";
import { deterministicUuid } from "./deterministic-id.js";

// §1716 (REQ-118/119) — THE GOLDENS THAT MAKE THIS A CONTRACT AND NOT A HELPER.
//
// `deterministicUuid` backs the "twice in, once out" dedupe on several APPEND-ONLY paths, so its outputs are
// already persisted in `events.id`. A change that moves one output byte does not fix old rows; it makes every
// future re-derivation miss them and append a duplicate that cannot be deleted (I3/I7).
//
// A shape assertion cannot catch that — `/^[0-9a-f]{8}-/` stays green while every id changes. So these are
// exact seed→id pairs, computed from the six copies this function replaced, five of which are the real seed
// SHAPES the production call sites use. They were the acceptance criterion for the consolidation: the six
// copies had to already produce them, and this one had to keep producing them.

/** Real production seed shapes → the ids the pre-consolidation copies produced. Frozen. */
const GOLDEN: ReadonlyArray<readonly [string, string]> = [
  ["", "e3b0c442-98fc-4c14-9afb-f4c8996fb924"],
  ["quote-accepted:q1", "6a226c9f-f845-44f3-928b-e0132c550077"],
  ["edi:quote-requested:shp_abc", "7c7cb011-cfb8-4f49-b030-52b1885ba40c"],
  ["edi:agent-acted:shp_abc", "e6d53059-4b24-4c36-8eb7-f5722a9541b9"],
  ["collector:dunning-sent:inv_1:30", "f0a6df82-acd1-4b37-827a-caed7ab48200"],
  ["approval-decided:evt_9", "137b9e1c-9d8e-4154-99e8-304bf003699a"],
];

/**
 * One seed per variant nibble. The variant arithmetic is the only branch in the function, and three of its
 * four outcomes are unreachable from any single seed — a golden set that happened to land on `9` four times
 * would leave `8`, `a` and `b` unpinned while reading as thorough. These four seeds were selected BY
 * SEARCHING for the outcome, not by hoping.
 */
const VARIANT_COVER: ReadonlyArray<readonly [string, string]> = [
  ["v0", "0270da4d-aac5-44f3-8bec-e5788a87ad7b"],
  ["v2", "fb04dcb6-970e-4c3d-9873-de51fd5a50d7"],
  ["v1", "3bfc2695-94ef-4492-a8e9-a74bab00f042"],
  ["v5", "ee861650-2dd0-41f3-b250-cdef1b5f1c40"],
];

describe("§1716 deterministicUuid — the bytes are the contract", () => {
  it.each(GOLDEN)("seed %j derives the persisted id", async (seed, id) => {
    expect(
      await deterministicUuid(seed),
      "an id byte moved. Old events keep their old ids, so the next re-derivation MISSES them and appends a " +
        "duplicate to an append-only table. This is not a snapshot to update — read the warning on the function.",
    ).toBe(id);
  });

  it("covers all four variant nibbles (8/9/a/b), so the only branch is not pinned by one outcome", async () => {
    const nibbles = new Set<string>();
    for (const [seed, id] of VARIANT_COVER) {
      expect(await deterministicUuid(seed)).toBe(id);
      nibbles.add(id.charAt(19));
    }
    expect([...nibbles].sort().join(""), "the variant cover collapsed onto fewer than four outcomes").toBe("89ab");
  });

  it("is RFC-4122 SHAPED, because events.id is uuid-shaped by contract (a raw hex slice would be refused)", async () => {
    for (const seed of ["", "a", "quote-accepted:q1", "é中🚀", "x".repeat(4096)]) {
      expect(await deterministicUuid(seed), `seed ${JSON.stringify(seed.slice(0, 16))}`).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it("is a FUNCTION of the seed: same seed same id, different seed different id", async () => {
    expect(await deterministicUuid("s")).toBe(await deterministicUuid("s"));
    // Adjacent seeds, because the dedupe hazard is two NEARLY-identical steps colliding, not two random ones.
    expect(await deterministicUuid("edi:quote-priced:shp_1")).not.toBe(await deterministicUuid("edi:quote-priced:shp_2"));
    expect(await deterministicUuid("a:b"), "the separator must not be transparent").not.toBe(await deterministicUuid("ab"));
  });
});
