import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEMOS, spineByPackage, spineFileCount } from "./demos.js";

// REQ-119 (audit §68) — the acceptance manifest and this module must name the SAME spine.
//
// `demos.ts` calls itself "the single source of truth shared by the runner (run.ts) and the manifest
// (docs/wp/acceptance-demos.md), so the two can never drift." Half of that was true: `run.ts` imports this
// module, so the RUNNER cannot drift. The MANIFEST is hand-written markdown — it cites `demos.ts` but does
// not derive from it, so "can never drift" described an intention, not a mechanism. Adding a demo or moving
// a spine file would have left the manifest stale with nothing failing.
//
// These make the claim true. The manifest stays prose (it carries the filmed-half narrative, which is the
// point of it and is not derivable), but the FACTS it shares with this module — which spine files, how many,
// which demos — are now checked rather than asserted.

const MANIFEST_PATH = "docs/wp/acceptance-demos.md";
const manifest = (): string => readFileSync(MANIFEST_PATH, "utf8");

describe("REQ-119: the acceptance manifest cannot drift from the demo spine", () => {
  it("every spine file in demos.ts is named in the manifest", () => {
    const md = manifest();
    for (const demo of DEMOS) {
      for (const { pkg, file } of demo.spine) {
        expect(md, `${MANIFEST_PATH} must name demo ${demo.n}'s spine file ${file} (${pkg})`).toContain(file);
      }
    }
  });

  it("the manifest names NO spine file this module does not declare", () => {
    // The reverse direction. Without it, a spine file deleted from demos.ts would linger in the manifest,
    // which reads as coverage that no longer runs — the failure direction that overstates.
    const declared = new Set(DEMOS.flatMap((d) => d.spine.map((s) => s.file)));
    const named = new Set(manifest().match(/(?:test|src)\/[A-Za-z0-9._/-]+\.(?:test|spec)\.tsx?/g) ?? []);
    for (const file of named) {
      expect(declared.has(file), `${MANIFEST_PATH} names ${file}, which demos.ts does not declare as a spine file`).toBe(true);
    }
  });

  it("every demo is represented in the manifest by number and title", () => {
    const md = manifest();
    for (const demo of DEMOS) {
      expect(md, `manifest must cover demo ${demo.n}`).toMatch(new RegExp(`[Dd]emo\\s*${demo.n}\\b`));
    }
  });

  it("all five doc-00 demos are declared, each with at least one spine test and a stated filmed delta", () => {
    expect(DEMOS.map((d) => d.n)).toEqual([1, 2, 3, 4, 5]);
    for (const d of DEMOS) {
      expect(d.spine.length, `demo ${d.n} has no spine test`).toBeGreaterThan(0);
      // The filmed delta is what keeps a green spine from being read as a finished demo. A blank one would
      // silently promote "the code path exists" to "the demo is done".
      expect(d.filmed.length, `demo ${d.n} must state what the FILM must additionally show`).toBeGreaterThan(60);
    }
  });

  it("spineFileCount() matches the distinct files actually declared", () => {
    const distinct = new Set(DEMOS.flatMap((d) => d.spine.map((s) => `${s.pkg}::${s.file}`)));
    expect(spineFileCount()).toBe(distinct.size);
    expect([...spineByPackage().keys()].sort()).toEqual(["@shuddl/api", "@shuddl/driver", "@shuddl/map", "@shuddl/mcp"]);
  });
});
