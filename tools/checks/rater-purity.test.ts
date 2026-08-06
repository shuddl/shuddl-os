import { fileURLToPath as _fu } from "node:url";
import { dirname as _dn, join as _jn } from "node:path";
const REPO_ROOT = _jn(_dn(_fu(import.meta.url)), "..", "..");
import { describe, expect, it } from "vitest";
import { analyzeRaterPurity, collectRaterSourceFiles } from "./rater-purity.js";

// REQ-004 + REQ-024 (mirrored for the rater): the adapter subtree (packages/rater/src/adapters/**) is the
// SOLE class-aware region. The class rule is a PATH+BARREL guarantee — no non-exempt src file may import a
// class/adapter/smc3 module by path, nor reach the adapter via the package's own barrel (./index /
// @shuddl/rater). It is a DENYLIST with two exemptions (adapters/** and the src-root barrel index.ts), not
// an allowlist of named core files; it does not police the erased `ClassAdapter` TYPE from @shuddl/contracts
// (a config shape, not class logic). NO file may import an LLM/agent SDK. These tests feed the pure analyzer
// SYNTHETIC inputs to prove it catches each planted violation (path, barrel-evasion, transitive helper,
// backtick dynamic import), rejects substring false-positives (classify/first-class), and exempts the two
// legitimate files. The final test asserts the REAL src is clean.

describe("class_as_foundation: only adapters/** may touch class", () => {
  it("flags a core module importing ./adapters/*", () => {
    const v = analyzeRaterPurity([{ path: "packages/rater/src/engine.ts", content: 'import { classToDensityPcf } from "./adapters/class.js";' }]);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("class_as_foundation");
    expect(v[0]?.file).toBe("packages/rater/src/engine.ts");
  });

  it("flags a core module importing a `class`-segment specifier", () => {
    const v = analyzeRaterPurity([{ path: "packages/rater/src/price.ts", content: 'import { toClass } from "./class-map.js";' }]);
    expect(v.map((x) => x.rule)).toEqual(["class_as_foundation"]);
  });

  it("matches `class` only as a leading path SEGMENT — no substring false-positives", () => {
    // The rule is in the blocking `verify` chain, so a false-positive would BLOCK an innocent merge.
    // class.js / class-map.js / class_thing.js are class-adapter modules → flagged; classify.js /
    // first-class.js / classroom.js / the `classnames` package are unrelated → NOT flagged.
    const flagged = analyzeRaterPurity([
      { path: "packages/rater/src/engine.ts", content: 'import { c } from "./class.js";' },
      { path: "packages/rater/src/compose.ts", content: 'import { c } from "./class-map.js";' },
      { path: "packages/rater/src/floors.ts", content: 'import { c } from "./class_thing.js";' },
    ]);
    expect(flagged.map((x) => x.rule)).toEqual(["class_as_foundation", "class_as_foundation", "class_as_foundation"]);

    const clean = analyzeRaterPurity([
      { path: "packages/rater/src/engine.ts", content: 'import { classify } from "./classify.js";' },
      { path: "packages/rater/src/compose.ts", content: 'import { x } from "./first-class.js";' },
      { path: "packages/rater/src/floors.ts", content: 'import { x } from "./classroom.js";' },
      { path: "packages/rater/src/price.ts", content: 'import cx from "classnames";' },
    ]);
    expect(clean).toEqual([]);
  });

  it("flags a core module importing an SMC3/NMFC table", () => {
    const v = analyzeRaterPurity([{ path: "packages/rater/src/compose.ts", content: 'import { table } from "./smc3-table.js";' }]);
    expect(v.map((x) => x.rule)).toEqual(["class_as_foundation"]);
  });

  it("closes the transitive-helper hole — a NON-core src file importing class is flagged too", () => {
    // types.ts is imported by engine.ts/price.ts; an allowlist of named core files would MISS this, letting
    // the engine become transitively class-aware. The denylist catches every non-exempt src file.
    const v = analyzeRaterPurity([
      { path: "packages/rater/src/types.ts", content: 'import { classToDensityPcf } from "./adapters/class.js";' },
      { path: "packages/rater/src/pricing-helper.ts", content: 'import { toClass } from "./class-map.js";' },
    ]);
    expect(v.map((x) => x.rule)).toEqual(["class_as_foundation", "class_as_foundation"]);
    expect(v.map((x) => x.file)).toEqual(["packages/rater/src/types.ts", "packages/rater/src/pricing-helper.ts"]);
  });

  it("closes the barrel re-export evasion — a core file reaching the adapter via the package's own barrel", () => {
    // The barrel re-exports classToDensityPcf, so `from "./index.js"` / "@shuddl/rater" would pull class
    // logic in with a specifier that trips none of the path patterns. Flag it (also a circular-import smell).
    const v = analyzeRaterPurity([
      { path: "packages/rater/src/engine.ts", content: 'import { classToDensityPcf } from "./index.js";' },
      { path: "packages/rater/src/price.ts", content: 'import { classToDensityPcf } from "@shuddl/rater";' },
      { path: "packages/rater/src/adapters/foo.ts", content: 'import { x } from "../index.js";' }, // exempt? no — see below
    ]);
    // engine.ts + price.ts flagged; adapters/foo.ts is EXEMPT (adapter subtree), so only two violations.
    expect(v.map((x) => x.rule)).toEqual(["class_as_foundation", "class_as_foundation"]);
    expect(v.map((x) => x.file)).toEqual(["packages/rater/src/engine.ts", "packages/rater/src/price.ts"]);
  });

  it("does NOT flag importing a specific module (not the barrel) — @shuddl/rater/engine or a nested index", () => {
    const v = analyzeRaterPurity([
      { path: "packages/rater/src/price.ts", content: 'import { priceFreight } from "@shuddl/rater/engine";' },
      { path: "packages/rater/src/sweep.ts", content: 'import { x } from "./sub/index.js";' },
    ]);
    expect(v).toEqual([]);
  });

  it("EXEMPTS the adapter subtree — it is the sole module allowed to contain/import class logic", () => {
    const v = analyzeRaterPurity([{ path: "packages/rater/src/adapters/class.ts", content: 'import { helper } from "./class-util.js";' }]);
    expect(v).toEqual([]);
  });

  it("EXEMPTS index.ts re-exporting the adapter — the barrel may expose it to external callers", () => {
    const v = analyzeRaterPurity([{ path: "packages/rater/src/index.ts", content: 'export { classToDensityPcf } from "./adapters/class.js";' }]);
    expect(v).toEqual([]);
  });

  it("does NOT exempt a nested foo/index.ts — only the src-root barrel is exempt", () => {
    const v = analyzeRaterPurity([{ path: "packages/rater/src/helpers/index.ts", content: 'export { toClass } from "../class-map.js";' }]);
    expect(v.map((x) => x.rule)).toEqual(["class_as_foundation"]);
  });

  it("passes a clean src module", () => {
    const v = analyzeRaterPurity([{ path: "packages/rater/src/money.ts", content: 'import { roundHalfUp } from "./util.js";\nexport const x = 1;' }]);
    expect(v).toEqual([]);
  });
});

