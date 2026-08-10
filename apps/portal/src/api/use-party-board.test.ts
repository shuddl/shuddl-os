import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

// §864 — THE BOARD HOOK'S HONESTY STATES, WHICH ARE THE WHOLE POINT OF IT.
//
// §863 pinned the parse under this hook and named the state machine above it as still untested. Its contract
// is not "fetch a board" — it is a set of refusals, written out in its own docblock: "It NEVER falls back to
// synthetic data: a failure keeps the last-known marks (stale) or, on a cold failure, shows unavailable — the
// map is only ever the server's truth or an honest gap."
//
// Four states carrying four different claims to a party looking at their freight:
//   ready + empty=false  these are your shipments, as of the SERVER's stamp
//   ready + empty=true   you have none — an honest empty board, not a fabricated fleet
//   ready + stale=true   these were true; the last refresh failed; nothing here is invented
//   unavailable          we have nothing and will not pretend otherwise
//
// A wrong transition here does not crash anything. It shows a party a fleet that is not theirs to see, or an
// empty board that is really an outage — which is why "no defect found" is not a reason to leave it unpinned.
//
// FAKE TIMERS, DELIBERATELY AND ONLY HERE. §862's lesson was that "this needs timers" is a claim worth
// checking, so: two of these cases assert that a poll was NOT scheduled (the 401 stop, the unmount), and
// scheduling is invisible without controlling time — you cannot distinguish "scheduled, not yet fired" from
// "never scheduled" by waiting. The other cases would run fine without them.

const get = vi.fn();
vi.mock("../lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/api.js")>("../lib/api.js");
  return { ...actual, get: (...a: unknown[]) => get(...a) };
});

const { usePartyBoard, BOARD_POLL_MS } = await import("./board.js");
const { ApiError } = await import("../lib/api.js");

const ITEM = { shipment_id: "SHP-1", lat_e6: 39_739_236, lon_e6: -104_990_251, status: "healthy" };
const ok = (items: unknown[] = [ITEM]) => ({ board: items, as_of: 1_700_000_000_000 });

/** Advance past one poll interval, flushing the promises each tick creates. */
const nextPoll = () => act(async () => void (await vi.advanceTimersByTimeAsync(BOARD_POLL_MS + 1)));

