// Vite `?raw` imports load a migration file's exact bytes so the sequencer suite applies the
// same SQL wrangler runs in production. Mirrors packages/ledger/test/sql-raw.d.ts.
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
