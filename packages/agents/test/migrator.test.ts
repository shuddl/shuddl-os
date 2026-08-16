import { describe, expect, it } from "vitest";
import {
  DeterministicMigrator,
  ClaudeMigrator,
  MigratorError,
  selectMigrator,
  buildOverrides,
} from "../src/index.js";
import { resolveColumnMapping } from "@shuddl/adapters";

// WP-14 Task 5 (REQ-127/035/024) — the Migrator LLM column-guesser. The LLM is NEVER hit in CI (every fetch
// below is a local stub). THE law under test: an unbound LLM degrades to the deterministic @shuddl/adapters
// mapping, and a malformed model response fail-safes to it — the model never silently rewrites the mapping.

// The Anthropic Messages envelope a stubbed fetch returns for a given model text.
function anthropicOk(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 });
}

const HEADERS = ["Customer", "Widget Code", "mode"]; // "Widget Code" is unmapped deterministically

describe("DeterministicMigrator — surfaces the @shuddl/adapters mapping, no LLM", () => {
  it("guesses equal the deterministic column mapping", async () => {
    const guesses = await new DeterministicMigrator().guess(HEADERS);
    const plan = resolveColumnMapping(HEADERS);
    expect(guesses).toEqual(plan.map((p) => ({ header: p.header, field: p.field, confidence: p.confidence })));
    // "Widget Code" is genuinely unmapped (field null) — the deterministic floor never fabricates a field.
    expect(guesses.find((g) => g.header === "Widget Code")?.field).toBeNull();
  });
});

describe("selectMigrator — degrades to deterministic when the LLM is unbound", () => {
  it("no key/model ⇒ DeterministicMigrator", () => {
    expect(selectMigrator()).toBeInstanceOf(DeterministicMigrator);
    expect(selectMigrator({ apiKey: "k" })).toBeInstanceOf(DeterministicMigrator); // model missing → still floor
  });
  it("key + model ⇒ ClaudeMigrator", () => {
    expect(selectMigrator({ apiKey: "k", model: "claude-x" })).toBeInstanceOf(ClaudeMigrator);
  });
});

describe("ClaudeMigrator — validated, fail-safe to deterministic", () => {
  it("a valid model response places an otherwise-unmapped header", async () => {
    // §1555 — capture the request so the COST ceiling is observable. This stub discarded it, which is why
    // `MAX_TOKENS` could be raised to 9,000,000,000 here with the suite green (audit §1554).
    const sent: RequestInit[] = [];
    const fetchImpl = async (_url: unknown, init?: RequestInit) => {
      sent.push(init ?? {});
      return anthropicOk(JSON.stringify([{ header: "Widget Code", field: "pro", confidence: 0.95 }]));
    };
    const guesses = await new ClaudeMigrator({ apiKey: "k", model: "m", fetchImpl: fetchImpl as unknown as typeof fetch }).guess(HEADERS);
    const tokens = (JSON.parse(String(sent[0]?.body ?? "{}")) as { max_tokens?: unknown }).max_tokens;
    expect(typeof tokens, "the migrator Messages request carries no max_tokens — an unbounded completion is an unbounded bill").toBe("number");
    expect(tokens as number, "max_tokens exceeds any sane per-call ceiling").toBeLessThanOrEqual(200_000);
    // The model's guess for "Widget Code" is merged; the other headers keep their deterministic guesses.
    expect(guesses.find((g) => g.header === "Widget Code")).toEqual({ header: "Widget Code", field: "pro", confidence: 0.95 });
    expect(guesses.find((g) => g.header === "mode")?.field).toBe("mode");
  });

  it("a MALFORMED model response fail-safes to the deterministic mapping (never a fabrication)", async () => {
    const fetchImpl = async () => anthropicOk("not json at all");
    const guesses = await new ClaudeMigrator({ apiKey: "k", model: "m", fetchImpl }).guess(HEADERS);
    expect(guesses).toEqual((await new DeterministicMigrator().guess(HEADERS)));
  });

  it("an out-of-shape model response (bad field) fail-safes to deterministic", async () => {
    const fetchImpl = async () => anthropicOk(JSON.stringify([{ header: "Customer", field: "not_a_field", confidence: 1 }]));
    const guesses = await new ClaudeMigrator({ apiKey: "k", model: "m", fetchImpl }).guess(HEADERS);
    expect(guesses).toEqual((await new DeterministicMigrator().guess(HEADERS)));
  });

  it("a 401 throws a non-retriable MigratorError; a 500 is retriable", async () => {
    const err401 = await new ClaudeMigrator({ apiKey: "k", model: "m", fetchImpl: async () => new Response("no", { status: 401 }) })
      .guess(HEADERS)
      .catch((e: unknown) => e);
    expect(err401).toBeInstanceOf(MigratorError);
    expect((err401 as MigratorError).retriable).toBe(false);

    const err500 = await new ClaudeMigrator({ apiKey: "k", model: "m", fetchImpl: async () => new Response("boom", { status: 500 }) })
      .guess(HEADERS)
      .catch((e: unknown) => e);
    expect((err500 as MigratorError).retriable).toBe(true);
  });
});

