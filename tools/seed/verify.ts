import { readFileSync } from "node:fs";
import { generateSeed, seedHash } from "./generate.js";
import { repoRoot } from "../checks/repo-root.js";

// REQ-155 DoD: `pnpm seed` reproduces an identical dataset hash. generateSeed/seedHash are async
// (the WP-02 envelope is canonically hash-chained via crypto.subtle), so this verifier awaits them.
async function main(): Promise<void> {
  const pinned = readFileSync(`${repoRoot()}/tools/seed/seed.hash`, "utf8").trim();
  const actual = await seedHash(await generateSeed());
  if (pinned !== actual) {
    console.error(`FAIL SEED-1 hash drift: pinned ${pinned.slice(0, 12)}… vs actual ${actual.slice(0, 12)}…`);
    console.error("A deliberate seed change must regenerate the pin (pnpm seed) and say so in the PR.");
    process.exit(1);
  }
  console.log("SEED-1 hash verified");
}

await main();
