import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-118/123/193 §1807 — A WORKER THAT SERVES HTTP PATHS MUST BE REACHABLE BY SOMEBODY.
//
// The route-pattern set in `wrangler.toml` is a hand-maintained gate that lives in a different file from the
// router it must agree with, and nothing diffs the two. §1806 found the first direction of the failure — a path
// EXPOSED that need not be (`/internal/platform/*` reachable on `api.shuddl.tech/*`, absent from both edge-rule
// rows). This gate covers the OTHER direction, which is the one nothing else can see:
//
//   a worker that dispatches on `pathname`, with NO prod route pattern and NO inbound service binding, is
//   reachable by nobody in a deployed environment — and it fails as DNS, at whatever future moment someone
//   finally wires the caller, with no test and no checklist row pointing at the cause.
//
// The two escape hatches are the two real ways a Worker receives a request: a public route (`[[env.prod.routes]]`)
// or another Worker's service binding (`service = "shuddl-<name>-prod"`). Queue consumers and cron handlers do
// NOT count — a worker can be perfectly reachable on those and still have an HTTP surface nobody can call, which
// is exactly the shipped case below.
//
// THE GATE FINDS THE SET; A HUMAN CLASSIFIES IT. Unreachability is not itself a defect — it is a defect only
// when something is MEANT to reach the endpoint. Both shipped instances are unreachable and their correct
// dispositions are OPPOSITE, which is why each exemption carries a purpose and its own ending event.
const EXEMPT: Readonly<Record<string, string>> = {
  // MEASURED 2026-08-18 (§1807) — A LATENT DEPLOY GAP, to be FIXED at EDI go-live.
  // `workers/translator/src/index.ts:68@fetch` calls the inbound 204 webhook "The ONLY public HTTP surface",
  // and its caller is an external EDI partner. The worker has `workers_dev = false` in all three envs, no route
  // pattern in any of them, and no inbound service binding (positive-controlled: the same probe finds 6 real
  // bindings to `shuddl-api-*`). So a partner cannot reach it — it fails as DNS, not as a 4xx. HARMLESS TODAY:
  // the EDI transport is CONFIRM-gated and `NotConfiguredTransport` is bound, so nobody is meant to be posting
  // yet. Filed as a GO-LIVE deploy-note row rather than fixed here, because provisioning a hostname is an owner
  // action. ENDS when the EDI transport is wired — at which point this entry must go and a route must exist.
  translator: "MUST gain a hostname at EDI go-live: an external partner is the intended caller (§1807)",
  // MEASURED 2026-08-18 (§1807) — DEFENSE IN DEPTH, to be KEPT.
  // `workers/agents/src/index.ts:310@TEST_SEND_PATH` is `/_dev/evidence-test-send`, a dev-only outbound-email
  // probe whose intended caller is an operator on a dev deploy, never the internet. The absent route is the
  // OUTERMOST of three independent gates: no hostname, then `ALLOW_TEST_SEND !== "1"` ⇒ 404 for every path and
  // method, then a fail-closed bearer token (unbound ⇒ 500 misconfigured, never open) compared in constant time.
  // This entry should never be removed. If it goes stale, that means the dev probe just gained a public
  // hostname — read the failure as the alarm it is, not as a list to tidy.
  agents: "MUST NOT gain a hostname: a dev-only probe; the absent route is the outermost of 3 gates (§1807)",
};

/** Patterns declared under `[[env.prod.routes]]`, walking sections rather than regexing the whole file. */
function prodRoutePatterns(toml: string): string[] {
  const out: string[] = [];
  let inProdRoutes = false;
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inProdRoutes = line === "[[env.prod.routes]]";
      continue;
    }
    if (!inProdRoutes) continue;
    const m = /^pattern\s*=\s*"([^"]+)"/.exec(line);
    if (m !== null) out.push(m[1]!);
  }
  return out;
}

/** Does this worker route requests by path? Hono registers routes; the raw handlers switch on `pathname`. */
function servesHttpPaths(root: string, worker: string): boolean {
  const dir = `${root}/workers/${worker}/src`;
  if (!existsSync(dir)) return false;
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );
  return files.some((f) => {
    const body = readFileSync(`${dir}/${f}`, "utf8");
    return body.includes("pathname") || body.includes("new Hono");
  });
}

