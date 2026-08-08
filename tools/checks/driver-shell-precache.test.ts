import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-061 §721 — `cache.addAll` IS ATOMIC, SO ONE BAD PATH COSTS THE WHOLE PRECACHE.
//
// The driver's service worker precaches its shell on install:
//
//     event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)) …)
//
// `addAll` rejects if ANY entry 404s, and a rejected `waitUntil` fails the install. So a single typo in a
// four-element list does not degrade the precache — it removes it entirely, and the symptom a driver reports
// is "the app doesn't open offline", not "a file is missing". §720 walked this chain link by link and named
// this as its sharpest unguarded edge: the list resolves today only because Vite emits `/index.html` from the
// app root, which is a dependency on the BUILD that the worker never states and nothing verified.
//
// This is a source-level floor, not a build-level one, and the distinction is honest: it proves each entry
// has a producer in the repo. It cannot prove the built bundle actually served it — that is what the
// airplane-mode soak fixture is for (owner-held, `fixtures/manifest.json`), and §717's fix is the first thing
// that soak should be pointed at.

const SW = "apps/driver/public/sw.js";
const PUBLIC = "apps/driver/public";
const VITE_ROOT_HTML = "apps/driver/index.html";

/** The precache list as the worker declares it. */
function shellEntries(src: string): string[] {
  const m = /const SHELL\s*=\s*\[([^\]]*)\]/.exec(src);
  if (m === null) return [];
  return [...m[1]!.matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]!);
}

/**
 * Where a served path comes from. Two producers, both stated rather than guessed:
 *  - `public/` is copied verbatim by Vite, so `/x` ⇒ `apps/driver/public/x`;
 *  - `/` and `/index.html` are the Vite root's `index.html`, emitted at build.
 */
function producerFor(root: string, url: string): string | null {
  if (url === "/" || url === "/index.html") {
    return existsSync(`${root}/${VITE_ROOT_HTML}`) ? VITE_ROOT_HTML : null;
  }
  const rel = `${PUBLIC}${url}`;
  return existsSync(`${root}/${rel}`) ? rel : null;
}

describe("REQ-061 §721: every precached shell path has a producer", () => {
  const root = repoRoot();
  const src = readFileSync(`${root}/${SW}`, "utf8");
  const shell = shellEntries(src);

  it("parses the SHELL list at all (non-vacuity — an empty list must not read as clean)", () => {
    // Without this, renaming the constant makes every assertion below iterate nothing and pass, which is the
    // exact shape this repo has met in ten gates (§487…§607).
    expect(shell.length, "SHELL did not parse — the constant moved or was restructured, which is not the same as it being empty").toBeGreaterThanOrEqual(4);
  });

  it.each(["addAll", "waitUntil"])("the install path still uses %s (the assumption this gate rests on)", (token) => {
    // If the worker stops precaching atomically, this file guards a hazard that no longer exists and should
    // be deleted rather than left as a green check nobody can explain (§"record holds with expiry triggers").
    expect(
      src.includes(token),
      `the service worker no longer uses \`${token}\` on install. If precaching became per-entry or was ` +
        "removed, the atomicity argument this gate rests on is gone — delete it and say so in the audit",
    ).toBe(true);
  });

  it("every SHELL entry resolves to a file in this repo", () => {
    const orphans = shell.filter((u) => producerFor(root, u) === null);
    expect(
      orphans,
      "a precached path has no producer. `cache.addAll` is ATOMIC: this does not lose one asset, it fails the " +
        "install and leaves the driver with NO offline shell at all — reported as \"the app doesn't open " +
        "offline\" rather than as a missing file (REQ-061):\n  " +
        orphans.join("\n  "),
    ).toEqual([]);
  });
});
