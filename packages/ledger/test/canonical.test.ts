import { describe, expect, it } from "vitest";
import { canonicalize, canonicalBytes, sha256Hex } from "../src/canonical.js";

describe("canonical JSON — the byte law", () => {
  it("sorts keys by UTF-16 code units, no whitespace", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it("emits unicode literally; composed vs decomposed hash differently (no NFC)", async () => {
    const a = await sha256Hex(canonicalBytes({ s: "\u00e9" })); // U+00E9 precomposed \u00e9
    const b = await sha256Hex(canonicalBytes({ s: "e\u0301" })); // e + U+0301 combining acute
    expect(a).not.toBe(b);
  });
  it("escapes only quote, backslash, control chars (lowercase \\u00xx)", () => {
    expect(canonicalize({ s: "\u0001\"\\" })).toBe('{"s":"\\u0001\\"\\\\"}');
  });
  it("rejects floats, -0, and unsafe integers", () => {
    for (const bad of [1.5, -0, 2 ** 53]) expect(() => canonicalize({ n: bad })).toThrow();
  });
  it("rejects lone surrogates (TextEncoder would fold them to U+FFFD — non-injective)", () => {
    expect(() => canonicalize({ s: "\ud800" })).toThrow(/surrogate/);
  });
  it("omits undefined members; null survives", () => {
    expect(canonicalize({ a: undefined as unknown as null, b: null })).toBe('{"b":null}');
  });
  it("array order preserved; nested objects sorted", () => {
    expect(canonicalize({ a: [{ z: 1, y: 2 }, 3] })).toBe('{"a":[{"y":2,"z":1},3]}');
  });
  it("known-answer: sha256 of canonical {} is stable", async () => {
    expect(await sha256Hex(canonicalBytes({}))).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  });
});
