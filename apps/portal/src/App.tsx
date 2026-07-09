// Surface shell only. Scoped map + quote→book panel land WP-03/WP-09 (REQ-073, REQ-085).
export function App(): React.JSX.Element {
  return (
    <main style={{ background: "var(--field)", color: "var(--signal)", minHeight: "100vh", fontFamily: "var(--display)", textTransform: "uppercase" }}>
      <h1 style={{ fontWeight: 700, fontSize: 64, lineHeight: 0.9, letterSpacing: "-0.015em", padding: 24 }}>(01) Portal</h1>
      <p style={{ fontFamily: "var(--mono)", color: "var(--signal-deep)", fontSize: 12, letterSpacing: "0.08em", padding: "0 24px" }}>Syncing</p>
    </main>
  );
}
