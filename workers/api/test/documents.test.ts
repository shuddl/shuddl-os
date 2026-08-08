import { tamperClaim } from "./helpers.js";
import { DocCapError, deriveDocSecret, mintDocDownloadCap, verifyDocDownloadCap } from "../src/pub/doc-cap.js";
import { StatusCapError, mintStatusCap, verifyStatusCap } from "../src/pub/status-cap.js";
import { sign } from "hono/jwt";
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ensureSchema,
  ensureTenantBSchema,
  nextEvidenceBytes,
  post,
  seedShipment,
  TENANT_SLUG,
  token,
} from "./helpers.js";
import { documentVisibilityFor } from "../src/routes/evidence.js";

// ─── REQ-085 (WP-09 Task 6) — THE PORTAL DOCUMENTS VIEW ─────────────────────────────────────────────
//
// Three surfaces under test:
//   1. GET /v1/shipments/:id/documents      — a lens-scoped documents LIST (a portal party sees only
//                                             visibility<>'internal' docs; ops/admin see all in-tenant).
//   2. GET /v1/documents/:id/url            — a short-lived SIGNED (tokenized-proxy) download URL, GATED
//                                             through the SAME lens (a party can only get a URL it can see).
//   3. GET /pub/documents/:cap             — the public bytes proxy the URL points at (cap IS the gate).
//
// THE CRUX: a documents row's `visibility` is DERIVED from the RECORDING event's resolved visibility, so a
// counterparty-visible POD/placed-photo becomes a counterparty-visible doc the portal party can actually
// see — while FAILING CLOSED to 'internal' on anything not known-wide.
//
// isolatedStorage is OFF (all api test files share ONE D1) — every case scopes to its own shipment id.

const TENANT = TENANT_SLUG;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A freight.photographed recording event carrying a chosen photo_hash + party_refs (+ an optional
// requested_visibility narrow). freight.photographed is NOT device-gated, so ops can append it directly.
function photographedInput(
  shipmentId: string,
  hash: string,
  partyRefs: string[],
  requestedVisibility?: "internal" | "counterparty" | "public",
): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: 1_720_000_000_000,
    actor: { party: "party-shipper" },
    party_refs: partyRefs,
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "freight.photographed",
    payload: { photo_hash: hash, photo_kind: "placed" },
    ...(requestedVisibility ? { requested_visibility: requestedVisibility } : {}),
  };
}

