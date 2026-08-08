import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-167 §621 — NO TRACKED ARTIFACT EMBEDS AN ABSOLUTE HOME PATH.
//
// REQ-167 bans "any tenant/person/customer/incumbent-vendor name in any repo artifact", and `check:identity`
// enforces it with a DENYLIST — a list of names, maintained client-side and held by the owner. That design is
// right for tenant and vendor names, which are unguessable from inside the repo. It has one structural blind
// spot: **it can only catch a name someone thought to add.**
//
// An absolute home path leaks a person identifier without needing to be on any list. `/Users/<name>/…` and
// `/home/<name>/…` embed the operator's account name in the artifact itself.
//
// MEASURED (§621): 39 occurrences across 5 files in docs/plans/, all carrying the same username, in
// operational instructions ("prefix every command with PATH=…"). They were also a portability defect — none
// of those commands run on another machine — which is the tell that the leak and the bug are the same edit.
//
// This rule is denylist-INDEPENDENT and therefore complementary rather than redundant: `check:identity` knows
// which names matter and cannot see a name it was never told; this knows nothing about names and cannot miss
// the shape. Neither subsumes the other.
//
// Scoped to TEXT artifacts. Binary fixtures and images are excluded — a path inside a PNG is not something a
// reader or a grep will surface, and including them would make the scan slow and noisy for no gain.

const ABSOLUTE_HOME = /(?:\/Users\/[a-z][a-z0-9._-]*|\/home\/[a-z][a-z0-9._-]*|[A-Z]:\\Users\\[A-Za-z])/;

/** Every tracked text file, minus the binaries and this rule's own source. */
function textFiles(root: string): string[] {
  return execSync("git ls-files", { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((f) => f && !/\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|woff2?|ttf|otf|pbf|mbtiles)$/i.test(f))
    // This file necessarily contains the pattern it bans, in the regex above and in the comment explaining
    // it. §606/§612/§618 met the same shape three times — prose quoting a known-bad value trips its own gate —
    // and the fix each time was to exclude the one file that must contain it, by identity, never by pattern.
    .filter((f) => f !== "tools/checks/absolute-paths.test.ts");
}

interface Leak {
  file: string;
  line: number;
}

function leaks(root: string): Leak[] {
  const out: Leak[] = [];
  for (const f of textFiles(root)) {
    let src: string;
    try {
      src = readFileSync(`${root}/${f}`, "utf8");
    } catch {
      continue; // unreadable bytes that slipped the extension filter — not a text artifact
    }
    src.split("\n").forEach((line, i) => {
      if (ABSOLUTE_HOME.test(line)) out.push({ file: f, line: i + 1 });
    });
  }
  return out;
}

describe("REQ-167 §621: no tracked artifact embeds an absolute home path", () => {
  const root = repoRoot();

  it("scans the tracked text corpus (non-vacuity)", () => {
    // A broken `git ls-files` or an over-eager extension filter would scan nothing and report clean — the
    // class this repo met in sixteen gates (§487 … §618).
    expect(textFiles(root).length, "no tracked text files found — the scan is broken, not the tree").toBeGreaterThan(200);
  });

  it("no file carries a /Users/<name> or /home/<name> path", () => {
    const found = leaks(root);
    expect(
      found,
      "an absolute home path in a tracked artifact. It embeds the operator's account name — REQ-167 bans a " +
        "person name in ANY repo artifact, and `check:identity` cannot help here because its denylist only " +
        "catches names someone thought to add. It is also a portability defect: the command or path does not " +
        "work on any other machine. Use $HOME, a repo-relative path, or an env var:\n  " +
        found.map((l) => `${l.file}:${l.line}`).join("\n  "),
    ).toEqual([]);
  });
});
