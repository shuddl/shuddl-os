// Vite `?raw` imports load a file's exact text (same mechanism as *.sql?raw). The Task-7 sweep test seeds a
// tenant D1 by applying the tenant migrations imported verbatim.
declare module "*?raw" {
  const content: string;
  export default content;
}

// Vite import.meta.glob, typed for the roster-regression pin (claimed-tenants.test.ts): the call MUST
// stay a literal import.meta.glob(...) — Vite transforms it statically — and the workers tsconfig does not
// load vite/client, so the narrow shape is declared here.
interface ImportMeta {
  glob(pattern: string, opts: { query: string; import: string }): Record<string, () => Promise<unknown>>;
}
