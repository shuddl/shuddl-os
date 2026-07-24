import { useEffect, useState } from "react";
import { Display, Mono } from "@shuddl/design";
import type { DriverManifest, DriverStop } from "@shuddl/contracts";
import type { Stop } from "./data/stops.js";
import type { StepId } from "./flow/stop-flow.js";
import { DaySheet } from "./components/DaySheet.js";
import { GatedFlow } from "./components/GatedFlow.js";
import { Screen } from "./components/Screen.js";
import { createManifestClient, type ManifestClient } from "./api/client.js";
import { createAuthSession, type AuthSession } from "./auth/session.js";

// DRIVER PWA (doc 07 §03) — the day sheet + the gated per-stop flow, now over an AUTHENTICATED server
// read (Task 10, REQ-030/025/013). The FICTIONAL DAY_SHEET fixture is GONE: the App fetches the driver's
// manifest with its session bearer and renders one of six HONEST states — loading | ready | empty | stale
// | unauthenticated | unavailable. It NEVER falls back to demo data, and a 401 CLEARS the session so no
// stale sheet survives an expired/revoked token. The precise coordinate of a withheld future stop is
// never in the payload (server-side POD-before-next-address reveal); the App can only render a locked row.

type View = { kind: "daysheet" } | { kind: "flow"; stop: Stop; startStep?: StepId };

type Data =
  | { kind: "loading" }
  | { kind: "ready"; manifest: DriverManifest }
  | { kind: "stale"; manifest: DriverManifest } // a refresh failed; showing the last-known good sheet
  | { kind: "empty" }
  | { kind: "unauthenticated" }
  | { kind: "unavailable" };

export interface AppDeps {
  /** Injectable manifest client (tests supply a fake; prod builds the real HTTP client). */
  readonly client?: ManifestClient;
  /** Injectable auth session (tests supply a fake; prod reads persistent storage). */
  readonly session?: AuthSession;
}

// The API origin. Same-origin by default; a build may point the PWA at a distinct API host via env.
function apiBase(): string {
  try {
    return (import.meta as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE ?? "";
  } catch {
    return "";
  }
}

// Map a server manifest stop into the display `Stop`. A WITHHELD future stop shows a locked, non-fictional
// row (no name, no coordinate); a revealed stop shows its coarse coordinate and status. No fixture data.
function toDisplayStop(ds: DriverStop): Stop {
  const label = ds.revealed ? `${ds.kind.toUpperCase()} · ${ds.shipment_id}` : "Locked stop";
  const address = ds.revealed
    ? ds.geo
      ? `${(ds.geo.lat_e6 / 1e6).toFixed(4)}, ${(ds.geo.lon_e6 / 1e6).toFixed(4)}`
      : "No location on file"
    : "Address revealed after the previous stop";
  return { id: ds.shipment_id, seq: ds.seq, kind: ds.kind, name: label, address, window: ds.status.toUpperCase() };
}

// A plain full-screen message state (loading / empty / unauthenticated / unavailable) — Screen chrome,
// one Display line + one Mono caption. Never renders a stop, never imports a fixture.
function MessageScreen({ title, caption }: { title: string; caption: string }): React.JSX.Element {
  return (
    <Screen>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: "auto", marginBottom: "auto" }}>
        <Display size="section" color="var(--field-on-dark)">
          {title}
        </Display>
        <Mono size={11} color="var(--signal-55)">
          {caption}
        </Mono>
      </div>
    </Screen>
  );
}

export function App(deps: AppDeps = {}): React.JSX.Element {
  const [session] = useState<AuthSession>(() => deps.session ?? createAuthSession());
  const [client] = useState<ManifestClient>(
    () => deps.client ?? createManifestClient({ baseUrl: apiBase(), getToken: () => session.getToken() }),
  );
  const [data, setData] = useState<Data>({ kind: "loading" });
  const [view, setView] = useState<View>({ kind: "daysheet" });
  // The last manifest that loaded cleanly — the source of the `stale` state when a later refresh fails.
  const [lastGood, setLastGood] = useState<DriverManifest | null>(null);

  useEffect(() => {
    // No active session ⇒ no request, no data: go straight to the explicit unauthenticated state.
    if (session.getToken() === null) {
      setData({ kind: "unauthenticated" });
      return;
    }
    let cancelled = false;
    const ac = new AbortController();
    void (async () => {
      const res = await client.fetchManifest(ac.signal);
      if (cancelled) return;
      if (res.kind === "ok") {
        setLastGood(res.manifest);
        setData(res.manifest.stops.length > 0 ? { kind: "ready", manifest: res.manifest } : { kind: "empty" });
      } else if (res.kind === "unauthenticated") {
        session.clear(); // a 401 drops the session — no stale sheet may survive an expired/revoked token
        setData({ kind: "unauthenticated" });
      } else {
        // Transport/parse failure — show the last-known sheet as STALE if we have one, else unavailable.
        setData(lastGood ? { kind: "stale", manifest: lastGood } : { kind: "unavailable" });
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
    // Runs once for the stable injected client/session; a login flow (REQ-069) will re-trigger it later.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, session]);

  // An open gated-stop flow overlays the day sheet regardless of refresh state.
  if (view.kind === "flow") {
    return (
      <GatedFlow
        stop={view.stop}
        {...(view.startStep ? { startStep: view.startStep } : {})}
        onExit={() => setView({ kind: "daysheet" })}
      />
    );
  }

  switch (data.kind) {
    case "loading":
      return <MessageScreen title="Loading" caption="LOADING TODAY'S STOPS" />;
    case "unauthenticated":
      return <MessageScreen title="Sign in" caption="YOUR SESSION ISN'T ACTIVE — SIGN IN TO LOAD YOUR DAY" />;
    case "unavailable":
      return <MessageScreen title="Can't load" caption="COULDN'T REACH THE SERVER — NOTHING IS SHOWN" />;
    case "empty":
      return <MessageScreen title="No stops" caption="NOTHING ASSIGNED TO YOU RIGHT NOW" />;
    case "ready":
    case "stale": {
      const manifest = data.manifest;
      const revealedById = new Map(manifest.stops.map((s) => [s.shipment_id, s.revealed]));
      const displayStops = manifest.stops.map(toDisplayStop);
      const doneCount = manifest.stops.filter((s) => s.status === "done").length;
      return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          {data.kind === "stale" ? (
            <div style={{ padding: "6px 24px", borderBottom: "1px solid var(--signal-12)" }}>
              <Mono size={11} color="var(--signal)">
                SHOWING YOUR LAST KNOWN DAY SHEET — COULDN'T REFRESH
              </Mono>
            </div>
          ) : null}
          <DaySheet
            stops={displayStops}
            doneCount={doneCount}
            // Only a REVEALED stop can be opened — a withheld future stop has no coordinate to work.
            onOpen={(stop) => {
              if (revealedById.get(stop.id) === true) setView({ kind: "flow", stop });
            }}
          />
        </div>
      );
    }
  }
}
