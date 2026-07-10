// RFC 6962 Merkle tree — the append-only ledger's daily anchor primitive (REQ-014).
//
// Domain separation is the whole point: a leaf is SHA-256(0x00 || data) and an internal node is
// SHA-256(0x01 || left || right). Without the 0x00/0x01 prefix bytes an attacker could present an
// internal node's preimage as a leaf (or vice-versa) and forge an inclusion proof — the classic
// second-preimage attack that plain concatenation trees are vulnerable to. Never drop the prefixes.
//
// A lone odd node PROMOTES unchanged to the next level (RFC 6962), it is NOT duplicated with itself
// (the Bitcoin CVE-2012-2459 quirk, which lets two distinct leaf-sets share a root). The empty tree
// is SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.
//
// PURE: no D1, no R2, no LLM (REQ-024). WebCrypto only.

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

export interface ProofStep {
  /** Which side the sibling hash sits on when recombining: "L" = sibling is the left operand. */
  side: "L" | "R";
  /** The sibling node hash, lower-case hex. */
  hash: string;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

async function leafHash(data: Uint8Array): Promise<Uint8Array> {
  const buf = new Uint8Array(1 + data.length);
  buf[0] = LEAF_PREFIX;
  buf.set(data, 1);
  return sha256(buf);
}

async function nodeHash(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  const buf = new Uint8Array(1 + left.length + right.length);
  buf[0] = NODE_PREFIX;
  buf.set(left, 1);
  buf.set(right, 1 + left.length);
  return sha256(buf);
}

// Fold the leaf hashes level-by-level, promoting a lone rightmost node unchanged. This is provably
// identical to RFC 6962's recursive largest-power-of-two split (see fixtures/merkle-vectors) and lets
// inclusionProof read the sibling structure straight off the same level arrays — so a proof can never
// disagree with the root it is built beside.
async function buildLevels(leaves: Uint8Array[]): Promise<Uint8Array[][]> {
  let level = await Promise.all(leaves.map(leafHash));
  const levels: Uint8Array[][] = [level];
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      // i+1 present -> hash the pair; otherwise the lone node promotes verbatim (never self-paired).
      next.push(i + 1 < level.length ? await nodeHash(level[i]!, level[i + 1]!) : level[i]!);
    }
    levels.push(next);
    level = next;
  }
  return levels;
}

export async function merkleRoot(leaves: Uint8Array[]): Promise<Uint8Array> {
  if (leaves.length === 0) return sha256(new Uint8Array(0)); // empty tree = SHA-256("")
  const levels = await buildLevels(leaves);
  return levels[levels.length - 1]![0]!;
}

export async function inclusionProof(leaves: Uint8Array[], index: number): Promise<ProofStep[]> {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new Error(`inclusionProof: index ${index} out of range [0, ${leaves.length})`);
  }
  const levels = await buildLevels(leaves);
  const proof: ProofStep[] = [];
  let idx = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l]!;
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    if (siblingIdx < level.length) {
      // A right-positioned node's sibling is to its LEFT, and vice-versa. A lone promoted node
      // (even idx, no idx+1) contributes NO step — it just rises to the next level.
      proof.push({ side: isRight ? "L" : "R", hash: bytesToHex(level[siblingIdx]!) });
    }
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export async function verifyInclusion(leafData: Uint8Array, proof: ProofStep[], root: Uint8Array): Promise<boolean> {
  let acc = await leafHash(leafData);
  for (const step of proof) {
    const sibling = hexToBytes(step.hash);
    acc = step.side === "L" ? await nodeHash(sibling, acc) : await nodeHash(acc, sibling);
  }
  return bytesEqual(acc, root);
}

// ---- byte/hex helpers (shared with anchor.ts + the TSA client) ----------------------------------

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hexToBytes: odd-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`hexToBytes: non-hex at offset ${i * 2}`);
    out[i] = byte;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
