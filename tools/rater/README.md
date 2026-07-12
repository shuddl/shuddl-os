# `tools/rater/parity.ts` — the rater parity harness (REQ-027 / REQ-165)

## What it is

The honest gate that proves the audited rating engine's behavior is reproduced by `@shuddl/rater`'s
`priceShipment`. It compares, per case, the service's output against the audited engine's **expected**
output — `status`, and when `PRICED` the `sell_cents` and (when the case pins them) the three `floors`;
when `UNKNOWN` the `reason` — **exactly**.

It backs two requirements that **cannot be closed from inside this repo**:

- **REQ-027** — the audited engine's **48 embedded tests** + the **504-quote sweep** pass in the service.
- **REQ-165** — the service **reproduces tenant-0 quotes exactly**.

Why not closeable here: the 48 tests, the 504-sweep, and the tenant-0 tariff are **engagement-workspace**
fixtures. They never enter this repo (REQ-167). `fixtures/manifest.json` lists them as `status: "pending"`:

| manifest id      | vendored path              | source                                            |
| ---------------- | -------------------------- | ------------------------------------------------- |
| `rater-48-tests` | `fixtures/rater/48-tests/` | manifest.private M-01 (ported engine v1.1 tests)  |
| `rater-504-sweep`| `fixtures/rater/504-sweep/`| manifest.private M-01                             |
| `zone-tariff-v1` | `fixtures/tariff/`         | manifest.private M-02…M-05 (zone tariff, ZIP→zone 560, rate groups, accessorials) |

## The two states

Run it with `pnpm check:rater-parity` (i.e. `tsx tools/rater/parity.ts`). It has exactly two behaviors, and
it distinguishes them by **actual filesystem presence** of the vendored inputs — never by a claim.

- **PENDING (current reality).** The case dirs and/or the tenant-0 config are absent. It prints the three
  pending manifest rows (id + status + path + on-disk state + source), prints a `PARITY PENDING …` line, and
  **exits 0 (advisory)**. It never prints "passed" / "GREEN". This is why it sits in the `verify` chain
  without blocking merges — mirroring `tools/fixtures/verify.ts`.

- **ACTIVE (once vendored).** All inputs are present. It loads + Zod-validates the config, loads every case
  per dir, and **before any GREEN** checks the counts: `fixtures/rater/48-tests/` must yield **exactly 48**
  cases and `fixtures/rater/504-sweep/` **exactly 504** (the literal REQ-027 numbers, pinned as named
  constants in `parity.ts`). A **0-case**, **short**, or **over** load hard-fails (exit 1) — reproducing over
  zero/partial comparisons is the exact false green this harness forbids, so an empty `[]` file, a stray
  metadata-only glob, or a half-vendored dir is surfaced, never blessed. Only when both counts match does it
  run the comparison, print `passed/total`, and **exit 1 on any mismatch**. The gate goes live automatically —
  no code change, no flag. (If the real engagement set ever legitimately differs from 48/504, that is a
  deliberate edit to the count constants + a register note — not a silent pass.)

**No dormant gate.** If `fixtures/manifest.json` marks any of `rater-48-tests` / `rater-504-sweep` /
`zone-tariff-v1` as `status:"vendored"` but the harness cannot find the files those rows name, it **hard-fails
(exit 1)** rather than PENDING-skip — a vendored claim the gate cannot honor must never sit silently off while
`check:fixtures` greens on the flipped manifest.

**Marking parity "passed" without the real fixtures is a hard failure of this harness.** There is no synthetic
"48 tests pass" path. The synthetic stand-in that proves the *runner logic* lives in
`packages/rater/test/parity.harness.test.ts` (inline, never under `fixtures/`) so it can never masquerade as
vendored engagement data.

## How to vendor the fixtures to activate it

1. **Cases** — drop JSON files into `fixtures/rater/48-tests/` and `fixtures/rater/504-sweep/`. Each file is
   either one case object or an array of case objects, matching `ParityCase`:

   ```json
   {
     "name": "chi-den-1500lb-liftgate",
     "request": { "origin_zip": "60601", "dest_zip": "80112", "weight_lb": 1500,
                  "dims": { "l_in": 48, "w_in": 40, "h_in": 48, "pieces": 1 },
                  "accessorials": ["liftgate"] },
     "expect": { "status": "PRICED", "sell_cents": 40000,
                 "floors": { "contribution": 25500, "full": 27600, "target": 29400 } }
   }
   ```

   - `expect.status` is `"PRICED"` or `"UNKNOWN"`.
   - `expect.sell_cents` is **required** when `PRICED` (a hollow PRICED case is rejected at parse).
   - `expect.floors` is optional — pin it to also gate the contribution/full/target ladder.
   - `expect.reason` is optional — pin it on an `UNKNOWN` case (`missing_physics` / `no_zone` / `no_rate_group`).
   - Extra keys on `request` are preserved (forward-compatible with the engine's export format).

2. **Tenant-0 config** — drop one JSON per `rate_config` kind into `fixtures/tariff/`, each validating against
   its `@shuddl/contracts` schema:

   | file                          | schema               | required |
   | ----------------------------- | -------------------- | -------- |
   | `fixtures/tariff/zone_tariff.json`  | `ZoneTariff`         | yes |
   | `fixtures/tariff/floors.json`       | `FloorsConfig`       | yes |
   | `fixtures/tariff/fsc.json`          | `FscConfig`          | yes |
   | `fixtures/tariff/accessorials.json` | `AccessorialSchedule`| yes |
   | `fixtures/tariff/class_adapter.json`| `ClassAdapter`       | optional |

3. **Update the manifest** — flip `rater-48-tests`, `rater-504-sweep`, `zone-tariff-v1` to
   `status: "vendored"` with pinned `sha256` (see `tools/fixtures/verify.ts`), noting the change per REQ-112.

Once all inputs are present, the next `pnpm check:rater-parity` runs the real comparison and gates on it.

## The runner is pure

`runParity(cases, config, priceFn = priceShipment): ParityResult` does the comparison with no I/O — the CLI
is only the vendored-vs-pending detection + loaders around it. That is what lets the harness test exercise the
comparison (including a deliberately-wrong case) without touching the filesystem or the real fixtures.
