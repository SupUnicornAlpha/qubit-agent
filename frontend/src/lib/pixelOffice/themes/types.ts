/**
 * 像素办公室主题系统类型定义。
 *
 * 设计原则：
 * - 主题 = 一份 atlas（图像 + 帧坐标） + 一组色板 + 一组后处理（夜晚/暖光） + 装饰偏好
 * - Night/Cozy 可与 Modern 共享 atlas（仅滤镜不同），不重复打包
 * - Canvas 与 Phaser 通过统一加载器消费同一主题
 */

import type {
  ModernAttribution,
  ModernFrameRect,
  ModernFurnitureCategory,
  ModernSpriteMeta,
} from "../../../assets/pixel-office/themes/modern/manifest";

export type ThemeId = "modern" | "modern_night" | "cozy";

/** 主题 atlas 静态资源描述（来自构建脚本产物） */
export type ThemeAtlasManifest = {
  /** 由 Vite 构建注入的最终 URL（可能含 hash） */
  imageUrl: string;
  /** Phaser TexturePacker JSON 的 URL */
  jsonUrl: string;
  /** atlas 像素尺寸（来自 manifest） */
  size: { w: number; h: number };
  /** 各帧在 atlas 中的源矩形（Canvas drawImage 用） */
  frames: Record<string, ModernFrameRect>;
  /** 各帧元数据（含类别 + footprintRadius） */
  spriteMeta: Record<string, ModernSpriteMeta>;
  /** 语义分类 → 可用 sprite 名列表（供随机/轮换选用） */
  categories: Record<ModernFurnitureCategory, readonly string[]>;
  /** 资产署名（CC-BY 必须暴露） */
  attribution: readonly ModernAttribution[];
};

/** 主题色板：影响墙体/地板/灯光基色等 */
export type ThemePalette = {
  /** 地板主色 */
  floor: string;
  /** 地板辅色（用于条纹） */
  floorAlt: string;
  /** 墙面色 */
  wall: string;
  /** 天花板色 */
  ceiling: string;
  /** 默认环境光叠加 */
  ambient: string;
};

/** 主题后处理滤镜：夜晚/暖光等 */
export type ThemeFilter = {
  /** 全局色调 overlay（CSS rgba） */
  overlayColor?: string;
  /** overlay alpha 0..1 */
  overlayAlpha?: number;
  /** 显示器/灯光 bloom 倍数（1 = 默认） */
  bloom?: number;
  /** 环境光强度倍数（0..2） */
  ambient?: number;
  /** 城市天际线整体明度（0..2） */
  skylineBrightness?: number;
};

/** 装饰偏好（影响在哪些位置摆放哪些 sprite） */
export type ThemeDecorationPreset = {
  /** 工位旁 desk sprite 候选 */
  deskSprites: readonly string[];
  /** 工位椅子 sprite 候选 */
  chairSprites: readonly string[];
  /** 休息角沙发 sprite */
  loungeSofa: string;
  /** 休息角茶几 sprite */
  loungeTable: string;
  /** 咖啡角机器 sprite */
  coffeeMachine: string;
  /** 角落装饰 sprite（plant 类，按位置依次取） */
  cornerPlants: readonly string[];
  /** 墙面装饰候选（wallArt / wallClock 等） */
  wallDecor: readonly string[];
  /** 额外散落家具（cabinet / printer / vending / water）；按距离随机摆放 */
  extras: readonly string[];
};

export type ThemeDescriptor = {
  id: ThemeId;
  label: string;
  /** 该主题使用的 atlas（多主题可共享同一份） */
  atlas: ThemeAtlasManifest;
  palette: ThemePalette;
  filter: ThemeFilter;
  decorations: ThemeDecorationPreset;
};

/** 已加载图像，供 Canvas 直接 drawImage 使用 */
export type LoadedThemeAtlas = {
  manifest: ThemeAtlasManifest;
  image: HTMLImageElement;
  /** 图像加载完成（loaded === true）才允许使用 */
  loaded: boolean;
};

export type ThemeChangeListener = (next: ThemeDescriptor, prev: ThemeDescriptor | null) => void;
