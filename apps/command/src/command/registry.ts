// WP-10 Task 10 (REQ-081) — the ⌘K command palette REGISTRY. A FIXED, typed set of ~20 canonical commands the
// operator filters and selects (VS-Code-style). This is DETERMINISTIC by law: there is NO LLM and NO natural-
// language parse anywhere here — a command is picked, its STRUCTURED args are supplied, and it fires. (Any future
// NL "type what you want" parse would be an agents-port living ONLY in packages/agents — REQ-024, statically
// linted — never in this surface.)
//
// Each command declares a `target` (its real destination — a router route, an in-app seam, or an API verb) and a
// `run(args, deps)` that performs it through the Task-8 seams:
//   • NAVIGATE — deps.navigate(path) over the router's real vocabulary (board / the three queues / a KPI drill /
//     copilot). resolveRoute already knows every one of these paths.
//   • OPEN — deps.openShipment(id) opens the shipment lens on the map home; deps.openIntake() OPENS the CSR intake
//     flow (Task 11 owns the multi-step flow itself — the palette only launches it, keeping the boundary clean).
//   • DISPATCH — deps.api.post(verb, body). The Task-8 api client attaches a FRESH Idempotency-Key to every
//     mutation (REQ-156) and surfaces a non-2xx as a typed ApiError, so run() can reflect the HONEST server state
//     (a 403 gate-block, a 422, a HELD booking) — NEVER a fabricated success.
import { ApiError } from "../lib/api.js";

/** The narrow api seam a command dispatches through (the Task-8 client's post/get — the client owns the key). */
export interface CommandApi {
  post<T>(path: string, body?: unknown): Promise<T>;
  get<T>(path: string): Promise<T>;
}

/** Everything a command can reach. Injected so the registry stays PURE and fully testable with doubles. */
export interface CommandDeps {
  /** Change the route (the Task-8 router vocabulary): board "/", the queues, the KPI drills, copilot. */
  navigate(path: string): void;
  /** Open a shipment's lens on the map home (the map IS the home — REQ-073/080). */
  openShipment(shipmentId: string): void;
  /** OPEN the CSR net-new intake flow. Task 11 builds the multi-step flow; this only launches it. */
  openIntake(): void;
  /** The api client (post attaches a fresh Idempotency-Key per mutation). */
  api: CommandApi;
}

/** The result a command reflects into the palette — HONEST: a gate-block/hold is `ok:false` with the real reason. */
export interface CommandOutcome {
  ok: boolean;
  message: string;
}

/** One structured argument the palette prompts for (a simple field — NEVER a free-text NL box). */
export interface CommandArg {
  key: string;
  label: string;
  placeholder?: string;
}

/** Where a command goes — used by the palette to decide whether to reflect a result (post) or just close (nav/seam). */
export type CommandTarget =
  | { kind: "navigate"; path: string }
  | { kind: "shipment" }
  | { kind: "intake" }
  | { kind: "post"; path: string };

/** The palette's display groups. */
export type CommandSection = "GO TO" | "INTAKE + QUOTE" | "SCHEDULE + DISPATCH" | "APPROVALS" | "COPILOT";

export interface Command {
  id: string;
  label: string;
  section: CommandSection;
  target: CommandTarget;
  args: readonly CommandArg[];
  run(args: Readonly<Record<string, string>>, deps: CommandDeps): CommandOutcome | Promise<CommandOutcome>;
}

const OK = (message: string): CommandOutcome => ({ ok: true, message });
const FAIL = (message: string): CommandOutcome => ({ ok: false, message });

// A server failure, reflected HONESTLY: the stable ErrorCode (+ its message). A gate-block (403 FORBIDDEN), a
// 422 VALIDATION_FAILED, a 409, a HELD booking — the operator sees the real reason, never a false "done".
function honest(e: unknown): CommandOutcome {
  if (e instanceof ApiError) return FAIL(e.message ? `${e.code} — ${e.message}` : e.code);
  return FAIL("REQUEST FAILED");
}

// Run a mutation and reflect it honestly. Success is a plain confirmation; any throw becomes the honest failure.
async function dispatch(effect: () => Promise<unknown>, okMessage: string): Promise<CommandOutcome> {
  try {
    await effect();
    return OK(okMessage);
  } catch (e) {
    return honest(e);
  }
}

// A navigation command — go to a real router route. Nothing is dispatched; the palette closes on success.
function nav(id: string, label: string, path: string, section: CommandSection = "GO TO"): Command {
  return {
    id,
    label,
    section,
    target: { kind: "navigate", path },
    args: [],
    run: (_args, deps) => {
      deps.navigate(path);
      return OK(`→ ${label}`);
    },
  };
}

// Full confidence — a deterministic client-composed fact (Bps 0..10000), mirroring rate.ts/approvals.ts.
const FULL_CONFIDENCE = 10_000;

