import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { stripComments } from "./source-corpus.js";

// §925 — A TENANT-SCOPED STORAGE KEY BUILT *INLINE* IS INVISIBLE TO THE GATE THAT GUARDS THEM.
//
// `tenant-scope.test.ts` (§572/§700/§702) is the REQ-025 guard for storage entry points: it reads each
// GUARDED_FNS declaration, finds the tenant PARAMETER's position, and requires every CALL to pass an
// authenticated expression there. It also carries a completeness half (§702) that derives the roster rather
// than trusting it — *"which exported functions take a tenant AND touch storage"*.
//
// Both halves are keyed on a FUNCTION. A key built inline —
//
//     const key = `${session.tenant}/imports/${body.r2_key}`;
//
// has no declaration to read a parameter position from and no export to derive, so it is outside the gate
// entirely. Not allowlisted, not exempted: **invisible**.
//
// MEASURED AT §925, twice and independently (a discovery sweep and a hand scan agreeing): exactly TWO such
// sites exist — `workers/api/src/routes/import.ts` and `workers/translator/src/inbound.ts`. **Neither is a
// live defect**: the translator's 990 ack key is pinned by `translator/isolation.test.ts` case 3b, written
// explicitly to catch a dropped `${tenant}` prefix, and the import key was pinned at §921 after its own
// mutation showed the whole api suite green without it.
//
// So this gate repairs no defect. It closes the DISCOVERY half of a guard that already has a roster half —
// the shape this repo keeps meeting (§802/§822/§920): a roster finds what it lists; only a scan finds what
// arrives. R2 is why it is worth the file: per-tenant D1 is PHYSICAL isolation and a wrong slug throws,
// while R2 is ONE SHARED BUCKET partitioned by a string prefix, so a dropped segment reads another tenant's
// objects with no error anywhere.

