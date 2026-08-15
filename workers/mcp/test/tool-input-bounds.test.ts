import { describe, expect, it } from "vitest";
import { buildRegistry } from "../src/tools/registry.js";

// §1551 (REQ-035/202/118) — EVERY MCP TOOL'S INPUT LENGTH BOUND ACTUALLY REFUSES.
//
// §1550 re-measured §1239's closed size-bound class and left an ordered work-list of unnamed bounds. This is the
// first cluster off it, and it was the worst: **14 length bounds across all six tool files, raised to 9,000,000
// at once, and the entire 193-test mcp suite stayed green.** Not one was asserted.
//
// It matters most HERE. Every other bounded surface takes input from a person or a partner system; these inputs
// are MODEL-SUPPLIED — this is the surface acceptance demo #4 runs on ("a booking placed from Claude via MCP") —
// and an arbitrarily long `shipment_id` is not a hostile act but an ordinary hallucination. The bound is what
// keeps that from becoming a path segment, a D1 parameter and a log line.
//
// TWO ASSERTIONS PER BOUND, because one proves nothing (§1534's control rule). Over the cap must be REFUSED, and
// the SAME payload exactly AT the cap must be ACCEPTED. Without the second, a schema that rejected everything —
// a typo in a sibling field, a `.strict()` catching a stray key — would read as a working bound.
//
// The schemas are reached through `buildRegistry()` rather than by importing module-local consts, so this test
// sees what the DISPATCHER sees: if a tool is ever registered with a different schema than the one its file
// declares, this notices and a direct import would not.

interface BoundCase {
  readonly tool: string;
  readonly field: string;
  readonly cap: number;
  /** A payload that is valid in every OTHER respect, so only `field` can explain a refusal. */
  readonly base: Record<string, unknown>;
}

const ID = "s".repeat(10);
const CASES: readonly BoundCase[] = [
  { tool: "track", field: "shipment_id", cap: 200, base: {} },
  { tool: "track", field: "kind", cap: 64, base: { shipment_id: ID } },
  { tool: "get_document", field: "shipment_id", cap: 200, base: {} },
  { tool: "get_document", field: "document_id", cap: 300, base: { shipment_id: ID } }, // evidenceDocId is longer: `evidence:<shipment>:<64-hex>`
  { tool: "approve", field: "shipment_id", cap: 200, base: { decision: "approved" } },
  { tool: "approve", field: "approval_event_id", cap: 200, base: { shipment_id: ID, decision: "approved" } },
  { tool: "approve", field: "idempotency_key", cap: 200, base: { shipment_id: ID, decision: "approved" } },
  { tool: "book_shipment", field: "shipment_id", cap: 200, base: { quote_event_id: ID } },
  { tool: "book_shipment", field: "quote_event_id", cap: 200, base: { shipment_id: ID } },
  { tool: "book_shipment", field: "idempotency_key", cap: 200, base: { shipment_id: ID, quote_event_id: ID } },
  { tool: "dispute", field: "shipment_id", cap: 200, base: { reason: "damaged in transit" } },
  { tool: "dispute", field: "idempotency_key", cap: 200, base: { shipment_id: ID, reason: "damaged in transit" } },
];

function schemaFor(tool: string): { safeParse: (v: unknown) => { success: boolean } } {
  const reg = buildRegistry();
  const t = reg.get(tool);
  if (t === undefined) throw new Error(`§1551: no tool named '${tool}' in the registry — update this roster, do not delete the case`);
  return t.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
}

describe("§1551 REQ-202: every MCP tool input length bound refuses over the cap and admits at it", () => {
  it("covers a real roster (non-vacuity — an empty table would assert nothing)", () => {
    // Floor the INPUT (§1148). 14 bounds were measured across six files; this table names the string-length ones
    // reachable through a top-level field. A shrinking table must fail here rather than quietly cover less.
    expect(CASES.length, "the bound roster shrank — a case was deleted rather than fixed").toBeGreaterThanOrEqual(12);
    expect(new Set(CASES.map((c) => c.tool)).size, "fewer tools covered than the roster was built for").toBeGreaterThanOrEqual(5);
  });

  for (const c of CASES) {
    it(`${c.tool}.${c.field}: ${c.cap + 1} chars is REFUSED, ${c.cap} is accepted`, () => {
      const schema = schemaFor(c.tool);
      const over = schema.safeParse({ ...c.base, [c.field]: "x".repeat(c.cap + 1) });
      expect(
        over.success,
        `${c.tool}.${c.field} accepted ${c.cap + 1} characters. These inputs are MODEL-supplied; an unbounded id ` +
          `becomes a path segment and a D1 parameter downstream.`,
      ).toBe(false);

      const at = schema.safeParse({ ...c.base, [c.field]: "x".repeat(c.cap) });
      expect(
        at.success,
        `${c.tool}.${c.field} REJECTED a payload exactly at its cap — so the refusal above proves nothing about ` +
          `the length bound; something else in the payload is being rejected.`,
      ).toBe(true);
    });
  }
});
