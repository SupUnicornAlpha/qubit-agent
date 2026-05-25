import { pixelFont } from "./fonts";
import { depthScale, floorEdgeX, type OfficePerspective } from "./officePerspective";
import { drawDropShadow, drawPerspectiveRug } from "./starOfficeStyle";
import { drawThemeSprite } from "./themeAssets";
import { ensureActiveAtlasLoaded, getActiveAtlasSync, getActiveTheme } from "./themes";
import type { LoadedThemeAtlas } from "./themes/types";
import type { OfficeLayout } from "./types";

/** 主题 sprite 渲染基准缩放：让 16/32 px raw 资产在 720p 舞台呈现近似程序化家具的视觉尺寸。 */
const THEME_SPRITE_SCALE = 2.4;

/**
 * 用主题 atlas 画一件家具：底中锚点 + 椭圆地面阴影 + 透视缩放。
 * 找不到 sprite 名返回 false，调用方应 fallback 到程序化绘制。
 */
function drawThemedFurniture(
  ctx: CanvasRenderingContext2D,
  atlas: LoadedThemeAtlas,
  spriteName: string,
  x: number,
  y: number,
  depth: number,
  opts: { shadowW?: number; scaleMul?: number; flipX?: boolean } = {}
): boolean {
  const frame = atlas.manifest.frames[spriteName];
  if (!frame) return false;
  const scale = THEME_SPRITE_SCALE * (opts.scaleMul ?? 1) * depthScale(depth);
  const visW = frame.w * scale;
  const shadowW = opts.shadowW ?? visW * 0.7;
  drawDropShadow(ctx, x, y, shadowW, Math.max(5, visW * 0.18));
  return drawThemeSprite(ctx, atlas, spriteName, x, y, scale, opts.flipX);
}

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

/** 用主题 atlas 重绘休息角 + 咖啡角 + 角落植物 + 墙饰；返回是否成功用了 sprite。 */
function drawThemedAmbience(
  ctx: CanvasRenderingContext2D,
  atlas: LoadedThemeAtlas,
  p: OfficePerspective,
  layout: OfficeLayout,
  now: number
): boolean {
  const theme = getActiveTheme();
  const decor = theme.decorations;

  const lounge = layout.lounge;
  const ls = depthScale(lounge.depth);
  drawThemedFurniture(ctx, atlas, decor.loungeSofa, lounge.x - 4 * ls, lounge.y, lounge.depth, {
    scaleMul: 1.1,
  });
  drawThemedFurniture(ctx, atlas, decor.loungeTable, lounge.x + 30 * ls, lounge.y + 6 * ls, lounge.depth, {
    scaleMul: 0.85,
    shadowW: 36 * ls,
  });
  drawFloorLamp(ctx, lounge.x + 64 * ls, lounge.y - 4, lounge.depth, now);
  drawCatBed(ctx, lounge.x - 60 * ls, lounge.y + 6, lounge.depth);

  drawThemedFurniture(ctx, atlas, decor.coffeeMachine, layout.coffee.x, layout.coffee.y, layout.coffee.depth, {
    scaleMul: 1.15,
  });
  const cs = depthScale(layout.coffee.depth);
  drawThemedFurniture(
    ctx,
    atlas,
    decor.cornerPlants[0] ?? "Big-Plant",
    layout.coffee.x - 30 * cs,
    layout.coffee.y + 2 * cs,
    layout.coffee.depth,
    { scaleMul: 0.9 }
  );

  // 书架旁植物
  drawThemedFurniture(
    ctx,
    atlas,
    decor.cornerPlants[1] ?? "Small-Plant",
    layout.shelf.x - 24,
    layout.shelf.y - 4,
    layout.shelf.depth,
    { scaleMul: 0.85 }
  );

  // 前景角落植物
  const frontY = p.floorFront - 28;
  const plx = floorEdgeX(p, frontY, "left") + 24;
  drawThemedFurniture(
    ctx,
    atlas,
    decor.cornerPlants[2] ?? "Big-Plant",
    plx,
    frontY,
    0.85,
    { scaleMul: 1 }
  );

  // 额外散落家具：在 rack 附近（已被寻路阻挡），不会影响通道
  const ed = depthScale(layout.rack.depth);
  if (decor.extras[0]) {
    drawThemedFurniture(ctx, atlas, decor.extras[0], layout.rack.x + 64 * ed, layout.rack.y + 10, layout.rack.depth, {
      scaleMul: 0.95,
    });
  }
  if (decor.extras[1]) {
    drawThemedFurniture(ctx, atlas, decor.extras[1], layout.shelf.x + 64 * ed, layout.shelf.y + 10, layout.shelf.depth, {
      scaleMul: 0.95,
    });
  }

  // 墙饰：替换为主题 wallDecor sprite（top 处沿窗户左右两侧分布）
  const wallY = p.windowH + 18;
  const winLeft = p.winLeft;
  const winRight = p.winRight;
  if (decor.wallDecor[0]) {
    drawThemedFurniture(ctx, atlas, decor.wallDecor[0], winLeft + 36, wallY + 18, 0.05, { scaleMul: 0.9 });
  }
  if (decor.wallDecor[1]) {
    drawThemedFurniture(ctx, atlas, decor.wallDecor[1], winLeft + 86, wallY + 14, 0.05, { scaleMul: 0.85 });
  }
  if (decor.wallDecor[2]) {
    drawThemedFurniture(ctx, atlas, decor.wallDecor[2], winRight - 56, wallY + 16, 0.05, { scaleMul: 0.85 });
  }

  return true;
}

