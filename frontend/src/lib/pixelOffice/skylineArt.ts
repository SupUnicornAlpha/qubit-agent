import type { CitySkyline } from "./types";
import type { SkylineDrawContext } from "./registry";
import { SkylineCanvas } from "./skylineCanvas";

function drawShanghaiLujiazui(s: SkylineCanvas) {
  const { base, W } = s;

  for (let x = 0; x < W; x++) {
    const h = 10 + ((x * 3) % 11);
    s.rect(x, base - h, 1, h, "#243848");
  }

  const pearlX = Math.floor(W * 0.08);
  s.rect(pearlX + 4, base - 82, 4, 82, "#a8a0b0");
  s.rect(pearlX + 3, base - 82, 6, 3, "#c8c0d0");
  s.rect(pearlX, base - 72, 11, 11, "#f04898");
  s.rect(pearlX - 1, base - 71, 13, 2, "#ffc8e0");
  s.rect(pearlX + 1, base - 70, 9, 8, "#e83888");
  s.rect(pearlX, base - 58, 11, 9, "#d02878");
  s.rect(pearlX + 2, base - 56, 7, 2, "#f8b0d0");
  s.rect(pearlX + 2, base - 42, 8, 8, "#e85098");
  s.rect(pearlX + 3, base - 40, 6, 2, "#f0a8c8");
  s.rect(pearlX + 4, base - 28, 6, 6, "#f068a8");
  s.rect(pearlX + 5, base - 22, 4, 4, "#e04088");
  s.rect(pearlX + 5, base - 86, 3, 5, "#ffa0d0");
  for (let i = 0; i < 10; i++) {
    s.px(pearlX + 2 + (i % 5), base - 64 + Math.floor(i / 5) * 6, "#ff90c8");
  }
  s.rect(pearlX + 2, base - 18, 5, 3, "#c02070");

  const jinmaoX = Math.floor(W * 0.2);
  let top = base - 10;
  for (let tier = 0; tier < 11; tier++) {
    const tw = 16 - Math.floor(tier * 0.85);
    const th = 8;
    top -= th;
    s.rect(jinmaoX + (16 - tw) / 2, top, tw, th, tier % 2 ? "#6a8090" : "#7a90a0");
    s.windows(jinmaoX + (16 - tw) / 2 + 1, top + 1, tw - 2, th - 2, "#d0e4f4", "#5a7080");
  }
  s.rect(jinmaoX + 6, top - 5, 5, 5, "#8aa0b0");
  s.rect(jinmaoX + 7, top - 6, 3, 2, "#b0c4d4");

  const swfcX = Math.floor(W * 0.34);
  const swfcH = 70;
  s.rect(swfcX, base - swfcH, 14, swfcH, "#5a7488");
  s.windows(swfcX + 1, base - swfcH + 3, 12, swfcH - 10, "#a0c0d8", "#486878");
  s.rect(swfcX + 4, base - swfcH, 6, 10, "#060c14");
  s.rect(swfcX + 5, base - swfcH + 1, 4, 8, "#142030");
  s.rect(swfcX + 3, base - swfcH - 2, 8, 3, "#405868");
  for (let y = 0; y < 4; y++) {
    s.rect(swfcX + 5, base - swfcH + 12 + y * 14, 4, 2, "#203040");
  }

  const shX = Math.floor(W * 0.46);
  const shH = 92;
  for (let y = 0; y < shH; y++) {
    const off = Math.floor(Math.sin(y * 0.15) * 2.5);
    const shade = y % 7 === 0 ? "#3a5870" : y % 4 === 0 ? "#4a6880" : "#5a7890";
    s.rect(shX + off, base - shH + y, 12, 1, shade);
  }
  s.rect(shX + 2, base - shH, 8, 4, "#6a90a0");
  for (let y = 8; y < shH; y += 9) {
    s.rect(shX + 4, base - shH + y, 4, 2, "#7aa8b8");
  }

  const aux = (x0: number, w: number, h: number, c: string) => {
    s.rect(x0, base - h, w, h, c);
    s.windows(x0 + 1, base - h + 2, w - 2, h - 3, "#90b0c8", "#3a5060");
  };
  aux(Math.floor(W * 0.6), 6, 22, "#3a5068");
  aux(Math.floor(W * 0.64), 8, 28, "#405870");
  aux(Math.floor(W * 0.7), 5, 18, "#354858");
  aux(Math.floor(W * 0.74), 7, 32, "#4a6880");
  aux(Math.floor(W * 0.8), 6, 24, "#3a5060");
  aux(Math.floor(W * 0.85), 9, 20, "#405868");
  aux(Math.floor(W * 0.92), 5, 16, "#354858");
}

function drawSkylineLights(s: SkylineCanvas, now: number) {
  const { c, W: artW } = s;
  const t = now / 650;
  const count = Math.min(80, Math.floor(artW * 0.15));
  for (let i = 0; i < count; i++) {
    const lx = c.ox + 20 + ((i * 59) % Math.max(20, c.areaW - 40));
    const ly = c.oy + 14 + ((i * 37) % Math.max(20, c.areaH - 60));
    if (Math.sin(t + i * 1.2) > 0.1) {
      c.ctx.fillStyle = i % 9 === 0 ? "#fff9c4" : i % 4 === 0 ? "#fde68a" : "#fcd34d";
      const sz = i % 7 === 0 ? 3 : 2;
      c.ctx.fillRect(lx, ly, sz, sz);
    }
  }
}

export function drawCitySkyline(ctx: SkylineDrawContext, _city: CitySkyline): void {
  const s = new SkylineCanvas(ctx);
  drawShanghaiLujiazui(s);
  drawSkylineLights(s, ctx.now);
}
