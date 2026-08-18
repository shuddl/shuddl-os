import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1464 (REQ-118/REQ-025) — A DURABLE OBJECT'S NAME IS ITS NAMESPACE, SO SOMETHING MUST GUARD THE NAME.
//
// `idFromName(x)` decides which instance's storage a caller reaches. Two callers that pass the same `x` share
// one object; a caller that drops the tenant from `x` puts every tenant on one instance. There is no error and
// no log — a shared counter looks exactly like a busy one — so the guarantee has to come from somewhere.
//
// §1463 measured where it comes from, per DO, by de-tenanting each call site and counting what red:
//
//   ShipmentSequencer  self-verifies (`expected.equals(this.ctx.id)`)   →  124 tests red
//   CapsMeter          cannot self-verify; driven through production    →    9 tests red
//   SparkMeter         cannot self-verify; NOT driven                   →    0 red (144/144 green)
//
// The meters CANNOT self-verify and that is not a defect: their requests carry no tenant at all, so the DO has
// no second source of truth to compare its identity against. The consequence is that for them the CALL SITE is
// the entire isolation — which is fine while a test drives the real call site, and worthless when one does not.
// SparkMeter's isolation case resolved the DO through the test file's OWN helper, so it proved that Durable
// Objects isolate by name (a Cloudflare property) and never that `sparkGateFor` passes the tenant.
//
// This gate makes that per-DO answer mandatory instead of incidental. Three classes exist today and all three
// are now defended; the point is DO number four, whose author must either self-verify or say, in writing, which
// test drives its production naming path.

