import { useEffect, useState } from "react";
import { Button, Display, Divider, Mono } from "@shuddl/design";
import { z } from "@shuddl/contracts";
import { ApiError, get } from "../lib/api.js";
import { hhmm } from "./ui.js";

// WP-15 Task 7 (REQ-152/153) — the Command `v_parity` SHADOW-PARITY DASHBOARD. The operator-facing half of the
// overlay: SHUDDL's native computation vs the incumbent's legacy mirror, PER MODULE, so an operator can SEE
// parity before authority flips. This is the reclaimed canonical `v_parity` VIEW (registry.ts) — NOT a 4th
// surface, NOT a 13th view.
//
// IT CONSUMES THE SERVER COMPUTE, IT NEVER RECOMPUTES: it reads GET /v1/parity (routes/parity.ts → the SHARED
// @shuddl/ledger/parity primitive) — the SAME number the flip gate enforces and the Watchtower alarms on, so what
// the operator sees can never drift from what the gate checks. A module row drills to its backing events: the
// NATIVE side via GET /v1/events?kind=<backing_kinds> (the native-visible default), the LEGACY side via the SAME
// with &includeShadow=true (the Task-4b legacy-shadow opt-in) — so the operator sees BOTH the native facts and the
// legacy mirror facts that back the parity number.
//
// THE HONESTY LAW (the anti-false-green heart, mirroring the KPI strip): a status:'UNKNOWN' module — a side is
// missing, so parity is UNPROVABLE — renders an explicit UNKNOWN no-data state, NEVER a fabricated 100% match and
// NEVER a green check. within_gate:false + UNKNOWN reads as "not proven," not "passing." Read-only throughout.

/** The wire shape of GET /v1/parity's ModuleParity (the command app does not depend on @shuddl/ledger — this
 *  mirrors the route's JSON, exactly like KpiTile mirrors GET /v1/kpis). A value is a REAL number OR "UNKNOWN". */
type ParityValue = number | "UNKNOWN";
type ParityStatus = "MATCH" | "DRIFT" | "UNKNOWN";
interface ModuleParityRow {
  module: string;
  native_value: ParityValue;
  legacy_value: ParityValue;
  drift_bps: ParityValue;
  within_gate: boolean;
  status: ParityStatus;
  backing_kinds: string[];
}

// The stored-event fields the drill needs (a LedgerEvent on the wire carries more; `source` splits native/legacy).
// PARSED at the boundary (§782). `get<T>` is a CAST (`request` ends in `return parsed as T`), so
// `get<{ modules: ... }>` / `get<{ events: ... }>` claimed shapes nothing checked — an absent key set state
// to `undefined` and the next render reached `.length`/`.map`, white-screening Command. The parity board is
// the worst place for that: it is the screen someone opens BECAUSE they already distrust the numbers.
//
// SCOPE, stated: the envelope (key present, IS an array) plus each row's scalar fields. `native_value`,
// `legacy_value` and `drift_bps` are `number | "UNKNOWN"` and stay `unknown` here rather than being
// re-declared — an over-strict schema rejects valid payloads, a worse failure than the crash being fixed.
const DrillEventWire = z.object({
  id: z.string(),
  kind: z.string(),
  ts: z.number(),
  shipment_id: z.string().optional(),
  source: z.string().optional(),
});
const DrillEventsResponse = z.object({ events: z.array(DrillEventWire) });
const ModuleParityWire = z.object({
  module: z.string(),
  native_value: z.unknown(),
  legacy_value: z.unknown(),
  drift_bps: z.unknown(),
  within_gate: z.boolean(),
  status: z.unknown(),
  backing_kinds: z.array(z.string()),
});
const ParityResponse = z.object({ modules: z.array(ModuleParityWire) });

// Derived from the wire schema — one shape, so the parsed value and the state type cannot drift.
type DrillEvent = z.infer<typeof DrillEventWire>;

export interface ParityDashboardProps {
  onOpenShipment: (shipmentId: string) => void;
  onClose: () => void;
  onAuthError: () => void;
}