// Build a client-suppliable EventInput envelope for the generic events route. The DO owns seq/hash/prev_hash/
// visibility; the client supplies the id (a fresh uuid), the actor, and the typed payload. `source: "native"`
// marks a first-party console action. No signature/device — a command action is not a device-namespaced capture.
function eventInput(kind: string, payload: unknown, actorParty: string): unknown {
  return {
    id: crypto.randomUUID(),
    ts: Date.now(),
    actor: { party: actorParty },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: FULL_CONFIDENCE,
    kind,
    payload,
  };
}

const shipmentPath = (id: string, suffix: string): string => `/v1/shipments/${encodeURIComponent(id)}${suffix}`;

// An approval decision (approve / deny) through the BLESSED approval-decision route — the ONLY home for
// approval.decided (REQ-194); the server enforces the matrix required_role, so a wrong-role caller gets a 403
// the palette reflects honestly.
function decisionCommand(id: string, label: string, decision: "approved" | "denied"): Command {
  return {
    id,
    label,
    section: "APPROVALS",
    target: { kind: "post", path: "/v1/shipments/:id/approval-decision" },
    args: [{ key: "shipment_id", label: "SHIPMENT ID" }],
    run: (a, deps) =>
      dispatch(
        () => deps.api.post(shipmentPath(a.shipment_id ?? "", "/approval-decision"), { decision }),
        decision === "approved" ? "APPROVAL RECORDED — APPROVED" : "APPROVAL RECORDED — DENIED",
      ),
  };
}

