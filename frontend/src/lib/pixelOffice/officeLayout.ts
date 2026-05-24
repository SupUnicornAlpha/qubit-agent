import { getRenderConfig } from "./config";
import {
  computeOfficePerspective,
  depthScale,
  floorWidthAtDepth,
  perspectiveGridPosition,
  type OfficePerspective,
} from "./officePerspective";
import type { DeskSlot, OfficeLayout } from "./types";
import { getStationFootprint } from "./stationMetrics";

const FLOOR_STRIP = 36;
const MARGIN_U = 0.1;
const MARGIN_V = 0.08;

function pickPerspectiveGrid(
  n: number,
  p: OfficePerspective,
  minW: number,
  minH: number
): { cols: number; rows: number; cellU: number; cellV: number } {
  let best: { cols: number; rows: number; cellU: number; cellV: number } | null = null;

  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellU = (1 - 2 * MARGIN_U) / cols;
    const cellV = (1 - 2 * MARGIN_V) / rows;

    const vFront = MARGIN_V + cellV * (rows - 0.5);
    const vBack = MARGIN_V + cellV * 0.5;
    const frontW = floorWidthAtDepth(p, vFront) * cellU;
    const backW = floorWidthAtDepth(p, vBack) * cellU;
    const frontH = (p.floorFront - p.floorBack) * cellV;

    if (frontW < minW * 0.88 || backW < minW * 0.72 || frontH < minH * 0.85) continue;

    const score = cols * 1000 + rows;
    if (!best || score < best.cols * 1000 + best.rows) {
      best = { cols, rows, cellU, cellV };
    }
  }

  if (best) return best;

  const cols = Math.max(1, Math.min(n, 4));
  const rows = Math.ceil(n / cols);
  return {
    cols,
    rows,
    cellU: (1 - 2 * MARGIN_U) / cols,
    cellV: (1 - 2 * MARGIN_V) / rows,
  };
}

function slotAt(
  p: OfficePerspective,
  col: number,
  row: number,
  cols: number,
  rows: number
): DeskSlot {
  const u = MARGIN_U + (col + 0.5) * ((1 - 2 * MARGIN_U) / cols);
  const v = MARGIN_V + (row + 0.5) * ((1 - 2 * MARGIN_V) / rows);
  const pos = perspectiveGridPosition(p, u, v);
  return { x: pos.x, y: pos.y, depth: pos.depth };
}

/** 透视网格排布工位、书架、机架 */
export function computeOfficeLayout(
  roles: ReadonlyArray<{ role: string }>,
  width: number,
  height: number
): OfficeLayout {
  const cfg = getRenderConfig();
  const fp = getStationFootprint(cfg);

  const windowH = Math.max(90, Math.floor(height * 0.28));
  const floorY = height - FLOOR_STRIP;
  const p = computeOfficePerspective(width, height, windowH);

  const n = roles.length;
  const grid = pickPerspectiveGrid(n, p, fp.minWidth, fp.minHeight);

  const desks = new Map<string, DeskSlot>();
  roles.forEach((r, i) => {
    const col = i % grid.cols;
    const row = Math.floor(i / grid.cols);
    desks.set(r.role, slotAt(p, col, row, grid.cols, grid.rows));
  });

  const midV = 0.52;
  const shelfPos = perspectiveGridPosition(p, 0.06, midV);
  const rackPos = perspectiveGridPosition(p, 0.94, midV);
  const loungePos = perspectiveGridPosition(p, 0.5, 0.12);
  const coffeePos = perspectiveGridPosition(p, 0.12, 0.72);
  const workZonePos = perspectiveGridPosition(p, 0.5, 0.42);

  const sample = slotAt(p, 0, 0, grid.cols, grid.rows);
  const sample2 = slotAt(p, Math.min(1, grid.cols - 1), 0, grid.cols, grid.rows);
  const cellW = Math.abs(sample2.x - sample.x) || fp.minWidth;
  const row1 = slotAt(p, 0, Math.min(1, grid.rows - 1), grid.cols, grid.rows);
  const cellH = Math.abs(row1.y - sample.y) || fp.minHeight;

  return {
    floorY,
    windowH,
    cellW,
    cellH,
    shelf: {
      x: shelfPos.x,
      y: shelfPos.y,
      depth: shelfPos.depth,
    },
    rack: {
      x: rackPos.x,
      y: rackPos.y,
      depth: rackPos.depth,
    },
    lounge: { x: loungePos.x, y: loungePos.y, depth: loungePos.depth },
    coffee: { x: coffeePos.x, y: coffeePos.y, depth: coffeePos.depth },
    workZone: { x: workZonePos.x, y: workZonePos.y - 20, depth: workZonePos.depth },
    desks,
  };
}

/** 纵深对应的近似占位（用于点击检测） */
export function deskHitRadius(depth: number, base = 64): number {
  return base * depthScale(depth);
}
