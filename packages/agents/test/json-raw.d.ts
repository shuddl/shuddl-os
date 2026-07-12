// Vite `?raw` imports load a fixture's exact bytes, so a regression test replays the vendored JSON
// verbatim — the bytes CI hash-pins (fixtures/manifest.json). Same mechanism the rater/ledger tests use.
declare module "*.json?raw" {
  const content: string;
  export default content;
}