/** 绘制环境道具与区域标识（在工位之前、地板之后） */
export function drawOfficeAmbience(
  ctx: CanvasRenderingContext2D,
  p: OfficePerspective,
  layout: OfficeLayout,
  now: number,
  isRunning: boolean
) {
  const theme = getActiveTheme();
  ensureActiveAtlasLoaded();
  const atlas = getActiveAtlasSync();

  // 主题色板驱动的地毯（保留分层结构，色彩走当前主题）
  drawPerspectiveRug(ctx, p, 0.5, 0.08, 0.55, 0.38, theme.palette.floor, theme.palette.floorAlt);
  drawPerspectiveRug(ctx, p, 0.35, 0.35, 0.82, 0.32, theme.palette.floor, theme.palette.floorAlt);
  drawPerspectiveRug(ctx, p, 0.92, 0.38, 0.72, 0.22, theme.palette.floor, theme.palette.floorAlt);

  if (atlas) {
    drawThemedAmbience(ctx, atlas, p, layout, now);
  } else {
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
  }

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

/**
 * 程序化透视书架 V2 —— 替代旧的"正面 sprite blit"，给柜体加上俯视顶板 + 侧厚度 + 5 层带书。
 *
 * 立体感来源：
 *   - 顶板是个透视梯形（VP 指向画面中心，所以左侧书架顶板向右倾斜，右侧反之）
 *   - 侧面是个微梯形（顶部窄底部宽，模拟一点透视的纵深）
 *   - 正面 5 层，每层错落几本不同色书脊，最上一层放绿植
 *
 * @param facing 哪一侧的侧面对镜头：通常左下角书架是 "right"（右侧面朝向 VP 看不见，
 *               但镜头偏中央看到的是它的右侧厚度），右下角机架同理 "left"。
 */
export function drawShelfPerspective(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  depth: number,
  facing: "left" | "right",
  _now: number
): void {
  const d = depthScale(depth);
  const w = 60 * d;
  const h = 108 * d;
  const sideW = 9 * d;
  const baseX = x - w / 2;
  const topY = y - h;
  const sign = facing === "right" ? 1 : -1;

  // 地面阴影
  drawDropShadow(ctx, x + sign * sideW * 0.4, y + 2 * d, (w + sideW) * 0.85, 6 * d, 0.32);

  // === 侧面（梯形：顶窄底宽，模拟一点透视收敛）===
  ctx.fillStyle = "#3a2818";
  ctx.beginPath();
  if (facing === "right") {
    ctx.moveTo(baseX + w, topY + 5 * d);
    ctx.lineTo(baseX + w + sideW, topY + 9 * d);
    ctx.lineTo(baseX + w + sideW * 0.7, topY + h);
    ctx.lineTo(baseX + w, topY + h);
  } else {
    ctx.moveTo(baseX, topY + 5 * d);
    ctx.lineTo(baseX - sideW, topY + 9 * d);
    ctx.lineTo(baseX - sideW * 0.7, topY + h);
    ctx.lineTo(baseX, topY + h);
  }
  ctx.closePath();
  ctx.fill();

  // 侧面木纹（3 条细横线）
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  for (let i = 0; i < 3; i++) {
    const t = 0.2 + i * 0.3;
    const sy = topY + 9 * d + (h - 9 * d) * t;
    const xa = facing === "right" ? baseX + w : baseX;
    const xb = facing === "right" ? baseX + w + sideW * (1 - t * 0.3) : baseX - sideW * (1 - t * 0.3);
    ctx.beginPath();
    ctx.moveTo(xa, sy);
    ctx.lineTo(xb, sy + 2 * d);
    ctx.lineTo(xb, sy + 3 * d);
    ctx.lineTo(xa, sy + 1 * d);
    ctx.closePath();
    ctx.fill();
  }

  // === 顶板（俯视梯形，前沿宽于后沿）===
  ctx.fillStyle = "#4a3220";
  ctx.beginPath();
  if (facing === "right") {
    ctx.moveTo(baseX + 2 * d, topY);
    ctx.lineTo(baseX + w, topY);
    ctx.lineTo(baseX + w + sideW, topY + 9 * d);
    ctx.lineTo(baseX, topY + 9 * d);
  } else {
    ctx.moveTo(baseX, topY);
    ctx.lineTo(baseX + w - 2 * d, topY);
    ctx.lineTo(baseX + w, topY + 9 * d);
    ctx.lineTo(baseX - sideW, topY + 9 * d);
  }
  ctx.closePath();
  ctx.fill();

  // 顶板前沿高光
  ctx.fillStyle = "rgba(255, 230, 180, 0.18)";
  ctx.beginPath();
  if (facing === "right") {
    ctx.moveTo(baseX, topY + 8 * d);
    ctx.lineTo(baseX + w + sideW, topY + 8 * d);
    ctx.lineTo(baseX + w + sideW, topY + 9 * d);
    ctx.lineTo(baseX, topY + 9 * d);
  } else {
    ctx.moveTo(baseX - sideW, topY + 8 * d);
    ctx.lineTo(baseX + w, topY + 8 * d);
    ctx.lineTo(baseX + w, topY + 9 * d);
    ctx.lineTo(baseX - sideW, topY + 9 * d);
  }
  ctx.closePath();
  ctx.fill();

  // === 正面柜身 ===
  ctx.fillStyle = "#6a4a30";
  ctx.fillRect(baseX, topY + 8 * d, w, h - 8 * d);

  // 正面木纹（垂直细条）
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(baseX + (w * (i + 1)) / 5, topY + 9 * d, 1, h - 9 * d);
  }

  // === 5 层书架隔板与书本 ===
  const layers = 5;
  const usableH = h - 14 * d;
  const layerH = usableH / layers;
  const bookColors = [
    "#c2410c",
    "#1d4ed8",
    "#15803d",
    "#a16207",
    "#7e22ce",
    "#0e7490",
    "#be123c",
    "#374151",
  ];

  for (let i = 0; i < layers; i++) {
    const layerY = topY + 10 * d + i * layerH;

    // 隔板（深色顶沿 + 浅色厚度）
    ctx.fillStyle = "#3a2616";
    ctx.fillRect(baseX + 2 * d, layerY, w - 4 * d, 2 * d);
    ctx.fillStyle = "#8b6a3a";
    ctx.fillRect(baseX + 2 * d, layerY + 2 * d, w - 4 * d, 1);

    // 内格凹陷
    ctx.fillStyle = "#3a2616";
    ctx.fillRect(baseX + 3 * d, layerY + 3 * d, w - 6 * d, layerH - 5 * d);

    if (i === 0) {
      // 顶层放绿植（中央）
      const plantX = baseX + w * 0.5;
      const plantY = layerY + 3 * d;
      const plantH = layerH - 5 * d;
      ctx.fillStyle = "#3f6212";
      ctx.fillRect(plantX - 4 * d, plantY + 1 * d, 8 * d, plantH - 4 * d);
      ctx.fillStyle = "#65a30d";
      ctx.fillRect(plantX - 3 * d, plantY, 6 * d, plantH - 6 * d);
      ctx.fillStyle = "#a3a3a3";
      ctx.fillRect(plantX - 3 * d, plantY + plantH - 4 * d, 6 * d, 3 * d);
      // 旁边放一本横置的厚书
      ctx.fillStyle = "#a16207";
      ctx.fillRect(baseX + 4 * d, plantY + plantH - 5 * d, 12 * d, 3 * d);
      ctx.fillStyle = "#fef3c7";
      ctx.fillRect(baseX + 4 * d, plantY + plantH - 5 * d, 12 * d, 1);
    } else {
      // 其它层：3-5 本随机高矮书脊
      const bookCount = 3 + ((i * 7) % 3);
      const innerX = baseX + 4 * d;
      const innerW = w - 8 * d;
      const bookSlotW = innerW / bookCount;
      for (let b = 0; b < bookCount; b++) {
        const bx = innerX + b * bookSlotW + 1;
        const bw = bookSlotW - 2;
        const color = bookColors[(i * 13 + b * 5) % bookColors.length]!;
        // 书脊不同高度
        const heightFactor = 0.78 + (((i * 5 + b * 3) % 4) * 0.06);
        const bh = (layerH - 5 * d) * heightFactor;
        const by = layerY + 3 * d + ((layerH - 5 * d) - bh);
        ctx.fillStyle = color;
        ctx.fillRect(bx, by, bw, bh);
        // 高光
        ctx.fillStyle = "rgba(255,255,255,0.22)";
        ctx.fillRect(bx, by, 1, bh);
        // 底阴影
        ctx.fillStyle = "rgba(0,0,0,0.3)";
        ctx.fillRect(bx, by + bh - 1, bw, 1);
        // 书名横纹（每隔一本）
        if (b % 2 === 0 && bh > 16 * d) {
          ctx.fillStyle = "#fef3c7";
          ctx.fillRect(bx + 1, by + bh * 0.35, bw - 2, 1);
        }
      }
    }
  }

  // 柜底踢脚（深色细条）
  ctx.fillStyle = "#2a1a0e";
  ctx.fillRect(baseX, topY + h - 3 * d, w, 3 * d);
}

