import type { Hono } from "hono";
import { z } from "zod";
import { lensFor, readEvents, type ReadQuery } from "@shuddl/ledger/lens";
import { selectCopilot, CopilotError } from "@shuddl/agents";
import type { CopilotReadPort, CopilotReadQuery, ReadEvent } from "@shuddl/agents";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { tenantDb } from "../tenants.js";
import type { Env, Vars } from "../index.js";

// WP-10 Task 7 (REQ-038/024) — the COPILOT surface: POST /v1/copilot/ask. A READ-ONLY question-answerer over
// the ledger. It NEVER writes (no sequencer, no append, no domain-table INSERT — the route only READS and
// returns text+citations) and NEVER fabricates (cite-or-abstain, enforced by the copilot core + AnswerResult).
//
// LENS-SCOPING (REQ-025/I6) — the read port is BOUND to the caller's OWN lens: every retrieval goes through
// readEvents(db, lensFor(session), q), so the copilot can only ever ground an answer on events the caller could
// already read. It can NEVER answer across the caller's visibility boundary (nor across tenants — tenantDb is
// keyed off the JWT claim ONLY). The event payloads it reads may have originated from UNTRUSTED email/portal
// input; the core treats them as data, and the LLM adapter (when configured) frames them as untrusted + re-grounds
// every claim — so a prompt-injected "cite evt-x" that isn't a real retrieved event ABSTAINS.
//
// LLM PLACEMENT (REQ-024) — the LLM lives ONLY in @shuddl/agents (statically linted). This route is the
// composition root: it binds the D1/lens read port and selects the adapter. In CI no key is bound, so
// selectCopilot returns the DeterministicCopilot floor — the LLM is never reachable in tests.

// The tenant-lens roles (admin/ops/finance/read). A portal party / driver has no cross-shipment copilot — the
// same role set as the other command-surface reads (exceptions/approvals/kpis).
const COPILOT_ROLES = ["admin", "ops", "finance", "read"] as const;

// The request body — bounded + .strict(): ONLY a question string. A blank or oversized question is a clean 400.
const AskBody = z.object({ question: z.string().min(1).max(2_000) }).strict();

// Optional LLM binding read off the worker Env (never a header/body). BOTH present ⇒ the live ClaudeCopilot;
// otherwise the DeterministicCopilot floor. CONFIRM-gated — unbound in CI, so the LLM is never called there.
function copilotConfig(env: Env): { apiKey?: string; model?: string } {
  const cfg: { apiKey?: string; model?: string } = {};
  if (env.ANTHROPIC_API_KEY) cfg.apiKey = env.ANTHROPIC_API_KEY;
  if (env.COPILOT_MODEL) cfg.model = env.COPILOT_MODEL;
  return cfg;
}

export function mountCopilotRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  app.post("/v1/copilot/ask", requireRole(...COPILOT_ROLES), async (c) => {
    const session = c.get("session");
    const db = tenantDb(c.env, session.tenant); // REQ-025 — D1 keyed off the claim ONLY

    const parsed = AskBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "BODY MUST BE {question: string}");

    // Resolve the caller's lens ONCE (from the JWT claim), then bind a read-only port that runs EVERY retrieval
    // through it. This is the whole visibility boundary — the copilot sees only what readEvents hands back.
    let lens;
    try {
      lens = lensFor(session);
    } catch {
      throw new ApiError("FORBIDDEN", 403, "SESSION LENS UNRESOLVED");
    }
    const port: CopilotReadPort = {
      async readEvents(q: CopilotReadQuery): Promise<ReadEvent[]> {
        const rq: ReadQuery = {};
        if (q.shipment_id !== undefined) rq.shipment_id = q.shipment_id;
        if (q.kind !== undefined) rq.kind = q.kind;
        if (q.limit !== undefined) rq.limit = q.limit;
        const events = await readEvents(db, lens, rq); // lens-scoped + redacted for non-tenant lenses
        return events.map((e) => {
          const re: ReadEvent = { event_id: e.id, kind: e.kind, ts: e.ts, payload: e.payload };
          if (e.shipment_id !== undefined) re.shipment_id = e.shipment_id;
          return re;
        });
      },
    };

    const copilot = selectCopilot(port, copilotConfig(c.env));
    try {
      const answer = await copilot.answer(parsed.data.question);
      return c.json(answer); // { text, citations, abstained } — no write ever happened
    } catch (e) {
      // A CopilotError is a CONFIG/transport fault (the live adapter unbound, or a provider 5xx) — surface it as
      // a clean 503, never a 500. It is never a grounding fault (grounding ABSTAINS, it does not throw).
      if (e instanceof CopilotError) throw new ApiError("INTERNAL", 503, "COPILOT UNAVAILABLE");
      throw e;
    }
  });
}
