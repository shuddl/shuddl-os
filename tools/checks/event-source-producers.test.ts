import { describe, expect, it } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { EXPECTED_EMPTY_GLOBS, SOURCE_SCAN_GLOBS, isTestPath, stripComments } from "./source-corpus.js";
import { repoRoot } from "./repo-root.js";

// §1178 (REQ-021/022/030) — A NON-NATIVE EVENT SOURCE IS A GATE EXEMPTION, SO ITS PRODUCERS ARE A CLOSED SET.
//
// `EventInput.source` is `z.enum(["native", "legacy", "edi", "email"])`, and the value is not cosmetic: the
// sequencer DO EXEMPTS `legacy` events from the native physical-precondition gates (invoice→POD, appointment,
// dispatch) — `legacy` SPECIFICALLY, not "non-native": `edi` and `email` are fully gated and fully projected
// (§1179). A record that declares itself `legacy` is asserting *"the incumbent's system already did this"*, and
// the DO believes it. `edi`/`email` are still pinned here because they are ingest DECLARATIONS the lens and the
// KPI layer read (NATIVE_VISIBLE_SOURCES), so a rogue producer of either is still a rogue provenance claim.
//
// `workers/api/src/routes/events.ts` states the invariant in a comment, and states why it matters:
//
//   "`source:'legacy'` is a SHADOW mirror record producible ONLY by the internal mirror seam … A client that
//    could self-declare `source:'legacy'` would BYPASS those gates entirely, forging a 'the incumbent already
//    did this' record."
//
// The CLIENT half is enforced: both loose-body append seams coerce `source = "native"` before the DO
// (events.ts and internal-platform.ts), and the other 22 emitters hardcode the literal in a server-built
// object. Measured at §1178 — all of it holds today.
//
// THE SERVER HALF WAS COVERED FOR ROUTES ONLY (corrected §1181 — this comment first said "by nothing").
// `append-chokepoint.test.ts` §567 already requires every file in `workers/api/src/routes` that calls
// `.append(` to contain `source:"native"` — seven files, all compliant. What it does NOT reach is everything
// else: `workers/agents`, `workers/translator`, `workers/billing`, `workers/mcp`, and `packages/*`. An AGENT
// emitting `source:"legacy"` directly was unguarded, and that is the likelier regression: someone wiring a new
// backfill or import picks the value that makes the gates stop complaining. This gate is the complement, not a
// duplicate — §567 is a POSITIVE requirement scoped to routes, this is a NEGATIVE one scoped to the repo.
//
// WHY A CLOSED SET IS THE RIGHT SHAPE HERE, when the neighbouring rule was not. The obvious formulation —
// "every sequencer-append caller must pin source" — was measured first and REJECTED: of the 15 files touching
// SHIPMENT_SEQ, 7 legitimately do not pin (transport seams whose inputs are built elsewhere, binding
// declarations, the DO itself, and the mirror seam whose whole job is emitting legacy). An allowlist covering
// half the corpus is the profile of a gate people learn to silence. Inverting it — positively matching the
// DANGEROUS value rather than the safe one — yields THREE allowlist entries instead of seven exemptions.
// [[invert-a-detector-whose-boundary-is-english]], applied to a boundary that turned out not to be English.
//
// NOTE ON `email`: the enum declares it and NOTHING produces it. Recorded rather than removed — the enum is a
// contract and pruning it is a register question, not a lint's call. If a producer ever appears, this gate
// flags it and the adjudication happens then, which is the point.

/** A non-native `source: "<value>"` literal — the gate-exempting declaration. */
const NON_NATIVE_SOURCE = /\bsource:\s*"(legacy|edi|email)"/g;

export interface SourceProducer {
  readonly file: string;
  readonly value: string;
}

/** Every non-native source literal in `text`, comments stripped (a comment discussing `legacy` produces nothing). */
export function nonNativeSourceProducers(file: string, text: string): SourceProducer[] {
  const src = stripComments(text);
  return [...src.matchAll(NON_NATIVE_SOURCE)].map((m) => ({ file, value: m[1] as string }));
}

/**
 * The ONLY files that may declare a non-native source, each with the seam it implements. Adding an entry is a
 * claim that this path is a genuine non-native ingest — not a way to make a gate stop failing.
 */
