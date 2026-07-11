import { useMemo, useState } from "react";
import { Button, Display, Divider, Input, Mono, TextLink } from "@shuddl/design";
import { DEMO_GLYPHS_URL, DEMO_TILE_URL, MapCanvas, demoFleet, useFleet } from "@shuddl/map";

// CLIENT PORTAL (REQ-073/074) — the SAME map, scoped to ONE party (party lens; positions are
// city-generalized until out-for-delivery inside useFleet). Hero = the customer's name in Display
// over their live freight; quote→book is one dark panel with 4 fields; docs/invoices are 1px-ruled
// lists, no cards. The party name is a synthetic placeholder (REQ-167 — never a real customer).

// Opt-in Mapbox tiles when VITE_MAPBOX_TOKEN is set at build; unset ⇒ self-hosted default (REQ-075).
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const PARTY_ID = "party-0";
const PARTY_NAME = "MERIDIAN SUPPLY CO.";

const DOCS: ReadonlyArray<[string, string]> = [
  ["BOL-40318", "SIGNED"],
  ["RATE CON-40318", "ACCEPTED"],
  ["POD-40206", "DELIVERED"],
];
const INVOICES: ReadonlyArray<[string, string]> = [
  ["INV-40206", "$1,480 · PAID"],
  ["INV-40311", "$2,240 · DUE 12D"],
];

function RuledList({ heading, rows }: { heading: string; rows: ReadonlyArray<[string, string]> }): React.JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <Mono size={10} color="var(--signal-55)">
        {heading}
      </Mono>
      <div style={{ marginTop: 8 }}>
        {rows.map(([name, meta]) => (
          <div key={name}>
            <Divider />
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "10px 0" }}>
              <Mono size={12}>{name}</Mono>
              <Mono size={12} color="var(--signal-55)">
                {meta}
              </Mono>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function App(): React.JSX.Element {
  const source = useMemo(() => demoFleet(), []);
  const { collection } = useFleet({ scope: "party", partyId: PARTY_ID }, source);
  const [origin, setOrigin] = useState("");
  const [dest, setDest] = useState("");
  const [weight, setWeight] = useState("");
  const [pickup, setPickup] = useState("");

  return (
    <main style={{ position: "fixed", inset: 0, background: "var(--field)", overflow: "hidden" }}>
      <MapCanvas tileUrl={DEMO_TILE_URL} glyphsUrl={DEMO_GLYPHS_URL} fleet={collection} onSelect={() => {}} mapboxToken={MAPBOX_TOKEN} />

      {/* Hero — the customer's name over their live freight. */}
      <header style={{ position: "absolute", top: 40, left: 32, maxWidth: "70vw" }}>
        <Mono size={11} color="var(--signal-55)">
          YOUR FREIGHT · LIVE
        </Mono>
        <Display size="hero">{PARTY_NAME}</Display>
      </header>

      {/* Quote → book: one dark panel, 4 fields. */}
      <section
        aria-label="Quote and book"
        style={{
          position: "absolute",
          top: 40,
          right: 32,
          width: "min(360px, 90vw)",
          background: "var(--ink-dark)",
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <Mono size={10} color="var(--signal-55)">
          QUOTE → BOOK
        </Mono>
        <Input name="origin" placeholder="Origin ZIP" value={origin} onChange={setOrigin} />
        <Input name="dest" placeholder="Destination ZIP" value={dest} onChange={setDest} />
        <Input name="weight" placeholder="Weight (lb)" value={weight} onChange={setWeight} />
        <Input name="pickup" placeholder="Pickup date" value={pickup} onChange={setPickup} />
        <Button type="submit">Get Quote</Button>
      </section>

      {/* Docs + invoices — 1px-ruled lists, no cards. */}
      <aside
        style={{
          position: "absolute",
          bottom: 32,
          left: 32,
          width: "min(420px, 92vw)",
          background: "var(--field)",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        <RuledList heading="DOCUMENTS" rows={DOCS} />
        <RuledList heading="INVOICES" rows={INVOICES} />
        <TextLink href="#status">Track a shipment</TextLink>
      </aside>
    </main>
  );
}
