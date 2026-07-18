import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventInput } from "@shuddl/contracts";
import { commands, COMMAND_COUNT, type Command, type CommandDeps } from "./registry.js";
import { ApiError, get, post } from "../lib/api.js";
import { resolveRoute } from "../router.js";

// WP-10 Task 10 (REQ-081) — the ⌘K command palette is a DETERMINISTIC registry: a FIXED set of ~20 canonical
// commands the operator filters/selects (no LLM, no NL parse — REQ-024). Each command either NAVIGATES (the
// Task-8 router vocabulary), OPENS a surface (the shipment lens / the CSR intake flow — Task 11 owns the flow),
// or DISPATCHES a real API verb through the Task-8 client (which attaches a FRESH Idempotency-Key per mutation).
// These tests pin the registry: exactly 20 commands, each mapping to a REAL verb/route, dispatching honestly.

// The router's real navigation vocabulary (resolveRoute) — board is "/", the three queues, the KPI drills, copilot.
const REAL_NAV = new Set([
  "/",
  "/queue/approvals",
  "/queue/exceptions",
  "/queue/money",
  "/kpi",
  "/kpi/dso",
  "/kpi/or",
  "/kpi/otd",
  "/kpi/unbilled",
  "/kpi/dwell",
  "/copilot",
]);

// The real API mutation verbs (workers/api/src/routes/*): the pricing gate, the two portal/intake seams,
// the blessed approval-decision, the generic events append (appointment.set / dispatch.assigned), the copilot.
const REAL_POST = new Set([
  "/v1/rate",
  "/v1/shipments/:id/accept-quote",
  "/v1/shipments/:id/approval-decision",
  "/v1/shipments/:id/events",
  "/v1/copilot/ask",
]);

// A recording deps double: capture every seam the command reaches so a test asserts the RIGHT verb/route fired.
function recordingDeps(overrides?: Partial<CommandDeps>): {
  deps: CommandDeps;
  posts: Array<{ path: string; body: unknown }>;
  navs: string[];
  shipments: string[];
  intakes: number;
} {
  const posts: Array<{ path: string; body: unknown }> = [];
  const navs: string[] = [];
  const shipments: string[] = [];
  const state = { intakes: 0 };
  const deps: CommandDeps = {
    navigate: (p) => navs.push(p),
    openShipment: (id) => shipments.push(id),
    openIntake: () => {
      state.intakes += 1;
    },
    api: {
      post: async <T>(path: string, body?: unknown): Promise<T> => {
        posts.push({ path, body });
        return {} as T;
      },
      get: async <T>(_path: string): Promise<T> => ({}) as T,
    },
    ...overrides,
  };
  return {
    deps,
    posts,
    navs,
    shipments,
    get intakes() {
      return state.intakes;
    },
  };
}

// Fill a command's args with a plausible structured value per key so run() can build its request in the
// generic "every command maps to a real target" sweep.
function fillArgs(cmd: Command): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of cmd.args) {
    if (a.key.endsWith("_ts")) out[a.key] = "1720000000000";
    else if (a.key === "leg_kind") out[a.key] = "pickup";
    else if (a.key === "weight_lb") out[a.key] = "1200";
    else out[a.key] = `X-${a.key}`;
  }
  return out;
}

