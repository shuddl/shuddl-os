import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrate.js";
import { authoritativeSource, resolveAuthority } from "../src/authority.js";
import type { AuthorityModule } from "../src/authority.js";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";

// WP-15 Task 2 (REQ-030 / REQ-008, Ten Laws L8) — the fail-closed proof for the authority read-seam. The
// EXHAUSTIVE fail-closed cases (a garbage authority value the real CHECK-constrained table forbids; a thrown
// query error) are exercised with a MOCK D1 that models exactly the prepare().bind().first() path
// resolveAuthority uses. A second block runs against the REAL authority_map schema (env.TENANT_A_DB +
// applyMigrations) to prove the SQL string, table, and column are faithful — a mock alone can't catch a wrong
// column name. The authoritativeSource truth table is pure. Per-test storage is isolated in pool-workers, so
// the seeded rows roll back after each `it`.

const DB = env.TENANT_A_DB;

// A minimal fake D1 modeling only prepare(sql).bind(...).first<T>(). `throwOn` simulates a read fault at each
// stage so the fail-closed try/catch is proven to swallow ALL of them (never throws, always 'legacy').
type FirstRow = { authority: string | null } | null;
function fakeDb(behavior: { row?: FirstRow; throwOn?: "prepare" | "bind" | "first" }): D1Database {
  return {
    prepare(_sql: string) {
      if (behavior.throwOn === "prepare") throw new Error("simulated prepare fault");
      return {
        bind(..._args: unknown[]) {
          if (behavior.throwOn === "bind") throw new Error("simulated bind fault");
          return {
            first: async () => {
              if (behavior.throwOn === "first") throw new Error("simulated query fault");
              return behavior.row ?? null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("resolveAuthority — 'native' ONLY for an exact native row; fail-closed to 'legacy' otherwise (REQ-030/L8)", () => {
  it("returns 'native' for a stored native row", async () => {
    expect(await resolveAuthority(fakeDb({ row: { authority: "native" } }), "rating")).toBe("native");
  });

  it("returns 'legacy' for a stored legacy row", async () => {
    expect(await resolveAuthority(fakeDb({ row: { authority: "legacy" } }), "rating")).toBe("legacy");
  });

  it("fail-closed 'legacy' for an ABSENT row (first() → null)", async () => {
    expect(await resolveAuthority(fakeDb({ row: null }), "invoicing")).toBe("legacy");
  });

  it("fail-closed 'legacy' for a NULL authority value", async () => {
    expect(await resolveAuthority(fakeDb({ row: { authority: null } }), "settlement")).toBe("legacy");
  });

  it("fail-closed 'legacy' for an UNRECOGNIZED value (case-exact — 'NATIVE'/'hybrid'/'' are NOT native)", async () => {
    expect(await resolveAuthority(fakeDb({ row: { authority: "NATIVE" } }), "comms")).toBe("legacy");
    expect(await resolveAuthority(fakeDb({ row: { authority: "hybrid" } }), "comms")).toBe("legacy");
    expect(await resolveAuthority(fakeDb({ row: { authority: "" } }), "comms")).toBe("legacy");
    expect(await resolveAuthority(fakeDb({ row: { authority: " native" } }), "comms")).toBe("legacy");
  });

  it("fail-closed 'legacy' on a thrown query error at ANY stage — never throws (the fail-closed proof)", async () => {
    await expect(resolveAuthority(fakeDb({ throwOn: "prepare" }), "rating")).resolves.toBe("legacy");
    await expect(resolveAuthority(fakeDb({ throwOn: "bind" }), "rating")).resolves.toBe("legacy");
    await expect(resolveAuthority(fakeDb({ throwOn: "first" }), "rating")).resolves.toBe("legacy");
  });
});

describe("resolveAuthority — against the REAL authority_map schema (SQL + table/column fidelity)", () => {
  beforeAll(async () => {
    await applyMigrations(DB, [
      { path: "0001_ledger_core.sql", sql: ledgerCore },
      { path: "0002_domain.sql", sql: domain },
    ]);
  });

  it("every never-seeded module fail-closes to 'legacy' (the UNSEEDED-map default — TODAY's behavior)", async () => {
    for (const m of ["rating", "invoicing", "dispatch", "settlement", "comms"] as AuthorityModule[]) {
      expect(await resolveAuthority(DB, m)).toBe("legacy");
    }
  });

  it("returns 'native' for a seeded native row and 'legacy' for a seeded legacy row (untouched stays legacy)", async () => {
    await DB.prepare("INSERT INTO authority_map (module, authority) VALUES ('rating','native')").run();
    await DB.prepare("INSERT INTO authority_map (module, authority) VALUES ('invoicing','legacy')").run();
    expect(await resolveAuthority(DB, "rating")).toBe("native");
    expect(await resolveAuthority(DB, "invoicing")).toBe("legacy");
    expect(await resolveAuthority(DB, "comms")).toBe("legacy"); // never seeded → still fail-closed
  });
});

describe("authoritativeSource — the truth table (native wins; legacy ONLY in shadow mode WITH a mirror)", () => {
  it("native authority ⇒ 'native' regardless of whether a mirror value exists", () => {
    expect(authoritativeSource("native", false)).toBe("native");
    expect(authoritativeSource("native", true)).toBe("native");
  });

  it("legacy authority WITHOUT a mirror value ⇒ 'native' (no-price-on-air: the freight is real)", () => {
    expect(authoritativeSource("legacy", false)).toBe("native");
  });

  it("legacy authority WITH a mirror value ⇒ 'legacy' (shadow mode — the ONLY path that yields legacy)", () => {
    expect(authoritativeSource("legacy", true)).toBe("legacy");
  });

  it("TODAY every caller passes legacyValueAvailable=false ⇒ ALWAYS 'native' (the behavior-neutral wiring)", () => {
    for (const a of ["native", "legacy"] as const) expect(authoritativeSource(a, false)).toBe("native");
  });
});
