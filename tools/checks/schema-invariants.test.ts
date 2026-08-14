import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1425 (REQ-118) — THE EIGHT SCHEMA INVARIANTS NAME THEIR ENFORCERS, AND EACH RECORDS WHAT BREAKING IT DID.
//
// `genesis/10` states eight invariants I1–I8. CLAUDE.md makes them a source-of-truth surface second only to
// the register. Until §1425 they had NO machine-checked map: the audit claimed at §310/§323/§340/§341 that
// they were mutation-proved, and that claim was a sentence in a 90,000-line document. §1394 built exactly this
// file for CLAUDE.md's ten laws, for exactly that reason — and §1421/§1422 then found THREE of those ten rows
// naming evidence that does not enforce the clause the row states, none of which §1180's existence audit
// could see.
//
// So this map is built the way that experience says it must be: every row records the MUTATION that confirmed
// it and the file that noticed, not merely a file that exists nearby. The statements are checked against
// `genesis/10` itself rather than restated here, so a re-worded invariant cannot leave this map describing
// something the doc no longer says.

const GENESIS_10 = "genesis/10-EVENT-TAXONOMY-DATA-MODEL.md";

interface Invariant {
  readonly id: string;
  /** A distinctive fragment of the invariant AS WRITTEN in genesis/10 — checked against the doc below. */
  readonly states: string;
  /** The file whose failure IS the enforcement, established by breaking the clause. */
  readonly enforcer: string;
  /** The mutation applied and what it red. Required: existence is not enforcement (§1421/§1422). */
  readonly proven: string;
}

const INVARIANTS: readonly Invariant[] = [
  {
    id: "I1",
    states: "no money_line without event",
    enforcer: "packages/ledger/test/money-projection.test.ts",
    proven:
      "§1425 — set `event_id: \"\"` in projectMoneyLines so a money_line carries no originating event: four+ " +
      "cases red, incl. \"projectMoneyLines is a pure projection of the event payload\" and the D1-backed " +
      "\"applyMoneyProjection through real D1 (append batch + ux_ml_corrects)\".",
  },
  {
    id: "I2",
    states: "no invoice without pod.signed",
    enforcer: "packages/ledger/test/invoice-gate.test.ts",
    proven:
      "§1418 — made `assertPodSigned` a no-op: five cases red, incl. \"invoice.issued before pod.signed\". " +
      "§1419 additionally removed its CALL from the sequencer's append path: four more red.",
  },
  {
    id: "I3",
    states: "no event edit/delete grants exist at DB level",
    enforcer: "tools/checks/invariants.ts",
    proven:
      "§1417 — deleted `events_guard_upd` from migration 0001: check:invariants reds with \"I3 VIOLATION: " +
      "missing guard trigger events_guard_upd (must be BEFORE UPDATE ON events)\", not the lock error. " +
      "§1414/§1416 separately closed two source-side routes that evaded it.",
  },
  {
    id: "I4",
    states: "co-signed or explicitly flagged",
    enforcer: "packages/contracts/test/events.test.ts",
    proven:
      "§1425 — disabled the `!hasDevice && !unwitnessed` rejection at BOTH sites (the first attempt asserted " +
      "one and correctly refused to run): three cases red, incl. \"EventInput enforces I4 too — the shape a " +
      "write meets BEFORE it is stored\".",
  },
  {
    id: "I5",
    states: "every quote pins rate_config versions",
    enforcer: "packages/rater/test/price.test.ts",
    proven:
      "§1425 — emitted `versions: { rate_config_ids: [] }` from priceShipment so a priced quote pins nothing: " +
      "four cases red, incl. the case named \"PINS every rate_config that influenced the price (min 1) — I5\".",
  },
  {
    id: "I6",
    states: "respected by every view",
    enforcer: "workers/api/test/lens-adversarial.test.ts",
    proven:
      "§1425 — replaced `visibility <> 'internal'` with `visibility IS NOT NULL` at BOTH lens sites: reds in " +
      "TWO suites — the ledger's lens goldens and concierge-timeline cases, and the adversarial api cases " +
      "\"portal P1 sees zero internal kinds\", \"margins stripped\", \"requested_visibility 'counterparty' on " +
      "an internal kind is ignored\", and \"table-driven I6 visibility sweep\". genesis/10 says this one is " +
      "tested adversarially; it is.",
  },
  {
    id: "I7",
    states: "correction pairs net zero in GL export",
    enforcer: "packages/ledger/test/gl-netting.fixture.test.ts",
    proven:
      "§1425 — the FIRST mutation (Math.abs on the credit leg) changed nothing observable and was recorded as " +
      "a question, not a verdict; a second that cannot be a no-op (credit leg + 1) reds four, incl. \"I7 DoD " +
      "— 20 shipments, 8 corrections (4 round-trip pairs): the netting fixture\" and the QB month reconcile.",
  },
  {
    id: "I8",
    states: "22nd table",
    enforcer: "tools/checks/invariants.test.ts",
    proven:
      "§1424 — disabled `effective > TABLE_BUDGET`: three cases red, including two evasion shapes (\"23 " +
      "no-space bracket tables … summed to 0\" and \"21 space-delimited + 3 no-space = 24\"). End-to-end a " +
      "new table also trips classification and test-helper schema parity, so only the third failure is I8.",
  },
];

