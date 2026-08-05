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

describe("REQ-151/REQ-201 — the translator's rating-config selection matches the API's", () => {
  it("EFFECTIVE_BY_KIND is character-identical to the api's", () => {
    const api = effectiveSql(apiRateConfigSrc);
    expect(api.length).toBeGreaterThan(0);
    expect(effectiveSql(translatorRateConfigSrc)).toBe(api);
  });

  it("that SQL still carries the whole selection rule (a canary on the rule itself, not just the copies)", () => {
    const sql = effectiveSql(apiRateConfigSrc);
    expect(sql).toContain("effective_ts <= ?2");
    expect(sql).toContain("ORDER BY effective_ts DESC, version DESC");
    expect(sql).toContain("LIMIT 1");
  });
});
