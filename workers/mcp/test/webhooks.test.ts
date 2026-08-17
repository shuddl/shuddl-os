import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { StaticSecretResolver, NotConfiguredSecretResolver } from "../src/principal.js";
import {
  buildWebhookPayload,
  deliverWebhook,
  deliveryMarkerKey,
  KvDeliveryMarkers,
  NotConfiguredEventSource,
  NotConfiguredWebhookTransport,
  resolveWebhookSubscription,
  runWebhookSweep,
  signWebhook,
  verifyWebhook,
  webhookSubIdFor,
  type DeliveryMarkers,
  type TerminalEvent,
  type WebhookDeps,
  type WebhookSubscription,
  type WebhookTransport,
} from "../src/webhooks.js";
import { applyControl, seedPairing, seedTenant } from "./helpers.js";

// WP-13 Task 10 (REQ-109/192) — OUTBOUND SIGNED WEBHOOKS. Fully tested here: the subscription storage (a
// pairings kind='webhook' row), the signed-payload builder + signature + verification, the counterparty-safe
// projection (REQ-192), the FAIL-CLOSED gating (NotConfigured resolver / no subscription ⇒ nothing leaves), and
// the IDEMPOTENT deliver-once (the per-event marker). SCAFFOLDED (documented go-live): the LIVE ledger/queue
// event source — the mcp worker has no tenant-wide terminal-event read today (CONTROL_DB is auth-only, REQ-025),
// so runWebhookSweep is driven here with an INJECTED event source (a fake), and the production default
// (NotConfiguredEventSource) yields nothing (a safe no-op cron).

const TENANT_W = "t-wh";
const ORIGINATOR = "prn-mcp-wh-orig"; // the mcp pairing whose shipments the subscription is notified about
const ORIGINATOR_SUSPENDED = "prn-mcp-wh-susp";
const ORIGINATOR_MALFORMED = "prn-mcp-wh-bad";
const ORIGINATOR_NOSUB = "prn-mcp-wh-nosub"; // no subscription row at all
const SECRET_REF = "wh-secret-ref";
const SECRET = "whsec_test_do_not_use_in_prod";
const HOOK_URL = "https://receiver.example.test/hooks/shuddl";
const FIXED_NOW = 1_700_000_000_000; // ms — deterministic signature timestamp

function memMarkers(): { markers: DeliveryMarkers; set: Set<string> } {
  const set = new Set<string>();
  return { markers: { async has(k) { return set.has(k); }, async mark(k) { set.add(k); } }, set };
}
function recordingTransport(reply: { ok: boolean; status: number } = { ok: true, status: 200 }): { transport: WebhookTransport; calls: Array<{ url: string; headers: Record<string, string>; body: string }> } {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  return { transport: { async send(url, headers, body) { calls.push({ url, headers, body }); return reply; } }, calls };
}
function eventSourceOf(events: TerminalEvent[]): { recentTerminalEvents(): Promise<TerminalEvent[]> } {
  return { async recentTerminalEvents() { return events; } };
}

const SUB: WebhookSubscription = {
  id: webhookSubIdFor(ORIGINATOR),
  originatorPairingId: ORIGINATOR,
  tenantId: TENANT_W,
  url: HOOK_URL,
  secretRef: SECRET_REF,
  events: ["booking.created", "invoice.issued", "delivery.evidenced"],
};
const EVENT: TerminalEvent = { id: "evt-booking-1", kind: "booking.created", shipmentId: "shp_wh01", ts: 1_699_999_000_000, originatorPairing: ORIGINATOR };

function makeDeps(over: Partial<WebhookDeps>): WebhookDeps {
  return {
    secrets: new StaticSecretResolver({ [SECRET_REF]: SECRET }),
    transport: recordingTransport().transport,
    markers: memMarkers().markers,
    eventSource: eventSourceOf([]),
    resolveSubscription: async () => SUB,
    now: () => FIXED_NOW,
    ...over,
  };
}

