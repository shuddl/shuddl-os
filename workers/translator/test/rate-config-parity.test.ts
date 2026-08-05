import { describe, expect, it } from "vitest";
import apiRateConfigSrc from "../../api/src/rate-config.ts?raw";
import translatorRateConfigSrc from "../src/rate-config.ts?raw";

// THE THIRD COPY (audit §223). `workers/agents/test/rate-config-parity.test.ts` guards api ↔ agents with a
// byte-identical assertion, because a drifted loader means one surface mis-prices while the other does not
// (REQ-151, "no price on air"). There is a THIRD copy — this worker's — and nothing covered it.
//
// It cannot be byte-identical: the translator needs only `loadTenantRatingConfig`, not the api's
// `loadTransitMatrix`, so the file is legitimately a subset (49 lines vs 84). What MUST agree is the part
// that decides WHICH config prices a load — and `inbound.ts` states the requirement outright: a 204-
// originated `quote.priced` must be "byte-identical to a CSR one (no misprice divergence)".
//
// So this pins the effective-selection SQL rather than the file. That one string carries the whole rule:
// rows already in effect (`effective_ts <= now`), newest first, ties broken by the highest row `version`,
// exactly one row. A fix to the tie-break or the horizon in the api that misses this copy would price an
// EDI booking differently from the identical CSR booking — silently, and only for tenants using EDI.
const EFFECTIVE_SQL = /const EFFECTIVE_BY_KIND =\s*([\s\S]*?);/;

function effectiveSql(src: string): string {
  const m = EFFECTIVE_SQL.exec(src);
  if (m === null) throw new Error("EFFECTIVE_BY_KIND not found — the loader's shape changed; re-read this test");
  return m[1]!.replace(/\s+/g, " ").trim();
}

// The `if (… === undefined …) return null;` line that makes all four configs REQUIRED (audit §280).
function requiredGuard(src: string): string {
  const m = /if \([^)]*=== undefined[^)]*\) return null;/.exec(src);
  return m === null ? "" : m[0];
}

describe("REQ-151/REQ-201 — the translator's rating-config selection matches the API's", () => {
  it("EFFECTIVE_BY_KIND is character-identical to the api's", () => {
    const api = effectiveSql(apiRateConfigSrc);
    expect(api.length).toBeGreaterThan(0);
    expect(effectiveSql(translatorRateConfigSrc)).toBe(api);
  });

  // audit §280 — the file declares itself "a FAITHFUL DUPLICATE of the REQUIRED-config half", and that half
  // has TWO load-bearing elements: the selection SQL (pinned above) and the requirement that ALL FOUR configs
  // be present. Only the first was pinned. The second is the "no price on air" law (CLAUDE.md #4) on the EDI
  // path: a missing required config must yield null, so inbound.ts's `if (config !== null)` skips pricing
  // instead of quoting against a partial tariff. The api pins the RUNTIME behaviour twice ("a tenant with no
  // rate_config → UNKNOWN no_tariff", "NO price on air: the loader is null"); the translator's copy had
  // neither, so the guard could be relaxed on this side alone with every gate green.
  it("the ALL-FOUR-REQUIRED guard is character-identical to the api's (the other half of the duplicate)", () => {
    const api = requiredGuard(apiRateConfigSrc);
    expect(api.length, "the api's required-config guard must be found, or this test pins nothing").toBeGreaterThan(0);
    expect(requiredGuard(translatorRateConfigSrc)).toBe(api);
  });

  it("that guard still names all FOUR required kinds (a canary on the rule, not just the copies)", () => {
    const guard = requiredGuard(apiRateConfigSrc);
    for (const v of ["zt", "fl", "fs", "acc"]) expect(guard).toContain(`${v} === undefined`);
    expect(guard, "class_adapter is loaded but OPTIONAL — requiring it would break cold-start tenants").not.toContain("cls === undefined");
    expect(guard).toContain("return null");
  });

  it("that SQL still carries the whole selection rule (a canary on the rule itself, not just the copies)", () => {
    const sql = effectiveSql(apiRateConfigSrc);
    expect(sql).toContain("effective_ts <= ?2");
    expect(sql).toContain("ORDER BY effective_ts DESC, version DESC");
    expect(sql).toContain("LIMIT 1");
  });
});
