import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "../checks/repo-root.js";

// REQ-154 §585 — EVERY BINDING TWO WORKERS SHARE POINTS AT THE SAME RESOURCE.
//
// §583/§584 gated ONE binding, `PLATFORM_TENANT_DB`, across both deployable scopes. Nine bindings are shared
// by two or more workers — `CONTROL_DB` by all five — and the other eight were gated by nothing. Two workers
// binding one logical resource to different targets is a split-brain: the biller meters against a control
// plane the api never provisioned into, and neither side errors.
//
// TWO PARITIES, deliberately separated, because the dev scope legitimately differs:
//   • LOGICAL (`database_name` / `bucket_name`) must agree in EVERY scope, dev included — it is the
//     resource's identity, and a disagreement there is a naming defect wherever it appears.
//   • PHYSICAL (`database_id`) must agree only in staging/prod. In dev the id names a per-worker miniflare
//     file (`local-agents-control` vs `local-control`) while the NAME is identical — each worker runs its own
//     local instance, which is correct and would be a false positive under one combined rule.
//
// Measured when this landed: 21 logical pairs and 12 physical pairs, ZERO divergent. This locks a clean state
// rather than fixing a defect — §486's cheap half, and the case that most needs a test, because nothing is
// failing today and nothing else would notice it starting to.
//
// It does NOT supersede preflight.test.ts's PLATFORM_TENANT_DB case: that one asserts the binding EXISTS in
// both workers (it throws when absent), which a parity-over-shared-bindings rule cannot — a binding present
// in neither worker is trivially "in parity".

interface Decl {
  worker: string;
  scope: string;
  binding: string;
  name?: string;
  id?: string;
}

function declarations(): Decl[] {
  const root = repoRoot();
  const out: Decl[] = [];
  const files = execSync('git ls-files "workers/*/wrangler.toml"', { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const f of files) {
    const worker = f.split("/")[1]!;
    let scope = "dev";
    for (const block of readFileSync(`${root}/${f}`, "utf8").split(/\n(?=\[)/)) {
      const env = /^\[+env\.(\w+)/.exec(block);
      if (env) scope = env[1]!;
      const binding = /binding\s*=\s*"([^"]+)"/.exec(block);
      if (!binding) continue;
      // All five binding types this repo uses (§586). §585 read only D1 + R2 and said so in its own reopen
      // trigger; queues and services were 6 shared pairs it could not see. A queue or a service name IS the
      // logical identity (there is no separate id), so both join the LOGICAL rule; a KV `id` is physical.
      const name =
        /database_name\s*=\s*"([^"]*)"/.exec(block) ??
        /bucket_name\s*=\s*"([^"]*)"/.exec(block) ??
        /^\s*queue\s*=\s*"([^"]*)"/m.exec(block) ??
        /^\s*service\s*=\s*"([^"]*)"/m.exec(block);
      const id = /database_id\s*=\s*"([^"]*)"/.exec(block) ?? /^\s*id\s*=\s*"([^"]*)"/m.exec(block);
      out.push({
        worker,
        scope,
        binding: binding[1]!,
        ...(name ? { name: name[1]! } : {}),
        ...(id ? { id: id[1]! } : {}),
      });
    }
  }
  return out;
}

/** (scope, binding) → worker → value, keeping only the pairs at least two workers declare. */
function grouped(field: "name" | "id", scopes?: ReadonlySet<string>): Map<string, Map<string, string>> {
  const m = new Map<string, Map<string, string>>();
  for (const d of declarations()) {
    const v = d[field];
    if (v === undefined) continue;
    if (scopes && !scopes.has(d.scope)) continue;
    const key = `${d.scope} ${d.binding}`;
    if (!m.has(key)) m.set(key, new Map());
    m.get(key)!.set(d.worker, v);
  }
  return new Map([...m].filter(([, ws]) => ws.size > 1));
}

function divergences(field: "name" | "id", scopes?: ReadonlySet<string>): string[] {
  return [...grouped(field, scopes)]
    .filter(([, ws]) => new Set(ws.values()).size > 1)
    .map(([key, ws]) => `${key}: ${[...ws].map(([w, v]) => `${w}=${v}`).join(", ")}`);
}