const ALLOWED_PRODUCERS: ReadonlyMap<string, string> = new Map([
  [
    "packages/adapters/src/legacy-mirror.ts",
    "the legacy MIRROR draft builder — constructs the shadow record the mirror seam appends (REQ-021)",
  ],
  [
    "workers/agents/src/mirror-sweep.ts",
    "the internal mirror SEAM — the one path events.ts names as the sole legitimate producer of source:'legacy'",
  ],
  [
    "workers/translator/src/core/map-204.ts",
    "the inbound EDI 204 mapper — a partner load tender arrives as source:'edi' (WP-12)",
  ],
]);

function corpus(): { path: string; text: string }[] {
  const root = repoRoot();
  const files: { path: string; text: string }[] = [];
  for (const g of SOURCE_SCAN_GLOBS) {
    const hits = globSync(g, { cwd: root }).filter((p) => !isTestPath(p));
    if (hits.length === 0 && !EXPECTED_EMPTY_GLOBS.has(g)) {
      throw new Error(`event-source-producers: glob matched ZERO files — ${g} (a broken pattern reads as a clean scan)`);
    }
    for (const p of hits) files.push({ path: p, text: readFileSync(`${root}/${p}`, "utf8") });
  }
  return files;
}

describe("§1178 REQ-021/030: only the declared seams may produce a non-native event source", () => {
  const files = corpus();
  const found = files.flatMap((f) => nonNativeSourceProducers(f.path, f.text));

  it("finds the known producers at all (non-vacuity — §968's rule)", () => {
    // Three files measured at §1178. A floor on the CORPUS, not on the findings: a broken glob or a renamed
    // adapter would otherwise report zero violations, which is exactly what a clean run prints.
    const producerFiles = new Set(found.map((p) => p.file));
    expect(
      producerFiles.size,
      `expected the mirror + EDI producers; found ${[...producerFiles].join(", ") || "none"} — the scan is broken, not the tree`,
    ).toBeGreaterThanOrEqual(3);
  });

  it("SENSITIVITY: a route that declares itself legacy is flagged", () => {
    // The realistic regression: a new backfill path picks the value that makes the physical gates stop firing.
    const planted = 'const ev = { kind: "invoice.issued", source: "legacy", payload: {} };';
    expect(nonNativeSourceProducers("workers/api/src/routes/backfill.ts", planted)).toEqual([
      { file: "workers/api/src/routes/backfill.ts", value: "legacy" },
    ]);
  });

  it("BOUNDARY: source:'native' is not a producer, and a COMMENT about legacy is not either", () => {
    expect(nonNativeSourceProducers("a.ts", 'const ev = { source: "native" };')).toEqual([]);
    expect(nonNativeSourceProducers("b.ts", '// a mirror record carries source: "legacy" — see mirror-sweep\nconst ev = { source: "native" };')).toEqual([]);
  });

  it("every non-native source producer is a declared seam", () => {
    const rogue = found
      .filter((p) => !ALLOWED_PRODUCERS.has(p.file))
      .map((p) => `${p.file} declares source:"${p.value}"`);
    expect(
      rogue,
      "a file outside the declared ingest seams produces a NON-NATIVE event source. `legacy` is a GATE " +
        "EXEMPTION — the sequencer DO skips the native physical-precondition gates (invoice→POD, appointment, " +
        "dispatch) for it — and `edi`/`email` are provenance claims the lens and KPI layer trust. Either way this " +
        "is an unaudited ingest declaration. If the path is a " +
        "genuine non-native ingest, add it to ALLOWED_PRODUCERS with the seam it implements; if it is a way to " +
        "stop a gate failing, the gate is the thing to satisfy:\n  " +
        rogue.join("\n  "),
    ).toEqual([]);
  });

  it("§672: every allowlisted producer still exists and still produces (no stale exemption)", () => {
    // An entry whose file was renamed or whose literal was removed is a stale carve-out: it would keep
    // granting an exemption nobody uses, and quietly cover a future file that inherits the path.
    const producing = new Set(found.map((p) => p.file));
    const stale = [...ALLOWED_PRODUCERS.keys()].filter((f) => !producing.has(f));
    expect(
      stale,
      "an allowlisted non-native producer no longer produces one. Either it moved (update the entry) or the " +
        "seam was retired (delete it) — an exemption must not outlive its subject:\n  " + stale.join("\n  "),
    ).toEqual([]);
  });
});
