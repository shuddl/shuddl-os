// Canonical JSON — the byte law of the ledger (REQ-011, REQ-002). JCS (RFC 8785)
// restricted to integer-only numbers. These rules are frozen forever; changing any
// of them breaks every hash chain. Do not "improve" this file.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

function esc(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c >= 0xd800 && c <= 0xdfff) throw new Error("canonical law: lone surrogate rejected (non-injective under UTF-8)");
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (c < 0x20) {
      out += ch === "\b" ? "\\b" : ch === "\t" ? "\\t" : ch === "\n" ? "\\n" : ch === "\f" ? "\\f" : ch === "\r" ? "\\r"
        : "\\u" + c.toString(16).padStart(4, "0");
    } else out += ch;
  }
  return out + '"';
}

export function canonicalize(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || Object.is(v, -0)) throw new Error(`canonical law: integers only, got ${v}`);
    return String(v);
  }
  if (typeof v === "string") return esc(v);
  if (Array.isArray(v)) {
    // Index-iterate (never `.map`, which skips holes): a sparse array [1,,2] must throw,
    // not silently emit invalid JSON "[1,,2]". Explicit [undefined] still throws below
    // (undefined is an unsupported type). Dense arrays are byte-identical to before.
    let out = "[";
    for (let i = 0; i < v.length; i++) {
      if (!(i in v)) throw new Error("canonical law: sparse array hole rejected (non-injective under JSON)");
      out += (i === 0 ? "" : ",") + canonicalize(v[i]);
    }
    return out + "]";
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + entries.map(([k, val]) => esc(k) + ":" + canonicalize(val)).join(",") + "}";
  }
  throw new Error(`canonical law: unsupported type ${typeof v}`);
}

export function canonicalBytes(v: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(v));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
