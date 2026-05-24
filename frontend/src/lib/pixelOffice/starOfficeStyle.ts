import { pixelFont } from "./fonts";
import { floorEdgeX, type OfficePerspective } from "./officePerspective";

/** Star Office 风格：物体脚下椭圆投影 */
export function drawDropShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h = 6,
  alpha = 0.28
) {
  ctx.save();
  ctx.fillStyle = `rgba(45, 35, 28, ${alpha})`;
  ctx.beginPath();
  ctx.ellipse(x, y + 4, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 透视地毯（休息区 / 工作区奶油色地垫） */
export function drawPerspectiveRug(
  ctx: CanvasRenderingContext2D,
  p: OfficePerspective,
  centerU: number,
  vTop: number,
  vBottom: number,
  widthRatio: number,
  base: string,
  alt?: string
) {
  const rows = 10;
  for (let i = 0; i < rows; i++) {
    const t0 = i / rows;
    const t1 = (i + 1) / rows;
    const v0 = vTop + (vBottom - vTop) * t0;
    const v1 = vTop + (vBottom - vTop) * t1;
    const y0 = p.windowH + (p.floorFront - p.windowH) * v0;
    const y1 = p.windowH + (p.floorFront - p.windowH) * v1;
    const lx0 = floorEdgeX(p, y0, "left");
    const rx0 = floorEdgeX(p, y0, "right");
    const w0 = (rx0 - lx0) * widthRatio;
    const cx = lx0 + (rx0 - lx0) * centerU;
    const lx1 = floorEdgeX(p, y1, "left");
    const rx1 = floorEdgeX(p, y1, "right");
    const w1 = (rx1 - lx1) * widthRatio;
    const cx1 = lx1 + (rx1 - lx1) * centerU;
    ctx.fillStyle = alt && i % 2 ? alt : base;
    ctx.beginPath();
    ctx.moveTo(cx - w0 / 2, y0);
    ctx.lineTo(cx + w0 / 2, y0);
    ctx.lineTo(cx1 + w1 / 2, y1);
    ctx.lineTo(cx1 - w1 / 2, y1);
    ctx.closePath();
    ctx.fill();
  }
  const yTop = p.windowH + (p.floorFront - p.windowH) * vTop;
  const lx = floorEdgeX(p, yTop, "left");
  const rx = floorEdgeX(p, yTop, "right");
  const w = (rx - lx) * widthRatio;
  const cx = lx + (rx - lx) * centerU;
  ctx.strokeStyle = "rgba(93, 64, 55, 0.35)";
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - w / 2, yTop, w, 1);
}

/** 绘制底部牌匾（Canvas 版，DOM 不可用时的兜底） */
export function drawOfficePlaque(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  title: string
) {
  const px = w / 2;
  const py = h - 22;
  const pw = Math.min(420, w - 40);
  const ph = 40;

  ctx.fillStyle = "#5d4037";
  ctx.strokeStyle = "#3e2723";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(px - pw / 2, py - ph / 2, pw, ph, 4);
  ctx.fill();
  ctx.stroke();

  ctx.font = pixelFont(14, "bold");
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffd700";
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 2;
  ctx.strokeText(title, px, py + 5);
  ctx.fillText(title, px, py + 5);

  ctx.font = pixelFont(16);
  ctx.fillStyle = "#ffd700";
  ctx.fillText("⭐", px - pw / 2 + 18, py + 6);
  ctx.fillText("⭐", px + pw / 2 - 18, py + 6);
}
