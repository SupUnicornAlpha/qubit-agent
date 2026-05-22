import { getRenderConfig } from "./config";
import type { PixelOfficeRegistry } from "./registry";
import type { CitySkyline } from "./types";

function cityLabel(cityId: string): string {
  if (cityId === "nyc") return "纽约 · 曼哈顿（世贸双子塔）";
  if (cityId === "shanghai") return "上海 · 陆家嘴（东方明珠 + 三件套）";
  if (cityId === "hongkong") return "香港 · 中环（中银大厦 / IFC）";
  return cityId;
}

/** 内置场景背景（可被 registry.setSceneBackgroundRenderer 整体替换） */
export function drawBuiltinSceneBackground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  cityId: string,
  now: number,
  reg: PixelOfficeRegistry
) {
  const cfg = getRenderConfig();
  const city = cityId as CitySkyline;
  const windowH = Math.max(100, Math.floor(h * 0.28));
  const wx = 10;
  const wy = 6;
  const ww = w - 20;
  const wh = windowH - 12;

  const sky = ctx.createLinearGradient(0, 0, 0, windowH);
  if (city === "nyc") {
    sky.addColorStop(0, "#0a1420");
    sky.addColorStop(0.4, "#1e3a58");
    sky.addColorStop(1, "#7a9ab8");
  } else if (city === "shanghai") {
    sky.addColorStop(0, "#140a28");
    sky.addColorStop(0.45, "#402060");
    sky.addColorStop(1, "#a07098");
  } else {
    sky.addColorStop(0, "#081420");
    sky.addColorStop(0.45, "#203850");
    sky.addColorStop(1, "#6090b0");
  }
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, windowH);

  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.fillRect(wx + 6, wy + 6, ww, wh);

  ctx.fillStyle = city === "shanghai" ? "#241838" : city === "hongkong" ? "#142030" : "#1c2838";
  ctx.fillRect(wx, wy, ww, wh);

  ctx.save();
  ctx.beginPath();
  ctx.rect(wx, wy, ww, wh);
  ctx.clip();

  const dusk = ctx.createLinearGradient(0, wy, 0, wy + wh);
  dusk.addColorStop(0, "rgba(255,200,140,0.14)");
  dusk.addColorStop(0.5, "transparent");
  dusk.addColorStop(1, "rgba(0,20,40,0.2)");
  ctx.fillStyle = dusk;
  ctx.fillRect(wx, wy, ww, wh);

  const skyline = reg.getSkyline(cityId);
  if (skyline) {
    skyline({
      ctx,
      ox: wx,
      oy: wy,
      areaW: ww,
      areaH: wh,
      pixel: cfg.skylinePixel,
      now,
    });
  }

  ctx.restore();

  ctx.strokeStyle = "#7a6048";
  ctx.lineWidth = 6;
  ctx.strokeRect(wx - 4, wy - 4, ww + 8, wh + 8);
  ctx.fillStyle = "#4a3828";
  ctx.fillRect(0, windowH - 5, w, 6);

  ctx.fillStyle = "#2a2520";
  ctx.fillRect(0, windowH, w, h - windowH);

  const tile = 24;
  for (let y = windowH; y < h; y += tile) {
    for (let x = 0; x < w; x += tile) {
      const alt = ((x / tile) + (y / tile)) % 2 === 0;
      ctx.fillStyle = alt ? "#3d3832" : "#353028";
      ctx.fillRect(x, y, tile, tile);
    }
  }

  ctx.fillStyle = "#4a4540";
  ctx.fillRect(0, h - 34, w, 34);
  for (let x = 0; x < w; x += 52) {
    ctx.fillStyle = "#5c5650";
    ctx.fillRect(x, h - 34, 32, 4);
  }

  ctx.fillStyle = "rgba(226, 232, 240, 0.9)";
  ctx.font = "12px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(cityLabel(cityId), wx + 12, wy + wh - 10);
}
