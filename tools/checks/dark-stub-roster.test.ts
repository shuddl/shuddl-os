import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1366 (REQ-021/024/109/152/154) — EVERY COMPOSITION ROOT THAT CAN RETURN A DARK STUB IS PINNED.
//
// A `NotConfigured*` stub is how this repo ships a capability that is deliberately not live: the EDI transport,
// the legacy feed, webhook delivery, MCP client-secret resolution, the LLM parsers. Each has a selector — a
// composition root — deciding whether production gets the stub or the real thing. §380 found the shape:
//
//     "the BEHAVIOUR of each default was pinned, the CHOICE of them was not, so swapping in a live
//      implementation broke nothing"
//
// …and then fixed two roots rather than counting them. Nine hundred sections later §1362 found a third
// (`feedReaderFor`), §1363 a fourth (`conciergeParser`) — and §1363's own survey undercounted because its body
// extraction could not span nested braces.
//
// THERE ARE NINE ROOTS, and building this gate immediately exposed a FALSE PIN among them rather than a tenth
// root: `secretResolverFor` in workers/mcp — which decides whether MCP client authentication is live — was
// credited as pinned by three consecutive manual sweeps because a repo-wide text match saw `toBeInstanceOf(
// NotConfiguredSecretResolver)` in workers/TRANSLATOR's suite. Zero mcp tests named it. The same-package rule
// below is the whole reason that surfaced, and it surfaced within a minute of the gate first running.
//
// FOUR MANUAL SWEEPS, FOUR DIFFERENT ANSWERS, AND A FALSE PIN THEY ALL SHARED, IS THE ARGUMENT FOR A GATE.
//
// HOW IT EXTRACTS. By BRACE DEPTH, never a line window and never a nesting-limited regex — the §1338/§1363
// lesson, and the specific reason the previous counts were wrong. A gate built from a cruder instrument than the
// one it replaces inherits the blind spot it exists to remove.
//
// HOW IT DECIDES "PINNED". A test IN THE SAME package/worker must both name the selector and assert
// `toBeInstanceOf(<its stub>)`. Same-package matters: `evidenceSender` exists in workers/agents AND workers/api,
// and a repo-wide text match credited the first with the second's assertion (§1363). Cross-package "coverage" is
// not coverage.

interface Root {
  readonly fn: string;
  readonly stub: string;
  readonly file: string;
  readonly pkg: string;
}

const pkgOf = (p: string): string => p.split("/").slice(0, 2).join("/");

/** Extract a function body by brace depth from a line index. */
function bodyFrom(lines: readonly string[], start: number): string {
  let depth = 0;
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    out.push(lines[i]!);
    depth += (lines[i]!.match(/\{/g) ?? []).length - (lines[i]!.match(/\}/g) ?? []).length;
    if (depth <= 0 && out.length > 1) break;
  }
  return out.join("\n");
}