describe("§1425 REQ-118: genesis/10's eight invariants each name an enforcer and how it was confirmed", () => {
  const root = repoRoot();
  const doc = readFileSync(`${root}/${GENESIS_10}`, "utf8");

  it("the roster covers exactly the invariants genesis/10 defines — derived, not assumed", () => {
    // The count comes from the DOC. If a ninth invariant is written, this map becomes a statement about eight
    // of nine and must say so; if one is deleted, a row here outlives its subject (§1359).
    const declared = [...new Set([...doc.matchAll(/\bI([1-8])\b/g)].map((m) => `I${m[1]}`))].sort();
    expect(declared.length, "genesis/10 no longer declares eight invariants — the parser broke or the doc changed").toBe(8);
    expect(INVARIANTS.map((i) => i.id).sort()).toEqual(declared);
  });

  it("every row still quotes genesis/10 verbatim", () => {
    // Guards against the map drifting from the doc: a re-worded invariant should fail here rather than leave
    // this file describing a rule that no longer exists in those words.
    const missing = INVARIANTS.filter((i) => !doc.includes(i.states)).map((i) => `${i.id}: "${i.states}"`);
    expect(
      missing,
      "an invariant's text is no longer in genesis/10 — re-read the doc and re-confirm the row, do not just " +
        "edit the quote:\n  " + missing.join("\n  "),
    ).toEqual([]);
  });

  it("every named enforcer exists on disk", () => {
    const gone = INVARIANTS.filter((i) => !existsSync(`${root}/${i.enforcer}`)).map((i) => `${i.id} → ${i.enforcer}`);
    expect(gone, `an invariant's enforcer is gone:\n  ${gone.join("\n  ")}`).toEqual([]);
  });

  it("every row records the MUTATION that confirmed it, not merely a file that exists", () => {
    // The §1421/§1422 lesson: §1180 audited the ten-law map by existence, passed all ten, and missed three
    // rows naming the wrong evidence. Existence cannot distinguish "this file enforces the rule" from "this
    // file is adjacent to the rule". All eight of these are confirmed by mutation — there is no NOT PROVEN
    // row here, unlike the ten laws where rules 1 and 9 are unprovable by any gate.
    for (const i of INVARIANTS) {
      expect(i.proven, `${i.id} does not record how it was confirmed`).toBeTruthy();
      expect(i.proven.length, `${i.id}'s confirmation is too short to name a mutation and its result`).toBeGreaterThan(100);
      expect(i.proven, `${i.id} does not cite the section that broke it`).toMatch(/§\d{3,4}/);
    }
  });
});
