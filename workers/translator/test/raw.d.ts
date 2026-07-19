// Vite `?raw` imports load a file's exact text (same mechanism as *.sql?raw). The Task-7 sweep test seeds a
// tenant D1 by applying the tenant migrations imported verbatim.
declare module "*?raw" {
  const content: string;
  export default content;
}
