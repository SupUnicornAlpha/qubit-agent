/** 一点透视：透视线汇聚于窗户底边两角 */
export type OfficePerspective = {
  w: number;
  h: number;
  windowH: number;
  /** 窗户左下角 X */
  winLeft: number;
  /** 窗户右下角 X */
  winRight: number;
  floorBack: number;
  floorFront: number;
  /** 与 winLeft/winRight 相同，供布局复用 */
  backLeft: number;
  backRight: number;
  ceilingY: number;
  vpX: number;
  vpY: number;
};

export type WindowQuad = {
  tl: { x: number; y: number };
  tr: { x: number; y: number };
  br: { x: number; y: number };
  bl: { x: number; y: number };
};

export function computeOfficePerspective(w: number, h: number, windowH: number): OfficePerspective {
  const floorFront = h - 36;
  const winMargin = 0.09;
  const winLeft = w * winMargin;
  const winRight = w * (1 - winMargin);
  const ceilingY = Math.max(8, Math.floor(windowH * 0.06));
  const floorBack = windowH + 4;
  return {
    w,
    h,
    windowH,
    winLeft,
    winRight,
    backLeft: winLeft,
    backRight: winRight,
    floorBack,
    floorFront,
    ceilingY,
    vpX: w / 2,
    vpY: windowH,
  };
}

/** 侧墙 X：从顶角连到窗户底角，再连到地面前沿 */
export function wallEdgeX(p: OfficePerspective, y: number, side: "left" | "right"): number {
  if (y >= p.windowH) return floorEdgeX(p, y, side);
  const cornerX = side === "left" ? p.winLeft : p.winRight;
  const topX = side === "left" ? 0 : p.w;
  const topY = p.ceilingY;
  if (y <= topY) return topX;
  const t = (y - topY) / (p.windowH - topY);
  return topX + (cornerX - topX) * t;
}

/** 后墙上的长方形窗户 */
export function computeWindowQuad(p: OfficePerspective): WindowQuad {
  const topY = p.ceilingY + 12;
  const bottomY = p.windowH;
  return {
    tl: { x: p.winLeft, y: topY },
    tr: { x: p.winRight, y: topY },
    bl: { x: p.winLeft, y: bottomY },
    br: { x: p.winRight, y: bottomY },
  };
}

function windowBounds(q: WindowQuad) {
  const xs = [q.tl.x, q.tr.x, q.bl.x, q.br.x];
  const ys = [q.tl.y, q.tr.y, q.bl.y, q.br.y];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { minX, minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

function clipWindowQuad(ctx: CanvasRenderingContext2D, q: WindowQuad) {
  ctx.beginPath();
  ctx.moveTo(q.tl.x, q.tl.y);
  ctx.lineTo(q.tr.x, q.tr.y);
  ctx.lineTo(q.br.x, q.br.y);
  ctx.lineTo(q.bl.x, q.bl.y);
  ctx.closePath();
  ctx.clip();
}

/** 地板左右边界：从窗户底角展开到镜头前缘 */
export function floorEdgeX(p: OfficePerspective, y: number, side: "left" | "right"): number {
  const cornerX = side === "left" ? p.winLeft : p.winRight;
  const frontX = side === "left" ? 0 : p.w;
  if (y <= p.windowH) return cornerX;
  const t = (y - p.windowH) / (p.floorFront - p.windowH);
  return cornerX + (frontX - cornerX) * t;
}

/** 纵深 0=窗户线 1=镜头前 */
export function depthAtY(p: OfficePerspective, y: number): number {
  if (p.floorFront <= p.windowH) return 0.5;
  return Math.max(0, Math.min(1, (y - p.windowH) / (p.floorFront - p.windowH)));
}

/** 根据纵深缩放精灵（远小近大） */
export function depthScale(depth: number): number {
  return 0.68 + depth * 0.38;
}

/** 透视网格 → 屏幕工位坐标（u/v 为 0–1，v 小=靠窗） */
export function perspectiveGridPosition(
  p: OfficePerspective,
  u: number,
  v: number
): { x: number; y: number; depth: number } {
  const y = p.windowH + (p.floorFront - p.windowH) * v;
  const lx = floorEdgeX(p, y, "left");
  const rx = floorEdgeX(p, y, "right");
  return { x: lx + (rx - lx) * u, y, depth: v };
}

/** 地板在纵深 v 处的可用宽度 */
export function floorWidthAtDepth(p: OfficePerspective, v: number): number {
  const y = p.windowH + (p.floorFront - p.windowH) * v;
  return floorEdgeX(p, y, "right") - floorEdgeX(p, y, "left");
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
  ctx.fillRect(Math.floor(x), Math.floor(y), Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)));
}

