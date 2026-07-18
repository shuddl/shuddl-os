import { useState } from "react";
import { Button, Chip, Display, Divider, Input, Mono } from "@shuddl/design";
import type { AnswerResult, EventRef } from "@shuddl/contracts";
import { ApiError, post } from "../lib/api.js";

// WP-10 Task 12 (REQ-038) — the COPILOT panel (the "+copilot" surface, opened by the ⌘K "Open Copilot" /
// "Ask the Copilot" command; NOT one of the 12 views). It POSTs {question} to /v1/copilot/ask and renders the
// AnswerResult READ-ONLY:
//   · an answer = its text + its event CITATIONS (each EventRef → a chip; a citation with a shipment_id opens
//     that shipment's lens on the board — deep-linking to the cited event via the feed);
//   · an ABSTENTION (abstained:true) is shown HONESTLY — the server's fixed "I can't answer that from the ledger"
//     text, with zero citations. NEVER a fabricated answer (cite-or-abstain is enforced server-side; the panel
//     only reflects it).
// The panel never writes to the ledger — it only asks and renders.

export interface CopilotPanelProps {
  onOpenShipment: (shipmentId: string) => void;
  onClose: () => void;
}

export function CopilotPanel({ onOpenShipment, onClose }: CopilotPanelProps): React.JSX.Element {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AnswerResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(): Promise<void> {
    const q = question.trim();
    if (q.length === 0) return;
    setLoading(true);
    setError(null);
    setAnswer(null);
    try {
      const res = await post<AnswerResult>("/v1/copilot/ask", { question: q });
      setAnswer(res);
    } catch (e: unknown) {
      setError(e instanceof ApiError ? `${e.code} — ${e.message}` : "COPILOT UNAVAILABLE");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section
      aria-label="Copilot"
      style={{ position: "absolute", top: 84, right: 24, background: "var(--field)", padding: 20, minWidth: 340, maxWidth: "min(520px, 92vw)", display: "flex", flexDirection: "column", gap: 12 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
        <Mono size={10} color="var(--signal-55)">
          COPILOT
        </Mono>
        <Button onClick={onClose}>Close</Button>
      </div>
      <Display size="sub">ASK THE LEDGER</Display>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Input value={question} onChange={setQuestion} placeholder="ASK A QUESTION" name="copilot-question" />
        <Button onClick={() => void ask()}>Ask</Button>
      </div>

      {loading ? (
        <Mono size={11}>THINKING</Mono>
      ) : error !== null ? (
        <Mono size={11} color="var(--signal-deep)">
          {error}
        </Mono>
      ) : answer !== null ? (
        answer.abstained ? (
          // HONEST abstention — the server's fixed message, no citations, no fabricated fact.
          <Mono size={12} color="var(--signal-deep)">
            {answer.text}
          </Mono>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Mono size={12}>{answer.text}</Mono>
            <Mono size={10} color="var(--signal-55)">
              CITATIONS
            </Mono>
            {answer.citations.map((c: EventRef) => (
              <div key={c.event_id}>
                <Divider />
                <div style={{ padding: "6px 0" }}>
                  {c.shipment_id !== undefined ? (
                    <button
                      type="button"
                      onClick={() => onOpenShipment(c.shipment_id as string)}
                      aria-label={`Open ${c.shipment_id}`}
                      style={{ background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer" }}
                    >
                      <Chip>
                        {c.kind} · {c.shipment_id}
                      </Chip>
                    </button>
                  ) : (
                    <Chip>{c.kind}</Chip>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      ) : null}
    </section>
  );
}
