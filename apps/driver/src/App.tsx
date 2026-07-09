// Surface shell only — Amendment A2: driver surfaces default to dark ground
// (docks at 5am, sunlight glare). The PWA proper (service worker, IndexedDB
// event queue, gated stop flow) lands WP-05 (REQ-061, REQ-062).
export function App(): React.JSX.Element {
  return (
    <main style={{ background: "var(--ink-dark)", color: "var(--field-on-dark)", minHeight: "100vh", fontFamily: "var(--display)", textTransform: "uppercase" }}>
      <h1 style={{ fontWeight: 700, fontSize: 64, lineHeight: 0.9, letterSpacing: "-0.015em", padding: 24 }}>(01) Driver</h1>
      <p style={{ fontFamily: "var(--mono)", fontSize: 12, letterSpacing: "0.08em", padding: "0 24px" }}>Syncing</p>
    </main>
  );
}
