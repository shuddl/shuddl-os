// Vite `?raw` imports load a fixture CSV's exact bytes (the Migrator import suite feeds the same messy files a
// real drag-drop would). Mirrors sql-raw.d.ts.
declare module "*.csv?raw" {
  const content: string;
  export default content;
}
