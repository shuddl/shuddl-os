import { useEffect, useState } from "react";
import { syncOnce, DEFAULT_BACKOFF } from "@shuddl/driver-core/sync";
import { getSession, pendingCount } from "../session.js";
import { createAuthSession, type AuthSession } from "../auth/session.js";
import { createTransports } from "./transport.js";

// Task 11 (REQ-016/017/030) — the React seam that DRAINS the durable offline queue. It runs the pure sync
// engine (@shuddl/driver-core/sync) over the device's OfflineQueue on a bounded interval + on reconnect /
// return-to-foreground. It NEVER promises background continuity: it syncs only while visible, online, and
// authenticated. A 401 clears the session (honest-by-construction — no stale sheet survives). Feature-
// detects IndexedDB so it is inert where there is no durable queue (a non-browser/test environment).

export interface SyncStatus {
  /** Captures still awaiting sync. */
  pending: number;
  syncing: boolean;
  /** A 401 halted the loop; the session was cleared. */
  authBlocked: boolean;
  lastError: string | null;
}

export interface UseSyncOptions {
  /** The driver's auth session (bearer + clear-on-401). Defaults to the persistent store. */
  session?: AuthSession;
  /** The API origin. Same-origin by default. */
  baseUrl?: string;
  /** Poll cadence in ms (bounded, truthful — not a background guarantee). */
  intervalMs?: number;
  /** Off switch (tests / a signed-out screen). */
  enabled?: boolean;
}

const IDLE: SyncStatus = { pending: 0, syncing: false, authBlocked: false, lastError: null };

export function useSync(options: UseSyncOptions = {}): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>(IDLE);

  useEffect(() => {
    const enabled = options.enabled ?? true;
    // No durable queue (no IndexedDB) ⇒ nothing to drain; also keeps the hook inert under test/SSR.
    if (!enabled || typeof indexedDB === "undefined") return;

    const session = options.session ?? createAuthSession();
    const baseUrl = options.baseUrl ?? "";
    const intervalMs = options.intervalMs ?? 15_000;
    const transports = createTransports({ baseUrl, getToken: () => session.getToken() });
    let cancelled = false;
    let running = false;

    const runPass = async (): Promise<void> => {
      if (cancelled || running) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return; // FOREGROUND only
      if (typeof navigator !== "undefined" && navigator.onLine === false) return; // offline — stay queued
      if (!session.getToken()) return; // no session — nothing to send (the UI shows unauthenticated)
      running = true;
      setStatus((s) => ({ ...s, syncing: true }));
      try {
        const s = await getSession();
        const pass = await syncOnce({
          queue: s.queue,
          now: () => Date.now(),
          random: () => Math.random(),
          sendEvent: transports.sendEvent,
          sendEvidence: transports.sendEvidence,
          backoff: DEFAULT_BACKOFF,
        });
        const pending = await pendingCount();
        if (pass.authBlocked) session.clear(); // a 401 drops the session — no stale data survives
        if (!cancelled) setStatus({ pending, syncing: false, authBlocked: pass.authBlocked, lastError: null });
      } catch (e) {
        if (!cancelled) setStatus((st) => ({ ...st, syncing: false, lastError: e instanceof Error ? e.message : "sync error" }));
      } finally {
        running = false;
      }
    };

    void runPass();
    const timer = setInterval(() => void runPass(), intervalMs);
    const onOnline = (): void => void runPass();
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void runPass();
    };
    if (typeof window !== "undefined") window.addEventListener("online", onOnline);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(timer);
      if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    };
  }, [options.session, options.baseUrl, options.intervalMs, options.enabled]);

  return status;
}
