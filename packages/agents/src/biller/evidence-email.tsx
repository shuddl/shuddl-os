import { renderToStaticMarkup } from "react-dom/server";
import { CSS_VAR_LITERALS } from "@shuddl/design";
import { EvidenceEmailView } from "./evidence-email-view.js";
import type { EvidenceEmailData } from "./evidence-email-view.js";

// THE SENDABLE EVIDENCE EMAIL (REQ-087) — what this module actually produces, stated honestly:
// an EMAIL-SAFE HTML FRAGMENT. No doctype, no <html>/<head>/<body> — the sender (Biller) must
// wrap it with a doctype and `<meta charset="utf-8">` (the copy uses `·` U+00B7, so the charset
// declaration is load-bearing). Mail clients strip CSS custom properties (Gmail) and Outlook's
// Word engine drops flex/grid/aspect-ratio entirely, so:
//   · every var(--token) the shared view emits is inlined here to its literal from
//     @shuddl/design CSS_VAR_LITERALS (5 hexes + the rgba transparents + the 2 font stacks);
//   · the view itself lays out with block flow + presentation tables (see evidence-email-view).
// An unrecognized var(--…) THROWS — a half-resolved email must never leave the building.
// Pure & deterministic: no Date, no random; same data → identical bytes.

const LITERALS: Readonly<Record<string, string>> = CSS_VAR_LITERALS;

/**
 * Substitute every `var(--token)` with its literal from the design token source — but ONLY inside
 * `style="…"` attribute values, never across the whole document. The shared view emits every design
 * token inside inline styles, and mail clients strip CSS custom properties, so those are what we inline.
 * Running the substitution over the ENTIRE html would let body/subject DATA text (e.g. a shipment_ref of
 * "var(--field)") get recolored — or throw the fail-loud "unknown token" path on attacker-controlled text
 * (an email DoS). React HTML-escapes attribute values, so DATA can never appear inside a style value;
 * scoping here keeps DATA inert while preserving the fail-loud contract for REAL style tokens.
 * Exported for tests: the fail-loud path (unknown STYLE token → throw) is part of the contract.
 */
export function inlineTokens(html: string): string {
  return html.replace(/style="([^"]*)"/g, (_whole, styleValue: string) => {
    const inlined = styleValue.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_m, name: string) => {
      const literal = LITERALS[name];
      if (literal === undefined) {
        throw new Error(`evidence-email: unknown design token ${name} — refusing to emit a half-resolved email`);
      }
      return literal;
    });
    // A var() surviving inside a style value is a REAL unresolved style token (not data) — fail loud.
    const leftover = inlined.indexOf("var(");
    if (leftover !== -1) {
      throw new Error(`evidence-email: unresolved var() remains in a style value at index ${leftover} — refusing to emit a half-resolved email`);
    }
    return `style="${inlined}"`;
  });
}

// React 19 hoists `<link rel="preload" as="image">` hints to the FRONT of static markup. An
// email fragment has no <head>, mail clients drop <link> anyway, and the hoisted hints would
// put each photo url ahead of its own <img> — strip them from the sendable form.
function stripPreloadHints(html: string): string {
  return html.replace(/<link rel="preload"[^>]*\/>/g, "");
}

/**
 * The Biller's send-ready projection: deterministic subject + the email-safe html FRAGMENT
 * (tokens inlined to literals; see module header for the wrapping the sender still owes).
 * shipment_ref is rejected if it carries CR/LF — it is interpolated into a mail header.
 */
export function renderEvidenceEmail(data: EvidenceEmailData): { subject: string; html: string } {
  if (/[\r\n]/.test(data.shipment_ref)) {
    throw new Error("evidence-email: shipment_ref carries CR/LF — refusing to interpolate into a mail header");
  }
  return {
    subject: `DELIVERED · ${data.shipment_ref} · PROOF + INVOICE`,
    html: inlineTokens(stripPreloadHints(renderToStaticMarkup(<EvidenceEmailView data={data} />))),
  };
}
