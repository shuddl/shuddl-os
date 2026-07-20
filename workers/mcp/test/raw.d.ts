// Vite `?raw` imports load a file's exact text (same mechanism as *.sql?raw). The OAuth/principal suites seed
// the control plane (pairings + tenants) by applying db/control/migrations/0001_control.sql imported verbatim.
declare module "*?raw" {
  const content: string;
  export default content;
}
