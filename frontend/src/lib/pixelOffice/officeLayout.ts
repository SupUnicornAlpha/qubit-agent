import { getRenderConfig } from "./config";
import type { OfficeLayout } from "./types";
import { getStationFootprint } from "./stationMetrics";

const FLOOR_STRIP = 40;

function pickGrid(
  n: number,
  usableW: number,
  usableH: number,
  minW: number,
  minH: number
): { cols: number; rows: number; cellW: number; cellH: number } {
  let best: { cols: number; rows: number; cellW: number; cellH: number } | null = null;

  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellW = usableW / cols;
    const cellH = usableH / rows;
    if (cellW < minW || cellH < minH) continue;

    const score = cols * 1000 + rows;
    if (!best || score < best.cols * 1000 + best.rows) {
      best = { cols, rows, cellW, cellH };
    }
  }

  if (best) return best;

  const cols = Math.max(1, Math.min(n, Math.floor(usableW / minW)));
  const rows = Math.max(1, Math.ceil(n / cols));
  const shrink = Math.min(1, usableW / (cols * minW), usableH / (rows * minH));
  return {
    cols,
    rows,
    cellW: (usableW / cols) * shrink,
    cellH: (usableH / rows) * shrink,
  };
}

/** 在全宽画布上排布工位、机架、书架（保证工位不重叠） */
export function computeOfficeLayout(
  roles: ReadonlyArray<{ role: string }>,
  width: number,
  height: number
): OfficeLayout {
  const cfg = getRenderConfig();
  const fp = getStationFootprint(cfg);

  const windowH = Math.max(90, Math.floor(height * 0.28));
  const floorY = height - FLOOR_STRIP;
  const usableTop = windowH + fp.topReserve + 16;
  const usableBottom = floorY - fp.bottomReserve;
  const usableH = Math.max(fp.minHeight, usableBottom - usableTop);
  const usableLeft = fp.leftReserve;
  const usableRight = width - fp.rightReserve;
  const usableW = Math.max(fp.minWidth, usableRight - usableLeft);

  const n = roles.length;
  const grid = pickGrid(n, usableW, usableH, fp.minWidth, fp.minHeight);

  const desks = new Map<string, { x: number; y: number }>();
  roles.forEach((r, i) => {
    const col = i % grid.cols;
    const row = Math.floor(i / grid.cols);
    desks.set(r.role, {
      x: usableLeft + grid.cellW * col + grid.cellW / 2,
      y: usableTop + grid.cellH * row + grid.cellH / 2,
    });
  });

  const floorCenterY = usableTop + (grid.rows * grid.cellH) / 2;
  return {
    floorY,
    windowH,
    cellW: grid.cellW,
    cellH: grid.cellH,
    shelf: { x: fp.leftReserve / 2 + 8, y: floorCenterY },
    rack: { x: width - fp.rightReserve / 2 - 8, y: floorCenterY },
    desks,
  };
}
