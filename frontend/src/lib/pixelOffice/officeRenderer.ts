import type { AtlasSprites } from "./spriteAtlas";
import { blitSprite, drawMonitorSprite } from "./spriteAtlas";
import { getRenderConfig } from "./config";
import { computeOfficePerspective, depthScale, drawDeskFloorShadow } from "./officePerspective";
import { getPixelOfficeRegistry } from "./runtime";
import type { CatAction, CatActor, ChatBeam, CitySkyline, DeskSlot, OfficeLayout, Particle, ScreenMode } from "./types";

function scales(depth = 0.5) {
  const c = getRenderConfig();
  const d = depthScale(depth);
  return {
    cat: c.catScale * d,
    desk: c.deskScale * d,
    furniture: c.furnitureScale * d,
    monitor: c.monitorScale * d,
  };
}

function getAtlas(): AtlasSprites {
  const reg = getPixelOfficeRegistry();
  return reg.getSpriteProvider().getAtlas() as AtlasSprites;
}

export function screenModeForAction(action: CatAction, label?: string): ScreenMode {
  switch (action) {
    case "chat_send":
    case "chat_recv":
      return "chat";
    case "mcp":
    case "at_rack":
      return "mcp";
    case "skill":
    case "at_shelf":
      return "skill";
    case "sandbox":
      return "sandbox";
    case "tool":
    case "builtin":
      return "code";
    case "success":
      return "ok";
    case "fail":
      return "err";
    case "success_empty":
      return "empty";
    default:
      return label?.includes("terminal") ? "sandbox" : "idle";
  }
}

function catSpriteRect(atlas: AtlasSprites, cat: CatActor) {
  const b = cat.breed;
  if (cat.action === "walk") {
    return cat.frame % 2 === 0 ? atlas.catWalk1[b] : atlas.catWalk2[b];
  }
  if (cat.action === "success") return atlas.catSuccess[b];
  if (cat.action === "fail") return atlas.catFail[b];
  if (cat.action === "success_empty") return atlas.catEmpty[b];
  if (
    ["tool", "mcp", "skill", "sandbox", "builtin", "at_rack", "at_shelf", "chat_send"].includes(cat.action)
  ) {
    return atlas.catWork[b];
  }
  return atlas.catIdle[b];
}

export function drawOfficeScene(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  city: CitySkyline,
  layout: OfficeLayout,
  now: number,
  isRunning = false
) {
  const reg = getPixelOfficeRegistry();
  const bg = reg.getSceneBackgroundRenderer();
  if (bg) bg(ctx, w, h, city, now);

  const atlas = getAtlas();

  const persp = computeOfficePerspective(w, h, layout.windowH);
  const drawFurniture = (slot: DeskSlot, rect: AtlasSprites["shelf"], label: string, labelDy: number) => {
    const sc = scales(slot.depth).furniture;
    const dx = slot.x - (rect.w * sc) / 2;
    const dy = slot.y - rect.h * sc + 8;
    drawDeskFloorShadow(ctx, slot.x, slot.y, rect.w * sc, 12, persp);
    blitSprite(ctx, atlas, rect, dx, dy, sc);
    ctx.fillStyle = "#94a3b8";
    ctx.font = `${Math.max(9, Math.floor(11 * depthScale(slot.depth)))}px monospace`;
    ctx.textAlign = "center";
    ctx.fillText(label, slot.x, slot.y + labelDy * depthScale(slot.depth));
  };

  drawFurniture(layout.shelf, atlas.shelf, "技能书架", 42);
  drawFurniture(layout.rack, atlas.rack, "MCP / 工具机架", 46);

  for (const layer of reg.getOverlays()) {
    layer.render(ctx, { width: w, height: h, now, cityId: city, isRunning });
  }
}

export function drawWorkstation(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  screenMode: ScreenMode,
  now: number,
  hot: boolean,
  selected: boolean,
  depth = 0.5,
  persp?: ReturnType<typeof computeOfficePerspective>
) {
  const atlas = getAtlas();
  const { desk, monitor } = scales(depth);
  const deskW = atlas.desk.w * desk;
  const deskH = atlas.desk.h * desk;

  if (persp) {
    drawDeskFloorShadow(ctx, x, y, deskW, deskH * 0.4, persp);
  }

  if (selected) {
    ctx.strokeStyle = "#60a5fa";
    ctx.lineWidth = 2;
    ctx.strokeRect(x - deskW / 2 - 10, y - deskH - 44, deskW + 20, deskH + 56);
  }
  if (hot) {
    ctx.fillStyle = "rgba(56, 189, 248, 0.1)";
    ctx.fillRect(x - deskW / 2 - 8, y - deskH - 42, deskW + 16, deskH + 52);
  }
  blitSprite(ctx, atlas, atlas.desk, x - deskW / 2, y - 10, desk);
  drawMonitorSprite(ctx, atlas, x, y - 26 * depthScale(depth), screenMode, now, monitor);
}

