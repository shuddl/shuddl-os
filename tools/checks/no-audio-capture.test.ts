import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { scanCorpus } from "./scan-corpus.js";
import { stripComments } from "./source-corpus.js";
import { parseRegister, type ReqRow } from "../traceability/register.js";

// §1048 — A CONFIRM-GATED PROHIBITION IS ENFORCED BY NOTHING, AND ONE OF THE THREE IS ONE WORD AWAY.
//
// CLAUDE.md's do-not-build list ends with: *"anything whose REQ row says CONFIRM-GATED while the CONFIRM is
// open (Direct merchant, voice recording, escrow settle)."* §1048 tested all three against the tree:
//
//   | prohibition      | register row        | code present | one word from a violation? |
//   |------------------|---------------------|--------------|----------------------------|
//   | Direct merchant  | REQ-104             | 0 files      | no — nothing adjacent      |
//   | escrow settle    | REQ-033 + REQ-143   | 0 files      | no — nothing adjacent      |
//   | voice recording  | REQ-096 + REQ-137   | 0 files      | **YES**                    |
//
// The asymmetry is the finding. Merchant and escrow have no adjacent built capability — reaching them means
// writing a subsystem. Voice recording's API is ALREADY CALLED, in shipping code, for a legitimate purpose:
// `apps/driver/src/components/CameraScreen.tsx` calls `getUserMedia({ video: { facingMode: "environment" } })`
// for REQ-063's forced photo. The prohibited capability is that object gaining `audio: true` — one property,
// in a file a driver-feature change already touches.
//
// MEASURED AT §1048, by planting exactly that word: the driver's own CameraScreen suite, `tsc --noEmit`,
// `pnpm lint` and `check:invariants` were **all four GREEN** with the live camera call requesting a
// microphone. Nothing in 26 gates could see it. `audio` is absent from the tree by authorship, not by
// enforcement — which is the state a prohibition is supposed to rule out.
//
// WHY THE REGISTER DECIDES, NOT THIS FILE. The ban is conditional: it holds *while the CONFIRM is open*. A
// hardcoded ban would outlive its own justification and have to be noticed and deleted by hand — the failure
// mode §945/§988 produced twice. So this gate READS REQ-096's status and COMPUTES its own applicability. When
// counsel closes CONFIRM-2 and the owner amends the row out of CONFIRM-GATED, the gate retires itself on the
// next run and says so. Read one side, compute the other — the register is source-of-truth #1, and this is
// what deriving authority from it looks like.
//
// SCOPE, STATED: capture, not playback. Rendering audio a user supplied is not recording them. The four
// markers below are the DOM's capture surface; a fifth arriving (a new API, a wrapper library) is invisible
// here, exactly as REQ-025's scanner is blind to a new storage entry point. That limit is why the gate names
// its markers rather than claiming to cover "audio".

const VOICE_REQS = ["REQ-096", "REQ-137"] as const;

/** The surfaces where DOM capture can occur. Workers have no `navigator`, so they are correctly absent. */
const GLOBS = [
  "apps/*/src/*.ts",
  "apps/*/src/**/*.ts",
  "apps/*/src/*.tsx",
  "apps/*/src/**/*.tsx",
  "packages/*/src/**/*.ts",
  "packages/*/src/*.tsx",
  "packages/*/src/**/*.tsx",
];

/**
 * Is the prohibition live? True while ANY voice REQ row is still CONFIRM-GATED.
 *
 * Exported and pure so both branches are testable WITHOUT editing `genesis/09` — the register is the owner's
 * file, and a gate that can only be tested by mutating it would never have its retirement path exercised.
 */
export function gateIsActive(rows: readonly ReqRow[]): { active: boolean; reason: string } {
  const found = rows.filter((r) => (VOICE_REQS as readonly string[]).includes(r.req_id));
  if (found.length === 0) {
    // Neither row exists. That is a register defect or a renumbering, not a licence to build — fail loud.
    return { active: true, reason: `neither ${VOICE_REQS.join(" nor ")} is in the register — cannot establish the CONFIRM is closed` };
  }
  const open = found.filter((r) => r.status === "CONFIRM-GATED");
  if (open.length === 0) {
    return { active: false, reason: `${found.map((r) => `${r.req_id}=${r.status}`).join(", ")} — the CONFIRM closed; this gate has retired itself` };
  }
  return { active: true, reason: `${open.map((r) => r.req_id).join(", ")} still CONFIRM-GATED` };
}

interface Marker { readonly name: string; readonly re: RegExp }

/**
 * The DOM's audio-CAPTURE surface. `getUserMedia`/`getDisplayMedia` are matched only when the constraint
 * object actually asks for audio — the video-only call at CameraScreen.tsx:69 is REQ-063 and must stay legal,
 * so a marker that fired on the API name alone would be useless the day it shipped.
 */
const MARKERS: readonly Marker[] = [
  { name: "getUserMedia/getDisplayMedia requesting audio", re: /get(?:User|Display)Media\s*\([^)]{0,200}?\baudio\b/s },
  { name: "MediaRecorder", re: /\bMediaRecorder\b/ },
  { name: "AudioContext", re: /\b(?:webkit)?AudioContext\b/ },
  { name: "SpeechRecognition", re: /\b(?:webkit)?SpeechRecognition\b/ },
];