function drawWallPanel(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  baseRgb: [number, number, number],
  darker: boolean
) {
  const yMin = Math.min(y0, y1, y2, y3);
  const yMax = Math.max(y0, y1, y2, y3);
  for (let y = Math.floor(yMin); y < yMax; y++) {
    const edges: number[] = [];
    const pts = [
      [x0, y0],
      [x1, y1],
      [x2, y2],
      [x3, y3],
    ];
    for (let i = 0; i < 4; i++) {
      const [xa, ya] = pts[i]!;
      const [xb, yb] = pts[(i + 1) % 4]!;
      if ((ya <= y && yb > y) || (yb <= y && ya > y)) {
        const t = (y - ya) / (yb - ya);
        edges.push(xa + (xb - xa) * t);
      }
    }
    if (edges.length < 2) continue;
    edges.sort((a, b) => a - b);
    const lx = edges[0]!;
    const rx = edges[edges.length - 1]!;
    const t = (y - yMin) / Math.max(1, yMax - yMin);
    const shade = darker ? 0.78 - t * 0.12 : 0.88 - t * 0.08;
    const [r, g, b] = baseRgb;
    ctx.fillStyle = `rgb(${Math.floor(r * shade)}, ${Math.floor(g * shade)}, ${Math.floor(b * shade)})`;
    ctx.fillRect(Math.floor(lx), y, Math.ceil(rx - lx), 1);
    if (y % 18 === 0) {
      ctx.fillStyle = "rgba(0,0,0,0.08)";
      ctx.fillRect(Math.floor(lx), y, Math.ceil(rx - lx), 1);
    }
  }
}

function drawSideWalls(ctx: CanvasRenderingContext2D, p: OfficePerspective, win: WindowQuad) {
  const cy = p.ceilingY;

  drawWallPanel(ctx, 0, cy, win.tl.x, win.tl.y, win.bl.x, win.bl.y, 0, p.floorFront, [92, 82, 72], true);
  drawWallPanel(ctx, p.w, cy, win.tr.x, win.tr.y, win.br.x, win.br.y, p.w, p.floorFront, [88, 78, 68], true);

  const wainscotY = p.windowH + 28;
  for (let y = cy; y < win.tl.y; y++) {
    const lx = wallEdgeX(p, y, "left");
    const rx = wallEdgeX(p, y, "right");
    const t = (y - cy) / Math.max(1, win.tl.y - cy);
    const warm = y >= wainscotY;
    const [r, g, b] = warm
      ? [Math.floor(118 + t * 8), Math.floor(98 + t * 6), Math.floor(78 + t * 4)]
      : [Math.floor(148 + t * 10), Math.floor(138 + t * 8), Math.floor(122 + t * 6)];
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(lx, y, win.tl.x - lx, 1);
    ctx.fillRect(win.tr.x, y, rx - win.tr.x, 1);
  }

  for (let y = wainscotY; y < p.floorFront; y += 18) {
    const lx = wallEdgeX(p, y, "left");
    const rx = wallEdgeX(p, y, "right");
    ctx.fillStyle = "rgba(62, 39, 35, 0.18)";
    ctx.fillRect(lx, y, win.tl.x - lx, 1);
    ctx.fillRect(win.tr.x, y, rx - win.tr.x, 1);
  }
  // 注意：不再画水平木条 skirt board ——
  // 之前 fillRect(0, win.bl.y-2, win.tl.x, 5) 会画一条水平线从画面边缘延伸到窗户底角，
  // 视觉上像"窗户底沿向两侧延长出去"，破坏了侧墙的一点透视收敛。
  // 窗台正面的木条已经在 drawWindowSillRect 里画过了，这里删掉即可。
}

