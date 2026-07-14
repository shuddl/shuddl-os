// tools/deploy/staging-smoke.ts — DEPLOYMENT SMOKE TEST (REQ-031 / REQ-046 / REQ-003 / I1).
//
// Proves the POD → invoice chain runs on LIVE, deployed Cloudflare staging infra: real per-tenant D1,
// the real cross-script sequencer Durable Object, the real Cloudflare Queue, and the deployed Biller
// consumer (shuddl-agents-staging). It drives ONE synthetic shipment end to end over HTTPS through the
// deployed api, then confirms the queue-triggered Biller wrote a penny-exact invoice.issued into the
// real tenant D1.
//
// This is a TEST HARNESS, not ledger code: the shipment id uses a plain random suffix, the fixed test
// P-256 keypair and rate config are copied verbatim from workers/api/test/helpers.ts, and JWTs are
// minted with the staging secret. Everything here is SYNTHETIC and REQ-167-clean (no real names).
//
// Run:  pnpm exec tsx tools/deploy/staging-smoke.ts
//
// The signed-capture path is REUSED from the workspace (packages/driver-core `capture`, which co-signs
// with @shuddl/ledger `signEvent` over the canonical bytes) — signing is NEVER hand-rolled here, so the
// deployed sequencer verifies these events exactly as it verifies a real driver PWA's.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { capture, type CaptureParams, type DeviceContext, type EvidenceField } from "../../packages/driver-core/src/capture.js";
import type { EventKind } from "@shuddl/contracts";

// ── deployed environment ─────────────────────────────────────────────────────────────────────────────
const BASE = "https://shuddl-api-staging.spencer-896.workers.dev";
const CONTROL_DB = "shuddl-control-staging";
const TENANT_DB = "shuddl-t-tenant-a-staging";
const TENANT_SLUG = "tenant-a";
const CONTROL_TENANT_ID = "t-a";
const DRIVER_USER = "u-driver";
const SECRET_PATH =
  "/private/tmp/claude-501/-Users-spencerpro-Desktop-shuddl-os/cc650534-111c-459e-a308-3069e051a4e2/scratchpad/staging-jwt.txt";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = join(HERE, "..", "..", "workers", "api"); // wrangler runs from workers/api (its wrangler.toml)
const TMP = dirname(SECRET_PATH); // scratchpad — for the generated seed .sql files

// ── the FIXED test device (copied from workers/api/test/helpers.ts — synthetic, deterministic) ────────
const TEST_DEVICE_ID = "device-1";
const TEST_DEVICE_PUBLIC_JWK: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "4Fiu7RC9gvD7wbSkV3sumOCBU1nnrBZWXll4jomr5cE",
  y: "1A4Zv77d-4yA-I4X-o3PbE6YO5ryjzRGEll1cvmF0xI",
};
const TEST_DEVICE_PRIVATE_JWK: JsonWebKey = { ...TEST_DEVICE_PUBLIC_JWK, d: "AVHaqhOOSQmgexOvGC6DN4bBPQ_6kJHVVo5hcT4_a34" };

// The seeded delivery fence + an INSIDE stamp + the CA consent doc (copied from helpers.ts).
const FENCE_CENTER = { lat_e6: 37_421_000, lon_e6: -122_084_000 };
const INSIDE = { lat_e6: 37_421_000, lon_e6: -122_084_000, accuracy_m: 5 };
const CONSENT = { doc_kind: "consent", policy_version: "v1", operating_state: "CA", acknowledged: true } as const;

// TEST_RATE_CONFIG (copied from helpers.ts) — the 4 rating-config rows. dest "800xx" → Z5 → rg-far.
const TEST_RATE_CONFIG = {
  zone_tariff: {
    kind: "zone_tariff",
    id: "zt-test",
    version: "v1",
    zip_to_zone: { "800": "Z5", "970": "Z1" },
    rate_groups: [
      { id: "rg-near", zones: ["Z1"], breaks: [{ min_lb: 0, cwt_cents: 3800 }, { min_lb: 500, cwt_cents: 3200 }], min_charge_cents: 9500 },
      { id: "rg-far", zones: ["Z5"], breaks: [{ min_lb: 0, cwt_cents: 5200 }, { min_lb: 500, cwt_cents: 4500 }], min_charge_cents: 11500 },
    ],
  },
  floors: { kind: "floors", id: "fl-test", version: "v1", target_or_bps: 9800, full_cost_bps: 9200, contribution_bps: 8500 },
  fsc: { kind: "fsc", id: "fsc-test", version: "v1", pct_bps: 2400 },
  accessorials: { kind: "accessorials", id: "acc-test", version: "v1", items: { liftgate: 3500 } },
} as const;

