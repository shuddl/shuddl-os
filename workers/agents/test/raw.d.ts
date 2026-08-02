// Vite `?raw` imports load a file's exact text (same mechanism as *.sql?raw). The parity test reads
// both tenant-allowlist source files verbatim to diff their slug sets.
declare module "*?raw" {
  const content: string;
  export default content;
}

// Vite's import.meta.glob, typed for the roster-regression pin (claimed-tenants.test.ts): the call MUST
// stay a literal `import.meta.glob(...)` — Vite transforms it statically, so aliasing breaks at runtime —
// and the workers tsconfig does not load vite/client, so the narrow shape is declared here instead.
interface ImportMeta {
  glob(pattern: string, opts: { query: string; import: string }): Record<string, () => Promise<unknown>>;
}