function drawPerspectiveFloor(ctx: CanvasRenderingContext2D, p: OfficePerspective) {
  const y0 = p.windowH;
  const tileStep = 10;

  for (let y = y0; y < p.floorFront; y++) {
    const lx = floorEdgeX(p, y, "left");
    const rx = floorEdgeX(p, y, "right");
    const rowW = rx - lx;
    const t = (y - y0) / (p.floorFront - y0);
    const cols = Math.max(6, Math.floor(8 + t * 6));
    const tileW = rowW / cols;
    const row = Math.floor(y / tileStep);
    for (let c = 0; c < cols; c++) {
      const even = (row + c) % 2 === 0;
      const [r, g, b] = even ? [212, 196, 168] : [196, 178, 148];
      const lift = Math.floor(t * 10);
      ctx.fillStyle = `rgb(${r + lift}, ${g + lift}, ${b + lift})`;
      ctx.fillRect(lx + c * tileW, y, tileW + 1, 1);
    }
  }

  for (let y = y0; y < p.floorFront; y += tileStep * 2) {
    const lx = floorEdgeX(p, y, "left");
    const rx = floorEdgeX(p, y, "right");
    ctx.fillStyle = "rgba(62, 39, 35, 0.08)";
    ctx.fillRect(lx, y, rx - lx, 1);
  }

  const gridN = 10;
  const frontL = floorEdgeX(p, p.floorFront, "left");
  const frontR = floorEdgeX(p, p.floorFront, "right");
  for (let i = 0; i <= gridN; i++) {
    const t = i / gridN;
    const bx = p.winLeft + (p.winRight - p.winLeft) * t;
    const fx = frontL + (frontR - frontL) * t;
    ctx.strokeStyle = "rgba(93, 64, 55, 0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx, y0);
    ctx.lineTo(fx, p.floorFront);
    ctx.stroke();
  }
}

