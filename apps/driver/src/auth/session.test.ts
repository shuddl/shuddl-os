import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createAuthSession } from "./session.js";

// REQ-030/069 §564 — THE DRIVER SESSION STORE'S DEGRADED BEHAVIOUR, AND THE HOLD THAT KEEPS IT SAFE.
//
// Every accessor here is try/caught so the app runs where storage is blocked (private mode). Two of the three
// catches are EMPTY, and audit §182 already recorded that one of them — `clear()` — is fail-OPEN: a storage
// that reads but refuses to write leaves the token behind while the caller believes the session was dropped.
//
// §182's hold states the reason it is harmless: **both call sites are 401 handlers**, so a surviving copy is
// stale rather than usable. That premise was re-verified at §564 and still holds exactly — `App.tsx:95` and
// `sync/useSync.ts:75`, nothing else.
//
// But nothing ENFORCED it. A hold whose safety depends on "there are exactly two call sites, both on a 401
// path" is a lockstep claim between a comment and the code, and the fix must read one side and COMPUTE the
// other rather than restate it. That is what the last test does: a third call site — the voluntary logout
// REQ-069 will bring — fails here and puts the fail-open in front of the person introducing it, which is the
// moment the hold says it stops being safe.

/** A store whose writes fail but whose reads work — the exact degraded mode the catches exist for. */
function readOnlyStore(seed: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  return {
    getItem: (k: string) => seed[k] ?? null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
}

describe("REQ-030 §564: the driver session store degrades without throwing", () => {
  it("getToken returns null when the store throws — never a partial or stale value", () => {
    const session = createAuthSession({
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    expect(session.getToken()).toBeNull();
  });

  it("getToken returns null when there is no store at all (storage blocked entirely)", () => {
    expect(createAuthSession(null).getToken()).toBeNull();
  });

  it("setToken swallows a failed write — persistence is lost, nothing stale is kept", () => {
    const session = createAuthSession(readOnlyStore());
    expect(() => session.setToken("t-1")).not.toThrow();
    // The failure mode is benign in the direction that matters: nothing was written, so nothing can be read.
    expect(session.getToken()).toBeNull();
  });

  it("clear() swallows a failed removal — and the token SURVIVES (the documented fail-open)", () => {
    const key = "shuddl.driver.session.token";
    const session = createAuthSession(readOnlyStore({ [key]: "t-live" }));
    expect(() => session.clear()).not.toThrow();
    // Pinned as the CURRENT behaviour, not as desirable: §182 accepted it because every caller is a 401
    // handler. If this ever starts returning null, the fail-open was fixed and §182's hold can be retired.
    expect(session.getToken(), "clear() cannot verify removal — see §182's expiry trigger").toBe("t-live");
  });
});

describe("REQ-030 §564: §182's hold — every clear() call site is a 401 path", () => {
  const root = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

  /** Every `session.clear()` in the shipped driver source, with the context that should justify it. */
  function clearCallSites(): { file: string; line: number; context: string }[] {
    const files = execSync('git ls-files "apps/driver/src/*.ts" "apps/driver/src/*.tsx"', { cwd: root, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter((f) => f && !f.includes(".test."));
    const out: { file: string; line: number; context: string }[] = [];
    for (const f of files) {
      const lines = readFileSync(`${root}/${f}`, "utf8").split("\n");
      lines.forEach((text, i) => {
        if (!/\bsession\.clear\s*\(\s*\)/.test(text)) return;
        // The justification may sit on the call line or in the few lines guarding it.
        // Comments are STRIPPED before the context is judged. Found the hard way (§564): the first mutation
        // that tried to prove this guard annotated itself "a call site nowhere near a 401" — and the word
        // "401" in that comment satisfied the check. A guard on a CODE property must not be satisfiable by
        // prose, or the next person writes `// not a 401 path` and merges.
        const window = lines
          .slice(Math.max(0, i - 4), i + 2)
          .map((l) => l.replace(/\/\/.*$/, ""))
          .join("\n");
        out.push({ file: f, line: i + 1, context: window });
      });
    }
    return out;
  }

  it("finds the call sites at all (non-vacuity)", () => {
    // Without this, a rename makes the assertion below iterate nothing and pass — §554's class, which this
    // repo has now met in four gates.
    expect(clearCallSites().length, "no session.clear() call sites found — the scan is broken, not the app").toBeGreaterThan(1);
  });

  it("every call site is guarded by a server-rejection discriminant, in CODE not prose", () => {
    // The CODE vocabulary for "the server rejected this session", not the prose one. The literal `401` never
    // appears in these paths — the transport maps it to a typed discriminant (`kind: "unauthenticated"`) and
    // the sync pass exposes `authBlocked`. Matching on "401" only ever matched the explanatory comments, which
    // is precisely what stripping them exposed (§564).
    const REJECTED_BY_SERVER = /\bunauthenticated\b|\bauthBlocked\b/;
    const stray = clearCallSites().filter((s) => !REJECTED_BY_SERVER.test(s.context));
    expect(
      stray,
      "session.clear() outside a 401 path. §182 accepted clear()'s EMPTY catch (a failed removal leaves the " +
        "token behind) ONLY because every caller had already been rejected by the server, making the survivor " +
        "stale rather than usable. A voluntary logout breaks that: fix the catch to verify the removal — read " +
        "back, overwrite, surface a failure — before adding this call site:\n  " +
        stray.map((s) => `${s.file}:${s.line}`).join("\n  "),
    ).toEqual([]);
  });
});
