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
        // SAFE TODAY, AND HERE IS WHAT ENDS THAT (audit §182). Swallowing means a storage that reads but
        // refuses to write leaves the token behind while the caller believes the session was dropped —
        // fail-OPEN, unlike getToken (returns null) and setToken (loses persistence, keeps nothing stale).
        // It is harmless only because BOTH call sites are 401 handlers (App.tsx:95, sync/useSync.ts:75):
        // the server has already rejected that token, so a surviving copy is stale, not usable.
        //
        // THE TRIGGER: the moment a VOLUNTARY logout exists — REQ-069's magic-link/PIN login screen is the
        // named follow-up in this file's header — `clear()` starts being asked to drop a token the server
        // still honours, on a device drivers share. Then this catch must verify the removal (read back,
        // overwrite, and surface a failure) instead of assuming it.
      }
    },
  };
}
