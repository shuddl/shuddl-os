import type { TestSpecification } from "vitest/node";

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
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
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
  async shard(files: TestSpecification[], index: number, count: number): Promise<TestSpecification[]> {
    const sorted = await this.sort(files);
    const per = Math.ceil(sorted.length / count);
    return sorted.slice((index - 1) * per, index * per);
  }
}

/** The sequence block every project spreads into its vitest `test` config. */
export const DETERMINISTIC_SEQUENCE = { shuffle: false, concurrent: false, sequencer: PathSequencer } as const;
