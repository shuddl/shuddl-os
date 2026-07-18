import { useEffect, useState } from "react";
import { Mono } from "@shuddl/design";
import { ApiError, get } from "../lib/api.js";
import { DarkPanel, RowButton, hhmm } from "./ui.js";

// WP-10 Task 12 (REQ-082) — the EXCEPTIONS queue (v_queue_exceptions). A live, READ-ONLY read over
// GET /v1/exceptions?status=open (Task 3 — a DURABLE read of exception.raised + osd.captured EVENTS, never the
// mutable status_cache). Each row is CLICKABLE to open its shipment's lens on the map board (via the shipment
// feed). RESOLUTION IS WP-11 — there is NO resolve action here (no exception.resolved kind exists in the frozen
// 35); this surface only surfaces + navigates. An item with no shipment_id (should not happen for these kinds) is
// shown but inert.

interface ExceptionRow {
  shipment_id: string | null;
  exception_event_id: string;
  kind: string;
  reason_code: string | null;
  ts: number;
  open: boolean;
}

export interface ExceptionsQueueProps {
  onAuthError: () => void;
  onOpenShipment: (shipmentId: string) => void;
}

export function ExceptionsQueue({ onAuthError, onOpenShipment }: ExceptionsQueueProps): React.JSX.Element {
  const [rows, setRows] = useState<ExceptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    get<{ exceptions: ExceptionRow[] }>("/v1/exceptions?status=open")
      .then((res) => {
        if (live) setRows(res.exceptions);
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.isAuthError) {
          onAuthError();
          return;
        }
        setError(e instanceof ApiError ? e.message : "COULD NOT LOAD EXCEPTIONS");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [onAuthError]);

  return (
    <DarkPanel heading="EXCEPTIONS">
      {loading ? (
        <Mono size={11} color="var(--field-on-dark)">
          SYNCING
        </Mono>
      ) : error !== null ? (
        <Mono size={11} color="var(--signal)">
          {error}
        </Mono>
      ) : rows.length === 0 ? (
        <Mono size={11} color="var(--field-on-dark)">
          NO OPEN EXCEPTIONS
        </Mono>
      ) : (
        rows.map((r) => {
          const label = r.reason_code ?? r.kind; // reason_code may be absent (defensive server read) — fall back to kind
          const content = (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "baseline" }}>
                <Mono size={12} color="var(--field-on-dark)">
                  {r.shipment_id ?? "—"}
                </Mono>
                <Mono size={10} color="var(--signal-55)">
                  {hhmm(r.ts)}
                </Mono>
              </div>
              <Mono size={10} color="var(--signal-55)">
                {label}
              </Mono>
            </div>
          );
          return (
            <div key={r.exception_event_id}>
              {r.shipment_id !== null ? (
                <RowButton onClick={() => onOpenShipment(r.shipment_id as string)} ariaLabel={`Open ${r.shipment_id}`}>
                  {content}
                </RowButton>
              ) : (
                content
              )}
            </div>
          );
        })
      )}
    </DarkPanel>
  );
}
