/**
 * 像素办公室渲染配置。
 * - standard：较轻量，适合小画布
 * - hd：约 1K 级（精灵图集更大、天际线像素更密），默认
 */
export type RenderTier = "standard" | "hd";

export type RenderConfig = {
  tier: RenderTier;
  /** 精灵图集内 1 逻辑像素 = spriteUnit CSS 像素 */
  spriteUnit: number;
  atlasBuild: number;
  catScale: number;
  monitorScale: number;
  deskScale: number;
  furnitureScale: number;
  /** 天际线 1 艺术像素 = skylinePixel 屏幕像素 */
  skylinePixel: number;
  /** 建议最小画布宽度（用于布局间距） */
  targetMinWidth: number;
  maxDevicePixelRatio: number;
};

const PRESETS: Record<RenderTier, RenderConfig> = {
  standard: {
    tier: "standard",
    spriteUnit: 6,
    atlasBuild: 3,
    catScale: 4.2,
    monitorScale: 4,
    deskScale: 4,
    furnitureScale: 3.6,
    skylinePixel: 3,
    targetMinWidth: 720,
    maxDevicePixelRatio: 2,
  },
  hd: {
    tier: "hd",
    spriteUnit: 8,
    atlasBuild: 6,
    catScale: 3.25,
    monitorScale: 3.2,
    deskScale: 3.2,
    furnitureScale: 3,
    skylinePixel: 1,
    targetMinWidth: 1024,
    maxDevicePixelRatio: 2,
  },
};

let activeTier: RenderTier = "hd";

export function setRenderTier(tier: RenderTier): void {
  activeTier = tier;
}

export function getRenderTier(): RenderTier {
  return activeTier;
}

export function getRenderConfig(tier?: RenderTier): RenderConfig {
  return PRESETS[tier ?? activeTier];
}
