/**
 * BFS 寻路：把 1280×720 像素办公室离散化为 GRID×GRID 单元，
 * 把桌子、书架、机架、休息角家具标记为不可通行；
 * findPath(start, end) 返回平滑后的世界坐标点列，供 Phaser tween 顺序播放。
 *
 * 走 8 方向 BFS（含对角线）+ 简单的 line-of-sight 平滑（删除可直达的中间点）。
 */
import { depthScale, type OfficePerspective } from "./officePerspective";
import type { OfficeLayout } from "./types";

const GRID = 32;
const STAGE_W = 1280;
const STAGE_H = 720;

export type Point = { x: number; y: number };
export type PathGrid = {
  cols: number;
  rows: number;
  cell: number;
  blocked: Uint8Array;
};

function idx(grid: PathGrid, c: number, r: number): number {
  return r * grid.cols + c;
}

function inBounds(grid: PathGrid, c: number, r: number): boolean {
  return c >= 0 && r >= 0 && c < grid.cols && r < grid.rows;
}

function paintCircle(grid: PathGrid, cx: number, cy: number, radius: number) {
  const r0 = Math.max(0, Math.floor((cy - radius) / grid.cell));
  const r1 = Math.min(grid.rows - 1, Math.floor((cy + radius) / grid.cell));
  const c0 = Math.max(0, Math.floor((cx - radius) / grid.cell));
  const c1 = Math.min(grid.cols - 1, Math.floor((cx + radius) / grid.cell));
  const r2 = radius * radius;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const dx = c * grid.cell + grid.cell / 2 - cx;
      const dy = r * grid.cell + grid.cell / 2 - cy;
      if (dx * dx + dy * dy <= r2) grid.blocked[idx(grid, c, r)] = 1;
    }
  }
}

/** 根据 layout + perspective 构建可行走网格 */
export function buildPathGrid(layout: OfficeLayout, persp: OfficePerspective): PathGrid {
  const cols = Math.ceil(STAGE_W / GRID);
  const rows = Math.ceil(STAGE_H / GRID);
  const blocked = new Uint8Array(cols * rows);
  const grid: PathGrid = { cols, rows, cell: GRID, blocked };

  // 1. 窗外/上方天花板区域整体不可走
  const ceilingRow = Math.floor(persp.windowH / GRID);
  for (let r = 0; r <= ceilingRow; r++) {
    for (let c = 0; c < cols; c++) blocked[idx(grid, c, r)] = 1;
  }

  // 2. 前墙踢脚板 / 屏幕底部
  const floorFrontRow = Math.floor(persp.floorFront / GRID);
  for (let r = floorFrontRow + 1; r < rows; r++) {
    for (let c = 0; c < cols; c++) blocked[idx(grid, c, r)] = 1;
  }

  // 3. 工位（桌子 + 椅子 + 显示器范围）—— 把桌子下方/前方留为通行
  for (const desk of layout.desks.values()) {
    const d = depthScale(desk.depth);
    paintCircle(grid, desk.x, desk.y - 12 * d, 26 * d);
  }

  // 4. 书架与机架
  paintCircle(grid, layout.shelf.x, layout.shelf.y - 8, 36 * depthScale(layout.shelf.depth));
  paintCircle(grid, layout.rack.x, layout.rack.y - 8, 36 * depthScale(layout.rack.depth));

  // 5. 休息角沙发 + 咖啡桌
  paintCircle(grid, layout.lounge.x, layout.lounge.y, 60 * depthScale(layout.lounge.depth));
  paintCircle(grid, layout.coffee.x, layout.coffee.y, 32 * depthScale(layout.coffee.depth));

  return grid;
}

function worldToCell(grid: PathGrid, p: Point): { c: number; r: number } {
  return {
    c: Math.max(0, Math.min(grid.cols - 1, Math.floor(p.x / grid.cell))),
    r: Math.max(0, Math.min(grid.rows - 1, Math.floor(p.y / grid.cell))),
  };
}

function cellToWorld(grid: PathGrid, c: number, r: number): Point {
  return { x: c * grid.cell + grid.cell / 2, y: r * grid.cell + grid.cell / 2 };
}

/** 找到最近的可走 cell（若起/终点本身被家具覆盖） */
function nearestFree(grid: PathGrid, c: number, r: number): { c: number; r: number } | null {
  if (!grid.blocked[idx(grid, c, r)]) return { c, r };
  for (let radius = 1; radius < Math.max(grid.cols, grid.rows); radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.abs(dc) !== radius && Math.abs(dr) !== radius) continue;
        const nc = c + dc;
        const nr = r + dr;
        if (inBounds(grid, nc, nr) && !grid.blocked[idx(grid, nc, nr)]) {
          return { c: nc, r: nr };
        }
      }
    }
  }
  return null;
}