beforeAll(async () => {
  await applyControl(env.CONTROL_DB);
  await seedTenant(env.CONTROL_DB, TENANT_W, "tenant-wh");
  // The subscription IS a pairings kind='webhook' row: id links the originator, secret_ref → signing secret,
  // caps JSON carries the delivery config { url, events? } (ADDITIVE — no new table, no new column).
  await seedPairing(env.CONTROL_DB, { id: webhookSubIdFor(ORIGINATOR), tenantId: TENANT_W, kind: "webhook", secretRef: SECRET_REF, caps: JSON.stringify({ url: HOOK_URL }) });
  await seedPairing(env.CONTROL_DB, { id: webhookSubIdFor(ORIGINATOR_SUSPENDED), tenantId: TENANT_W, kind: "webhook", secretRef: SECRET_REF, status: "suspended", caps: JSON.stringify({ url: HOOK_URL }) });
  await seedPairing(env.CONTROL_DB, { id: webhookSubIdFor(ORIGINATOR_MALFORMED), tenantId: TENANT_W, kind: "webhook", secretRef: SECRET_REF, caps: "{not json" });
  // The ORIGINATOR mcp pairings themselves — real provisioning always creates both rows, and resolution
  // now REQUIRES them to name the same tenant (2026-08-01 audit: a webhook row under another tenant would
  // otherwise route this tenant's milestones to it).
  for (const o of [ORIGINATOR, ORIGINATOR_SUSPENDED, ORIGINATOR_MALFORMED]) {
    await seedPairing(env.CONTROL_DB, { id: o, tenantId: TENANT_W, kind: "mcp", scopes: '["mcp"]', caps: "{}" });
  }
});

describe("svix-style HMAC signing + verification", () => {
  it("a built payload carries a signature the receiver verifies with the secret", async () => {
    const payload = buildWebhookPayload(EVENT);
    const signed = await signWebhook(SECRET, payload, EVENT.id, Math.floor(FIXED_NOW / 1000));
    expect(await verifyWebhook(SECRET, signed.headers, signed.body)).toBe(true);
  });

  it("a TAMPERED body fails verification", async () => {
    const signed = await signWebhook(SECRET, buildWebhookPayload(EVENT), EVENT.id, Math.floor(FIXED_NOW / 1000));
    const tampered = JSON.stringify({ ...JSON.parse(signed.body), shipment_id: "shp_ATTACKER" });
    expect(await verifyWebhook(SECRET, signed.headers, tampered)).toBe(false);
  });

  it("a TAMPERED signature header fails verification", async () => {
    const signed = await signWebhook(SECRET, buildWebhookPayload(EVENT), EVENT.id, Math.floor(FIXED_NOW / 1000));
    const bad = { ...signed.headers, "webhook-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" };
    expect(await verifyWebhook(SECRET, bad, signed.body)).toBe(false);
  });

  it("the WRONG secret fails verification (authenticity, not just integrity)", async () => {
    const signed = await signWebhook(SECRET, buildWebhookPayload(EVENT), EVENT.id, Math.floor(FIXED_NOW / 1000));
    expect(await verifyWebhook("whsec_a_different_secret", signed.headers, signed.body)).toBe(false);
  });

  it("a missing signature header fails verification (fail-closed)", async () => {
    const signed = await signWebhook(SECRET, buildWebhookPayload(EVENT), EVENT.id, Math.floor(FIXED_NOW / 1000));
    const noSig: Record<string, string> = { ...signed.headers };
    delete noSig["webhook-signature"];
    expect(await verifyWebhook(SECRET, noSig, signed.body)).toBe(false);
  });
});

describe("REQ-192 — the payload carries ONLY the counterparty-safe projection", () => {
  it("the payload keys are exactly {id,type,shipment_id,occurred_at} — no internal field", () => {
    const payload = buildWebhookPayload(EVENT);
    expect(Object.keys(payload).sort()).toEqual(["id", "occurred_at", "shipment_id", "type"]);
  });

  it("the ORIGINATOR pairing (refs.pairing) NEVER rides the signed body", async () => {
    const secretEvent: TerminalEvent = { ...EVENT, originatorPairing: "prn-SECRET-INTERNAL-ROUTING-KEY" };
    const signed = await signWebhook(SECRET, buildWebhookPayload(secretEvent), secretEvent.id, 1);
    expect(signed.body).not.toContain("prn-SECRET-INTERNAL-ROUTING-KEY");
    expect(signed.body).not.toContain("originatorPairing");
  });
});