// ── THE 20 CANONICAL COMMANDS ───────────────────────────────────────────────────────────────────────────────
export const commands: readonly Command[] = [
  // NAVIGATION (the router vocabulary) — board, the three queues, the KPI strip + per-KPI drills, copilot.
  nav("go.board", "Go to Board", "/"),
  nav("go.approvals", "Go to Approvals", "/queue/approvals"),
  nav("go.exceptions", "Go to Exceptions", "/queue/exceptions"),
  nav("go.money", "Go to Money", "/queue/money"),
  nav("go.kpis", "Go to KPI Strip", "/kpi"),
  nav("go.kpi.dso", "Open KPI: DSO", "/kpi/dso"),
  nav("go.kpi.or", "Open KPI: Cost/Rev Ratio", "/kpi/or"),
  nav("go.kpi.otd", "Open KPI: On-Time Delivery", "/kpi/otd"),
  nav("go.kpi.unbilled", "Open KPI: Unbilled PODs", "/kpi/unbilled"),
  nav("go.kpi.dwell", "Open KPI: Avg Dwell", "/kpi/dwell"),
  nav("go.copilot", "Open Copilot", "/copilot", "COPILOT"),

  // OPEN a shipment's lens by id (the map home selection).
  {
    id: "open.shipment",
    label: "Open Shipment by ID",
    section: "GO TO",
    target: { kind: "shipment" },
    args: [{ key: "shipment_id", label: "SHIPMENT ID" }],
    run: (a, deps) => {
      const id = (a.shipment_id ?? "").trim();
      if (!id) return FAIL("SHIPMENT ID REQUIRED");
      deps.openShipment(id);
      return OK(`OPENED ${id}`);
    },
  },

  // INTAKE — the palette LAUNCHES the CSR intake flow; Task 11 builds the multi-step flow itself.
  {
    id: "new.order",
    label: "New Order (CSR Intake)",
    section: "INTAKE + QUOTE",
    target: { kind: "intake" },
    args: [],
    run: (_a, deps) => {
      deps.openIntake();
      return OK("INTAKE OPENED");
    },
  },

  // QUOTE a shipment — the server-side pricing gate. A blank weight stays absent ⇒ the engine returns UNKNOWN
  // (no price on air, Law 4); a provided weight must be a positive integer (integer canonical law).
  {
    id: "quote.shipment",
    label: "Quote a Shipment",
    section: "INTAKE + QUOTE",
    target: { kind: "post", path: "/v1/rate" },
    args: [
      { key: "shipment_id", label: "SHIPMENT ID" },
      { key: "origin_zip", label: "ORIGIN ZIP" },
      { key: "dest_zip", label: "DEST ZIP" },
      { key: "weight_lb", label: "WEIGHT (LB) — BLANK = UNKNOWN" },
    ],
    run: (a, deps) => {
      const body: Record<string, unknown> = {
        shipment_id: a.shipment_id,
        origin_zip: a.origin_zip,
        dest_zip: a.dest_zip,
      };
      const w = (a.weight_lb ?? "").trim();
      if (w) {
        const n = Number(w);
        if (!Number.isInteger(n) || n <= 0) return FAIL("WEIGHT MUST BE A POSITIVE INTEGER");
        body.weight_lb = n;
      }
      return dispatch(() => deps.api.post("/v1/rate", body), "QUOTE REQUESTED");
    },
  },

  // ACCEPT a priced quote — appends quote.accepted, which triggers the gated Booking agent. Honest label: the
  // acceptance is recorded; the booking itself is the agent's job (behind credit/evidence gates), not a done deal.
  {
    id: "accept.quote",
    label: "Accept a Quote",
    section: "INTAKE + QUOTE",
    target: { kind: "post", path: "/v1/shipments/:id/accept-quote" },
    args: [
      { key: "shipment_id", label: "SHIPMENT ID" },
      { key: "quote_event_id", label: "QUOTE EVENT ID" },
    ],
    run: (a, deps) =>
      dispatch(
        () => deps.api.post(shipmentPath(a.shipment_id ?? "", "/accept-quote"), { quote_event_id: a.quote_event_id }),
        "QUOTE ACCEPTED — BOOKING TRIGGERED",
      ),
  },

  // SCHEDULE an appointment — appointment.set via the generic events route. A local guard keeps the window a
  // valid, non-inverted epoch-ms pair BEFORE dispatch (the server refines it too); a bad slot is an honest FAIL.
  {
    id: "schedule.appointment",
    label: "Schedule Appointment",
    section: "SCHEDULE + DISPATCH",
    target: { kind: "post", path: "/v1/shipments/:id/events" },
    args: [
      { key: "shipment_id", label: "SHIPMENT ID" },
      { key: "leg_kind", label: "LEG (PICKUP OR DELIVERY)" },
      { key: "facility_id", label: "FACILITY ID" },
      { key: "slot_key", label: "SLOT KEY" },
      { key: "window_start_ts", label: "WINDOW START (EPOCH MS)" },
      { key: "window_end_ts", label: "WINDOW END (EPOCH MS)" },
      { key: "actor_party", label: "ACTOR PARTY" },
    ],
    run: (a, deps) => {
      if (a.leg_kind !== "pickup" && a.leg_kind !== "delivery") return FAIL("LEG MUST BE PICKUP OR DELIVERY");
      const start = Number(a.window_start_ts);
      const end = Number(a.window_end_ts);
      if (!Number.isInteger(start) || !Number.isInteger(end)) return FAIL("WINDOW MUST BE EPOCH MS INTEGERS");
      if (end < start) return FAIL("WINDOW END MUST BE >= START");
      const payload = {
        leg_kind: a.leg_kind,
        facility_id: a.facility_id,
        slot_key: a.slot_key,
        window_start_ts: start,
        window_end_ts: end,
      };
      return dispatch(
        () => deps.api.post(shipmentPath(a.shipment_id ?? "", "/events"), eventInput("appointment.set", payload, a.actor_party ?? "")),
        "APPOINTMENT SET",
      );
    },
  },

  // DISPATCH a load to a driver — dispatch.assigned via the events route.
  {
    id: "dispatch.driver",
    label: "Dispatch to Driver",
    section: "SCHEDULE + DISPATCH",
    target: { kind: "post", path: "/v1/shipments/:id/events" },
    args: [
      { key: "shipment_id", label: "SHIPMENT ID" },
      { key: "actor_party", label: "CARRIER PARTY" },
      { key: "driver_user_id", label: "DRIVER USER ID" },
    ],
    run: (a, deps) =>
      dispatch(
        () => deps.api.post(shipmentPath(a.shipment_id ?? "", "/events"), eventInput("dispatch.assigned", { driver_user_id: a.driver_user_id }, a.actor_party ?? "")),
        "DISPATCH ASSIGNED",
      ),
  },

  // APPROVALS — approve / deny an open below-floor approval (the blessed, matrix-gated route).
  decisionCommand("approve.approval", "Approve Approval", "approved"),
  decisionCommand("deny.approval", "Deny Approval", "denied"),

  // COPILOT — ask the READ-ONLY, cite-or-abstain ledger copilot. The answer (or an honest ABSTENTION) is
  // reflected; the copilot NEVER fabricates, so a no-evidence question shows the abstention, never a made-up fact.
  {
    id: "copilot.ask",
    label: "Ask the Copilot",
    section: "COPILOT",
    target: { kind: "post", path: "/v1/copilot/ask" },
    args: [{ key: "question", label: "QUESTION" }],
    run: async (a, deps) => {
      try {
        const res = await deps.api.post<{ text?: string; abstained?: boolean }>("/v1/copilot/ask", { question: a.question });
        if (res.abstained || !res.text) return OK("COPILOT ABSTAINED — NO CITED EVIDENCE");
        return OK(res.text.length > 120 ? `${res.text.slice(0, 117)}...` : res.text);
      } catch (e) {
        return honest(e);
      }
    },
  },
];

/** The count the DoD pins ("20 canonical commands pass"). */
export const COMMAND_COUNT = commands.length;
