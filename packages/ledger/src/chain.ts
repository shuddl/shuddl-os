import { canonicalBytes, sha256Hex } from "./canonical.js";
import type { LedgerEvent } from "@shuddl/contracts";

export const GENESIS_HASH = "0".repeat(64);

// hashView: the envelope minus sig and minus the stored hash itself. Everything else —
// prev_hash, seq, id, ts, recorded_at — is covered, so tampering anywhere breaks the
// next link. Frozen forever alongside the canonical byte law.
export function hashView(e: LedgerEvent): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...(e as Record<string, unknown>) };
  delete rest.sig;
  delete rest.hash;
  return rest;
}

export async function hashEvent(e: LedgerEvent): Promise<string> {
  return sha256Hex(canonicalBytes(hashView(e)));
}

// Test/fixture helper: assigns seq (dense from 0), prev_hash, hash.
export async function buildChain(events: LedgerEvent[]): Promise<LedgerEvent[]> {
  const out: LedgerEvent[] = [];
  let prev = GENESIS_HASH;
  for (const [i, e] of events.entries()) {
    const withLinks = { ...e, seq: i, prev_hash: prev };
    const hash = await hashEvent(withLinks as LedgerEvent);
    out.push({ ...withLinks, hash } as LedgerEvent);
    prev = hash;
  }
  return out;
}

export type ChainFailure = { seq: number; reason: "prev_hash_mismatch" | "seq_gap" | "bad_genesis" | "hash_mismatch" };
export type ChainResult = { ok: true; head: string; count: number } | { ok: false; failure: ChainFailure };

// Streaming verification: accepts a plain array or an async page-iterator (the API worker
// keyset-pages D1 by seq). Signature verification is NOT done here — P-256 verify is ~1ms
// each, so 10K events would cost ~10s; that lives in a separate verifySignatures pass.
export async function verifyChain(
  events: AsyncIterable<LedgerEvent> | Iterable<LedgerEvent>,
  opts?: { fromSeq?: number; trustedPrevHash?: string },
): Promise<ChainResult> {
  let expectedSeq = opts?.fromSeq ?? 0;
  let expectedPrev = opts?.trustedPrevHash ?? GENESIS_HASH;
  let count = 0;
  for await (const e of events as AsyncIterable<LedgerEvent>) {
    if (e.seq !== expectedSeq) return { ok: false, failure: { seq: e.seq, reason: "seq_gap" } };
    if (e.prev_hash !== expectedPrev) {
      return { ok: false, failure: { seq: e.seq, reason: e.seq === 0 ? "bad_genesis" : "prev_hash_mismatch" } };
    }
    const recomputed = await hashEvent(e);
    if (e.hash !== undefined && e.hash !== recomputed) return { ok: false, failure: { seq: e.seq, reason: "hash_mismatch" } };
    expectedPrev = recomputed;
    expectedSeq += 1;
    count += 1;
  }
  return { ok: true, head: expectedPrev, count };
}