export function drawCatSprite(ctx: CanvasRenderingContext2D, cat: CatActor, now: number, depth?: number) {
  const atlas = getAtlas();
  const d = depth ?? cat.depth ?? 0.5;
  const { cat: catScale } = scales(d);
  const rect = catSpriteRect(atlas, cat);
  const bob =
    cat.action === "success"
      ? -Math.abs(Math.sin((now % 600) / 100)) * 4
      : cat.action === "fail"
        ? Math.sin((now % 200) / 50) * 3
        : 0;
  blitSprite(
    ctx,
    atlas,
    rect,
    cat.x - (rect.w * catScale) / 2,
    cat.y - rect.h * catScale + bob,
    catScale,
    cat.facing === -1
  );

  if (cat.bubble && cat.bubbleUntil && now < cat.bubbleUntil) {
    drawBubble(ctx, cat.x, cat.y - 48 * depthScale(d), cat.bubble, cat.facing);
  }
}

function drawBubble(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, facing: 1 | -1) {
  const label = text.length > 18 ? `${text.slice(0, 17)}…` : text;
  ctx.save();
  ctx.font = "11px monospace";
  const bw = ctx.measureText(label).width + 14;
  const bx = x + (facing === 1 ? 12 : -12 - bw);
  ctx.fillStyle = "rgba(15, 23, 42, 0.94)";
  ctx.strokeStyle = "#64748b";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(bx, y, bw, 20, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#e2e8f0";
  ctx.fillText(label, bx + 7, y + 14);
  ctx.restore();
}

export function drawRoleLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  role: string,
  selected: boolean,
  depth = 0.5
) {
  const fs = depthScale(depth);
  ctx.textAlign = "center";
  ctx.font = selected ? `bold ${Math.floor(12 * fs)}px system-ui,sans-serif` : `${Math.floor(11 * fs)}px system-ui,sans-serif`;
  ctx.fillStyle = selected ? "#93c5fd" : "#cbd5e1";
  const short = label.length > 14 ? `${label.slice(0, 13)}…` : label;
  ctx.fillText(short, x, y + 38 * fs);
  ctx.font = `${Math.floor(10 * fs)}px monospace`;
  ctx.fillStyle = "#64748b";
  ctx.fillText(role, x, y + 52 * fs);
}

export function drawChatBeam(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  now: number,
  until: number
) {
  const t = 1 - (until - now) / 2400;
  if (t < 0 || t > 1) return;
  const mx = ax + (bx - ax) * t;
  const my = ay + (by - ay) * t - 14;
  ctx.fillStyle = "#fbbf24";
  ctx.beginPath();
  ctx.arc(mx, my, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(251, 191, 36, 0.45)";
  ctx.setLineDash([5, 7]);
  ctx.beginPath();
  ctx.moveTo(ax, ay - 30);
  ctx.lineTo(bx, by - 30);
  ctx.stroke();
  ctx.setLineDash([]);
}

export function spawnParticles(particles: Particle[], x: number, y: number, kind: "ok" | "err" | "empty") {
  const color = kind === "ok" ? "#4ade80" : kind === "err" ? "#f87171" : "#fbbf24";
  const count = kind === "empty" ? 8 : 14;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * (1.4 + Math.random()),
      vy: Math.sin(angle) * (1.4 + Math.random()) - 1,
      life: 700 + Math.random() * 400,
      color,
      size: kind === "empty" ? 4 : 3 + Math.random() * 2,
    });
  }
}

export function tickParticles(particles: Particle[], dt: number): Particle[] {
  const next: Particle[] = [];
  for (const p of particles) {
    const life = p.life - dt;
    if (life <= 0) continue;
    next.push({ ...p, x: p.x + p.vx, y: p.y + p.vy, vy: p.vy + 0.04, life });
  }
  return next;
}

export function drawParticles(ctx: CanvasRenderingContext2D, particles: Particle[]) {
  for (const p of particles) {
    ctx.globalAlpha = Math.min(1, p.life / 500);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x, p.y, p.size, p.size);
  }
  ctx.globalAlpha = 1;
}

export function actionLabel(action: CatAction): string {
  const map: Partial<Record<CatAction, string>> = {
    chat_send: "对话",
    chat_recv: "倾听",
    mcp: "MCP",
    skill: "Skill",
    sandbox: "沙箱",
    builtin: "内置工具",
    tool: "工具",
    at_rack: "机架作业",
    at_shelf: "查阅技能",
    walk: "移动",
    success: "成功",
    fail: "失败",
    success_empty: "空结果",
    signal: "信号",
  };
  return map[action] ?? "待命";
}

export type { ChatBeam, AtlasSprites };