describe("subscription storage — a pairings kind='webhook' row (fail-closed resolution)", () => {
  it("resolves an active webhook subscription (url + secret_ref + all terminal kinds by default)", async () => {
    const sub = await resolveWebhookSubscription(env.CONTROL_DB, ORIGINATOR);
    expect(sub).not.toBeNull();
    expect(sub?.url).toBe(HOOK_URL);
    expect(sub?.secretRef).toBe(SECRET_REF);
    expect(sub?.events).toEqual(["booking.created", "invoice.issued", "delivery.evidenced"]);
  });

  it("an originator with NO subscription row → null (fail-closed)", async () => {
    expect(await resolveWebhookSubscription(env.CONTROL_DB, ORIGINATOR_NOSUB)).toBeNull();
  });

  it("a SUSPENDED webhook row → null (status gate)", async () => {
    expect(await resolveWebhookSubscription(env.CONTROL_DB, ORIGINATOR_SUSPENDED)).toBeNull();
  });

  it("a MALFORMED caps config → null (unusable ⇒ fail-closed)", async () => {
    expect(await resolveWebhookSubscription(env.CONTROL_DB, ORIGINATOR_MALFORMED)).toBeNull();
  });
});

describe("deliverWebhook — fail-closed + idempotent", () => {
  it("with NO resolvable secret (NotConfiguredSecretResolver) NOTHING is POSTed", async () => {
    const { transport, calls } = recordingTransport();
    const deps = makeDeps({ secrets: new NotConfiguredSecretResolver(), transport });
    const outcome = await deliverWebhook(deps, SUB, EVENT);
    expect(outcome).toBe("skipped-no-secret");
    expect(calls).toHaveLength(0); // no unsigned/unauthenticated request ever leaves
  });

  it("delivers ONCE — the receiver verifies the signature and the marker is set", async () => {
    const { transport, calls } = recordingTransport();
    const { markers, set } = memMarkers();
    const deps = makeDeps({ transport, markers });
    const outcome = await deliverWebhook(deps, SUB, EVENT);
    expect(outcome).toBe("delivered");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(HOOK_URL);
    expect(await verifyWebhook(SECRET, calls[0]!.headers, calls[0]!.body)).toBe(true); // authentic on the wire
    expect(set.has(deliveryMarkerKey(SUB.id, EVENT.id))).toBe(true); // marked on success
  });

  it("a RE-RUN does not re-deliver (the per-event marker ⇒ idempotent)", async () => {
    const { transport, calls } = recordingTransport();
    const { markers } = memMarkers();
    const deps = makeDeps({ transport, markers });
    expect(await deliverWebhook(deps, SUB, EVENT)).toBe("delivered");
    expect(await deliverWebhook(deps, SUB, EVENT)).toBe("already");
    expect(calls).toHaveLength(1); // the second attempt POSTed nothing
  });

  it("an event kind outside the subscription's allow-list is skipped (no POST)", async () => {
    const { transport, calls } = recordingTransport();
    const narrowSub: WebhookSubscription = { ...SUB, events: ["invoice.issued"] };
    const deps = makeDeps({ transport });
    expect(await deliverWebhook(deps, narrowSub, EVENT)).toBe("skipped-kind"); // EVENT is booking.created
    expect(calls).toHaveLength(0);
  });

  it("a failed send leaves NO marker (retried next tick, never a phantom delivered)", async () => {
    const { transport, calls } = recordingTransport({ ok: false, status: 500 });
    const { markers, set } = memMarkers();
    const deps = makeDeps({ transport, markers });
    await expect(deliverWebhook(deps, SUB, EVENT)).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(set.size).toBe(0); // no marker on a failed delivery
  });
});

