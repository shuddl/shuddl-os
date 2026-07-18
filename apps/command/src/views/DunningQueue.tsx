import { useCallback, useEffect, useState } from "react";
import { Mono } from "@shuddl/design";
import { ApiError, get, post } from "../lib/api.js";
import { formatCents } from "../intake/intake.js";
import { DarkPanel, GhostButton } from "./ui.js";

// WP-11 Task 7 (REQ-032) — the Collector DUNNING draft queue, folded UNDER the money surface (NOT a 13th canonical
// view — it rides alongside MoneyQueue in the (03) MONEY section). It lists the Collector's DRAFT dunning (GET
// /v1/dunning?status=draft, re-rendered from committed invoice state) and lets an operator SEND one (POST
// /v1/dunning/:id/send — the HUMAN IS THE APPROVAL; no auto-send, no dual-control matrix). The send state is
// reflected HONESTLY: a held/failed send shows the REAL state, never a false "SENT". Token-only design (the
// sanctioned DarkPanel/GhostButton/Mono over the five tokens — the design audit stays clean, REQ-158).

type DunningBucket = "reminder" | "firm" | "final";
interface DunningDraft {
  draft_id: string;
  invoice_id: string;
  bucket: DunningBucket;
  amount_cents: number;
  days_overdue: number;
  recipient: string | null;
  subject: string;
}
// The FIXED per-bucket row label (the tone's escalation, never model output — mirrors DUNNING_TONES.subjectTag).
const BUCKET_LABEL: Record<DunningBucket, string> = { reminder: "REMINDER", firm: "PAST DUE", final: "FINAL NOTICE" };

// The per-draft send lifecycle — reflected HONESTLY. `held`/`error` are the real held state, never a false "SENT".
type SendState = { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "held"; detail: string } | { kind: "error"; detail: string };

interface SendResponse {
  status: "sent" | "held" | "skipped";
  reason?: string;
  detail?: string;
}

export function DunningQueue({ onAuthError }: { onAuthError: () => void }): React.JSX.Element {
  const [drafts, setDrafts] = useState<DunningDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, SendState>>({});

  useEffect(() => {
    let live = true;
    setLoading(true);
    get<{ drafts: DunningDraft[] }>("/v1/dunning?status=draft")
      .then((res) => {
        if (live) setDrafts(res.drafts);
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.isAuthError) {
          onAuthError();
          return;
        }
        setError(e instanceof ApiError ? e.message : "COULD NOT LOAD DUNNING");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [onAuthError]);

  const send = useCallback(
    (draftId: string) => {
      setStates((s) => ({ ...s, [draftId]: { kind: "sending" } }));
      // post() attaches a FRESH Idempotency-Key (the api client, REQ-156) — the human-initiated send.
      post<SendResponse>(`/v1/dunning/${encodeURIComponent(draftId)}/send`)
        .then((res) => {
          // HONEST: only a true "sent" shows SENT; a "held" (or any non-sent) shows the real held state.
          setStates((s) => ({ ...s, [draftId]: res.status === "sent" ? { kind: "sent" } : { kind: "held", detail: res.detail ?? "HELD" } }));
        })
        .catch((e: unknown) => {
          if (e instanceof ApiError && e.isAuthError) {
            onAuthError();
            return;
          }
          // a failed/held send shows the REAL state — NEVER a false "SENT".
          setStates((s) => ({ ...s, [draftId]: { kind: "error", detail: e instanceof ApiError ? e.message : "SEND FAILED" } }));
        });
    },
    [onAuthError],
  );

  return (
    <DarkPanel heading="DUNNING">
      {loading ? (
        <Mono size={11} color="var(--field-on-dark)">
          SYNCING
        </Mono>
      ) : error !== null ? (
        <Mono size={11} color="var(--signal)">
          {error}
        </Mono>
      ) : drafts.length === 0 ? (
        <Mono size={11} color="var(--field-on-dark)">
          NO DUNNING DRAFTS
        </Mono>
      ) : (
        drafts.map((d) => {
          const st: SendState = states[d.draft_id] ?? { kind: "idle" };
          return (
            <div key={d.draft_id} data-testid={`dunning-${d.draft_id}`} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "baseline" }}>
                <Mono size={10} color="var(--signal-55)">
                  {BUCKET_LABEL[d.bucket]}
                </Mono>
                <Mono size={12} color="var(--field-on-dark)">
                  {formatCents(d.amount_cents)}
                </Mono>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "baseline" }}>
                <Mono size={11} color="var(--field-on-dark)">
                  {d.invoice_id}
                </Mono>
                <Mono size={10} color="var(--signal-55)">
                  {`${d.days_overdue}D OVERDUE`}
                </Mono>
              </div>
              <Mono size={10} color="var(--signal-55)">
                {d.recipient ?? "NO BILLING EMAIL"}
              </Mono>
              {st.kind === "sent" ? (
                <Mono size={11} color="var(--signal)">
                  SENT
                </Mono>
              ) : st.kind === "held" ? (
                <Mono size={11} color="var(--signal)">
                  HELD — NOT SENT
                </Mono>
              ) : st.kind === "error" ? (
                <Mono size={11} color="var(--signal)">
                  {`HOLD — ${st.detail}`}
                </Mono>
              ) : (
                <GhostButton
                  onClick={() => send(d.draft_id)}
                  disabled={st.kind === "sending" || d.recipient === null}
                  ariaLabel={`send dunning for ${d.invoice_id}`}
                >
                  {st.kind === "sending" ? "SENDING" : "SEND"}
                </GhostButton>
              )}
            </div>
          );
        })
      )}
    </DarkPanel>
  );
}