beforeEach(() => {
  // `shouldAdvanceTime` is load-bearing, not decoration: with frozen fake timers `waitFor` polls on a clock
  // that never moves, so every case in this file timed out at 5s on the first run. Auto-advance keeps
  // real-time helpers alive while `advanceTimersByTimeAsync` still controls the 20s poll explicitly — the
  // auto-advance rate is milliseconds per tick and cannot reach BOARD_POLL_MS on its own.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  get.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("§864: usePartyBoard shows the server's truth or an honest gap — never synthetic data (REQ-073/025)", () => {
  it("READY: a good load carries the items and the SERVER's freshness stamp", async () => {
    get.mockResolvedValue(ok());
    const { result } = renderHook(() => usePartyBoard("P-1", vi.fn()));

    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.asOf, "the stamp is the server's, never the browser clock").toBe(1_700_000_000_000);
    expect(result.current.stale).toBe(false);
    expect(result.current.empty).toBe(false);
  });

  it("EMPTY: zero marks is a ready state, not a failure and not a fabricated fleet", async () => {
    get.mockResolvedValue(ok([]));
    const { result } = renderHook(() => usePartyBoard("P-1", vi.fn()));

    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(result.current.empty, "an honest empty board").toBe(true);
    expect(result.current.items).toEqual([]);
  });

  it("UNAVAILABLE: a COLD failure shows a gap and invents nothing", async () => {
    get.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => usePartyBoard("P-1", vi.fn()));

    await waitFor(() => expect(result.current.phase).toBe("unavailable"));
    expect(result.current.items, "no synthetic fallback, ever").toEqual([]);
    expect(result.current.asOf).toBeNull();
  });

  it("STALE: a WARM failure keeps the last-known marks and says so", async () => {
    // The distinction the whole hook exists for: the same error produces `unavailable` cold and `stale` warm,
    // because a party staring at a map deserves last-known-and-labelled over a blank screen.
    get.mockResolvedValueOnce(ok());
    const { result } = renderHook(() => usePartyBoard("P-1", vi.fn()));
    await waitFor(() => expect(result.current.phase).toBe("ready"));

    get.mockRejectedValue(new Error("network down"));
    await nextPoll();

    expect(result.current.phase, "still ready — the marks are real, just old").toBe("ready");
    expect(result.current.stale).toBe(true);
    expect(result.current.items, "last-known marks RETAINED").toHaveLength(1);
    expect(result.current.asOf, "and stamped with when they were true").toBe(1_700_000_000_000);
  });

  it("RECOVERY: a later success clears stale rather than latching it", async () => {
    get.mockResolvedValueOnce(ok());
    const { result } = renderHook(() => usePartyBoard("P-1", vi.fn()));
    await waitFor(() => expect(result.current.phase).toBe("ready"));

    get.mockRejectedValueOnce(new Error("blip"));
    await nextPoll();
    expect(result.current.stale).toBe(true);

    get.mockResolvedValue({ ...ok(), as_of: 1_700_000_099_000 });
    await nextPoll();
    expect(result.current.stale, "a recovered board is not stale").toBe(false);
    expect(result.current.asOf).toBe(1_700_000_099_000);
  });

  // `isAuthError` is `status === 401 || code === "UNAUTHORIZED"` — a disjunction, so both branches are driven.
  // MEASURED (§864): the first draft passed the constructor's arguments in the wrong ORDER
  // (`code, message, status` instead of `code, status, message`) and still went green, because the misplaced
  // code alone satisfied the second branch. It was correct for the wrong reason and exercised one side only;
  // `typecheck` caught the order, and the disjunction is the reason this is now a table.
  it.each([
    ["a 401 status", () => new ApiError("BAD_RESPONSE", 401, "unauthorized")],
    ["an UNAUTHORIZED code", () => new ApiError("UNAUTHORIZED" as never, 403, "unauthorized")],
  ])("401 via %s: hands off to onAuthError and STOPS polling — no loop against a dead session", async (_l, mk) => {
    // A 401 that kept polling would hammer the API on every revoked session, and each response would re-trigger
    // the same handoff. The `return` before the reschedule is the whole guard.
    get.mockRejectedValue(mk());
    const onAuthError = vi.fn();
    renderHook(() => usePartyBoard("P-1", onAuthError));

    await waitFor(() => expect(onAuthError).toHaveBeenCalledTimes(1));
    expect(get).toHaveBeenCalledTimes(1);

    await nextPoll();
    await nextPoll();
    expect(get, "a 401 must not reschedule").toHaveBeenCalledTimes(1);
    expect(onAuthError).toHaveBeenCalledTimes(1);
  });

  it("a NON-auth failure DOES keep polling (so the 401 stop is a stop, not a dead loop)", async () => {
    // Pairs with the case above. Without it, a hook that stopped polling on every error would satisfy the
    // "must not reschedule" assertion perfectly while silently never recovering from a blip.
    get.mockRejectedValue(new Error("blip"));
    renderHook(() => usePartyBoard("P-1", vi.fn()));

    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await nextPoll();
    expect(get.mock.calls.length, "a transient failure must retry").toBeGreaterThan(1);
  });

  it("UNMOUNT stops the loop — no poll and no setState survives the screen", async () => {
    get.mockResolvedValue(ok());
    const { result, unmount } = renderHook(() => usePartyBoard("P-1", vi.fn()));
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    const seen = get.mock.calls.length;

    unmount();
    await nextPoll();
    await nextPoll();
    expect(get, "an unmounted board must not keep polling").toHaveBeenCalledTimes(seen);
  });
});