const NEIGHBORS: ReadonlyArray<[number, number, number]> = [
  [1, 0, 10],
  [-1, 0, 10],
  [0, 1, 10],
  [0, -1, 10],
  [1, 1, 14],
  [-1, 1, 14],
  [1, -1, 14],
  [-1, -1, 14],
];

/** A* 寻路；返回沿路径的世界坐标点列（包含 start, end），失败时返回 null。 */
export function findPath(grid: PathGrid, start: Point, end: Point): Point[] | null {
  const s0 = worldToCell(grid, start);
  const e0 = worldToCell(grid, end);
  const s = nearestFree(grid, s0.c, s0.r);
  const e = nearestFree(grid, e0.c, e0.r);
  if (!s || !e) return null;

  const N = grid.cols * grid.rows;
  const gScore = new Int32Array(N).fill(1 << 28);
  const fScore = new Int32Array(N).fill(1 << 28);
  const cameFrom = new Int32Array(N).fill(-1);
  const open = new Uint8Array(N);
  const closed = new Uint8Array(N);

  const heuristic = (c: number, r: number) => {
    const dx = Math.abs(c - e.c);
    const dy = Math.abs(r - e.r);
    return 10 * (dx + dy) + (14 - 2 * 10) * Math.min(dx, dy);
  };

  const sIdx = idx(grid, s.c, s.r);
  gScore[sIdx] = 0;
  fScore[sIdx] = heuristic(s.c, s.r);
  open[sIdx] = 1;

  // 简单线性扫描 open 集合（网格 ≤40×23=920 个节点，足够快）
  while (true) {
    let curr = -1;
    let best = 1 << 30;
    for (let i = 0; i < N; i++) {
      if (open[i] && fScore[i] < best) {
        best = fScore[i];
        curr = i;
      }
    }
    if (curr < 0) return null;

    if (curr === idx(grid, e.c, e.r)) {
      const cells: Point[] = [];
      let cur: number = curr;
      while (cur >= 0) {
        const r = Math.floor(cur / grid.cols);
        const c = cur - r * grid.cols;
        cells.push(cellToWorld(grid, c, r));
        const prev = cameFrom[cur];
        if (prev === undefined || prev < 0) break;
        cur = prev;
      }
      cells.reverse();
      const smoothed = smoothPath(grid, cells);
      smoothed[0] = start;
      smoothed[smoothed.length - 1] = end;
      return smoothed;
    }

    open[curr] = 0;
    closed[curr] = 1;
    const r = Math.floor(curr / grid.cols);
    const c = curr - r * grid.cols;

    for (const [dc, dr, cost] of NEIGHBORS) {
      const nc = c + dc;
      const nr = r + dr;
      if (!inBounds(grid, nc, nr)) continue;
      const ni = idx(grid, nc, nr);
      if (grid.blocked[ni] || closed[ni]) continue;
      // 对角线穿越被阻塞角时禁止抄近路
      if (dc !== 0 && dr !== 0) {
        if (grid.blocked[idx(grid, c + dc, r)] || grid.blocked[idx(grid, c, r + dr)]) continue;
      }
      const tentative = gScore[curr]! + cost;
      if (tentative < gScore[ni]!) {
        cameFrom[ni] = curr;
        gScore[ni] = tentative;
        fScore[ni] = tentative + heuristic(nc, nr);
        if (!open[ni]) open[ni] = 1;
      }
    }
  }
}

/** Line-of-sight: a→b 之间所有 cell 是否都可通行 */
function lineClear(grid: PathGrid, a: Point, b: Point): boolean {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (grid.cell * 0.6)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const c = Math.floor(x / grid.cell);
    const r = Math.floor(y / grid.cell);
    if (!inBounds(grid, c, r) || grid.blocked[idx(grid, c, r)]) return false;
  }
  return true;
}

/** Stringy 平滑：从起点贪心跳到能直达的最远点，减少多余 waypoint */
function smoothPath(grid: PathGrid, pts: Point[]): Point[] {
  if (pts.length <= 2) return pts.slice();
  const out: Point[] = [pts[0]!];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !lineClear(grid, pts[i]!, pts[j]!)) j--;
    out.push(pts[j]!);
    i = j;
  }
  return out;
}
