import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CSS_VAR_LITERALS, FONTS, TOKENS } from "@shuddl/design";
import { EvidenceEmailView, formatCents, renderEvidenceEmail } from "../src/index.js";
import type { EvidenceEmailData } from "../src/index.js";
import { inlineTokens } from "../src/biller/evidence-email.js";

// ============================================================================================
// WP-06 — the EVIDENCE EMAIL as a shared, data-wired composition (REQ-087) with the referral
// surface (REQ-129). One shared VIEW, two rendered forms:
//   · VIEW (portal): var(--token) references — the app stylesheet dereferences them.
//   · SENDABLE (renderEvidenceEmail): mail clients strip var()/flex/grid, so tokens are
//     inlined to literals and the layout is block flow + presentation tables. Both forms are
//     design-law scanned below, each with non-vacuous assertions for ITS mode.
// Tokens/fonts come from @shuddl/design (never hand-duplicated — --signal-deep already moved
// once under Amendment A1; importing kills the drift). Money is INTEGER CENTS.
// ============================================================================================

const DATA: EvidenceEmailData = {
  shipment_ref: "SHP-40206",
  delivered_at: "2026-07-10 · 14:32 MT",
  signed_by: "J. NAVARRO · RECEIVING",
  location: "DENVER, CO 80216",
  invoice_ref: "INV-40206",
  total_cents: 148_000,
  photos: {},
  referral_url: "https://shuddl.example/ship-like-this?ref=SHP-40206",
};

const WITH_PHOTOS: EvidenceEmailData = {
  ...DATA,
  photos: {
    signature_url: "https://evidence.example/pod/sig-40206.jpg",
    placed_url: "https://evidence.example/pod/placed-40206.jpg",
  },
};

// ── design-law scanners (shared by both modes) ─────────────────────────────────────────────

const BLESSED_HEX = new Set<string>(Object.values(TOKENS).map((h) => h.toUpperCase()));
const normalizeCommas = (v: string): string => v.replace(/,\s+/g, ",");
const SANCTIONED_TRANSPARENTS = new Set<string>(
  Object.values(CSS_VAR_LITERALS)
    .filter((v) => v.startsWith("rgba"))
    .map((v) => normalizeCommas(v).toLowerCase()),
);

/** Every hex in the html, normalized to 6-digit uppercase (3/4/8-digit forms fold in; alpha drops). */
function extractHexes(html: string): string[] {
  const out: string[] = [];
  const dbl = (c: string): string => c + c;
  for (const m of html.matchAll(/#([0-9A-Fa-f]{3,8})\b/g)) {
    const s = (m[1] as string).toUpperCase();
    if (s.length === 3 || s.length === 4) out.push(`#${dbl(s[0] as string)}${dbl(s[1] as string)}${dbl(s[2] as string)}`);
    else if (s.length === 8) out.push(`#${s.slice(0, 6)}`);
    else out.push(`#${s}`); // 6 stays; 5/7 are invalid and will fail the blessed-set check loudly
  }
  return out;
}

/** All functional color() calls, whitespace-normalized for set membership. */
function extractFunctionalColors(html: string): string[] {
  return [...html.matchAll(/\b(?:rgb|hsl)a?\s*\([^)]*\)/gi)].map((m) => normalizeCommas(m[0]).toLowerCase());
}

/**
 * ALLOWLIST check on every color-bearing declaration value: each whitespace token must be a
 * blessed hex, a sanctioned transparent, a var(--…) reference (view mode only), or structural
 * (keyword/length). Allowlisting inverts the named-color problem — "blue"/"coral" is not a
 * lawful piece, so `color:blue` fails instead of slipping past a hex-only scan.
 * Returns the number of declarations checked (callers assert > 0: non-vacuous).
 */
