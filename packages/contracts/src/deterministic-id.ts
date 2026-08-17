// §1716 (REQ-118/119) — THE ONE DETERMINISTIC EVENT-ID DERIVATION.
//
// Several append paths derive an event id from a SEED rather than minting a random one, so that re-running the
// same logical step produces the SAME id and the sequencer's dedupe collapses it. That is the mechanism behind
// "twice in, once out" on:
//
//   · `POST /v1/shipments/:id/accept-quote` — one `quote.accepted` per quote, even past the HTTP idempotency
//     window (portal-actions.ts; and §1715 measured what happens where that structural guarantee is absent)
//   · the portal claim seam, the approval decision, the Collector's dunning notice
//   · the translator's EDI 204 chain (quote.requested → priced → accepted → agent.acted / approval.requested)
//   · the legacy-mirror sweep's re-ingest — LAW 3(a)
//
// Every one of those is an APPEND-ONLY write. If two call sites derive different ids from the same seed, the
// dedupe silently stops working and the second write is a REAL duplicate event that cannot be deleted (I3/I7);
// there is no correcting it, only a compensating event.
//
// SO WHY THIS FILE EXISTS. Measured at §1716, `deterministicUuid` was defined SIX times — `portal-actions.ts`,
// `dunning.ts`, `approvals.ts`, `inbound.ts`, `map-204.ts`, `mirror-sweep.ts` — across three workers, in TWO
// textual shapes (five sliced the digest to 32 chars and read the variant nibble with a `|| "0"` fallback; the
// sixth kept the full 64 and used `charAt(16)`). Those two shapes are semantically identical — proved over 406
// seeds, zero disagreements, against a positive control that DID disagree on 314 of them — so nothing was
// broken. That is exactly the §1547 situation the metering period was in: byte-divergent copies that agree
// only because nobody has yet edited one. An id derivation is the worst member of that class to leave
// unconsolidated, because its failure mode is an immutable duplicate rather than a wrong number.
//
// The workers now IMPORT this; they do not redefine it. `tools/checks/deterministic-id-single-source.test.ts`
// is what keeps that true, and `deterministic-id.test.ts` beside this file pins the OUTPUT — see the warning
// on `deterministicUuid` about why the bytes, not just the shape, are the contract.
//
// REQ-024: a PURE crypto util, exactly like `party.ts` — no ledger import, no zod, no LLM. `crypto.subtle` is
// available in both Node and Workers, so contracts stays the dependency-light boundary every worker can import.

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Derive a stable RFC-4122-SHAPED uuid from a seed string: the first 32 hex characters of SHA-256(seed), laid
 * out `8-4-4-4-12` with the version nibble forced to `4` and the variant nibble forced into `8|9|a|b`. The
 * shape matters because these ids land in `events.id`, which is uuid-shaped by contract — a raw hex slice
 * would be rejected at the boundary rather than deduped.
 *
 * ⚠️ THE BYTES ARE THE CONTRACT, NOT THE SHAPE. Ids derived by this function are ALREADY PERSISTED in
 * append-only `events` rows. Changing the digest, the slice offsets, the nibble arithmetic — anything that
 * moves an output byte — does not "fix" old rows: it makes every future re-derivation MISS them, so the next
 * re-ingest appends a duplicate of an event that can never be deleted. This is the same rule `party.ts` states
 * for its legacy `intake:` prefix ("byte-exactness is the point, not symmetry"). `deterministic-id.test.ts`
 * pins six golden seed→id pairs plus one seed per variant nibble; if you are here to change this function,
 * that suite is the conversation you are having.
 *
 * NOT a random-id replacement. Use this only where a repeat of the same logical step must collapse to one
 * event; a genuinely new event still mints a random id.
 */
export async function deterministicUuid(seed: string): Promise<string> {
  const h = (await sha256Hex(seed)).slice(0, 32);
  // Variant per RFC 4122 §4.4: the top two bits of the 17th nibble set to 10 ⇒ 8, 9, a or b.
  const variant = ((parseInt(h.slice(16, 17) || "0", 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
