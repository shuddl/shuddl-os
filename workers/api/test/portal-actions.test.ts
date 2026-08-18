import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { rowToEvent } from "@shuddl/ledger/lens";
import type { LedgerEvent } from "@shuddl/contracts";
import { ensureSchema, seedRateConfig, TEST_RATE_CONFIG, token, post, TENANT_SLUG } from "./helpers.js";

// REQ-085 (WP-09 Task 8) — the NARROW, lens-gated portal action seams:
//   Piece 1 — POST /v1/rate now admits `portal`, lens-scoped to a shipment the party can see.
//   Piece 2 — POST /v1/shipments/:id/accept-quote → quote.accepted (triggers the WP-08 Booking agent).
//   Piece 3 — POST /v1/shipments/:id/claim → a portal-channel message.received (timeline + Concierge queue);
//             and the custody-chain VIEW through the EXISTING GET /v1/shipments/:id/events under the party lens.
//
// Ids are prefixed `pa-` and unique to this file — the harness shares ONE D1 across files (isolatedStorage
// off), so every stream/party/shipment id is scoped to us and no case assumes an empty table.

const PORTAL_P = "pa-portal-party"; // the party the shipment is visible to
const OTHER_P = "pa-other-party"; // a portal party NOT on the shipment (the cross-party adversary)

const SHP = "pa-shp-1"; // the quote→accept→claim shipment; PORTAL_P is on party_refs
const SHP_VIEW = "pa-shp-view"; // the custody-chain VIEW shipment; PORTAL_P is on party_refs

const HEX64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const GEO = { lat_e6: 37_421_000, lon_e6: -122_084_000, accuracy_m: 5 };
const PRICEABLE = { origin_zip: "97201", dest_zip: "80012", weight_lb: 1000, dims: { l_in: 48, w_in: 40, h_in: 48, pieces: 2 } };

const opsTok = (): Promise<string> => token({ sub: "pa-ops", tenant: TENANT_SLUG, role: "ops" });
const portalTok = (partyId: string): Promise<string> => token({ sub: `${partyId}-user`, tenant: TENANT_SLUG, role: "portal", party_id: partyId });

// booking.created: creates the shipments row (T4) AND puts `refs` on party_refs so a portal party is visible
// on the stream. bill_to = party-bill-to (has a deliverable email → REQ-182 gate passes; no credit hold).
function bookingInput(shipmentId: string, refs: string[]): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: 1_720_000_000_000,
    actor: { party: "party-shipper" },
    party_refs: refs,
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "booking.created",
    payload: { quote_event_id: "pa-quote-seed", division: "main", shipper_party_id: "party-shipper", consignee_party_id: "party-consignee", bill_to_party_id: "party-bill-to" },
  };
}