const PARITY_VIEW = "v_parity";

/** A real number renders as-is; "UNKNOWN" renders the literal (never a fabricated 0/placeholder). */
function fmtValue(v: ParityValue): string {
  return v === "UNKNOWN" ? "UNKNOWN" : String(v);
}
/** Drift in bps, or the honest UNKNOWN when either side is missing. */
function fmtDrift(v: ParityValue): string {
  return v === "UNKNOWN" ? "UNKNOWN" : `${v} BPS`;
}
// The status token: a DRIFT module SPEAKS in the loud --signal (the alarm the operator must see); a MATCH — and an
// UNKNOWN, which is calm-but-honest (its literal text carries "not proven") — stay quiet in the muted --signal-55.
// Five-token law: both are sanctioned design tokens, so the audit stays clean.
function statusColor(status: ParityStatus): string {
  return status === "DRIFT" ? "var(--signal)" : "var(--signal-55)";
}

const rowButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: "10px 0",
  margin: 0,
  cursor: "pointer",
  textAlign: "left",
  width: "100%",
  display: "block",
};
const eventButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  margin: 0,
  cursor: "pointer",
  textAlign: "left",
  width: "100%",
  display: "block",
};
const rowFlex: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 16, alignItems: "baseline" };

export function ParityDashboard({ onOpenShipment, onClose, onAuthError }: ParityDashboardProps): React.JSX.Element {
  const [modules, setModules] = useState<ModuleParityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null); // the module currently drilled (null = the list)
  const [nativeEvents, setNativeEvents] = useState<DrillEvent[]>([]);
  const [legacyEvents, setLegacyEvents] = useState<DrillEvent[]>([]);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError, setDrillError] = useState<string | null>(null);

  // Load the per-module parity from the SERVER compute (no client recompute). Honest: a read failure shows the
  // real reason (or drops the session on a 401) — never a fabricated set of green rows.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    get<unknown>("/v1/parity")
      .then((raw) => {
        if (live) setModules(ParityResponse.parse(raw).modules as unknown as ModuleParityRow[]);
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.isAuthError) {
          onAuthError();
          return;
        }
        setError(e instanceof ApiError ? e.message : "COULD NOT LOAD PARITY");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [onAuthError]);

  // Drill a module: read its backing events on BOTH sides. NATIVE = the default (native-visible) firehose; LEGACY
  // = the SAME kind filter with &includeShadow=true (the Task-4b opt-in), then keep only the source:'legacy' mirror
  // rows so the LEGACY column shows the incumbent facts. A null selection reads nothing (no fabricated content).
  useEffect(() => {
    if (selected === null) {
      setNativeEvents([]);
      setLegacyEvents([]);
      setDrillError(null);
      return;
    }
    const mod = modules.find((m) => m.module === selected);
    if (mod === undefined) return;
    let live = true;
    setDrillLoading(true);
    setDrillError(null);
    const kinds = encodeURIComponent(mod.backing_kinds.join(","));
    async function load(): Promise<void> {
      const nativeRes = DrillEventsResponse.parse(await get<unknown>(`/v1/events?kind=${kinds}`));
      const legacyRes = DrillEventsResponse.parse(await get<unknown>(`/v1/events?kind=${kinds}&includeShadow=true`));
      if (!live) return;
      setNativeEvents(nativeRes.events);
      setLegacyEvents(legacyRes.events.filter((e) => e.source === "legacy"));
    }
    load()
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.isAuthError) {
          onAuthError();
          return;
        }
        setDrillError(e instanceof ApiError ? e.message : "COULD NOT LOAD BACKING EVENTS");
      })
      .finally(() => {
        if (live) setDrillLoading(false);
      });
    return () => {
      live = false;
    };
  }, [selected, modules, onAuthError]);

  const active = selected !== null ? modules.find((m) => m.module === selected) : undefined;

  function renderEvent(e: DrillEvent): React.JSX.Element {
    const content = (
      <div style={{ ...rowFlex, padding: "8px 0" }}>
        <Mono size={12}>{e.kind}</Mono>
        <Mono size={10} color="var(--signal-55)">
          {e.shipment_id ?? "—"} · {hhmm(e.ts)}
        </Mono>
      </div>
    );
    return (
      <div key={e.id}>
        <Divider />
        {e.shipment_id !== undefined ? (
          <button type="button" onClick={() => onOpenShipment(e.shipment_id as string)} aria-label={`Open ${e.shipment_id}`} style={eventButtonStyle}>
            {content}
          </button>
        ) : (
          content
        )}
      </div>
    );
  }

  return (
    <section
      aria-label="parity dashboard"
      style={{ position: "absolute", top: 84, left: 24, background: "var(--field)", padding: 20, minWidth: 360, maxWidth: "min(620px, 94vw)", display: "flex", flexDirection: "column", gap: 10 }}
    >
      <div style={{ ...rowFlex }}>
        <Mono size={10} color="var(--signal-55)">
          {PARITY_VIEW}
        </Mono>
        <Button onClick={onClose}>Close</Button>
      </div>

      {active === undefined ? (
        // ── the MODULE LIST — native-vs-legacy per module ────────────────────────────────────────────────────
        <>
          <Display size="sub">SHADOW PARITY</Display>
          <Mono size={11} color="var(--signal-55)">
            NATIVE VS LEGACY · PER MODULE
          </Mono>
          {loading ? (
            <Mono size={11}>SYNCING</Mono>
          ) : error !== null ? (
            <Mono size={11} color="var(--signal-deep)">
              {error}
            </Mono>
          ) : modules.length === 0 ? (
            <Mono size={11}>NO OVERLAY MODULES</Mono>
          ) : (
            modules.map((m) => (
              <div key={m.module}>
                <Divider />
                <button type="button" onClick={() => setSelected(m.module)} aria-label={`${m.module} parity row`} style={rowButtonStyle}>
                  <div style={rowFlex}>
                    <Mono size={13}>{m.module}</Mono>
                    <Mono size={12} color={statusColor(m.status)}>
                      {m.status}
                    </Mono>
                  </div>
                  <div style={{ display: "flex", gap: 16, flexWrap: "wrap", paddingTop: 4 }}>
                    <Mono size={10} color="var(--signal-55)">
                      NATIVE {fmtValue(m.native_value)}
                    </Mono>
                    <Mono size={10} color="var(--signal-55)">
                      LEGACY {fmtValue(m.legacy_value)}
                    </Mono>
                    <Mono size={10} color="var(--signal-55)">
                      DRIFT {fmtDrift(m.drift_bps)}
                    </Mono>
                  </div>
                </button>
              </div>
            ))
          )}
        </>
      ) : (
        // ── the DRILL — the module's backing events, native side + legacy mirror side ─────────────────────────
        <>
          <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
            <Button onClick={() => setSelected(null)}>Back</Button>
            <Display size="sub">{active.module}</Display>
          </div>
          <Mono size={12} color={statusColor(active.status)}>
            {active.status} · DRIFT {fmtDrift(active.drift_bps)}
          </Mono>
          <Mono size={10} color="var(--signal-55)">
            BACKING · {active.backing_kinds.join(" · ")}
          </Mono>

          {drillLoading ? (
            <Mono size={11}>SYNCING</Mono>
          ) : drillError !== null ? (
            <Mono size={11} color="var(--signal-deep)">
              {drillError}
            </Mono>
          ) : (
            <>
              <Mono size={10} color="var(--signal-55)">
                NATIVE
              </Mono>
              {nativeEvents.length === 0 ? <Mono size={11}>NO NATIVE EVENTS YET</Mono> : nativeEvents.map(renderEvent)}
              <Mono size={10} color="var(--signal-55)">
                LEGACY (SHADOW MIRROR)
              </Mono>
              {legacyEvents.length === 0 ? <Mono size={11}>NO LEGACY MIRROR EVENTS</Mono> : legacyEvents.map(renderEvent)}
            </>
          )}
        </>
      )}
    </section>
  );
}
