// The five locked color tokens + two font stacks (doc 07 §01) as typed JS constants, for the
// places CSS custom properties can't reach (canvas, MapLibre paint expressions, JS math). In
// CSS/JSX always prefer `var(--token)`. Teal (`progress`) is progress-fills-only and never
// appears in a design primitive; it lives here only so the map layer can read it.

export const TOKENS = {
  field: "#D5D1CC",
  signal: "#FF4A33",
  signalDeep: "#A52F18",
  inkDark: "#1A1A1A",
  progress: "#00C4B4",
} as const;

export const FONTS = {
  display: "'Barlow Condensed', 'Oswald', sans-serif",
  mono: "'JetBrains Mono', 'IBM Plex Mono', monospace",
} as const;

export type ColorToken = keyof typeof TOKENS;
export type FontToken = keyof typeof FONTS;

// Every custom property tokens.css defines, mapped to its literal value — for the ONE surface
// that cannot dereference var(): the sendable evidence email (mail clients strip custom
// properties). The transparent reds live here as literals because this file IS the token
// source (the design audit exempts tokens.ts exactly as it exempts tokens.css). Keep in
// lockstep with tokens.css — the design test pins the two files against each other.
export const CSS_VAR_LITERALS = {
  "--field": TOKENS.field,
  "--signal": TOKENS.signal,
  "--signal-deep": TOKENS.signalDeep,
  "--ink-dark": TOKENS.inkDark,
  "--progress": TOKENS.progress,
  "--signal-55": "rgba(255, 74, 51, 0.55)",
  "--signal-12": "rgba(255, 74, 51, 0.12)",
  "--signal-07": "rgba(255, 74, 51, 0.07)",
  "--field-on-dark": TOKENS.field,
  "--display": FONTS.display,
  "--mono": FONTS.mono,
} as const;
