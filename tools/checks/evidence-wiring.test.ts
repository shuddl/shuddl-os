import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-170 §634 — THE EVIDENCE PRECONDITION IS GATED ON ITS OWN WIRING.
//
// §633 proved the Biller fails closed when a POD's bytes are absent: `held(evidence_missing)`, no invoice, no
// send, no terminal marker, four tests red under M138. Then it recorded the hole that proof leaves:
//
//     if (deps.evidence !== undefined) { ...the whole byte precondition... }
//
// The check is **skipped entirely** when the bucket is not wired. That gating is deliberate and correct — a
// unit test not exercising the byte gate omits the dep — but it means the production guarantee rests on one
// line in a composition root, and its own comment is the only thing asserting it:
//
//     "Production always provides it here, so the byte precondition always runs in prod."
//
// A comment is not a gate. If `evidence: env.EVIDENCE` is dropped from the deps assembly, or the R2 binding
// disappears from a deployable scope, the Biller stops requiring bytes and starts issuing invoices for PODs
// whose evidence does not exist — silently, because skipping is the documented behaviour of an unwired dep.
// That is money outrunning the physics, which is the inversion CLAUDE.md's first principle exists to prevent.
//
// Both halves are asserted because either alone is insufficient: the deps line without the binding is a
// runtime undefined, and the binding without the deps line is an unused bucket.

const INDEX = "workers/agents/src/index.ts";
const TOML = "workers/agents/wrangler.toml";

describe("REQ-170 §634: the Biller's evidence bucket is wired in production", () => {
  const root = repoRoot();

  it("the composition root passes the evidence bucket into BillerDeps", () => {
    const src = readFileSync(`${root}/${INDEX}`, "utf8");
    // Asserted on the DEPS ASSIGNMENT, not on the identifier appearing somewhere: `EVIDENCE` occurs in this
    // file in comments and in the retention sweep too, so a looser match would pass with the Biller unwired.
    expect(
      /\bevidence:\s*env\.EVIDENCE\b/.test(src),
      "the Biller's deps no longer carry `evidence: env.EVIDENCE`. The byte precondition is gated on that dep " +
        "being present, so it now SKIPS — invoices issue for PODs whose bytes were never stored, with no error " +
        "anywhere, because skipping is the documented behaviour of an unwired dep (REQ-170, §633)",
    ).toBe(true);
  });

  it("the R2 binding exists in every deployable scope", () => {
    const toml = readFileSync(`${root}/${TOML}`, "utf8");
    // dev included: the local scope is where a developer would first notice the precondition silently stop
    // running, and excluding it would make this gate blind exactly where the feedback is fastest.
    const blocks = toml.split(/\n(?=\[)/).filter((b) => /binding\s*=\s*"EVIDENCE"/.test(b));
    expect(
      blocks.length,
      "the EVIDENCE R2 binding is missing from one or more scopes in workers/agents/wrangler.toml. " +
        "`env.EVIDENCE` is then undefined at runtime and the Biller's byte precondition skips",
    ).toBeGreaterThanOrEqual(3);
  });

  it("the precondition is still gated on the dep (non-vacuity)", () => {
    // If the gating is ever removed — the precondition made unconditional — these assertions stop protecting
    // anything, and keeping them would be cargo cult. This states the assumption they rest on, so the day it
    // changes the reader is sent here rather than left with two tests guarding a hazard that no longer exists.
    const biller = readFileSync(`${root}/workers/agents/src/biller.ts`, "utf8");
    expect(
      /if\s*\(\s*deps\.evidence\s*!==\s*undefined\s*\)/.test(biller),
      "the Biller no longer gates the byte precondition on `deps.evidence` being present. If it is now " +
        "unconditional, this whole file is obsolete — delete it and say so. If it moved, re-point it",
    ).toBe(true);
  });
});
