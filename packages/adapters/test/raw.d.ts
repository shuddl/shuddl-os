// Vite `?raw` imports (the CSV fixtures load as strings) — the ambient shape so tsc/vitest resolve them.
declare module "*?raw" {
  const content: string;
  export default content;
}