interface WorkerFacts {
  readonly name: string;
  readonly servesHttp: boolean;
  readonly routes: readonly string[];
  readonly inboundBindings: readonly string[];
}

/** The rule, as a pure function so the positive control can drive it with a synthetic worker. */
function unreachable(w: WorkerFacts): boolean {
  return w.servesHttp && w.routes.length === 0 && w.inboundBindings.length === 0;
}

describe("REQ-118/123/193 §1807: a worker serving HTTP paths is reachable by a route or a service binding", () => {
  const root = repoRoot();
  const names = readdirSync(`${root}/workers`).filter((w) =>
    existsSync(`${root}/workers/${w}/wrangler.toml`),
  );
  const tomls = new Map(
    names.map((w) => [w, readFileSync(`${root}/workers/${w}/wrangler.toml`, "utf8")] as const),
  );
  const facts: WorkerFacts[] = names.map((name) => ({
    name,
    servesHttp: servesHttpPaths(root, name),
    routes: prodRoutePatterns(tomls.get(name)!),
    inboundBindings: names
      .filter((other) => other !== name && tomls.get(other)!.includes(`service = "shuddl-${name}-prod"`))
      .map((other) => other),
  }));

  it("the corpus floor — a parser that read nothing would report every worker reachable", () => {
    // §1807 measured 5 workers: api/agents/billing/mcp/translator. Floor under that so ordinary churn does not
    // trip it, and well above zero so a broken readdir cannot pass. Floor the INPUT, never the findings.
    expect(names.length, "the workers/ scan collapsed — fix the path before trusting a green").toBeGreaterThan(3);
    // Both escape-hatch probes must find real instances, or an "everything is reachable" verdict is vacuous.
    expect(
      facts.filter((f) => f.routes.length > 0).map((f) => f.name),
      "the [[env.prod.routes]] walker found no patterns anywhere — it is broken, not the configs",
    ).not.toEqual([]);
    expect(
      facts.filter((f) => f.inboundBindings.length > 0).map((f) => f.name),
      "the service-binding probe found nothing — it is broken, not the configs",
    ).not.toEqual([]);
    expect(facts.filter((f) => f.servesHttp).length).toBeGreaterThan(2);
  });

  it("POSITIVE CONTROL — the rule fires on a worker that serves paths and is reachable by nobody", () => {
    expect(unreachable({ name: "x", servesHttp: true, routes: [], inboundBindings: [] })).toBe(true);
    // …and each escape hatch alone must clear it, or the gate would demand both.
    expect(unreachable({ name: "x", servesHttp: true, routes: ["x.example/*"], inboundBindings: [] })).toBe(false);
    expect(unreachable({ name: "x", servesHttp: true, routes: [], inboundBindings: ["caller"] })).toBe(false);
    // A cron/queue-only worker with no HTTP surface is not this gate's business.
    expect(unreachable({ name: "x", servesHttp: false, routes: [], inboundBindings: [] })).toBe(false);
  });

  it("every HTTP-serving worker is reachable, or is a declared exemption", () => {
    const problems = facts
      .filter(unreachable)
      .filter((f) => EXEMPT[f.name] === undefined)
      .map(
        (f) =>
          `workers/${f.name}: dispatches on a request path but has NO [[env.prod.routes]] pattern and NO other ` +
          "worker binds it as a service — nothing can call it in a deployed environment. Give it a route, give " +
          "a caller a service binding, or add it to EXEMPT with the reason and the event that ends the exemption.",
      );
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("the exemption list self-cleans — an entry that stopped being true fails here", () => {
    // An allowlist nobody prunes rots into a permanent hole. Both directions are checked: a name that is not a
    // worker, and a worker that has since become reachable (the good outcome, which must not stay exempted).
    const stale = Object.keys(EXEMPT).filter((name) => {
      const f = facts.find((x) => x.name === name);
      return f === undefined || !unreachable(f);
    });
    expect(
      stale,
      `EXEMPT names a worker that no longer needs it (or does not exist): ${stale.join(", ")} — delete the entry`,
    ).toEqual([]);
  });
});
