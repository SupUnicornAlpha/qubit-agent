/**
 * Pure-function helpers for inspecting a packed RGBA pixel buffer
 * during the Pixel Office v2 sprite-sheet build.
 *
 * Used by `frontend/scripts/build-pixel-office-v2.ts` to compute exact
 * frame bounds for each (breed, pose) cell of an AI-generated sheet,
 * so the renderer can blit only the cat (no whitespace) and at the
 * correct pixel-perfect rectangle.
 */

export type Bounds = { x: number; y: number; w: number; h: number };

export type RgbaBuffer = Uint8ClampedArray | Uint8Array;

/**
 * A pixel counts as "background" if it is either:
 *  - effectively transparent (alpha < 16), or
 *  - near-white opaque (R, G, B all >= whiteThreshold).
 *
 * This matches both AI-generated white-canvas sprite sheets and any
 * pre-trimmed transparent PNGs.
 */
export function isBackgroundPixel(
  r: number,
  g: number,
  b: number,
  a: number,
  whiteThreshold: number,
): boolean {
  if (a < 16) return true;
  return r >= whiteThreshold && g >= whiteThreshold && b >= whiteThreshold;
}

/**
 * Scan a sub-rectangle of an RGBA buffer and return the tight bounding box
 * of foreground (non-background) pixels.
 *
 * @returns The bounds in the SAME coordinate space as the cell (i.e. relative
 *          to the full image origin), or null if the cell is empty.
 */
export function findContentBoundsInCell(
  pixels: RgbaBuffer,
  imageWidth: number,
  cellX: number,
  cellY: number,
  cellW: number,
  cellH: number,
  whiteThreshold: number,
): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;

  const xEnd = cellX + cellW;
  const yEnd = cellY + cellH;

  for (let y = cellY; y < yEnd; y++) {
    const rowStart = y * imageWidth;
    for (let x = cellX; x < xEnd; x++) {
      const i = (rowStart + x) * 4;
      const r = pixels[i] ?? 0;
      const g = pixels[i + 1] ?? 0;
      const b = pixels[i + 2] ?? 0;
      const a = pixels[i + 3] ?? 0;
      if (isBackgroundPixel(r, g, b, a, whiteThreshold)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