function checkColorDecls(html: string, mode: "view" | "sendable"): number {
  const structural = new Set(["solid", "none", "transparent", "currentcolor", "inherit", "collapse"]);
  let checked = 0;
  for (const m of html.matchAll(/([a-z-]*color|background|border[a-z-]*|outline[a-z-]*|fill|stroke)\s*:\s*([^;"]+)/gi)) {
    checked += 1;
    for (const tok of normalizeCommas((m[2] as string).trim()).split(/\s+/)) {
      const lawful =
        structural.has(tok.toLowerCase()) ||
        /^\d+(?:\.\d+)?(?:px|%|em|rem)?$/.test(tok) ||
        BLESSED_HEX.has(tok.toUpperCase()) ||
        SANCTIONED_TRANSPARENTS.has(tok.toLowerCase()) ||
        (mode === "view" && /^var\(--[\w-]+\)$/.test(tok));
      expect(lawful, `[${mode}] unlawful color piece "${tok}" in "${m[1] as string}: ${m[2] as string}"`).toBe(true);
    }
  }
  return checked;
}

const normFont = (v: string): string =>
  v.replace(/["']/g, "").split(",").map((s) => s.trim().toLowerCase()).join(",");

function extractFontFamilies(html: string): string[] {
  return [...html.matchAll(/font-family\s*:\s*([^;"]+)/gi)].map((m) => (m[1] as string).trim());
}

// ── the sendable form ───────────────────────────────────────────────────────────────────────

describe("renderEvidenceEmail (REQ-087) — the sendable form", () => {
  it("subject names the shipment and says DELIVERED, mono-case", () => {
    const { subject } = renderEvidenceEmail(DATA);
    expect(subject).toBe("DELIVERED · SHP-40206 · PROOF + INVOICE");
    expect(subject).toContain(DATA.shipment_ref);
    expect(subject).toContain("DELIVERED");
  });

  it("rejects CR/LF in shipment_ref before subject interpolation (header-injection hygiene, M5)", () => {
    expect(() => renderEvidenceEmail({ ...DATA, shipment_ref: "SHP-1\r\nbcc: x@y" })).toThrow(/header/i);
    expect(() => renderEvidenceEmail({ ...DATA, shipment_ref: "SHP-1\nX" })).toThrow();
  });

  it("html carries the Delivered display, both captions, and the dispute footer — normal-case DOM, uppercased at paint (A5)", () => {
    const { html } = renderEvidenceEmail(DATA);
    expect(html).toContain(">Delivered<");
    expect(html).toContain(">Signature<");
    expect(html).toContain(">Freight as placed<");
    expect(html).toContain("This email is the record · Reply to dispute within 48h");
    // the uppercase is CSS, inlined so it survives mail clients — the DOM string stays readable
    expect(html).toMatch(/text-transform\s*:\s*uppercase/);
  });

  it("html carries every META value and the invoice line with the formatted integer-cents total", () => {
    const { html } = renderEvidenceEmail(DATA);
    expect(html).toContain(DATA.shipment_ref);
    expect(html).toContain(DATA.delivered_at);
    expect(html).toContain(DATA.signed_by);
    expect(html).toContain(DATA.location);
    expect(html).toContain("INV-40206 · $1,480.00");
  });

  it("renders a real full-bleed <img> per provided photo url — unrounded, unfiltered (A6)", () => {
    const { html } = renderEvidenceEmail(WITH_PHOTOS);
    expect(html).toContain('src="https://evidence.example/pod/sig-40206.jpg"');
    expect(html).toContain('src="https://evidence.example/pod/placed-40206.jpg"');
    expect(html).toMatch(/width\s*:\s*100%/);
    expect(html).not.toMatch(/filter\s*:/i);
  });

  it("pairs each caption to ITS photo — a caption swap must fail (M1)", () => {
    const { html } = renderEvidenceEmail(WITH_PHOTOS);
    // alt sits on the matching src
    expect(html).toContain('<img src="https://evidence.example/pod/sig-40206.jpg" alt="Signature"');
    expect(html).toContain('<img src="https://evidence.example/pod/placed-40206.jpg" alt="Freight as placed"');
    // and the visible caption is adjacent to its own img: sig img < sig caption < placed img < placed caption
    const sigImg = html.indexOf("sig-40206.jpg");
    const sigCap = html.indexOf(">Signature<");
    const placedImg = html.indexOf("placed-40206.jpg");
    const placedCap = html.indexOf(">Freight as placed<");
    expect(sigImg).toBeGreaterThan(-1);
    expect(sigImg).toBeLessThan(sigCap);
    expect(sigCap).toBeLessThan(placedImg);
    expect(placedImg).toBeLessThan(placedCap);
  });

  it("renders NO <img> when photo urls are absent — the documentary placeholder slot stands in", () => {
    const { html } = renderEvidenceEmail(DATA);
    expect(html).not.toContain("<img");
    expect(html).toContain(">Signature<");
    expect(html).toContain(">Freight as placed<");
  });

  it("carries the REQ-129 referral surface: a real anchor at the referral_url", () => {
    const { html } = renderEvidenceEmail(DATA);
    expect(html).toContain('href="https://shuddl.example/ship-like-this?ref=SHP-40206"');
    expect(html).toContain("Ship like this");
    expect(html).toMatch(/<a\s[^>]*href=/);
  });

  it("is deterministic: same data → byte-identical html", () => {
    const a = renderEvidenceEmail(WITH_PHOTOS);
    const b = renderEvidenceEmail(WITH_PHOTOS);
    expect(a.html).toBe(b.html);
    expect(a.subject).toBe(b.subject);
  });
});

describe("email-safety of the sendable form (C1 — mail clients strip var()/flex/grid)", () => {
  const sendable = renderEvidenceEmail(WITH_PHOTOS).html + renderEvidenceEmail(DATA).html;

  it("contains NO var(--…) — every token is inlined to its literal", () => {
    expect(sendable).not.toContain("var(");
  });

  it("inlines the transparent-red derivatives as their sanctioned literals", () => {
    expect(sendable).toContain(CSS_VAR_LITERALS["--signal-55"]);
    expect(sendable).toContain(CSS_VAR_LITERALS["--signal-12"]);
  });

  it("uses no flex, no grid, no aspect-ratio — block flow + presentation tables only", () => {
    expect(sendable).not.toMatch(/display\s*:\s*(?:flex|grid|inline-flex|inline-grid)/i);
    expect(sendable).not.toMatch(/aspect-ratio/i);
    expect(sendable).toContain('role="presentation"');
  });

  it("carries no <link> — React 19's hoisted preload hints are stripped (body-only fragment)", () => {
    expect(sendable).not.toContain("<link");
  });

  it("inlineTokens THROWS on an unrecognized token — never send a half-resolved email", () => {
    expect(() => inlineTokens("color:var(--nope)")).toThrow(/--nope/);
  });
});

// ── design law, per mode (doc 07; REQ-145/146/147) ─────────────────────────────────────────

describe("design law — SENDABLE mode (literals only)", () => {
  const html = renderEvidenceEmail(WITH_PHOTOS).html + renderEvidenceEmail(DATA).html;

  it("every hex is one of the five tokens — and hexes now EXIST to scan (non-vacuous)", () => {
    const hexes = extractHexes(html);
    expect(hexes.length).toBeGreaterThan(0);
    for (const hex of hexes) expect(BLESSED_HEX.has(hex), `raw color ${hex} outside the five tokens`).toBe(true);
  });

  it("every functional color is a sanctioned transparent-red/ink derivative", () => {
    const fns = extractFunctionalColors(html);
    expect(fns.length).toBeGreaterThan(0); // --signal-55 captions are present
    for (const fn of fns) expect(SANCTIONED_TRANSPARENTS.has(fn), `functional color ${fn} not sanctioned`).toBe(true);
  });

  it("every color-bearing declaration is lawful (allowlist — a CSS named color fails)", () => {
    expect(checkColorDecls(html, "sendable")).toBeGreaterThan(0);
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

  it("has no border-radius above 4px, unit-aware (M2)", () => {
    for (const m of html.matchAll(/border-radius\s*:\s*([^;"]+)/gi)) {
      for (const n of (m[1] as string).matchAll(/(\d+(?:\.\d+)?)([a-z%]*)/gi)) {
        const unit = ((n[2] as string) ?? "").toLowerCase();
        expect(unit === "" || unit === "px", `border-radius unit "${unit}" — px only`).toBe(true);
        expect(Number(n[1])).toBeLessThanOrEqual(4);
      }
    }
  });
});

describe("design law — VIEW mode (the portal render keeps var(--…) references)", () => {
  const viewHtml =
    renderToStaticMarkup(<EvidenceEmailView data={WITH_PHOTOS} />) + renderToStaticMarkup(<EvidenceEmailView data={DATA} />);

  it("reaches the palette ONLY through var(--…) — zero raw hexes (non-vacuous: vars exist)", () => {
    expect(viewHtml).toContain("var(--");
    expect(extractHexes(viewHtml)).toEqual([]);
  });

  it("every color-bearing declaration is lawful (var(--…) sanctioned in this mode)", () => {
    expect(checkColorDecls(viewHtml, "view")).toBeGreaterThan(0);
  });

  it("fonts are the two token references", () => {
    const fonts = extractFontFamilies(viewHtml);
    expect(fonts.length).toBeGreaterThan(0);
    for (const f of fonts) expect(f).toMatch(/^var\(--(?:display|mono)\)$/);
  });
});

// ── money law ───────────────────────────────────────────────────────────────────────────────

describe("formatCents — integer/string arithmetic only", () => {
  it("formats the canonical cases", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(1)).toBe("$0.01");
    expect(formatCents(148_000)).toBe("$1,480.00");
    expect(formatCents(22_208_400)).toBe("$222,084.00"); // the REQ-040 anomaly number, as a formatting case
    expect(formatCents(123_456_789)).toBe("$1,234,567.89");
  });

  it("throws on a non-integer", () => {
    expect(() => formatCents(148000.5)).toThrow();
    expect(() => formatCents(Number.NaN)).toThrow();
  });

  it("throws on a negative (an invoice total is ≥ 0)", () => {
    expect(() => formatCents(-1)).toThrow();
  });
});