describe("buildOverrides — rescues weak/unmapped headers, never downgrades a confident map", () => {
  it("a ≥0.8 guess on an unmapped header becomes an override; a confident deterministic map is untouched", async () => {
    const guesses = [
      { header: "Customer", field: "shipper_name" as const, confidence: 0.6 }, // would DOWNGRADE a confident map → ignored
      { header: "Widget Code", field: "pro" as const, confidence: 0.9 }, // rescues an unmapped header → override
    ];
    const overrides = buildOverrides(HEADERS, guesses);
    expect(overrides).toEqual({ "Widget Code": { field: "pro", confidence: 0.9 } });
  });

  it("the deterministic guesser yields NO overrides (the full degrade path)", async () => {
    const guesses = await new DeterministicMigrator().guess(HEADERS);
    expect(buildOverrides(HEADERS, guesses)).toEqual({});
  });

  it("§1677 REQ-035 — a guess BELOW 0.8 never overrides, even on a header the deterministic pass could NOT map", () => {
    // REQ-035 is explicit: "Migrator: any export→primitives with confidence; <0.8 queues review". The floor
    // lives in `buildOverrides` as the SECOND conjunct of `!baseConfident && g.confidence >= 0.8` — and every
    // case above varies only the FIRST. "Customer" @0.6 is ignored because its deterministic map is already
    // confident, not because 0.6 is low. So the floor itself was unexercised: replacing `>= 0.8` with `>= 0`
    // left packages/agents 236/236 AND the import route 20/20 green (§1677).
    //
    // What that costs is not a dropped column (CLAUDE.md #10's rule, already gated) but a SILENTLY MIS-MAPPED
    // one: an ambiguous header — the bare "name"/"ref" the system prompt warns the model about — takes a
    // 0.2-confidence guess and overwrites the deterministic mapping during a ONE-SHOT legacy onboarding.
    const weak = [{ header: "Widget Code", field: "pro" as const, confidence: 0.79 }];
    expect(
      buildOverrides(HEADERS, weak),
      "0.79 is below REQ-035's floor: it must queue for review, never apply — and 'Widget Code' is unmapped " +
        "deterministically, so the never-downgrade rule is NOT what is refusing it here",
    ).toEqual({});

    // The boundary is INCLUSIVE (`>= 0.8`), which is exactly what "<0.8 queues review" means. Pinned from both
    // sides so neither loosening the floor nor tightening it past the requirement can pass.
    const atFloor = [{ header: "Widget Code", field: "pro" as const, confidence: 0.8 }];
    expect(buildOverrides(HEADERS, atFloor), "0.8 is AT the floor and applies — REQ-035 queues below it, not at it").toEqual({
      "Widget Code": { field: "pro", confidence: 0.8 },
    });
  });
});