/** Queue names by role, per scope — consumers carry no `binding`, so the parity rules above cannot see them. */
function queuesByRole(role: "producers" | "consumers"): Map<string, Set<string>> {
  const root = repoRoot();
  const out = new Map<string, Set<string>>();
  const files = execSync('git ls-files "workers/*/wrangler.toml"', { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const f of files) {
    let scope = "dev";
    for (const block of readFileSync(`${root}/${f}`, "utf8").split(/\n(?=\[)/)) {
      const env = /^\[+env\.(\w+)/.exec(block);
      if (env) scope = env[1]!;
      const head = /^\[+([\w.]+)\]+/.exec(block);
      const q = /^\s*queue\s*=\s*"([^"]*)"/m.exec(block);
      if (!head || !q) continue;
      if (!head[1]!.endsWith(role)) continue;
      if (!out.has(scope)) out.set(scope, new Set());
      out.get(scope)!.add(q[1]!);
    }
  }
  return out;
}

// REQ-026/154 §587 — EVERY QUEUE HAS BOTH ENDS, IN EVERY SCOPE.
//
// §586's own reopen trigger: consumers carry no `binding`, so the parity rules above are structurally blind
// to them, and a producer/consumer name mismatch is checked by nothing. That failure is silent in the worst
// way — `api` enqueues an agent trigger, the message lands in a queue no worker reads, and the Biller and
// Concierge simply never run. Nothing errors; the freight just stops being acted on.
//
// Both directions are defects here, because this repo owns both ends of every queue:
//   • produced with no consumer → messages accumulate and expire unread;
//   • consumed with no producer → a worker subscribed to a queue nothing feeds (dead config, and usually the
//     residue of a rename that only touched one side).
describe("REQ-026 §587: producer and consumer queue names pair up", () => {
  const produced = queuesByRole("producers");
  const consumed = queuesByRole("consumers");

  it("finds queues in every scope (non-vacuity)", () => {
    expect([...produced.keys()].sort(), "the producer scan is stale, not the configs").toEqual(["dev", "prod", "staging"]);
    expect([...consumed.keys()].sort(), "the consumer scan is stale, not the configs").toEqual(["dev", "prod", "staging"]);
  });

  it("every produced queue is consumed, and every consumed queue is produced, within its scope", () => {
    const bad: string[] = [];
    for (const scope of new Set([...produced.keys(), ...consumed.keys()])) {
      const p = produced.get(scope) ?? new Set();
      const c = consumed.get(scope) ?? new Set();
      for (const q of p) if (!c.has(q)) bad.push(`${scope}: "${q}" is PRODUCED but no worker consumes it`);
      for (const q of c) if (!p.has(q)) bad.push(`${scope}: "${q}" is CONSUMED but no worker produces it`);
    }
    expect(bad, `a queue with only one end — messages go nowhere and nothing errors:\n  ${bad.join("\n  ")}`).toEqual([]);
  });
});

describe("REQ-154 §585: cross-worker binding parity", () => {
  it("finds shared bindings at all (non-vacuity)", () => {
    // A renamed table or a parser change would compare nothing and pass — the class this repo met in five
    // gates (§487/§554/§572/§584).
    // RAISED with the corpus (§586): 21 → 27 logical pairs once queues and services joined. A floor left at
    // the old number would pass with those two types silently dropped back out, which is the scan-collapse
    // shape §572 found in a guard written to prevent it.
    expect(grouped("name").size, "no shared bindings found — the scan is broken, not the configs").toBeGreaterThan(24);
    expect(grouped("id", new Set(["staging", "prod"])).size, "no shared deployable ids found").toBeGreaterThan(10);
  });

  it("the LOGICAL resource name agrees in every scope, dev included", () => {
    const bad = divergences("name");
    expect(bad, `two workers name one binding's resource differently:\n  ${bad.join("\n  ")}`).toEqual([]);
  });

  it("the PHYSICAL database id agrees in staging and prod", () => {
    // dev is excluded ON PURPOSE: there the id names a per-worker miniflare file while the NAME is shared.
    const bad = divergences("id", new Set(["staging", "prod"]));
    expect(
      bad,
      "two workers bind one logical resource to DIFFERENT databases in a deployable scope — a split-brain " +
        "where each side reads and writes a different store and neither errors:\n  " + bad.join("\n  "),
    ).toEqual([]);
  });
});