/**
 * 程序化透视机架 V2 —— 黑色金属机柜，5 层服务器，每层带状态 LED。
 *
 * 同样有顶板透视 + 侧面厚度 + 正面层叠的结构。
 */
export function drawRackPerspective(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  depth: number,
  facing: "left" | "right",
  now: number
): void {
  const d = depthScale(depth);
  const w = 60 * d;
  const h = 108 * d;
  const sideW = 9 * d;
  const baseX = x - w / 2;
  const topY = y - h;
  const sign = facing === "right" ? 1 : -1;

  drawDropShadow(ctx, x + sign * sideW * 0.4, y + 2 * d, (w + sideW) * 0.85, 6 * d, 0.32);

  // 侧面（深金属）
  ctx.fillStyle = "#0f172a";
  ctx.beginPath();
  if (facing === "right") {
    ctx.moveTo(baseX + w, topY + 5 * d);
    ctx.lineTo(baseX + w + sideW, topY + 9 * d);
    ctx.lineTo(baseX + w + sideW * 0.7, topY + h);
    ctx.lineTo(baseX + w, topY + h);
  } else {
    ctx.moveTo(baseX, topY + 5 * d);
    ctx.lineTo(baseX - sideW, topY + 9 * d);
    ctx.lineTo(baseX - sideW * 0.7, topY + h);
    ctx.lineTo(baseX, topY + h);
  }
  ctx.closePath();
  ctx.fill();

  // 侧面金属高光（顶部一条窄亮线）
  ctx.fillStyle = "rgba(100, 116, 139, 0.5)";
  ctx.beginPath();
  if (facing === "right") {
    ctx.moveTo(baseX + w, topY + 5 * d);
    ctx.lineTo(baseX + w + sideW, topY + 9 * d);
    ctx.lineTo(baseX + w + sideW * 0.95, topY + 10 * d);
    ctx.lineTo(baseX + w, topY + 6 * d);
  } else {
    ctx.moveTo(baseX, topY + 5 * d);
    ctx.lineTo(baseX - sideW, topY + 9 * d);
    ctx.lineTo(baseX - sideW * 0.95, topY + 10 * d);
    ctx.lineTo(baseX, topY + 6 * d);
  }
  ctx.closePath();
  ctx.fill();

  // 顶板
  ctx.fillStyle = "#1e293b";
  ctx.beginPath();
  if (facing === "right") {
    ctx.moveTo(baseX + 2 * d, topY);
    ctx.lineTo(baseX + w, topY);
    ctx.lineTo(baseX + w + sideW, topY + 9 * d);
    ctx.lineTo(baseX, topY + 9 * d);
  } else {
    ctx.moveTo(baseX, topY);
    ctx.lineTo(baseX + w - 2 * d, topY);
    ctx.lineTo(baseX + w, topY + 9 * d);
    ctx.lineTo(baseX - sideW, topY + 9 * d);
  }
  ctx.closePath();
  ctx.fill();

  // 顶板散热孔（5 个圆点）
  ctx.fillStyle = "#0f172a";
  for (let i = 0; i < 5; i++) {
    const cx = baseX + 6 * d + i * (w / 5);
    ctx.beginPath();
    ctx.arc(cx, topY + 4 * d, 1.2 * d, 0, Math.PI * 2);
    ctx.fill();
  }

  // 正面机柜
  ctx.fillStyle = "#1e293b";
  ctx.fillRect(baseX, topY + 8 * d, w, h - 8 * d);

  // 正面金属边框（左右）
  ctx.fillStyle = "#334155";
  ctx.fillRect(baseX, topY + 8 * d, 2 * d, h - 11 * d);
  ctx.fillRect(baseX + w - 2 * d, topY + 8 * d, 2 * d, h - 11 * d);

  // 5 层服务器 unit
  const units = 5;
  const usableH = h - 14 * d;
  const unitH = usableH / units;
  const blink = Math.floor(now / 600);
  const ledColors = ["#22c55e", "#38bdf8", "#fbbf24", "#a855f7", "#f87171"];

  for (let i = 0; i < units; i++) {
    const uy = topY + 10 * d + i * unitH;
    const innerX = baseX + 3 * d;
    const innerW = w - 6 * d;

    // 单元面板（更深底色）
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(innerX, uy + 1 * d, innerW, unitH - 3 * d);

    // 顶沿金属高光
    ctx.fillStyle = "#475569";
    ctx.fillRect(baseX + 2 * d, uy, w - 4 * d, 1);

    // 散热栅栏（横向细线，模拟 server unit 通风口）
    ctx.fillStyle = "rgba(100, 116, 139, 0.45)";
    for (let g = 0; g < Math.max(2, Math.floor(unitH / (3 * d))); g++) {
      ctx.fillRect(innerX + 3 * d, uy + 3 * d + g * 3 * d, innerW - 22 * d, 1);
    }

    // 左侧：电源指示 LED 2 个
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(innerX + 2 * d, uy + 3 * d, 2 * d, 2 * d);
    ctx.fillStyle = (blink + i) % 3 === 0 ? "#fbbf24" : "#1e293b";
    ctx.fillRect(innerX + 2 * d, uy + 7 * d, 2 * d, 2 * d);

    // 右侧：状态 LED 排（5 颗，呼吸闪烁）
    for (let l = 0; l < 5; l++) {
      const lit = (blink + i * 3 + l) % 4 !== 0;
      ctx.fillStyle = lit ? ledColors[l % ledColors.length]! : "#1e293b";
      ctx.fillRect(innerX + innerW - 14 * d + l * 3 * d, uy + 4 * d, 2 * d, 2 * d);
    }

    // 右下小屏幕（mini display）
    if (unitH > 18 * d) {
      ctx.fillStyle = "#1e3a5f";
      ctx.fillRect(innerX + innerW - 14 * d, uy + 8 * d, 12 * d, 4 * d);
      ctx.fillStyle = blink % 2 ? "#38bdf8" : "#7dd3fc";
      ctx.fillRect(innerX + innerW - 13 * d, uy + 9 * d, 5 * d, 1);
      ctx.fillRect(innerX + innerW - 13 * d, uy + 10 * d, 8 * d, 1);
    }
  }

  // 柜底踢脚 + 万向轮
  ctx.fillStyle = "#020617";
  ctx.fillRect(baseX, topY + h - 3 * d, w, 3 * d);
  ctx.fillStyle = "#334155";
  ctx.fillRect(baseX + 3 * d, topY + h - 2 * d, 4 * d, 2 * d);
  ctx.fillRect(baseX + w - 7 * d, topY + h - 2 * d, 4 * d, 2 * d);
}