// ── tiny assert / log ─────────────────────────────────────────────────────────────────────────────────
const failures: string[] = [];
function check(cond: boolean, msg: string): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures.push(msg);
}
function fatal(msg: string): never {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
}

// ── wrangler d1 (remote) plumbing ────────────────────────────────────────────────────────────────────
function wrangler(args: string[]): string {
  try {
    return execFileSync("npx", ["wrangler", ...args], { cwd: API_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    fatal(`wrangler ${args.join(" ")}\n${err.stderr ?? ""}${err.stdout ?? ""}${err.message ?? ""}`);
  }
}
function d1File(db: string, sqlPath: string): void {
  wrangler(["d1", "execute", db, "--remote", "--yes", "--file", sqlPath]);
}
type D1Row = Record<string, string | number | null>;
function d1Query(db: string, sql: string): D1Row[] {
  const out = wrangler(["d1", "execute", db, "--remote", "--yes", "--json", "--command", sql]);
  const start = out.indexOf("[");
  if (start < 0) fatal(`no JSON in wrangler output:\n${out}`);
  const parsed = JSON.parse(out.slice(start)) as { results: D1Row[] }[];
  return parsed[0]?.results ?? [];
}
const sq = (s: string): string => `'${s.replace(/'/g, "''")}'`; // single-quote a SQL string literal

// ── HS256 JWT (standard; hono/jwt `verify` on the deployed api accepts it — never a hand-rolled event sig) ─
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function signJwt(claims: Record<string, unknown>, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  const data = `${header}.${payload}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return `${data}.${b64url(sig)}`;
}
function token(claims: Record<string, unknown>, secret: string): Promise<string> {
  return signJwt({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims }, secret);
}

// ── HTTP append path (mirrors workers/api/test/helpers.ts `post`, against the LIVE url) ────────────────
interface Res {
  status: number;
  json: Record<string, unknown> | null;
}
async function postEvent(shipmentId: string, body: unknown, tok: string): Promise<Res> {
  const res = await fetch(`${BASE}/v1/shipments/${shipmentId}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// Deterministic 32-byte evidence pattern (mirrors helpers.nextEvidenceBytes) — self-consistent hash.
let evidenceCounter = 0;
function nextEvidenceBytes(): Uint8Array {
  const n = evidenceCounter++;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (n + i * 7 + 3) & 0xff;
  return bytes;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const secret = readFileSync(SECRET_PATH, "utf8");
  const shipmentId = `SMK-${Math.random().toString(36).slice(2, 8)}${Math.random().toString(36).slice(2, 6)}`;
  const streamId = `s:${shipmentId}`;
  console.log(`\n=== SHUDDL staging POD→invoice smoke ===`);
  console.log(`api:      ${BASE}`);
  console.log(`shipment: ${shipmentId}  (stream ${streamId})`);
  console.log(`jwt secret bytes: ${secret.length}\n`);

  // ── 1. SEED the remote control + tenant DBs via wrangler d1 execute --remote --file ──────────────────
  const deviceKeys = JSON.stringify([{ device_id: TEST_DEVICE_ID, public_jwk: TEST_DEVICE_PUBLIC_JWK }]);
  const controlSql = [
    `INSERT OR IGNORE INTO tenants (id,name,slug,plan,policy,created_ts) VALUES (${sq(CONTROL_TENANT_ID)},'Tenant A',${sq(TENANT_SLUG)},'pilot','{}',0);`,
    `INSERT OR IGNORE INTO users (id,tenant_id,email,role,auth,device_keys) VALUES (${sq(DRIVER_USER)},${sq(CONTROL_TENANT_ID)},'driver@tenant-a.test','driver','{}',${sq(deviceKeys)});`,
  ].join("\n");

  const parties: [string, string][] = [
    ["party-shipper", "shipper"],
    ["party-carrier", "carrier"],
    ["party-consignee", "consignee"],
    ["party-bill-to", "broker"],
    ["party-interline", "carrier"],
  ];
  const rateRows = [TEST_RATE_CONFIG.zone_tariff, TEST_RATE_CONFIG.floors, TEST_RATE_CONFIG.fsc, TEST_RATE_CONFIG.accessorials];
  const statusCache = JSON.stringify({ assigned_driver: DRIVER_USER });
  const legGeo = JSON.stringify(FENCE_CENTER);
  const tenantSql = [
    ...parties.map(([id, kind]) => `INSERT OR IGNORE INTO parties (id,kind,names) VALUES (${sq(id)},${sq(kind)},'{}');`),
    ...rateRows.map((p) => `INSERT OR REPLACE INTO rate_config (id,version,kind,payload,effective_ts,approved_by) VALUES (${sq(p.id)},1,${sq(p.kind)},${sq(JSON.stringify(p))},0,'seed');`),
    `INSERT INTO shipments (id,shipper_party_id,consignee_party_id,bill_to_party_id,status_cache,created_ts) VALUES (${sq(shipmentId)},'party-shipper','party-consignee','party-bill-to',${sq(statusCache)},0);`,
    `INSERT INTO legs (id,shipment_id,seq,kind,executor_party_id,geo) VALUES (${sq(`leg-${shipmentId}-0`)},${sq(shipmentId)},0,'delivery','party-carrier',${sq(legGeo)});`,
  ].join("\n");

  const controlPath = join(TMP, "smoke-seed-control.sql");
  const tenantPath = join(TMP, "smoke-seed-tenant.sql");
  writeFileSync(controlPath, controlSql);
  writeFileSync(tenantPath, tenantSql);
  console.log("seeding control DB (tenant t-a + driver u-driver + device-1)...");
  d1File(CONTROL_DB, controlPath);
  console.log("seeding tenant-a DB (5 parties + rate_config + shipment + delivery leg)...");
  d1File(TENANT_DB, tenantPath);

  // ── 2. MINT tokens. /v1/rate is server-gated to elevated roles (REQ-030), so pricing rides an ops
  //       token; the gated driver flow rides the driver token (sub u-driver) whose write-scope the
  //       seeded status_cache.assigned_driver satisfies. ─────────────────────────────────────────────
  const opsTok = await token({ sub: "u-smoke-ops", tenant: TENANT_SLUG, role: "ops" }, secret);
  const driverTok = await token({ sub: DRIVER_USER, tenant: TENANT_SLUG, role: "driver" }, secret);

  // health sanity (unauthenticated).
  const health = await fetch(`${BASE}/v1/health`).then((r) => r.json() as Promise<Record<string, unknown>>).catch(() => null);
  check(health?.ok === true, `GET /v1/health ok (env=${String(health?.env)})`);

  // ── 3a. PRICE — POST /v1/rate (records quote.priced + agent.acted on the stream). ────────────────────
  const rateRes = await fetch(`${BASE}/v1/rate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opsTok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify({ shipment_id: shipmentId, origin_zip: "97201", dest_zip: "80012", weight_lb: 1000, dims: { l_in: 48, w_in: 40, h_in: 48, pieces: 2 } }),
  });
  const rate = (await rateRes.json().catch(() => null)) as { status?: string; sell_cents?: number; lines?: { kind: string; amount_cents: number }[] } | null;
  if (rateRes.status !== 200 || rate?.status !== "PRICED" || typeof rate.sell_cents !== "number") {
    fatal(`POST /v1/rate did not price (status ${rateRes.status}): ${JSON.stringify(rate)}`);
  }
  const sellCents = rate.sell_cents;
  const quoteLineSum = (rate.lines ?? []).reduce((s, l) => s + l.amount_cents, 0);
  console.log(`\nquote PRICED: sell_cents=${sellCents}  lines=${JSON.stringify(rate.lines)}`);
  check(quoteLineSum === sellCents, `quote lines sum (${quoteLineSum}) === sell_cents (${sellCents})`);

  // ── 3b. GATED DRIVER FLOW — the minimal delivery sequence that clears every gate to a committed
  //        pod.signed + delivery.evidenced (mirrors workers/api/test/pod.test.ts happy path). Each event
  //        is hashed-at-capture + P-256 co-signed by device-1, POSTed with a fresh Idempotency-Key. ────
  const deviceCtx: DeviceContext = {
    device_id: TEST_DEVICE_ID,
    privateKey: await crypto.subtle.importKey("jwk", TEST_DEVICE_PRIVATE_JWK, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
    party: "party-carrier",
    nextSeq: (() => {
      let s = 0;
      return () => s++;
    })(),
  };
  let clock = Date.now();
  async function driveStep(kind: string, payload: Record<string, unknown>, evidenceField?: EvidenceField): Promise<{ res: Res; hash?: string }> {
    const ts = clock++;
    const params: CaptureParams = { shipment_id: shipmentId, kind: kind as EventKind, payload, ts, captured_ts: ts, actor_user: DRIVER_USER };
    if (evidenceField !== undefined) params.evidence = { bytes: nextEvidenceBytes(), field: evidenceField };
    const { event, deferred } = await capture(params, deviceCtx);
    const res = await postEvent(shipmentId, event, driverTok);
    if (res.status !== 201) fatal(`append ${kind} returned ${res.status} (expected 201): ${JSON.stringify(res.json)}`);
    console.log(`  append ${kind} -> ${res.status}`);
    return deferred ? { res, hash: deferred.hash } : { res };
  }

  console.log(`\ndriving the gated delivery flow as driver ${DRIVER_USER}...`);
  await driveStep("document.attached", { ...CONSENT }); // consent before any GPS stamp (INSIDE derives CA)
  await driveStep("stop.arrived", { geo: { ...INSIDE }, auto: false }); // arrival INSIDE the seeded fence
  const placed = await driveStep("freight.photographed", { photo_kind: "placed" }, "photo_hash"); // forced placed photo
  const signed = await driveStep("pod.signed", { geo: { ...INSIDE } }, "signature_hash"); // the Biller's trigger
  const podId = (signed.res.json as { id?: string }).id;
  check(typeof podId === "string" && podId.length > 0, `pod.signed committed with id ${podId}`);
  await driveStep("delivery.evidenced", { placed_photo_hash: placed.hash, geo: { ...INSIDE } }); // THE POD

  // ── 4. WAIT for the real Queue to deliver the pod.signed trigger to the deployed Biller, which
  //       appends invoice.issued THROUGH the cross-script sequencer DO. Poll the real tenant D1. ───────
  console.log(`\nwaiting for the queue-triggered Biller to write invoice.issued...`);
  let invoiceEventId: string | null = null;
  for (let i = 0; i < 12; i++) {
    await sleep(3000);
    const row = d1Query(TENANT_DB, `SELECT id FROM events WHERE stream_id=${sq(streamId)} AND kind='invoice.issued' LIMIT 1`);
    if (row.length > 0) {
      invoiceEventId = String(row[0]!.id);
      console.log(`  invoice.issued detected after ~${(i + 1) * 3}s: ${invoiceEventId}`);
      break;
    }
    console.log(`  ...not yet (${(i + 1) * 3}s)`);
  }

  // ── 5. QUERY the real tenant-a D1 and assert the causal chain + penny parity. ────────────────────────
  const chain = d1Query(TENANT_DB, `SELECT kind,seq FROM events WHERE stream_id=${sq(streamId)} ORDER BY seq`);
  console.log(`\nevent chain on ${streamId}:`);
  for (const e of chain) console.log(`  seq ${String(e.seq).padStart(2)}  ${e.kind}`);

  check(chain.some((e) => e.kind === "quote.priced"), "quote.priced is on the stream");
  check(chain.some((e) => e.kind === "pod.signed"), "pod.signed is on the stream");
  check(chain.some((e) => e.kind === "delivery.evidenced"), "delivery.evidenced (the POD) is on the stream");
  check(invoiceEventId !== null, "invoice.issued was written by the Biller onto the stream");

  if (invoiceEventId === null) {
    fatal("no invoice.issued after ~36s — the Biller HELD or the trigger was lost (see report).");
  }
  check(chain[chain.length - 1]?.kind === "invoice.issued", "invoice.issued is the LAST event (follows the POD)");

  const invoices = d1Query(TENANT_DB, `SELECT id,total_cents,status FROM invoices WHERE issued_event_id=${sq(invoiceEventId)}`);
  check(invoices.length === 1, `exactly one invoices row for this issue (${invoices.length})`);
  const inv = invoices[0]!;
  const totalCents = Number(inv.total_cents);
  console.log(`\ninvoice row: id=${inv.id} total_cents=${totalCents} status=${inv.status}`);
  check(inv.status === "issued", `invoice status === 'issued' (${inv.status})`);
  check(totalCents === sellCents, `invoice.total_cents (${totalCents}) === quote.sell_cents (${sellCents})`);

  const money = d1Query(TENANT_DB, `SELECT direction,kind,amount_cents FROM money_lines WHERE shipment_id=${sq(shipmentId)} ORDER BY line_no`);
  const moneySum = money.reduce((s, m) => s + Number(m.amount_cents), 0);
  console.log(`money_lines (${money.length}):`);
  for (const m of money) console.log(`  ${m.direction}  ${m.kind}  ${m.amount_cents}`);
  check(money.length > 0, "money_lines were projected");
  check(money.every((m) => m.direction === "ar"), "every money_line is AR (direction=ar)");
  check(moneySum === sellCents, `Σ money_lines (${moneySum}) === quote.sell_cents (${sellCents})`);

  const pennyParity = totalCents === sellCents && moneySum === sellCents && quoteLineSum === sellCents;
  console.log(`\n── PENNY PARITY: quote=${sellCents}  invoice=${totalCents}  Σmoney_lines=${moneySum}  → ${pennyParity ? "HELD" : "BROKEN"}`);

  console.log(`\n=== ${failures.length === 0 ? "SMOKE PASS ✅" : `SMOKE FAIL ❌ (${failures.length})`} ===`);
  console.log(`shipment=${shipmentId} quote.sell_cents=${sellCents} invoice.total_cents=${totalCents} status=${inv.status}`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  FAILED: ${f}`);
    process.exit(1);
  }
}

main().catch((e: unknown) => fatal(e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e)));
