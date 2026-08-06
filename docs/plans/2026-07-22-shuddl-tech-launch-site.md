# SHUDDL.TECH Launch Site Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build and launch the SHUDDL marketing + waitlist site on shuddl.tech as a single Cloudflare Worker (static assets + D1-backed waitlist API), obeying the Terminal Gallery design law with maximal sanctioned motion.

**Architecture:** One hand-crafted static page (no framework — full control over motion and payload, sub-100KB before fonts) served by a Worker `assets` binding; the same Worker exposes `POST /api/waitlist` writing to a dedicated D1 database. Custom domain `shuddl.tech` attached via wrangler routes. The animated hero is a hand-authored `<canvas>` "living map": greige field, red road circuitry, freight chevrons with fading trails, a periodic exception pulse that dims the world — the product's signature visual, recreated as marketing.

**Tech Stack:** Cloudflare Workers (wrangler 4), D1, vanilla HTML/CSS/JS, canvas 2D, Barlow Condensed + JetBrains Mono (self-hosted woff2), node:test for pure logic.

**Constraints (from `.agents/product-marketing-context.md` — binding):**
- Five color tokens only; two fonts; uppercase; no shadows/gradients/radius>4px; no blue/gray/green; no stock imagery/illustration/emoji.
- Motion is heavy but lawful: fade-up reveals, staggered, count-ups, trails, pulses, teal fills, crossfades. `prefers-reduced-motion` honored. Banned: springs, parallax, rotation, particles, shimmer, hover-lift.
- REQ-167: no tenant/person/customer/incumbent-vendor names anywhere.
- No pricing numbers on the site (hypotheses only). No CONFIRM-gated features presented as live.
- Waitlist is the conversion action: email + segment (CARRIER/BROKER/SHIPPER/DRIVER/DEVELOPER) + optional fleet size; design-partner application as secondary CTA (mailto or same form flagged).

**Isolation note:** everything lives in `marketing-site/` (new dir). `shuddl-site/` (vinext experiment) is left untouched. No WP-16 files are touched; no git operations on wp-15/wp-16 branches are required to deploy.

---

### Task 1: Scaffold
- Create `marketing-site/{wrangler.jsonc, worker/index.ts, public/, schema.sql, package.json, tests/}`
- `wrangler.jsonc`: name `shuddl-tech`, assets binding to `public/` with `run_worker_first: ["/api/*"]`, D1 binding `WAITLIST`, routes `[{pattern: "shuddl.tech", custom_domain: true}]`, compat date current.
- Commit-free (untracked dir; user decides on committing later).

### Task 2: Waitlist API (test-first for pure logic)
- `worker/validate.ts`: `parseSignup(body)` → `{email, segment, fleet?}` or error. Email regex + length caps; segment enum; honeypot field `company_url` must be empty.
- `tests/validate.test.mjs` (node:test): valid, bad email, bad segment, honeypot filled, oversized input. Run: `node --test`.
- `worker/index.ts`: `POST /api/waitlist` → parse → `INSERT INTO waitlist ... ON CONFLICT(email) DO UPDATE SET segment=excluded.segment` → 200 `{ok:true}`; JSON errors 400; everything else falls through to assets. Never 500 on dupes.
- `schema.sql`: `waitlist(id INTEGER PK, email TEXT UNIQUE NOT NULL, segment TEXT, fleet TEXT, source TEXT, ua TEXT, created_at TEXT DEFAULT now)`.

### Task 3: The page — structure + copy
- `public/index.html`, sections per context doc §14: (01) HERO map+capture · (02) THE PROBLEM · (03) THE MOMENT (delivered-email artifact) · (04) WHAT RUNS ITSELF (13 agents) · (05) KEEP YOUR TMS (overlay) · (06) BOOK FREIGHT FROM CLAUDE (typed transcript) · (07) THE LAWS · (08) WAITLIST + ink footer.
- All copy from the context doc; claims only from §12 "safe" list.

### Task 4: Terminal Gallery CSS
- `public/styles.css`: tokens verbatim; display/mono type law; 1px `--signal-12` grid; dark panels; buttons/inputs per grammar; reveal/count-up keyframe hooks; `prefers-reduced-motion` kills all.
- Self-host fonts in `public/fonts/` (Barlow Condensed 700, JetBrains Mono 400, latin subsets).

### Task 5: Motion layer
- `public/main.js`: IntersectionObserver reveals (stagger), count-up numbers (1.2–1.8s eased), Claude transcript typewriter, scroll progress as a teal top hairline, section-number crossfades.
- `public/map.js`: canvas hero — field wash, hand-authored US-ish network of bezier routes at 5–8% red, 8–12 chevrons gliding with 600ms trails, dwell squares with mono labels, delivered marks flipping hollow, every ~14s one exception pulses (1.6s opacity sine) while the world dims to 35%, teal fill advancing along one route. DPR-aware, ~60fps, paused off-screen, static frame under reduced-motion.

### Task 6: Marketing-skill passes
- Run `marketing-skills:page-cro`, `marketing-skills:signup-flow-cro`, `marketing-skills:launch-strategy`; fold applicable findings into copy, hierarchy, form, and launch checklist. (User-requested order: after the plan.)

### Task 7: Ultracode review swarm (Workflow tool)
- Parallel reviewers: design-law compliance (tokens/case/radius/shadow/motion bans) · copy vs guardrails (REQ-167 leak grep + hypothesis-pricing + gated-features) · accessibility (contrast pair usage, focus, aria, reduced-motion) · code correctness (API, honeypot, D1 conflict path) · performance (payload, canvas loop). Adversarial verify each finding; fix confirmed ones; re-run `node --test`.

### Task 8: Provision + deploy + verify live
- `wrangler d1 create shuddl-waitlist` → id into wrangler.jsonc → `wrangler d1 execute --remote --file schema.sql`.
- `wrangler deploy` (attaches shuddl.tech custom domain; fallback to workers.dev + report if zone isn't in this account).
- Verify: `curl -sI https://shuddl.tech` → 200; `curl -X POST /api/waitlist` happy+dupe+bad → 200/200/400; D1 row count; browser screenshot.

### Task 9: Report
- Final summary: live URL, what shipped, waitlist storage location, follow-ups (Resend confirmation email after domain warmup REQ-157; www redirect; analytics).