export function drawDeskLampForWorkstation(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  depth: number,
  active: boolean,
  now: number
) {
  // 桌面台面约在 y - 8*depthScale（与 monitorBaseY 对齐），台灯比桌面再高 6px
  drawDeskLamp(ctx, x + 22 * depthScale(depth), y - 14 * depthScale(depth), depth, active, now);
}

/**
 * 按 role hash 在每张桌上放 1-2 件桌面小物（Folders/Books/Papers），偶尔加 Bin 在桌旁地面。
 * 完全确定性：同一个 role 永远摆同样的物件 → 每只猫的工位有自己的"个性"。
 * Atlas 未加载时静默 fallback（不画）——零成本影响。
 *
 * 桌面坐标系：drawWorkstation 调用前定位锚点 (x, y)，其中:
 *   - x 是工位水平中心
 *   - y 是桌底 / 椅子坐姿基准
 *   - 桌面台面约在 y - 28 * depthScale(depth)（与显示器底座等高）
 */
type DeskTrinket = "pen-cup" | "water-cup" | "frame" | "plant-mini" | "hub";

/**
 * 程序化绘制桌面小物件。比 sprite-based Folders/Books 更精致：
 *   - pen-cup    深色笔筒 + 4 支不同颜色的笔
 *   - water-cup  陶瓷马克杯 + 茶水 + 摇摆蒸汽
 *   - frame      黑色相框 + 内画一颗小心心（生活气）
 *   - plant-mini 微型多肉（陶盆 + 多层绿叶）
 *   - hub        USB 集线器 + 3 颗呼吸 LED
 *
 * 锚点 (x, y) 位于物件正下方接触桌面的中心。
 */
