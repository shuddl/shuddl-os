// Task 10 (REQ-030/069) — the driver's authenticated session token. This is the DRIVER LOGIN token
// (a bearer the API's auth middleware verifies), distinct from the device SIGNING key in ../session.ts
// (the offline dedupe/co-sign identity). A full magic-link/PIN login screen is a follow-up (REQ-069);
// this is the token store the App reads to decide `unauthenticated`, and that a 401 clears — so a
// revoked/expired session can never leave stale data on screen.
//
// The store is a thin, guarded wrapper over persistent storage so it degrades cleanly where storage is
// unavailable (private mode / no localStorage): every accessor is try/caught and never throws.

export interface AuthSession {
  /** The active bearer, or null when there is no session. */
  getToken(): string | null;
  /** Persist a bearer after a successful login (the login flow is a follow-up, REQ-069). */
  setToken(token: string): void;
  /** Drop the session — called on 401 so no stale data survives an expired/revoked token. */
  clear(): void;
}

const STORAGE_KEY = "shuddl.driver.session.token";

type TokenStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStore(): TokenStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage blocked (e.g. private mode) — the app runs, just without persistence
  }
}

export function createAuthSession(store: TokenStore | null = defaultStore()): AuthSession {
  return {
    getToken(): string | null {
      try {
        return store?.getItem(STORAGE_KEY) ?? null;
      } catch {
        return null;
      }
    },
    setToken(token: string): void {
      try {
        store?.setItem(STORAGE_KEY, token);
      } catch {
        /* best-effort persistence */
      }
    },
    clear(): void {
      try {
        store?.removeItem(STORAGE_KEY);
      } catch {
        /* best-effort */
      }
    },
  };
}
