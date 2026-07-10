import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, inclusionProof, merkleRoot, verifyInclusion, type ProofStep } from "../src/merkle.js";
import { sha256Hex } from "../src/canonical.js";
import vectorsRaw from "../../../fixtures/merkle-vectors/vectors.json?raw";

// RFC 6962 Merkle — the daily-anchor primitive (REQ-014). The fixture roots were derived by the
// recursive largest-power-of-two split (fixtures/merkle-vectors/ref6962.mjs). Here we re-derive them
// a THIRD, fully independent way — explicit by-hand composition of the exact tree SHAPE for each n —
// so the implementation (level-by-level fold), the generator (recursive split), and this test (hand
// composition) must all agree. If merkleRoot's odd-node promotion were wrong, these disagree.

const vectors = JSON.parse(vectorsRaw) as { leaves: string[]; roots: Record<string, string> };

async function sha(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}
const LH = (d: Uint8Array): Promise<Uint8Array> => sha(Uint8Array.from([0x00, ...d]));
const NH = (l: Uint8Array, r: Uint8Array): Promise<Uint8Array> => sha(Uint8Array.from([0x01, ...l, ...r]));

const VEC_LEAVES = vectors.leaves.map(hexToBytes);

describe("REQ-014 — RFC 6962 known-answer vectors (empty + 1..7 leaves)", () => {
  it("empty tree = SHA-256(\"\") = e3b0c442…", async () => {
    expect(bytesToHex(await merkleRoot([]))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(vectors.roots["0"]).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("merkleRoot matches the vendored fixture roots for n = 0..7", async () => {
    for (let n = 0; n <= 7; n++) {
      expect(bytesToHex(await merkleRoot(VEC_LEAVES.slice(0, n)))).toBe(vectors.roots[String(n)]);
    }
  });

  it("re-derives each fixture root by explicit hand-composition of the tree shape", async () => {
    const [l0, l1, l2, l3, l4, l5, l6] = VEC_LEAVES;
    const t01 = await NH(await LH(l0!), await LH(l1!));
    const t23 = await NH(await LH(l2!), await LH(l3!));
    const t0123 = await NH(t01, t23); // balanced 4-leaf subtree
    // n=1: H(leaf); n=2: node; n=3: node(node(0,1), leaf2); n=4: balanced; n=5..7 promote the tail.
    const hand: Record<number, Uint8Array> = {
      1: await LH(l0!),
      2: t01,
      3: await NH(t01, await LH(l2!)),
      4: t0123,
      5: await NH(t0123, await LH(l4!)),
      6: await NH(t0123, await NH(await LH(l4!), await LH(l5!))),
      7: await NH(t0123, await NH(await NH(await LH(l4!), await LH(l5!)), await LH(l6!))),
    };
    for (let n = 1; n <= 7; n++) {
      expect(bytesToHex(hand[n]!)).toBe(vectors.roots[String(n)]);
    }
  });
});

// Distinct leaf data per index (2-byte big-endian) — no accidental duplicate leaves.
function leaf(i: number): Uint8Array {
  return Uint8Array.of((i >> 8) & 0xff, i & 0xff);
}

async function mutateOneByte(hex: string): Promise<string> {
  const b = hexToBytes(hex);
  b[0] = b[0]! ^ 0x01;
  return bytesToHex(b);
}

describe("REQ-014 — inclusion proofs verify; any mutation fails (property loop n = 1..257)", () => {
  it("every leaf proof verifies, and mutated leaf / proof step / root are rejected", async () => {
    for (let n = 1; n <= 257; n++) {
      const leaves = Array.from({ length: n }, (_, i) => leaf(i));
      const root = await merkleRoot(leaves);
      // Exhaustive for small n; boundary + quartile sample for larger n (keeps the loop O(n) per size
      // instead of O(n^2), while still touching every tree size 1..257 and every boundary index).
      const indices =
        n <= 16
          ? Array.from({ length: n }, (_, i) => i)
          : [...new Set([0, 1, n >> 2, n >> 1, n - 2, n - 1])].filter((i) => i >= 0 && i < n);

      for (const idx of indices) {
        const proof = await inclusionProof(leaves, idx);
        // positive: the real leaf verifies
        expect(await verifyInclusion(leaf(idx), proof, root)).toBe(true);
        // mutated leaf data: a different leaf must NOT verify against this proof/root
        expect(await verifyInclusion(leaf(idx === 0 ? n : idx - 1), proof, root)).toBe(false);
        // mutated root: flip one byte
        const badRoot = hexToBytes(await mutateOneByte(bytesToHex(root)));
        expect(await verifyInclusion(leaf(idx), proof, badRoot)).toBe(false);
        // mutated proof step: flip one byte in a sibling hash (only when a sibling exists)
        if (proof.length > 0) {
          const badProof: ProofStep[] = proof.map((s, i) =>
            i === 0 ? { side: s.side, hash: hexToBytesSyncFlip(s.hash) } : s,
          );
          expect(await verifyInclusion(leaf(idx), badProof, root)).toBe(false);
          // mutated proof side: swapping L<->R must break recombination (except a single-step self-symmetric
          // case cannot arise here because sibling != self)
          const flippedSide: ProofStep[] = proof.map((s, i) =>
            i === 0 ? { side: s.side === "L" ? "R" : "L", hash: s.hash } : s,
          );
          expect(await verifyInclusion(leaf(idx), flippedSide, root)).toBe(false);
        }
      }
    }
  });
});

function hexToBytesSyncFlip(hex: string): string {
  const b = hexToBytes(hex);
  b[b.length - 1] = b[b.length - 1]! ^ 0x80;
  return bytesToHex(b);
}

describe("REQ-014 — merkle edge cases", () => {
  it("single-leaf proof is empty and verifies (root == leafHash)", async () => {
    const leaves = [leaf(0)];
    const proof = await inclusionProof(leaves, 0);
    expect(proof).toEqual([]);
    expect(await verifyInclusion(leaf(0), proof, await merkleRoot(leaves))).toBe(true);
  });

  it("inclusionProof rejects an out-of-range index", async () => {
    await expect(inclusionProof([leaf(0), leaf(1)], 2)).rejects.toThrow(/out of range/);
    await expect(inclusionProof([leaf(0)], -1)).rejects.toThrow(/out of range/);
  });

  it("hexToBytes/bytesToHex round-trip and sha256Hex agree on the empty-string digest", async () => {
    expect(bytesToHex(hexToBytes("00ff10"))).toBe("00ff10");
    expect(await sha256Hex(new Uint8Array(0))).toBe(bytesToHex(await merkleRoot([])));
  });
});
