// Real-pixel render of the SENDABLE evidence email (REQ-087/129 — render honesty, WP-06 Task 7).
//
// This screenshots exactly what a consignee's mail client is handed: renderEvidenceEmail(...).html —
// the email-safe fragment with every design token INLINED to its literal — wrapped by the sender's own
// wrapFragment (doctype + charset; packages/agents/src/biller/sender.ts owes that wrap in production).
// No app stylesheet, no var(--token) dereferencing, no dev server: if the inlining or the table-based
// email-safe layout is wrong, THIS PNG is wrong. Same headless-Chrome mechanism as the other tools/live
// renders (puppeteer-core against system Chrome; static html, so no WebGL flags needed).
//
// Data: the REQ-167-clean fictional fixture the portal preview pins (apps/portal/src/evidence-email.tsx)
// — SHP-40206 / INV-40206 / $1,480.00 — with NO photo urls, so the documentary placeholder slots render
// (the stable canonical form; no network fetch can flake the pixels).
//
// Run:  pnpm exec tsx --tsconfig tools/live/tsconfig.render.json tools/live/render-email.ts
//       (the --tsconfig is load-bearing: it applies the automatic JSX runtime to the @shuddl/agents
//       + @shuddl/design .tsx sources — without it the render crashes with "React is not defined")
// Out:  tools/live/out/evidence-email.png (committed evidence — look at it, per the render-honesty rule)

import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import { renderEvidenceEmail } from "../../packages/agents/src/biller/evidence-email.js";
import { wrapFragment } from "../../packages/agents/src/biller/sender.js";
import type { EvidenceEmailData } from "../../packages/agents/src/biller/evidence-email-view.js";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// The portal fixture, verbatim (REQ-167-clean fictional values; the Biller composes this same shape).
const FIXTURE: EvidenceEmailData = {
  shipment_ref: "SHP-40206",
  delivered_at: "2026-07-10 · 14:32 MT",
  signed_by: "J. NAVARRO · RECEIVING",
  location: "DENVER, CO 80216",
  invoice_ref: "INV-40206",
  total_cents: 148_000,
  photos: {}, // absent ⇒ the documentary placeholder slots — the stable canonical form
  referral_url: "https://shuddl.tech?ref=SHP-40206",
};

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "out", "evidence-email.png");

const { subject, html } = renderEvidenceEmail(FIXTURE);
const doc = wrapFragment(html); // the sender's production wrap — doctype + <meta charset="utf-8">

// The composed document is an intermediate (the PNG is the committed evidence) — park it in tmp.
const htmlPath = join(tmpdir(), "shuddl-evidence-email.html");
writeFileSync(htmlPath, doc);
mkdirSync(join(here, "out"), { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--window-size=760,480"],
});
const page = await browser.newPage();
// 760 wide (the 640px email column + its 32px gutters breathes at typical webmail width);
// deviceScaleFactor 2 so the 10/11px mono metadata is legible in the committed evidence. The
// viewport height sits BELOW the document height on purpose: fullPage then sizes the capture to
// the email itself, not to a taller-than-content viewport (no dead band under the fragment).
await page.setViewport({ width: 760, height: 480, deviceScaleFactor: 2 });
const errs: string[] = [];
page.on("console", (m) => {
  if (m.type() === "error") errs.push(m.text());
});
page.on("pageerror", (e) => errs.push(`PAGEERROR: ${e.message}`));
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle0", timeout: 30_000 });
await page.screenshot({ path: outPath as `${string}.png`, fullPage: true });
await browser.close();

console.log("subject:", subject);
console.log("rendered:", outPath, "| console errors:", errs.length);
for (const e of errs.slice(0, 6)) console.log("  ERR:", e.slice(0, 140));
