import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { scanCorpus } from "./scan-corpus.js";

// REQ-118 §598 — NO TENANT-FACING ERROR LEAVES THE API OUTSIDE THE ENVELOPE.
//
// §597 measured the error boundary and found it clean: every API failure throws `ApiError`, the global
// handler turns it into `ErrorEnvelope`, and an unexpected throw becomes a FIXED "INTERNAL ERROR" with the
// detail going only to the log. It then named its own gap: *"a route that builds its own Response for an
// error leaves the envelope and the handler entirely, and nothing above would see it."*
//
// That is the §567 shape — a chokepoint that holds today because everyone has used it, with nothing making
// the next person. A hand-built error response is not a hypothetical mistake: it is the shortest path when a
// route needs a status the helper does not obviously offer, and it silently opts out of `req_id`, the
// stable `code` clients switch on, and the fixed-message disclosure guard.
//
// THE RULE IS NARROW ON PURPOSE. `new Response` is legitimate for a SUCCESS body — `documents.ts` streams R2
// bytes with one, and forcing that through an envelope would be wrong. What must never happen is a raw
// response carrying an ERROR status. Measured when this landed: exactly ONE `new Response` in all of
// `workers/api/src`, on the byte-streaming path, with no status literal (so, 200).
//
// Scoped to `workers/api` alone, deliberately. The other workers legitimately answer outside the envelope:
// the Stripe webhook must reply in Stripe's shape, the flag-gated `/test-send` probe returns bare 404s as its
// no-oracle posture (§564), and unrouted requests in billing/translator get a plain 404. Widening this rule
// to them would produce four false positives and one disabled gate (§575's warning).

interface RawResponse {
  file: string;
  line: number;
  status: string;
}

function apiSourceFiles(root: string): string[] {
  // §625 — ONE glob (the `**` sibling was redundant: git's `*` crosses `/`). scanCorpus fails on an
  // empty match, so the corpus cannot silently collapse.
  return scanCorpus(["workers/api/src/*.ts"], root, { excludeTests: true });
}

/** Every `new Response(...)` in the api worker, with the status literal it carries (if any). */
function rawResponses(root: string): RawResponse[] {
  const out: RawResponse[] = [];
  for (const f of apiSourceFiles(root)) {
    const src = readFileSync(`${root}/${f}`, "utf8");
    for (const m of src.matchAll(/new Response\(/g)) {
      // A 220-char window comfortably spans a multi-line init object's `status:` field.
      const segment = src.slice(m.index, m.index + 220);
      const status = /status:\s*(\d{3})/.exec(segment);
      out.push({ file: f, line: src.slice(0, m.index).split("\n").length, status: status?.[1] ?? "none" });
    }
  }
  return out;
}

describe("REQ-118 §598: every API error goes through ErrorEnvelope", () => {
  const root = repoRoot();

  it("scans the api worker's source (non-vacuity)", () => {
    // A renamed directory would scan nothing and pass — the class this repo met in nine gates
    // (§487/§554/§572/§584/§586/§590/§592/§593).
    expect(apiSourceFiles(root).length, "no api source found — the scan is broken, not the tree").toBeGreaterThan(30);
  });

  it("no raw Response carries an error status — those must throw ApiError", () => {
    const errors = rawResponses(root).filter((r) => /^[45]\d\d$/.test(r.status));
    expect(
      errors,
      "a hand-built error response in the api worker. It bypasses ErrorEnvelope entirely: no `req_id` (so the " +
        "failure is not traceable to a log line), no stable `code` for clients to switch on, and none of the " +
        "fixed-message disclosure guard §597 pinned. Throw `ApiError` and let `handleError` shape it:\n  " +
        errors.map((r) => `${r.file}:${r.line}  status=${r.status}`).join("\n  "),
    ).toEqual([]);
  });

  it("the ONE legitimate raw Response is the document byte stream, and it stays a success path", () => {
    // Pinned by identity rather than by count: if this site ever gains an error status, the rule above fires,
    // and if a SECOND byte-streaming route appears it lands here as a deliberate decision rather than drifting
    // in. `toEqual` on the file list is what makes a second site a failure instead of a silent widening.
    const files = [...new Set(rawResponses(root).map((r) => r.file))];
    expect(files, "a new raw Response site appeared — confirm it is a success body, not an error").toEqual([
      "workers/api/src/routes/documents.ts",
    ]);
  });
});
