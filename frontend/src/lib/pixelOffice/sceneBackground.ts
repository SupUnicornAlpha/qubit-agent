import { pixelFont } from "./fonts";
import type { PixelOfficeRegistry } from "./registry";
import {
  computeOfficePerspective,
  computeWindowQuad,
  drawOfficeInterior,
  drawPerspectiveWindow,
} from "./officePerspective";

function cityLabel(cityId: string): string {
  if (cityId === "shanghai") return "上海 · 陆家嘴";
  if (cityId === "nyc") return "纽约 · 曼哈顿";
  if (cityId === "hongkong") return "香港 · 中环";
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
  const windowH = Math.max(100, Math.floor(h * 0.28));
  const p = computeOfficePerspective(w, h, windowH);
  const win = computeWindowQuad(p);

  drawOfficeInterior(ctx, w, h, windowH, now);

  const skyline = reg.getSkyline(cityId);
  drawPerspectiveWindow(ctx, p, win, (ox, oy, areaW, areaH) => {
    if (!skyline) return;
    skyline({
      ctx,
      ox,
      oy,
      areaW,
      areaH,
      pixel: 1,
      now,
    });
  });

  const labelX = (win.bl.x + win.br.x) / 2;
  const labelY = win.bl.y - 12;
  ctx.fillStyle = "rgba(226, 232, 240, 0.92)";
  ctx.font = pixelFont(12);
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 4;
  ctx.fillText(cityLabel(cityId), labelX, labelY);
  ctx.shadowBlur = 0;
}