// §1505 — `.tsx` INCLUDED. The filter used to read `.ts` only, dropping the 14 `.tsx` files that live
// inside the very trees this corpus names. Measured at §1505 by planting this gate's own violation in
// `packages/agents/src/collector/dunning.tsx`: the suite stayed green. Nothing in a render view should
// trip this rule — which is the point, because that is also what was said about `evidence-email-view.tsx`
// until `formatCents` turned out to live there (float-money-division, same phase). A corpus should match
// the RULE's subject, not the file type its author pictured; widening is free while the gate stays green.
// §1506 — `apps` INCLUDED. The tree list was packages+workers, and the driver PWA composes its own transports
// (`apps/driver/src/sync`) — exactly the shape this gate exists for. MEASURED at §1506: a root returning a
// `new NotConfigured…()` planted in `apps/driver/src/sync/useSync.ts` left the suite 4/4 green, while the same
// probe in a `packages` file reds. A composition root in a surface is still a composition root.
function shippedFiles(root: string): string[] {
  return execSync("git ls-files packages workers apps", { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.") && !f.includes("/test/"));
}

function testFiles(root: string): string[] {
  // …and the TEST side widens with it: a root in `apps` can only be pinned by a test in `apps`.
  return execSync("git ls-files packages workers apps", { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.includes(".test."));
}

function darkStubRoots(root: string): Root[] {
  const found: Root[] = [];
  for (const file of shippedFiles(root)) {
    const lines = readFileSync(`${root}/${file}`, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = /(?:export )?(?:async )?function (\w+)\(/.exec(lines[i]!);
      if (!m) continue;
      const body = bodyFrom(lines, i);
      const stub = /new (NotConfigured\w+)/.exec(body);
      if (!stub) continue;
      found.push({ fn: m[1]!, stub: stub[1]!, file, pkg: pkgOf(file) });
    }
  }
  return found;
}

// EXEMPT — a root whose CHOICE is pinned by something other than a `toBeInstanceOf` on the selector. Each entry
// states the mechanism, and the staleness case below refuses an exemption whose subject has gone (§1359/§672).
const EXEMPT: readonly { readonly fn: string; readonly pkg: string; readonly why: string }[] = [
  {
    fn: "evidenceSender",
    pkg: "workers/agents",
    why:
      "not exported, and pinned BEHAVIOURALLY end-to-end by workers/agents/test/test-send.test.ts — 'gate 4' " +
      "drives the route with nothing bound and asserts no outbound send, 'gate 5' binds RESEND_API_KEY + " +
      "EVIDENCE_FROM and asserts the send happens. Both directions of the choice are observed through the real " +
      "selector, which is stronger than an instanceof on it.",
  },
];

describe("§1366: every dark-stub composition root is pinned", () => {
  const root = repoRoot();
  const roots = darkStubRoots(root);
  const tests = testFiles(root).map((f) => ({ f, text: readFileSync(`${root}/${f}`, "utf8") }));

  it("finds the roots at all (non-vacuity — an empty scan must not read as universal compliance)", () => {
    // The floor bounds the CORPUS, not the hits (§1148): if the extractor breaks, this fails rather than
    // silently certifying a tree it never parsed.
    expect(shippedFiles(root).length, "no shipped source found — the scan is broken, not the tree").toBeGreaterThan(150);
    expect(roots.length, "dark-stub composition roots went missing — the extractor broke; there were NINE at §1366").toBeGreaterThanOrEqual(9);
  });

  it("every root's CHOICE is asserted by a test in its OWN package", () => {
    const unpinned = roots
      .filter((r) => !EXEMPT.some((e) => e.fn === r.fn && e.pkg === r.pkg))
      .filter(
        (r) =>
          !tests.some(
            (t) => pkgOf(t.f) === r.pkg && t.text.includes(r.fn) && new RegExp(`toBeInstanceOf\\(\\s*${r.stub}`).test(t.text),
          ),
      )
      .map((r) => `${r.file}::${r.fn} → ${r.stub}`);

    expect(
      unpinned,
      "a composition root can hand production a NotConfigured* stub — or a LIVE implementation — and no test in " +
        "its own package asserts which. That is how a capability goes live silently: the stub's behaviour is " +
        "covered, the CHOICE of it is not (§380). Add a case asserting the selector `toBeInstanceOf` its stub, " +
        "in that package's own suite, with a message naming what going live costs. If the choice is genuinely " +
        "pinned another way, add it to EXEMPT above WITH the mechanism:\n  " +
        unpinned.join("\n  "),
    ).toEqual([]);
  });

  it("no EXEMPT entry has outlived its subject (§1359 — an exemption's failure mode is silence)", () => {
    const orphaned = EXEMPT.filter((e) => !roots.some((r) => r.fn === e.fn && r.pkg === e.pkg)).map((e) => `${e.pkg}::${e.fn}`);
    expect(
      orphaned,
      "an EXEMPT entry names a root that no longer exists — it is now a standing excuse for nothing. Delete it, " +
        "or point it at whatever replaced that selector:\n  " +
        orphaned.join("\n  "),
    ).toEqual([]);
  });

  it("every EXEMPT entry still names the test file that justifies it", () => {
    // An exemption that cites a mechanism is only as good as the mechanism still existing. §1359's lesson, one
    // level deeper: the subject can survive while its stated justification is deleted.
    for (const e of EXEMPT) {
      const cited = /([\w/-]+\.test\.ts)/.exec(e.why);
      expect(cited, `${e.pkg}::${e.fn}: the exemption cites no test file — state the mechanism`).not.toBeNull();
      expect(
        tests.some((t) => t.f === cited![1]),
        `${e.pkg}::${e.fn}: the exemption cites ${cited![1]}, which no longer exists`,
      ).toBe(true);
    }
  });
});
