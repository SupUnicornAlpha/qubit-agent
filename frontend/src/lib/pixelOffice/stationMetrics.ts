import type { RenderConfig } from "./config";

/** 单个工位在画布上占用的最小矩形（用于防重叠布局） */
export type StationFootprint = {
  minWidth: number;
  minHeight: number;
  leftReserve: number;
  rightReserve: number;
  topReserve: number;
  bottomReserve: number;
};

/** 与 officeRenderer 中 blit 尺寸对齐的占位估算 */
export function getStationFootprint(cfg: RenderConfig): StationFootprint {
  const deskW = (cfg.tier === "hd" ? 56 : 40) * cfg.deskScale;
  const monW = (cfg.tier === "hd" ? 50 : 34) * cfg.monitorScale;
  const monH = (cfg.tier === "hd" ? 38 : 26) * cfg.monitorScale;
  const catH = (cfg.tier === "hd" ? 30 : 22) * cfg.catScale;

  return {
    minWidth: Math.ceil(Math.max(deskW, monW) + 28),
    minHeight: Math.ceil(monH + catH * 0.45 + 32),
    leftReserve: cfg.tier === "hd" ? 128 : 104,
    rightReserve: cfg.tier === "hd" ? 128 : 104,
    topReserve: 8,
    bottomReserve: 44,
  };
}
