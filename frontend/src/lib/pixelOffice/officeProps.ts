import { pixelFont } from "./fonts";
import { depthScale, floorEdgeX, type OfficePerspective } from "./officePerspective";
import { drawDropShadow, drawPerspectiveRug } from "./starOfficeStyle";
import type { OfficeLayout } from "./types";

function px(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  c: string
) {
  ctx.fillStyle = c;
  ctx.fillRect(Math.floor(x), Math.floor(y), Math.max(1, w), Math.max(1, h));
}

/** 区域角标（Star Office 风格：工作区 / 休息角 / 工具区） */
function drawZoneMarkers(ctx: CanvasRenderingContext2D, layout: OfficeLayout) {
  const zones: Array<{ pt: { x: number; y: number; depth: number }; label: string; color: string }> = [
    { pt: layout.workZone, label: "💻 工作区", color: "#6d5040" },
    { pt: layout.lounge, label: "🛋 休息角", color: "#8b7355" },
    { pt: layout.shelf, label: "📚 技能区", color: "#92400e" },
    { pt: layout.rack, label: "🐛 工具区", color: "#b45309" },
  ];

  for (const z of zones) {
    const fs = Math.max(9, Math.floor(10 * depthScale(z.pt.depth)));
    ctx.font = pixelFont(fs, "bold");
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(15, 23, 42, 0.55)";
    ctx.fillText(z.label, z.pt.x + 1, z.pt.y + 1);
    ctx.fillStyle = z.color;
    ctx.fillText(z.label, z.pt.x, z.pt.y);
  }
}

function drawCoffeeStation(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  depth: number,
  now: number
) {
  const s = depthScale(depth);
  const w = 36 * s;
  const h = 44 * s;
  px(ctx, x - w / 2, y - h, w, h, "#4a5568");
  px(ctx, x - w / 2 + 2, y - h + 2, w - 4, h - 4, "#64748b");
  px(ctx, x - 8 * s, y - h + 8, 16 * s, 10 * s, "#334155");
  px(ctx, x - 6 * s, y - h + 10, 12 * s, 6 * s, "#1e293b");
  const steam = Math.floor(now / 400) % 3;
  if (steam > 0) {
    px(ctx, x - 4 * s, y - h - 4 * s, 3 * s, 3 * s, "rgba(226,232,240,0.5)");
    px(ctx, x + 2 * s, y - h - 6 * s, 2 * s, 2 * s, "rgba(226,232,240,0.35)");
  }
  px(ctx, x + 10 * s, y - h + 14, 8 * s, 12 * s, "#f8fafc");
  px(ctx, x + 11 * s, y - h + 16, 6 * s, 2 * s, "#38bdf8");
}

function drawLoungeArmchair(ctx: CanvasRenderingContext2D, x: number, y: number, depth: number) {
  const s = depthScale(depth);
  drawDropShadow(ctx, x, y, 52 * s, 8 * s);
  px(ctx, x - 30 * s, y - 20 * s, 60 * s, 16 * s, "#8b7355");
  px(ctx, x - 28 * s, y - 28 * s, 56 * s, 12 * s, "#a08968");
  px(ctx, x - 24 * s, y - 18 * s, 48 * s, 12 * s, "#c4a882");
  px(ctx, x - 30 * s, y - 10 * s, 10 * s, 10 * s, "#6d5a48");
  px(ctx, x + 20 * s, y - 10 * s, 10 * s, 10 * s, "#6d5a48");
}

function drawCoffeeTable(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  depth: number,
  now: number
) {
  const s = depthScale(depth);
  drawDropShadow(ctx, x, y, 44 * s, 7 * s);
  px(ctx, x - 22 * s, y - 14 * s, 44 * s, 6 * s, "#6d5040");
  px(ctx, x - 20 * s, y - 12 * s, 40 * s, 4 * s, "#8b6914");
  px(ctx, x - 18 * s, y - 8 * s, 8 * s, 8 * s, "#5c4030");
  px(ctx, x + 10 * s, y - 8 * s, 8 * s, 8 * s, "#5c4030");
  px(ctx, x - 6 * s, y - 22 * s, 14 * s, 12 * s, "#475569");
  px(ctx, x - 4 * s, y - 20 * s, 10 * s, 8 * s, "#334155");
  px(ctx, x - 2 * s, y - 18 * s, 6 * s, 4 * s, "#1e293b");
  const steam = Math.floor(now / 380) % 3;
  if (steam > 0) {
    px(ctx, x + 8 * s, y - 26 * s, 3 * s, 3 * s, "rgba(255,255,255,0.45)");
    px(ctx, x + 12 * s, y - 28 * s, 2 * s, 2 * s, "rgba(255,255,255,0.3)");
  }
  px(ctx, x + 4 * s, y - 16 * s, 6 * s, 5 * s, "#f8fafc");
  px(ctx, x + 5 * s, y - 14 * s, 4 * s, 2 * s, "#92400e");
}