describe("llm_in_rater: no LLM/agent SDK anywhere under packages/rater/src", () => {
  it("flags a core module importing @anthropic-ai/*", () => {
    const v = analyzeRaterPurity([{ path: "packages/rater/src/engine.ts", content: 'import Anthropic from "@anthropic-ai/sdk";' }]);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("llm_in_rater");
  });

  it("flags the bare specifier `ai`, `openai`, `@ai-sdk/*` and any `*agents*`", () => {
    const files = [
      { path: "packages/rater/src/engine.ts", content: 'import { generateText } from "ai";' },
      { path: "packages/rater/src/compose.ts", content: 'import OpenAI from "openai";' },
      { path: "packages/rater/src/floors.ts", content: 'import { x } from "@ai-sdk/openai";' },
      { path: "packages/rater/src/sweep.ts", content: 'import { run } from "@shuddl/agents/rater";' },
    ];
    const v = analyzeRaterPurity(files);
    expect(v.map((x) => x.rule)).toEqual(["llm_in_rater", "llm_in_rater", "llm_in_rater", "llm_in_rater"]);
  });

  it("flags LLM imports even in the exempt files (index.ts / adapters) — the LLM ban is universal", () => {
    const v = analyzeRaterPurity([{ path: "packages/rater/src/index.ts", content: 'export { chat } from "@anthropic-ai/sdk";' }]);
    expect(v.map((x) => x.rule)).toEqual(["llm_in_rater"]);
  });

  it("catches a side-effect import (no `from`) and a dynamic import()", () => {
    const files = [
      { path: "packages/rater/src/engine.ts", content: 'import "@anthropic-ai/sdk";' },
      { path: "packages/rater/src/compose.ts", content: 'const m = await import("openai");' },
    ];
    const v = analyzeRaterPurity(files);
    expect(v.map((x) => x.rule)).toEqual(["llm_in_rater", "llm_in_rater"]);
  });

  it("catches a BACKTICK dynamic import — import(`openai`) must not slip the merge gate", () => {
    const files = [
      { path: "packages/rater/src/engine.ts", content: "const m = await import(`openai`);" },
      { path: "packages/rater/src/compose.ts", content: "import `@anthropic-ai/sdk`;" },
    ];
    const v = analyzeRaterPurity(files);
    expect(v.map((x) => x.rule)).toEqual(["llm_in_rater", "llm_in_rater"]);
  });

  it("does not false-positive on legitimate relative/contract imports", () => {
    const files = [
      { path: "packages/rater/src/engine.ts", content: 'import { roundHalfUp } from "./money.js";' },
      { path: "packages/rater/src/price.ts", content: 'import type { ZoneTariff } from "@shuddl/contracts";' },
    ];
    expect(analyzeRaterPurity(files)).toEqual([]);
  });
});

describe("the REAL packages/rater/src is pure", () => {
  it("has zero purity violations (the engine never imports class or an LLM)", () => {
    const files = collectRaterSourceFiles();
    expect(files.length).toBeGreaterThan(0); // guard: prove we actually scanned the tree
    expect(analyzeRaterPurity(files)).toEqual([]);
  });
});

// NON-VACUITY OF THE SCAN ITSELF (audit §467). §466 measured the sibling append-chokepoint gate sitting at
// exit 0 with its globs pointed at a missing directory — a violation scan that scans nothing reports clean.
// This gate had the same gap and was the LAST of the eighteen: seven other glob-reading gates already carried
// a signal, so the class is bounded at one and closed here.
describe("rater-purity — the scan must actually find the package (audit §467)", () => {
  it("collectRaterSourceFiles finds the real rater sources", () => {
    const files = collectRaterSourceFiles(REPO_ROOT);
    expect(files.length, "the glob must match packages/rater/src — a broken scan disarms REQ-024 silently").toBeGreaterThan(5);
    expect(files.every((f) => f.path.startsWith("packages/rater/src/"))).toBe(true);
  });

  it("an EMPTY file set analyses clean — which is exactly why the count must be checked separately", () => {
    // The analysis is correct on empty input: no files, no violations. That correctness is what makes the
    // vacuity invisible, and it is the reason the guard belongs at the COLLECTION site rather than inside
    // analyzeRaterPurity — a pure function cannot tell "nothing to check" from "nothing wrong".
    expect(analyzeRaterPurity([])).toEqual([]);
  });
});
