import type { CitySkyline } from "./types";
import type { SkylineDrawContext } from "./registry";
import { SkylineCanvas } from "./skylineCanvas";

function drawNycTwinTowers(s: SkylineCanvas) {
  const { base, W } = s;

  for (let x = 0; x < W; x++) {
    const d = Math.sin(x * 0.08) * 0.5;
    s.rect(x, base + Math.floor(d), 1, 6, x % 4 === 0 ? "#1e5088" : "#184878");
  }

  const filler = (x0: number, w: number, h: number, body: string, lit = "#b0c8e0") => {
    s.rect(x0, base - h, w, h, body);
    s.windows(x0 + 1, base - h + 2, w - 2, h - 4, lit, "#5a7088");
  };

  filler(0, 12, 20, "#3a4a5c");
  filler(14, 9, 16, "#445868");
  filler(26, 14, 28, "#4a5a6c");
  filler(42, 8, 14, "#3e4e60");
  s.rect(38, base - 34, 4, 34, "#354858");
  filler(52, 11, 22, "#526878");
  filler(W - 55, 10, 18, "#4a6278");
  filler(W - 42, 13, 26, "#566c82");
  filler(W - 28, 9, 20, "#4e6278");
  filler(W - 16, 7, 14, "#465a6e");
  filler(W - 8, 5, 10, "#3a4a5c");

  const tw = 22;
  const th = 88;
  const gap = 5;
  const cx = Math.floor(W * 0.42) - tw - Math.floor(gap / 2);

  const drawTower = (x0: number, h: number, antenna: boolean, tint: string) => {
    s.rect(x0, base - h, tw, h, tint);
    s.rect(x0 + 1, base - h + 1, tw - 2, h - 2, "#c0ccd8");
    s.windows(x0 + 2, base - h + 5, tw - 4, h - 8, "#eef4fc", "#98a8c0");
    for (let band = 0; band < 6; band++) {
      s.rect(x0, base - h + 6 + band * 13, tw, 1, "#8898a8");
    }
    s.rect(x0, base - h, tw, 4, "#6a7888");
    if (antenna) {
      s.rect(x0 + 9, base - h - 7, 3, 7, "#d8e0e8");
      s.rect(x0 + 7, base - h - 8, 7, 2, "#f4f8fc");
      s.rect(x0 + 10, base - h - 10, 1, 2, "#ff4444");
    }
  };

  drawTower(cx, th, true, "#a8b4c4");
  drawTower(cx + tw + gap, th - 4, false, "#98a8b8");
  s.rect(cx - 4, base - 12, tw * 2 + gap + 8, 12, "#283848");
  s.rect(cx - 2, base - 14, tw * 2 + gap + 4, 2, "#384858");

  for (let i = 0; i < 4; i++) {
    s.rect(6 + i * 5, base - 2 - i, 4, 2, "#8a7050");
  }
  s.rect(W - 20, base - 3, 12, 3, "#7a6848");
}

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

function drawHongKongCentral(s: SkylineCanvas) {
  const { base, W } = s;

  for (let x = 0; x < W; x++) {
    s.rect(x, base - 5, 1, 5, x % 3 === 0 ? "#1a5088" : "#143c68");
  }

  const aux = (x0: number, w: number, h: number, body: string) => {
    s.rect(x0, base - h, w, h, body);
    s.windows(x0 + 1, base - h + 2, w - 2, h - 3, "#a8c0d8", "#4a6078");
  };

  const bocX = Math.floor(W * 0.03);
  const bocH = 58;
  for (let y = 0; y < bocH; y++) {
    const inset = Math.floor(y / 4.5);
    const w = 14 - inset * 2;
    s.rect(bocX + inset, base - bocH + y, w, 1, y % 2 ? "#90a0b0" : "#a8b8c8");
  }
  for (let d = 0; d < 14; d++) {
    s.px(bocX + d, base - bocH + d * 3, "#f0f4f8");
    s.px(bocX + 13 - Math.floor(d / 2), base - bocH + d * 3 + 1, "#687888");
  }
  s.rect(bocX + 5, base - bocH - 6, 4, 6, "#d8e4f0");
  s.windows(bocX + 3, base - bocH + 10, 6, bocH - 16, "#dce8f4", "#607080");

  aux(Math.floor(W * 0.1), 5, 28, "#4a6078");
  aux(Math.floor(W * 0.14), 6, 34, "#526880");
  aux(Math.floor(W * 0.19), 4, 22, "#405868");

  const plazaX = Math.floor(W * 0.24);
  s.rect(plazaX, base - 48, 9, 42, "#5a7088");
  s.windows(plazaX + 1, base - 46, 7, 38, "#98b8d0", "#4a6078");
  for (let i = 0; i < 9; i++) {
    s.px(plazaX + 4 - Math.min(i, 4), base - 48 - i, "#c0d0e0");
    s.px(plazaX + 4 + Math.min(i, 4), base - 48 - i, "#c0d0e0");
  }

  for (let i = 0; i < 12; i++) {
    const bx = Math.floor(W * 0.32) + i * 4;
    const bh = 14 + ((i * 5) % 9) * 3;
    aux(bx, 4, bh, i % 2 ? "#465a70" : "#3e5268");
  }

  aux(Math.floor(W * 0.48), 7, 36, "#566c80");
  aux(Math.floor(W * 0.54), 6, 30, "#4a6480");

  const ifc2X = Math.floor(W * 0.62);
  const ifcH = 78;
  s.rect(ifc2X, base - ifcH, 14, ifcH, "#6a8498");
  s.rect(ifc2X + 1, base - ifcH + 2, 12, ifcH - 4, "#88a0b8");
  s.windows(ifc2X + 2, base - ifcH + 5, 10, ifcH - 12, "#d8ecf8", "#5a7488");
  s.rect(ifc2X + 3, base - ifcH, 8, 5, "#a0b8c8");
  s.rect(ifc2X + 4, base - ifcH - 3, 6, 3, "#b8ccd8");

  const iccX = Math.floor(W * 0.74);
  const iccH = 72;
  for (let y = 0; y < iccH; y++) {
    const taper = Math.floor(y / 8);
    s.rect(iccX + taper, base - iccH + y, 12 - taper, 1, y % 3 === 0 ? "#708898" : "#8098a8");
  }
  s.rect(iccX + 2, base - iccH - 4, 6, 4, "#98a8b8");
  s.windows(iccX + 3, base - iccH + 8, 6, iccH - 14, "#c8dce8", "#506878");

  aux(Math.floor(W * 0.82), 8, 38, "#4a6880");
  aux(Math.floor(W * 0.88), 6, 28, "#405870");
  aux(Math.floor(W * 0.93), 5, 22, "#3a5068");
  aux(Math.floor(W * 0.97), 4, 16, "#354858");

  for (let i = 0; i < 3; i++) {
    s.rect(20 + i * 8, base - 2, 5, 2, "#6a5840");
  }
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

export function drawCitySkyline(ctx: SkylineDrawContext, city: CitySkyline): void {
  const s = new SkylineCanvas(ctx);
  if (city === "nyc") drawNycTwinTowers(s);
  else if (city === "shanghai") drawShanghaiLujiazui(s);
  else drawHongKongCentral(s);
  drawSkylineLights(s, ctx.now);
}
