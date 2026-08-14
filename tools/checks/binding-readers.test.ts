import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1476 (REQ-118/119) — EVERY DECLARED BINDING HAS A READER.
//
// §1475 asked whether a declared fixture has anyone waiting for it. The same question, at the runtime contract:
// a binding declared in `wrangler.toml` and read by NO code is a provisioned resource nobody uses — a D1 that
// costs money and confuses the next reader, a queue whose messages arrive nowhere, a var that documents an
// intent the code abandoned. `binding-parity.test.ts` compares environments to EACH OTHER, so a binding
// declared identically in dev/staging/prod and read nowhere passes it perfectly.
//
// WHAT THIS COST TO MEASURE, recorded because the number is the point: reaching a trustworthy answer took SEVEN
// corrections to the probe, each of which had reported correct code as a violation —
//
//   1. Durable Object bindings use `name =`, not `binding =`  → SHIPMENT_SEQ/SPARK_METER/CAPS_METER read as undeclared
//   2. secrets are DELIBERATELY absent from the toml           → `wrangler-no-secrets.test.ts` bans them there
//   3. tenant DBs are reached by computed index `env[binding]` → TENANT_*_DB read as unread
//   4. a guard can be `if (env.X)`, not just `env.X ?? d`      → COPILOT_MODEL read as unguarded
//   5. substring matching                                      → `env.TEST_SEND_TO` matched `env.TEST_SEND_TOKEN`
//   6. readers live in PACKAGES the worker imports, not only in `workers/*/src`
//   7. an UNANCHORED key regex                                 → `name` matched inside `class_name = "ShipmentSequencer"`
//
// A binding surface has several ways to be declared and read, and a probe modelling one of them reports the
// rest as defects. Five of the seven were MY error about correct code; none was a repo defect. That is why the corpus below is workers + packages, and why the extraction handles both key
// spellings and the computed form.
//
// THE ONE FINDING: `ENVIRONMENT` is declared in `workers/billing` and `workers/translator` (all three env
// blocks) and typed in their `Env` interfaces, and neither worker ever reads the value. api/agents/mcp all do —
// a health probe, CORS origin selection, and the two TSA fake-client gates §1352 pins.

const WORKERS = ["workers/api", "workers/agents", "workers/billing", "workers/translator", "workers/mcp"] as const;

/** A binding declared but deliberately unread, with why it stays. */
const DECLARED_UNREAD: readonly { readonly worker: string; readonly binding: string; readonly why: string }[] = [
  {
    worker: "workers/billing",
    binding: "ENVIRONMENT",
    why:
      "Declared in all three env blocks and typed `ENVIRONMENT?: string` on this worker's Env, but no code " +
      "reads the value. It is the deploy-time environment label every other worker uses for a health probe or " +
      "an environment gate; billing has neither. Harmless (an unread var costs nothing at runtime) and kept " +
      "rather than pruned, because the label is uniform across all five tomls and dropping it from one would " +
      "make the configs disagree for a reason no one would remember. Recorded so it is a decision, not a gap.",
  },
  {
    worker: "workers/translator",
    binding: "ENVIRONMENT",
    why:
      "Identical to the billing entry: declared in all three env blocks, typed on the Env interface, value " +
      "never read. Same reasoning — uniformity across the five worker configs is worth more than pruning one " +
      "unread label, and the alternative (deleting it here only) creates a difference that reads as accidental. " +
      "If either worker later gains a health endpoint or an environment gate, this row deletes itself.",
  },
];

const SECTION = /\s*\[\[?([a-z0-9_.]+)\]\]?\s*$/;
/** Resource bindings key on `binding =`; durable objects key on `name =`. Both are declarations. */
// ANCHORED. Unanchored, this matches the `name` INSIDE `class_name = "ShipmentSequencer"` and reports three
// DO CLASS names as unread bindings — correction 7, the same substring class as correction 5 above.
const BINDING_KEY = /^\s*(?:binding|name)\s*=\s*"(\w+)"/;
const VAR_KEY = /^\s*([A-Z][A-Z0-9_]*)\s*=/;
const RESOURCE = ["queues", "durable_objects", "d1_", "r2_", "kv_", "services"];

function declared(root: string, worker: string): Set<string> {
  const out = new Set<string>();
  let section: string | null = null;
  for (const line of readFileSync(`${root}/${worker}/wrangler.toml`, "utf8").split("\n")) {
    const h = SECTION.exec(line);
    if (h !== null) {
      section = h[1] as string;
      continue;
    }
    if (section === null) continue;
    if (RESOURCE.some((r) => section !== null && section.includes(r))) {
      const b = BINDING_KEY.exec(line);
      if (b !== null) out.add(b[1] as string);
      continue;
    }
    if (section.endsWith("vars")) {
      const v = VAR_KEY.exec(line);
      if (v !== null) out.add(v[1] as string);
    }
  }
  return out;
}

