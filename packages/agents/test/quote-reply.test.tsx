import { describe, expect, it } from "vitest";
import { CSS_VAR_LITERALS, FONTS, TOKENS } from "@shuddl/design";
import { renderQuoteReply } from "../src/index.js";
import type { QuoteReplyData } from "../src/index.js";

// ============================================================================================
// WP-07 Task 5 — the CONCIERGE QUOTE REPLY (REQ-098): the tenant-voice, design-law-clean quote
// email the auto-reply sends. It mirrors the Biller's evidence email exactly: one deterministic
// render, tokens inlined to literals for mail clients, block flow + presentation tables (no
// flex/grid), the price shown via integer-cents formatCents. The "tenant voice" is a config-
// seeded from-name + a bounded signature line — NEVER free model output (the SENT content is
// deterministic and validated; the model never authors the body).
// ============================================================================================

const DATA: QuoteReplyData = {
  shipment_ref: "SHP-51120",
  lane: { origin_zip: "97201", dest_zip: "98101" },
  sell_cents: 148_000,
  tenant_from_name: "Example Freight Desk", // a config-seeded tenant voice — a placeholder, no identity (REQ-167)
};

const WITH_VALIDITY: QuoteReplyData = { ...DATA, valid_until: "2026-07-21 · 17:00 MT" };

// ── design-law scanners (mirror the evidence-email test: allowlist, not a hex-only sweep) ────

const BLESSED_HEX = new Set<string>(Object.values(TOKENS).map((h) => h.toUpperCase()));
const normalizeCommas = (v: string): string => v.replace(/,\s+/g, ",");
const SANCTIONED_TRANSPARENTS = new Set<string>(
  Object.values(CSS_VAR_LITERALS)
    .filter((v) => v.startsWith("rgba"))
    .map((v) => normalizeCommas(v).toLowerCase()),
);

function extractHexes(html: string): string[] {
  const out: string[] = [];
  const dbl = (c: string): string => c + c;
  for (const m of html.matchAll(/#([0-9A-Fa-f]{3,8})\b/g)) {
    const s = (m[1] as string).toUpperCase();
    if (s.length === 3 || s.length === 4) out.push(`#${dbl(s[0] as string)}${dbl(s[1] as string)}${dbl(s[2] as string)}`);
    else if (s.length === 8) out.push(`#${s.slice(0, 6)}`);
    else out.push(`#${s}`);
  }
  return out;
}

function extractFunctionalColors(html: string): string[] {
  return [...html.matchAll(/\b(?:rgb|hsl)a?\s*\([^)]*\)/gi)].map((m) => normalizeCommas(m[0]).toLowerCase());
}

