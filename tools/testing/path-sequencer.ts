import { BaseSequencer } from "vitest/node";

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
 * `beforeAll` writes are never rolled back even when `isolatedStorage` is on, so cross-file state exists
 * there too. Determinism is also worth having for its own sake — a flaky failure you can reproduce is a bug,
 * one you cannot is a rumour.
 *
 * Sorting by PATH is the only ordering that does not depend on run history. It is deliberately not
 * alphabetical-by-basename: the full module id keeps directories grouped, which is the stable choice.
 *
 * ONE definition, imported by every config, rather than a copy per project — the same rule this audit
 * applied to the reserved-plan SQL and the usage_credits id, and for the same reason: five copies of an
 * ordering rule is five chances for four of them to drift.
 */
export class PathSequencer extends BaseSequencer {
  // `ReturnType<BaseSequencer["sort"]>` is ALREADY `Promise<…>` — wrapping it again in `Promise<>` is what
  // the first cut did, and it typechecked inside the vitest config (not covered by a tsconfig) while
  // failing the moment the class moved into `tools/`. A good argument for the shared module.
  async sort(files: Parameters<BaseSequencer["sort"]>[0]): ReturnType<BaseSequencer["sort"]> {
    const key = (f: unknown): string =>
      typeof f === "string" ? f : (((f as { moduleId?: string }).moduleId ?? String((f as unknown[])?.[1] ?? f)) as string);
    return [...files].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  }
}

/** The sequence block every project spreads into its vitest `test` config. */
export const DETERMINISTIC_SEQUENCE = { shuffle: false, concurrent: false, sequencer: PathSequencer } as const;
