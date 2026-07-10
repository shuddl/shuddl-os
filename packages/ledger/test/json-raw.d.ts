// Vite `?raw` imports load a fixture's exact bytes (same mechanism as *.sql?raw), so the
// netting test replays the vendored seed.json verbatim — the bytes CI hash-pins.
declare module "*.json?raw" {
  const content: string;
  export default content;
}
