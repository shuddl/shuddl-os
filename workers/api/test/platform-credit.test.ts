import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { PLATFORM_TENANT_ID } from "@shuddl/contracts";
import { ensureSchema, ensureTenantBSchema, ensureTenantPlaneSchema, retryOnDoInvalidation } from "./helpers.js";
import { resolvePlatformTenantDb } from "../src/tenants.js";
import type { SeqStub } from "../src/routes/events.js";
import app from "../src/index.js";
import type { Env } from "../src/index.js";

// WP-14 Task 10 (REQ-123/025/003/030) — the WRITE-PATH proof that the REAL sequencer resolves the reserved
// `_platform` tenant and lands credit MONEY EVENTS there, PROJECTED (never a direct money_lines write), with:
//   · finding C — a `_platform` credit invoice.issued (no POD) is ACCEPTED; a CUSTOMER invoice.issued with no
//     pod.signed is STILL GATE_BLOCKed (the exemption is narrow — the customer I2 gate is unchanged).
//   · finding D — the `_platform` invoice.issued/payment.received events are `internal`, never `counterparty`.
//   · ISOLATION (REQ-025) — a customer/claimed append can NEVER reach `_platform`: the customer resolver rejects
//     it, and the `platform: true` door refuses any non-platform tenant. Credit events land ONLY on the platform D1.
//   · the INTERNAL route — DARK without the shared secret (503), authorized with it, refused on a bad secret.
// This is the api-harness half of the billing swap (finding B): the billing worker routes through THIS path.

const PLATFORM_INTERNAL_SECRET = "test-platform-internal-secret";
const GL_CREDITS_AR = "4300-PLATFORM-CREDITS-AR";

// env with the internal secret bound (own-prop over the real env prototype, mirrors signup.test.ts onEnv), so the
// internal route is AUTHORIZED under app.fetch. The DARK default (no secret) is proven through SELF.fetch.
const secretEnv: Env = Object.assign(Object.create(env) as Env, { PLATFORM_INTERNAL_SECRET });

function platform(): D1Database {
  return resolvePlatformTenantDb(env);
}

let n = 0;
function creditIds(): { invoiceId: string; shipmentId: string; streamId: string } {
  n += 1;
  const shipmentId = `credit-t10-${n}-${Date.now()}`;
  return { invoiceId: `credit_${n}_${Date.now()}`, shipmentId, streamId: `s:${shipmentId}` };
}

// The credit-pack SALE event (mirrors workers/billing/src/credits.ts emitCreditPurchase's EventInput exactly).
function creditInvoiceInput(o: { invoiceId: string; shipmentId: string; party: string; cents: number }): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: o.shipmentId,
    ts: Date.now(),
    actor: { party: "agent:billing" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "invoice.issued",
    payload: {
      invoice_id: o.invoiceId,
      party_id: o.party, // the buyer tenant is the AR party on the platform ledger
      division: "platform",
      lines: [{ line_no: 1, kind: "credit_purchase", amount_cents: o.cents, gl_map: GL_CREDITS_AR }],
    },
  };
}
// The settlement event (method 'stripe' → the money projection posts NO line, only the AR settle flip).
function creditPaymentInput(o: { invoiceId: string; shipmentId: string; party: string; cents: number }): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: o.shipmentId,
    ts: Date.now(),
    actor: { party: "agent:billing" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "payment.received",
    payload: { invoice_id: o.invoiceId, amount_cents: o.cents, method: "stripe", party_id: o.party },
  };
}

// A CUSTOMER invoice.issued (freight) on a fresh stream with NO pod.signed — must STILL be POD-gated.
function customerInvoiceInput(shipmentId: string): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: Date.now(),
    actor: { party: "agent:biller" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "invoice.issued",
    payload: {
      invoice_id: `inv-${shipmentId}`,
      party_id: "party-bill-to",
      division: "brokerage",
      lines: [{ line_no: 1, kind: "freight", amount_cents: 120_000, gl_map: "4000-REV" }],
    },
  };
}