/** A template literal that interpolates a tenant AND contains a path separator — i.e. a storage key. */
const TENANT_KEY = /`[^`]*\$\{[^}]*\b(?:tenant|tenantSlug|tenantId|session\.tenant|claims\.t|req\.tenant)\b[^}]*\}[^`]*`/;
const HAS_PATH = /`[^`]*\/[^`]*`/;
/** Diagnostics and identifiers are not storage keys. Excluded by the STATEMENT they sit in, not by guesswork. */
const NOT_A_KEY = /console\.|throw |new Error\(|detail:|reason:|message:|idFromName|sha256Hex|uuidFromSeed|filename=/;

interface Site {
  file: string;
  line: number;
  snippet: string;
}

function inlineTenantKeys(root: string): Site[] {
  const files = execSync("git ls-files", { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && f.includes("/src/") && !f.includes(".test."));
  const out: Site[] = [];
  for (const f of files) {
    const lines = stripComments(readFileSync(`${root}/${f}`, "utf8")).split("\n");
    lines.forEach((raw, i) => {
      const l = raw.trim();
      if (!TENANT_KEY.test(l) || !HAS_PATH.test(l) || NOT_A_KEY.test(l)) return;
      out.push({ file: f, line: i + 1, snippet: l.slice(0, 100) });
    });
  }
  return out;
}

/**
 * Every tenant-interpolated storage key in source, and what accounts for it. `builder` means the literal is
 * the BODY of a named function that `tenant-scope.test.ts` already guards — the gate sees every call site.
 * `inline` means there is no function, so the gate cannot see it, and the named test is what stands in.
 *
 * Keyed by FILE plus a code SNIPPET, never by line number: an edit elsewhere in the file rots a line anchor
 * and this repo has the scars (§913, §885). A moved key keeps its row; a CHANGED key loses it, which is the
 * moment someone should look.
 */
const ACCOUNTED: ReadonlyArray<{ file: string; contains: string; how: string }> = [
  { file: "packages/ledger/src/anchor.ts", contains: "anchors/${tenant}/${day}/tsr.der", how: "builder: anchorReceiptKey" },
  { file: "packages/ledger/src/anchor.ts", contains: "anchors/${tenant}/${day}/manifest.json", how: "builder: anchorManifestKey" },
  { file: "packages/ledger/src/documents/retention.ts", contains: "evidence/${tenant}/", how: "builder: evidenceTenantPrefix" },
  { file: "packages/ledger/src/watchtower-snapshot.ts", contains: "watchtower/${tenant}/", how: "builder: snapshotKey" },
  { file: "workers/api/src/routes/evidence.ts", contains: "evidence/${tenant}/${shipmentId}/${hash}", how: "builder: evidenceKey" },
  { file: "workers/translator/src/sweep-214.ts", contains: "edi/${tenant}/tender/", how: "builder: tenderPrefix" },
  // `tenderKey` is deliberately NOT a row: its literal is `${tenderPrefix(tenant)}${shipmentId}` — the path
  // separator lives in the BUILDER it composes, not in this template, so the detector does not see it and a row
  // here would be dead weight. The §672 half caught exactly that on the first run.
  { file: "workers/translator/src/sweep-214.ts", contains: "edi/${tenant}/214/${dedupeKey}", how: "builder: sent214Key" },
  { file: "workers/translator/src/sweep-214.ts", contains: "edi/${tenant}/quarantine/", how: "builder: quarantineKey" },
  { file: "workers/translator/src/sweep-214.ts", contains: "edi/${tenant}/unresolvable/", how: "builder: unresolvableKey" },
  // PREFIX GUARDS — not keys built, but keys CHECKED. Same tenant segment, same consequence if dropped.
  { file: "workers/agents/src/biller.ts", contains: "evidence/${tenant}/", how: "guard: the POD row must live in this tenant's namespace" },
  { file: "workers/api/src/routes/documents.ts", contains: "evidence/${claims.t}/", how: "guard: doc-cap confinement — pinned by documents.test.ts (§921)" },
  // THE TWO INLINE SITES. No builder exists, so tenant-scope.test.ts cannot see either.
  {
    file: "workers/api/src/routes/import.ts",
    contains: "${session.tenant}/imports/",
    how: "INLINE — pinned by workers/api/test/import.test.ts (§921): a key naming another tenant's upload 404s, with a control that the same bytes under this tenant's prefix DO import",
  },
  {
    file: "workers/translator/src/inbound.ts",
    contains: "edi/${tenantSlug}/990/",
    how: "INLINE — pinned by workers/translator/test/isolation.test.ts case 3b, written explicitly to catch a dropped ${tenant} prefix",
  },
];

describe("§925: every tenant-interpolated storage key is accounted for", () => {
  const root = repoRoot();
  const sites = inlineTenantKeys(root);

  it("the scan finds a real population (non-vacuity — an empty scan accounts for nothing)", () => {
    // A changed template style, a moved src layout, or a broken ls-files read yields [] and the comparison
    // below would pass over nothing — the failure this repo met in four gates (§487/§554/§572).
    expect(sites.length, "no tenant-interpolated storage keys found — the scan is broken, not the source").toBeGreaterThanOrEqual(10);
  });

  it("every site matches an ACCOUNTED row (a new inline tenant key must be classified)", () => {
    const unaccounted = sites
      .filter((s) => !ACCOUNTED.some((a) => a.file === s.file && s.snippet.includes(a.contains)))
      .map((s) => `${s.file}:${s.line}  ${s.snippet}`);
    expect(
      unaccounted,
      "a tenant-scoped storage key is built or checked inline and nothing accounts for it. `tenant-scope.test.ts` " +
        "is keyed on FUNCTION declarations, so an inline template is invisible to it — not allowlisted, INVISIBLE. " +
        "R2 is one shared bucket partitioned by a string prefix: a dropped tenant segment reads another tenant's " +
        "objects with no error anywhere. Either extract a named builder and add it to GUARDED_FNS (preferred — " +
        "that buys the call-site check too), or add a row here naming the test that drives a dropped prefix:\n  " +
        unaccounted.join("\n  "),
    ).toEqual([]);
  });

  it("no ACCOUNTED row outlives its subject (§672)", () => {
    const dead = ACCOUNTED.filter((a) => !sites.some((s) => s.file === a.file && s.snippet.includes(a.contains))).map(
      (a) => `${a.file}  «${a.contains}»  — ${a.how}`,
    );
    expect(
      dead,
      "an ACCOUNTED row names a key that no longer exists in that file. The key was deleted (delete the row) or " +
        "CHANGED (read it — a changed tenant-scoped key is exactly the edit worth looking at):\n  " + dead.join("\n  "),
    ).toEqual([]);
  });
});
