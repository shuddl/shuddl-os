import { describe, expect, it } from "vitest";
import { buildRepoIndex, collectCitations, extractCitations, resolveCandidates } from "./citation-links.js";
import {
  checkRatchet,
  countUnanchored,
  formatRatchetViolation,
  loadRatchetConfig,
  type RatchetCounts,
  type Resolver,
} from "./citation-ratchet.js";

const TARGETS = ["workers/api/src/do/sequencer.ts", "packages/ledger/src/anchor.ts", "workers/api/src/routes/events.ts", "packages/contracts/src/events.ts"];

// A resolver over a tiny fake tree: exact path wins, otherwise every file with that basename.
const PATHS = [...TARGETS, "docs/quiet.md", "packages/rater/src/price.ts"];
const resolve: Resolver = (cited, citing) => resolveCandidates(cited, citing, PATHS);

function cite(citingFile: string, text: string) {
  return extractCitations(citingFile, text);
}

describe("counting: what the ratchet actually measures", () => {
  it("counts an UNanchored citation into a ratcheted target, keyed (citing file, target)", () => {
    const counts = countUnanchored(cite("docs/a.md", "`workers/api/src/do/sequencer.ts:100`"), TARGETS, resolve);
    expect(counts).toEqual({ "docs/a.md": { "workers/api/src/do/sequencer.ts": 1 } });
  });

  it("does NOT count an anchored citation — an anchor is the thing the ratchet is buying", () => {
    expect(countUnanchored(cite("docs/a.md", "`workers/api/src/do/sequencer.ts:100@ratecon`"), TARGETS, resolve)).toEqual({});
  });

  it("does NOT count a citation into a file that is not ratcheted", () => {
    expect(countUnanchored(cite("docs/a.md", "`packages/rater/src/price.ts:10`"), TARGETS, resolve)).toEqual({});
  });

  it("counts an AMBIGUOUS basename against every ratcheted candidate — fail-closed, and a nudge to write the full path", () => {
    const counts = countUnanchored(cite("docs/a.md", "`events.ts:200`"), TARGETS, resolve);
    expect(counts["docs/a.md"]).toEqual({ "packages/contracts/src/events.ts": 1, "workers/api/src/routes/events.ts": 1 });
  });

  it("accumulates multiple citations from the same file to the same target", () => {
    const counts = countUnanchored(cite("docs/a.md", "`packages/ledger/src/anchor.ts:10` and `packages/ledger/src/anchor.ts:20`"), TARGETS, resolve);
    expect(counts["docs/a.md"]?.["packages/ledger/src/anchor.ts"]).toBe(2);
  });
});

describe("the ratchet: fail on growth, fail on an un-banked fall, pass when held", () => {
  const baseline: RatchetCounts = { "docs/a.md": { "workers/api/src/do/sequencer.ts": 2 } };

  it("passes when the count is exactly held", () => {
    expect(checkRatchet({ "docs/a.md": { "workers/api/src/do/sequencer.ts": 2 } }, { targets: TARGETS, baseline })).toEqual([]);
  });

  it("FAILS when a count grows — the new unanchored citation is the whole point", () => {
    const v = checkRatchet({ "docs/a.md": { "workers/api/src/do/sequencer.ts": 3 } }, { targets: TARGETS, baseline });
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("grew");
    expect(v[0]?.baseline).toBe(2);
    expect(v[0]?.actual).toBe(3);
  });

  it("FAILS when a citing file that had no baseline entry adds one (a brand-new document counts as growth)", () => {
    const v = checkRatchet({ "docs/new.md": { "packages/ledger/src/anchor.ts": 1 } }, { targets: TARGETS, baseline });
    expect(v.map((x) => x.kind)).toContain("grew");
    expect(v.find((x) => x.kind === "grew")?.baseline).toBe(0);
  });

  it("tells the author what to do and why, naming the target", () => {
    const [v] = checkRatchet({ "docs/a.md": { "workers/api/src/do/sequencer.ts": 3 } }, { targets: TARGETS, baseline });
    const text = formatRatchetViolation(v!);
    expect(text).toMatch(/docs\/a\.md/);
    expect(text).toMatch(/workers\/api\/src\/do\/sequencer\.ts/);
    expect(text).toMatch(/@symbol/);
    expect(text).toMatch(/churn/i);
  });

  it("FAILS when a count FALLS — otherwise the ratchet silently loosens back to the old number", () => {
    const v = checkRatchet({ "docs/a.md": { "workers/api/src/do/sequencer.ts": 1 } }, { targets: TARGETS, baseline });
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("fell");
  });

  it("a fall reads as PROGRESS and names the one command that banks it", () => {
    const [v] = checkRatchet({ "docs/a.md": { "workers/api/src/do/sequencer.ts": 1 } }, { targets: TARGETS, baseline });
    const text = formatRatchetViolation(v!);
    expect(text).toMatch(/progress/i);
    expect(text).toMatch(/--write-ratchet/);
  });

  it("treats a vanished citing file as a fall to zero, not as a pass", () => {
    const v = checkRatchet({}, { targets: TARGETS, baseline });
    expect(v).toHaveLength(1);
    expect(v[0]?.actual).toBe(0);
    expect(v[0]?.kind).toBe("fell");
  });

  it("is silent about unanchored citations into NON-ratcheted files — that is the other 480+", () => {
    const counts = countUnanchored(cite("docs/a.md", "`packages/rater/src/price.ts:10`"), TARGETS, resolve);
    expect(checkRatchet(counts, { targets: TARGETS, baseline: {} })).toEqual([]);
  });
});

describe("the committed baseline matches the live tree (the lock that makes the ratchet real)", () => {
  it("every ratcheted target is a real repo path — a typo'd target would ratchet nothing, silently", () => {
    const config = loadRatchetConfig();
    const paths = new Set(buildRepoIndex().paths);
    expect(config.targets.filter((t) => !paths.has(t))).toEqual([]);
  });

  it("no ratcheted target is an ambiguous basename shared by many files (see: the index.ts rejection)", () => {
    const config = loadRatchetConfig();
    const paths = buildRepoIndex().paths;
    const overloaded = config.targets.filter((t) => paths.filter((p) => p.endsWith(`/${t.split("/").pop() ?? ""}`)).length > 3);
    expect(overloaded).toEqual([]);
  });

  it("the live count equals the committed baseline exactly", () => {
    const config = loadRatchetConfig();
    const index = buildRepoIndex();
    const live = countUnanchored(collectCitations(), config.targets, (cited, citing) => resolveCandidates(cited, citing, index.paths));
    expect(checkRatchet(live, config).map(formatRatchetViolation)).toEqual([]);
  });
});