function drawDeskTrinket(
  ctx: CanvasRenderingContext2D,
  kind: DeskTrinket,
  x: number,
  y: number,
  depth: number,
  now: number
): void {
  const d = depthScale(depth);
  drawDropShadow(ctx, x, y, 8 * d, Math.max(2, 2 * d), 0.32);

  switch (kind) {
    case "pen-cup": {
      ctx.fillStyle = "#1f2937";
      ctx.fillRect(x - 4 * d, y - 10 * d, 8 * d, 10 * d);
      ctx.fillStyle = "#374151";
      ctx.fillRect(x - 4 * d, y - 10 * d, 8 * d, 1);
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillRect(x - 4 * d, y - 10 * d, 1, 10 * d);
      const pens = ["#dc2626", "#2563eb", "#16a34a", "#facc15"];
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = pens[i]!;
        ctx.fillRect(x - 3 * d + i * 2 * d, y - (14 + i) * d, 1, (5 + i) * d);
      }
      break;
    }
    case "water-cup": {
      ctx.fillStyle = "#f8fafc";
      ctx.fillRect(x - 4 * d, y - 11 * d, 7 * d, 11 * d);
      ctx.fillStyle = "#e2e8f0";
      ctx.fillRect(x - 4 * d, y - 11 * d, 7 * d, 1);
      ctx.fillStyle = "#7c2d12";
      ctx.fillRect(x - 3 * d, y - 10 * d, 5 * d, 2 * d);
      ctx.fillStyle = "#cbd5e1";
      ctx.fillRect(x + 3 * d, y - 9 * d, 1, 4 * d);
      const sway = Math.round(Math.sin(now / 400) * d);
      ctx.fillStyle = "rgba(220,230,240,0.55)";
      ctx.fillRect(x - 2 * d + sway, y - 14 * d, 1, 2 * d);
      ctx.fillRect(x + 1 * d - sway, y - 14 * d, 1, 2 * d);
      break;
    }
    case "frame": {
      ctx.fillStyle = "#1f2937";
      ctx.fillRect(x - 5 * d, y - 10 * d, 10 * d, 9 * d);
      ctx.fillStyle = "#fef3c7";
      ctx.fillRect(x - 4 * d, y - 9 * d, 8 * d, 7 * d);
      ctx.fillStyle = "#dc2626";
      ctx.fillRect(x - 1 * d, y - 7 * d, 1, 1);
      ctx.fillRect(x + 1 * d, y - 7 * d, 1, 1);
      ctx.fillRect(x - 2 * d, y - 6 * d, 5 * d, 1);
      ctx.fillRect(x - 1 * d, y - 5 * d, 3 * d, 1);
      ctx.fillRect(x, y - 4 * d, 1, 1);
      break;
    }
    case "plant-mini": {
      ctx.fillStyle = "#7c2d12";
      ctx.fillRect(x - 3 * d, y - 4 * d, 6 * d, 4 * d);
      ctx.fillStyle = "#92400e";
      ctx.fillRect(x - 3 * d, y - 4 * d, 6 * d, 1);
      ctx.fillStyle = "#166534";
      ctx.fillRect(x - 3 * d, y - 9 * d, 6 * d, 5 * d);
      ctx.fillStyle = "#22c55e";
      ctx.fillRect(x - 2 * d, y - 11 * d, 4 * d, 3 * d);
      ctx.fillStyle = "#4ade80";
      ctx.fillRect(x - 1 * d, y - 12 * d, 2 * d, 1);
      break;
    }
    case "hub": {
      ctx.fillStyle = "#27272a";
      ctx.fillRect(x - 5 * d, y - 4 * d, 10 * d, 3 * d);
      ctx.fillStyle = "#3f3f46";
      ctx.fillRect(x - 5 * d, y - 4 * d, 10 * d, 1);
      const blink = Math.floor(now / 700);
      const colors = ["#22c55e", "#38bdf8", "#facc15"];
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = (blink + i) % 3 === 0 ? colors[i]! : "#27272a";
        ctx.fillRect(x - 3 * d + i * 3 * d, y - 3 * d, 1, 1);
      }
      break;
    }
  }
}

