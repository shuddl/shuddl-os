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