function drawCenterCarpet(ctx: CanvasRenderingContext2D, p: OfficePerspective) {
  const rows = 12;
  for (let i = 0; i < rows; i++) {
    const t0 = i / rows;
    const t1 = (i + 1) / rows;
    const y0 = p.windowH + (p.floorFront - p.windowH) * t0;
    const y1 = p.windowH + (p.floorFront - p.windowH) * t1;
    const lx0 = floorEdgeX(p, y0, "left");
    const rx0 = floorEdgeX(p, y0, "right");
    const w0 = rx0 - lx0;
    const cx0 = (lx0 + rx0) / 2;
    const carpetW0 = w0 * (0.18 + t0 * 0.14);
    const lx1 = floorEdgeX(p, y1, "left");
    const rx1 = floorEdgeX(p, y1, "right");
    const w1 = rx1 - lx1;
    const cx1 = (lx1 + rx1) / 2;
    const carpetW1 = w1 * (0.18 + t1 * 0.14);
    ctx.fillStyle = i % 2 === 0 ? "#e8dcc8" : "#ddd0bc";
    ctx.beginPath();
    ctx.moveTo(cx0 - carpetW0 / 2, y0);
    ctx.lineTo(cx0 + carpetW0 / 2, y0);
    ctx.lineTo(cx1 + carpetW1 / 2, y1);
    ctx.lineTo(cx1 - carpetW1 / 2, y1);
    ctx.closePath();
    ctx.fill();
    if (i === 0) {
      ctx.strokeStyle = "rgba(93, 64, 55, 0.3)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function drawCeiling(ctx: CanvasRenderingContext2D, p: OfficePerspective, win: WindowQuad, now: number) {
  const cy = p.ceilingY;
  ctx.fillStyle = "#252b38";
  ctx.beginPath();
  ctx.moveTo(0, cy);
  ctx.lineTo(p.w, cy);
  ctx.lineTo(win.tr.x, win.tr.y);
  ctx.lineTo(win.tl.x, win.tl.y);
  ctx.closePath();
  ctx.fill();

  const blink = Math.floor(now / 900) % 2 === 0;
  const midY = cy + (win.tl.y - cy) * 0.55;
  const lx = wallEdgeX(p, midY, "left") + 24;
  const rx = wallEdgeX(p, midY, "right") - 72;
  const span = Math.max(40, rx - lx);
  const tubes = 4;
  for (let i = 0; i < tubes; i++) {
    const tx = lx + (span * i) / (tubes - 1 || 1);
    px(ctx, tx, midY, 40, 5, "#5a5868");
    px(ctx, tx + 2, midY + 1, 36, 3, blink ? "#e8f4ff" : "#b8c8d8");
  }
}

function drawWindowSillRect(ctx: CanvasRenderingContext2D, q: WindowQuad) {
  const sillH = 10;
  ctx.fillStyle = "#4a5568";
  ctx.fillRect(q.bl.x - 4, q.bl.y, q.br.x - q.bl.x + 8, sillH);
  ctx.fillStyle = "#5c6a7c";
  ctx.fillRect(q.bl.x - 2, q.bl.y + 2, q.br.x - q.bl.x + 4, 5);

  const pw = q.br.x - q.bl.x;
  px(ctx, q.bl.x + pw * 0.06, q.bl.y + 8, 10, 12, "#4a7c59");
  px(ctx, q.bl.x + pw * 0.08, q.bl.y + 5, 7, 7, "#6aad78");
  px(ctx, q.br.x - pw * 0.12, q.bl.y + 8, 8, 10, "#8b6914");
  px(ctx, q.br.x - pw * 0.1, q.bl.y + 6, 5, 5, "#c49a2a");
}

/** 透视窗框 + 外景（skyline 由 registry 绘制） */
export function drawPerspectiveWindow(
  ctx: CanvasRenderingContext2D,
  _p: OfficePerspective,
  q: WindowQuad,
  drawSkyline: (ox: number, oy: number, areaW: number, areaH: number) => void
) {
  const { minX, minY, w: bw, h: bh } = windowBounds(q);

  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.beginPath();
  ctx.moveTo(q.tl.x + 5, q.tl.y + 5);
  ctx.lineTo(q.tr.x + 5, q.tr.y + 5);
  ctx.lineTo(q.br.x + 5, q.br.y + 5);
  ctx.lineTo(q.bl.x + 5, q.bl.y + 5);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#0f1820";
  clipWindowQuad(ctx, q);
  drawSkyline(minX, minY, bw, bh);

  const vignette = ctx.createLinearGradient(0, minY, 0, minY + bh);
  vignette.addColorStop(0, "rgba(20,30,45,0.15)");
  vignette.addColorStop(0.55, "transparent");
  vignette.addColorStop(1, "rgba(10, 18, 28, 0.4)");
  ctx.fillStyle = vignette;
  ctx.fillRect(minX - 2, minY, bw + 4, bh + 2);
  ctx.restore();

  const frameW = 5;
  ctx.strokeStyle = "#5a6878";
  ctx.lineWidth = frameW;
  ctx.lineJoin = "miter";
  ctx.beginPath();
  ctx.moveTo(q.tl.x, q.tl.y);
  ctx.lineTo(q.tr.x, q.tr.y);
  ctx.lineTo(q.br.x, q.br.y);
  ctx.lineTo(q.bl.x, q.bl.y);
  ctx.closePath();
  ctx.stroke();

  ctx.strokeStyle = "#4a5868";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(q.tl.x + 3, q.tl.y + 3);
  ctx.lineTo(q.tr.x - 3, q.tr.y + 3);
  ctx.lineTo(q.br.x - 3, q.br.y - 3);
  ctx.lineTo(q.bl.x + 3, q.bl.y - 3);
  ctx.closePath();
  ctx.stroke();

  drawWindowSillRect(ctx, q);

  const mullionY = (q.tl.y + q.bl.y) / 2;
  const mx = (q.tl.x + q.tr.x) / 2;
  ctx.strokeStyle = "#5c6a7c";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(mx, mullionY);
  ctx.lineTo(mx, q.bl.y);
  ctx.stroke();
}

function drawWallDecor(ctx: CanvasRenderingContext2D, p: OfficePerspective, win: WindowQuad) {
  const wallY = p.windowH + 6;
  const lx = wallEdgeX(p, wallY + 20, "left");
  const rx = wallEdgeX(p, wallY + 20, "right");

  px(ctx, lx + 14, wallY + 12, 28, 28, "#2a3548");
  px(ctx, lx + 16, wallY + 14, 24, 22, "#3d4f68");
  px(ctx, lx + 24, wallY + 20, 8, 8, "#e8eef8");

  const bx = rx - 88;
  if (bx > win.tr.x + 16) {
    px(ctx, bx, wallY + 8, 72, 40, "#e8e4dc");
    px(ctx, bx + 4, wallY + 12, 64, 30, "#f8fafc");
    px(ctx, bx + 8, wallY + 16, 20, 3, "#3b82f6");
    px(ctx, bx + 8, wallY + 22, 28, 3, "#22c55e");
  }

  px(ctx, rx - 36, wallY + 4, 28, 48, "#dc2626");
  px(ctx, rx - 32, wallY + 8, 20, 36, "#ef4444");
}

function drawFloorDecor(ctx: CanvasRenderingContext2D, p: OfficePerspective, now: number) {
  const yNear = p.floorFront - 18;
  const lx = floorEdgeX(p, yNear, "left");
  px(ctx, lx + 12, yNear - 42, 36, 40, "#5c4a38");
  px(ctx, lx + 14, yNear - 40, 32, 36, "#6a5848");
  px(ctx, lx + 20, yNear - 52, 20, 18, "#4a7c59");
  px(ctx, lx + 22, yNear - 50, 16, 14, "#6aad78");

  const rx = floorEdgeX(p, yNear, "right");
  px(ctx, rx - 48, yNear - 50, 32, 48, "#c8d4e0");
  px(ctx, rx - 46, yNear - 48, 28, 8, "#94a3b8");
  px(ctx, rx - 44, yNear - 36, 24, 32, "#e2e8f0");
  px(ctx, rx - 40, yNear - 28, 8, 6, "#38bdf8");
  const drip = Math.floor(now / 400) % 3;
  if (drip > 0) px(ctx, rx - 38, yNear - 22 + drip, 4, 4, "#7dd3fc");

  const midY = p.windowH + (p.floorFront - p.windowH) * 0.55;
  const midL = floorEdgeX(p, midY, "left");
  px(ctx, midL + 8, midY - 22, 28, 20, "#4a4238");
  px(ctx, midL + 10, midY - 20, 24, 16, "#5c5048");
  px(ctx, midL + 16, midY - 26, 8, 8, "#f8fafc");
  px(ctx, midL + 17, midY - 24, 6, 4, "#38bdf8");

  const midR = floorEdgeX(p, midY, "right");
  px(ctx, midR - 36, midY - 28, 30, 26, "#3d3834");
  px(ctx, midR - 34, midY - 26, 26, 22, "#4a4540");
  px(ctx, midR - 28, midY - 32, 14, 10, "#64748b");
  px(ctx, midR - 26, midY - 30, 10, 6, "#1e293b");

  const cableY = p.windowH + 6;
  px(ctx, p.winLeft + 20, cableY, p.winRight - p.winLeft - 40, 5, "#2a3344");
  for (let i = 0; i < 5; i++) {
    px(ctx, p.winLeft + 28 + i * 10, cableY + 1, 6, 2, i % 2 ? "#4ade80" : "#22d3ee");
  }
}

function drawFrontBaseboard(ctx: CanvasRenderingContext2D, p: OfficePerspective) {
  ctx.fillStyle = "#5d4037";
  ctx.fillRect(0, p.floorFront, p.w, 34);
  for (let x = 0; x < p.w; x += 52) {
    ctx.fillStyle = "#6d5040";
    ctx.fillRect(x, p.floorFront, 32, 4);
  }
}

/** 绘制带一点透视的办公室室内（墙、地板、装饰；不含窗外景） */
export function drawOfficeInterior(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  windowH: number,
  now: number
) {
  const p = computeOfficePerspective(w, h, windowH);
  const win = computeWindowQuad(p);

  ctx.fillStyle = "#2a2520";
  ctx.fillRect(0, 0, w, h);

  drawCeiling(ctx, p, win, now);
  drawSideWalls(ctx, p, win);
  drawPerspectiveFloor(ctx, p);
  drawCenterCarpet(ctx, p);
  drawWallDecor(ctx, p, win);
  drawFloorDecor(ctx, p, now);
  drawFrontBaseboard(ctx, p);

  const shadowGrad = ctx.createLinearGradient(0, p.floorBack, 0, p.floorFront);
  shadowGrad.addColorStop(0, "transparent");
  shadowGrad.addColorStop(0.85, "transparent");
  shadowGrad.addColorStop(1, "rgba(0,0,0,0.2)");
  ctx.fillStyle = shadowGrad;
  const lx = floorEdgeX(p, p.floorFront - 1, "left");
  const rx = floorEdgeX(p, p.floorFront - 1, "right");
  ctx.fillRect(lx, p.windowH, rx - lx, p.floorFront - p.windowH);
}

/** 工位脚下的透视阴影 */
export function drawDeskFloorShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  persp: OfficePerspective
) {
  const sy = y + 6;
  if (sy < persp.windowH || sy > persp.floorFront) return;
  const t = (sy - persp.windowH) / (persp.floorFront - persp.windowH);
  const sw = w * (0.85 + t * 0.2);
  const sh = Math.max(4, h * (0.5 + t * 0.3));
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.beginPath();
  ctx.ellipse(x, sy, sw / 2, sh / 2, 0, 0, Math.PI * 2);
  ctx.fill();
}

export function getPerspectiveForLayout(w: number, h: number, windowH: number): OfficePerspective {
  return computeOfficePerspective(w, h, windowH);
}