export function drawDeskDressing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  depth: number,
  role: string,
  now = 0
): void {
  ensureActiveAtlasLoaded();
  const atlas = getActiveAtlasSync();
  if (!atlas) return;

  let seed = 2166136261 >>> 0;
  for (let i = 0; i < role.length; i++) {
    seed = (seed ^ role.charCodeAt(i)) >>> 0;
    seed = Math.imul(seed, 16777619) >>> 0;
  }
  const pick = (n: number) => {
    seed = (Math.imul(seed, 16777619) ^ 0x9e3779b9) >>> 0;
    return seed % n;
  };
  const chance = (pct: number) => pick(100) < pct;

  const d = depthScale(depth);
  const deskTopY = y - 10; // 与显示器底座 / 桌面平齐
  const leftX = x - 26 * d;
  const rightX = x + 26 * d;

  // 主桌面物件：左右各 1 件，按 role hash 决定是 sprite 还是程序化 trinket
  const leftTrinkets: DeskTrinket[] = ["pen-cup", "frame", "plant-mini"];
  const rightTrinkets: DeskTrinket[] = ["water-cup", "hub", "pen-cup"];
  const spriteLeft = ["Folders", "Folders-2", "Books", "Papers"];
  const spriteRight = ["Books", "Papers", "Folders", "Folders-2"];

  // 60% sprite + 40% trinket，让画面既保留 sprite 风格又有程序化精度
  if (chance(60)) {
    const item = spriteLeft[pick(spriteLeft.length)]!;
    drawThemedFurniture(ctx, atlas, item, leftX, deskTopY, depth, {
      scaleMul: 0.55,
      shadowW: 14 * d,
    });
  } else {
    drawDeskTrinket(ctx, leftTrinkets[pick(leftTrinkets.length)]!, leftX, deskTopY, depth, now);
  }
  if (chance(60)) {
    const item = spriteRight[pick(spriteRight.length)]!;
    drawThemedFurniture(ctx, atlas, item, rightX, deskTopY, depth, {
      scaleMul: 0.55,
      shadowW: 14 * d,
    });
  } else {
    drawDeskTrinket(ctx, rightTrinkets[pick(rightTrinkets.length)]!, rightX, deskTopY, depth, now);
  }

  // 偶尔（25%）加 Bin 在桌子右下角地面（不阻挡 pathfinding，因桌椅本身已是障碍）
  if (chance(25)) {
    drawThemedFurniture(ctx, atlas, "Bin", x + 36 * d, y + 4 * d, depth, {
      scaleMul: 0.62,
      shadowW: 12 * d,
    });
  }
}
