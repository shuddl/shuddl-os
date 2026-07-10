import { env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import type { AppendedEvent } from "../src/do/sequencer.js";
import { verifyChain } from "@shuddl/ledger/chain";
import { rowToEvent } from "@shuddl/ledger/lens";
import { TENANT_SLUG, ensureSchema } from "./helpers.js";

// REGRESSION for Task 14 / Task 16 (REQ-025, I3): a SECOND api test file that also seeds via the shared
// idempotent `ensureSchema`. Before ensureSchema this file's beforeAll re-applied the pinned migrations
// against the isolatedStorage:false shared D1 and died with "table tenants already exists". It must now
// coexist with sequencer.test.ts in the SAME run — proving the shared setup composes across files.
// It scopes to its OWN (tenant|streamId) + shipment id and never assumes an empty table.

type SeqStub = DurableObjectStub & {
  append(req: { tenant: string; streamId: string; input: unknown }): Promise<AppendedEvent>;
};

beforeAll(async () => {
  await ensureSchema(env);
});

it("a second file that shares ensureSchema can append and chain-verifies its own stream", async () => {
  const streamId = "s:shared-setup-1";
  const stub = env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${TENANT_SLUG}|${streamId}`)) as unknown as SeqStub;
  const r = await stub.append({
    tenant: TENANT_SLUG,
    streamId,
    input: {
      id: crypto.randomUUID(),
      shipment_id: "shared-setup-1",
      ts: 1_720_000_000_000,
      actor: { party: "party-shipper" },
      party_refs: [],
      evidence: [],
      source: "native",
      confidence: 10_000,
      kind: "quote.requested",
      payload: {},
    },
  });
  expect(r.seq).toBe(0);

  const res = await env.TENANT_A_DB.prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq").bind(streamId).all();
  const events = (res.results as Record<string, string | number | null>[]).map((row) => rowToEvent(row));
  expect(events).toHaveLength(1);
  expect((await verifyChain(events)).ok).toBe(true);
});
