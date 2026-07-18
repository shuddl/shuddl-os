import { z } from "zod";

// WP-10 Task 7 (REQ-038/024) — the COPILOT contract: a read-only, cite-or-abstain answer over the ledger.
// The copilot NEVER writes and NEVER fabricates: every factual claim it makes is GROUNDED on a REAL retrieved
// event id, and if it cannot ground an answer it ABSTAINS. This is the honesty law, mirrored from the
// Concierge's fail-safe (a model that cannot be corroborated never speaks a ledger-affecting fact).

// EventRef — a REAL event handle the UI links to (GET /v1/shipments/:id/events). Every citation is one of
// these, and its `event_id` MUST be an event that was actually retrieved through the caller's lens (the core
// enforces the membership). `kind` and `shipment_id` come verbatim off the retrieved event, so the UI can
// render a citation chip and deep-link without a second fetch. `.strict()` — no extra keys.
export const EventRef = z
  .object({
    event_id: z.string().min(1),
    kind: z.string().min(1), // an EventKind value, copied off the cited (real) event — bounded as a string here
    shipment_id: z.string().min(1).optional(), // present ⇒ non-empty (a real shipment handle)
  })
  .strict();
export type EventRef = z.infer<typeof EventRef>;

// AnswerResult — the copilot's whole output. THE cite-or-abstain invariant is ENFORCED in the schema, so an
// ungrounded answer can never even be constructed:
//   · a NON-abstained answer MUST carry ≥1 citation — a factual claim with zero citations is a fabrication; and
//   · an ABSTENTION carries EXACTLY zero citations (an honest "I can't answer that from the ledger", abstained:true).
// The core additionally proves each citation's event_id is IN the retrieved set (grounding); the contract is the
// floor that makes "a claim with no citation" unrepresentable.
export const AnswerResult = z
  .object({
    text: z.string(),
    citations: z.array(EventRef),
    abstained: z.boolean(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (!a.abstained && a.citations.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "a non-abstained answer MUST cite ≥1 event (cite-or-abstain — a claim with no citation is a fabrication)",
        path: ["citations"],
      });
    }
    if (a.abstained && a.citations.length !== 0) {
      ctx.addIssue({
        code: "custom",
        message: "an abstention carries zero citations",
        path: ["citations"],
      });
    }
  });
export type AnswerResult = z.infer<typeof AnswerResult>;