function checkColorDecls(html: string): number {
  const structural = new Set(["solid", "none", "transparent", "currentcolor", "inherit", "collapse"]);
  let checked = 0;
  for (const m of html.matchAll(/([a-z-]*color|background|border[a-z-]*|outline[a-z-]*|fill|stroke)\s*:\s*([^;"]+)/gi)) {
    checked += 1;
    for (const tok of normalizeCommas((m[2] as string).trim()).split(/\s+/)) {
      const lawful =
        structural.has(tok.toLowerCase()) ||
        /^\d+(?:\.\d+)?(?:px|%|em|rem)?$/.test(tok) ||
        BLESSED_HEX.has(tok.toUpperCase()) ||
        SANCTIONED_TRANSPARENTS.has(tok.toLowerCase());
      expect(lawful, `unlawful color piece "${tok}" in "${m[1] as string}: ${m[2] as string}"`).toBe(true);
    }
  }
  return checked;
}

const normFont = (v: string): string =>
  v.replace(/["']/g, "").split(",").map((s) => s.trim().toLowerCase()).join(",");

function extractFontFamilies(html: string): string[] {
  return [...html.matchAll(/font-family\s*:\s*([^;"]+)/gi)].map((m) => (m[1] as string).trim());
}

// ── subject + content ─────────────────────────────────────────────────────────────────────

describe("renderQuoteReply (REQ-098) — subject + content", () => {
  it("subject names the shipment and the rate, integer-cents", () => {
    const { subject } = renderQuoteReply(DATA);
    expect(subject).toBe("YOUR RATE · SHP-51120 · $1,480.00");
    expect(subject).toContain(DATA.shipment_ref);
    expect(subject).toContain("$1,480.00"); // 148000¢ → $1,480.00 (integer/string math)
  });

  it("rejects CR/LF in shipment_ref before subject interpolation (header-injection hygiene)", () => {
    expect(() => renderQuoteReply({ ...DATA, shipment_ref: "SHP-1\r\nbcc: x@y" })).toThrow(/header/i);
    expect(() => renderQuoteReply({ ...DATA, shipment_ref: "SHP-1\nX" })).toThrow();
  });

  it("html carries the lane (both zips), the formatted price, the tenant from-name, and a footer", () => {
    const { html } = renderQuoteReply(DATA);
    expect(html).toContain("97201"); // origin
    expect(html).toContain("98101"); // dest
    expect(html).toContain("$1,480.00"); // the Rater's sell, integer-cents
    expect(html).toContain("Example Freight Desk"); // the tenant voice (normal-case DOM, uppercased at paint)
    expect(html).toMatch(/reply/i); // a dispute/validity footer that invites a reply
    expect(html).toContain(">Your rate<"); // the Display headline
  });

  it("shows a validity row ONLY when valid_until is supplied", () => {
    expect(renderQuoteReply(DATA).html).not.toContain("Valid until");
    const { html } = renderQuoteReply(WITH_VALIDITY);
    expect(html).toContain("Valid until");
    expect(html).toContain("2026-07-21 · 17:00 MT");
  });

  it("is deterministic: same data → byte-identical subject + html", () => {
    const a = renderQuoteReply(WITH_VALIDITY);
    const b = renderQuoteReply(WITH_VALIDITY);
    expect(a.html).toBe(b.html);
    expect(a.subject).toBe(b.subject);
  });
});

// ── email-safety + design law (sendable literals only) ──────────────────────────────────────

describe("renderQuoteReply — email-safety (mail clients strip var()/flex/grid)", () => {
  const html = renderQuoteReply(WITH_VALIDITY).html + renderQuoteReply(DATA).html;

  it("contains NO var(--…) — every token is inlined to its literal", () => {
    expect(html).not.toContain("var(");
  });

  it("uses no flex, no grid, no aspect-ratio — block flow + presentation tables only", () => {
    expect(html).not.toMatch(/display\s*:\s*(?:flex|grid|inline-flex|inline-grid)/i);
    expect(html).not.toMatch(/aspect-ratio/i);
    expect(html).toContain('role="presentation"');
  });

  it("carries no <link> — no hoisted preload hints leak into the fragment", () => {
    expect(html).not.toContain("<link");
  });
});

describe("renderQuoteReply — design law (doc 07; REQ-145/146/147)", () => {
  const html = renderQuoteReply(WITH_VALIDITY).html + renderQuoteReply(DATA).html;

  it("every hex is one of the five tokens — and hexes EXIST to scan (non-vacuous)", () => {
    const hexes = extractHexes(html);
    expect(hexes.length).toBeGreaterThan(0);
    for (const hex of hexes) expect(BLESSED_HEX.has(hex), `raw color ${hex} outside the five tokens`).toBe(true);
  });

  it("every functional color is a sanctioned transparent-red/ink derivative", () => {
    for (const fn of extractFunctionalColors(html)) {
      expect(SANCTIONED_TRANSPARENTS.has(fn), `functional color ${fn} not sanctioned`).toBe(true);
    }
  });

  it("every color-bearing declaration is lawful (allowlist — a CSS named color fails)", () => {
    expect(checkColorDecls(html)).toBeGreaterThan(0);
  });

  it("names only the two blessed LITERAL font stacks", () => {
    const fonts = extractFontFamilies(html);
    expect(fonts.length).toBeGreaterThan(0);
    const blessed = new Set([normFont(FONTS.display), normFont(FONTS.mono)]);
    for (const f of fonts) expect(blessed.has(normFont(f)), `font-family ${f} outside the two stacks`).toBe(true);
  });

  it("has zero shadows and zero gradients", () => {
    expect(html).not.toMatch(/box-shadow/i);
    expect(html).not.toMatch(/text-shadow/i);
    expect(html).not.toMatch(/gradient\(/i);
  });

  it("has no border-radius above 4px, unit-aware", () => {
    for (const m of html.matchAll(/border-radius\s*:\s*([^;"]+)/gi)) {
      for (const n of (m[1] as string).matchAll(/(\d+(?:\.\d+)?)([a-z%]*)/gi)) {
        const unit = ((n[2] as string) ?? "").toLowerCase();
        expect(unit === "" || unit === "px", `border-radius unit "${unit}" — px only`).toBe(true);
        expect(Number(n[1])).toBeLessThanOrEqual(4);
      }
    }
  });
});