async function uploadEvidence(shipmentId: string, hash: string, bytes: Uint8Array, tok: string): Promise<Response> {
  return SELF.fetch(`https://api.local/v1/evidence?shipment_id=${encodeURIComponent(shipmentId)}&photo_hash=${hash}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/octet-stream" },
    body: new Uint8Array(bytes),
  });
}

// Record a placed-photo event on the stream (scoping partyRefs to whoever should see it), then upload the
// matching bytes — the REAL derivation path. Returns the derived documents.id.
async function recordAndUpload(
  shipmentId: string,
  partyRefs: string[],
  tok: string,
  requestedVisibility?: "internal" | "counterparty" | "public",
): Promise<string> {
  const bytes = nextEvidenceBytes();
  const hash = await sha256Hex(bytes);
  const rec = await post(shipmentId, photographedInput(shipmentId, hash, partyRefs, requestedVisibility), tok);
  expect(rec.status, `recording event must append: ${JSON.stringify(rec.json)}`).toBe(201);
  const up = await uploadEvidence(shipmentId, hash, bytes, tok);
  expect(up.status, "evidence upload must store").toBeGreaterThanOrEqual(200);
  expect(up.status).toBeLessThan(300);
  const body = (await up.json()) as { document_id: string };
  return body.document_id;
}

interface DocsListRes {
  status: number;
  documents: Array<Record<string, unknown>>;
}
async function listDocs(shipmentId: string, tok: string): Promise<DocsListRes> {
  const res = await SELF.fetch(`https://api.local/v1/shipments/${encodeURIComponent(shipmentId)}/documents`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const parsed = res.status === 200 ? ((await res.json()) as { documents: Array<Record<string, unknown>> }) : { documents: [] };
  return { status: res.status, documents: parsed.documents };
}

interface DocUrlRes {
  status: number;
  json: Record<string, unknown> | null;
}
async function docUrl(documentId: string, tok: string): Promise<DocUrlRes> {
  const res = await SELF.fetch(`https://api.local/v1/documents/${encodeURIComponent(documentId)}/url`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const opsTok = (): Promise<string> => token({ sub: "docs-ops", tenant: TENANT, role: "ops" });
const portalTok = (partyId: string): Promise<string> =>
  token({ sub: `${partyId}-user`, tenant: TENANT, role: "portal", party_id: partyId });

const DOCS_PARTY = "docs-party-1"; // the portal party on the shared documents shipment

const SHP_MIX = "docs-shp-mix"; // one counterparty doc + one internal doc (both DERIVED)
const SHP_DERIVE = "docs-shp-derive"; // pure derivation assertions (row visibility straight from D1)

let cpDocId = ""; // counterparty doc on SHP_MIX (party sees it)
let intDocId = ""; // internal doc on SHP_MIX (party never sees it)
let cpBytes: Uint8Array; // the bytes behind cpDocId, for the download-proxy assertion
let cpBytesHash = "";

beforeAll(async () => {
  await ensureSchema(env);
  await ensureTenantBSchema(env);
  const ops = await opsTok();

  await seedShipment(SHP_MIX);
  await seedShipment(SHP_DERIVE);

  // SHP_MIX: a counterparty doc (default freight.photographed visibility) and an internal doc (a recording
  // event NARROWED to internal). BOTH via the real derived path; both name DOCS_PARTY in party_refs so the
  // party is scoped to the shipment — yet the internal recording never surfaces to the party lens.
  cpBytes = nextEvidenceBytes();
  cpBytesHash = await sha256Hex(cpBytes);
  {
    const rec = await post(SHP_MIX, photographedInput(SHP_MIX, cpBytesHash, [DOCS_PARTY]), ops);
    expect(rec.status, JSON.stringify(rec.json)).toBe(201);
    const up = await uploadEvidence(SHP_MIX, cpBytesHash, cpBytes, ops);
    expect(up.status).toBe(201);
    cpDocId = ((await up.json()) as { document_id: string }).document_id;
  }
  intDocId = await recordAndUpload(SHP_MIX, [DOCS_PARTY], ops, "internal");

  // sanity: the derivation actually produced the two visibilities in the documents table.
  const rows = await env.TENANT_A_DB.prepare("SELECT id, visibility FROM documents WHERE shipment_id = ? ORDER BY id")
    .bind(SHP_MIX)
    .all<{ id: string; visibility: string }>();
  const byId = new Map(rows.results.map((r) => [r.id, r.visibility]));
  expect(byId.get(cpDocId)).toBe("counterparty");
  expect(byId.get(intDocId)).toBe("internal");
});

describe("documentVisibilityFor — fail-closed inheritance (skill fail-closed-on-inherited-visibility)", () => {
  it("only the known WIDE ranks inherit; internal / undefined / null / garbage collapse to 'internal'", () => {
    expect(documentVisibilityFor("counterparty")).toBe("counterparty");
    expect(documentVisibilityFor("public")).toBe("public");
    expect(documentVisibilityFor("internal")).toBe("internal");
    expect(documentVisibilityFor(undefined)).toBe("internal");
    expect(documentVisibilityFor(null)).toBe("internal");
    expect(documentVisibilityFor("bogus")).toBe("internal");
  });
});

describe("visibility DERIVATION from the recording event (evidence write)", () => {
  it("a counterparty-visible placed-photo recording yields a counterparty-visible doc row", async () => {
    const docId = await recordAndUpload(SHP_DERIVE, [DOCS_PARTY], await opsTok());
    const row = await env.TENANT_A_DB.prepare("SELECT visibility FROM documents WHERE id = ?").bind(docId).first<{ visibility: string }>();
    expect(row?.visibility).toBe("counterparty");
  });

  it("a recording NARROWED to internal yields an internal doc row (fail-closed, not widened)", async () => {
    const docId = await recordAndUpload(SHP_DERIVE, [DOCS_PARTY], await opsTok(), "internal");
    const row = await env.TENANT_A_DB.prepare("SELECT visibility FROM documents WHERE id = ?").bind(docId).first<{ visibility: string }>();
    expect(row?.visibility).toBe("internal");
  });
});

describe("GET /v1/shipments/:id/documents — lens-scoped list", () => {
  it("a portal party sees ONLY the counterparty doc, never the internal one", async () => {
    const res = await listDocs(SHP_MIX, await portalTok(DOCS_PARTY));
    expect(res.status).toBe(200);
    const ids = new Set(res.documents.map((d) => d.id as string));
    expect(ids.has(cpDocId)).toBe(true);
    expect(ids.has(intDocId)).toBe(false);
    // and every row the party sees is non-internal
    for (const d of res.documents) expect(d.visibility).not.toBe("internal");
  });

  it("ops (tenant lens) sees BOTH the counterparty and the internal doc", async () => {
    const res = await listDocs(SHP_MIX, await opsTok());
    expect(res.status).toBe(200);
    const ids = new Set(res.documents.map((d) => d.id as string));
    expect(ids.has(cpDocId)).toBe(true);
    expect(ids.has(intDocId)).toBe(true);
  });

  it("a portal party NOT on the shipment gets an empty list (fail-closed shipment scope)", async () => {
    const res = await listDocs(SHP_MIX, await portalTok("docs-party-stranger"));
    expect(res.status).toBe(200);
    expect(res.documents).toEqual([]);
  });
});

describe("GET /v1/documents/:id/url — lens-gated signed download URL", () => {
  it("a portal party gets a URL for a counterparty doc it can see, and the URL streams the exact bytes", async () => {
    const res = await docUrl(cpDocId, await portalTok(DOCS_PARTY));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const url = res.json?.url as string;
    expect(typeof url).toBe("string");
    expect(url.startsWith("/pub/documents/")).toBe(true);

    // the public proxy the URL points at streams the exact stored bytes (no auth header — the cap is the gate)
    const dl = await SELF.fetch(`https://api.local${url}`);
    expect(dl.status).toBe(200);
    const got = new Uint8Array(await dl.arrayBuffer());
    expect(got.byteLength).toBe(cpBytes.byteLength);
    expect(await sha256Hex(got)).toBe(cpBytesHash);
  });

  it("a portal party requesting a URL for an INTERNAL doc → 404 (fail-closed, no existence oracle)", async () => {
    const res = await docUrl(intDocId, await portalTok(DOCS_PARTY));
    expect(res.status).toBe(404);
    expect(res.json?.url).toBeUndefined();
  });

  it("a portal party NOT on the shipment cannot get a URL even for a counterparty doc → 404", async () => {
    const res = await docUrl(cpDocId, await portalTok("docs-party-stranger"));
    expect(res.status).toBe(404);
  });

  it("ops (tenant lens) gets a URL for any in-tenant doc, including the internal one", async () => {
    const res = await docUrl(intDocId, await opsTok());
    expect(res.status).toBe(200);
    expect((res.json?.url as string).startsWith("/pub/documents/")).toBe(true);
  });

  it("a nonexistent document id → 404", async () => {
    const res = await docUrl("no-such-doc", await opsTok());
    expect(res.status).toBe(404);
  });

  it("a portal session WITHOUT a party_id is 403, not 500 — the lens translation is REACHABLE (audit §377)", async () => {
    // Sibling of the invoices case. `party_id` is optional in SessionClaims and unenforced by the auth
    // middleware, so a portal token without it is valid and `lensFor` throws `LENS_UNRESOLVED` here for
    // real. `toLensError` is what makes that a 403 instead of a 500; mutating it left 760 tests green.
    //
    // Asserted on the DOCUMENT-URL route specifically because this file's other 403s and 404s come from
    // the lens GATES (internal visibility, shipment scope) — a status alone would not say which fired, so
    // the message is the discriminator, per §82's authoring rule.
    const t = await token({ sub: "docs-noparty", tenant: TENANT, role: "portal" });
    const res = await docUrl(intDocId, t);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.json)).toContain("SESSION LENS UNRESOLVED");
  });
});

describe("GET /pub/documents/:cap — public bytes proxy fail-closed", () => {
  it("a garbage cap → 404 (uniform, no oracle)", async () => {
    const res = await SELF.fetch("https://api.local/pub/documents/not-a-real-cap");
    expect(res.status).toBe(404);
  });
});

// THE CAP IS THE WHOLE GATE (audit §458). `/pub/documents/:cap` is mounted OUTSIDE `/v1/*`, so the auth
// middleware never runs — routes/documents.ts says so in as many words: "the cap IS the authorization, and
// verifyDocDownloadCap is the whole gate." Before this describe, the ONLY negative test was a garbage
// string, which fails at PARSE. Nothing exercised a well-formed cap that should still be refused, and
// `doc-cap.ts` had zero test references of any kind.
//
// The four properties below are the ones a bearer capability actually rests on. Each is a token that PARSES
// — the attack is never a malformed string, it is a valid-looking one.
describe("verifyDocDownloadCap — a well-formed cap that must still be refused (REQ-085, audit §458)", () => {
  const SECRET = "test-jwt-secret-for-doc-caps";
  const future = (): number => Math.floor(Date.now() / 1000) + 600;

  it("round-trips: a freshly minted cap yields back its tenant + key (the positive control)", async () => {
    const cap = await mintDocDownloadCap(SECRET, { t: "tenant-a", k: "evidence/tenant-a/shp/abc", expSeconds: future() });
    await expect(verifyDocDownloadCap(cap, SECRET)).resolves.toEqual({ t: "tenant-a", k: "evidence/tenant-a/shp/abc" });
  });

  it("a TAMPERED payload is refused — editing `k` to another document breaks the MAC", async () => {
    // The real attack: a party holds a legitimate cap for its OWN document and rewrites the object key to
    // point at someone else's. The claim is that `k` lives INSIDE the MAC; this is what proves it.
    const cap = await mintDocDownloadCap(SECRET, { t: "tenant-a", k: "evidence/tenant-a/shp/mine", expSeconds: future() });
    const forged = tamperClaim(cap, { k: "evidence/tenant-b/shp/theirs" });
    await expect(verifyDocDownloadCap(forged, SECRET)).rejects.toBeInstanceOf(DocCapError);
    // the tenant claim is inside the MAC on the same terms — pub-status pins both axes, so this one does too
    await expect(verifyDocDownloadCap(tamperClaim(cap, { t: "tenant-b" }), SECRET)).rejects.toBeInstanceOf(DocCapError);
  });

  it("an EXPIRED cap is refused — the expiry is inside the MAC, not advisory", async () => {
    const cap = await mintDocDownloadCap(SECRET, { t: "tenant-a", k: "evidence/tenant-a/shp/abc", expSeconds: Math.floor(Date.now() / 1000) - 5 });
    await expect(verifyDocDownloadCap(cap, SECRET)).rejects.toBeInstanceOf(DocCapError);
  });

  it("a cap minted under a DIFFERENT secret is refused — no cross-environment replay", async () => {
    const cap = await mintDocDownloadCap("some-other-deployments-secret", { t: "tenant-a", k: "evidence/tenant-a/shp/abc", expSeconds: future() });
    await expect(verifyDocDownloadCap(cap, SECRET)).rejects.toBeInstanceOf(DocCapError);
  });

  it("a SESSION token is not a doc cap — the domain separation is real, not documented", async () => {
    // doc-cap.ts claims the cap secret is "cryptographically DISJOINT from JWT_SECRET (the session secret),
    // so a session JWT can never verify as a doc cap". A session JWT is signed with JWT_SECRET ITSELF; the
    // cap secret is HMAC(JWT_SECRET, DOMAIN). Nothing tested that the two cannot be interchanged.
    const sessionish = await sign({ sub: "u-ops", tenant: "tenant-a", role: "ops", exp: future() }, SECRET, "HS256");
    await expect(verifyDocDownloadCap(sessionish, SECRET)).rejects.toBeInstanceOf(DocCapError);
  });

  // REQ-085 §660 — THE CAP-TO-CAP PAIR, which the session-to-cap test above does not reach.
  //
  // §659 mutated the doc cap's domain separation and found it defended three ways. Its reopen trigger asked
  // the completeness question: three token types make SIX ordered cross-type pairs, and only ONE
  // (session → doc) was tested. The pair that matters most is cap ↔ cap, because BOTH are unauthenticated —
  // §613 established that /pub/* deliberately escapes session auth. A status cap (view a shipment's status)
  // verifying as a doc cap (download its evidence bytes) is a privilege escalation between two anonymous
  // surfaces, with no session involved on either side.
  //
  // Separation exists by construction — the domains differ (`shuddl-status-cap-v1` vs
  // `shuddl-doc-download-v1`), so the derived secrets and the `typ` literals both differ. Nothing asserted it.
  it("a STATUS cap is not a doc cap — the two unauthenticated surfaces do not interchange", async () => {
    const statusCap = await mintStatusCap(SECRET, { t: "tenant-a", s: "shp-1", expSeconds: future() });
    await expect(verifyDocDownloadCap(statusCap, SECRET)).rejects.toBeInstanceOf(DocCapError);
  });

  it("a DOC cap is not a status cap — the refusal is symmetric, not one-directional", async () => {
    // Asserted separately because the two derivations are independent code paths: a shared-secret bug on one
    // side would not necessarily appear on the other, and a one-directional test would find only half of it.
    const docCap = await mintDocDownloadCap(SECRET, { t: "tenant-a", k: "evidence/tenant-a/shp/abc", expSeconds: future() });
    await expect(verifyStatusCap(docCap, SECRET)).rejects.toBeInstanceOf(StatusCapError);
  });

  it("a token signed with the DERIVED secret but the wrong `typ` is refused — the strict parse is the second layer", async () => {
    // THE TEST ABOVE DOES NOT COVER THIS, and the mutation is what showed it: deleting the `.strict()` parse
    // entirely left all 18 tests GREEN, because a session JWT is signed with JWT_SECRET itself and dies at the
    // MAC before `typ` is ever read. The strict parse only bites on a token that ALREADY has a valid MAC —
    // i.e. anything else that ever signs under the doc secret. Nothing does today, so this is defence in
    // depth (§389 "nothing reaches it"), and it is pinned here so it cannot be removed as dead weight.
    const derived = await deriveDocSecret(SECRET);
    const wrongTyp = await sign({ typ: "status-cap", t: "tenant-a", k: "evidence/tenant-a/shp/abc", exp: future() }, derived, "HS256");
    await expect(verifyDocDownloadCap(wrongTyp, SECRET)).rejects.toBeInstanceOf(DocCapError);
  });
});
