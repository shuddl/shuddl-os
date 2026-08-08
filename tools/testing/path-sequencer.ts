// §729 — NO VITEST TYPE IMPORT. `import type { TestSpecification } from "vitest/node"` resolved to the
// ROOT's vitest 4 while the five workers that consume this class run 3.2.x, and the two majors'
// TestSpecification differ (v4 adds testNamePattern / testIds / testTagsFilter). §28 removed the RUNTIME
// coupling and recorded that "the only import left is a TYPE, which is erased at runtime" — true of
// runtime, but the declared CONTRACT still did not match the runner that calls it. Invisible until these
// vitest configs were typechecked for the first time (§729). Generic methods are assignable to both
// majors' sequencer interfaces, and the sort key is read structurally anyway, so no vitest type is needed.

/**
 * Order test FILES by path, deterministically, for every vitest project in this repo.
 *
 * WHY THIS EXISTS (2026-08-02 audit §21/§22). Vitest's default sequencer orders files by their CACHED
 * DURATION from previous runs, so the order drifts on its own as timings move — and `sequence.shuffle:
 * false` does NOT pin it, because shuffle is a different knob. Measured: two consecutive runs of the api
 * suite began with completely disjoint file lists, and the agents suite likewise reordered between runs.
 *
 * That turns any order-dependent defect into an intermittent one. This repo paid for that twice in one
 * session: a `usage_credits.id` UNIQUE collision that appeared in roughly one run in five (§17), and a
 * firehose 500 caused by a fixture seeding schema-invalid `events` rows that surfaced only when
 * `lens-adversarial` happened to draw a later slot than `driver-manifest` (§20/§21). Each cost several full
 * suite runs just to IDENTIFY. With the order pinned, both failed on every run and were fixed the same day.
 *
 * The api worker needs this most — it runs `isolatedStorage: false`, so 66 files share ONE D1 with no
 * per-test rollback and file order is literally part of the fixture. But the other workers are not immune:
 * `beforeAll` writes are never rolled back even when `isolatedStorage` is on. Determinism is also worth
 * having for its own sake — a flaky failure you can reproduce is a bug, one you cannot is a rumour.
 *
 * NO BASE CLASS, DELIBERATELY (§28). This first shipped as `class PathSequencer extends BaseSequencer`.
 * A review caught the consequence: the root pins vitest ^4.1.10 while ALL FIVE workers pin 3.2.x, so
 * importing the class from `tools/` handed a **v4 base class to a v3 runner**. It happened to work — `sort`
 * is fully overridden and v3 only calls `shard()` under `--shard`, which CI does not pass — but "happens to
 * work across a major version" is not a property to depend on in the harness that decides whether every
 * other test is trustworthy. Implementing the two methods directly removes the coupling: the only import
 * left is a TYPE, which is erased at runtime, so each project instantiates a plain class of its own vintage.
 */
export class PathSequencer {
  /**
   * Stable, history-independent order. Sorting by the full module id (not the basename) keeps directories
   * grouped, which is the property that makes a failure reproducible rather than merely alphabetical.
   */
  async sort<T>(files: T[]): Promise<T[]> {
    const key = (f: unknown): string =>
      typeof f === "string" ? f : (((f as { moduleId?: string }).moduleId ?? String((f as unknown[])?.[1] ?? f)) as string);
    return [...files].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  }

  /**
   * `--shard` support. Not used by CI today, but implemented rather than stubbed: a sequencer that silently
   * returned every file to every shard would make a sharded run pass while re-running the whole suite N
   * times, which is exactly the kind of quietly-wrong harness this module exists to prevent. Shards the
   * PATH-SORTED list so a given file lands in the same shard on every run.
   */
  async shard<T>(files: T[], index?: number, count?: number): Promise<T[]> {
    // §729 — THE PARAMS ARE OPTIONAL BECAUSE TWO VITEST MAJORS ARE IN PLAY, and this file is the seam.
    // The note above records that the root pins ^4.1.10 while all five workers pin 3.2.x. v3 calls
    // `shard(files, index, count)`; v4 changed the interface to `shard(files)` and carries the shard spec on
    // the runner config. A REQUIRED 3-arg signature is not assignable to v4's 1-arg one, which is the type
    // error that surfaced the moment these configs were first typechecked at all (§729).
    //
    // Optional params satisfy both. What must NOT happen is the silent path: with `count` undefined,
    // `Math.ceil(n / undefined)` is NaN and `slice(NaN, NaN)` returns [] — a sharded run would report every
    // shard GREEN having executed NOTHING. That is a worse version of the exact failure the comment above
    // says this method exists to prevent, so absent params throw.
    if (typeof index !== "number" || typeof count !== "number") {
      throw new Error(
        "PathSequencer.shard was called without an index/count (vitest v4 passes the shard spec on the runner " +
          "config instead of as arguments). Read it from the config before sharding — returning an empty or a " +
          "full list here would make every shard pass while running nothing, or run the whole suite N times.",
      );
    }
    const sorted = await this.sort(files);
    const per = Math.ceil(sorted.length / count);
    return sorted.slice((index - 1) * per, index * per);
  }
}

/** The sequence block every project spreads into its vitest `test` config. */
export const DETERMINISTIC_SEQUENCE = { shuffle: false, concurrent: false, sequencer: PathSequencer } as const;