export function audioCaptureHits(text: string): string[] {
  const src = stripComments(text);
  return MARKERS.filter((m) => m.re.test(src)).map((m) => m.name);
}

describe("§1048: while REQ-096's CONFIRM is open, no surface captures audio", () => {
  const root = repoRoot();
  const rows = parseRegister();
  const { active, reason } = gateIsActive(rows);
  const files = scanCorpus(GLOBS, root, { excludeTests: true });

  it("the matcher separates capture from the legal video-only call (unit cases)", () => {
    // REQ-063's shipping call — the exact text at CameraScreen.tsx:69. It must NOT trip the gate.
    expect(audioCaptureHits(`await md.getUserMedia({ video: { facingMode: "environment" } })`)).toEqual([]);
    // The one-word violation §1048 planted, which four gate families missed.
    expect(audioCaptureHits(`await md.getUserMedia({ video: { facingMode: "environment" }, audio: true })`))
      .toContain("getUserMedia/getDisplayMedia requesting audio");
    expect(audioCaptureHits(`navigator.mediaDevices.getUserMedia({ audio: true })`)).toHaveLength(1);
    expect(audioCaptureHits(`new MediaRecorder(stream)`)).toEqual(["MediaRecorder"]);
    expect(audioCaptureHits(`const ctx = new webkitAudioContext()`)).toEqual(["AudioContext"]);
    expect(audioCaptureHits(`new webkitSpeechRecognition()`)).toEqual(["SpeechRecognition"]);
    // A COMMENT saying the word is not a capture. This file is itself full of the word `audio`.
    expect(audioCaptureHits(`// we deliberately never request audio: true here\nconst x = 1;`)).toEqual([]);
  });

  it("the register decides whether the gate applies (both branches, without touching genesis/09)", () => {
    const row = (req_id: string, status: string): ReqRow =>
      ({ req_id, domain: "COMMS", requirement: "Voice", source: "", spec: "", wp: "", dod_test: "", status });
    expect(gateIsActive([row("REQ-096", "CONFIRM-GATED"), row("REQ-137", "CONFIRM-GATED")]).active).toBe(true);
    // ONE row closing is not enough — REQ-137 (per-state consent) gates the same capability.
    expect(gateIsActive([row("REQ-096", "F1"), row("REQ-137", "CONFIRM-GATED")]).active).toBe(true);
    // Both closed → the prohibition's own condition is false, and the gate stands down.
    expect(gateIsActive([row("REQ-096", "F1"), row("REQ-137", "F1")]).active).toBe(false);
    // A missing row must NOT read as permission — the dangerous default is the one that goes quiet.
    expect(gateIsActive([]).active).toBe(true);
  });

  it("scans a real corpus (per-glob non-vacuity is enforced by scanCorpus itself)", () => {
    // No `mayBeEmpty`: every glob matches today. `scanCorpus` throws `EmptyGlobError` the moment one stops,
    // so an amputated subtree fails loudly instead of shrinking the denominator in silence (§1041/§1044).
    // MEASURED 2026-08-11 at §1048: 108 files across the seven globs, tests excluded. The floor sits well
    // below that because its job is detecting a COLLAPSE; amputation is scanCorpus's job and the specific
    // file that matters is the assertion below. A floor set at the measured value would fail on every
    // legitimate deletion — which is how floors get raised past the point of meaning anything.
    expect(files.length, "no surface files scanned — the corpus is broken, not the repo").toBeGreaterThanOrEqual(80);
    // The gate must actually be reading the file that can violate it. A rename would otherwise retire this
    // check silently — the §572 shape, in the one file §1048 proved is one word from a violation.
    expect(files, "the driver's camera screen is not in the corpus — it is the file this gate exists for")
      .toContain("apps/driver/src/components/CameraScreen.tsx");
  });

  it("no surface file captures audio", () => {
    if (!active) {
      // Self-retired. Left as a passing test rather than deleted code so the transition is legible in CI output.
      expect(reason).toContain("retired");
      return;
    }
    const violations = files
      .map((f) => ({ f, hits: audioCaptureHits(readFileSync(`${root}/${f}`, "utf8")) }))
      .filter((x) => x.hits.length > 0)
      .map((x) => `${x.f}  →  ${x.hits.join(", ")}`);
    expect(
      violations,
      `surface file(s) capturing audio while the CONFIRM is OPEN (${reason}):\n  ` +
        violations.join("\n  ") +
        "\n\nCLAUDE.md forbids building anything whose REQ row says CONFIRM-GATED while the CONFIRM is open, " +
        "and REQ-137 makes per-state call-recording consent a counsel sign-off — two-party states are the " +
        "reason. MEASURED AT §1048: adding `audio: true` to the driver's live camera call left the driver " +
        "suite, typecheck, lint and check:invariants ALL GREEN, so this gate is the only thing that sees it.\n" +
        "If the capability is genuinely wanted, the route is the register, not the code: close CONFIRM-2, " +
        "amend REQ-096/REQ-137 out of CONFIRM-GATED, and this gate retires itself on the next run.",
    ).toEqual([]);
  });
});