interface Res {
  status: number;
  json: Record<string, unknown> | null;
}
async function rate(shipmentId: string, tok: string): Promise<Res> {
  const res = await SELF.fetch("https://api.local/v1/rate", {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify({ shipment_id: shipmentId, ...PRICEABLE }),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}
async function acceptQuote(shipmentId: string, body: unknown, tok: string): Promise<Res> {
  const res = await SELF.fetch(`https://api.local/v1/shipments/${shipmentId}/accept-quote`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}
async function fileClaim(shipmentId: string, body: unknown, tok: string): Promise<Res> {
  const res = await SELF.fetch(`https://api.local/v1/shipments/${shipmentId}/claim`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}
/** File a claim with an EXPLICIT Idempotency-Key, so two principals can be driven with the same one (§1615). */
async function fileClaimWithKey(shipmentId: string, body: unknown, tok: string, key: string): Promise<Res> {
  const res = await SELF.fetch(`https://api.local/v1/shipments/${shipmentId}/claim`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}
async function listEvents(shipmentId: string, tok: string): Promise<{ status: number; events: LedgerEvent[]; body: string }> {
  const res = await SELF.fetch(`https://api.local/v1/shipments/${shipmentId}/events`, { headers: { Authorization: `Bearer ${tok}` } });
  const body = await res.text();
  const parsed = res.status === 200 ? (JSON.parse(body) as { events: LedgerEvent[] }) : { events: [] };
  return { status: res.status, events: parsed.events, body };
}
async function streamEvents(shipmentId: string): Promise<LedgerEvent[]> {
  const r = await env.TENANT_A_DB.prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq").bind(`s:${shipmentId}`).all();
  return (r.results as Record<string, string | number | null>[]).map((row) => rowToEvent(row));
}
async function quotePricedIdOf(shipmentId: string): Promise<string> {
  const evs = await streamEvents(shipmentId);
  const q = evs.find((e) => e.kind === "quote.priced");
  if (!q) throw new Error(`no quote.priced on ${shipmentId}`);
  return q.id;
}

beforeAll(async () => {
  await ensureSchema(env);
  await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
  const ops = await opsTok();
  // SHP + SHP_VIEW: PORTAL_P visible via booking.created party_refs; OTHER_P is on neither.
  for (const id of [SHP, SHP_VIEW]) {
    const b = await post(id, bookingInput(id, [PORTAL_P]), ops);
    if (b.status !== 201) throw new Error(`seed ${id}/booking failed: ${b.status} ${JSON.stringify(b.json)}`);
  }

  // SHP_VIEW: seed the custody chain (custody.transferred/exception.raised/pod.signed) with PORTAL_P on
  // party_refs so the party lens surfaces them. Non-interline custody passes cleanly; exception carries a
  // photo+reason_code (REQ-050); pod.signed is ungated. Real actor parties (passport FK).
  const chain: Array<{ kind: string; payload: Record<string, unknown>; actor: string }> = [
    { kind: "custody.transferred", payload: { from_party: "party-shipper", to_party: "party-carrier", geo: { ...GEO }, unwitnessed: true }, actor: "party-carrier" },
    { kind: "exception.raised", payload: { photo_hash: HEX64, reason_code: "damage", note: "pa fixture" }, actor: "party-carrier" },
    { kind: "pod.signed", payload: { signature_hash: HEX64, geo: { ...GEO }, unwitnessed: true }, actor: "party-carrier" },
  ];
  for (const c of chain) {
    const r = await post(SHP_VIEW, { id: crypto.randomUUID(), shipment_id: SHP_VIEW, ts: 1_720_000_000_000, actor: { party: c.actor }, party_refs: [PORTAL_P], evidence: [], source: "native", confidence: 10_000, kind: c.kind, payload: c.payload }, ops);
    if (r.status !== 201) throw new Error(`seed ${SHP_VIEW}/${c.kind} failed: ${r.status} ${JSON.stringify(r.json)}`);
  }
  // §1778 — AN EXPLICIT BOUND. Measured from a full `pnpm test` merge run: this file spends 5.4s
  // in setup (file total minus the sum of its per-test durations) against vitest's DEFAULT 10s hook
  // timeout — 54% of the budget, on a machine that was not otherwise loaded. §1777's
  // `lens-adversarial` proved this is not theoretical: the same default killed a 14.4s-setup hook mid-run,
  // skipping 45 tests with no assertion failure to point at. Bounded at the hook rather than package-wide so a future slowdown here is still visible.
}, 60_000);

// ---- Piece 1: /v1/rate admits a lens-scoped portal party -------------------------------------------
describe("Piece 1 — POST /v1/rate lens-gated for portal (REQ-085)", () => {
  it("a portal party prices its OWN shipment → 200 PRICED, appends quote.priced", async () => {
    const before = (await streamEvents(SHP)).filter((e) => e.kind === "quote.priced").length;
    const r = await rate(SHP, await portalTok(PORTAL_P));
    expect(r.status).toBe(200);
    expect(r.json?.status).toBe("PRICED");
    const after = (await streamEvents(SHP)).filter((e) => e.kind === "quote.priced").length;
    expect(after).toBe(before + 1); // the authorized portal price appended a quote.priced
  });

  it("a portal party rating a shipment it CANNOT see → 403, nothing appended", async () => {
    const before = (await streamEvents(SHP)).length;
    const r = await rate(SHP, await portalTok(OTHER_P));
    expect(r.status).toBe(403);
    expect((await streamEvents(SHP)).length).toBe(before); // no quote.priced/agent.acted for an unauthorized party
  });

  it("ops stays unrestricted (control) — prices the same shipment 200 PRICED", async () => {
    const r = await rate(SHP, await opsTok());
    expect(r.status).toBe(200);
    expect(r.json?.status).toBe("PRICED");
  });

  // REQ-085 / REQ-074 — the COUNTERPARTY response shape. The redaction law (packages/ledger/src/redact.ts
  // REDACTIONS["quote.priced"]) strips floors/basis/versions from every non-tenant lens on the events read;
  // the same party must not receive them synchronously at pricing time. The guest twin (/pub/quote) already
  // declares these EXCLUDED forever; this pins the authed portal response to the same law.
  it("the portal PRICED response carries NO margin internals — floors/versions/basis and the approval cents/share never reach a counterparty (REQ-085/074)", async () => {
    const r = await rate(SHP, await portalTok(PORTAL_P));
    expect(r.status).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(body.status).toBe("PRICED");
    // The exact allowlist and NOTHING else — a future field addition must consciously pass this gate.
    expect(Object.keys(body).sort()).toEqual(["anomaly", "approval", "lines", "sell_cents", "status", "transit"]);
    expect(body.floors).toBeUndefined();
    expect(body.versions).toBeUndefined();
    expect(body.basis).toBeUndefined();
    // approval keeps only the gate RESULT the UI reflects — never the evaluated/gross/share economics.
    const approval = body.approval as Record<string, unknown>;
    expect(Object.keys(approval).sort()).toEqual(["approval", "approvals_required", "required_role", "rule"]);
    // each line is margin-free by re-map: kind/code/amount_cents only.
    for (const line of body.lines as Array<Record<string, unknown>>) {
      expect(Object.keys(line).sort()).toEqual(["amount_cents", "code", "kind"]);
    }
  });

  it("the tenant lens keeps the full shape (control) — ops still receives floors + versions", async () => {
    const r = await rate(SHP, await opsTok());
    expect(r.status).toBe(200);
    expect(r.json?.floors).toBeDefined();
    expect(r.json?.versions).toBeDefined();
  });
});

// ---- Piece 2: the narrow lens-gated accept seam ----------------------------------------------------
describe("Piece 2 — POST /v1/shipments/:id/accept-quote (REQ-085/028)", () => {
  it("a portal party accepts a priced quote on its shipment → 201 quote.accepted{quote_event_id}", async () => {
    await rate(SHP, await portalTok(PORTAL_P)); // ensure a quote.priced exists
    const quoteId = await quotePricedIdOf(SHP);
    const r = await acceptQuote(SHP, { quote_event_id: quoteId }, await portalTok(PORTAL_P));
    expect(r.status).toBe(201);
    expect(r.json?.kind).toBe("quote.accepted");
    expect((r.json?.payload as Record<string, unknown>).quote_event_id).toBe(quoteId);
    // the accept is on the stream (the WP-08 Booking trigger fires off it, best-effort, post-commit)
    const accepted = (await streamEvents(SHP)).filter((e) => e.kind === "quote.accepted");
    expect(accepted.some((e) => e.id === r.json?.id)).toBe(true);
  });

  it("accepting on a shipment it CANNOT see → 403 (lens gate before body)", async () => {
    const quoteId = await quotePricedIdOf(SHP);
    const r = await acceptQuote(SHP, { quote_event_id: quoteId }, await portalTok(OTHER_P));
    expect(r.status).toBe(403);
  });

  it("a quote_event_id not priced on this shipment → 400 (no dangling accept)", async () => {
    const r = await acceptQuote(SHP, { quote_event_id: crypto.randomUUID() }, await portalTok(PORTAL_P));
    expect(r.status).toBe(400);
  });

  // §1264 — THE WRONG-KIND HALF of the same guard. The case above names an id that exists NOWHERE, so it is
  // refused by `id = ?` and the `kind = 'quote.priced'` clause never runs — the fixture cannot tell a DANGLING
  // id from a WRONG-KIND one, though the test's name reads as though it covers both.
  //
  // Measured: deleting that clause left the FULL workers/api suite at 834/834 — and its MIRROR, booking.ts
  // GUARD 2, left workers/agents at 130/130. One rule written twice and NEITHER copy defended, so the
  // "defense in depth" against a wrong-kind quote id had zero depth.
  //
  // The damage is not a phantom booking (GUARD 2 skips it) — it is worse-shaped than that: the API answers
  // 201, an untrusted portal party writes a `quote.accepted` naming a non-quote event onto an APPEND-ONLY
  // ledger where it can never be removed (I3/I7), and the freight then silently never books.
  it("§1264 REQ-085: an id that EXISTS on this stream but is NOT a quote.priced → 400 (wrong-kind, not dangling)", async () => {
    const stream = await streamEvents(SHP);
    const notAQuote = stream.find((e) => e.kind !== "quote.priced");
    expect(notAQuote, "premise: the stream must carry a NON-quote event, or this repeats the dangling case").toBeDefined();
    const r = await acceptQuote(SHP, { quote_event_id: notAQuote!.id }, await portalTok(PORTAL_P));
    expect(r.status, `naming a ${notAQuote!.kind} as the accepted quote must be refused`).toBe(400);
    // ...and nothing was appended. Events are append-only: a malformed quote.accepted is permanent.
    const accepted = (await streamEvents(SHP)).filter((e) => e.kind === "quote.accepted");
    expect(
      accepted.some((e) => (e.payload as Record<string, unknown>).quote_event_id === notAQuote!.id),
      "a quote.accepted naming a non-quote event reached the immutable ledger",
    ).toBe(false);
  });

  it("a non-strict / malformed body is a clean 400", async () => {
    const quoteId = await quotePricedIdOf(SHP);
    const r = await acceptQuote(SHP, { quote_event_id: quoteId, sneaky: "x" }, await portalTok(PORTAL_P));
    expect(r.status).toBe(400);
  });

  it("accepting the SAME quote twice is idempotent — one quote.accepted (DO dedupe on a deterministic id)", async () => {
    // a fresh shipment so the count is unambiguous
    const shp = "pa-shp-idem";
    const ops = await opsTok();
    const b = await post(shp, bookingInput(shp, [PORTAL_P]), ops);
    expect(b.status).toBe(201);
    await rate(shp, await portalTok(PORTAL_P));
    const quoteId = await quotePricedIdOf(shp);
    const a1 = await acceptQuote(shp, { quote_event_id: quoteId }, await portalTok(PORTAL_P));
    const a2 = await acceptQuote(shp, { quote_event_id: quoteId }, await portalTok(PORTAL_P));
    expect(a1.status).toBe(201);
    expect(a2.status).toBe(201);
    expect(a1.json?.id).toBe(a2.json?.id); // same deterministic event id → the DO returned the existing row
    const accepted = (await streamEvents(shp)).filter((e) => e.kind === "quote.accepted");
    expect(accepted).toHaveLength(1);
  });
});

// ---- the adversary: a portal party can NEVER book / emit money / override a gate --------------------
describe("Piece 2 adversarial — portal cannot append booking.created / money / override (REQ-030/085)", () => {
  it("a portal POST of booking.created to the general events route → 403 (portal excluded from that role set)", async () => {
    const r = await post(SHP, bookingInput(SHP, [PORTAL_P]), await portalTok(PORTAL_P));
    expect(r.status).toBe(403);
    // and NO second booking.created landed
    const bookings = (await streamEvents(SHP)).filter((e) => e.kind === "booking.created");
    expect(bookings).toHaveLength(1);
  });

  it("a portal POST of a money kind (invoice.issued) → 403", async () => {
    const r = await post(SHP, { id: crypto.randomUUID(), shipment_id: SHP, ts: 1, actor: { party: PORTAL_P }, party_refs: [PORTAL_P], evidence: [], source: "native", confidence: 10_000, kind: "invoice.issued", payload: { invoice_id: "pa-x", party_id: PORTAL_P, division: "main", lines: [{ line_no: 1, kind: "freight", amount_cents: 1, gl_map: "4000" }] } }, await portalTok(PORTAL_P));
    expect(r.status).toBe(403);
  });

  it("a portal POST carrying a gate override → 403 (override needs an elevated role; portal is not on the route at all)", async () => {
    const r = await post(SHP, { id: crypto.randomUUID(), shipment_id: SHP, ts: 1, actor: { party: PORTAL_P }, party_refs: [PORTAL_P], evidence: [], source: "native", confidence: 10_000, kind: "stop.arrived", payload: { geo: { ...GEO }, auto: true }, override: { by: "x", reason: "y" } }, await portalTok(PORTAL_P));
    expect(r.status).toBe(403);
  });
});

// ---- Piece 3: claims — FILE + VIEW -----------------------------------------------------------------
describe("Piece 3 — POST /v1/shipments/:id/claim (REQ-085/100)", () => {
  it("a portal party files a claim → 201 message.received on the 'portal' channel, on its timeline", async () => {
    const r = await fileClaim(SHP, { description: "pallet arrived damaged, 2 cartons crushed" }, await portalTok(PORTAL_P));
    expect(r.status).toBe(201);
    expect(r.json?.kind).toBe("message.received");
    const payload = r.json?.payload as Record<string, unknown>;
    expect(payload.channel).toBe("portal");
    expect(payload.intent).toBe("claim");
    // it lands on the party's own timeline (party_refs includes the filer)
    const list = await listEvents(SHP, await portalTok(PORTAL_P));
    expect(list.events.some((e) => e.id === r.json?.id && e.kind === "message.received")).toBe(true);
    // and projects a messages read-model row on the portal channel (the Concierge/ops queue home)
    const row = await env.TENANT_A_DB.prepare("SELECT channel, direction FROM messages WHERE id = ?").bind(`msg:${r.json?.id as string}`).first<{ channel: string; direction: string }>();
    expect(row?.channel).toBe("portal");
    expect(row?.direction).toBe("in");
  });

  // §1615 (REQ-025/085/100) — TWO PRINCIPALS, ONE KEY: THE COLLISION §1613's FIX EXPOSED.
  //
  // The claim event id is derived from the Idempotency-Key so a retry reproduces its own id and the sequencer
  // dedupes it. The seed used to be `portal-claim:<shipment>:<key>` — no principal — and this route is
  // `requireRole("admin","ops","portal")`, so a party and an operator both reach it.
  //
  // Before §1613, the HTTP idempotency cache hid this: the second caller was served the first's cached response
  // and never ran. Folding `sub` into that scope made the second request EXECUTE — which is when the deeper
  // collision became reachable: same shipment, same key, same derived id, DO dedupe, and the second filer gets
  // the FIRST party's event back with a 201 while their own claim is never recorded. Fixing one layer moved the
  // collision down a layer; this pins the layer underneath.
  it("§1615: two DIFFERENT principals filing with the SAME Idempotency-Key produce two DISTINCT claims", async () => {
    const sharedKey = "shared-idem-1615";
    const first = await fileClaimWithKey(SHP, { description: "party sees crushed cartons" }, await portalTok(PORTAL_P), sharedKey);
    expect(first.status, "setup: the party's claim must land").toBe(201);

    const second = await fileClaimWithKey(SHP, { description: "ops files a separate note" }, await opsTok(), sharedKey);
    expect(second.status, "the second filer must not be refused").toBe(201);
    expect(
      second.json?.id,
      "the second principal was handed the FIRST party's event — same derived id, deduped at the sequencer — so " +
        "their own claim was never recorded while the 201 said it was",
    ).not.toBe(first.json?.id);

    // Both claims exist on the timeline: two filings, two events.
    const list = await listEvents(SHP, await opsTok());
    const ids = list.events.map((e) => e.id);
    expect(ids).toContain(first.json?.id);
    expect(ids).toContain(second.json?.id);
  });

  it("filing a claim on a shipment it CANNOT see → 403", async () => {
    const r = await fileClaim(SHP, { description: "not my shipment" }, await portalTok(OTHER_P));
    expect(r.status).toBe(403);
  });

  it("an over-long / non-strict claim body is a clean 400 (bounded)", async () => {
    const tooLong = "x".repeat(5000);
    expect((await fileClaim(SHP, { description: tooLong }, await portalTok(PORTAL_P))).status).toBe(400);
    expect((await fileClaim(SHP, { description: "ok", extra: 1 }, await portalTok(PORTAL_P))).status).toBe(400);
  });

  it("VIEW — a portal party reads the custody chain via the EXISTING events route (no new read route)", async () => {
    const list = await listEvents(SHP_VIEW, await portalTok(PORTAL_P));
    expect(list.status).toBe(200);
    const kinds = new Set<string>(list.events.map((e) => e.kind));
    for (const k of ["custody.transferred", "exception.raised", "pod.signed"]) {
      expect(kinds.has(k), `portal must see custody-chain kind ${k}`).toBe(true);
    }
  });

  it("VIEW — a portal party NOT on the shipment sees nothing", async () => {
    const list = await listEvents(SHP_VIEW, await portalTok(OTHER_P));
    expect(list.status).toBe(200);
    expect(list.events).toEqual([]);
  });
});

// ─── §927 — §377's CLASS, FINISHED: A PORTAL TOKEN WITHOUT party_id IS 403, NOT 500 ─────────────────────
//
// `party_id` is `z.string().optional()` in SessionClaims and nothing in the auth middleware requires it for
// `role: "portal"`, so this token is schema-valid and these paths are LIVE. §377 established exactly that,
// against a standing ledger that had the class filed as "defensive translation of an impossible error", and
// pinned two instances (invoices, documents). Four more existed. This closes two of them.
//
// The stakes are small and real: without the translation the plain `Error("LENS_UNRESOLVED: …")` reaches
// `app.onError` and becomes a 500 — a refusal either way, but a 500 says "this server is broken" where the
// truth is "this token is incomplete", and real 500s are harder to see when a reachable client error
// manufactures them.
//
// The MESSAGE is the discriminator, not the status: both routes answer 403 two lines later for a shipment
// outside scope, so asserting the status alone would not say which guard fired (§82's authoring rule).
describe("§927: a portal session WITHOUT party_id is 403 on the action and read paths (§377's class)", () => {
  const noParty = (): Promise<string> => token({ sub: "pa-noparty", tenant: TENANT_SLUG, role: "portal" });

  it("the portal ACTION path translates LENS_UNRESOLVED to a clean 403", async () => {
    const res = await fileClaim("shp-noparty-action", { reason: "damage", detail: "x" }, await noParty());
    expect(res.status, JSON.stringify(res.json)).toBe(403);
    expect(JSON.stringify(res.json)).toContain("SESSION LENS UNRESOLVED");
  });

  it("the RATE path translates it too (routes/rate.ts) — the fourth copy", async () => {
    // Completing the class rather than three-quarters of it: the sweep found FOUR silent copies and a fix
    // that closes three is the correct-per-FILE mistake this record keeps naming.
    const res = await rate("shp-noparty-rate", await noParty());
    expect(res.status, JSON.stringify(res.json)).toBe(403);
    expect(JSON.stringify(res.json)).toContain("SESSION LENS UNRESOLVED");
  });

  it("the shipment-events READ path translates it too (routes/events.ts toReadError)", async () => {
    const res = await listEvents("shp-noparty-read", await noParty());
    expect(res.status, res.body).toBe(403);
    expect(res.body).toContain("SESSION LENS UNRESOLVED");
  });
});
