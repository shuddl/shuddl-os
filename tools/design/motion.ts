// Motion-law detectors (doc 07 §06 audit #5, REQ-148). Pure string analysis, no DOM.
// Sanctioned motion is narrow: reveals (fade-up), eased count-ups, opacity fades, map-mark
// glide, the two map pulses, the ⌘K typewriter. Everything else is decoration and banned:
// springs, parallax, decorative rotation, hover-scale, decorative growth, particles,
// shimmer/skeleton loaders, and bob/float loops (an infinite @keyframes tweening transform).

/** Escape a keyframes name for embedding in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** cubic-bezier() with a control-point y outside [0,1] overshoots → a spring. */
export function isSpringBezier(text: string): boolean {
  for (const m of text.matchAll(
    /cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/gi,
  )) {
    const y1 = Number(m[2]);
    const y2 = Number(m[4]);
    if (y1 > 1 || y1 < 0 || y2 > 1 || y2 < 0) return true;
  }
  return false;
}

/** rotate(<non-0>) — decorative spin. Chevron heading-orient is a map `icon-rotate`
 * expression, not a CSS `rotate()`, so it is out of this detector's reach. */
export function hasNonZeroRotate(text: string): boolean {
  for (const m of text.matchAll(/\brotate[xyz3d]*\(\s*(-?[\d.]+)\s*(?:deg|rad|turn|grad)?\s*\)/gi)) {
    if (Number(m[1]) !== 0) return true;
  }
  return false;
}

/** M4 — a static `transform: scale(n)` with n>1 that is NOT inside a `:hover` rule. That is a
 * decorative pop/growth; the map-mark glide and the two pulses are JS rAF loops on the canvas,
 * not CSS transforms, so they are out of reach. Hover scaling is caught by `hover-scale`. */
export function hasDecorativeScale(text: string): boolean {
  const withoutHover = text.replace(/:hover\b[^{}]*\{[^}]*\}/gis, "");
  for (const m of withoutHover.matchAll(/transform\s*:\s*[^;{}]*?\bscale[xyz]?\(\s*(-?[\d.]+)/gi)) {
    if (Number(m[1]) > 1) return true;
  }
  return false;
}

/** Brace-balanced `@keyframes NAME { … }` blocks as `{ name, body }`. A hand-rolled counter is
 * used because a nested-brace keyframes body (`0% { … } 100% { … }`) can't be matched by regex. */
function keyframesBlocks(text: string): Array<{ name: string; body: string }> {
  const blocks: Array<{ name: string; body: string }> = [];
  const re = /@keyframes\s+([\w-]+)\s*\{/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (name === undefined) continue;
    let depth = 1;
    let i = re.lastIndex;
    const start = i;
    for (; i < text.length && depth > 0; i++) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    blocks.push({ name, body: text.slice(start, Math.max(start, i - 1)) });
    re.lastIndex = i;
  }
  return blocks;
}

/** M4 — an INFINITE loop that tweens transform/translate/scale/rotate: a bob/float decoration.
 * The one sanctioned entrance (`shuddl-reveal`) runs ONCE (its `animation` has no `infinite`),
 * so it is never flagged; a `@keyframes bob {…} … animation: bob 2s infinite` is. */
export function infiniteTransformKeyframes(text: string): string[] {
  const reasons: string[] = [];
  for (const { name, body } of keyframesBlocks(text)) {
    if (!/\b(?:transform|translate[xyz3d]*|scale[xyz]*|rotate[xyz3d]*)\b/i.test(body)) continue;
    const n = escapeRegExp(name);
    const drivenInfinite =
      new RegExp(`animation(?:-name)?\\s*:\\s*["']?[^;{}"']*\\b${n}\\b[^;{}"']*\\binfinite\\b`, "i").test(text) ||
      new RegExp(`animation\\s*:\\s*["']?[^;{}"']*\\binfinite\\b[^;{}"']*\\b${n}\\b`, "i").test(text) ||
      (new RegExp(`animation-?[nN]ame\\s*:\\s*["']?${n}\\b`, "i").test(text) &&
        /animation-?[iI]teration-?[cC]ount\s*:\s*["']?\s*infinite/i.test(text));
    if (drivenInfinite) {
      reasons.push(`infinite @keyframes '${name}' tweening transform/translate/scale — a bob/float loop; entrance motion eases in once, it never loops`);
    }
  }
  return reasons;
}

/** All banned-motion reasons found in `text` (empty = clean). */
export function bannedMotion(text: string): string[] {
  const reasons: string[] = [];
  if (isSpringBezier(text)) reasons.push("spring/overshoot cubic-bezier — motion eases, never bounces");
  if (hasNonZeroRotate(text)) reasons.push("decorative rotation (rotate())");
  // `animation-name` (CSS) / `animation`/`animationName` (JSX) referencing a banned loop.
  if (/@keyframes\s+(shimmer|skeleton|spin|parallax)\b/i.test(text) ||
      /animation(?:-name|Name)?\s*:\s*[^;{]*\b(?:shimmer|skeleton|spin|parallax)\b/i.test(text)) {
    reasons.push("banned looping animation (shimmer/skeleton/spin/parallax)");
  }
  // background-attachment: fixed — CSS kebab or JSX camelCase (backgroundAttachment: "fixed").
  if (/background-attachment\s*:\s*fixed/i.test(text) || /backgroundAttachment\s*:\s*["']?\s*fixed/i.test(text)) {
    reasons.push("parallax (background-attachment: fixed)");
  }
  if (/:hover\b[^{}]*\{[^}]*\bscale\s*\(/is.test(text)) reasons.push("hover-scale");
  if (hasDecorativeScale(text)) reasons.push("decorative transform: scale(>1) outside :hover");
  if (/\btsparticles\b|\bparticles\.(?:js|min)\b|particle-network/i.test(text)) reasons.push("particles");
  // will-change: transform (CSS kebab or JSX camelCase) paired with scroll — parallax rig.
  if ((/will-change\s*:\s*transform/i.test(text) || /willChange\s*:\s*["']?\s*transform/i.test(text)) && /\bscroll\b/i.test(text)) {
    reasons.push("scroll-driven will-change: transform (parallax)");
  }
  reasons.push(...infiniteTransformKeyframes(text));
  return reasons;
}
