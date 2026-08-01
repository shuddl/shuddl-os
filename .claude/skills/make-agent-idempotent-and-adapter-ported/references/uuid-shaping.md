# UUID-shaping recipe — reference & test vectors

The one deterministic-id helper every SHUDDL agent core copies. Byte-identical in
`workers/agents/src/biller.ts:78-95`, `concierge.ts:110-133`, `sla-sweep.ts:71-90`.
Never re-derive it "cleaner" — the parity is the point; the sequencer DO dedupes by
this id, so a redelivered trigger must reproduce the SAME id or it double-writes.

## The helper (verbatim)
```ts
// no Date, no random — redelivery must reproduce these exactly
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A domain-separated SHA-256 of the trigger event id, shaped into a v4-variant UUID
// so it satisfies EventInput's z.string().uuid().
async function eventIdFor(domain: string, triggerEventId: string): Promise<string> {
  const h = (await sha256Hex(`<agent>:${domain}:${triggerEventId}`)).slice(0, 32);
  const variant = ((parseInt(h.slice(16, 17) || "0", 16) & 0x3) | 0x8).toString(16); // 8/9/a/b
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
```

## Why each piece is load-bearing
- **`<agent>:${domain}:` prefix** — domain separation. One inbound message produces
  `quote-requested`, `quote-priced`, `message-sent` ids; distinct `domain` tags keep them
  from colliding. The `concierge:sla-overdue:` tag (`sla-sweep.ts:81`) never collides with
  the concierge quote-event ids derived from the same inbound.
- **`.slice(0, 32)`** — a UUID is 32 hex nibbles; take the first 128 bits of the digest.
- **`4` at position 12** — the literal version-4 nibble.
- **`variant` `(x & 0x3) | 0x8` → 8/9/a/b** — the RFC-4122 variant bits. Without this the
  string fails `z.string().uuid()` and the append is rejected.

## Non-UUID entity ids — same hash, different shape
Word-char-only ids (so `s:<id>` / `msg:<id>` streams stay valid), a distinct domain tag each:
```ts
`shp_${(await sha256Hex(`concierge:shipment:${messageEventId}`)).slice(0, 16)}`  // concierge.ts:127
`party_${(await sha256Hex(`concierge:party:${email}`)).slice(0, 16)}`            // concierge.ts:132 — keyed off from_ref, NOT model output
`inv_${(await sha256Hex(`biller:invoice:${podEventId}`)).slice(0, 16)}`          // biller.ts:94
```
Note `partyIdFor` keys off the **authenticated sender email** (`from_ref`), never the LLM's
`party_hint.email` — REQ-172. Deriving a party id from model output lets a crafted body match
a victim's party or mint an attacker party.

## Test-vector discipline
There is no golden UUID literal to paste here — the vectors live as executable assertions in the
agent test suites (`workers/agents/test/*`), which is the correct place (they run in CI). When you
add a new agent, mirror the existing pattern: assert that `eventIdFor(domain, id)` (a) matches
`/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`, and (b) is **stable** —
calling it twice with the same inputs returns the same string (the redelivery invariant). Do not
hardcode a digest here; a copy-paste vector rots the moment the domain tag changes.

## The redelivery invariant this protects
`workers/agents/src/concierge.ts:231-259` computes `shipmentId` + all three event ids up front,
then checks whether the terminal `message.sent` is already committed. Because every id is a pure
function of `msg.event_id`, a redelivery lands on the SAME primary keys → the fast-path re-sends
from committed events instead of creating a second shipment/quote. That is the whole safety story:
**determinism is what makes at-least-once delivery safe.**
