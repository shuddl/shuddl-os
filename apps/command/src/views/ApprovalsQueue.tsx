import { useEffect, useState } from "react";
import { Mono } from "@shuddl/design";
import { ApiError, get, post } from "../lib/api.js";
import { DarkPanel, GhostButton } from "./ui.js";

// WP-10 Task 12 (REQ-082/194) — the APPROVALS queue (v_queue_approvals). A live read over GET /v1/approvals?status=open
// (Task 2), each open approval carrying Approve / Deny actions that POST /v1/shipments/:id/approval-decision (the
// BLESSED, matrix-gated path). HONESTY:
//   · the api client attaches a FRESH Idempotency-Key to every POST (lib/api.ts) — a retry replays, a distinct
//     action gets a distinct key;
//   · the server enforces the matrix required_role, so an UNDER-ROLE decision (ops deciding a finance dual) comes
//     back a real 403 — we surface that reason verbatim and KEEP the row (nothing was decided), never a fake success;
//   · on a decided 2xx the row LEAVES the open list (it is no longer open).
// Read-only otherwise: this view neither invents an approval nor mutates the ledger except through the blessed route.

// An approvals read-model row (workers/api/src/routes/approvals.ts APPROVAL_COLS). object_id is the shipment id.
interface ApprovalRow {
  id: string;
  object_kind: string;
  object_id: string;
  rule: string;
  required_role: string;
  requested_event_id: string;
  decided_event_id: string | null;
  status: string;
}

export interface ApprovalsQueueProps {
  onAuthError: () => void;
}

export function ApprovalsQueue({ onAuthError }: ApprovalsQueueProps): React.JSX.Element {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null); // the object_id currently being decided
  const [rowError, setRowError] = useState<Record<string, string>>({}); // per-shipment honest decision failure (e.g. a 403)

  useEffect(() => {
    let live = true;
    setLoading(true);
    get<{ approvals: ApprovalRow[] }>("/v1/approvals?status=open")
      .then((res) => {
        if (live) setRows(res.approvals);
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.isAuthError) {
          onAuthError();
          return;
        }
        setError(e instanceof ApiError ? e.message : "COULD NOT LOAD APPROVALS");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [onAuthError]);

  async function decide(row: ApprovalRow, decision: "approved" | "denied"): Promise<void> {
    setPending(row.object_id);
    setRowError((m) => {
      const next = { ...m };
      delete next[row.object_id];
      return next;
    });
    try {
      // The blessed decision route — the api client stamps a fresh Idempotency-Key (REQ-156). A 2xx means the
      // ledger recorded approval.decided; the row is no longer open, so it leaves the list.
      await post(`/v1/shipments/${encodeURIComponent(row.object_id)}/approval-decision`, { decision });
      setRows((rs) => rs.filter((r) => r.id !== row.id));
    } catch (e: unknown) {
      if (e instanceof ApiError && e.isAuthError) {
        onAuthError();
        return;
      }
      // HONEST server truth: a 403 (below-role) or any refusal shows its real reason; the row STAYS (undecided).
      setRowError((m) => ({ ...m, [row.object_id]: e instanceof ApiError ? `${e.code} — ${e.message}` : "DECISION FAILED" }));
    } finally {
      setPending(null);
    }
  }

  return (
    <DarkPanel heading="APPROVALS">
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
          NO OPEN APPROVALS
        </Mono>
      ) : (
        rows.map((r) => (
          <div key={r.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "baseline" }}>
              <Mono size={12} color="var(--field-on-dark)">
                {r.object_id}
              </Mono>
              <Mono size={10} color="var(--signal-55)">
                {r.required_role.toUpperCase()}
              </Mono>
            </div>
            <Mono size={10} color="var(--signal-55)">
              {r.rule}
            </Mono>
            <div style={{ display: "flex", gap: 8 }}>
              <GhostButton onClick={() => void decide(r, "approved")} disabled={pending === r.object_id}>
                Approve
              </GhostButton>
              <GhostButton onClick={() => void decide(r, "denied")} disabled={pending === r.object_id}>
                Deny
              </GhostButton>
            </div>
            {rowError[r.object_id] !== undefined ? (
              <Mono size={10} color="var(--signal)">
                {rowError[r.object_id]}
              </Mono>
            ) : null}
          </div>
        ))
      )}
    </DarkPanel>
  );
}