function stubFor(tenant: string, streamId: string): SeqStub {
  return env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${tenant}|${streamId}`)) as unknown as SeqStub;
}
async function appendPlatform(streamId: string, input: Record<string, unknown>): Promise<{ id: string; visibility: string }> {
  return retryOnDoInvalidation(async () => {
    const ev = await stubFor(PLATFORM_TENANT_ID, streamId).append({ tenant: PLATFORM_TENANT_ID, streamId, input, platform: true });
    return { id: ev.id, visibility: ev.visibility };
  });
}

beforeAll(async () => {
  await ensureSchema(env); // control plane + tenant-a (+ its parties, incl. party-bill-to)
  await ensureTenantBSchema(env);
  // The reserved platform tenant's OWN D1 carries the SAME ledger schema (events + money_lines + invoices), where
  // the credit money events land. Idempotent (skips if `events` already exists on the shared, isolation-off D1).
  await ensureTenantPlaneSchema(platform());
});

describe("finding C — a _platform credit invoice.issued (NO POD) is ACCEPTED through the real sequencer", () => {
  it("appends the credit invoice.issued + projects a credit_purchase AR money line (no POD required)", async () => {
    const { invoiceId, shipmentId, streamId } = creditIds();
    const appended = await appendPlatform(streamId, creditInvoiceInput({ invoiceId, shipmentId, party: "tenant-a", cents: 500_00 }));
    expect(appended.id).toBeTruthy(); // did NOT GATE_BLOCK on the missing pod.signed

    // The money_lines row is PROJECTED from the event (its event_id points back at it) — never a direct write (I1/REQ-003).
    const line = await platform()
      .prepare("SELECT event_id, kind, direction, amount_cents, party_id, gl_map FROM money_lines WHERE event_id = ?")
      .bind(appended.id)
      .first<{ event_id: string; kind: string; direction: string; amount_cents: number; party_id: string; gl_map: string }>();
    expect(line).not.toBeNull();
    expect(line!.kind).toBe("credit_purchase");
    expect(line!.direction).toBe("ar");
    expect(line!.amount_cents).toBe(500_00);
    expect(line!.party_id).toBe("tenant-a");
    expect(line!.gl_map).toBe(GL_CREDITS_AR);

    // The invoices projection row exists and totals the pack; still 'issued' until a covering payment settles it.
    const inv = await platform().prepare("SELECT status, total_cents FROM invoices WHERE id = ?").bind(invoiceId).first<{ status: string; total_cents: number }>();
    expect(inv).not.toBeNull();
    expect(inv!.total_cents).toBe(500_00);
    expect(inv!.status).toBe("issued");
  });

  it("a covering payment.received settles the credit invoice to paid (in-batch, in-order)", async () => {
    const { invoiceId, shipmentId, streamId } = creditIds();
    await appendPlatform(streamId, creditInvoiceInput({ invoiceId, shipmentId, party: "tenant-a", cents: 750_00 }));
    await appendPlatform(streamId, creditPaymentInput({ invoiceId, shipmentId, party: "tenant-a", cents: 750_00 }));

    const inv = await platform().prepare("SELECT status FROM invoices WHERE id = ?").bind(invoiceId).first<{ status: string }>();
    expect(inv!.status).toBe("paid");
    // method 'stripe' posts NO extra money line — credit_purchase stays the ONLY line on this stream.
    const ml = await platform().prepare("SELECT COUNT(*) AS n FROM money_lines WHERE event_id IN (SELECT id FROM events WHERE stream_id = ?)").bind(streamId).first<{ n: number }>();
    expect(ml!.n).toBe(1);
  });

  it("idempotent: re-appending the SAME credit invoice event (same id) does not double-project", async () => {
    const { invoiceId, shipmentId, streamId } = creditIds();
    const input = creditInvoiceInput({ invoiceId, shipmentId, party: "tenant-b", cents: 300_00 });
    const a = await appendPlatform(streamId, input);
    const b = await appendPlatform(streamId, input); // redelivery — same event id
    expect(b.id).toBe(a.id);
    const cnt = await platform().prepare("SELECT COUNT(*) AS n FROM money_lines WHERE event_id = ?").bind(a.id).first<{ n: number }>();
    expect(cnt!.n).toBe(1); // once out
  });
});

describe("finding C is NARROW — a CUSTOMER invoice.issued with no pod.signed is STILL POD-gated (I2 unchanged)", () => {
  it("a tenant-a invoice.issued on a POD-less stream GATE_BLOCKs (required_evidence pod.signed)", async () => {
    const streamId = `s:cust-nopod-${Date.now()}`;
    const stub = stubFor("tenant-a", streamId);
    await expect(
      retryOnDoInvalidation(() => stub.append({ tenant: "tenant-a", streamId, input: customerInvoiceInput(`cust-nopod-${Date.now()}`) })),
    ).rejects.toThrow(/GATE_BLOCKED[\s\S]*pod\.signed/);
    // Nothing was appended (append-on-block is impossible).
    const cnt = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS n FROM events WHERE stream_id = ?").bind(streamId).first<{ n: number }>();
    expect(cnt!.n).toBe(0);
  });
});

describe("finding D — _platform credit money events are INTERNAL visibility, never counterparty", () => {
  it("the invoice.issued AND payment.received both stamp visibility='internal'", async () => {
    const { invoiceId, shipmentId, streamId } = creditIds();
    const inv = await appendPlatform(streamId, creditInvoiceInput({ invoiceId, shipmentId, party: "tenant-a", cents: 500_00 }));
    const pay = await appendPlatform(streamId, creditPaymentInput({ invoiceId, shipmentId, party: "tenant-a", cents: 500_00 }));
    expect(inv.visibility).toBe("internal");
    expect(pay.visibility).toBe("internal");
    // …and the stored rows agree (the shared resolver defaults these kinds to counterparty; the clamp wins).
    const rows = await platform().prepare("SELECT kind, visibility FROM events WHERE stream_id = ? ORDER BY seq").bind(streamId).all<{ kind: string; visibility: string }>();
    // Pin the population before asserting over it (audit §180): two appends → exactly two rows. Without
    // this the loop is vacuous — a seeding change that stored nothing would keep this DB-level
    // confirmation green while confirming nothing.
    expect(rows.results).toHaveLength(2);
    for (const r of rows.results) expect(r.visibility).toBe("internal");
  });
});

describe("ISOLATION (REQ-025) — a customer/claimed append can NEVER reach _platform", () => {
  it("driving the DO for _platform WITHOUT platform:true is FORBIDDEN (customer resolver rejects _platform)", async () => {
    const streamId = `s:credit-forbid-${Date.now()}`;
    const stub = stubFor(PLATFORM_TENANT_ID, streamId);
    await expect(
      retryOnDoInvalidation(() => stub.append({ tenant: PLATFORM_TENANT_ID, streamId, input: creditInvoiceInput({ invoiceId: "x", shipmentId: `credit-forbid-${Date.now()}`, party: "tenant-a", cents: 100 }) })),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  it("the platform:true door refuses a NON-platform tenant (the flag can never bind a customer slug)", async () => {
    const streamId = `s:not-platform-${Date.now()}`;
    const stub = stubFor("tenant-a", streamId);
    await expect(
      retryOnDoInvalidation(() => stub.append({ tenant: "tenant-a", streamId, input: creditInvoiceInput({ invoiceId: "x", shipmentId: `not-platform-${Date.now()}`, party: "tenant-a", cents: 100 }), platform: true })),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  it("credit events land ONLY on the platform D1 — no customer tenant D1 carries a credit_purchase line", async () => {
    const { invoiceId, shipmentId, streamId } = creditIds();
    await appendPlatform(streamId, creditInvoiceInput({ invoiceId, shipmentId, party: "tenant-a", cents: 500_00 }));
    for (const db of [env.TENANT_A_DB, env.TENANT_B_DB]) {
      const ml = await db.prepare("SELECT COUNT(*) AS n FROM money_lines WHERE kind = 'credit_purchase'").first<{ n: number }>();
      expect(ml?.n ?? 0).toBe(0);
    }
    expect((await platform().prepare("SELECT COUNT(*) AS n FROM money_lines WHERE kind='credit_purchase'").first<{ n: number }>())!.n).toBeGreaterThan(0);
  });
});

describe("the INTERNAL platform route — DARK without the secret, authorized with it, refused on a bad secret", () => {
  function appendReq(streamId: string, input: Record<string, unknown>, header?: string): Request {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (header !== undefined) headers["X-Platform-Internal"] = header;
    return new Request("https://api.local/internal/platform/credit-append", { method: "POST", headers, body: JSON.stringify({ streamId, input }) });
  }

  it("DARK — no PLATFORM_INTERNAL_SECRET bound on the real worker ⇒ 503, nothing appended (SELF.fetch)", async () => {
    const { invoiceId, shipmentId, streamId } = creditIds();
    const res = await SELF.fetch(appendReq(streamId, creditInvoiceInput({ invoiceId, shipmentId, party: "tenant-a", cents: 500_00 }), PLATFORM_INTERNAL_SECRET));
    expect(res.status).toBe(503);
    const cnt = await platform().prepare("SELECT COUNT(*) AS n FROM events WHERE stream_id = ?").bind(streamId).first<{ n: number }>();
    expect(cnt!.n).toBe(0);
  });

  it("a WRONG X-Platform-Internal header ⇒ 403, nothing appended", async () => {
    const { invoiceId, shipmentId, streamId } = creditIds();
    const res = await app.fetch(appendReq(streamId, creditInvoiceInput({ invoiceId, shipmentId, party: "tenant-a", cents: 500_00 }), "wrong-secret"), secretEnv);
    expect(res.status).toBe(403);
    const cnt = await platform().prepare("SELECT COUNT(*) AS n FROM events WHERE stream_id = ?").bind(streamId).first<{ n: number }>();
    expect(cnt!.n).toBe(0);
  });

  it("with the secret + correct header ⇒ 200 {id}, and the credit event lands on the platform D1", async () => {
    const { invoiceId, shipmentId, streamId } = creditIds();
    const res = await app.fetch(appendReq(streamId, creditInvoiceInput({ invoiceId, shipmentId, party: "tenant-a", cents: 500_00 }), PLATFORM_INTERNAL_SECRET), secretEnv);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { id: string };
    expect(out.id).toBeTruthy();
    const line = await platform().prepare("SELECT kind FROM money_lines WHERE event_id = ?").bind(out.id).first<{ kind: string }>();
    expect(line!.kind).toBe("credit_purchase");

    // the settle route flips the invoice to paid once a covering payment.received is committed
    const payRes = await app.fetch(
      new Request("https://api.local/internal/platform/credit-append", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Platform-Internal": PLATFORM_INTERNAL_SECRET },
        body: JSON.stringify({ streamId, input: creditPaymentInput({ invoiceId, shipmentId, party: "tenant-a", cents: 500_00 }) }),
      }),
      secretEnv,
    );
    expect(payRes.status).toBe(200);
    const payId = ((await payRes.json()) as { id: string }).id;

    const settleRes = await app.fetch(
      new Request("https://api.local/internal/platform/credit-settle", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Platform-Internal": PLATFORM_INTERNAL_SECRET },
        body: JSON.stringify({ invoiceId, paymentEventId: payId, amountCents: 500_00 }),
      }),
      secretEnv,
    );
    expect(settleRes.status).toBe(200);
    const inv = await platform().prepare("SELECT status FROM invoices WHERE id = ?").bind(invoiceId).first<{ status: string }>();
    expect(inv!.status).toBe("paid");
  });

  // WP-15 Task 4b (REQ-021/030) — the SECOND append seam FORCES source:'native' too (defense-in-depth I1). A
  // forged `source:'legacy'` on this internal body is COERCED, so the credit event lands as a REAL native money
  // projection — never a gate-exempt / projection-skipped legacy shadow on the revenue tenant. (Not reachable
  // today: secret-gated, and billing/credits.ts hardcodes native — this closes the latent hole structurally.)
  it("COERCES a forged source:'legacy' on the credit-append body to native (the event lands source='native' AND projects a money_line)", async () => {
    const { invoiceId, shipmentId, streamId } = creditIds();
    const forged = { ...creditInvoiceInput({ invoiceId, shipmentId, party: "tenant-a", cents: 500_00 }), source: "legacy" };
    const res = await app.fetch(appendReq(streamId, forged, PLATFORM_INTERNAL_SECRET), secretEnv);
    expect(res.status).toBe(200);
    const id = ((await res.json()) as { id: string }).id;
    // source was coerced to native (not the forged legacy):
    const row = await platform().prepare("SELECT source FROM events WHERE id = ?").bind(id).first<{ source: string }>();
    expect(row!.source).toBe("native");
    // and BECAUSE it is native, it PROJECTED a credit money_line — a legacy shadow would have skipped projections
    // (this money_line's presence is what a non-coerced legacy source would have made vanish → the I1 RED signal).
    const line = await platform().prepare("SELECT kind FROM money_lines WHERE event_id = ?").bind(id).first<{ kind: string }>();
    expect(line!.kind).toBe("credit_purchase");
  });
});

// REQ-031/123 §500 — the credit-settle route states THREE guarantees in its own comments and, until now,
// asserted none of them.
//
// `POST /internal/platform/credit-settle` is the re-runnable AR catch-up: it flips a credit invoice
// issued→paid ONLY when a covering `payment.received` is already committed. Its whole safety is one WHERE
// clause — `WHERE id = ? AND status = 'issued' AND total_cents <= ?`.
//
// MEASURED (audit §500): neutering the coverage half of that clause so it is always satisfied left ALL 782
// api tests GREEN. A $1 payment could mark a $750 invoice paid and nothing in the build would notice. The
// happy path was covered; the guard was not — which is the difference between testing that a money route
// works and testing that it refuses.
describe("REQ-031 §500: credit-settle refuses what it must, and repeats harmlessly", () => {
  function appendReq(streamId: string, input: Record<string, unknown>): Request {
    return new Request("https://api.local/internal/platform/credit-append", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Platform-Internal": PLATFORM_INTERNAL_SECRET },
      body: JSON.stringify({ streamId, input }),
    });
  }
  function settleReq(body: Record<string, unknown>): Request {
    return new Request("https://api.local/internal/platform/credit-settle", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Platform-Internal": PLATFORM_INTERNAL_SECRET },
      body: JSON.stringify(body),
    });
  }
  const statusOf = async (invoiceId: string) =>
    (await platform().prepare("SELECT status FROM invoices WHERE id = ?").bind(invoiceId).first<{ status: string }>())?.status;

  /** An issued credit invoice for `cents`, with a committed covering payment event. Returns both ids. */
  async function issuedWithPayment(cents: number): Promise<{ invoiceId: string; payId: string }> {
    const { invoiceId, shipmentId, streamId } = creditIds();
    await app.fetch(appendReq(streamId, creditInvoiceInput({ invoiceId, shipmentId, party: "tenant-a", cents })), secretEnv);
    const payRes = await app.fetch(
      appendReq(streamId, creditPaymentInput({ invoiceId, shipmentId, party: "tenant-a", cents })),
      secretEnv,
    );
    return { invoiceId, payId: ((await payRes.json()) as { id: string }).id };
  }

  it("an UNDER-COVERING payment does NOT settle — the clause a mutation proved nothing watched", async () => {
    const { invoiceId, payId } = await issuedWithPayment(750_00);
    // The invoice is settled in-batch by the covering payment append, so re-issue a fresh unpaid one to
    // isolate the ROUTE's own guard rather than the projection's.
    const { invoiceId: freshId, shipmentId, streamId } = creditIds();
    await app.fetch(appendReq(streamId, creditInvoiceInput({ invoiceId: freshId, shipmentId, party: "tenant-b", cents: 750_00 })), secretEnv);
    expect(await statusOf(freshId), "precondition: the fresh invoice is unpaid").toBe("issued");

    const res = await app.fetch(settleReq({ invoiceId: freshId, paymentEventId: payId, amountCents: 1_00 }), secretEnv);
    expect(res.status).toBe(200);
    expect((await res.json()) as { settled: boolean }).toMatchObject({ settled: false });
    expect(await statusOf(freshId), "$1 must never settle a $750 invoice").toBe("issued");
    expect(await statusOf(invoiceId), "and the covering invoice is untouched by this call").toBe("paid");
  });

  it("no backing payment.received ⇒ settled:false and NOTHING is written (fail-closed)", async () => {
    const { invoiceId, shipmentId, streamId } = creditIds();
    await app.fetch(appendReq(streamId, creditInvoiceInput({ invoiceId, shipmentId, party: "tenant-a", cents: 200_00 })), secretEnv);
    const res = await app.fetch(settleReq({ invoiceId, paymentEventId: "evt-does-not-exist", amountCents: 200_00 }), secretEnv);
    expect(res.status).toBe(200);
    expect((await res.json()) as { settled: boolean }).toMatchObject({ settled: false });
    expect(await statusOf(invoiceId)).toBe("issued");
  });

  it("a SECOND settle is a no-op — the route's 'idempotent (a no-op once paid)' claim", async () => {
    const { invoiceId, payId } = await issuedWithPayment(400_00);
    expect(await statusOf(invoiceId)).toBe("paid");
    const again = await app.fetch(settleReq({ invoiceId, paymentEventId: payId, amountCents: 400_00 }), secretEnv);
    expect(again.status).toBe(200);
    // `settled:false` because the compare-and-set found no row in 'issued' — the repeat changed nothing.
    expect((await again.json()) as { settled: boolean }).toMatchObject({ settled: false });
    expect(await statusOf(invoiceId)).toBe("paid");
  });
});
