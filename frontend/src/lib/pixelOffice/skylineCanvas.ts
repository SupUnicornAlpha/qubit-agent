import type { SkylineDrawContext } from "./registry";

/** 天际线绘制辅助（艺术像素坐标系） */
export class SkylineCanvas {
  readonly base: number;
  readonly W: number;

  constructor(readonly c: SkylineDrawContext) {
    this.base = Math.floor(c.areaH / c.pixel) - 6;
    this.W = Math.floor(c.areaW / c.pixel);
  }

  rect(x: number, y: number, w: number, h: number, color: string) {
    const { ctx, ox, oy, pixel: P } = this.c;
    ctx.fillStyle = color;
    ctx.fillRect(ox + x * P, oy + y * P, w * P, h * P);
  }

  px(x: number, y: number, color: string) {
    this.rect(x, y, 1, 1, color);
  }

  windows(x0: number, y0: number, w: number, h: number, lit: string, dim: string) {
    for (let yy = y0; yy < y0 + h; yy += 2) {
      for (let xx = x0; xx < x0 + w; xx++) {
        if ((xx + yy) % 3 === 0) this.px(xx, yy, lit);
        else if ((xx + yy) % 5 === 0) this.px(xx, yy, dim);
      }
    }
  }
}