/** Everything a worker's `env` can be read from: its own src PLUS every package it may import (correction 6). */
function readable(root: string, worker: string): Set<string> {
  const list = (glob: string): string[] =>
    execSync(`git ls-files -- ${glob}`, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .split("\n")
      .filter((f) => f !== "" && f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.includes("/test/"));
  const src = [...list(`'${worker}/src/*.ts'`), ...list(`'${worker}/src/**/*.ts'`), ...list("'packages/*/src/*.ts'"), ...list("'packages/*/src/**/*.ts'")];
  const code = src.map((f) => readFileSync(`${root}/${f}`, "utf8")).join("\n");
  const out = new Set<string>();
  for (const m of code.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) out.add(m[1] as string);
  // correction 3 — a binding reached by computed index (`env[TENANT_BINDINGS[slug]]`) never appears as `env.X`.
  for (const m of code.matchAll(/"([A-Z][A-Z0-9_]*(?:_DB|_SEQ|_METER))"/g)) out.add(m[1] as string);
  return out;
}

describe("§1476 REQ-119: every binding a worker declares is read by some code", () => {
  const root = repoRoot();
  const rows = WORKERS.map((w) => ({ worker: w, declared: declared(root, w), read: readable(root, w) }));

  it("derives a real population (non-vacuity — an empty scan certifies every binding)", () => {
    const total = rows.reduce((n, r) => n + r.declared.size, 0);
    // LIVE, MEASURED at §1476: 44 declarations across the five workers (11/12/8/8/5).
    expect(total, "no bindings parsed — the toml shape or the section matcher changed").toBeGreaterThanOrEqual(25);
    for (const r of rows) {
      expect(r.declared.size, `${r.worker} declared nothing — its toml did not parse`).toBeGreaterThan(0);
      expect(r.read.size, `${r.worker} reads nothing — the code corpus did not resolve`).toBeGreaterThan(0);
    }
  });

  it("every declared binding is read, or DECLARED unread with a reason", () => {
    const orphans = rows.flatMap((r) =>
      [...r.declared]
        .filter((b) => !r.read.has(b))
        .filter((b) => !DECLARED_UNREAD.some((d) => d.worker === r.worker && d.binding === b))
        .map((b) => `${r.worker} → ${b}`),
    );
    expect(
      orphans,
      "a binding is declared in wrangler.toml and read by NO code — a provisioned resource nobody uses (a D1 " +
        "that costs money, a queue whose messages arrive nowhere) or a var documenting an intent the code " +
        "dropped. `binding-parity` cannot see this: it compares environments to each other, and a binding " +
        "declared identically everywhere and read nowhere passes it perfectly. Wire a reader, delete the " +
        "declaration, or declare it unread with why:\n  " + orphans.join("\n  "),
    ).toEqual([]);
  });

  it("every DECLARED_UNREAD entry still has its subject and is still unread", () => {
    for (const d of DECLARED_UNREAD) {
      const r = rows.find((x) => x.worker === d.worker);
      expect(r, `DECLARED_UNREAD names ${d.worker}, which is not a scanned worker`).toBeDefined();
      expect(r?.declared.has(d.binding), `${d.worker} no longer declares ${d.binding} — delete this entry`).toBe(true);
      expect(r?.read.has(d.binding), `${d.worker} now READS ${d.binding} — delete this entry so the gate enforces it`).toBe(false);
      expect(d.why.length, `${d.worker}/${d.binding}'s reason is too short to be a reason`).toBeGreaterThan(180);
    }
  });

  it("the extractor handles BOTH declaration spellings (positive control for correction 1)", () => {
    // Durable Objects key on `name =`; everything else on `binding =`. A probe modelling one spelling reports
    // the other as undeclared — §1476 measured exactly that on SHIPMENT_SEQ, SPARK_METER and CAPS_METER.
    const api = rows.find((r) => r.worker === "workers/api");
    expect(api?.declared.has("SHIPMENT_SEQ"), "the DO `name =` spelling is not being read as a declaration").toBe(true);
    expect(api?.declared.has("EVIDENCE"), "the resource `binding =` spelling is not being read as a declaration").toBe(true);
    const agents = rows.find((r) => r.worker === "workers/agents");
    expect(agents?.read.has("TENANT_A_DB"), "the computed-index read form is not being recognised (correction 3)").toBe(true);
  });
});
