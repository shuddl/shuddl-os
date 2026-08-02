// Vite `?raw` imports load a file's exact text (same mechanism as *.sql?raw). The metering test seeds a tenant
// D1 (events + agent_runs) and the control D1 (usage_credits) by applying the migrations imported verbatim.
declare module "*?raw" {
  const content: string;
  export default content;
}

// Vite import.meta.glob, typed for the roster-regression pin (claimed-tenants.test.ts). The call must
// stay a literal import.meta.glob(...) — Vite transforms it statically.
interface ImportMeta {
  glob(pattern: string, opts: { query: string; import: string }): Record<string, () => Promise<unknown>>;
}
