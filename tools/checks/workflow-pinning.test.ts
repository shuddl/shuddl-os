import { describe, expect, it } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §974 — EVERY GITHUB ACTION IS PINNED TO AN IMMUTABLE COMMIT SHA.
//
// `ci.yml` and `nightly.yml` both state it in their headers: "Every action is pinned to an immutable commit
// SHA with its release tag in the trailing comment." MEASURED AT §974 and true without exception —
// checked=16 `uses:` refs, 16 SHA-pinned, 16 carrying the trailing tag comment.
//
// It was enforced by nothing. A mutable ref (`@v4`, `@main`) is a supply-chain hole of a specific kind: the
// tag keeps resolving, the workflow keeps passing, and the code executing in a job that holds
// `CLOUDFLARE_API_TOKEN` and `IDENTITY_DENYLIST` changes underneath it. Nothing in the repo would have
// objected, and §973 established there is no workflow validation here at all — no `actionlint`, no YAML
// parser available in this environment.
//
// This is the smallest gate that closes the highest-value part of that gap. It is a text scan by design: it
// needs no YAML parser (none is installable here) and therefore cannot break for the reason §973 could not
// be completed.
//
// SCOPE, STATED: this checks the REF is immutable and documented. It does not verify the SHA belongs to the
// action it names, nor that the trailing tag matches that SHA — both need the network and a token, and a
// gate that silently degrades when offline is worse than one with an honest boundary.

const WORKFLOW_GLOBS = [".github/workflows/*.yml", ".github/workflows/*.yaml"];
const SHA40 = /^[0-9a-f]{40}$/;

interface Ref {
  file: string;
  line: number;
  ref: string;
  hasTagComment: boolean;
}

function actionRefs(root: string): Ref[] {
  const out: Ref[] = [];
  for (const g of WORKFLOW_GLOBS) {
    for (const rel of globSync(g, { cwd: root }).sort()) {
      readFileSync(`${root}/${rel}`, "utf8")
        .split("\n")
        .forEach((l, i) => {
          const m = /uses:\s*([^\s#]+)/.exec(l);
          if (m === null) return;
          // A local composite action (`./.github/actions/x`) has no SHA to pin and is versioned by this repo.
          if ((m[1] as string).startsWith("./")) return;
          out.push({ file: rel, line: i + 1, ref: m[1] as string, hasTagComment: l.includes("#") });
        });
    }
  }
  return out;
}

describe("§974: every GitHub action is pinned to an immutable SHA", () => {
  const root = repoRoot();
  const refs = actionRefs(root);

  it("finds workflows and action refs at all (non-vacuity — checked=0 is a question, not an answer)", () => {
    // §968's rule, applied to this gate's own corpus. A renamed `.github/workflows/` directory or a glob that
    // stops matching would otherwise certify a clean supply chain over zero files.
    const files = WORKFLOW_GLOBS.flatMap((g) => globSync(g, { cwd: root }));
    expect(files.length, "no workflow files found — the glob is broken, not the repo").toBeGreaterThanOrEqual(2);
    expect(
      refs.length,
      "no `uses:` action refs parsed from the workflows — the scan is broken, not a repo without actions",
    ).toBeGreaterThanOrEqual(10);
  });

  it("no action is referenced by a mutable ref (tag, branch, or bare)", () => {
    const mutable = refs.filter((r) => !SHA40.test(r.ref.split("@").pop() ?? ""));
    expect(
      mutable,
      "workflow action(s) pinned to a MUTABLE ref:\n  " +
        mutable.map((r) => `${r.file}:${r.line}  ${r.ref}`).join("\n  ") +
        "\n\nA tag or branch keeps resolving while the code behind it changes — inside jobs that hold " +
        "CLOUDFLARE_API_TOKEN and IDENTITY_DENYLIST. Both workflow headers already promise the opposite: " +
        '"Every action is pinned to an immutable commit SHA with its release tag in the trailing comment." ' +
        "Pin to the 40-hex commit SHA and put the tag in a trailing comment.",
    ).toEqual([]);
  });

  it("every pin carries its release tag in a trailing comment", () => {
    // The second half of the stated convention, and the half that makes the first half maintainable: a bare
    // 40-hex SHA is unreviewable — nobody can tell v4.2.2 from an arbitrary commit without resolving it.
    const bare = refs.filter((r) => SHA40.test(r.ref.split("@").pop() ?? "") && !r.hasTagComment);
    expect(
      bare,
      "SHA-pinned action(s) with no trailing release-tag comment:\n  " +
        bare.map((r) => `${r.file}:${r.line}  ${r.ref}`).join("\n  ") +
        "\n\nThe pin is correct but unreviewable: a reader cannot distinguish a release tag from an arbitrary " +
        "commit without a network round-trip. Add `# vX.Y.Z`, as every other ref in these files does.",
    ).toEqual([]);
  });
});
