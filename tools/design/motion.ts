// Motion-law detectors (doc 07 §06 audit #5, REQ-148). Pure string analysis, no DOM.
// Sanctioned motion is narrow: reveals (fade-up), eased count-ups, opacity fades, map-mark
// glide, the two map pulses, the ⌘K typewriter. Everything else is decoration and banned:
// springs, parallax, decorative rotation, hover-scale, particles, shimmer/skeleton loaders.

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

/** All banned-motion reasons found in `text` (empty = clean). */
export function bannedMotion(text: string): string[] {
  const reasons: string[] = [];
  if (isSpringBezier(text)) reasons.push("spring/overshoot cubic-bezier — motion eases, never bounces");
  if (hasNonZeroRotate(text)) reasons.push("decorative rotation (rotate())");
  if (/@keyframes\s+(shimmer|skeleton|spin|parallax)\b/i.test(text) ||
      /animation(?:-name)?\s*:\s*[^;{]*\b(?:shimmer|skeleton|spin|parallax)\b/i.test(text)) {
    reasons.push("banned looping animation (shimmer/skeleton/spin/parallax)");
  }
  if (/background-attachment\s*:\s*fixed/i.test(text)) reasons.push("parallax (background-attachment: fixed)");
  if (/:hover\b[^{}]*\{[^}]*\bscale\s*\(/is.test(text)) reasons.push("hover-scale");
  if (/\btsparticles\b|\bparticles\.(?:js|min)\b|particle-network/i.test(text)) reasons.push("particles");
  if (/will-change\s*:\s*transform/i.test(text) && /\bscroll\b/i.test(text)) reasons.push("scroll-driven will-change: transform (parallax)");
  return reasons;
}
