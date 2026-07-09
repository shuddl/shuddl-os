// Vite `?raw` imports load a migration file's text verbatim so schema tests run the
// exact bytes wrangler applies in production. Typed here so `import m from "*.sql?raw"`
// is strict under vitest-pool-workers.
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
