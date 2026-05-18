/** 矩形节点锚点（中心 + 尺寸） */
export interface TopoRect {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

const DEFAULT_PAD = 3;

/** 从矩形中心指向目标中心，取矩形边界上的出口/入口点（带内缩 pad） */
export function rectBoundaryToward(
  rect: TopoRect,
  targetCx: number,
  targetCy: number,
  pad = DEFAULT_PAD
): { x: number; y: number } {
  const dx = targetCx - rect.cx;
  const dy = targetCy - rect.cy;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
    return { x: rect.cx, y: rect.cy + rect.h / 2 - pad };
  }
  const hw = Math.max(1, rect.w / 2 - pad);
  const hh = Math.max(1, rect.h / 2 - pad);
  const scale = Math.min(hw / Math.abs(dx), hh / Math.abs(dy));
  return { x: rect.cx + dx * scale, y: rect.cy + dy * scale };
}

export interface TopoEdgePathOptions {
  /** 使用二次贝塞尔（广播扇出、纵向星形） */
  curved?: boolean;
  /** 同源多边时的序号，用于分散控制点 */
  fanIndex?: number;
  fanTotal?: number;
  /** 曲线外凸强度系数 */
  curveStrength?: number;
}

/**
 * 两节点间 SVG path：边界锚点 → 边界锚点，可选贝塞尔避让。
 */
export function buildTopologyEdgePath(from: TopoRect, to: TopoRect, options: TopoEdgePathOptions = {}): string {
  const start = rectBoundaryToward(from, to.cx, to.cy);
  const end = rectBoundaryToward(to, from.cx, from.cy);

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  const useCurve =
    options.curved ??
    (Math.abs(dy) > Math.abs(dx) * 0.75 || (options.fanTotal ?? 0) > 1);

  if (!useCurve) {
    return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
  }

  const mx = (start.x + end.x) / 2;
  const my = (start.y + end.y) / 2;
  const nx = -dy / len;
  const ny = dx / len;
  const fanTotal = options.fanTotal ?? 1;
  const fanIndex = options.fanIndex ?? 0;
  const spread = fanTotal > 1 ? (fanIndex - (fanTotal - 1) / 2) * 14 : 0;
  const strength = options.curveStrength ?? 1;
  const bulge = Math.min(56, Math.max(18, len * 0.28)) * strength;
  const cx = mx + nx * (bulge + spread * 0.35);
  const cy = my + ny * (bulge + spread * 0.35);

  return `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`;
}

/** 二次贝塞尔上 t∈[0,1] 的采样点（用于边标签） */
export function sampleQuadratic(
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  x2: number,
  y2: number,
  t: number
): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * x1 + 2 * u * t * cx + t * t * x2,
    y: u * u * y1 + 2 * u * t * cy + t * t * y2,
  };
}

/** 直线段 t 采样 */
export function sampleLine(x1: number, y1: number, x2: number, y2: number, t: number): { x: number; y: number } {
  return { x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t };
}
