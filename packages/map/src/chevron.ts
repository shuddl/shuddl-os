import { TOKENS } from "@shuddl/design";

// The moving-truck mark is a chevron oriented to heading. `icon-rotate` applies the bearing
// (clockwise degrees) ON TOP of the art, so the art MUST point NORTH (up) at 0°. Rasterised by
// hand (no canvas) so it builds identically in the browser, in jsdom, and in a worker — a plain
// RGBA bitmap that map.addImage('chevron', …) accepts directly.

export interface ChevronImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Even-odd point-in-polygon so the concave arrowhead (with its bottom notch) fills correctly. */
function inPolygon(x: number, y: number, poly: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i];
    const pj = poly[j];
    if (!pi || !pj) continue;
    const [xi, yi] = pi;
    const [xj, yj] = pj;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A north-pointing chevron (arrowhead) in signal red. Apex at the top, a concave notch at the
 * bottom-centre so it reads as a directional chevron, not a solid triangle. */
export function chevronImage(): ChevronImage {
  const size = 24;
  const [r, g, b] = hexToRgb(TOKENS.signal);
  const data = new Uint8ClampedArray(size * size * 4);
  // apex (north) → right base → bottom-centre notch → left base
  const poly: ReadonlyArray<readonly [number, number]> = [
    [12, 2],
    [21, 20],
    [12, 14],
    [3, 20],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inPolygon(x + 0.5, y + 0.5, poly)) {
        const idx = (y * size + x) * 4;
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }
  }
  return { width: size, height: size, data };
}
