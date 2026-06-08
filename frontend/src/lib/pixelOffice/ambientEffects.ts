/**
 * 环境特效：背光尘粒、键盘波纹、雨天、台灯光晕。
 * 全部基于 ctx 2D 绘制（与现有渲染管线兼容），由每帧 paint 调用。
 *
 * 设计原则：
 * - 尘粒是稳定的全局粒子池（不依赖 React state）
 * - 主题感知：夜间主题禁用尘粒、启用雨；白天反之
 * - 工位特效按需触发（work / chat_send 时启动）
 */

import { depthScale, type OfficePerspective } from "./officePerspective";
import { getActiveTheme } from "./themes";

type DustParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  twinkle: number;
};

let dustPool: DustParticle[] | null = null;
let lastInitDims = { w: 0, h: 0 };

const DUST_COUNT = 36;

function ensureDust(w: number, h: number): DustParticle[] {
  if (dustPool && lastInitDims.w === w && lastInitDims.h === h) return dustPool;
  dustPool = [];
  for (let i = 0; i < DUST_COUNT; i++) {
    dustPool.push({
      x: Math.random() * w,
      y: Math.random() * h * 0.85,
      vx: (Math.random() - 0.5) * 0.18,
      vy: -Math.random() * 0.12 - 0.04,
      size: Math.random() < 0.65 ? 1 : 2,
      alpha: 0.18 + Math.random() * 0.32,
      twinkle: Math.random() * Math.PI * 2,
    });
  }
  lastInitDims = { w, h };
  return dustPool;
}

/** 在天花板/窗户区域漂浮的背光尘粒（仅白天/暖橙主题） */
export function drawDustParticles(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  now: number
): void {
  const theme = getActiveTheme();
  const dust = ensureDust(w, h);
  ctx.save();
  for (const p of dust) {
    p.x += p.vx;
    p.y += p.vy;
    if (p.x < -2) p.x = w + 2;
    if (p.x > w + 2) p.x = -2;
    if (p.y < -2) {
      p.y = h * 0.85;
      p.x = Math.random() * w;
    }
    const tw = 0.7 + Math.sin(now / 700 + p.twinkle) * 0.3;
    const a = p.alpha * tw;
    ctx.fillStyle =
      theme.id === "cozy" ? `rgba(255, 230, 180, ${a})` : `rgba(255, 248, 220, ${a})`;
    ctx.fillRect(Math.floor(p.x), Math.floor(p.y), p.size, p.size);
  }
  ctx.restore();
}

/** v2 暂无内置 night 主题；保留 stub 以维持调用点签名稳定。 */
export function drawRain(
  _ctx: CanvasRenderingContext2D,
  _w: number,
  _windowH: number,
  _now: number,
): void {
  /* no-op */
}

/** 工位 work 时的键盘波纹（蓝色同心弧） */
export function drawWorkRipple(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  depth: number,
  now: number,
  intensity = 1
): void {
  const d = depthScale(depth);
  const tCycle = (now % 1400) / 1400;
  ctx.save();
  for (let i = 0; i < 2; i++) {
    const t = (tCycle + i * 0.5) % 1;
    const r = 6 * d + t * 18 * d;
    const a = (1 - t) * 0.25 * intensity;
    ctx.strokeStyle = `rgba(125, 211, 252, ${a})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(x, y + 4 * d, r, r * 0.4, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** 强化的台灯光晕（主题亮度感知） */
export function drawDeskLampBloom(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  depth: number,
  now: number
): void {
  const filter = getActiveTheme().filter;
  const bloom = filter.bloom ?? 1;
  const d = depthScale(depth);
  const pulse = 0.78 + Math.sin(now / 540) * 0.22;
  const radius = 56 * d * bloom;
  const grd = ctx.createRadialGradient(x, y - 14 * d, 0, x, y - 4 * d, radius);
  grd.addColorStop(0, `rgba(253, 224, 71, ${0.42 * pulse * bloom})`);
  grd.addColorStop(0.45, `rgba(253, 224, 71, ${0.16 * pulse * bloom})`);
  grd.addColorStop(1, "rgba(253, 224, 71, 0)");
  ctx.save();
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.ellipse(x, y - 6 * d, radius, radius * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 屏幕 bloom：所有非 idle 屏幕的环境投光（主题 bloom 倍率感知） */
export function drawScreenBloom(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  depth: number,
  mode: string,
  now: number
): void {
  if (mode === "idle") return;
  const filter = getActiveTheme().filter;
  const bloom = filter.bloom ?? 1;
  const colors: Record<string, string> = {
    chat: "#7dd3fc",
    code: "#86efac",
    mcp: "#4ade80",
    skill: "#fbbf24",
    sandbox: "#22d3ee",
    ok: "#86efac",
    err: "#f87171",
    empty: "#fde68a",
  };
  const c = colors[mode] ?? "#94a3b8";
  const d = depthScale(depth);
  const pulse = 0.55 + Math.sin(now / 320) * 0.3;
  const r = 42 * d * bloom;
  const grd = ctx.createRadialGradient(x, y - 18 * d, 0, x, y - 18 * d, r);
  grd.addColorStop(0, hexToRgba(c, 0.32 * pulse * bloom));
  grd.addColorStop(0.55, hexToRgba(c, 0.12 * pulse * bloom));
  grd.addColorStop(1, hexToRgba(c, 0));
  ctx.save();
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.ellipse(x, y - 18 * d, r, r * 0.65, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 工位的"工作中"复合特效（结合波纹 + bloom），由 paint 在 work/chat 时调用 */
export function drawWorkstationAmbient(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  depth: number,
  screenMode: string,
  now: number,
  isWorking: boolean
): void {
  drawScreenBloom(ctx, x, y, depth, screenMode, now);
  if (isWorking) {
    drawWorkRipple(ctx, x, y, depth, now, screenMode === "code" ? 1.3 : 1);
  }
}

/** 全局环境层（dust + rain）：每帧调一次，由 paint 在最末位（UI 之前）调用 */
export function drawAmbientLayer(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  persp: OfficePerspective | null,
  now: number
): void {
  drawDustParticles(ctx, w, h, now);
  if (persp) drawRain(ctx, w, persp.windowH, now);
}

/** 测试 / 主题切换时重置粒子池 */
export function resetAmbientEffects(): void {
  dustPool = null;
  lastInitDims = { w: 0, h: 0 };
}
