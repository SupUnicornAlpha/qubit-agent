import { describe, expect, test } from "bun:test";
import { findContentBoundsInCell, isBackgroundPixel } from "./bbox";

describe("isBackgroundPixel", () => {
  test("treats near-white opaque pixels as background", () => {
    expect(isBackgroundPixel(255, 255, 255, 255, 240)).toBe(true);
    expect(isBackgroundPixel(245, 248, 250, 255, 240)).toBe(true);
  });

  test("treats colored pixels as foreground", () => {
    expect(isBackgroundPixel(120, 80, 30, 255, 240)).toBe(false);
    expect(isBackgroundPixel(0, 0, 0, 255, 240)).toBe(false);
  });

  test("treats transparent pixels as background", () => {
    expect(isBackgroundPixel(0, 0, 0, 0, 240)).toBe(true);
    expect(isBackgroundPixel(120, 80, 30, 8, 240)).toBe(true);
  });
});

describe("findContentBoundsInCell", () => {
  test("returns tight bbox of the only foreground pixel", () => {
    const W = 4;
    const H = 4;
    const pixels = new Uint8ClampedArray(W * H * 4).fill(255);
    const idx = (2 * W + 1) * 4;
    pixels[idx] = 200;
    pixels[idx + 1] = 50;
    pixels[idx + 2] = 50;
    pixels[idx + 3] = 255;

    const r = findContentBoundsInCell(pixels, W, 0, 0, W, H, 240);
    expect(r).toEqual({ x: 1, y: 2, w: 1, h: 1 });
  });

  test("returns null when cell is fully background", () => {
    const W = 4;
    const H = 4;
    const empty = new Uint8ClampedArray(W * H * 4).fill(255);
    expect(findContentBoundsInCell(empty, W, 0, 0, W, H, 240)).toBeNull();
  });

  test("scopes scan to the requested sub-rectangle only", () => {
    const W = 8;
    const H = 4;
    const pixels = new Uint8ClampedArray(W * H * 4).fill(255);
    /** Place a foreground pixel inside cell #0 (cols 0..3) */
    const a = (1 * W + 2) * 4;
    pixels[a] = 10; pixels[a + 1] = 10; pixels[a + 2] = 10; pixels[a + 3] = 255;
    /** Place a foreground pixel inside cell #1 (cols 4..7) */
    const b = (1 * W + 5) * 4;
    pixels[b] = 30; pixels[b + 1] = 30; pixels[b + 2] = 30; pixels[b + 3] = 255;

    expect(findContentBoundsInCell(pixels, W, 0, 0, 4, H, 240)).toEqual({
      x: 2, y: 1, w: 1, h: 1,
    });
    expect(findContentBoundsInCell(pixels, W, 4, 0, 4, H, 240)).toEqual({
      x: 5, y: 1, w: 1, h: 1,
    });
  });

  test("computes bbox spanning multiple foreground pixels", () => {
    const W = 6;
    const H = 6;
    const pixels = new Uint8ClampedArray(W * H * 4).fill(255);
    const set = (x: number, y: number) => {
      const i = (y * W + x) * 4;
      pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 0; pixels[i + 3] = 255;
    };
    set(2, 1);
    set(4, 1);
    set(3, 3);

    expect(findContentBoundsInCell(pixels, W, 0, 0, W, H, 240)).toEqual({
      x: 2, y: 1, w: 3, h: 3,
    });
  });
});
