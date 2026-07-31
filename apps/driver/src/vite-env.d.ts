// Vite injects VITE_-prefixed env at build. This mirrors the command/portal surfaces' vite-env.d.ts so the
// driver reads `import.meta.env` with the same typed discipline (no structural cast at the call site).
interface ImportMetaEnv {
  // The API origin the driver's server reads target. Unset ⇒ a synthetic, unreachable `.example`
  // placeholder (REQ-167) — NEVER same-origin, which would let the SPA fallback answer an API path with
  // the HTML shell. Set at build (or stubbed in tests) to the real per-environment API host.
  readonly VITE_API_BASE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
