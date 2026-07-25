/** The two pulses off one sine, as CONSTANTS. Keeping these scalar is the whole point: a data-driven
 * paint expression is bound per-feature and re-uploaded for all 1,000 entities every frame, whereas a
 * constant binds to a GL uniform. The exception throbs urgently (1.6s), at-risk breathes calmly (3s),
 * healthy never moves — that grammar now lives in the LAYER SPLIT (filters on the static `statusStr`
 * property), which is what lets the animated value be a bare number. */
export function pulseWidths(ts: number): { exception: number; atRisk: number } {
  const urgent = 0.5 + 0.5 * Math.sin((ts / 1600) * 2 * Math.PI);
  const calm = 0.5 + 0.5 * Math.sin((ts / 3000) * 2 * Math.PI);
  return { exception: 2 + 4 * urgent, atRisk: 1 + 1.5 * calm };
}
