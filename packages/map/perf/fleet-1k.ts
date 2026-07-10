// The 1,000-entity perf fixture (REQ-079) — the named entry point the perf harness (`perf.spec.ts`)
// and its unit test (`fleet-1k.test.ts`) consume. The seeded generator itself lives in
// `../src/demo.ts` (shared with the five canonical screens) so there is ONE deterministic source of
// truth for synthetic fleets. `fleet1k()` is `generateFleet({ count: 1000, seed: FLEET_1K_SEED })`.
export { fleet1k, generateFleet, FLEET_1K_SEED } from "../src/demo.js";
export type { GenerateFleetOptions } from "../src/demo.js";
