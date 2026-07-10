// Independent RFC 6962 reference generator for vectors.json (REQ-014). Run: `node ref6962.mjs`.
// This computes the Merkle Tree Hash by the RECURSIVE largest-power-of-two split — a DIFFERENT
// algorithm from packages/ledger/src/merkle.ts (which folds level-by-level with odd-node promotion).
// Both must produce the same roots; merkle.test.ts re-derives them a third way by explicit
// hand-composition. Three independent derivations agreeing is the anti-circularity guard.
import { createHash } from "node:crypto";

const sha = (b) => createHash("sha256").update(b).digest();
const leafHash = (d) => sha(Buffer.concat([Buffer.from([0x00]), Buffer.from(d)]));
const nodeHash = (l, r) => sha(Buffer.concat([Buffer.from([0x01]), l, r]));

function largestPow2LessThan(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}
function mth(leaves) {
  if (leaves.length === 0) return sha(Buffer.alloc(0));
  if (leaves.length === 1) return leafHash(leaves[0]);
  const k = largestPow2LessThan(leaves.length);
  return nodeHash(mth(leaves.slice(0, k)), mth(leaves.slice(k)));
}

const leaves = [];
for (let i = 0; i < 7; i++) leaves.push(Buffer.from([i]));
const roots = {};
for (let n = 0; n <= 7; n++) roots[String(n)] = mth(leaves.slice(0, n)).toString("hex");
console.log(JSON.stringify({ leaves: leaves.map((b) => b.toString("hex")), roots }, null, 2));
