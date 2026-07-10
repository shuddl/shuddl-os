// Vite `?raw` imports load a file's exact text (same mechanism as *.sql?raw). The parity test reads
// both tenant-allowlist source files verbatim to diff their slug sets.
declare module "*?raw" {
  const content: string;
  export default content;
}