function drawFloorLamp(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  depth: number,
  now: number
) {
  const s = depthScale(depth);
  drawDropShadow(ctx, x, y, 16 * s, 5 * s);
  px(ctx, x - 2 * s, y - 38 * s, 4 * s, 36 * s, "#5c4030");
  px(ctx, x - 10 * s, y - 42 * s, 20 * s, 8 * s, "#fde68a");
  const pulse = 0.85 + Math.sin(now / 600) * 0.15;
  const grd = ctx.createRadialGradient(x, y - 20 * s, 0, x, y, 48 * s);
  grd.addColorStop(0, `rgba(253, 224, 71, ${0.28 * pulse})`);
  grd.addColorStop(1, "rgba(253, 224, 71, 0)");
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.ellipse(x, y - 4 * s, 36 * s, 16 * s, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawCatBed(ctx: CanvasRenderingContext2D, x: number, y: number, depth: number) {
  const s = depthScale(depth);
  drawDropShadow(ctx, x, y, 28 * s, 6 * s);
  px(ctx, x - 14 * s, y - 8 * s, 28 * s, 8 * s, "#78716c");
  px(ctx, x - 12 * s, y - 14 * s, 24 * s, 8 * s, "#a8a29e");
  px(ctx, x - 6 * s, y - 12 * s, 12 * s, 6 * s, "#e7e5e4");
}

function drawPoster(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, accent: string) {
  px(ctx, x, y, w, h, "#2a2218");
  px(ctx, x + 2, y + 2, w - 4, h - 4, "#3d3020");
  px(ctx, x + 6, y + 6, w - 12, h - 14, accent);
  px(ctx, x + 8, y + h - 10, w - 16, 4, "#fde68a");
}

function drawDeskLamp(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  depth: number,
  on: boolean,
  now: number
) {
  const s = depthScale(depth);
  px(ctx, x - 2 * s, y - 14 * s, 4 * s, 12 * s, "#64748b");
  px(ctx, x - 8 * s, y - 16 * s, 16 * s, 4 * s, on ? "#fde68a" : "#94a3b8");
  if (on) {
    const pulse = 0.85 + Math.sin(now / 500) * 0.15;
    const grd = ctx.createRadialGradient(x, y - 8 * s, 0, x, y, 28 * s);
    grd.addColorStop(0, `rgba(253, 224, 71, ${0.22 * pulse})`);
    grd.addColorStop(1, "rgba(253, 224, 71, 0)");
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.ellipse(x, y + 4 * s, 22 * s, 10 * s, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawPottedPlant(ctx: CanvasRenderingContext2D, x: number, y: number, depth: number) {
  const s = depthScale(depth);
  px(ctx, x - 6 * s, y - 8 * s, 12 * s, 8 * s, "#78350f");
  px(ctx, x - 8 * s, y - 18 * s, 16 * s, 12 * s, "#4a7c59");
  px(ctx, x - 4 * s, y - 22 * s, 8 * s, 8 * s, "#6aad78");
}

function drawWallArt(ctx: CanvasRenderingContext2D, p: OfficePerspective, winLeft: number) {
  const y = p.windowH + 14;
  drawPoster(ctx, winLeft + 20, y, 36, 28, "#38bdf8");
  drawPoster(ctx, winLeft + 62, y + 4, 28, 22, "#4ade80");
}

/** 工位木牌名牌（截图中的 brown tag 风格） */
export function drawDeskNameplate(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  title: string,
  role: string,
  selected: boolean,
  depth: number
) {
  const s = depthScale(depth);
  const short = title.length > 12 ? `${title.slice(0, 11)}…` : title;
  ctx.font = pixelFont(10 * s, "bold");
  const tw = ctx.measureText(short).width + 14 * s;
  const rh = 22 * s;
  const rx = x - tw / 2;
  const ry = y + 18 * s;

  ctx.fillStyle = selected ? "#6d5040" : "#5d4037";
  ctx.strokeStyle = selected ? "#ffd700" : "#3e2723";
  ctx.lineWidth = selected ? 2 : 1;
  ctx.beginPath();
  ctx.roundRect(rx, ry, tw, rh, 3 * s);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#ffd700";
  ctx.textAlign = "center";
  ctx.fillText(short, x, ry + 9 * s);
  ctx.font = pixelFont(8 * s);
  ctx.fillStyle = "#f5e6c8";
  ctx.fillText(role, x, ry + 18 * s);
}

/** Pixel Agents 风格状态角标 */
export function statusEmojiForAction(action: string, screenMode: string): string | null {
  if (action === "chat_send" || action === "chat_recv") return "💬";
  if (action === "walk") return "🚶";
  if (action === "at_rack" || action === "mcp") return "⚡";
  if (action === "at_shelf" || action === "skill") return "📚";
  if (action === "success") return "✓";
  if (action === "fail") return "✗";
  if (action === "success_empty") return "∅";
  if (["tool", "builtin", "sandbox"].includes(action)) return "⌨";
  if (screenMode === "code") return "⌨";
  if (screenMode === "chat") return "💬";
  if (action === "idle") return null;
  return "●";
}

export function drawStatusBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  emoji: string,
  depth: number
) {
  const s = depthScale(depth);
  const r = 11 * s;
  ctx.fillStyle = "rgba(15, 23, 42, 0.88)";
  ctx.strokeStyle = "#475569";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.font = pixelFont(11 * s);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, x, y + 1);
  ctx.textBaseline = "alphabetic";
}

export function drawMonitorGlow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  depth: number,
  mode: string,
  now: number
) {
  if (mode === "idle") return;
  const s = depthScale(depth);
  const colors: Record<string, string> = {
    chat: "#38bdf8",
    code: "#4ade80",
    mcp: "#22c55e",
    skill: "#fbbf24",
    sandbox: "#60a5fa",
    ok: "#4ade80",
    err: "#f87171",
    empty: "#fbbf24",
  };
  const c = colors[mode] ?? "#94a3b8";
  const pulse = 0.7 + Math.sin(now / 380) * 0.3;
  ctx.save();
  ctx.globalAlpha = 0.16 * pulse;
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.ellipse(x, y - 14 * s, 28 * s, 12 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 绘制环境道具与区域标识（在工位之前、地板之后） */
export function drawOfficeAmbience(
  ctx: CanvasRenderingContext2D,
  p: OfficePerspective,
  layout: OfficeLayout,
  now: number,
  isRunning: boolean
) {
  drawPerspectiveRug(ctx, p, 0.5, 0.08, 0.55, 0.38, "#f5efe4", "#ebe3d4");
  drawPerspectiveRug(ctx, p, 0.35, 0.35, 0.82, 0.32, "#ede4d4", "#e2d8c8");
  drawPerspectiveRug(ctx, p, 0.92, 0.38, 0.72, 0.22, "#e8e0d8", "#ddd4cc");

  drawWallArt(ctx, p, p.winLeft);

  const lounge = layout.lounge;
  drawCoffeeTable(ctx, lounge.x, lounge.y + 8, lounge.depth, now);
  drawLoungeArmchair(ctx, lounge.x - 36 * depthScale(lounge.depth), lounge.y, lounge.depth);
  drawLoungeArmchair(ctx, lounge.x + 36 * depthScale(lounge.depth), lounge.y, lounge.depth);
  drawFloorLamp(ctx, lounge.x + 52 * depthScale(lounge.depth), lounge.y - 4, lounge.depth, now);
  drawCatBed(ctx, lounge.x - 58 * depthScale(lounge.depth), lounge.y + 6, lounge.depth);

  drawCoffeeStation(ctx, layout.coffee.x, layout.coffee.y, layout.coffee.depth, now);
  drawPottedPlant(ctx, layout.coffee.x - 28 * depthScale(layout.coffee.depth), layout.coffee.y, layout.coffee.depth);
  drawPottedPlant(ctx, layout.shelf.x - 18, layout.shelf.y - 8, layout.shelf.depth);

  const frontY = p.floorFront - 28;
  const plx = floorEdgeX(p, frontY, "left") + 24;
  drawPottedPlant(ctx, plx, frontY, 0.85);

  drawZoneMarkers(ctx, layout);

  if (isRunning) {
    const midY = p.windowH + (p.floorFront - p.windowH) * 0.35;
    const lx = floorEdgeX(p, midY, "left");
    const rx = floorEdgeX(p, midY, "right");
    ctx.strokeStyle = "rgba(74, 222, 128, 0.22)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.strokeRect(lx + 8, midY - 6, rx - lx - 16, 12);
    ctx.setLineDash([]);
  }
}

export function drawDeskLampForWorkstation(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  depth: number,
  active: boolean,
  now: number
) {
  drawDeskLamp(ctx, x + 22 * depthScale(depth), y - 32 * depthScale(depth), depth, active, now);
}
