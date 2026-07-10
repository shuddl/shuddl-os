import { mkdirSync, writeFileSync } from "node:fs";
import { generateSeed, seedHash } from "./generate.js";

// Node CLI for `pnpm seed`: writes the SEED-1 artifact + repins tools/seed/seed.hash. Kept OUT of
// generate.ts because that module is imported by the pool-workers seed-load test, where node:fs is
// absent — this file is only ever run under tsx (Node).
async function main(): Promise<void> {
  const seed = await generateSeed();
  const hash = await seedHash(seed);
  mkdirSync("seed", { recursive: true });
  writeFileSync("seed/SEED-1.json", JSON.stringify(seed, null, 2));
  writeFileSync("tools/seed/seed.hash", hash + "\n");
  console.log(`SEED-1 written (${seed.shipments.length} shipments), hash ${hash.slice(0, 12)}…`);
}

await main();
