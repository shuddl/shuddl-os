// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

// §859 — THE HOOK'S HEADER STATES THREE GUARANTEES; NOTHING ENFORCED THEM.
//
// `useSync.ts` says, in prose: "It NEVER promises background continuity: it syncs only while visible, online,
// and authenticated." Three refusals, each one line of code, each the difference between a truthful status
// and a lie told to a driver holding a phone. §848 pinned `classifyStatus` and §849 the transport — the two
// layers UNDER this one — while the orchestration between them had no test at all (§858 named it).
//
// A comment stating a guarantee is a missing test: prose cannot fail. Deleting any of the three refusals
// leaves every other driver suite green, and the failure is invisible on a desk — a developer's browser is
// visible, online and authenticated, so all three guards are satisfied at once and their absence never shows.
// The conditions only diverge in a truck.
//
// Mocked at the module seam, not below it: the point is what the HOOK decides to call, so `syncOnce` is a spy
// and the assertion is whether it was reached.

const syncOnce = vi.fn(async () => ({ authBlocked: false, parked: 0 }));
const clear = vi.fn();
const getToken = vi.fn<() => string | null>(() => "tok");
const pendingCount = vi.fn(async () => 2);

vi.mock("@shuddl/driver-core/sync", () => ({
  syncOnce: (...a: unknown[]) => syncOnce(...(a as [])),
  DEFAULT_BACKOFF: { baseMs: 1, maxMs: 2, jitter: 0 },
}));
vi.mock("../session.js", () => ({
  getSession: async () => ({ queue: { kind: "fake-queue" } }),
  pendingCount: () => pendingCount(),
}));
vi.mock("../auth/session.js", () => ({ createAuthSession: () => ({ getToken, clear }) }));
vi.mock("../api/base.js", () => ({ apiBase: () => "https://api.example.test" }));
vi.mock("./transport.js", () => ({
  createTransports: () => ({ sendEvent: vi.fn(), sendEvidence: vi.fn() }),
}));

const { useSync } = await import("./useSync.js");

/** Override a getter jsdom defines as read-only (`visibilityState`, `onLine`). */
function stub(target: object, prop: string, value: unknown): void {
  Object.defineProperty(target, prop, { configurable: true, get: () => value });
}

beforeEach(() => {
  vi.clearAllMocks();
  getToken.mockReturnValue("tok");
  syncOnce.mockResolvedValue({ authBlocked: false, parked: 0 });
  stub(document, "visibilityState", "visible");
  stub(navigator, "onLine", true);
});

afterEach(cleanup);

describe("§859: useSync syncs only while visible, online and authenticated (REQ-016/017/030)", () => {
  it("all three satisfied: a pass runs and the status reports what the engine returned", async () => {
    // Non-vacuity for every refusal below. Without this, a hook that never syncs at all would satisfy the
    // three negative cases perfectly — the §858 shape, where blinding the instrument left the negatives green.
    syncOnce.mockResolvedValue({ authBlocked: false, parked: 3 });
    const { result } = renderHook(() => useSync({ intervalMs: 60_000 }));

    await waitFor(() => expect(syncOnce).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.pending).toBe(2));
    expect(result.current.parked, "parked evidence must surface — it used to be invisible").toBe(3);
    expect(result.current.syncing).toBe(false);
    expect(result.current.lastError).toBeNull();
  });

  it("HIDDEN: a backgrounded app does not sync — the hook promises no background continuity", async () => {
    stub(document, "visibilityState", "hidden");
    renderHook(() => useSync({ intervalMs: 60_000 }));

    await act(async () => {});
    expect(syncOnce, "a hidden document must not drain the queue").not.toHaveBeenCalled();
  });

  it("OFFLINE: captures stay queued rather than being spent against a dead network", async () => {
    stub(navigator, "onLine", false);
    renderHook(() => useSync({ intervalMs: 60_000 }));

    await act(async () => {});
    expect(syncOnce).not.toHaveBeenCalled();
  });

  it("UNAUTHENTICATED: no token, no send — and no request is spent discovering that", async () => {
    getToken.mockReturnValue(null);
    renderHook(() => useSync({ intervalMs: 60_000 }));

    await act(async () => {});
    expect(syncOnce).not.toHaveBeenCalled();
  });

  it("a 401 CLEARS the session, so no stale sheet survives a revoked driver", async () => {
    // The honest-by-construction claim in the header. If the clear were dropped, the driver would keep a
    // day sheet the server has already refused to serve.
    syncOnce.mockResolvedValue({ authBlocked: true, parked: 0 });
    const { result } = renderHook(() => useSync({ intervalMs: 60_000 }));

    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.authBlocked).toBe(true));
  });

  it("a throwing pass surfaces lastError and releases the lock (syncing never latches on)", async () => {
    // `syncing: true` is set before the await. If the catch failed to clear it, the UI would show a
    // permanent spinner and the in-flight guard would be the only thing standing between that and a lie.
    syncOnce.mockRejectedValue(new Error("queue read failed"));
    const { result } = renderHook(() => useSync({ intervalMs: 60_000 }));

    await waitFor(() => expect(result.current.lastError).toBe("queue read failed"));
    expect(result.current.syncing, "a failed pass must not leave the UI spinning").toBe(false);
  });

  it("ENABLED=false is a real off switch", async () => {
    renderHook(() => useSync({ enabled: false, intervalMs: 60_000 }));
    await act(async () => {});
    expect(syncOnce).not.toHaveBeenCalled();
  });

  it("UNMOUNT detaches the listeners — asserted on the REMOVAL, not on the silence it causes", async () => {
    // MEASURED (§859): deleting `window.removeEventListener` from the cleanup left this test GREEN when it
    // asserted only that no further pass ran. That silence is produced by a SIBLING GUARD — the cleanup also
    // sets `cancelled = true`, and `runPass` returns on it at its first line — so a leaked handler still
    // fires, still runs, and still does nothing observable. The behavioural assertion cannot see the leak;
    // it is a real one (a handler outliving every driver screen), so the removal itself is what gets pinned.
    const offWin = vi.spyOn(window, "removeEventListener");
    const offDoc = vi.spyOn(document, "removeEventListener");
    const { unmount } = renderHook(() => useSync({ intervalMs: 60_000 }));
    await waitFor(() => expect(syncOnce).toHaveBeenCalledTimes(1));

    unmount();

    expect(offWin.mock.calls.map((c) => c[0]), "the online handler must be detached").toContain("online");
    expect(offDoc.mock.calls.map((c) => c[0]), "the visibility handler must be detached").toContain(
      "visibilitychange",
    );

    // And the behaviour the removal exists for, kept as the weaker second half.
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(syncOnce, "an unmounted hook must not answer network events").toHaveBeenCalledTimes(1);
  });

  it("a reconnect while MOUNTED does drain (the listener is real, not merely detached correctly)", async () => {
    // Pairs with the unmount case: proves the previous test's silence came from the cleanup, not from a
    // listener that never worked. Two tests, one claim.
    renderHook(() => useSync({ intervalMs: 60_000 }));
    await waitFor(() => expect(syncOnce).toHaveBeenCalledTimes(1));

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(syncOnce).toHaveBeenCalledTimes(2));
  });
});
