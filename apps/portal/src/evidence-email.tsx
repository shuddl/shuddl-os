import { Display, Divider, Mono } from "@shuddl/design";

// THE EVIDENCE EMAIL (doc 07 §03) — the brand's furthest-traveling artifact, given design-system
// treatment equal to the app: greige ground, Display "DELIVERED", the signature + placed-freight
// photos FULL-BLEED and unrounded (A6 — the only imagery in the product), mono metadata, red rules.
// This is the money-as-a-projection-of-physics moment: POD → invoice + evidence, the same second.
// Deterministic; no real photos (documentary placeholders) so the canonical screenshot is stable.

const META: ReadonlyArray<[string, string]> = [
  ["SHIPMENT", "SHP-40206"],
  ["DELIVERED", "2026-07-10 · 14:32 MT"],
  ["SIGNED BY", "J. NAVARRO · RECEIVING"],
  ["LOCATION", "DENVER, CO 80216"],
  ["INVOICE", "INV-40206 · $1,480.00"],
];

/** A full-bleed, unrounded documentary photo slot (the real POD image renders here in production). */
function PhotoSlot({ caption }: { caption: string }): React.JSX.Element {
  return (
    <figure style={{ margin: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          aspectRatio: "4 / 3",
          background: "var(--signal-07)",
          borderTop: "1px solid var(--signal)",
          display: "flex",
          alignItems: "flex-end",
          padding: 12,
        }}
      >
        <Mono size={10} color="var(--signal-55)">
          {caption}
        </Mono>
      </div>
    </figure>
  );
}

export function EvidenceEmail(): React.JSX.Element {
  return (
    <main style={{ background: "var(--field)", minHeight: "100vh", display: "flex", justifyContent: "center" }}>
      <article style={{ width: "min(640px, 100%)", padding: 32, display: "flex", flexDirection: "column", gap: 20 }}>
        <Mono size={11} color="var(--signal-55)">
          SHUDDL · PROOF OF DELIVERY
        </Mono>

        <Display size="hero">DELIVERED</Display>
        <Divider />

        {/* Full-bleed evidence photos — signature + placed freight. */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <PhotoSlot caption="SIGNATURE" />
          <PhotoSlot caption="FREIGHT AS PLACED" />
        </div>

        {/* Mono metadata over red rules. */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          {META.map(([k, v]) => (
            <div key={k}>
              <Divider />
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "10px 0" }}>
                <Mono size={11} color="var(--signal-55)">
                  {k}
                </Mono>
                <Mono size={12}>{v}</Mono>
              </div>
            </div>
          ))}
          <Divider />
        </div>

        <Mono size={10} color="var(--signal-55)">
          THIS EMAIL IS THE RECORD · REPLY TO DISPUTE WITHIN 48H
        </Mono>
      </article>
    </main>
  );
}
