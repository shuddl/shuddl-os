import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { scanCorpus } from "./scan-corpus.js";

// REQ-118 §666 — AN EVENT PAYLOAD SCHEMA THAT IS NOT `.strict()` SILENTLY DROPS THE FIELD IT DID NOT KNOW.
//
// §665 pinned strictness on the event ENVELOPE. This is the same guarantee one level in, on the 28 payload
// schemas — and the consequence there is different, and worse.
//
// MEASURED, not assumed: a Zod object without `.strict()` does not pass an unknown key through, it STRIPS it.
// `z.object({a}).parse({a:1,b:2})` returns `{"a":1}`. So a payload schema that loses its `.strict()` does not
// start accepting richer events; it starts SILENTLY DISCARDING the parts it does not recognise.
//
// A mis-keyed field on `invoice.issued` (`ammount`) is then dropped, and the event is hashed and appended
// WITHOUT it. On an append-only ledger that record is permanent: corrections are new events (I3/I7), but
// nothing anywhere signalled that there was something to correct. That is the precise inversion of this
// repo's tenth engineering rule — "any legacy column that doesn't map raises a gap row, never disappears" —
// applied to the surface where the rule matters most, because a stored event is co-signed and immutable.
//
// All 28 are `.strict()` today. The defect this closes is that FOURTEEN of them were undefended: dropping
// every `.strict()` in `anchors.ts`, `driver-manifest.ts` and `money.ts` left contracts 304, ledger 634,
// api 798, agents 122, billing 58 and driver-core 41 ALL GREEN. Correct code, no enforcement — so the next
// DRY refactor that hoists a shared base object removes them without a single test noticing (§660's M167 is
// exactly that refactor, on a different schema).
//
// THE LIST IS DERIVED FROM THE SOURCE, NOT FROM A NAMING CONVENTION. An earlier cut of this gate matched
// `export const *Payload`, which is a proxy for "is an event payload" and would miss a schema named
// otherwise — §652's rule. The authoritative list is the second argument of every `evInput(...)` call, which
// is what actually decides what a client may put in a stored event.

const EVENTS = "packages/contracts/src/events.ts";

/** Payload schemas that are deliberately open, each with the reason it is not a closed set. */
const SANCTIONED_OPEN: ReadonlyMap<string, string> = new Map([
  [
    "JsonObject",
    "`quote.expired` carries no typed payload — the schema IS the open-object primitive, so requiring " +
      "`.strict()` on it is a category error. It has no field list to be strict about.",
  ],
]);

/** Every distinct schema handed to `evInput(kind, schema)` — the definitive payload surface. */
function payloadSchemas(src: string): { kinds: number; schemas: string[] } {
  const hits = [...src.matchAll(/evInput\(\s*"([^"]+)"\s*,\s*(\w+)\s*\)/g)];
  return { kinds: hits.length, schemas: [...new Set(hits.map((m) => m[2]!))].sort() };
}

/** The declaration body of `export const <name> = …`, up to the next top-level export. */
function declarationOf(name: string, sources: Map<string, string>): string | undefined {
  for (const src of sources.values()) {
    const m = new RegExp(String.raw`export const ${name}\s*=`).exec(src);
    if (!m) continue;
    const next = src.indexOf("\nexport const", m.index + 1);
    return src.slice(m.index, next > 0 ? next : undefined);
  }
  return undefined;
}

describe("REQ-118 §666: every event payload schema is a closed set", () => {
  const root = repoRoot();
  const files = scanCorpus(["packages/contracts/src/*.ts"], root, { excludeTests: true });
  const sources = new Map(files.map((f) => [f, readFileSync(`${root}/${f}`, "utf8")]));
  const { kinds, schemas } = payloadSchemas(readFileSync(`${root}/${EVENTS}`, "utf8"));

  it("finds the payload surface at all (non-vacuity — a broken parse must not read as clean)", () => {
    // Pinned against the 35-event-kind budget in CLAUDE.md rather than a loose floor: if these stop
    // agreeing, either the budget moved (a register amendment) or this parse broke, and both need a human.
    expect(kinds, "no evInput(kind, schema) calls parsed — the pattern is wrong, not the schema list").toBe(35);
    expect(schemas.length, "35 kinds must collapse to a plausible number of distinct payload schemas").toBeGreaterThanOrEqual(25);
  });

  it("every payload schema resolves to a declaration we can actually read", () => {
    // Without this, a renamed or re-exported schema would silently drop out of the strictness check below
    // and the gate would report clean on a surface it never looked at (§610: the selector needs its own floor).
    const unresolved = schemas.filter((s) => declarationOf(s, sources) === undefined);
    expect(unresolved, `payload schema(s) declared outside packages/contracts/src — this gate cannot see them:\n  ${unresolved.join("\n  ")}`).toEqual([]);
  });

  it("every payload schema is .strict() — an unknown key is REFUSED, never stripped", () => {
    const loose = schemas.filter((s) => !SANCTIONED_OPEN.has(s)).filter((s) => !declarationOf(s, sources)!.includes(".strict()"));
    expect(
      loose,
      "event payload schema(s) are not `.strict()`. Zod STRIPS unknown keys rather than passing them " +
        "through, so a mis-keyed field is silently discarded and the event is hashed and appended without " +
        "it — permanently, with nothing signalling there is anything to correct (I3/I7). Add `.strict()`, " +
        "or add the schema to SANCTIONED_OPEN with the reason it has no field list to close:\n  " +
        loose.join("\n  "),
    ).toEqual([]);
  });

  it("nothing sits in SANCTIONED_OPEN after it stops being a payload schema", () => {
    // §"record holds with expiry triggers" — an exemption outliving its subject is a standing excuse.
    const live = new Set(schemas);
    const stale = [...SANCTIONED_OPEN.keys()].filter((k) => !live.has(k));
    expect(stale, `SANCTIONED_OPEN excuses a schema no longer used as a payload — delete the entry:\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});
