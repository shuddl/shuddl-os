import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { feedReaderFor, runMirrorSweep } from "../src/index.js";
import { NotConfiguredFeedReader } from "../src/mirror-sweep.js";

// REQ-021/022/035/152 — THE LEGACY MIRROR CANNOT READ A FEED, AND THAT IS LOAD-BEARING (audit §1362).
//
// The third member of a family §379/§380 closed twice and never swept: `workers/translator/test/
// transport-dormancy.test.ts` and `workers/mcp/test/webhook-dormancy.test.ts`. §380 stated the finding
// exactly — *"the BEHAVIOUR of each default was pinned, the CHOICE of them was not, so swapping in a live
// implementation broke nothing"* — and then fixed two composition roots rather than counting them. A sweep of
// every selector that can return a `NotConfigured*` stub finds SEVEN; six are pinned. This was the seventh.
//
// WHY THIS ONE MATTERS MOST OF THE SEVEN. §1361 measured what un-darkening it costs. `sweepTenantLegacyMirror`
// does a D1 `anchorStream` read PLUS a sequencer append per record, over `records.filter(isNew)`. The watermark
// makes that `O(changed)` in STEADY STATE — but on the FIRST sweep after a feed is wired the cursor sits at its
// initial value, every row of the legacy export is `isNew`, and the loop runs the whole file against a
// per-invocation subrequest ceiling (1,000 Free / 10,000 Paid; no worker sets `[limits] subrequests`). There is
// no LIMIT and no page size. So the property that makes this cron safe today is not a bound in the code — it is
// that `feedReaderFor` returns a reader which cannot read.
//
// A TRIPWIRE, not a correctness proof. It asserts the mirror cannot ingest, and fails at the go-live config
// flip — which is exactly when the unbounded first sweep stops being hypothetical. Whoever REDs it should read
// the GO-LIVE-CHECKLIST row *"Live legacy-feed provisioning"*, which now carries the row-count warning, and
// decide a page size in the SAME change.

const HOLD =
  "STOP: the legacy mirror's first sweep is UNBOUNDED (audit §1361). `feedReaderFor` returning a dark reader " +
  "is the only thing bounding it today — the watermark bounds STEADY STATE only, and on the first sweep every " +
  "export row is new. Wiring a live feed without deciding a page size can exceed the per-invocation subrequest " +
  "ceiling mid-import. Read GO-LIVE-CHECKLIST 'Live legacy-feed provisioning' and resolve that first.";

describe("REQ-021/152: the production legacy-mirror feed is fail-closed (dormancy tripwire)", () => {
  const e = env as unknown as Parameters<typeof feedReaderFor>[0];

  it("the feed reader is the NotConfigured one — wiring a live feed must fail HERE first", () => {
    expect(feedReaderFor(e, "tenant-a"), HOLD).toBeInstanceOf(NotConfiguredFeedReader);
  });

  it("returns the dark reader for EVERY tenant, not merely the first — the choice is unconditional", () => {
    // `feedReaderFor` takes a slug, so a future per-tenant flip is a one-line change that would leave the
    // assertion above green for `tenant-a` while a different tenant ingests. Pinned across slugs so a partial
    // wiring cannot hide behind the one tenant this file happens to name.
    for (const slug of ["tenant-a", "tenant-b", "does-not-exist"]) {
      expect(feedReaderFor(e, slug), HOLD).toBeInstanceOf(NotConfiguredFeedReader);
    }
  });

  it("the dark reader yields nothing, so the sweep has nothing to iterate", () => {
    // The behaviour half — already true, asserted here so this file states the WHOLE hold rather than half of
    // it. `read()` returning null is what makes `sweepTenantLegacyMirror` a no-op; the assertion above is what
    // makes that reader the one production actually selects.
    return expect(new NotConfiguredFeedReader().read()).resolves.toBeNull();
  });

  it("is non-vacuous: the sweep it guards is real, exported and runnable", () => {
    // Without this, deleting `runMirrorSweep` or renaming the selector would leave every assertion above
    // trivially satisfiable by a stub import — the shape this audit rejects repeatedly (§786, §1351).
    expect(typeof runMirrorSweep).toBe("function");
    expect(typeof feedReaderFor).toBe("function");
  });
});
