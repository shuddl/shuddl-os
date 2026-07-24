import { DriverManifest } from "@shuddl/contracts";

// Task 10 (REQ-030/025) — the driver PWA's ONLY server read. It calls GET /v1/driver/manifest with the
// authenticated bearer and returns a DISCRIMINATED result the App switches on. It NEVER falls back to
// demo/fixture data: a 401 is a distinct `unauthenticated` result (the App clears the session), and any
// transport/parse failure is `unavailable` — the caller decides whether to show a stale last-known sheet
// or an explicit unavailable state. Zod validates at the boundary (DriverManifest.strict) so a malformed
// or field-injected response is `unavailable`, never rendered as truth.

export type ManifestResult =
  | { kind: "ok"; manifest: DriverManifest }
  | { kind: "unauthenticated" }
  | { kind: "unavailable"; reason: string };

export interface ManifestClient {
  fetchManifest(signal?: AbortSignal): Promise<ManifestResult>;
}

export interface ManifestClientOptions {
  /** The API origin (same-origin "" in dev; a configured base in prod). */
  readonly baseUrl: string;
  /** The authenticated bearer, or null when there is no active session. */
  readonly getToken: () => string | null;
  /** Injectable for tests; defaults to the platform fetch. */
  readonly fetchImpl?: typeof fetch;
}

export function createManifestClient(opts: ManifestClientOptions): ManifestClient {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async fetchManifest(signal?: AbortSignal): Promise<ManifestResult> {
      const token = opts.getToken();
      if (!token) return { kind: "unauthenticated" }; // no token ⇒ no request, no data

      let res: Response;
      try {
        res = await doFetch(`${opts.baseUrl}/v1/driver/manifest`, {
          headers: { Authorization: `Bearer ${token}` },
          ...(signal ? { signal } : {}),
        });
      } catch (e) {
        return { kind: "unavailable", reason: e instanceof Error ? e.message : "network error" };
      }

      if (res.status === 401) return { kind: "unauthenticated" }; // the session is no longer valid
      if (!res.ok) return { kind: "unavailable", reason: `HTTP ${res.status}` };

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { kind: "unavailable", reason: "invalid response body" };
      }
      const parsed = DriverManifest.safeParse(body);
      if (!parsed.success) return { kind: "unavailable", reason: "manifest failed validation" };
      return { kind: "ok", manifest: parsed.data };
    },
  };
}
