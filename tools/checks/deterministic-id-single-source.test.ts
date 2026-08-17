import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1716 (REQ-118/119) — A DETERMINISTIC EVENT ID HAS ONE BUILDER.
//
// This is §1547's gate for a nastier subject. That one kept the metering PERIOD in one place because two
// definitions would split a tenant's meter row across two ids for the same month. This one keeps the
// deterministic EVENT ID in one place, and the failure mode is worse: those ids are how several append paths
// dedupe a re-run, and they are ALREADY PERSISTED in `events`. A second definition that drifts by one byte
// does not produce a wrong number — it produces a duplicate event that cannot be deleted (I3/I7).
//
// MEASURED AT §1716 (before the consolidation): SIX definitions across three workers — `portal-actions.ts`,
// `dunning.ts`, `approvals.ts`, `inbound.ts`, `map-204.ts`, `mirror-sweep.ts` — in TWO textual shapes. They
// agreed (406 seeds, zero disagreements, against a positive control that disagreed on 314), so nothing was
// broken. Nothing made them agree except that nobody had edited one yet.
//
// AND THE COVERAGE WAS THINNER THAN THE COPY COUNT SUGGESTS. Mutating the derivation (slice offset 13→14)
// leaves `workers/api` at **891/891 GREEN** and `workers/agents` at **148/148** — including the api's own
// "accepting the SAME quote twice is idempotent" case, because both accepts in one test run derive the same
// MUTATED id and still collapse. Those tests prove internal consistency; byte-stability against rows written
// by a PREVIOUS deploy is the thing they structurally cannot see. Only two translator assertions noticed, and
// both by accident — a checked-in round-trip fixture that happens to contain one derived id.
//
// So the net is two-part: `packages/contracts/src/deterministic-id.test.ts` pins the BYTES, and this gate
// keeps a second definition from appearing beside it and quietly diverging.

const HOME = "packages/contracts/src/deterministic-id.ts";

/** A function by that name, anywhere but the home. The five removed copies all used this exact name. */
const NAMED_BUILDER = /(?:async\s+)?function\s+deterministicUuid\b/;

/**
 * The uuid LAYOUT built from a digest: two interpolations, then a literal `-4` version nibble immediately
 * before a third. This catches a copy that gets renamed — which is the realistic evasion, since anyone
 * writing a second one is writing it because they did not know the first existed.
 *
 * Deliberately NOT matching "a template literal containing dashes and interpolations" — that is every id
 * builder in the repo (`shp_${…}`, `lgm_quar_${…}`, `q:${…}`). The discriminator is the forced RFC-4122
 * version nibble sitting between two interpolations, which only a uuid layout has.
 */
const UUID_LAYOUT = /\}-\$\{[^`]*?\}-4\$\{/;

function productionSources(root: string): string[] {
  return execSync('git ls-files "packages" "workers" "apps"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.") && !f.includes("/test/") && f !== HOME);
}

/** PURE: does this source define its own deterministic-uuid builder? Separate so a synthetic corpus proves it. */
export function definesOwnUuidBuilder(text: string): boolean {
  return NAMED_BUILDER.test(text) || UUID_LAYOUT.test(text);
}

describe("§1716 REQ-118: the deterministic event id has ONE builder", () => {
  const root = repoRoot();

  it("recognises both removed shapes and clears the id builders that legitimately exist (calibration)", () => {
    // The two shapes actually found at §1716 — five files carried the first, `map-204.ts` the second.
    const sliced = "const h = (await sha256Hex(seed)).slice(0, 32);\nreturn `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`;";
    const full = "const h = await sha256Hex(seed);\nreturn `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`;";
    expect(definesOwnUuidBuilder(sliced), "the sliced shape (5 of the 6 copies)").toBe(true);
    expect(definesOwnUuidBuilder(full), "the full-digest shape (map-204.ts)").toBe(true);
    // Renamed but structurally identical — the realistic evasion.
    expect(definesOwnUuidBuilder("function stableId(s){ return `${a}-${b}-4${c}-${d}-${e}`; }")).toBe(true);
    // NOT a uuid: the other derived-id idioms this repo really uses must stay clear, or the gate is noise.
    expect(definesOwnUuidBuilder("const id = `shp_${(await sha256Hex(seed)).slice(0, 16)}`;"), "shipment id").toBe(false);
    expect(definesOwnUuidBuilder("const id = `lgm_quar_${h.slice(0, 24)}`;"), "quarantine id").toBe(false);
    expect(definesOwnUuidBuilder("const key = `${tenant}:${period}`;"), "a two-part key").toBe(false);
    expect(definesOwnUuidBuilder("const id = crypto.randomUUID();"), "a genuinely new event").toBe(false);
  });

  it("reads a real corpus (non-vacuity — a broken glob must not read as compliance)", () => {
    // LIVE at §1716: 221 production sources. A gate that scanned nothing would report zero violations.
    expect(productionSources(root).length, "almost no production sources — the glob broke, not the tree").toBeGreaterThan(150);
    expect(readFileSync(`${root}/${HOME}`, "utf8"), "the home no longer defines it — repoint HOME").toContain("export async function deterministicUuid");
  });

  it("no production source outside contracts defines its own", () => {
    const offenders = productionSources(root).filter((f) => definesOwnUuidBuilder(readFileSync(`${root}/${f}`, "utf8")));
    expect(
      offenders,
      `${offenders.length} file(s) build a deterministic uuid outside ${HOME}: ${offenders.join(", ")}. These ids ` +
        "are already persisted in append-only `events`, and they are how a re-run collapses to one event. A " +
        "second definition that drifts by one byte does not make a wrong number — it appends a duplicate that " +
        "cannot be deleted. Import `deterministicUuid` from @shuddl/contracts. If a genuinely different id " +
        "scheme is needed, it needs a different NAME and a register row, not a second copy of this one.",
    ).toEqual([]);
  });
});
