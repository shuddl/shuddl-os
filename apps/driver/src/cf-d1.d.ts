// Minimal ambient shim for the Cloudflare `D1Database` type. The driver PWA imports
// `@shuddl/ledger/gates/transition-gates` for the shared `REQUIRED_EVIDENCE` vocabulary; that module
// re-exports `GateError` from `invoice-gate.ts`, whose `assertPodSigned` is TYPE-annotated with
// `D1Database`. The browser app never calls that server function — but tsc still type-checks the
// imported source, so it needs the type name. We declare only the surface `invoice-gate` uses rather
// than pull the full `@cloudflare/workers-types` (whose globals collide with the DOM lib the PWA needs).
declare global {
  interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = unknown>(): Promise<T | null>;
  }
  interface D1Database {
    prepare(query: string): D1PreparedStatement;
  }
}

export {};