describe("command registry (REQ-081) — the deterministic ⌘K palette", () => {
  it("registers EXACTLY 20 canonical commands (the DoD), with unique ids", () => {
    expect(COMMAND_COUNT).toBe(20);
    expect(commands.length).toBe(20);
    expect(new Set(commands.map((c) => c.id)).size).toBe(20);
  });

  it("every command maps to a REAL verb or route (never an invented one)", () => {
    for (const cmd of commands) {
      switch (cmd.target.kind) {
        case "navigate":
          expect(REAL_NAV.has(cmd.target.path), `${cmd.id} → ${cmd.target.path}`).toBe(true);
          break;
        case "post":
          expect(REAL_POST.has(cmd.target.path), `${cmd.id} → ${cmd.target.path}`).toBe(true);
          break;
        case "shipment":
        case "intake":
          break; // an in-app seam (the lens / the CSR intake flow), not a URL
        default:
          throw new Error(`${cmd.id} has no real target`);
      }
    }
  });

  it("the queue/kpi/copilot navigation targets resolve to real router screens (not the board fallback)", () => {
    const byId = (id: string): Command => {
      const c = commands.find((x) => x.id === id);
      if (!c) throw new Error(`no command ${id}`);
      return c;
    };
    const pathOf = (id: string): string => {
      const t = byId(id).target;
      if (t.kind !== "navigate") throw new Error(`${id} is not a navigation`);
      return t.path;
    };
    expect(resolveRoute({ pathname: pathOf("go.approvals"), search: "", hash: "" })).toEqual({ name: "queue", kind: "approvals" });
    expect(resolveRoute({ pathname: pathOf("go.money"), search: "", hash: "" })).toEqual({ name: "queue", kind: "money" });
    expect(resolveRoute({ pathname: pathOf("go.kpi.dso"), search: "", hash: "" })).toEqual({ name: "kpi", metric: "dso" });
    expect(resolveRoute({ pathname: pathOf("go.copilot"), search: "", hash: "" })).toEqual({ name: "copilot" });
  });

  it("a navigation command calls deps.navigate with the canonical route path", async () => {
    const r = recordingDeps();
    const board = commands.find((c) => c.id === "go.board");
    await board?.run({}, r.deps);
    expect(r.navs).toContain("/");
    const money = commands.find((c) => c.id === "go.money");
    await money?.run({}, r.deps);
    expect(r.navs).toContain("/queue/money");
  });

  it("open-shipment opens the lens; new-order OPENS the CSR intake flow (Task 11 owns the flow)", async () => {
    const r = recordingDeps();
    await commands.find((c) => c.id === "open.shipment")?.run({ shipment_id: "SHP-1" }, r.deps);
    expect(r.shipments).toEqual(["SHP-1"]);
    expect(r.posts).toHaveLength(0); // the palette does NOT build the intake itself
    await commands.find((c) => c.id === "new.order")?.run({}, r.deps);
    expect(r.intakes).toBe(1);
  });

  it("Quote a Shipment dispatches POST /v1/rate; a blank weight stays UNKNOWN (no price on air)", async () => {
    const r = recordingDeps();
    await commands.find((c) => c.id === "quote.shipment")?.run(
      { shipment_id: "SHP-1", origin_zip: "07001", dest_zip: "30301", weight_lb: "" },
      r.deps,
    );
    expect(r.posts[0]?.path).toBe("/v1/rate");
    const body = r.posts[0]?.body as Record<string, unknown>;
    expect(body.shipment_id).toBe("SHP-1");
    expect(body.weight_lb).toBeUndefined(); // blank ⇒ omitted ⇒ server returns UNKNOWN, never a fabricated price
  });

  it("Approve and Deny post the RIGHT decision to the blessed approval-decision route", async () => {
    const r = recordingDeps();
    await commands.find((c) => c.id === "approve.approval")?.run({ shipment_id: "SHP-9" }, r.deps);
    await commands.find((c) => c.id === "deny.approval")?.run({ shipment_id: "SHP-9" }, r.deps);
    expect(r.posts[0]?.path).toBe("/v1/shipments/SHP-9/approval-decision");
    expect((r.posts[0]?.body as { decision: string }).decision).toBe("approved");
    expect((r.posts[1]?.body as { decision: string }).decision).toBe("denied");
  });

  it("Accept a Quote posts the shipment's accept-quote with the quote_event_id", async () => {
    const r = recordingDeps();
    await commands.find((c) => c.id === "accept.quote")?.run({ shipment_id: "SHP-2", quote_event_id: "evt-7" }, r.deps);
    expect(r.posts[0]?.path).toBe("/v1/shipments/SHP-2/accept-quote");
    expect((r.posts[0]?.body as { quote_event_id: string }).quote_event_id).toBe("evt-7");
  });

  it("Schedule Appointment builds a SCHEMA-VALID appointment.set EventInput for the events route", async () => {
    const r = recordingDeps();
    await commands.find((c) => c.id === "schedule.appointment")?.run(
      {
        shipment_id: "SHP-3",
        leg_kind: "delivery",
        facility_id: "fac-1",
        slot_key: "slot-9",
        window_start_ts: "1720000000000",
        window_end_ts: "1720003600000",
        actor_party: "p:carrier",
      },
      r.deps,
    );
    expect(r.posts[0]?.path).toBe("/v1/shipments/SHP-3/events");
    // The built body parses as a real EventInput (deterministic, no fabrication) — the strongest "real verb" proof.
    const parsed = EventInput.parse(r.posts[0]?.body);
    expect(parsed.kind).toBe("appointment.set");
    expect(parsed.source).toBe("native");
  });

  it("Dispatch to Driver builds a SCHEMA-VALID dispatch.assigned EventInput", async () => {
    const r = recordingDeps();
    await commands.find((c) => c.id === "dispatch.driver")?.run(
      { shipment_id: "SHP-4", actor_party: "p:carrier", driver_user_id: "u:driver" },
      r.deps,
    );
    expect(r.posts[0]?.path).toBe("/v1/shipments/SHP-4/events");
    const parsed = EventInput.parse(r.posts[0]?.body);
    expect(parsed.kind).toBe("dispatch.assigned");
  });

  it("Ask the Copilot posts /v1/copilot/ask and reflects an ABSTENTION honestly (never a fabricated answer)", async () => {
    const r = recordingDeps({
      api: {
        post: async <T>(): Promise<T> => ({ text: "", citations: [], abstained: true }) as T,
        get: async <T>(): Promise<T> => ({}) as T,
      },
    });
    const out = await commands.find((c) => c.id === "copilot.ask")?.run({ question: "what is the DSO?" }, r.deps);
    expect(out?.ok).toBe(true);
    expect(out?.message.toLowerCase()).toContain("abstain");
  });

  it("a gate-block / 403 surfaces the HONEST server code — never a false success", async () => {
    const r = recordingDeps({
      api: {
        post: async <T>(): Promise<T> => {
          throw new ApiError("FORBIDDEN", 403, "YOUR ROLE DOES NOT SATISFY THIS APPROVAL'S REQUIRED ROLE");
        },
        get: async <T>(): Promise<T> => ({}) as T,
      },
    });
    const out = await commands.find((c) => c.id === "approve.approval")?.run({ shipment_id: "SHP-9" }, r.deps);
    expect(out?.ok).toBe(false);
    expect(out?.message).toContain("FORBIDDEN");
  });
});

// Prove the Idempotency-Key discipline end-to-end: a command that dispatches THROUGH the real api client
// (not the double) makes the client attach a fresh Idempotency-Key header on the mutation (REQ-156).
describe("command registry — mutations carry a fresh Idempotency-Key via the real api client", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("Approve dispatched through the real post() attaches an Idempotency-Key and the right verb", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const deps: CommandDeps = {
      navigate: () => {},
      openShipment: () => {},
      openIntake: () => {},
      api: { post, get },
    };
    await commands.find((c) => c.id === "approve.approval")?.run({ shipment_id: "SHP-9" }, deps);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url.endsWith("/v1/shipments/SHP-9/approval-decision")).toBe(true);
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBeTruthy();
  });
});