describe("runWebhookSweep — the cron body (fail-closed + idempotent)", () => {
  it("the NotConfigured event source yields nothing → a safe no-op (nothing delivered)", async () => {
    const { transport, calls } = recordingTransport();
    const deps = makeDeps({ eventSource: new NotConfiguredEventSource(), transport });
    const summary = await runWebhookSweep(deps);
    expect(summary).toEqual({ scanned: 0, delivered: 0, already: 0, skipped: 0, failed: 0 });
    expect(calls).toHaveLength(0);
  });

  it("routes an event to its originator's subscription and delivers once; a re-run re-delivers nothing", async () => {
    const { transport, calls } = recordingTransport();
    const { markers } = memMarkers();
    const deps = makeDeps({ eventSource: eventSourceOf([EVENT]), transport, markers, resolveSubscription: (p) => resolveWebhookSubscription(env.CONTROL_DB, p) });
    const first = await runWebhookSweep(deps);
    expect(first.delivered).toBe(1);
    expect(calls).toHaveLength(1);
    const second = await runWebhookSweep(deps);
    expect(second.already).toBe(1);
    expect(second.delivered).toBe(0);
    expect(calls).toHaveLength(1); // still just the one delivery
  });

  it("an event whose originator has no subscription is skipped (fail-closed)", async () => {
    const { transport, calls } = recordingTransport();
    const orphan: TerminalEvent = { ...EVENT, originatorPairing: ORIGINATOR_NOSUB };
    const deps = makeDeps({ eventSource: eventSourceOf([orphan]), transport, resolveSubscription: (p) => resolveWebhookSubscription(env.CONTROL_DB, p) });
    const summary = await runWebhookSweep(deps);
    expect(summary.skipped).toBe(1);
    expect(summary.delivered).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("the production NotConfiguredWebhookTransport refuses to deliver (fail-closed by construction)", async () => {
    await expect(new NotConfiguredWebhookTransport().send(HOOK_URL, {}, "{}")).rejects.toThrow();
  });
});

// 2026-08-01 convergence audit (REQ-025) — the subscription's tenant must MATCH the originator's.
describe("tenant parity — a webhook row under another tenant cannot claim an originator", () => {
  it("resolves to null when the webhook row's tenant differs from the originator pairing's", async () => {
    const foreign = "prn-wh-foreign";
    await seedTenant(env.CONTROL_DB, "t-wh-other", "tenant-wh-other");
    // The originator belongs to TENANT_W; the webhook row is provisioned under a DIFFERENT tenant.
    await seedPairing(env.CONTROL_DB, { id: foreign, tenantId: TENANT_W, kind: "mcp", scopes: '["mcp"]', caps: "{}" });
    await seedPairing(env.CONTROL_DB, {
      id: webhookSubIdFor(foreign), tenantId: "t-wh-other", kind: "webhook", secretRef: SECRET_REF,
      caps: JSON.stringify({ url: HOOK_URL }),
    });
    expect(await resolveWebhookSubscription(env.CONTROL_DB, foreign)).toBeNull();
  });

  it("a cleartext http:// delivery URL is refused — signatures prove authenticity, never confidentiality", async () => {
    const plain = "prn-wh-plain";
    await seedPairing(env.CONTROL_DB, { id: plain, tenantId: TENANT_W, kind: "mcp", scopes: '["mcp"]', caps: "{}" });
    await seedPairing(env.CONTROL_DB, {
      id: webhookSubIdFor(plain), tenantId: TENANT_W, kind: "webhook", secretRef: SECRET_REF,
      caps: JSON.stringify({ url: "http://hooks.example/inbound" }),
    });
    expect(await resolveWebhookSubscription(env.CONTROL_DB, plain)).toBeNull();
  });
});

describe("§1714 REQ-118: a delivery marker is PERMANENT — the one store whose TTL must stay absent", () => {
  it("mark() writes with NO expiry, so a delivered webhook can never re-fire", async () => {
    // THE ASYMMETRY THIS PINS. Three KV/R2 stores in this build carry a deliberate TTL and each is asserted:
    // the api's idempotency record (§789, via KV's own `expiration` metadata) and the OAuth code
    // (`oauth.test.ts`). This store is the one where a TTL would be a DEFECT — the marker's presence IS the
    // "already delivered" record, so an evicted marker re-delivers a webhook to a partner, with whatever
    // side effects that partner attaches to it. The filed row states permanence is CORRECT; nothing asserted
    // it, so "tidying up" by adding an expirationTtl here — the idiom used two files away — would look like
    // hygiene and cause duplicate delivery.
    //
    // Asserted on the OPTIONS ARGUMENT rather than by advancing a clock: the property is that the write
    // carries no expiry at all, and a bare `put` passes `undefined`.
    const calls: Array<{ key: string; value: unknown; options: unknown }> = [];
    const fakeKv = {
      put: (key: string, value: unknown, options?: unknown): Promise<void> => {
        calls.push({ key, value, options });
        return Promise.resolve();
      },
      get: (): Promise<string | null> => Promise.resolve(null),
    } as unknown as KVNamespace;

    await new KvDeliveryMarkers(fakeKv).mark("wh:prn-x:evt-1");

    expect(calls, "mark() must write exactly once").toHaveLength(1);
    expect(calls[0]?.key).toBe("wh:prn-x:evt-1");
    expect(
      calls[0]?.options,
      "a delivery marker must carry NO expiry — an evicted marker re-delivers the webhook (filed row: " +
        "'Idempotency MARKERS are permanent'). If a TTL is ever wanted here, it is a behaviour change: the " +
        "marker's presence is the delivered record.",
    ).toBeUndefined();
  });
});
