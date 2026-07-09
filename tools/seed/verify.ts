import { readFileSync } from "node:fs";
import { generateSeed, seedHash } from "./generate.js";

// REQ-155 DoD: `pnpm seed` reproduces an identical dataset hash.
const pinned = readFileSync("tools/seed/seed.hash", "utf8").trim();
const actual = seedHash(generateSeed());
if (pinned !== actual) {
  console.error(`FAIL SEED-1 hash drift: pinned ${pinned.slice(0, 12)}… vs actual ${actual.slice(0, 12)}…`);
  console.error("A deliberate seed change must regenerate the pin (pnpm seed) and say so in the PR.");
  process.exit(1);
}
console.log("SEED-1 hash verified");