/** `.equals(this.ctx.id)` in either order — the identity re-derivation the sequencer performs. */
const SELF_VERIFIES = /\.equals\(\s*this\.ctx\.id\s*\)|this\.ctx\.id\.equals\(/;

/**
 * DOs that cannot self-verify, with the test that drives their PRODUCTION naming path instead.
 *
 * `drivenBy` is checked for existence, and — the part that matters — it must not be the file that merely
 * resolves the DO itself. §1463's whole finding is that a test can resolve a DO correctly all day and still
 * never exercise the code that ships.
 */
const NAME_TRUSTED: readonly { readonly cls: string; readonly why: string; readonly drivenBy: string }[] = [
  {
    cls: "SparkMeter",
    why:
      "Its `checkAndReserve` request carries period/allotment/actionId and NO tenant, so the DO has nothing to " +
      "compare its own identity against — unlike the sequencer, whose caller declares a tenant the DO can " +
      "re-derive. Isolation therefore rests entirely on `sparkGateFor` naming the meter `idFromName(tenant)`. " +
      "§1463 added the case that drives that composition root: two Spark tenants, one slot each, A exhausts " +
      "and B must still hold its own. RED under a constant name and under a period-keyed name.",
    drivenBy: "workers/agents/test/spark-meter.test.ts",
  },
  {
    cls: "CapsMeter",
    why:
      "Same shape as SparkMeter — the reserve request carries no actor identity, so `idFromName(pairingId)` at " +
      "the `caps.ts` call site is the whole per-actor boundary. Already defended before §1464: de-naming it " +
      "reds NINE cases, including one titled 'the CapsMeter DO is keyed idFromName(pairingId) — no " +
      "cross-tenant counter can collide', because those cases drive the real caps path rather than resolving " +
      "the DO themselves.",
    drivenBy: "workers/mcp/test/caps.test.ts",
  },
];

function doClasses(root: string): { cls: string; file: string; selfVerifies: boolean }[] {
  const files = execSync("git ls-files -- 'workers/*/src/*.ts' 'workers/*/src/*.tsx' 'workers/*/src/**/*.ts' 'workers/*/src/**/*.tsx'", {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => f !== "" && !f.endsWith(".test.ts") && !f.includes("/test/"));
  const out: { cls: string; file: string; selfVerifies: boolean }[] = [];
  for (const file of files) {
    const src = readFileSync(`${root}/${file}`, "utf8");
    for (const m of src.matchAll(/export\s+class\s+(\w+)\s+extends\s+DurableObject\b/g)) {
      out.push({ cls: m[1] as string, file, selfVerifies: SELF_VERIFIES.test(src) });
    }
  }
  return out;
}

/** Every `class_name` bound as a durable object in any wrangler config — the deploy-time roster. */
function boundClasses(root: string): Set<string> {
  const tomls = execSync("git ls-files -- '*wrangler*.toml'", { cwd: root, encoding: "utf8" }).split("\n").filter((f) => f !== "");
  const out = new Set<string>();
  for (const t of tomls) {
    for (const m of readFileSync(`${root}/${t}`, "utf8").matchAll(/class_name\s*=\s*"(\w+)"/g)) out.add(m[1] as string);
  }
  return out;
}

describe("§1464 REQ-025: every Durable Object either verifies its own name or declares who does", () => {
  const root = repoRoot();
  const classes = doClasses(root);
  const bound = boundClasses(root);

  it("derives a real population (non-vacuity — an empty scan certifies every DO)", () => {
    // LIVE, MEASURED at §1464: 3 classes, 3 bound class_names. Floor 1 rather than 3: this is a tripwire for
    // the scan breaking, and a repo legitimately gains DOs. The parity assertion below is what keeps it honest.
    expect(classes.length, "no DurableObject subclass found — the scan broke, not the repo").toBeGreaterThanOrEqual(1);
    expect(bound.size, "no durable_objects class_name found in any wrangler toml — the config scan broke").toBeGreaterThanOrEqual(1);
  });

  it("the source classes and the wrangler bindings are the SAME set (neither side drifts)", () => {
    // Two mechanisms enforcing one roster: a class nobody binds is dead code that still looks live, and a
    // binding with no class is a deploy that boots into a missing export. §1370's rule — when two lists must
    // agree, assert the delta, never eyeball the globs.
    const srcNames = new Set(classes.map((c) => c.cls));
    expect([...srcNames].filter((c) => !bound.has(c)).sort(), "a DurableObject class is not bound in any wrangler toml").toEqual([]);
    expect([...bound].filter((c) => !srcNames.has(c)).sort(), "a wrangler durable_objects binding names a class no source exports").toEqual([]);
  });

  it("each DO self-verifies its id, or is DECLARED name-trusted with the test that drives its naming path", () => {
    const undefended = classes
      .filter((c) => !c.selfVerifies && !NAME_TRUSTED.some((n) => n.cls === c.cls))
      .map((c) => `${c.cls} (${c.file})`);
    expect(
      undefended,
      "a Durable Object neither re-derives its own id from the request nor is declared name-trusted. Its " +
        "`idFromName(...)` call site is then the ONLY thing keeping tenants apart, and nothing here says what " +
        "proves that call site correct — which is exactly how SparkMeter shipped with a green test titled " +
        "'TENANT ISOLATION' that could not fail (§1463). Either add the `expected.equals(this.ctx.id)` check, " +
        "or add a NAME_TRUSTED entry naming the test that drives the PRODUCTION naming path:\n  " +
        undefended.join("\n  "),
    ).toEqual([]);
  });

  it("every name-trusted declaration still has its subject and its driver (no exemption outlives either)", () => {
    for (const n of NAME_TRUSTED) {
      const cls = classes.find((c) => c.cls === n.cls);
      expect(cls, `NAME_TRUSTED names ${n.cls}, which no longer exists — delete the entry`).toBeDefined();
      expect(
        cls?.selfVerifies,
        `${n.cls} now self-verifies its id — delete the NAME_TRUSTED entry so the stronger guarantee is the one recorded`,
      ).toBe(false);
      expect(existsSync(`${root}/${n.drivenBy}`), `${n.cls}'s declared driver ${n.drivenBy} does not exist`).toBe(true);
      expect(n.why.length, `${n.cls}'s reason is too short to be a reason`).toBeGreaterThan(160);
    }
  });

  it("the self-verification detector actually fires on the sequencer (positive control)", () => {
    // Without this, narrowing SELF_VERIFIES to nothing would make every DO look name-trusted-or-undefended and
    // the roster above would silently become the only rule. §1463 measured that this guard is real: removing
    // it reds 124 tests in workers/api.
    const seq = classes.find((c) => c.cls === "ShipmentSequencer");
    expect(seq, "the sequencer is gone — this control no longer proves the detector works").toBeDefined();
    expect(seq?.selfVerifies, "SELF_VERIFIES no longer matches the sequencer's id check — the pattern rotted").toBe(true);
    expect(SELF_VERIFIES.test("if (!expected.equals(this.ctx.id)) throw x;"), "detector missed its own example").toBe(true);
    expect(SELF_VERIFIES.test("if (a.equals(b)) throw x;"), "detector fires on an unrelated equals()").toBe(false);
  });
});
